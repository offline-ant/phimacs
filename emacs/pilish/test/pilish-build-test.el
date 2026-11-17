;;; pilish-build-test.el --- Tests for prepared build inputs -*- lexical-binding: t; -*-

;;; Code:

(require 'ert)
(require 'cl-lib)

(defconst pilish-test-build--repo-root
  (expand-file-name ".." (file-name-directory load-file-name))
  "Pilish package directory used by build script tests.")

(load (expand-file-name "scripts/pilish-build.el"
                        pilish-test-build--repo-root)
      t t)

(ert-deftest pilish-test-build-package-requirements-follow-package-header ()
  "Read dependency versions from the package header, excluding Emacs itself."
  (should (equal '((transient . (0 9 0))
                   (magit-section . (4 0 0))
                   (md-ts-mode . (0 5 0))
                   (markdown-table-wrap . (0 2 0)))
                 (pilish-build-package-requirements))))

(ert-deftest pilish-test-build-package-requirements-fallback-without-lm-package-requires ()
  "Read package requirements even when `lm-package-requires' is unavailable."
  (let ((pilish-build-main-file
         (make-temp-file "pilish-build" nil ".el"
                         ";;; demo.el --- demo -*- lexical-binding: t; -*-\n\
;; Package-Requires: ((emacs \"29.1\") (transient \"0.9.0\"))\n")))
    (unwind-protect
        (cl-letf (((symbol-function 'lm-package-requires) nil))
          (should (equal '((transient . (0 9 0)))
                         (pilish-build-package-requirements))))
      (delete-file pilish-build-main-file))))

(ert-deftest pilish-test-build-check-deps-accepts-prepared-versions ()
  "Validate every selected requirement against the prepared package tree."
  (let (checked)
    (cl-letf (((symbol-function 'package-installed-p)
               (lambda (package version)
                 (push (cons package version) checked)
                 t)))
      (should (pilish-build-check-deps
               '((transient . (0 9 0)) (md-ts-mode . (0 5 0)))))
      (should (equal (nreverse checked)
                     '((transient . (0 9 0)) (md-ts-mode . (0 5 0))))))))

(ert-deftest pilish-test-build-check-deps-names-missing-preparation ()
  "Missing dependencies name the required version and preparation action."
  (cl-letf (((symbol-function 'package-installed-p)
             (lambda (package _version) (eq package 'transient))))
    (let ((error-text
           (condition-case err
               (pilish-build-check-deps
                '((transient . (0 9 0)) (md-ts-mode . (0 5 0))))
             (error (error-message-string err)))))
      (should (string-match-p "md-ts-mode >= 0.5.0" error-text))
      (should (string-match-p "root Emacs preparation step" error-text)))))

(ert-deftest pilish-test-build-environment-selects-only-explicit-inputs ()
  "Package, grammar and native-cache origins come from the caller's inputs."
  (let* ((directory (make-temp-file "pilish-build-inputs-" t))
         (process-environment (copy-sequence process-environment))
         (package-user-dir nil)
         (package-directory-list '("/unrelated/packages"))
         (package-load-list '(all))
         (treesit-extra-load-path '("/unrelated/grammars"))
         (user-emacs-directory "/unrelated/emacs/")
         (load-path (copy-sequence load-path))
         activated native-cache)
    (unwind-protect
        (progn
          (dolist (name '("PACKAGE_USER_DIR" "GRAMMAR_DIR" "PILISH_TEST_CACHE_DIR"))
            (let ((path (expand-file-name name directory)))
              (make-directory path)
              (setenv name path)))
          (cl-letf (((symbol-function 'package-initialize)
                     (lambda () (setq activated t)))
                    ((symbol-function 'startup-redirect-eln-cache)
                     (lambda (path) (setq native-cache path))))
            (pilish-build-test-environment))
          (should activated)
          (should (equal package-user-dir
                         (file-name-as-directory (getenv "PACKAGE_USER_DIR"))))
          (should (equal treesit-extra-load-path
                         (list (file-name-as-directory (getenv "GRAMMAR_DIR")))))
          (should (equal package-load-list '((pilish nil) all)))
          (should-not package-directory-list)
          (should (equal native-cache
                         (expand-file-name "eln-cache/" (getenv "PILISH_TEST_CACHE_DIR"))))
          (should (equal (car load-path)
                         (file-name-directory pilish-build-main-file))))
      (delete-directory directory t))))

(ert-deftest pilish-test-build-environment-requires-absolute-existing-inputs ()
  "A missing or relative package input fails before activation."
  (let ((process-environment (copy-sequence process-environment)))
    (setenv "PACKAGE_USER_DIR" "relative/packages")
    (should (string-match-p
             "PACKAGE_USER_DIR"
             (condition-case err
                 (pilish-build-test-environment)
               (error (error-message-string err)))))))

(ert-deftest pilish-test-build-install-grammars-reports-ready-and-installed-counts ()
  "Count already-ready and newly installed grammars separately."
  (let ((available '(markdown)) installed messages)
    (cl-letf (((symbol-function 'treesit-language-available-p)
               (lambda (lang &rest _) (memq lang available)))
              ((symbol-function 'treesit-install-language-grammar)
               (lambda (lang &optional _out-dir)
                 (push lang installed)
                 (push lang available)))
              ((symbol-function 'message)
               (lambda (format-string &rest args)
                 (push (apply #'format format-string args) messages))))
      (should (equal '(:already-installed 1 :installed 2 :failed 0 :total 3)
                     (pilish-build-install-grammars '(markdown bash javascript))))
      (should (equal '(javascript bash) installed))
      (should (string-match-p "already ready 1, installed 2, failed 0, total 3"
                              (car messages))))))

(ert-deftest pilish-test-build-install-grammars-errors-when-a-grammar-fails ()
  "Signal an error when any requested grammar cannot be installed."
  (cl-letf (((symbol-function 'treesit-language-available-p) (lambda (&rest _) nil))
            ((symbol-function 'treesit-install-language-grammar) (lambda (&rest _) nil)))
    (should-error (pilish-build-install-grammars '(markdown)))))

(ert-deftest pilish-test-build-scripts-byte-compile-cleanly ()
  "Build helper and explicit grammar wrapper byte-compile without warnings."
  (let* ((emacs (expand-file-name invocation-name invocation-directory))
         (scripts-dir (expand-file-name "scripts" pilish-test-build--repo-root))
         (output-buffer (generate-new-buffer " *pilish-build-compile*"))
         (exit-code
          (call-process emacs nil output-buffer nil "--batch" "-Q"
                        "-L" pilish-test-build--repo-root "-L" scripts-dir
                        "-l" "pilish-build" "--eval" "(pilish-build-test-environment)"
                        "--eval" "(setq byte-compile-error-on-warn t)"
                        "-f" "batch-byte-compile"
                        (expand-file-name "scripts/pilish-build.el" pilish-test-build--repo-root)
                        (expand-file-name "scripts/install-ts-grammars.el" pilish-test-build--repo-root))))
    (unwind-protect
        (progn
          (with-current-buffer output-buffer
            (ert-info ((buffer-string))
              (should (eq 0 exit-code)))))
      (kill-buffer output-buffer)
      (dolist (name '("pilish-build.elc" "install-ts-grammars.elc"))
        (let ((file (expand-file-name name scripts-dir)))
          (when (file-exists-p file) (delete-file file)))))))

(ert-deftest pilish-test-build-install-grammars-registers-recipes-for-explicit-subset ()
  "An explicit optional-grammar subset installs from Pilish's pinned recipes."
  (let* ((emacs (expand-file-name invocation-name invocation-directory))
         (scripts-dir (expand-file-name "scripts" pilish-test-build--repo-root))
         (output (generate-new-buffer " *pilish-build-recipes*"))
         (exit-code
          ;; A fresh Emacs: nothing else has loaded pilish-grammars yet.
          (call-process
           emacs nil output nil "--batch" "-Q"
           "-L" pilish-test-build--repo-root "-L" scripts-dir "-l" "pilish-build"
           "--eval" (prin1-to-string
                     '(let (recipes)
                        (advice-add 'treesit-language-available-p :override
                                    (lambda (language &rest _) (assq language recipes)))
                        (advice-add 'treesit-install-language-grammar :override
                                    (lambda (language &rest _)
                                      (push (assq language treesit-language-source-alist)
                                            recipes)))
                        (pilish-build-install-grammars '(python json html))
                        (princ (format "RECIPES:%S" (mapcar #'cadr (reverse recipes)))))))))
    (unwind-protect
        (with-current-buffer output
          (ert-info ((buffer-string))
            (should (eq 0 exit-code))
            (should (string-match-p
                     (regexp-quote
                      (concat "RECIPES:(\"https://github.com/tree-sitter/tree-sitter-python\""
                              " \"https://github.com/tree-sitter/tree-sitter-json\""
                              " \"https://github.com/tree-sitter/tree-sitter-html\")"))
                     (buffer-string)))))
      (kill-buffer output))))

(ert-deftest pilish-test-build-install-ts-grammars-script-delegates-to-helper ()
  "The explicit grammar wrapper calls its owning helper."
  (let (called)
    (cl-letf (((symbol-function 'pilish-build-install-grammars)
               (lambda (&rest _) (setq called t))))
      (load (expand-file-name "scripts/install-ts-grammars.el"
                              pilish-test-build--repo-root) nil t)
      (should called))))

(ert-deftest pilish-test-build-logo-asset-present ()
  "The shipped logo retains its runtime adaptation contract."
  (with-temp-buffer
    (insert-file-contents
     (expand-file-name "assets/pilish-logo.svg" pilish-test-build--repo-root))
    (should (= 1 (how-many "fill=\"#07100F\"" (point-min) (point-max))))
    (should (= 3 (how-many "fill=\"#EEF2E8\"" (point-min) (point-max))))
    (should (= 2 (how-many "fill=\"#A970FF\"" (point-min) (point-max))))))

(ert-deftest pilish-test-build-modified-source-notice-is-prominent ()
  "The source package includes a dated notice linked before the user guide."
  (let* ((manifest
          (with-temp-buffer
            (insert-file-contents
             (expand-file-name "../../provenance/pilish-import.json"
                               pilish-test-build--repo-root))
            (json-parse-buffer :object-type 'plist)))
         (notice
          (with-temp-buffer
            (insert-file-contents
             (expand-file-name "NOTICE.md" pilish-test-build--repo-root))
            (buffer-string))))
    (should (string-match "Modified-version notice — \\([0-9]\\{4\\}-[0-9]\\{2\\}-[0-9]\\{2\\}\\)" notice))
    (let ((date (match-string 1 notice)))
      (with-temp-buffer
        (insert-file-contents
         (expand-file-name "README.org" pilish-test-build--repo-root))
        (goto-char (point-min))
        (should (re-search-forward "^\\* What is Pilish" nil t))
        (let ((entry (buffer-substring-no-properties (point-min) (match-beginning 0))))
          (should (string-match-p (regexp-quote date) entry))
          (should (string-match-p (regexp-quote "[[file:NOTICE.md]") entry)))))
    (dolist (revision (list (plist-get (plist-get manifest :import) :revision)
                           (plist-get (plist-get manifest :import) :upstreamBase)))
      (should (string-match-p (regexp-quote revision) notice)))
    (should (string-match-p "GPL-3.0-or-later" notice))
    (should (file-readable-p (expand-file-name "LICENSE" pilish-test-build--repo-root)))))

(ert-deftest pilish-test-build-package-compilation-keeps-only-runtime-lisp ()
  "Package-local ignore metadata keeps helper/test bytecode out of VC installs."
  (let* ((directory (make-temp-file "pilish-package-compile-" t))
         (desc (package-desc-create :name 'pilish-fixture :dir directory))
         (byte-compile-error-on-warn t)
         (source ";;; fixture.el --- Fixture -*- lexical-binding: t; -*-\n(provide 'fixture)\n"))
    (unwind-protect
        (progn
          (copy-file (expand-file-name ".elpaignore" pilish-test-build--repo-root)
                     (expand-file-name ".elpaignore" directory))
          (with-temp-file (expand-file-name "fixture.el" directory) (insert source))
          (dolist (name '("test" "scripts" "bench"))
            (make-directory (expand-file-name name directory))
            (with-temp-file (expand-file-name "fixture.el" (expand-file-name name directory))
              (insert source)))
          (package--compile desc)
          (should (file-exists-p (expand-file-name "fixture.elc" directory)))
          (dolist (name '("test" "scripts" "bench"))
            (should-not (file-exists-p (expand-file-name (concat name "/fixture.elc") directory)))))
      (delete-directory directory t))))

(provide 'pilish-build-test)
;;; pilish-build-test.el ends here
