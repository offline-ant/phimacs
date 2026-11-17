;;; early-init.el --- Isolated Phimacs startup -*- lexical-binding: t; -*-
;; SPDX-License-Identifier: MIT

(setq package-enable-at-startup nil
      package-archives nil
      native-comp-jit-compilation nil
      gc-cons-threshold (* 128 1024 1024)
      read-process-output-max (* 1024 1024)
      inhibit-startup-screen t
      initial-scratch-message nil
      frame-inhibit-implied-resize t
      frame-resize-pixelwise t
      load-prefer-newer t)
(dolist (parameter '((menu-bar-lines . 0) (tool-bar-lines . 0)
                     (vertical-scroll-bars) (horizontal-scroll-bars)))
  (add-to-list 'default-frame-alist parameter))

(defconst phimacs-config-directory
  (file-name-directory (or load-file-name buffer-file-name))
  "Source directory containing this reference configuration.")
(defconst phimacs-source-directory
  (file-name-as-directory (expand-file-name "../../" phimacs-config-directory))
  "Source checkout containing this profile and its own Lisp packages.")
(defconst phimacs-state-directory
  (file-name-as-directory
   (expand-file-name
    (or (getenv "PHIMACS_STATE_DIR")
        (expand-file-name "phimacs" (or (getenv "XDG_STATE_HOME")
                                       "~/.local/state")))))
  "Private mutable state, never the reference init directory.")
(when (file-in-directory-p phimacs-state-directory phimacs-config-directory)
  (error "PHIMACS_STATE_DIR must be outside the source configuration"))
(unless (file-directory-p phimacs-state-directory)
  (make-directory phimacs-state-directory t)
  (set-file-modes phimacs-state-directory #o700))
(unless (and (not (file-symlink-p (directory-file-name phimacs-state-directory)))
             (equal (file-attribute-user-id (file-attributes phimacs-state-directory))
                    (user-uid))
             (zerop (logand (file-modes phimacs-state-directory) #o077)))
  (error "Phimacs state directory %s must be your own non-symlink directory with mode 0700; create it with mkdir -m 700 (or umask 077) or run chmod 700 on it"
         (directory-file-name phimacs-state-directory)))
;; Installed packages and packages' own mutable files (TRAMP, Transient, logs)
;; belong with state, never the source config.
(setq user-emacs-directory (expand-file-name "emacs/" phimacs-state-directory)
      auto-save-list-file-prefix (expand-file-name "auto-save-list/.saves-" phimacs-state-directory)
      package-user-dir (expand-file-name "elpa" user-emacs-directory))
(when (fboundp 'startup-redirect-eln-cache)
  (startup-redirect-eln-cache (expand-file-name "eln-cache" phimacs-state-directory)))
(let ((socket (or (getenv "PHIMACS_SERVER_SOCKET")
                  (expand-file-name
                   (or (getenv "PHIMACS_SERVER_NAME") "phimacs")
                   (expand-file-name "sockets/" phimacs-state-directory)))))
  (unless (file-name-absolute-p socket) (error "PHIMACS_SERVER_SOCKET must be absolute"))
  (setq server-name socket server-socket-dir (file-name-directory socket)))
(add-to-list 'load-path (expand-file-name "lisp" phimacs-config-directory))
(add-hook 'emacs-startup-hook
          (lambda () (setq gc-cons-threshold (* 64 1024 1024))))
;;; early-init.el ends here
