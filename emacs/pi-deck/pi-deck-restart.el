;;; pi-deck-restart.el --- Verified Emacs replacement handoff -*- lexical-binding: t; -*-
;; SPDX-License-Identifier: MIT

;;; Commentary:
;; Prepare a private, acknowledged helper before the old Emacs may exit.  The
;; helper never signals the old process and does nothing without a commit marker.
;; Manual and externally supervised replacement have separate explicit commands.
;; Linux process-start identity prevents a reused PID becoming the old owner.

;;; Code:
(require 'cl-lib)
(require 'subr-x)
(require 'server)
(require 'pi-deck-core)
(declare-function pi-deck-server-socket "pi-deck-daemon" ())

(defcustom pi-deck-restart-mode 'manual
  "How Emacs replacement is started: manually or by an external supervisor.
Neither mode installs a service.  A restart disconnects frontend clients;
host-native processes may stop, but detached RPC roots are not stopped."
  :type '(choice (const manual) (const supervised))
  :group 'pi-deck)

(defcustom pi-deck-restart-command '("emacs" "--daemon=%s")
  "Manual replacement command, started only after this Emacs exits.
`%s' in arguments expands to this server's absolute socket filename."
  :type '(repeat string)
  :group 'pi-deck)

(defcustom pi-deck-supervisor-restart-command nil
  "Explicit command asking the external supervisor to replace exited Emacs.
Required in supervised mode; no manual command is used as a fallback.  This
runs after the old process exits, never as an implicit stop/restart service."
  :type '(repeat string)
  :group 'pi-deck)

(defcustom pi-deck-restart-poll-interval 0.2
  "Seconds between the prepared helper's process-identity checks."
  :type 'number
  :group 'pi-deck)

(defcustom pi-deck-restart-prepare-timeout 5
  "Maximum seconds to await acknowledgement from a replacement helper."
  :type 'number
  :group 'pi-deck)

(defun pi-deck-restart-command-line ()
  "Return the command for the selected explicit replacement mode."
  (let ((socket (or (pi-deck-server-socket) server-name))
        (command (pcase pi-deck-restart-mode
                   ('manual pi-deck-restart-command)
                   ('supervised (or pi-deck-supervisor-restart-command
                                    (user-error "Supervised restart needs pi-deck-supervisor-restart-command")))
                   (_ (user-error "Unknown pi-deck-restart-mode: %S" pi-deck-restart-mode)))))
    (unless (and (consp command) (cl-every #'stringp command) (not (string-empty-p (car command))))
      (user-error "Replacement command must be a nonempty list of strings"))
    (mapcar (lambda (argument)
              (if (string-search "%s" argument) (format argument socket) argument))
            command)))

(defun pi-deck--process-start (pid)
  "Return Linux PID's start identity, or nil after exit (including zombies)."
  (condition-case nil
      (with-temp-buffer
        (insert-file-contents (format "/proc/%d/stat" pid))
        (let* ((fields (split-string (buffer-substring-no-properties
                                     (progn (goto-char (point-max)) (search-backward ") ") (+ (point) 2))
                                     (point-max))))
               (state (car fields)))
          (unless (member state '("Z" "X")) (nth 19 fields))))
    (file-error nil)))

(defun pi-deck--restart-script (pid start command directory log)
  "Return the private handoff script for PID/START and COMMAND.
DIRECTORY holds ready/commit markers; LOG is private startup diagnostic output."
  (format
   (concat "set -eu\n"
           "op=%s\nexec >%s 2>&1\n"
           "cleanup() { rm -f -- \"$op/ready\" \"$op/commit\"; rmdir -- \"$op\" 2>/dev/null || :; }\n"
           "trap cleanup EXIT\n"
           "start() { IFS= read -r stat < \"/proc/$1/stat\" 2>/dev/null || return 1; stat=${stat##*) }; set -- $stat; [ \"$1\" != Z ] && [ \"$1\" != X ] || return 1; shift 19; printf '%%s' \"$1\"; }\n"
           "[ \"$(start %d)\" = %s ] || exit 1\n"
           "printf '%%s %%s\\n' \"$$\" \"$(start $$)\" > \"$op/ready\"\n"
           "while [ ! -f \"$op/commit\" ]; do [ -d \"$op\" ] && [ \"$(start %d)\" = %s ] || exit 1; sleep %s; done\n"
           "while [ \"$(start %d)\" = %s ]; do [ -d \"$op\" ] || exit 1; sleep %s; done\n"
           "cleanup\ntrap - EXIT\nexec %s\n")
   (shell-quote-argument directory) (shell-quote-argument log)
   pid (shell-quote-argument start) pid (shell-quote-argument start) pi-deck-restart-poll-interval
   pid (shell-quote-argument start) pi-deck-restart-poll-interval
   (mapconcat #'shell-quote-argument command " ")))

(defun pi-deck--restart-helper-ready-p (directory)
  "Return non-nil while DIRECTORY's acknowledged helper identity still lives."
  (let ((ready (expand-file-name "ready" directory)))
    (when (file-readable-p ready)
      (let ((text (with-temp-buffer (insert-file-contents ready) (buffer-string))))
        (when (string-match "\\`\\([0-9]+\\) \\([0-9]+\\)\n\\'" text)
          (equal (match-string 2 text)
                 (pi-deck--process-start (string-to-number (match-string 1 text)))))))))

(defun pi-deck--prepare-restart (command)
  "Prepare and verify COMMAND's detached helper; return its operation directory.
A failure cleans up this uncommitted operation and never exits Emacs."
  (let* ((executable (executable-find (car command)))
         (setsid (executable-find "setsid"))
         (shell (executable-find "sh"))
         (start (pi-deck--process-start (emacs-pid))))
    (unless (and executable (file-regular-p executable) (file-executable-p executable))
      (user-error "Replacement executable is unavailable: %s" (car command)))
    (unless (and setsid shell (executable-find "sleep") start)
      (user-error "Restart requires Linux /proc, util-linux setsid, sh and sleep"))
    (unless (and (numberp pi-deck-restart-poll-interval) (> pi-deck-restart-poll-interval 0)
                 (numberp pi-deck-restart-prepare-timeout) (> pi-deck-restart-prepare-timeout 0))
      (user-error "Restart polling and preparation timeout must be positive"))
    (let* ((directory (make-temp-file "pi-deck-restart-" t))
           (log (expand-file-name (locate-user-emacs-file "var/pi-deck/restart.log")))
           (command (cons executable (cdr command)))
           (deadline (+ (float-time) pi-deck-restart-prepare-timeout))
           acknowledged)
      (set-file-modes directory #o700)
      (unwind-protect
          (progn
            (make-directory (file-name-directory log) t)
            (when (file-symlink-p log) (user-error "Restart log is a symbolic link; refusing to overwrite it"))
            (with-file-modes #o600 (write-region "" nil log nil 'silent))
            (set-file-modes log #o600)
            (let ((status (call-process setsid nil nil nil "-f" shell "-c"
                                        (pi-deck--restart-script (emacs-pid) start command directory log))))
              (unless (and (integerp status) (zerop status))
                (user-error "Restart helper failed (%s); Emacs is still running; inspect %s" status log)))
            (while (and (not acknowledged) (< (float-time) deadline))
              (setq acknowledged (pi-deck--restart-helper-ready-p directory))
              (unless acknowledged (accept-process-output nil 0.02)))
            (unless acknowledged
              (user-error "Restart helper did not acknowledge readiness; Emacs is still running; inspect %s" log))
            directory)
        (unless acknowledged (delete-directory directory t))))))

(provide 'pi-deck-restart)
;;; pi-deck-restart.el ends here
