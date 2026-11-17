;;; pi-sound-test.el --- Tests for pi-sound.el -*- lexical-binding: t; -*-

;; Run: emacs -Q --batch -L emacs -l emacs/pi-sound-test.el -f ert-run-tests-batch-and-exit

;;; Code:

(require 'ert)
(require 'cl-lib)
(require 'pi-sound)

(defconst pi-sound-test--script "#!/bin/sh
# Fake pi-sound CLI; PI_SOUND_FAKE selects the dictation behaviour.
case \"$1\" in
play|notify)
  printf '%s|' \"$@\" >> \"$PI_SOUND_LOG\"; echo >> \"$PI_SOUND_LOG\"
  echo noise; echo noise >&2
  exit 0 ;;
mode)
  echo '{\"mode\":\"send\"}'
  exit 0 ;;
dictate)
  [ -n \"$PI_SOUND_ARGS\" ] && printf '%s|' \"$@\" > \"$PI_SOUND_ARGS\"
  case \"$PI_SOUND_FAKE\" in
  error) echo '{\"type\":\"error\",\"message\":\"No microphone connected\"}'; exit 0 ;;
  crash) echo boom >&2; exit 3 ;;
  esac
  printf '{\"type\":\"ready\",\"device\":\"test-device\",\"backend\":\"fake\",\"mode\":\"%s\",\"dictatedFormat\":\"%s\"}\\n' \"${PI_SOUND_MODE:-type}\" \"${PI_SOUND_FORMAT-(dictated) %s}\"
  echo '{\"type\":\"partial\",\"text\":\"hel\"}'
  cat >/dev/null
  if [ \"$PI_SOUND_FAKE\" = send-it ]; then
    printf '{\"type\":\"final\",\"text\":\"%s\",\"send\":true}\\n' \"${PI_SOUND_TEXT:-hello there}\"; exit 0
  fi
  if [ \"$PI_SOUND_FAKE\" = clear ]; then
    echo '{\"type\":\"final\",\"text\":\"\",\"clear\":true}'; exit 0
  fi
  # A JSON line split across writes.
  printf '{\"type\":\"final\",\"te'; printf 'xt\":\"%s\"}\\n' \"${PI_SOUND_TEXT:-hello there}\" ;;
esac
")

(define-derived-mode pi-sound-test-input-mode text-mode "Test-Input"
  "Stands in for a Pilish input buffer.")

(defmacro pi-sound-test--with-fake (env &rest body)
  "Run BODY with `pi-sound-program' a fake CLI and ENV added to the environment."
  (declare (indent 1))
  `(let* ((dir (make-temp-file "pi-sound-test" t))
          (pi-sound-program (expand-file-name "pi-sound" dir))
          (process-environment (append ,env process-environment))
          (pi-sound-state 'idle)
          (pi-sound-delivery nil)
          (pi-sound-dictated-format nil)
          (pi-sound-target-functions nil)
          (pi-sound-device nil)
          (pi-sound--process nil)
          (pi-sound--target nil)
          (states nil)
          (pi-sound-state-change-functions (list (lambda (state) (push state states)))))
     (with-temp-file pi-sound-program (insert pi-sound-test--script))
     (set-file-modes pi-sound-program #o755)
     (unwind-protect (progn ,@body)
       (when (process-live-p pi-sound--process) (delete-process pi-sound--process))
       (delete-directory dir t))))

(defun pi-sound-test--until (predicate)
  "Wait up to 5 seconds for PREDICATE."
  (let ((deadline (+ (float-time) 5)))
    (while (and (not (funcall predicate)) (< (float-time) deadline))
      (accept-process-output nil 0.05))
    (should (funcall predicate))))

(defun pi-sound-test--record ()
  "Start dictating, wait until recording, then stop and wait until idle."
  (pi-sound-dictate)
  (pi-sound-test--until (lambda () (eq pi-sound-state 'recording)))
  (pi-sound-dictate)
  (pi-sound-test--until (lambda () (and (eq pi-sound-state 'idle) (null pi-sound--process)))))

(defun pi-sound-test--args (file)
  "Return the CLI arguments the fake recorded in FILE."
  (split-string (with-temp-buffer (insert-file-contents file) (buffer-string)) "|"))

(ert-deftest pi-sound-type-inserts-at-start-with-spacing-and-preview ()
  (let ((args (make-temp-file "pi-sound-args")))
    (unwind-protect
        (pi-sound-test--with-fake (list (concat "PI_SOUND_ARGS=" args))
          (with-temp-buffer
            (insert "say")
            (pi-sound-dictate)
            (pi-sound-test--until (lambda () (eq pi-sound-state 'recording)))
            (should (equal pi-sound-device "test-device"))
            (should (equal pi-sound-delivery "type"))
            ;; An ordinary buffer cannot submit: no stopping by itself.
            (should (equal (pi-sound-test--args args)
                           '("dictate" "--send-word" "" "--pause-ms" "0" "")))
            ;; The live transcript shows where the text will go, as no text.
            (pi-sound-test--until (lambda () (overlayp pi-sound--preview)))
            (should (= (overlay-start pi-sound--preview) 4))
            (let ((preview (overlay-get pi-sound--preview 'before-string)))
              (should (equal (substring-no-properties preview) " hel"))
              (should (eq (get-text-property 1 'face preview) 'pi-sound-partial)))
            (should (equal (buffer-string) "say"))
            ;; Typing while recording does not move the insertion point.
            (insert "!")
            (goto-char 4)
            (pi-sound-dictate)
            (should (eq pi-sound-state 'transcribing))
            (pi-sound-test--until (lambda () (eq pi-sound-state 'idle)))
            (should-not pi-sound--preview)
            (should-not (overlays-in (point-min) (point-max)))
            (should (equal (buffer-string) "say (dictated) hello there!"))
            (should (= (point) (+ 4 (length " (dictated) hello there"))))
            (should (equal (reverse states) '(connecting recording transcribing idle)))
            (should (null pi-sound-device))))
      (delete-file args))))

(defvar pi-sound-test--sent nil)

(defun pi-sound-test--send ()
  "Record the buffer as sent."
  (interactive)
  (push (buffer-string) pi-sound-test--sent))

(defun pi-sound-test--input-target ()
  "Stand in for the Pilish input target in `pi-sound-test-input-mode'."
  (when (derived-mode-p 'pi-sound-test-input-mode)
    (list :submit #'pi-sound-test--send :command 'pi-sound-test--send)))

(ert-deftest pi-sound-send-submits-only-targets-that-can ()
  (let ((args (make-temp-file "pi-sound-args")))
    (unwind-protect
        (pi-sound-test--with-fake (list "PI_SOUND_MODE=send" (concat "PI_SOUND_ARGS=" args))
          (let ((pi-sound-test--sent nil)
                (pi-sound-target-functions (list #'pi-sound-test--input-target)))
            (with-temp-buffer
              (pi-sound-test-input-mode)
              (insert "draft")
              (pi-sound-test--record)
              ;; A target that submits keeps the CLI's own stops.
              (should (equal (pi-sound-test--args args) '("dictate" "")))
              (should (equal pi-sound-test--sent '("draft (dictated) hello there"))))
            ;; Other buffers only insert.
            (with-temp-buffer
              (pi-sound-test--record)
              (should (equal (buffer-string) "(dictated) hello there"))
              (should (= (length pi-sound-test--sent) 1)))))
      (delete-file args)))
  ;; The dictatedFormat setting replaces the format; terminals and shells
  ;; take the text verbatim.
  (pi-sound-test--with-fake '("PI_SOUND_FORMAT=<%s>")
    (with-temp-buffer
      (pi-sound-test--record)
      (should (equal (buffer-string) "<hello there>")))
    (with-temp-buffer
      (let ((pi-sound-unformatted-modes '(pi-sound-test-input-mode)))
        (pi-sound-test-input-mode)
        (pi-sound-test--record)
        (should (equal (buffer-string) "hello there"))))))

(ert-deftest pi-sound-send-it-and-the-send-command-submit-in-type-mode ()
  ;; The CLI reports a send (a final "send" or a pause); the input dictated
  ;; into is sent even after moving to another buffer.
  (pi-sound-test--with-fake '("PI_SOUND_FAKE=send-it")
    (let ((pi-sound-target-functions (list #'pi-sound-test--input-target))
          (pi-sound-test--sent nil)
          (input (generate-new-buffer " *pi-sound-input*"))
          (other (generate-new-buffer " *pi-sound-other*")))
      (unwind-protect
          (save-window-excursion
            (switch-to-buffer input)
            (pi-sound-test-input-mode)
            (insert "draft")
            (pi-sound-dictate)
            (pi-sound-test--until (lambda () (eq pi-sound-state 'recording)))
            (switch-to-buffer other)
            (pi-sound-dictate)
            (pi-sound-test--until (lambda () (and (eq pi-sound-state 'idle) (null pi-sound--process))))
            (should (equal pi-sound-test--sent '("draft (dictated) hello there")))
            (should (eq (current-buffer) other))
            (should (equal (with-current-buffer other (buffer-string)) "")))
        (kill-buffer input)
        (kill-buffer other))))
  ;; While dictating, the buffer's send command stops and then sends.
  (pi-sound-test--with-fake nil
    (let ((pi-sound-target-functions (list #'pi-sound-test--input-target))
          (pi-sound-test--sent nil))
      (with-temp-buffer
        (pi-sound-test-input-mode)
        (insert "draft")
        (should-not (command-remapping 'pi-sound-test--send))
        (pi-sound-dictate)
        (pi-sound-test--until (lambda () (eq pi-sound-state 'recording)))
        (let ((command (command-remapping 'pi-sound-test--send)))
          (should (eq command 'pi-sound-stop-and-send))
          (call-interactively command))
        (should (eq pi-sound-state 'transcribing))
        (pi-sound-test--until (lambda () (and (eq pi-sound-state 'idle) (null pi-sound--process))))
        (should (equal pi-sound-test--sent '("draft (dictated) hello there")))
        (should-not (command-remapping 'pi-sound-test--send))
        ;; Without that request, type mode only inserts.
        (pi-sound-test--record)
        (should (equal pi-sound-test--sent '("draft (dictated) hello there")))
        (should (equal (buffer-string)
                       "draft (dictated) hello there (dictated) hello there"))))))

(ert-deftest pi-sound-clear-word-discards-everywhere ()
  ;; A final "clear" neither inserts nor submits, even in send mode or after
  ;; the send command asked to send, and keeps the kill ring.
  (pi-sound-test--with-fake '("PI_SOUND_FAKE=clear" "PI_SOUND_MODE=send")
    (let ((pi-sound-target-functions (list #'pi-sound-test--input-target))
          (pi-sound-test--sent nil)
          (kill-ring nil))
      (with-temp-buffer
        (pi-sound-test-input-mode)
        (insert "draft")
        (pi-sound-dictate)
        (pi-sound-test--until (lambda () (eq pi-sound-state 'recording)))
        (call-interactively (command-remapping 'pi-sound-test--send))
        (pi-sound-test--until (lambda () (and (eq pi-sound-state 'idle) (null pi-sound--process))))
        (should (equal (buffer-string) "draft")))
      (with-temp-buffer
        (insert "say")
        (pi-sound-test--record)
        (should (equal (buffer-string) "say")))
      (with-temp-buffer
        (insert "read only")
        (setq buffer-read-only t)
        (pi-sound-test--record))
      (should-not pi-sound-test--sent)
      (should-not kill-ring))))

(ert-deftest pi-sound-cancel-inserts-nothing ()
  (pi-sound-test--with-fake nil
    (with-temp-buffer
      (pi-sound-dictate)
      (pi-sound-test--until (lambda () (eq pi-sound-state 'recording)))
      (pi-sound-cancel)
      (accept-process-output nil 0.2)
      (should (equal (buffer-string) ""))
      (should (eq pi-sound-state 'idle))
      (should (null pi-sound--process)))))

(ert-deftest pi-sound-read-only-goes-to-kill-ring ()
  (pi-sound-test--with-fake nil
    (let ((kill-ring nil))
      (with-temp-buffer
        (pi-sound-dictate)
        (pi-sound-test--until (lambda () (eq pi-sound-state 'recording)))
        (setq buffer-read-only t)
        (pi-sound-dictate)
        (pi-sound-test--until (lambda () (eq pi-sound-state 'idle)))
        (should (equal (buffer-string) ""))
        (should (equal (car kill-ring) "(dictated) hello there"))))))

(ert-deftest pi-sound-undeliverable-text-goes-to-the-kill-ring ()
  (pi-sound-test--with-fake nil
    (let ((kill-ring nil))
      ;; Read-only text, such as a widget's label, signals; the text is kept.
      (with-temp-buffer
        (insert (propertize "label" 'read-only t))
        (let ((inhibit-read-only t)) (insert "field"))
        (goto-char 3)
        (pi-sound-test--record)
        (should (equal (buffer-substring-no-properties (point-min) (point-max)) "labelfield"))
        (should (equal (car kill-ring) "(dictated) hello there")))
      ;; So is text whose buffer is gone.
      (let ((buffer (generate-new-buffer " *pi-sound-gone*")))
        (with-current-buffer buffer
          (pi-sound-dictate)
          (pi-sound-test--until (lambda () (eq pi-sound-state 'recording))))
        (kill-buffer buffer)
        (setq kill-ring nil)
        (pi-sound-dictate)
        (pi-sound-test--until (lambda () (and (eq pi-sound-state 'idle) (null pi-sound--process))))
        (should (equal (car kill-ring) "(dictated) hello there"))))))

(ert-deftest pi-sound-submit-waits-for-a-newer-prompt ()
  (let* ((submitted 0)
         (target (list :buffer (current-buffer) :depth 0
                       :valid-p #'always :submit (lambda () (cl-incf submitted))))
         (depth 1)
         (minibuffer-exit-hook nil))
    (cl-letf (((symbol-function 'minibuffer-depth) (lambda () depth)))
      (pi-sound--submit-when-ready target)
      (should (= submitted 0))
      (should minibuffer-exit-hook)
      ;; The prompt closes: the exit hook runs while it is still open.
      (setq depth 0)
      (run-hooks 'minibuffer-exit-hook)
      (should-not minibuffer-exit-hook)
      (pi-sound-test--until (lambda () (= submitted 1))))))

(ert-deftest pi-sound-auto-stop-chooses-the-cli-stops ()
  (should (equal (pi-sound--dictate-arguments '(:auto-stop t)) '("dictate")))
  (should (equal (pi-sound--dictate-arguments '(:auto-stop word))
                 '("dictate" "--pause-ms" "0")))
  (should (equal (pi-sound--dictate-arguments '(:auto-stop nil))
                 '("dictate" "--send-word" "" "--pause-ms" "0"))))

(ert-deftest pi-sound-prompt-answers-are-normalized ()
  (should (equal (pi-sound--yes-or-no "Yes.") "yes"))
  (should (equal (pi-sound--yes-or-no "Nope!") "no"))
  (should (equal (pi-sound--yes-or-no "maybe") "maybe"))
  (with-temp-buffer
    (let ((minibuffer-completion-table '("Apple pie" "Banana" "banana split"))
          (minibuffer-completion-predicate nil))
      (insert "x")
      (pi-sound--insert-completion "Apple pie.")
      (should (equal (buffer-string) "Apple pie"))
      ;; No unique candidate: the text is inserted as said.
      (pi-sound--insert-completion " cherry")
      (should (equal (buffer-string) "Apple pie cherry")))))

(ert-deftest pi-sound-mode-shows-the-indicator-and-prompt-buttons ()
  (let ((global-mode-string nil)
        (minibuffer-setup-hook nil)
        (minibuffer-exit-hook nil)
        (pi-sound-state 'idle)
        (pi-sound--prompt-buttons nil))
    (unwind-protect
        (progn
          (pi-sound-mode 1)
          (should (member pi-sound--mode-line-entry global-mode-string))
          (should-not (pi-sound--mode-line))
          (let ((pi-sound-state 'recording) (pi-sound-device "test-device"))
            (should (string-match-p "REC test-device" (pi-sound--mode-line))))
          (should (memq #'pi-sound--add-prompt-button minibuffer-setup-hook))
          ;; A prompt's button follows the state and leaves with the prompt.
          (with-temp-buffer
            (insert (propertize "Name: " 'read-only t 'field t))
            (cl-letf (((symbol-function 'minibuffer-prompt-end) (lambda () 7)))
              (pi-sound--add-prompt-button))
            (let ((overlay (car pi-sound--prompt-buttons)))
              (should (string-match-p "🎤" (overlay-get overlay 'after-string)))
              (should (eq (keymap-lookup (get-text-property 1 'local-map
                                                            (overlay-get overlay 'after-string))
                                         "<mouse-1>")
                          'pi-sound-button-click))
              (let ((pi-sound-state 'recording)) (pi-sound--refresh-prompt-buttons))
              (should (string-match-p "REC" (overlay-get overlay 'after-string)))
              (pi-sound--remove-prompt-button)
              (should-not pi-sound--prompt-buttons)
              (should-not (overlay-buffer overlay))))
          ;; Yes or no questions are answered by their keys, without a button.
          (with-temp-buffer
            (let ((minibuffer-history-variable 'yes-or-no-p-history))
              (pi-sound--add-prompt-button))
            (use-local-map y-or-n-p-map)
            (pi-sound--add-prompt-button)
            (should-not pi-sound--prompt-buttons)))
      (pi-sound-mode -1))
    (should-not (member pi-sound--mode-line-entry global-mode-string))
    (should-not (memq #'pi-sound--add-prompt-button minibuffer-setup-hook))))

(ert-deftest pi-sound-errors-and-crashes-return-to-idle ()
  (dolist (fake '("error" "crash"))
    (pi-sound-test--with-fake (list (concat "PI_SOUND_FAKE=" fake))
      (with-temp-buffer
        (pi-sound-dictate)
        (pi-sound-test--until (lambda () (and (eq pi-sound-state 'idle) (null pi-sound--process))))
        (should (equal (buffer-string) ""))
        (should (equal (reverse states) '(connecting idle))))))
  (let ((pi-sound-program "/nonexistent/pi-sound") (pi-sound-state 'idle))
    (with-temp-buffer
      (should-error (pi-sound-dictate) :type 'user-error)
      (should (eq pi-sound-state 'idle)))))

(ert-deftest pi-sound-toggle-mode-reads-the-cli ()
  (pi-sound-test--with-fake nil
    (pi-sound-toggle-mode)
    (should (equal pi-sound-delivery "send"))))

(ert-deftest pi-sound-button-shows-state-and-dispatches-clicks ()
  (pi-sound-test--with-fake nil
    (let ((button (pi-sound-button)))
      (should (string-match-p "🎤" button))
      (should (string-match-p "type or send" (get-text-property 1 'help-echo button)))
      (let ((map (get-text-property 1 'local-map button)))
        (should (eq (keymap-lookup map "<header-line> <mouse-1>") 'pi-sound-button-click))
        (should (eq (keymap-lookup map "<header-line> <mouse-3>") 'pi-sound-button-click))
        (should (eq (keymap-lookup map "<mode-line> <mouse-1>") 'pi-sound-button-click))))
    (setq pi-sound-state 'recording pi-sound-device "test-device" pi-sound-delivery "send")
    (let ((button (pi-sound-button)))
      (should (string-match-p "● REC test-device" button))
      (should (eq (get-text-property 1 'face button) 'pi-sound-recording))
      (should (string-match-p "stop dictation.*(send)" (get-text-property 1 'help-echo button))))
    (setq pi-sound-state 'transcribing)
    (should (equal (substring-no-properties (pi-sound-button)) " … "))
    (let (called)
      (cl-letf (((symbol-function 'pi-sound-dictate) (lambda () (push 'dictate called)))
                ((symbol-function 'pi-sound-toggle-mode) (lambda () (push 'mode called))))
        (pi-sound-button-click '(mouse-1 nil))
        (pi-sound-button-click '(mouse-3 nil))
        (should (equal called '(mode dictate)))))))

(defun pi-sound-test--overlay (window)
  "Return the current buffer's button overlay for WINDOW."
  (let ((overlay (cdr (assq window pi-sound--input-button-overlays))))
    (should (overlay-buffer overlay))
    (should (eq (overlay-get overlay 'window) window))
    overlay))

(defun pi-sound-test--margin-label (window)
  "Return the current buffer's margin button string in WINDOW."
  (let ((display (get-text-property 0 'display
                                    (overlay-get (pi-sound-test--overlay window)
                                                 'before-string))))
    (should (equal (car display) '(margin right-margin)))
    (cadr display)))

(ert-deftest pi-sound-input-button-uses-a-right-margin-beside-the-first-visible-row ()
  (pi-sound-test--with-fake nil
    (let ((pi-sound-input-button t)
          (input (generate-new-buffer " *pi-sound-input*"))
          (other (generate-new-buffer " *pi-sound-other*")))
      (unwind-protect
          (save-window-excursion
            (delete-other-windows)
            (switch-to-buffer other)
            (let ((window (split-window)))
              (with-current-buffer input
                (pi-sound-test-input-mode)
                (pi-sound-input-button-setup)
                (set-window-buffer window input)
                ;; Redisplay runs these hooks; batch Emacs never redisplays.
                (dolist (hook pi-sound--input-button-hooks)
                  (should (memq #'pi-sound--place-input-buttons (symbol-value hook))))
                (pi-sound--place-input-buttons)
                (should (= right-margin-width 3))
                (should (= (cdr (window-margins window)) 3))
                (should (= (overlay-start (pi-sound-test--overlay window)) (point-min)))
                (should (equal (overlay-get (pi-sound-test--overlay window) 'priority) 1))
                (let ((label (pi-sound-test--margin-label window)))
                  (should (equal (substring-no-properties label) " 🎤"))
                  (should (= (string-width label) 3))
                  (should (eq (keymap-lookup (get-text-property 1 'local-map label)
                                             "<right-margin> <mouse-1>")
                              'pi-sound-button-click)))
                ;; A scrolled draft has it beside the first visible row.
                (dotimes (line 30) (insert (format "line %d\n" line)))
                (let ((start (save-excursion (goto-char (point-min)) (forward-line 10) (point))))
                  (set-window-start window start)
                  (pi-sound--place-input-buttons)
                  (should (= (overlay-start (pi-sound-test--overlay window)) start)))
                ;; The draft never holds the button.
                (erase-buffer)
                (insert "draft")
                (set-window-start window (point-min))
                (pi-sound--place-input-buttons)
                (should (equal (buffer-string) "draft"))
                (should (= (overlay-start (pi-sound-test--overlay window)) (point-min))))
              ;; States fit the three columns; recording is red.
              (pi-sound--set-state 'connecting)
              (with-current-buffer input
                (should (equal (substring-no-properties (pi-sound-test--margin-label window))
                               " … ")))
              (setq pi-sound-device "test-device")
              (pi-sound--set-state 'recording)
              (with-current-buffer input
                (let ((label (pi-sound-test--margin-label window)))
                  (should (equal (substring-no-properties label) "REC"))
                  (should (eq (get-text-property 0 'face label) 'pi-sound-recording))
                  (should (string-match-p "Recording via test-device\nmouse-1: stop"
                                          (get-text-property 0 'help-echo label)))))
              (pi-sound--set-state 'idle)
              ;; A margin click dictates into the clicked input.
              (let (dictated)
                (cl-letf (((symbol-function 'pi-sound-dictate)
                           (lambda () (push (current-buffer) dictated))))
                  (pi-sound-button-click `(mouse-1 (,window right-margin (0 . 0) 0)))
                  (should (equal dictated (list input)))
                  (should (eq (selected-window) window))))
              ;; The option removes margin and button everywhere, and restores them.
              (customize-set-variable 'pi-sound-input-button nil)
              (with-current-buffer input
                (should-not pi-sound--input-button-overlays)
                (should-not (overlays-in (point-min) (point-max)))
                (should (= right-margin-width 0))
                (should (memq (cdr (window-margins window)) '(nil 0))))
              (customize-set-variable 'pi-sound-input-button t)
              (with-current-buffer input
                (should (= (length (overlays-in (point-min) (point-max))) 1))
                (should (= (cdr (window-margins window)) 3)))
              ;; A buffer not set up gets nothing.
              (with-current-buffer other
                (should-not pi-sound--input-button-overlays)
                (should (= right-margin-width 0)))))
        (kill-buffer input)
        (kill-buffer other)))))

(ert-deftest pi-sound-input-button-adds-to-other-margin-columns ()
  (let ((pi-sound-input-button t))
    (save-window-excursion
      (with-temp-buffer
        (set-window-buffer (selected-window) (current-buffer))
        (pi-sound-test-input-mode)
        ;; Another button, such as Pilish's send button, holds two columns.
        (setq-local right-margin-width 2)
        (pi-sound-input-button-setup)
        (pi-sound-input-button-setup)
        (should (= right-margin-width 5))
        (customize-set-variable 'pi-sound-input-button nil)
        (should (= right-margin-width 2))
        (customize-set-variable 'pi-sound-input-button t)
        (should (= right-margin-width 5))
        ;; A re-run major mode resets the margin; setup reserves it again.
        (pi-sound-test-input-mode)
        (pi-sound-input-button-setup)
        (should (= right-margin-width 3))
        (should (= (length (overlays-in (point-min) (point-max))) 1))
        ;; md-ts-mode's teardown deletes the overlay on a re-run.
        (delete-overlay (cdar pi-sound--input-button-overlays))
        (pi-sound-test-input-mode)
        (pi-sound-input-button-setup)
        (should (= right-margin-width 3))
        (should (= (length (overlays-in (point-min) (point-max))) 1))))))

(ert-deftest pi-sound-input-button-off-reserves-no-margin ()
  (let ((pi-sound-input-button nil))
    (with-temp-buffer
      (pi-sound-test-input-mode)
      (pi-sound-input-button-setup)
      (should-not pi-sound--input-button-overlays)
      (should (= right-margin-width 0)))))

;;;; Prompts (graphical Emacs only)

;; Batch Emacs reads prompts from standard input, so these need a display:
;; xvfb-run emacs -Q -L emacs -l emacs/pi-sound-test.el \
;;   --eval '(ert-run-tests-batch-and-exit "pi-sound-prompt")'

(defun pi-sound-test--answer-prompt (read &optional during)
  "Return what READ, a prompt function, returns while dictating into it.
Dictation starts in the prompt and stops once recording; DURING is called
in the prompt while recording.  Gives up after 5 seconds."
  (let* ((started nil)
         (timer (run-with-timer
                 0.1 0.05
                 (lambda ()
                   (pcase pi-sound-state
                     ('idle (when (and (minibufferp) (not started))
                              (setq started t)
                              (pi-sound-dictate)))
                     ('recording
                      (when (overlayp pi-sound--preview)
                        (when during (funcall during) (setq during nil))
                        (pi-sound-dictate))))))))
    (unwind-protect (with-timeout (5 'timeout) (funcall read))
      (cancel-timer timer)
      (pi-sound-test--until (lambda () (eq pi-sound-state 'idle))))))

(ert-deftest pi-sound-prompt-takes-free-text-yes-no-and-choices ()
  (skip-unless (display-graphic-p))
  (let ((pi-sound-unformatted-modes nil))
    (pi-sound-test--with-fake '("PI_SOUND_FAKE=send-it")
      (let ((during nil))
        (unwind-protect
            (progn
              (pi-sound-mode 1)
              ;; Free text takes the format; the button and the live
              ;; transcript show in the prompt.
              (should (equal (pi-sound-test--answer-prompt
                              (lambda () (read-string "Name: "))
                              (lambda ()
                                (setq during
                                      (list (overlay-get (car pi-sound--prompt-buttons)
                                                         'after-string)
                                            (overlay-buffer pi-sound--preview)
                                            (overlay-get pi-sound--preview 'before-string)))))
                             "(dictated) hello there"))
              (should (string-match-p "REC" (nth 0 during)))
              (should (minibufferp (nth 1 during)))
              (should (equal (substring-no-properties (nth 2 during)) "hel")))
          (pi-sound-mode -1))))
    (pi-sound-test--with-fake '("PI_SOUND_FAKE=send-it" "PI_SOUND_TEXT=Yes.")
      (should (eq (pi-sound-test--answer-prompt (lambda () (yes-or-no-p "Sure? "))) t)))
    ;; y-or-n-p answers with a key, without needing a send.
    (pi-sound-test--with-fake '("PI_SOUND_TEXT=No.")
      (should (eq (pi-sound-test--answer-prompt (lambda () (y-or-n-p "Sure? "))) nil)))
    (pi-sound-test--with-fake '("PI_SOUND_FAKE=send-it" "PI_SOUND_TEXT=beta.")
      (should (equal (pi-sound-test--answer-prompt
                      (lambda () (completing-read "Pick: " '("Alpha" "Beta") nil t)))
                     "Beta")))))

(ert-deftest pi-sound-prompt-closed-meanwhile-keeps-the-text ()
  (skip-unless (display-graphic-p))
  (pi-sound-test--with-fake '("PI_SOUND_FAKE=send-it")
    (let ((kill-ring nil)
          (timer nil))
      ;; The prompt is answered by hand while recording.  Not with RET:
      ;; while recording, that stops the dictation and submits it.
      (setq timer (run-with-timer
                   0.1 0.05
                   (lambda ()
                     (pcase pi-sound-state
                       ('idle (when (minibufferp) (pi-sound-dictate)))
                       ('recording
                        (cancel-timer timer)
                        (insert "x")
                        (exit-minibuffer))))))
      (unwind-protect
          (should (equal (with-timeout (5 'timeout) (read-string "First: ")) "x"))
        (cancel-timer timer))
      ;; The transcript arrives while the next prompt reuses the minibuffer.
      (pi-sound-dictate)
      (should (equal (with-timeout (5 'timeout)
                       (minibuffer-with-setup-hook
                           (lambda ()
                             (run-with-timer
                              0.3 nil (lambda () (setq unread-command-events (list ?y ?\r)))))
                         (read-string "Second: ")))
                     "y"))
      (pi-sound-test--until (lambda () (eq pi-sound-state 'idle)))
      (should (equal (car kill-ring) "(dictated) hello there")))))

;;;; Device output

(ert-deftest pi-sound-play-and-notify-run-in-the-background ()
  (let ((log (make-temp-file "pi-sound-log")))
    (unwind-protect
        (pi-sound-test--with-fake (list (concat "PI_SOUND_LOG=" log))
          (let ((before (length (process-list))))
            (pi-sound-deck-notify 'blocked "main needs attention" "~/x" nil)
            (pi-sound-deck-notify 'finished "main finished" nil nil)
            (pi-sound-play "done")
            (pi-sound-test--until (lambda () (<= (length (process-list)) before)))
            (should (equal (sort (split-string (with-temp-buffer (insert-file-contents log) (buffer-string)) "\n" t))
                           (sort (list "play|request|" "notify|main needs attention|~/x|"
                                       "play|done|" "notify|main finished|" "play|done|")))))
          ;; A missing CLI does nothing.
          (let ((pi-sound-program "/nonexistent/pi-sound"))
            (should-not (pi-sound-play 'done))
            (should-not (pi-sound-notify "x"))))
      (delete-file log))))

;;; pi-sound-test.el ends here
