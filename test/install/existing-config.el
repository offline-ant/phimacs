;;; existing-config.el --- Literal package-vc installation fixture -*- lexical-binding: t; -*-

(require 'cl-lib)
(require 'ert)
(require 'package)
(require 'package-vc)
(require 'use-package)

(setq package-user-dir (getenv "PHIMACS_INSTALL_PACKAGES")
      package-directory-list nil
      package-archives nil
      package-check-signature nil
      package-vc-register-as-project nil
      package-native-compile nil
      native-comp-jit-compilation nil
      load-prefer-newer t
      custom-file (expand-file-name "custom.el" user-emacs-directory))
(load (getenv "PHIMACS_INSTALL_DEPENDENCY_INIT") nil t)

;; Git is limited to file:// by the process environment.  Any URL retrieval is
;; unexpected: all third-party package dependencies were prepared beforehand.
(advice-add 'url-retrieve-synchronously :before
            (lambda (&rest _) (error "Unexpected archive/network retrieval")))

(ert-deftest phimacs-existing-config-literal-vc-install ()
  (let ((dependencies (getenv "PHIMACS_INSTALL_DEPENDENCIES")))
    (should (equal package-directory-list (list dependencies)))
    (should-not (file-in-directory-p package-user-dir dependencies))
    (dolist (name '(dash cond-let llama with-editor magit-section markdown-mode
                   markdown-table-wrap md-ts-mode ghostel))
      (require name)
      (let ((library (locate-library (symbol-name name))))
        (should (file-in-directory-p library dependencies))
        (should (file-readable-p (concat (file-name-sans-extension library) ".elc")))
        (should (file-in-directory-p
                 (package-desc-dir (package-get-descriptor name)) dependencies))
        (should (cl-some
                 (lambda (entry)
                   (and (stringp (car entry))
                        (member (cons 'provide name) (cdr entry))
                        (file-in-directory-p (car entry) dependencies)))
                 load-history)))))
  ;; Explicit :vc must beat a numerically newer archive descriptor.
  (setq package-archive-contents
        (list (list 'pilish (package-desc-create :name 'pilish :version '(20261114 1)
                                                 :kind 'single :archive "synthetic"))))
  (load (getenv "PHIMACS_INSTALL_PACKAGE_INIT") nil t)
  (should (featurep 'pilish))
  (should (featurep 'pilish-runtime))
  (should (equal pilish-runtime-pi-executable (getenv "PHIMACS_INSTALL_PI")))
  (should (equal pilish-runtime-pimux-executable (getenv "PHIMACS_INSTALL_PIMUX")))
  (require 'pi-deck)
  (should (featurep 'pi-deck))
  (should-not pi-deck-mode)
  (should-not (featurep 'phimacs-ui))
  (should-not (locate-library "pi-orchestration"))
  (should-not (locate-library "pi-sound"))
  (dolist (entry '((pilish . "emacs/pilish/pilish")
                   (pi-deck . "emacs/pi-deck/pi-deck")))
    (let* ((name (car entry))
           (installed (expand-file-name (symbol-name name) package-user-dir))
           (main (expand-file-name (concat (cdr entry) ".elc") installed))
           (library (locate-library (symbol-name name))))
      (should (file-exists-p main))
      (should (file-equal-p main library))
      (should (equal (vc-working-revision (concat (file-name-sans-extension main) ".el"))
                     (getenv "PHIMACS_INSTALL_REVISION")))
      (dolist (outside '("boundary.elc" "emacs/config/probe.elc" "other-package/probe.elc"))
        (should-not (file-exists-p (expand-file-name outside installed))))))
  (let ((pilish-root (expand-file-name "pilish/emacs/pilish" package-user-dir)))
    (should-not (directory-files-recursively
                 (expand-file-name "test" pilish-root) "\\.elc\\'"))))

(ert-run-tests-batch-and-exit "^phimacs-existing-config-")
;;; existing-config.el ends here
