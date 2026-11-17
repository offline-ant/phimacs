;;; pi-deck-test-fixtures.el --- Shared pi-deck test fixtures -*- lexical-binding: t; -*-

;; SPDX-License-Identifier: MIT

;;; Commentary:

;; Fake Pilish sessions (chat buffers owning pipe processes), real ghostel
;; terminals and real (hidden) tab-bar tabs holding the spaces' layouts.
;; No Pi processes.

;;; Code:

(require 'ert)
(require 'pi-deck)

;; Optional owning checkout, explicitly selected by the caller. No sibling
;; checkout, home package cache or running host is discovered by this suite.
(when-let* ((directory (getenv "PHIMACS_TEST_ORCHESTRATION")))
  (unless (file-name-absolute-p directory)
    (error "PHIMACS_TEST_ORCHESTRATION must be an absolute Lisp source directory"))
  (add-to-list 'load-path directory))

(defvar-local pi-deck-test--runtime nil
  "Synthetic public runtime identity for a fake chat, nil for unshared fixtures.")

(defun pi-deck-test--desktop-state (buffer)
  "Return the fake BUFFER's opaque public desktop state without filesystem I/O."
  (list :directory (pilish-session-directory buffer) :name (pilish-session-name buffer)
        :session-file (pilish-session-file buffer)
        :runtime (buffer-local-value 'pi-deck-test--runtime buffer)
        :draft (when-let* ((input (pilish-session-input-buffer buffer)))
                 (with-current-buffer input (buffer-string)))
        :images nil :followups nil :quarantine nil :leaf-id nil))

(defun pi-deck-test--restore-view (state)
  "Restore fake STATE as a stopped view; never start a real Pi or shell."
  (let ((chat (pi-deck-test--session (plist-get state :directory) (plist-get state :name))))
    (with-current-buffer chat
      (setq pi-deck-test--runtime (copy-tree (plist-get state :runtime))
            pilish--state (plist-put pilish--state :session-file (plist-get state :session-file))))
    (with-current-buffer (pilish-session-input-buffer chat)
      (insert (or (plist-get state :draft) "")))
    (delete-process (pilish-session-process chat))
    chat))

(defun pi-deck-test--dispose (buffer)
  "Dispose fake BUFFER and its input without issuing another runtime stop."
  (when (buffer-live-p buffer)
    (let ((input (pilish-session-input-buffer buffer))
          (process (pilish-session-process buffer))
          (pilish-quit-without-confirmation t)
          (kill-buffer-query-functions nil))
      (when (and process (process-live-p process)) (delete-process process))
      (when (buffer-live-p input) (kill-buffer input))
      (when (buffer-live-p buffer) (kill-buffer buffer)))))

(defvar pi-deck-test--notifications nil
  "Notifications delivered during a test, newest first.")

(defun pi-deck-test--wait (predicate &optional seconds)
  "Process events until PREDICATE holds or SECONDS (default 5) pass."
  (let ((deadline (+ (float-time) (or seconds 5))))
    (while (and (not (funcall predicate)) (< (float-time) deadline))
      (accept-process-output nil 0.02))
    (funcall predicate)))

(defmacro pi-deck-test--with-large-frame (&rest body)
  "Run BODY in a 160x50 batch frame, room for panes side by side."
  (declare (indent 0))
  `(progn
     (set-frame-size nil 160 50)
     (unwind-protect (progn ,@body)
       (set-frame-size nil 80 25))))

(defmacro pi-deck-test--with-deck (&rest body)
  "Run BODY with a clean deck, one ungrouped tab and temporary state files."
  (declare (indent 0))
  `(let* ((dir (make-temp-file "pi-deck-test-" t))
          (pi-deck-state-file (expand-file-name "state.eld" dir))
          (pi-deck-preferences-file (expand-file-name "preferences.eld" dir))
          (pi-deck--agents (make-hash-table :test 'eq))
          (pi-deck-spaces nil)
          (pi-deck--layouts nil)
          (pi-deck--last-space nil)
          (pi-deck-sidebar nil)
          (pi-deck-sidebar-width pi-deck-sidebar-width)
          (pi-deck-save-delay nil)
          ;; This Emacs owns the temporary state file; restores run at once.
          (pi-deck--state-claimed t)
          (pi-deck--state-owner "/tmp/pi-deck-test-owner")
          (pi-deck--state-backup-pending nil)
          (pi-deck--restoring nil)
          (pi-deck--restore-failures nil)
          (pi-deck--restored-buffers nil)
          (pi-deck--restored-links nil)
          (pi-deck-restore-interval 0)
          (pi-deck--finished-workers nil)
          (pi-deck--pending-reveal nil)
          (pi-deck-new-space-action 'dired)
          (pi-deck-test--notifications nil)
          (pi-deck-notify-function
           (lambda (title body agent) (push (list title body agent) pi-deck-test--notifications)))
          (pilish-extension-dialog-style 'minibuffer)
          (tab-bar-tabs-function #'tab-bar-tabs)
          (kill-buffer-query-functions nil))
     ;; Public API stubs belong only to this synthetic fixture boundary;
     ;; native protocol/reconnect acceptance uses the real checkout separately.
     (cl-letf (((symbol-function 'pilish-session-runtime)
                (lambda (buffer) (buffer-local-value 'pi-deck-test--runtime buffer)))
               ((symbol-function 'pilish-session-desktop-state) #'pi-deck-test--desktop-state)
               ((symbol-function 'pilish-restore-session-state) #'pi-deck-test--restore-view)
               ((symbol-function 'pilish-list-runtimes) (lambda () nil))
               ((symbol-function 'pilish-attach-runtime)
                (lambda (&rest _) (ert-fail "No runtime attachment expected in unshared fake fixture")))
               ((symbol-function 'pilish-reconnect-runtime)
                (lambda (_buffer &optional callback) (when callback (funcall callback nil))))
               ((symbol-function 'pilish-resume-stopped-session)
                (lambda (_buffer &optional callback) (when callback (funcall callback nil))))
               ((symbol-function 'pilish-stop-runtime)
                (lambda (_buffer &optional callback) (when callback (funcall callback nil))))
               ((symbol-function 'pilish-disconnect-session) #'pi-deck-test--dispose))
     (set-frame-parameter nil 'tabs nil)
     (unwind-protect
         (progn
           (pi-deck-mode 1)
           ,@body)
       (pi-deck-mode -1)
       (dolist (buffer (buffer-list))
         (when (or (pi-deck-pi-buffer-p buffer) (pi-deck-shell-buffer-p buffer)
                   (string-prefix-p "*pi-deck" (buffer-name buffer)))
           (when-let* ((process (or (get-buffer-process buffer)
                                    (and (pi-deck-pi-buffer-p buffer)
                                         (pilish-session-process buffer)))))
             (set-process-query-on-exit-flag process nil)
             (delete-process process))
           (let ((pilish-quit-without-confirmation t)) (kill-buffer buffer))))
       (set-frame-parameter nil 'tabs nil)
       (delete-other-windows)
       (switch-to-buffer "*scratch*")
       (when pi-deck--update-timer (cancel-timer pi-deck--update-timer)
             (setq pi-deck--update-timer nil))
       (delete-directory dir t)))))

(defun pi-deck-test--require-grammars ()
  "Require explicit native rendering inputs, without prompting or downloading."
  (unless (and (treesit-language-available-p 'markdown)
               (treesit-language-available-p 'markdown-inline))
    (ert-skip "The prepared Emacs directory lacks the two essential Markdown grammars")))

(defun pi-deck-test--session (dir name)
  "Return a fake Pilish chat buffer for DIR and NAME owning a pipe process."
  (pi-deck-test--require-grammars)
  (let* ((dir (file-name-as-directory dir))
         (chat (generate-new-buffer (pilish--buffer-name :chat dir name)))
         (input (generate-new-buffer (pilish--buffer-name :input dir name)))
         (process (make-pipe-process :name (format "pi-deck-fake-%s" name) :noquery t
                                     :sentinel #'pilish--process-sentinel)))
    (with-current-buffer input
      (pilish-input-mode)
      (pilish--set-chat-buffer chat))
    (with-current-buffer chat
      (pilish-chat-mode)
      (pilish--set-chat-session-identity dir name)
      (pilish--set-process process)
      (pilish--set-input-buffer input)
      (setq pilish--state (list :model '(:id "faux-model")
                                :session-file (expand-file-name (format "%s.jsonl" name) dir))))
    (process-put process 'pilish-chat-buffer chat)
    (pi-deck-refresh-agent chat)
    chat))

(defun pi-deck-test--phase (chat phase)
  "Apply Pilish activity PHASE in CHAT through its public hook."
  (with-current-buffer chat (pilish--set-activity-phase phase)))

(defun pi-deck-test--main-windows ()
  "Return the selected frame's live windows outside side windows."
  (cl-remove-if (lambda (window) (window-parameter window 'window-side))
                (window-list nil 'no-minibuf)))

(defun pi-deck-test--in-dired-p (&optional window)
  "Return non-nil when WINDOW (default selected) shows Dired."
  (with-current-buffer (window-buffer window) (derived-mode-p 'dired-mode)))

(defun pi-deck-test--position (property value)
  "Return the first position whose PROPERTY is `equal' to VALUE, or nil."
  (save-excursion
    (goto-char (point-min))
    (when-let* ((match (text-property-search-forward property value #'equal)))
      (prop-match-beginning match))))

(defun pi-deck-test--click (window position &optional type)
  "Return a mouse event of TYPE (default `mouse-1') at POSITION in WINDOW."
  (list (or type 'mouse-1) (list window position '(0 . 0) 0 nil
                                 position '(0 . 0) nil '(0 . 0) '(1 . 1))))

(defun pi-deck-test--settle ()
  "Run timers pi-deck deferred (placing panels after a target started)."
  (pi-deck-test--wait (lambda () nil) 0.05))

(defun pi-deck-test--finished-worker (dir parent name)
  "Close a fake worker NAME of PARENT in DIR; return its finished record."
  (let* ((worker (pi-deck-test--session dir name))
         (file (expand-file-name (format "%s.jsonl" name) dir)))
    (with-temp-file file
      (insert "{\"type\":\"session\",\"version\":3,\"id\":\"s-1\",\"cwd\":\"/tmp\"}\n"))
    (setf (pi-deck-agent-parent (pi-deck-agent worker)) parent
          (pi-deck-agent-target (pi-deck-agent worker)) "t-1")
    (let ((pilish-quit-without-confirmation t))
      (delete-process (pilish-session-process worker))
      (kill-buffer (pilish-session-input-buffer worker))
      (kill-buffer worker))
    (car (pi-deck-finished-workers parent))))

(provide 'pi-deck-test-fixtures)
;;; pi-deck-test-fixtures.el ends here
