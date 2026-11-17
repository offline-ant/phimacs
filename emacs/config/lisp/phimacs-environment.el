;;; phimacs-environment.el --- Options, programs and private state -*- lexical-binding: t; -*-
;; SPDX-License-Identifier: MIT
(require 'subr-x)
(require 'server)

(defgroup phimacs nil "The Phimacs reference environment." :group 'applications)
(defcustom phimacs-enable-orchestration t
  "Enable the generic Emacs orchestration companion."
  :type 'boolean :group 'phimacs)
(defcustom phimacs-enable-sound nil
  "Enable explicitly configured public sound integration."
  :type 'boolean :group 'phimacs)
(defcustom phimacs-enable-evil nil
  "Enable Evil modal editing with the `SPC' leader; nil keeps default Emacs keys."
  :type 'boolean :group 'phimacs)
(defcustom phimacs-enable-osc52 nil
  "Allow clipboard writes through the outer terminal's OSC 52 capability."
  :type 'boolean :group 'phimacs)
(defcustom phimacs-pi-program (or (getenv "PHIMACS_PI") "pi")
  "The selected Pi host, shared with the pimux service via PHIMACS_PI."
  :type 'string :group 'phimacs)
(defcustom phimacs-pimux-program
  (expand-file-name "packages/pimux/bin/pimux" phimacs-source-directory)
  "The pimux client from this profile's source checkout."
  :type 'string :group 'phimacs)
(defcustom phimacs-task-status-program
  (expand-file-name "packages/orchestration/dist/worker-task-cli.js" phimacs-source-directory)
  "The checkout's worker task reader; required only with orchestration enabled."
  :type 'string :group 'phimacs)
(defvar phimacs-user-file
  (or (getenv "PHIMACS_USER_FILE")
      (expand-file-name "user.el" (expand-file-name "phimacs" (or (getenv "XDG_CONFIG_HOME") "~/.config"))))
  "Personal overrides, loaded before packages and features.")

(defun phimacs-program (program)
  "Return the absolute executable for PROGRAM, a command name or file name."
  (let ((file (if (file-name-absolute-p program) program (executable-find program))))
    (unless (and file (file-executable-p file))
      (error "Cannot find executable %s; install it or customize its phimacs-*-program option" program))
    (file-truename file)))

(unless (version<= "31.1" emacs-version) (error "Phimacs requires Emacs 31.1 or later"))
(unless (and (fboundp 'module-load) (treesit-available-p))
  (error "Phimacs needs an Emacs with native-module and tree-sitter support"))
;; Only explicit preparation may fetch assets; using a chat or terminal must not.
(setq ghostel-module-directory (expand-file-name "ghostel/" user-emacs-directory)
      ghostel-module-auto-install nil
      pilish-essential-grammar-action 'warn)
(add-to-list 'treesit-extra-load-path (expand-file-name "tree-sitter" user-emacs-directory))

(defun phimacs-start-server ()
  "Start the direct profile's server; return a newly owned process or nil.
Daemons publish their endpoint through Emacs startup.
Never replace another owner."
  (unless (daemonp)
    (if (and server-process (process-live-p server-process))
        (unless (equal (process-contact server-process :service) server-name)
          (error "This Emacs already owns a different server; start the profile separately"))
      (unless (file-directory-p server-socket-dir)
        (make-directory server-socket-dir t)
        (set-file-modes server-socket-dir #o700))
      (let ((attributes (file-attributes server-socket-dir)))
        (unless (and (not (file-symlink-p (directory-file-name server-socket-dir)))
                     (equal (file-attribute-user-id attributes) (user-uid))
                     (zerop (logand (file-modes server-socket-dir) #o077)))
          (error "Profile socket directory must be owned by you with mode 0700")))
      (when (or (file-exists-p server-name) (file-symlink-p server-name)
                (server-running-p server-name))
        (error "Profile endpoint %s is already owned or unavailable; inspect it before recovery"
               server-name))
      (server-start)
      server-process)))

(provide 'phimacs-environment)
;;; phimacs-environment.el ends here
