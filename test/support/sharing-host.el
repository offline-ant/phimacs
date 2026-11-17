;;; sharing-host.el --- Disposable checkout integration peer -*- lexical-binding: t; -*-
;; SPDX-License-Identifier: MIT
;;; Commentary:
;; Test-only public API driver.  Product sources come from PHIMACS_ROOT and the
;; this checkout's Pilish, dependencies from the explicitly prepared Emacs directory;
;; no user init or personal package directory is loaded.
;;; Code:
(require 'cl-lib)
(require 'json)
(require 'seq)

(defvar sharing-host--views (make-hash-table :test 'equal))
(defvar sharing-host--inputs (make-hash-table :test 'equal))
(defvar sharing-host--responses (make-hash-table :test 'equal))
(defvar sharing-host--ready (make-hash-table :test 'equal))
(defvar sharing-host--stops (make-hash-table :test 'equal))
(defvar sharing-host--confirmations nil)

(defun sharing-host--unexpected-confirmation (&rest arguments)
  "Record and refuse unexpected confirmation ARGUMENTS instead of hanging."
  (push (format "%S" arguments) sharing-host--confirmations)
  (error "Unexpected confirmation during Close regression: %S" arguments))

(dolist (function '(y-or-n-p yes-or-no-p x-popup-dialog))
  (advice-add function :before #'sharing-host--unexpected-confirmation))

;; Complete-profile journeys load this driver after normal profile startup.
(unless (equal (getenv "PHIMACS_SHARING_PROFILE") "1")
;; The prepared Emacs directory supplies dependencies; candidates come from source.
(let ((directory (file-name-as-directory (getenv "PHIMACS_SHARING_EMACS_DIR"))))
  (require 'package)
  (setq package-user-dir (expand-file-name "elpa" directory)
        package-load-list '((pilish nil) all)
        package-archives nil
        user-emacs-directory
        (expand-file-name (concat "client-" (getenv "PHIMACS_SHARING_CLIENT") "/")
                          (getenv "PHIMACS_TEST_ROOT"))
        treesit-extra-load-path (list (expand-file-name "tree-sitter" directory))
        ghostel-module-directory (expand-file-name "ghostel/" directory))
  (package-initialize))
(add-to-list 'load-path (getenv "PHIMACS_SHARING_PILISH"))
(add-to-list 'load-path (expand-file-name "emacs/pi-deck" (getenv "PHIMACS_ROOT")))
(setq load-prefer-newer t
      native-comp-jit-compilation nil
      pilish-essential-grammar-action 'warn
      pilish-extension-dialog-style 'inline
      pilish-chat-style 'pi
      pilish-input-window-height 'fit
      pilish-send-while-busy 'steer
      ghostel-module-auto-install nil
      pi-deck-state-file (expand-file-name "deck-state.eld" user-emacs-directory)
      pi-deck-preferences-file (expand-file-name "preferences.eld" user-emacs-directory))
(make-directory user-emacs-directory t)
(require 'pilish)
(require 'pi-deck)
(pilish-configure-runtime :pi-executable (getenv "PHIMACS_SHARING_PI")
                          :pimux-executable (getenv "PHIMACS_SHARING_PIMUX")
                          :task-status-executable nil)
(dolist (library '("pi-orchestration" "pi-sound" "phimacs-packages"
                   "vertico" "corfu" "dracula-theme" "evil"))
  (when (locate-library library) (error "Unexpected optional library: %s" library)))
(when (executable-find "phimacs-task-status")
  (error "Unexpected optional task-status executable"))
(dolist (entry `(("pilish" . ,(getenv "PHIMACS_SHARING_PILISH"))
                 ("pi-deck" . ,(expand-file-name "emacs/pi-deck" (getenv "PHIMACS_ROOT")))))
  (unless (string-prefix-p (file-name-as-directory (cdr entry)) (locate-library (car entry)))
    (error "Unexpected source origin: %s" (car entry))))
(setq pilish-extra-args
      (list "--no-extensions" "--no-skills" "--no-context-files" "--no-prompt-templates"
            "--extension" (getenv "PHIMACS_SHARING_FAUX")
            "--provider" "fx" "--model" "one" "--thinking" "off"))
(pi-deck-mode 1))

(defun sharing-host--chat (name)
  "Return the named test view NAME or fail."
  (let ((chat (gethash name sharing-host--views)))
    (unless (buffer-live-p chat) (error "No live acceptance view: %s" name))
    chat))

(defun sharing-host-create (name)
  "Start an intentional new managed session named NAME."
  (let ((chat (pilish-start-session
               (getenv "PHIMACS_SHARING_PROJECT") name
               :on-ready (lambda (result) (puthash name result sharing-host--ready)))))
    (puthash name chat sharing-host--views)
    name))

(defun sharing-host-attach (mux name)
  "Attach the existing MUX using the public API, naming its view NAME."
  (let ((runtime (seq-find (lambda (item) (equal (plist-get item :mux-id) mux))
                           (pilish-list-runtimes))))
    (unless runtime (error "Runtime is absent; attachment does not launch: %s" mux))
    (puthash name (pilish-attach-runtime runtime name) sharing-host--views)
    name))

(defun sharing-host-state (name)
  "Report only public state of the named acceptance view NAME."
  (let* ((chat (gethash name sharing-host--views))
         (alive (buffer-live-p chat))
         (input (if alive (pilish-session-input-buffer chat)
                  (gethash name sharing-host--inputs))))
    (when alive (puthash name input sharing-host--inputs))
    (if (not alive)
        `((alive . :json-false)
          (inputAlive . ,(if (buffer-live-p input) t :json-false))
          (tracked . ,(if (pi-deck-agent chat) t :json-false))
          (stop . ,(gethash name sharing-host--stops))
          (confirmations . ,(vconcat sharing-host--confirmations)))
      `((alive . t)
      (inputAlive . ,(if (buffer-live-p input) t :json-false))
      (tracked . ,(if (pi-deck-agent chat) t :json-false))
      (confirmations . ,(vconcat sharing-host--confirmations))
      (runtime . ,(pilish-session-runtime chat))
      (identity . ,(pilish-session-process-identity chat))
      (file . ,(pilish-session-file chat))
      (model . ,(pilish-session-model chat))
      (busy . ,(if (pilish-session-busy-p chat) t :json-false))
      (draft . ,(if (buffer-live-p input)
                    (with-current-buffer input (buffer-substring-no-properties (point-min) (point-max))) ""))
      (quarantine . ,(vconcat (pilish-session-quarantine chat)))
      (dialogs . ,(vconcat (pilish-session-pending-dialogs chat)))
      (queued . ,(pilish-session-queued-prompts chat))
      (ready . ,(gethash name sharing-host--ready))
      (response . ,(gethash name sharing-host--responses))
      (stop . ,(gethash name sharing-host--stops))
      (text . ,(with-current-buffer chat (buffer-substring-no-properties (point-min) (point-max))))))))

(defun sharing-host-prompt (name text &optional behavior)
  "Submit explicit TEXT from NAME with optional RPC BEHAVIOR."
  (remhash name sharing-host--responses)
  (pilish-submit-prompt (sharing-host--chat name) text
                       (lambda (response) (puthash name response sharing-host--responses)) behavior)
  t)

(defun sharing-host-draft (name text)
  "Edit the local public input buffer of NAME to TEXT, without submission."
  (with-current-buffer (pilish-session-input-buffer (sharing-host--chat name))
    (erase-buffer) (insert text))
  t)

(defun sharing-host-save (name file)
  "Save all public local desktop state of NAME into private FILE."
  (with-temp-file file
    (prin1 (pilish-session-desktop-state (sharing-host--chat name)) (current-buffer)))
  (set-file-modes file #o600)
  t)

(defun sharing-host-restore (name file)
  "Restore NAME from private FILE."
  (let ((state (with-temp-buffer (insert-file-contents file) (read (current-buffer)))))
    (puthash name (pilish-restore-session-state state) sharing-host--views))
  t)

(defun sharing-host-disconnect (name)
  "Dispose only NAME's frontend view, as during frontend teardown."
  (pilish-disconnect-session (sharing-host--chat name))
  t)

(defun sharing-host-close (name &optional deck)
  "Close NAME everywhere without confirmation, through deck when DECK is non-nil."
  (remhash name sharing-host--stops)
  (let ((chat (sharing-host--chat name)))
    (if deck
        (let ((agent (pi-deck-agent chat)))
          (unless agent (error "Acceptance agent is not tracked by deck: %s" name))
          (pi-deck-close-agent agent))
      (pilish-close-session
       chat (lambda (error) (puthash name (or error "acknowledged") sharing-host--stops)))))
  t)

(defun sharing-host-adopt (name file)
  "Name the automatically restored deck view of FILE as NAME."
  (let* ((agent (seq-find
                 (lambda (item)
                   (let ((chat (pi-deck-agent-buffer item)))
                     (and (buffer-live-p chat)
                          (equal (pilish-session-file chat) file))))
                 (pi-deck-agents)))
         (chat (and agent (pi-deck-agent-buffer agent))))
    (unless (buffer-live-p chat) (error "No automatically restored deck view for %s" file))
    (puthash name chat sharing-host--views)
    name))

(defun sharing-host-answer (name text)
  "Answer NAME's first pending dialog with explicit TEXT."
  (let* ((chat (sharing-host--chat name))
         (dialog (car (pilish-session-pending-dialogs chat))))
    (unless dialog (error "No pending dialog in %s" name))
    (with-current-buffer chat
      (let ((position (text-property-any (point-min) (point-max)
                                         'pilish-dialog (plist-get dialog :id))))
        (unless position (error "Pending dialog has no inline widget in %s" name))
        (pilish-dialog-answer-text text position)))))

(defun sharing-host-wire (expression)
  "Return the JSON result of test EXPRESSION as one printable base64 string."
  (base64-encode-string
   (encode-coding-string (json-encode (eval (read expression) t)) 'utf-8) t))

(provide 'sharing-host)
;;; sharing-host.el ends here
