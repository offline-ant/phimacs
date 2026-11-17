;;; reference-startup.el --- Checkout startup probe -*- lexical-binding: t; -*-
;; SPDX-License-Identifier: MIT
;; The reference init with the test's user.el, which selects the prepared
;; packages and this checkout's executables.
(require 'json)
(load (expand-file-name "init.el" (getenv "PHIMACS_TEST_INIT_DIR")) nil t)
(unless (and (equal pilish-runtime-task-status-executable
                    (expand-file-name "packages/orchestration/dist/worker-task-cli.js"
                                      (getenv "PHIMACS_ROOT")))
             (featurep 'pi-deck)
             (eq pilish-runtime-mode 'detached))
  (error "Missing the configured detached runtime or deck"))
(unless (and (bound-and-true-p pi-deck-mode) (not (bound-and-true-p evil-mode))
             phimacs--pi-enabled phimacs--ui-enabled
             (eq pilish-chat-style 'pi) (eq pilish-input-window-height 'fit)
             (eq pilish-extension-dialog-style 'inline)
             (eq pilish-send-while-busy 'steer)
             (bound-and-true-p pilish-window-pairing-mode)
             (not phimacs-enable-sound))
  (error "Reference configuration is incompletely enabled"))
(dolist (language '(markdown markdown-inline))
  (unless (and (treesit-language-available-p language)
               (= 15 (treesit-language-abi-version language)))
    (error "Missing required ABI-15 grammar: %s" language)))
(with-temp-buffer
  (insert "# Fresh startup\n\n| a | b |\n| - | - |\n| **one** | two |\n")
  (md-ts-mode)
  (font-lock-ensure))
(unless (featurep 'ghostel-module)
  (module-load (expand-file-name (concat "ghostel-module" module-file-suffix) ghostel-module-directory)))
(let ((file (getenv "PHIMACS_TEST_EVIDENCE")))
  (with-temp-file file
    (insert (json-encode `((display . ,(getenv "PHIMACS_TEST_DISPLAY"))
                           (api . 1) (protocol . 2) (grammarAbi . 15)
                           (detachedRestore . t) (authoritativeClose . t)
                           (taskStatus . ,pilish-runtime-task-status-executable)
                           (stateOwner . ,pi-deck--state-owner)
                           (serverSocket . ,(pi-deck-server-socket))
                           (pilish . ,(file-name-directory (symbol-file 'pilish-configure-runtime 'defun)))
                           (moduleLoaded . ,(if (featurep 'ghostel-module) t :json-false))
                           (colourCells . ,(display-color-cells))
                           (dark . ,(eq frame-background-mode 'dark))
                           (evil . ,(if (bound-and-true-p evil-mode) t :json-false)))))))
(kill-emacs 0)
;;; reference-startup.el ends here
