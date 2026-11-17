;;; pi-sound.el --- Voice dictation into any buffer -*- lexical-binding: t; -*-

;; SPDX-License-Identifier: MIT

;; Author: offline-ant
;; Version: 0.1.0
;; Package-Requires: ((emacs "30.1"))
;; Keywords: multimedia, convenience
;; URL: https://github.com/offline-ant/phimacs

;;; Commentary:

;; `pi-sound-dictate' toggles a recording: the first call starts
;; `pi-sound dictate', the second stops it and gives the transcript to the
;; target decided where the recording started (see pi-sound-target.el):
;; the text goes where point was, into the prompt that was open, or to a
;; terminal.  The live transcript shows there in `pi-sound-partial' until
;; then.  C-g while it runs cancels.
;;
;; Targets that can submit, such as prompts and Pilish inputs, also
;; submit: in send mode (see `pi-sound-toggle-mode'), when the transcript
;; ends in the CLI's send word (default "send", which is removed), and when
;; the recording stopped by itself, the CLI's `sendWordMs' (default one
;; second) after the live transcript ends in the send word or four seconds
;; after any other speech.  Elsewhere recordings stop only by hand and keep
;; a trailing "send".  A transcript ending in the CLI's clear word (default
;; "clear stop") is discarded everywhere, and the recording stops by itself
;; `sendWordMs' after it.  While recording, a target's submit command
;; (remapped to `pi-sound-stop-and-send') stops and then submits.
;;
;; `pi-sound-mode' adds a recording indicator to every mode line and a
;; microphone button to minibuffer prompts other than yes or no questions,
;; whose answers a click should give directly; bind dictation keys in
;; `pi-sound-mode-map', which also takes precedence in prompts.
;;
;; The CLI's explicitly configured capture source and speech backend are used.
;; Loading this frontend does not configure or access audio devices.
;;
;; `pi-sound-input-button-setup' shows the same button beside the first
;; visible row of each window of an input buffer, following its scrolling,
;; in three columns it adds to the right margin (other margin buttons keep
;; theirs): add it to a mode hook such as
;; `pilish-input-mode-hook'.  `pi-sound-input-button' turns it
;; off everywhere.  The margin shows a microphone when idle, a red "REC"
;; while recording and "…" while connecting or transcribing; clicking it
;; dictates into that buffer.
;;
;; `pi-sound-button' returns a header or mode line button showing the
;; state: a microphone when idle, a red "● REC <device>" while recording
;; and "…" while transcribing.  mouse-1 toggles dictation, mouse-3 toggles
;; the mode.  Use it in a header or mode line as (:eval (pi-sound-button)).
;;
;; `pi-sound-play' and `pi-sound-notify' play a notification sound and show a
;; desktop pop-up through the configured output sink, in the background.
;; `pi-sound-deck-notify' does both for pi-deck: add it to
;; `pi-deck-notify-functions' (blocked plays "request", finished "done").

;;; Code:

(require 'subr-x)
(require 'seq)
(require 'pi-sound-target)

(defgroup pi-sound nil
  "Voice dictation through the pi-sound CLI."
  :group 'convenience
  :prefix "pi-sound-")

(defcustom pi-sound-program "pi-sound"
  "The pi-sound CLI."
  :type 'string)

(defface pi-sound-recording
  '((t :inherit error :weight bold))
  "Button face while recording.")

(defvar pi-sound--input-button-overlays nil
  "This buffer's margin button overlays, an alist of (WINDOW . OVERLAY).")
(make-variable-buffer-local 'pi-sound--input-button-overlays)
;; A re-run major mode can keep its overlays, so it must keep their owner too.
;; md-ts-mode's teardown deletes them instead, which leaves the overlay
;; without a buffer.
(put 'pi-sound--input-button-overlays 'permanent-local t)

(defvar-local pi-sound--input-button-host nil
  "Non-nil when `pi-sound-input-button-setup' offered the margin button here.")

(defvar-local pi-sound--input-button-margin nil
  "Non-nil while the right margin includes the button's columns.
Not permanent: a re-run major mode resets `right-margin-width' too.")


(defcustom pi-sound-input-button t
  "Whether input buffers set up by `pi-sound-input-button-setup' show the button.
Non-nil adds three columns to the right margin beside the draft and shows
the dictation button in them.  nil shows neither.  Setting it through Customize
or `setopt' updates existing buffers."
  :type 'boolean
  :set (lambda (symbol value)
         (set-default symbol value)
         (dolist (buffer (buffer-list))
           (when (buffer-local-value 'pi-sound--input-button-host buffer)
             (with-current-buffer buffer (pi-sound--update-input-button))))))

(defvar pi-sound-state 'idle
  "Dictation state: `idle', `connecting', `recording' or `transcribing'.")

(defvar pi-sound-state-change-functions nil
  "Functions called with the new `pi-sound-state' whenever it changes.")

(defvar pi-sound-delivery nil
  "Last known mode, \"type\" or \"send\"; nil until pi-sound reports it.")

(defvar pi-sound-device nil
  "Device of the current recording, or nil.")

(defvar pi-sound--process nil)
(defvar pi-sound--target nil
  "Target of the current dictation, a plist; see pi-sound-target.el.")
(defvar pi-sound--send-requested nil
  "Non-nil when `pi-sound-stop-and-send' asked to send the current transcript.")

(defvar-keymap pi-sound--target-mode-map
  :doc "Remaps the dictation target's submit command; see `pi-sound--target-mode'.")

(define-minor-mode pi-sound--target-mode
  "While dictating into this buffer, submitting finishes the dictation first.
The target's :command runs `pi-sound-stop-and-send' instead."
  :keymap pi-sound--target-mode-map)

(defun pi-sound--target-remap (target enable)
  "With ENABLE, remap TARGET's submit command in its buffer, else stop."
  (let ((command (plist-get target :command))
        (buffer (plist-get target :buffer)))
    (when (and command (symbolp command) (buffer-live-p buffer))
      (when enable
        (setcdr pi-sound--target-mode-map nil)
        (keymap-set pi-sound--target-mode-map (format "<remap> <%s>" command)
                    #'pi-sound-stop-and-send))
      (with-current-buffer buffer (pi-sound--target-mode (if enable 1 -1))))))

(defun pi-sound--status (format &rest args)
  "Show the status message FORMAT with ARGS, unless dictating into the prompt.
The prompt's button shows the state there, and a message would cover it."
  (let ((inhibit-message (and pi-sound--target
                              (minibufferp (plist-get pi-sound--target :buffer) t))))
    (apply #'message format args)))

(defun pi-sound--set-state (state)
  "Enter STATE, notify `pi-sound-state-change-functions' and redraw."
  (unless (eq state pi-sound-state)
    (setq pi-sound-state state)
    (unless (memq state '(recording transcribing))
      (setq pi-sound-device nil))
    (when (eq state 'idle)
      (setq pi-sound--send-requested nil)
      (pi-sound--hide-preview)
      (when pi-sound--target (pi-sound--target-remap pi-sound--target nil)))
    (run-hook-with-args 'pi-sound-state-change-functions state)
    (pi-sound--refresh-input-buttons)
    (pi-sound--refresh-prompt-buttons)
    (force-mode-line-update t)))

;;;; Process

(defun pi-sound--handle (process message)
  "Act on one parsed MESSAGE from PROCESS."
  (let ((type (alist-get 'type message)))
    (when (member type '("final" "error"))
      (process-put process 'terminal t))
    (pcase type
      ("ready"
       (setq pi-sound-device (alist-get 'device message))
       (when-let* ((mode (alist-get 'mode message))) (setq pi-sound-delivery mode))
       (setq pi-sound-dictated-format (alist-get 'dictatedFormat message))
       (pi-sound--set-state 'recording)
       (pi-sound--status "Dictating via %s (%s, %s) — again to stop, C-g to cancel"
                pi-sound-device (alist-get 'backend message) pi-sound-delivery))
      ("partial" (pi-sound--show-preview pi-sound--target (alist-get 'text message)))
      ("final"
       (let ((text (string-trim (alist-get 'text message)))
             ;; The send word, a pause or `pi-sound-stop-and-send' sends in
             ;; either mode, as send mode does.
             (send (or pi-sound--send-requested (eq (alist-get 'send message) t)
                       (equal pi-sound-delivery "send"))))
         (pi-sound--set-state 'idle)
         (cond
          ;; The clear word discards the dictation, even when sending was asked.
          ((eq (alist-get 'clear message) t) (message "Dictation cleared"))
          ((and (string-empty-p text) (not send))
           (message "Dictation: nothing heard"))
          (t
           (pi-sound--deliver pi-sound--target text send)
           (when (alist-get 'limited message)
             (message "Dictation stopped at the 5-minute limit"))))))
      ("error"
       (pi-sound--set-state 'idle)
       (message "Dictation failed: %s" (alist-get 'message message))))))

(defun pi-sound--filter (process output)
  "Parse complete JSON lines of OUTPUT from PROCESS."
  (let ((pending (concat (or (process-get process 'pending) "") output)))
    (while (string-match "\n" pending)
      (let ((line (substring pending 0 (match-beginning 0))))
        (setq pending (substring pending (match-end 0)))
        (unless (string-empty-p line)
          (condition-case nil
              (pi-sound--handle process (json-parse-string line :object-type 'alist))
            (json-parse-error (message "Dictation: unexpected output %S" line))))))
    (process-put process 'pending pending)))

(defun pi-sound--sentinel (process _event)
  "Forget PROCESS when it ends; report an exit without a result."
  (unless (process-live-p process)
    (when (eq process pi-sound--process)
      (setq pi-sound--process nil)
      (unless (process-get process 'terminal)
        (message "Dictation: %s exited without a result (status %s); see %s"
                 pi-sound-program (process-exit-status process)
                 (buffer-name (process-get process 'stderr))))
      (pi-sound--set-state 'idle))))

(defun pi-sound-cancel ()
  "Cancel the running dictation without inserting anything, else quit."
  (interactive)
  (if (not (process-live-p pi-sound--process))
      (keyboard-quit)
    (let ((process pi-sound--process))
      (setq pi-sound--process nil)
      (delete-process process))
    (pi-sound--set-state 'idle)
    (message "Dictation cancelled")))

(defvar pi-sound--cancel-map
  (let ((map (make-sparse-keymap)))
    (keymap-set map "C-g" #'pi-sound-cancel)
    map))

(defun pi-sound--dictate-arguments (target)
  "Return the CLI arguments that start dictating into TARGET.
The recording stops by itself only as TARGET's :auto-stop allows."
  (append (list "dictate")
          (unless (plist-get target :auto-stop) (list "--send-word" ""))
          (unless (eq (plist-get target :auto-stop) t) (list "--pause-ms" "0"))))

;;;###autoload
(defun pi-sound-dictate ()
  "Start dictating here, or stop and deliver the transcript.
The target is decided here; see pi-sound-target.el."
  (interactive)
  (if (process-live-p pi-sound--process)
      (if (not (eq pi-sound-state 'recording))
          (message "Dictation: still %s (C-g cancels)" pi-sound-state)
        (process-send-eof pi-sound--process)
        (pi-sound--set-state 'transcribing)
        (pi-sound--status "Transcribing…"))
    (let ((stderr (get-buffer-create " *pi-sound-stderr*"))
          (target (pi-sound--resolve-target)))
      (with-current-buffer stderr (erase-buffer))
      (condition-case error
          (setq pi-sound--process
                (make-process :name "pi-sound-dictate"
                              :command (cons pi-sound-program
                                             (pi-sound--dictate-arguments target))
                              :connection-type 'pipe
                              :noquery t
                              :stderr stderr
                              :filter #'pi-sound--filter
                              :sentinel #'pi-sound--sentinel))
        (file-missing
         (user-error "Dictation: %s not found (%s)" pi-sound-program
                     (error-message-string error))))
      (process-put pi-sound--process 'stderr stderr)
      (setq pi-sound--target target)
      (pi-sound--target-remap target t)
      (pi-sound--set-state 'connecting)
      (pi-sound--status "Dictation: connecting…")
      (set-transient-map pi-sound--cancel-map
                         (lambda () (process-live-p pi-sound--process))))))

(defun pi-sound-stop-and-send ()
  "Stop the running dictation, then send its buffer, whatever the mode.
While dictating, this replaces the target buffer's send command, such as
`pilish-send', so sending finishes the dictation first."
  (interactive)
  (pcase pi-sound-state
    ('recording (setq pi-sound--send-requested t) (pi-sound-dictate))
    ('transcribing (setq pi-sound--send-requested t)
                   (pi-sound--status "Transcribing, then sending…"))
    (_ (message "Dictation: still %s (C-g cancels)" pi-sound-state))))

;;;###autoload
(defun pi-sound-toggle-mode ()
  "Toggle between typing transcripts and sending them."
  (interactive)
  (with-temp-buffer
    (let ((status (condition-case error
                      (call-process pi-sound-program nil '(t nil) nil "mode" "toggle")
                    (file-missing
                     (user-error "Dictation: %s not found (%s)" pi-sound-program
                                 (error-message-string error)))))
          (mode (ignore-errors
                  (alist-get 'mode (json-parse-string (buffer-string) :object-type 'alist)))))
      (unless (and (eq status 0) (stringp mode))
        (user-error "Dictation: %s mode toggle failed: %s" pi-sound-program
                    (string-trim (buffer-string))))
      (setq pi-sound-delivery mode)
      (pi-sound--refresh-input-buttons)
      (force-mode-line-update t)
      (message "Dictation mode: %s" (if (equal mode "send") "send transcripts" "type transcripts")))))

;;;; Sound and notifications on the device

(defun pi-sound--run-detached (&rest args)
  "Run the pi-sound CLI with ARGS in the background, discarding its output.
Does nothing when the CLI is missing."
  (condition-case nil
      (make-process :name "pi-sound-output"
                    :command (cons pi-sound-program args)
                    :buffer nil :connection-type 'pipe :noquery t
                    :sentinel #'ignore)
    (file-missing nil)))

(defun pi-sound-play (name)
  "Play notification sound NAME (`done' or `request') on the user's device."
  (pi-sound--run-detached "play" (format "%s" name)))

(defun pi-sound-notify (title &optional body)
  "Show a desktop notification with TITLE and BODY on the user's device."
  (apply #'pi-sound--run-detached "notify" title (and body (list body))))

;;;###autoload
(defun pi-sound-deck-notify (kind title body _agent)
  "Play a sound for KIND and show TITLE and BODY on the user's device.
A `pi-deck-notify-functions' function: `blocked' plays \"request\",
`finished' plays \"done\"."
  (pi-sound-play (if (eq kind 'blocked) 'request 'done))
  (pi-sound-notify title body))

;;;; Button

(defun pi-sound-label ()
  "Return the button label for `pi-sound-state'."
  (pcase pi-sound-state
    ('recording (propertize (format " ● REC %s " (or pi-sound-device "")) 'face 'pi-sound-recording))
    ('transcribing " … ")
    ('connecting " 🎤… ")
    (_ " 🎤 ")))

(defvar-keymap pi-sound-button-map
  :doc "Bindings of the button in text, margins, header and mode lines."
  ;; Clicks act on release; the presses do nothing.
  "<down-mouse-1>" #'ignore
  "<mouse-1>" #'pi-sound-button-click
  "<down-mouse-3>" #'ignore
  "<mouse-3>" #'pi-sound-button-click
  "<right-margin> <down-mouse-1>" #'ignore
  "<right-margin> <mouse-1>" #'pi-sound-button-click
  "<right-margin> <down-mouse-3>" #'ignore
  "<right-margin> <mouse-3>" #'pi-sound-button-click
  "<header-line> <down-mouse-1>" #'ignore
  "<header-line> <mouse-1>" #'pi-sound-button-click
  "<header-line> <down-mouse-3>" #'ignore
  "<header-line> <mouse-3>" #'pi-sound-button-click
  "<mode-line> <down-mouse-1>" #'ignore
  "<mode-line> <mouse-1>" #'pi-sound-button-click
  "<mode-line> <down-mouse-3>" #'ignore
  "<mode-line> <mouse-3>" #'pi-sound-button-click)

(defun pi-sound--button (label)
  "Return LABEL as the clickable dictation button."
  (propertize label
              'mouse-face 'mode-line-highlight 'pointer 'hand
              'local-map pi-sound-button-map
              'help-echo (format "%smouse-1: %s dictation; mouse-3: toggle mode (%s)\nIn prompts and Pi inputs, ending with the send word or pausing submits."
                                 (if (and (eq pi-sound-state 'recording) pi-sound-device)
                                     (format "Recording via %s\n" pi-sound-device)
                                   "")
                                 (if (eq pi-sound-state 'idle) "start" "stop")
                                 (or pi-sound-delivery "type or send"))))

;;;###autoload
(defun pi-sound-button ()
  "Return the dictation button for a header or mode line."
  (pi-sound--button (pi-sound-label)))

(defun pi-sound-button-click (event)
  "Toggle dictation for mouse-1 EVENT, the mode for mouse-3.
A click in a window's text or margin, such as on a prompt's button, first
selects that window, so dictation goes to its point."
  (interactive "e")
  (let ((position (event-start event)))
    (when (and (windowp (posn-window position))
               (memq (posn-area position) '(nil left-margin right-margin)))
      (select-window (posn-window position))))
  (if (eq (event-basic-type event) 'mouse-3)
      (pi-sound-toggle-mode)
    (pi-sound-dictate)))

;;;; Input margin button

(defconst pi-sound--input-button-width 3
  "Columns of the right margin reserved for the input button.")

(defun pi-sound--input-label ()
  "Return the margin label for `pi-sound-state', at most three columns."
  (pcase pi-sound-state
    ('recording (propertize "REC" 'face 'pi-sound-recording))
    ((or 'connecting 'transcribing) " … ")
    (_ " 🎤")))

(defun pi-sound--input-button-string ()
  "Return the before-string that shows the button in the right margin."
  (propertize " " 'display `((margin right-margin)
                             ,(pi-sound--button (pi-sound--input-label)))))

(defun pi-sound--reserve-right-margin (reserve)
  "Add the button's columns to the right margin, or with RESERVE nil remove them."
  (unless (eq (not reserve) (not pi-sound--input-button-margin))
    (setq pi-sound--input-button-margin reserve)
    (setq-local right-margin-width
                (funcall (if reserve #'+ #'-) (or right-margin-width 0)
                         pi-sound--input-button-width))
    (dolist (window (get-buffer-window-list nil nil t))
      (set-window-margins window (car (window-margins window)) right-margin-width))))

(defun pi-sound--place-input-buttons (&rest _)
  "Show the button beside the first visible row of each window of this buffer.
Windows no longer showing the buffer lose theirs."
  (let ((windows (get-buffer-window-list nil nil t))
        (string (pi-sound--input-button-string))
        placed)
    (dolist (window windows)
      (let ((overlay (cdr (assq window pi-sound--input-button-overlays)))
            (start (window-start window)))
        (if (and overlay (overlay-buffer overlay))
            (unless (= start (overlay-start overlay))
              (move-overlay overlay start start))
          (setq overlay (make-overlay start start))
          (overlay-put overlay 'window window)
          ;; Before-strings show in increasing priority, so this follows
          ;; lines shown above the draft, such as Pilish widgets.
          (overlay-put overlay 'priority 1))
        (overlay-put overlay 'before-string string)
        (push (cons window overlay) placed)))
    (dolist (entry pi-sound--input-button-overlays)
      (unless (memq (car entry) windows) (delete-overlay (cdr entry))))
    (setq pi-sound--input-button-overlays placed)))

(defconst pi-sound--input-button-hooks
  '(window-scroll-functions window-buffer-change-functions)
  "Buffer-local hooks after which the buttons are placed again.")

(defun pi-sound--update-input-button ()
  "Show, refresh or remove this buffer's margin buttons."
  (if (and pi-sound-input-button pi-sound--input-button-host)
      (progn
        (dolist (hook pi-sound--input-button-hooks)
          (add-hook hook #'pi-sound--place-input-buttons nil t))
        (pi-sound--reserve-right-margin t)
        (pi-sound--place-input-buttons))
    (dolist (hook pi-sound--input-button-hooks)
      (remove-hook hook #'pi-sound--place-input-buttons t))
    (dolist (entry pi-sound--input-button-overlays)
      (delete-overlay (cdr entry)))
    (setq pi-sound--input-button-overlays nil)
    (pi-sound--reserve-right-margin nil)))

(defun pi-sound--refresh-input-buttons ()
  "Redraw every margin button for the current state and mode."
  (dolist (buffer (buffer-list))
    (when (buffer-local-value 'pi-sound--input-button-host buffer)
      (with-current-buffer buffer (pi-sound--update-input-button)))))

;;;###autoload
(defun pi-sound-input-button-setup ()
  "Offer the dictation button in the current buffer's right margin.
For input mode hooks such as `pilish-input-mode-hook'.  The button shows
beside each window's first visible row while `pi-sound-input-button' is
non-nil."
  (setq pi-sound--input-button-host t)
  (pi-sound--update-input-button))

;;;; Dictating anywhere

(defvar-keymap pi-sound-mode-map
  :doc "Keys of `pi-sound-mode'.
Bind dictation keys here: minor mode keys take precedence over the
minibuffer's own, so they also work in prompts.")

(defvar pi-sound--prompt-buttons nil
  "Overlays showing the dictation button after minibuffer prompts.")

(defconst pi-sound--mode-line-entry '(:eval (pi-sound--mode-line))
  "The `global-mode-string' entry of `pi-sound-mode'.")

(defun pi-sound--mode-line ()
  "Return the button while dictating, for every mode line; else nil."
  (unless (eq pi-sound-state 'idle) (pi-sound-button)))

(defun pi-sound--prompt-button-string ()
  "Return the button shown after a prompt."
  (concat (pi-sound--button (pi-sound--input-label)) " "))

(defun pi-sound--add-prompt-button ()
  "Show the button after the prompt of the minibuffer being entered.
Yes or no questions get none: their keys or dictation answer them."
  (unless (pi-sound--yes-or-no-prompt-p)
    (let ((overlay (make-overlay (point-min) (minibuffer-prompt-end))))
      (overlay-put overlay 'after-string (pi-sound--prompt-button-string))
      (push overlay pi-sound--prompt-buttons))))

(defun pi-sound--remove-prompt-button ()
  "Remove the button of the minibuffer being left."
  (setq pi-sound--prompt-buttons
        (seq-remove (lambda (overlay)
                      (when (memq (overlay-buffer overlay) (list nil (current-buffer)))
                        (delete-overlay overlay)
                        t))
                    pi-sound--prompt-buttons)))

(defun pi-sound--refresh-prompt-buttons ()
  "Redraw the prompt buttons for the current state."
  (dolist (overlay pi-sound--prompt-buttons)
    (overlay-put overlay 'after-string (pi-sound--prompt-button-string))))

;;;###autoload
(define-minor-mode pi-sound-mode
  "Dictate anywhere: keys, a recording indicator and a button on prompts.
While dictating, every mode line shows the recording state.  Minibuffer
prompts other than yes or no questions show the dictation button after
the prompt; clicking it dictates into the prompt.  Bind dictation keys
in `pi-sound-mode-map'."
  :global t
  :group 'pi-sound
  (if pi-sound-mode
      (progn
        (add-hook 'minibuffer-setup-hook #'pi-sound--add-prompt-button)
        (add-hook 'minibuffer-exit-hook #'pi-sound--remove-prompt-button)
        (add-to-list 'global-mode-string pi-sound--mode-line-entry t))
    (remove-hook 'minibuffer-setup-hook #'pi-sound--add-prompt-button)
    (remove-hook 'minibuffer-exit-hook #'pi-sound--remove-prompt-button)
    (setq global-mode-string (delete pi-sound--mode-line-entry global-mode-string))
    (mapc #'delete-overlay pi-sound--prompt-buttons)
    (setq pi-sound--prompt-buttons nil)))

(provide 'pi-sound)
;;; pi-sound.el ends here
