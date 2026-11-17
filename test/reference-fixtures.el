;;; reference-fixtures.el --- Checkout-only UI fixtures -*- lexical-binding: t; -*-
(defconst phimacs-reference-test-root
  (file-name-directory (directory-file-name (file-name-directory load-file-name))))

(defun phimacs-reference-load-ui ()
  "Load the reference UI from the packages in PHIMACS_TEST_EMACS_DIR.
That directory is a prepared reference Emacs directory (elpa/ and so on, see
scripts/emacs-packages.mjs).  All own-source packages, including Pilish, come
from this checkout.  Nothing is installed, no Pi or user init is loaded."
  (let ((directory (or (getenv "PHIMACS_TEST_EMACS_DIR")
                       (error "PHIMACS_TEST_EMACS_DIR must name a prepared reference Emacs directory")))
        (root phimacs-reference-test-root))
    (load (expand-file-name "emacs/config/early-init.el" root) nil t)
    (require 'phimacs-environment)
    (setq package-user-dir (expand-file-name "elpa" directory)
          package-directory-list nil)
    (require 'phimacs-packages)
    (phimacs-load-packages)
    (require 'phimacs-ui)
    (phimacs-enable-ui)))
;;; reference-fixtures.el ends here
