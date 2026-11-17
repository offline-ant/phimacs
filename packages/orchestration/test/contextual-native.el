;;; contextual-native.el --- Explicit checkout host for native tests -*- lexical-binding: t; -*-
;; SPDX-License-Identifier: MIT
;;; Commentary:
;; Only this checkout's sources and the explicitly prepared Emacs directory
;; (PHIMACS_TEST_EMACS_DIR), never the user's init, packages or daemon.
;;; Code:
(let ((directory (file-name-as-directory (getenv "PHIMACS_TEST_EMACS_DIR"))))
  (require 'package)
  (setq package-user-dir (expand-file-name "elpa" directory)
        package-load-list '((pilish nil) all)
        ghostel-module-directory (expand-file-name "ghostel/" directory)
        treesit-extra-load-path (list (expand-file-name "tree-sitter" directory)))
  (package-initialize))
(add-to-list 'load-path (getenv "PI_CONTEXTUAL_PILISH"))
(add-to-list 'load-path (getenv "PI_CONTEXTUAL_ORCHESTRATION"))
(setq native-comp-jit-compilation nil
      load-prefer-newer t
      pilish-essential-grammar-action 'warn)
(require 'pilish)
(pilish-configure-runtime :pi-executable (getenv "PHIMACS_PI")
                          :pimux-executable (getenv "PI_CONTEXTUAL_PIMUX"))
(require 'pi-orchestration)
(provide 'contextual-native)
;;; contextual-native.el ends here
