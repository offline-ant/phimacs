;;; reference-ui.el --- Fresh reference UI regressions -*- lexical-binding: t; -*-
(require 'ert)
;; PHIMACS_TEST_EVIL=1 selects the Evil variant, as a user.el would before startup.
(setq phimacs-enable-evil (equal (getenv "PHIMACS_TEST_EVIL") "1"))
(load (expand-file-name "reference-fixtures.el" (file-name-directory load-file-name)) nil t)
(phimacs-reference-load-ui)

(ert-deftest reference-ui-enables-style-and-completion ()
  (should (equal frame-background-mode 'dark))
  (should (custom-theme-enabled-p 'dracula))
  (dolist (mode '(vertico-mode marginalia-mode global-corfu-mode winum-mode which-key-mode))
    (should (symbol-value mode)))
  (should (equal completion-styles '(orderless basic))))

(ert-deftest reference-ui-default-keys-without-evil ()
  (skip-unless (not phimacs-enable-evil))
  (should-not (featurep 'evil))
  (with-temp-buffer
    (should (eq (key-binding (kbd "M-m f f")) #'find-file))
    (should (eq (key-binding (kbd "M-m w h")) #'windmove-left))
    (should (eq (key-binding (kbd "M-m 2")) #'winum-select-window-2))
    (should (eq (key-binding (kbd "C-x C-f")) #'find-file))
    (should (eq (key-binding (kbd "SPC")) #'self-insert-command))))

(ert-deftest reference-ui-evil-variant ()
  (skip-unless phimacs-enable-evil)
  (dolist (mode '(evil-mode evil-escape-mode global-evil-surround-mode))
    (should (symbol-value mode)))
  (should (eq (lookup-key evil-motion-state-map [escape]) #'ignore))
  (with-temp-buffer
    (evil-local-mode 1)
    (evil-normal-state)
    (should (eq (key-binding (kbd "SPC f f")) #'find-file))
    (should (eq (key-binding (kbd "SPC 2")) #'winum-select-window-2))
    (evil-insert-state)
    (should (eq (key-binding (kbd "M-m f f")) #'find-file))))

(ert-deftest reference-ui-repeat-enable-is-idempotent ()
  (let ((hooks (copy-sequence pilish-chat-mode-hook))
        (display (copy-tree display-buffer-alist)))
    (phimacs-enable-ui)
    (should (equal hooks pilish-chat-mode-hook))
    (should (equal display display-buffer-alist))))

(ert-deftest reference-ui-status-is-below-draft ()
  (with-temp-buffer
    (setq-local header-line-format '("model status"))
    (phimacs-modeline-input)
    (should (equal mode-line-format '("model status")))
    (should-not header-line-format))
  (with-temp-buffer
    (phimacs-modeline-chat)
    (should (equal mode-line-format '(" ")))))

(ert-deftest reference-ui-loads-installed-packages-and-checkout-packages ()
  (let ((directory (file-truename (getenv "PHIMACS_TEST_EMACS_DIR"))))
    (dolist (library '("vertico" "vertico-directory" "corfu-popupinfo" "dracula-theme"))
      (should (file-in-directory-p (file-truename (locate-library library)) directory)))
    (should (file-in-directory-p (locate-library "pi-deck")
                                 (expand-file-name "emacs/pi-deck" phimacs-reference-test-root)))))

(ert-deftest reference-ui-optionals-and-state-are-isolated ()
  (should-not phimacs-enable-sound)
  (should-not phimacs-enable-osc52)
  (should-not package-enable-at-startup)
  (should-not package-archives)
  (should (file-in-directory-p savehist-file phimacs-state-directory))
  (should-not (file-in-directory-p savehist-file phimacs-config-directory))
  (should (zerop (logand (file-modes phimacs-state-directory) #o077))))

(ert-run-tests-batch-and-exit)
