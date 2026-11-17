;;; phimacs-pi.el --- Explicit detached frontend configuration -*- lexical-binding: t; -*-
;; SPDX-License-Identifier: MIT
(require 'phimacs-environment)
(require 'phimacs-packages)
(require 'phimacs-ui)
(defvar pi-deck-command-map)
(declare-function xterm-paste "term/xterm" (event))
(declare-function pi-deck-mode "pi-deck" (&optional arg))
(declare-function phimacs-enable-dictation "phimacs-dictation" ())
(declare-function pi-sound-dictate "pi-sound")
(declare-function pi-sound-deck-notify "pi-sound")
(defvar phimacs--pi-enabled nil)

(defun phimacs-chat-paste (event)
  "Send terminal paste EVENT to this chat's public input buffer."
  (interactive "e")
  (let ((input (pilish-session-input-buffer (current-buffer))))
    (unless (buffer-live-p input) (user-error "This chat has no input buffer"))
    (when-let* ((window (get-buffer-window input))) (select-window window))
    (with-current-buffer input (goto-char (point-max)) (xterm-paste event))))

(defun phimacs-move-window-pair (move &rest arguments)
  "Call Evil MOVE with ARGUMENTS while preserving a chat/input pair."
  (if (bound-and-true-p pilish-window-pairing-mode)
      (progn
        (select-window (pilish-dissolve-window-pair (selected-window)))
        (let ((ignore-window-parameters t)) (apply move arguments)))
    (apply move arguments)))

(defun phimacs-enable-pi ()
  "Enable the supported fork only after validating its public contract.
No session is started here and no missing runtime is silently relaunched."
  (unless phimacs--pi-enabled
    (setq pilish-chat-style 'pi
          pilish-input-window-height 'fit
          pilish-header-line-location 'input
          pilish-extension-dialog-style 'inline
          pilish-send-while-busy 'steer
          pilish-jump-to-end-on-submit t
          pilish-send-on-double-return 0.4
          pilish-input-arrow-history t
          pilish-input-send-button t
          pilish-input-stop-button t
          pilish-jump-to-answer t
          pilish-notify-in-chat t
          pi-deck-state-file (expand-file-name "deck/state.eld" phimacs-state-directory)
          pi-deck-preferences-file (expand-file-name "deck/preferences.eld" phimacs-state-directory)
          pi-deck-pane-header-prefix-function #'phimacs-pane-prefix)
    (require 'pilish)
    (let ((pi (phimacs-program phimacs-pi-program)))
      (when-let* ((selected (getenv "PHIMACS_PI")))
        (unless (equal pi (phimacs-program selected))
          (error "phimacs-pi-program differs from PHIMACS_PI; select the same host for service and frontend")))
      (setenv "PHIMACS_PI" pi)
      (pilish-configure-runtime :pi-executable pi
                               :pimux-executable (phimacs-program phimacs-pimux-program)
                               :task-status-executable
                               (when phimacs-enable-orchestration
                                 (phimacs-program phimacs-task-status-program))))
    (phimacs-check-assets)
    (pilish-window-pairing-mode 1)
    (keymap-set pilish-chat-mode-map "<xterm-paste>" #'phimacs-chat-paste)
    (face-spec-set 'pilish-pi-user-message
                   '((((class color) (min-colors 257)) :background "#353747" :extend t)
                     (((class color) (min-colors 256)) :background "#3a3a3a" :extend t)
                     (t :inherit highlight :extend t)))
    (require 'ghostel)
    (unless (featurep 'ghostel-module)
      (error "Ghostel native module is unavailable; prepare the profile's native assets"))
    (when phimacs-enable-evil
      (unless (advice-member-p #'phimacs-move-window-pair 'evil-move-window)
        (advice-add 'evil-move-window :around #'phimacs-move-window-pair))
      (require 'evil-ghostel))
    (when phimacs-enable-orchestration (require 'pi-orchestration))
    (require 'pi-deck)
    (setq pi-deck-restart-mode (intern (or (getenv "PHIMACS_DAEMON_MODE") "manual")))
    (when-let* ((launcher (getenv "PHIMACS_EMACS_LAUNCHER")))
      (setq pi-deck-restart-command (list launcher "--no-frame" "--daemon-mode" "manual")
            pi-deck-supervisor-restart-command
            (list launcher "--no-frame" "--daemon-mode" "supervised")))
    ;; Before the deck restores views, so restored inputs get the button too.
    (when phimacs-enable-sound
      (require 'phimacs-dictation)
      (phimacs-enable-dictation)
      (phimacs-leader "v" #'pi-sound-dictate)
      (add-hook 'pi-deck-notify-functions #'pi-sound-deck-notify))
    ;; Direct startup must own its stable endpoint before deck claims persistence.
    ;; Daemon startup publishes its endpoint later; deck already waits on that hook.
    (let ((owned-server (phimacs-start-server)))
      (condition-case condition
          (pi-deck-mode 1)
        ((error quit)
         (condition-case cleanup
             (when (and owned-server (eq server-process owned-server))
               (server-start t t))
           (error
            (error "%s; profile server cleanup also failed: %s"
                   (error-message-string condition) (error-message-string cleanup))))
         (signal (car condition) (cdr condition)))))
    (phimacs-leader "d" '(:keymap pi-deck-command-map :which-key "deck"))
    (keymap-global-set "C-c d" pi-deck-command-map)
    (setq phimacs--pi-enabled t)))

(provide 'phimacs-pi)
;;; phimacs-pi.el ends here
