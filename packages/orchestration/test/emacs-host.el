;;; emacs-host.el --- Disposable native Emacs host fixture -*- lexical-binding: t; -*-

;;; Commentary:
;; Loaded only by private daemons that native tests own (`emacs -Q
;; --daemon=<socket> -l emacs-host.el'): Pilish, ghostel and the
;; orchestration companion, without the user's configuration.  Package, Pilish,
;; native-module and grammar paths must be explicit acquired test inputs;
;; there are no sibling-checkout or home-cache fallbacks.

;;; Code:

(require 'package)
(defun pi-emacs-host--input-directory (variable)
  "Read an explicit existing test input directory from VARIABLE."
  (let ((value (getenv variable)))
    (unless (and value (file-name-absolute-p value) (file-directory-p value))
      (error "%s must name an existing absolute test input directory" variable))
    value))
(setq package-user-dir (pi-emacs-host--input-directory "PI_EMACS_ELPA")
      load-prefer-newer t
      treesit-extra-load-path
      (list (pi-emacs-host--input-directory "PI_EMACS_GRAMMARS")))
(package-initialize)
(defconst pi-emacs-host--directory
  (file-name-directory (or load-file-name buffer-file-name)))
(add-to-list 'load-path (pi-emacs-host--input-directory "PI_EMACS_PILISH"))
(add-to-list 'load-path (expand-file-name "../emacs" pi-emacs-host--directory))
(setq ghostel-module-directory
      (pi-emacs-host--input-directory "PI_EMACS_GHOSTEL_MODULE"))
(require 'pi-orchestration)
(setq pilish-extra-args nil)

(defun pi-lifecycle-input (encoded)
  "Read or change an owned input buffer using base64 JSON ENCODED."
  (let* ((data (json-parse-string
                (decode-coding-string (base64-decode-string encoded) 'utf-8)
                :object-type 'plist))
         (target (gethash (plist-get data :id) pi-orchestration--targets))
         (input (pilish-session-input-buffer (plist-get target :buffer))))
    (unless (buffer-live-p input) (error "Missing lifecycle target input"))
    (with-current-buffer input
      (when (plist-member data :text)
        (erase-buffer)
        (insert (plist-get data :text)))
      (when (eq (plist-get data :send) t) (pilish-send))
      (base64-encode-string (encode-coding-string (buffer-string) 'utf-8) t))))

(provide 'emacs-host)
;;; emacs-host.el ends here
