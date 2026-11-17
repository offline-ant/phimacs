;;; init.el --- Phimacs reference environment -*- lexical-binding: t; -*-
;; SPDX-License-Identifier: MIT

(unless (boundp 'phimacs-config-directory)
  (load (expand-file-name "early-init.el"
                          (file-name-directory (or load-file-name buffer-file-name))) nil t))
(require 'phimacs-environment)
;; Overrides are deliberately outside the source checkout and run before packages
;; and optional features.
(when (file-exists-p phimacs-user-file) (load phimacs-user-file nil t))
(require 'phimacs-packages)
(phimacs-load-packages)
(require 'phimacs-ui)
(require 'phimacs-pi)
(phimacs-enable-ui)
(phimacs-enable-pi)
;;; init.el ends here
