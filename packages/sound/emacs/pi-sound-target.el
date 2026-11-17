;;; pi-sound-target.el --- Where dictated text goes -*- lexical-binding: t; -*-

;; SPDX-License-Identifier: MIT

;;; Commentary:

;; A dictation's target is decided where it starts and receives the
;; transcript when it ends.  `pi-sound-target-functions' are asked first;
;; without an answer the built-in targets decide: the active minibuffer
;; prompt, terminal and shell buffers, then any buffer.  A target is a
;; plist:
;;
;;   :buffer     the buffer dictated into; default the current one
;;   :position   marker where the text goes and the live transcript shows;
;;               default point
;;   :insert     function inserting the final text in :buffer; default
;;               inserts at :position after a separating space
;;   :submit     function submitting :buffer after the text, or nil
;;   :command    the command that submits by hand; while recording it
;;               stops the dictation and submits afterwards instead
;;   :normalize  function turning the text into an answer, such as \"yes\";
;;               normalized answers never take `dictatedFormat'
;;   :format     whether `dictatedFormat' applies; default without
;;               :normalize and outside `pi-sound-unformatted-modes'
;;   :auto-stop  when the recording stops by itself: t on the send word or
;;               a pause, `word' on the send word only, nil never; default
;;               t with :submit, else nil
;;   :valid-p    function telling whether the target still exists;
;;               default whether :buffer is live
;;
;; Text that cannot be delivered, such as into read-only text or a prompt
;; that closed meanwhile, goes to the kill ring.  Submitting waits while a
;; newer minibuffer prompt is open, so it never answers that prompt.

;;; Code:

(require 'cl-lib)
(require 'seq)
(require 'subr-x)

(declare-function ghostel-paste-string "ext:ghostel" (string))
(declare-function ghostel-send-key "ext:ghostel" (key-name &optional mods))
(declare-function vterm-send-string "ext:vterm" (string &optional paste-p))
(declare-function vterm-send-return "ext:vterm" ())
(declare-function eat-term-send-string "ext:eat" (terminal string))
(declare-function term-send-raw-string "term" (chars))
(declare-function comint-send-input "comint" (&optional no-newline artificial))
(declare-function eshell-send-input "esh-mode" (&optional use-region queue-p no-newline))
(defvar eat-terminal)

(defvar pi-sound-target-functions nil
  "Functions describing the target of a dictation that starts here.
Each is called without arguments in the buffer and at the point where the
dictation starts; the first non-nil value, a target plist as described in
the Commentary of pi-sound-target.el, is used.  Without one, the built-in
targets decide.")

(defcustom pi-sound-unformatted-modes
  '(ghostel-mode vterm-mode eat-mode term-mode comint-mode eshell-mode)
  "Major modes whose buffers take transcripts without `dictatedFormat'.
Terminals and shells run what they receive, so their text stays verbatim."
  :type '(repeat symbol)
  :group 'pi-sound)

(defface pi-sound-partial
  '((t :inherit shadow))
  "Live transcript shown at the target before it is inserted."
  :group 'pi-sound)

(defvar pi-sound-dictated-format nil
  "Format of dictated text, or nil.
Its one %s stands for the transcript.  The CLI reports its
`dictatedFormat' setting, default \"(dictated) %s\", so the model can
read a misheard word as a transcription error.")

(defun pi-sound-format-dictated (text)
  "Return TEXT in `pi-sound-dictated-format', or TEXT when there is none."
  (if pi-sound-dictated-format
      (string-replace "%s" text pi-sound-dictated-format)
    text))

;;;; Resolving

(defun pi-sound--resolve-target ()
  "Return the complete target of a dictation starting here."
  (let* ((target (copy-sequence (or (run-hook-with-args-until-success
                                     'pi-sound-target-functions)
                                    (pi-sound--builtin-target))))
         (buffer (or (plist-get target :buffer) (current-buffer))))
    (cl-flet ((default (key value)
                (unless (plist-member target key)
                  (setq target (plist-put target key value)))))
      (default :buffer buffer)
      (default :position (with-current-buffer buffer (point-marker)))
      (let ((position (plist-get target :position)))
        (default :insert (lambda (text) (pi-sound--insert-at position text))))
      (default :format (and (not (plist-get target :normalize))
                            (not (with-current-buffer buffer
                                   (apply #'derived-mode-p pi-sound-unformatted-modes)))))
      (default :auto-stop (and (plist-get target :submit) t))
      (default :valid-p (lambda () (buffer-live-p buffer)))
      (plist-put target :depth (minibuffer-depth)))))

(defun pi-sound--builtin-target ()
  "Return the built-in target of the current buffer."
  (cond ((minibufferp nil t) (pi-sound--minibuffer-target))
        ((pi-sound--terminal-target))
        (t (list))))

(defun pi-sound--terminal-target ()
  "Return the target of a terminal or shell buffer, or nil.
They submit on the send word only: a pause never runs a command."
  (cond
   ((derived-mode-p 'ghostel-mode)
    (list :insert #'ghostel-paste-string
          :submit (lambda () (ghostel-send-key "return")) :auto-stop 'word))
   ((derived-mode-p 'vterm-mode)
    (list :insert (lambda (text) (vterm-send-string text t))
          :submit #'vterm-send-return :auto-stop 'word))
   ((derived-mode-p 'eat-mode)
    (list :insert (lambda (text) (eat-term-send-string eat-terminal text))
          :submit (lambda () (eat-term-send-string eat-terminal "\r")) :auto-stop 'word))
   ((derived-mode-p 'term-mode)
    (list :insert #'term-send-raw-string
          :submit (lambda () (term-send-raw-string "\r")) :auto-stop 'word))
   ((derived-mode-p 'comint-mode)
    (list :submit #'comint-send-input :command 'comint-send-input :auto-stop 'word))
   ((derived-mode-p 'eshell-mode)
    (list :submit #'eshell-send-input :command 'eshell-send-input :auto-stop 'word))))

;;;; Minibuffer prompts

(defvar-local pi-sound--prompt-token nil
  "Identifies the prompt a dictation started in.
Leaving the prompt resets the minibuffer's local variables, so a later
prompt reusing the buffer never matches.")

(defun pi-sound--y-or-n-prompt-p ()
  "Return non-nil if the current minibuffer reads a `y-or-n-p' key."
  (eq (keymap-lookup (current-local-map) "<remap> <self-insert-command>")
      'y-or-n-p-insert-other))

(defun pi-sound--yes-or-no-prompt-p ()
  "Return non-nil if the current minibuffer asks a yes or no question."
  (or (pi-sound--y-or-n-prompt-p)
      (eq minibuffer-history-variable 'yes-or-no-p-history)))

(defun pi-sound--minibuffer-target ()
  "Return the target of the active minibuffer prompt in the current buffer."
  (let* ((buffer (current-buffer))
         (token (setq pi-sound--prompt-token (list 'prompt)))
         (press-return (lambda () (pi-sound--press buffer ?\r))))
    (append
     (cond
      ;; `y-or-n-p' answers with a key.
      ((pi-sound--y-or-n-prompt-p)
       (list :normalize #'pi-sound--yes-or-no
             :insert (lambda (answer)
                       (if (member answer '("yes" "no"))
                           (pi-sound--press buffer (if (equal answer "yes") ?y ?n))
                         (error "Not a yes or no answer: %s" answer)))
             :auto-stop t))
      ((eq minibuffer-history-variable 'yes-or-no-p-history)
       (list :normalize #'pi-sound--yes-or-no
             :insert #'pi-sound--replace-minibuffer :submit press-return))
      (minibuffer-completion-table
       (list :insert #'pi-sound--insert-completion :format nil :submit press-return))
      (t (list :submit press-return)))
     (list :buffer buffer
           :command (keymap-lookup nil "RET")
           :valid-p (lambda ()
                      (and (buffer-live-p buffer)
                           (minibufferp buffer t)
                           (eq (buffer-local-value 'pi-sound--prompt-token buffer) token)))))))

(defun pi-sound--press (buffer key)
  "Have the minibuffer prompt in BUFFER read KEY next, as if typed."
  (when-let* ((window (active-minibuffer-window))
              ((eq (window-buffer window) buffer)))
    (select-window window))
  (setq unread-command-events (append unread-command-events (list key))))

(defun pi-sound--yes-or-no (text)
  "Return \"yes\" or \"no\" for TEXT that says so, else TEXT."
  (let ((word (downcase (string-trim (replace-regexp-in-string "[[:punct:]]" "" text)))))
    (cond ((member word '("yes" "yeah" "yep" "y")) "yes")
          ((member word '("no" "nope" "n")) "no")
          (t text))))

(defun pi-sound--replace-minibuffer (text)
  "Replace the prompt's input with TEXT."
  (delete-minibuffer-contents)
  (insert text))

(defun pi-sound--insert-completion (text)
  "Replace the input with the candidate TEXT names, or insert TEXT at point.
A candidate is named when it equals TEXT ignoring case and punctuation."
  (let* ((key (lambda (string)
                (downcase (string-trim (replace-regexp-in-string "[[:punct:]]" "" string)))))
         (spoken (funcall key text))
         (matches (seq-filter (lambda (candidate) (equal (funcall key candidate) spoken))
                              (all-completions "" minibuffer-completion-table
                                               minibuffer-completion-predicate))))
    (if (= (length matches) 1)
        (pi-sound--replace-minibuffer (car matches))
      (insert text))))

;;;; Delivering

(defun pi-sound--separator (position)
  "Return the space to put before text inserted at POSITION, or \"\".
None at the buffer start, after whitespace or after read-only text such
as a prompt."
  (if (and (> position (point-min))
           (not (memq (char-before position) '(?\s ?\t ?\n)))
           (not (get-text-property (1- position) 'read-only)))
      " "
    ""))

(defun pi-sound--insert-at (marker text)
  "Insert TEXT at MARKER after `pi-sound--separator'; point moves along."
  (let* ((position (marker-position marker))
         (at-point (= (point) position))
         (text (concat (pi-sound--separator position) text)))
    (save-excursion (goto-char position) (insert text))
    (when at-point (goto-char (+ position (length text))))
    (dolist (window (get-buffer-window-list nil nil t))
      (when (= (window-point window) position)
        (set-window-point window (+ position (length text)))))))

(defun pi-sound--keep (text reason)
  "Put TEXT on the kill ring because of REASON and say so."
  (if (string-empty-p text)
      (message "Dictation: nothing sent (%s)" reason)
    (kill-new text)
    (message "Dictation copied (%s): %s" reason text)))

(defun pi-sound--deliver (target text send)
  "Give TARGET the final TEXT, then with SEND submit it.
TEXT is normalized or formatted as TARGET says.  Empty TEXT only submits."
  (let* ((buffer (plist-get target :buffer))
         (normalize (plist-get target :normalize))
         (text (cond ((string-empty-p text) text)
                     (normalize (funcall normalize text))
                     ((plist-get target :format) (pi-sound-format-dictated text))
                     (t text))))
    (cond
     ((not (funcall (plist-get target :valid-p)))
      (pi-sound--keep text "its target is gone"))
     ((and (not (string-empty-p text))
           (condition-case error
               (progn (with-current-buffer buffer (funcall (plist-get target :insert) text))
                      nil)
             (error (pi-sound--keep text (error-message-string error)) t))))
     ((and send (plist-get target :submit))
      (pi-sound--submit-when-ready target))
     ((not (string-empty-p text)) (message "Dictated: %s" text)))))

(defun pi-sound--submit-when-ready (target)
  "Submit TARGET once no prompt newer than its start is open."
  (if (> (minibuffer-depth) (plist-get target :depth))
      (letrec ((retry (lambda ()
                        (remove-hook 'minibuffer-exit-hook retry)
                        ;; The exit hook runs before the prompt is gone.
                        (run-at-time 0 nil #'pi-sound--submit-when-ready target))))
        (add-hook 'minibuffer-exit-hook retry))
    (when (funcall (plist-get target :valid-p))
      (with-current-buffer (plist-get target :buffer)
        (funcall (plist-get target :submit))))))

;;;; Live transcript

(defvar pi-sound--preview nil
  "Overlay showing the live transcript at the target, or nil.")

(defun pi-sound--show-preview (target text)
  "Show TEXT in `pi-sound-partial' where TARGET's text will go."
  (let ((marker (plist-get target :position)))
    (when-let* (((not (string-empty-p text)))
                (buffer (marker-buffer marker)))
      (with-current-buffer buffer
        (unless (and (overlayp pi-sound--preview) (overlay-buffer pi-sound--preview))
          (setq pi-sound--preview (make-overlay marker marker)))
        (move-overlay pi-sound--preview marker marker buffer)
        (let ((string (propertize (concat (pi-sound--separator marker) text)
                                  'face 'pi-sound-partial)))
          ;; The cursor stays at the insertion point, before the preview.
          (put-text-property 0 1 'cursor t string)
          ;; A before-string follows after-strings ending here, such as a
          ;; prompt's dictation button.
          (overlay-put pi-sound--preview 'before-string string))))))

(defun pi-sound--hide-preview ()
  "Remove the live transcript."
  (when (overlayp pi-sound--preview)
    (delete-overlay pi-sound--preview))
  (setq pi-sound--preview nil))

(provide 'pi-sound-target)
;;; pi-sound-target.el ends here
