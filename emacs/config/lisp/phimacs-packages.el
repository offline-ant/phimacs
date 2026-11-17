;;; phimacs-packages.el --- Pinned profile packages and explicit preparation -*- lexical-binding: t; -*-
;; SPDX-License-Identifier: MIT

;;; Commentary:

;; Normal startup only activates prepared packages.  Installation, native assets
;; and checkout byte-compilation are explicit preparation actions, using the same
;; package declarations below.  Own-source packages always come from this checkout.

;;; Code:

(require 'cl-lib)
(require 'package)
(require 'package-vc)
(require 'phimacs-environment)

(defconst phimacs-package-specifications
  '((dash "fcb5d831fc08a43f984242c7509870f30983c27c"
          :url "https://github.com/magnars/dash.el" :ignored-files ("dash-functional.el"))
    (cond-let "09292a77001434f59ab55c775dec2b98cb18d028"
              :url "https://github.com/tarsius/cond-let")
    (llama "6850d0c91b629da14fdff2300c222289d1a0029a" :url "https://github.com/tarsius/llama")
    (with-editor "5021ef6885381cf5b2852f7a3f67ca8c4be1dca2"
                 :url "https://github.com/magit/with-editor" :lisp-dir "lisp")
    (magit-section "659f89955cf60fe3d4326d881c412df06c69680d"
                   :url "https://github.com/magit/magit" :lisp-dir "lisp"
                   :main-file "magit-section.el" :ignored-files ("magit.el"))
    (magit "659f89955cf60fe3d4326d881c412df06c69680d"
           :url "https://github.com/magit/magit" :lisp-dir "lisp")
    (markdown-mode "f5d520b3ee7722dd2231ab586ba51d8eb166e49b"
                   :url "https://github.com/jrblevin/markdown-mode")
    (markdown-table-wrap "f846b77d13f34fba57c80214c1a61e00c94048a3"
                         :url "https://github.com/dnouri/markdown-table-wrap")
    (md-ts-mode "769ef52965c46e9346bf19d04adc6fef9d23b01c"
                :url "https://github.com/dnouri/md-ts-mode")
    (ghostel "97ec8f16eb90cd0de87dbf5643d7371cf9895686"
             :url "https://github.com/dakra/ghostel" :lisp-dir "lisp")
    (dracula-theme "538b8d20c667ac4b0c43ed1a5ef50760fb4ad754"
                   :url "https://github.com/dracula/emacs")
    (general "a48768f85a655fe77b5f45c2880b420da1b1b9c3"
             :url "https://github.com/noctuid/general.el")
    (winum "098249c65042ee0308b8236d1ee838c8da8fdf25"
           :url "https://github.com/deb0ch/winum.el")
    (vertico "a9998a777f1d92348f84d091bb15b87df933a7a2"
             :url "https://github.com/minad/vertico")
    (orderless "3d2c2e6468ddf51e69c78e8212e5fd9006d2ce8a"
               :url "https://github.com/oantolin/orderless")
    (marginalia "42eafcfddbe88d92ed96521a00a5a90a49bac4dd"
                :url "https://github.com/minad/marginalia")
    (consult "3c64214db5cd61a8f8186e4dce89c0e04be1652c"
             :url "https://github.com/minad/consult")
    (embark "27de48004242e98586b9c9661fdb6912f26fe70f"
            :url "https://github.com/oantolin/embark"
            :ignored-files ("embark-consult.el" "avy-embark-collect.el"))
    (embark-consult "80254c91da90635978fb12db8b9ab9bf54f3bfb0"
                    :url "https://github.com/oantolin/embark" :main-file "embark-consult.el"
                    :ignored-files ("avy-embark-collect.el"))
    (wgrep "2d1c0509215499e927817b0d7d3f133db678e010"
           :url "https://github.com/mhayashi1120/Emacs-wgrep" :ignored-files ("wgrep-*.el"))
    (corfu "b468efac023dda39332acc943edc9895c80b5a6f"
           :url "https://github.com/minad/corfu")
    (cape "50bc6187daf9af9df1a802fcbbd91fe4b952fc69"
          :url "https://github.com/minad/cape"))
  "Third-party profile packages, in dependency order.
Each entry is (NAME REVISION . PACKAGE-VC-SPEC).")

(defconst phimacs-evil-package-specifications
  '((goto-chg "278cd3e6d5107693aa2bb33189ca503f22f227d0"
              :url "https://github.com/emacs-evil/goto-chg")
    (evil "6a3e1ddd04ac504a016590940d0af2a3361b9efd"
          :url "https://github.com/emacs-evil/evil" :ignored-files ("evil-test-helpers.el"))
    (evil-collection "3948a7890960d389dffa637203a6760df68b1c1c"
                     :url "https://github.com/emacs-evil/evil-collection")
    (evil-surround "a14856cd811d2ad2cab343d1a2591e68c1e7ba6d"
                   :url "https://github.com/emacs-evil/evil-surround")
    (evil-escape "3c335a5709b1abb08687960038746b36add465f9"
                 :url "https://github.com/emacsorphanage/evil-escape")
    (evil-terminal-cursor-changer "5557d7e5c011962a06663924a26ca36af1ad5f84"
                                  :url "https://github.com/7696122/evil-terminal-cursor-changer")
    (evil-ghostel "c0c34d740c50a5514f4dc30ae1f4214679a96e49"
                  :url "https://github.com/dakra/ghostel" :lisp-dir "extensions/evil-ghostel"))
  "Additional pinned packages for the optional Evil profile.")

(defun phimacs-selected-package-specifications ()
  "Return the pinned third-party packages selected by this profile."
  (append phimacs-package-specifications
          (when phimacs-enable-evil phimacs-evil-package-specifications)))

(defun phimacs-source-directories ()
  "Return this checkout's selected Lisp package directories."
  (mapcar (lambda (directory) (expand-file-name directory phimacs-source-directory))
          (append '("emacs/pilish" "emacs/pi-deck")
                  (when phimacs-enable-orchestration '("packages/orchestration/emacs"))
                  (when phimacs-enable-sound '("packages/sound/emacs")))))

(defun phimacs-load-packages ()
  "Activate prepared third-party packages and this checkout's selected sources.
Never install or download a package during normal startup."
  ;; A stock/archive copy cannot replace the maintained source frontend.
  (add-to-list 'package-load-list '(pilish nil))
  (package-initialize)
  (dolist (entry (phimacs-selected-package-specifications))
    (unless (package-installed-p (car entry))
      (error "Missing profile package %s; run node scripts/emacs-packages.mjs --state %s"
             (car entry) (directory-file-name phimacs-state-directory))))
  (dolist (directory (reverse (phimacs-source-directories)))
    (unless (file-directory-p directory) (error "Missing checkout Lisp package: %s" directory))
    (add-to-list 'load-path directory))
  ;; These packages keep their companion libraries below their main Lisp file.
  (dolist (name '(vertico corfu))
    (when-let* ((library (locate-library (symbol-name name))))
      (add-to-list 'load-path (expand-file-name "extensions" (file-name-directory library))))))

(defun phimacs-install-packages ()
  "Explicitly install the selected pinned packages into this profile's state.
Existing installations are never updated.
Use fresh state to prepare changed pins."
  (interactive)
  (add-to-list 'package-load-list '(pilish nil))
  (package-initialize)
  (dolist (entry (phimacs-selected-package-specifications))
    (unless (package-installed-p (car entry))
      (package-vc-install (cons (car entry) (cddr entry)) (cadr entry))))
  (phimacs-load-packages))

(defun phimacs-install-module-and-grammars ()
  "Explicitly prepare Ghostel's module and the two essential Markdown grammars.
Use the packages' own installers and keep existing files."
  (interactive)
  (require 'ghostel)
  (unless (file-exists-p (expand-file-name (concat "ghostel-module" module-file-suffix)
                                         ghostel-module-directory))
    (ghostel-download-module))
  (require 'pilish-grammars)
  (unless (cl-every #'treesit-language-available-p '(markdown markdown-inline))
    (let ((build (make-temp-file "phimacs-grammars-" t))
          (directory (expand-file-name "tree-sitter/" user-emacs-directory)))
      (unwind-protect
          (progn
            (pilish-install-essential-grammars build)
            (make-directory directory t)
            (dolist (library (directory-files build t "\\.so\\'"))
              (rename-file library directory t)))
        (delete-directory build t)))))

(defun phimacs-check-assets ()
  "Refuse an incomplete native preparation without downloading anything."
  (unless (file-readable-p (expand-file-name (concat "ghostel-module" module-file-suffix)
                                            ghostel-module-directory))
    (error "Missing Ghostel native module; run node scripts/emacs-packages.mjs --state %s"
           (directory-file-name phimacs-state-directory)))
  (dolist (language '(markdown markdown-inline))
    (unless (treesit-language-available-p language)
      (error "Missing %s grammar; run node scripts/emacs-packages.mjs --state %s"
             language (directory-file-name phimacs-state-directory)))))

(defun phimacs-byte-compile-packages ()
  "Byte-compile selected checkout packages after explicit preparation.
Compile top-level package sources, never tests or user overrides."
  (interactive)
  (require 'bytecomp)
  (let ((directories (append (phimacs-source-directories)
                             (list (expand-file-name "lisp" phimacs-config-directory)))))
    (dolist (directory directories)
      (dolist (file (directory-files directory t "\\.el\\'"))
        (unless (or (string-match-p "-tests?\\.el\\'" file)
                    (and (not phimacs-enable-sound)
                         (equal (file-name-nondirectory file) "phimacs-dictation.el")))
          (unless (byte-compile-file file) (error "Byte compilation failed: %s" file)))))))

(provide 'phimacs-packages)
;;; phimacs-packages.el ends here
