;;; pilish-build.el --- Batch helpers for local build tasks -*- lexical-binding: t; -*-

;; Copyright (C) 2026 Daniel Nouri

;; Author: Daniel Nouri <daniel.nouri@gmail.com>
;; SPDX-License-Identifier: GPL-3.0-or-later

;; This file is not part of GNU Emacs.

;;; Commentary:

;; Helpers shared by focused Makefile checks and explicit grammar provisioning.
;; Test inputs are prepared outside this package; these helpers never install
;; Lisp packages or select a second Pi host.

;;; Code:

(require 'cl-lib)
(require 'lisp-mnt)
(require 'package)
(require 'treesit)

(defvar pilish-grammar-recipes nil
  "Grammar recipes provided by `pilish-grammars'.")

(defconst pilish-build-main-file
  (expand-file-name "../pilish.el"
                    (file-name-directory (or load-file-name buffer-file-name)))
  "Path to the package entry point used as build metadata source of truth.")

(defun pilish-build--version-string (version)
  "Return VERSION list as a dotted string."
  (mapconcat #'number-to-string version "."))

(defun pilish-build--read-package-requires ()
  "Return the `Package-Requires' header from the current buffer."
  (if (fboundp 'lm-package-requires)
      (lm-package-requires)
    (let ((header (lm-header "package-requires")))
      (unless header
        (error "Missing Package-Requires header in %s"
               pilish-build-main-file))
      (car (read-from-string header)))))

(defun pilish-build-package-requirements ()
  "Return non-Emacs package requirements from `pilish.el'."
  (mapcar (pcase-lambda (`(,package ,version))
            (cons package (version-to-list version)))
          (cl-remove-if (lambda (requirement)
                          (eq (car requirement) 'emacs))
                        (with-temp-buffer
                          (insert-file-contents pilish-build-main-file)
                          (pilish-build--read-package-requires)))))

(defun pilish-build-test-environment ()
  "Activate explicitly prepared package, grammar and cache directories.
Require absolute existing directories in PACKAGE_USER_DIR, GRAMMAR_DIR
and PILISH_TEST_CACHE_DIR.  Never use personal package/native caches."
  (let ((directories
         (mapcar (lambda (name)
                   (let ((directory (getenv name)))
                     (unless (and directory (file-name-absolute-p directory)
                                  (file-directory-p directory))
                       (error "Set %s to an existing absolute private directory" name))
                     (file-name-as-directory directory)))
                 '("PACKAGE_USER_DIR" "GRAMMAR_DIR" "PILISH_TEST_CACHE_DIR"))))
    (setq package-user-dir (nth 0 directories)
          package-directory-list nil
          package-load-list '((pilish nil) all)
          treesit-extra-load-path (list (nth 1 directories))
          user-emacs-directory (nth 2 directories))
    (startup-redirect-eln-cache (expand-file-name "eln-cache/" user-emacs-directory))
    (package-initialize)
    (add-to-list 'load-path (file-name-directory pilish-build-main-file))))

(defun pilish-build-check-deps (&optional requirements)
  "Check prepared package REQUIREMENTS without downloading anything.
REQUIREMENTS defaults to `pilish-build-package-requirements'.  Optional
Evil tests skip when their separately prepared integrations are absent."
  (let (missing)
    (dolist (requirement (or requirements (pilish-build-package-requirements)))
      (pcase-let ((`(,package . ,min-version) requirement))
        (unless (package-installed-p package min-version)
          (push (format "%s >= %s" package
                        (pilish-build--version-string min-version))
                missing))))
    (when missing
      (error "Prepared dependencies missing: %s; run the root Emacs preparation step"
             (mapconcat #'identity (nreverse missing) ", ")))
    t))

(defun pilish-build--default-grammars ()
  "Return all grammars needed by Pilish."
  (require 'pilish-grammars)
  (mapcar #'car pilish-grammar-recipes))

(defun pilish-build-install-grammars (&optional grammars)
  "Install tree-sitter GRAMMARS used by Pilish.
GRAMMARS defaults to all recipes from `pilish-grammar-recipes'.
Returns a plist with counts for already installed, newly installed,
failed, and total grammars.  Signals an error if any grammar fails."
  ;; Registers the recipes, also for an explicitly selected subset.
  (require 'pilish-grammars)
  (let* ((grammars (or grammars (pilish-build--default-grammars)))
         (already-installed 0)
         (installed 0)
         (failed 0)
         (failed-grammars nil)
         (result nil))
    (dolist (lang grammars)
      (if (treesit-language-available-p lang)
          (progn
            (message "Grammar %s: already installed" lang)
            (cl-incf already-installed))
        (message "Grammar %s: installing..." lang)
        (condition-case err
            (progn
              (treesit-install-language-grammar lang)
              (if (treesit-language-available-p lang)
                  (progn
                    (message "Grammar %s: installed successfully" lang)
                    (cl-incf installed))
                (message "Grammar %s: install returned but grammar not available" lang)
                (push lang failed-grammars)
                (cl-incf failed)))
          (error
           (message "Grammar %s: FAILED - %s" lang (error-message-string err))
           (push lang failed-grammars)
           (cl-incf failed)))))
    (setq result (list :already-installed already-installed
                       :installed installed
                       :failed failed
                       :total (length grammars)))
    (message "Grammars: already ready %d, installed %d, failed %d, total %d"
             already-installed installed failed (length grammars))
    (when failed-grammars
      (error "Grammar install failed: %s"
             (mapconcat #'symbol-name (nreverse failed-grammars) ", ")))
    result))

(provide 'pilish-build)
;;; pilish-build.el ends here
