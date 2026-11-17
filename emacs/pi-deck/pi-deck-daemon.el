;;; pi-deck-daemon.el --- Emacs server status, config reload and restart -*- lexical-binding: t; -*-

;; SPDX-License-Identifier: MIT

;;; Commentary:

;; `pi-deck-daemon-info' reports the server this Emacs runs (name, socket,
;; PID, clients, frames, uptime) and the Pi orchestration host.  Restarting saves
;; the deck state, starts a detached helper that waits for this process to
;; exit and then runs `pi-deck-restart-command', and exits.  The new daemon
;; restores the saved spaces and sessions like any start of the server
;; owning the state file (see pi-deck-persist).

;;; Code:

(require 'server)
(require 'pi-deck-core)
(require 'pi-deck-restart)

(declare-function pi-deck-save-state "pi-deck-persist" (&optional file))
(defvar pi-deck-state-file)
(defvar pi-deck--state-owner)
(defvar pi-deck--restoring)
(defvar pi-deck--dbus-available)
(defvar pi-deck-notify-method)

(defun pi-deck-server-running-p ()
  "Return non-nil when this Emacs runs its server."
  (and (bound-and-true-p server-process) (process-live-p server-process)))

(defun pi-deck-server-socket ()
  "Return this Emacs's server socket file (or TCP auth file), or nil.
An absolute `server-name' is the file itself."
  (when (pi-deck-server-running-p)
    (expand-file-name server-name (if server-use-tcp server-auth-dir server-socket-dir))))

(defun pi-deck-server-display-name ()
  "Return the server name without its directory."
  (file-name-nondirectory server-name))

(defun pi-deck--client-frames ()
  "Return frames that can show spaces: all frames except a daemon's own frame."
  (if (daemonp)
      (cl-remove-if (lambda (frame)
                      (equal (terminal-name (frame-terminal frame)) "initial_terminal"))
                    (frame-list))
    (frame-list)))

(defun pi-deck-daemon-info-lines ()
  "Return lines describing this Emacs server and the Pi integration."
  (let ((sessions (cl-count-if (lambda (agent)
                                 (and (eq (pi-deck-agent-kind agent) 'pi)
                                      (process-live-p (or (pi-deck-agent-process agent) 0))))
                               (pi-deck-agents))))
    (list
     (format "Emacs %s · %s · pid %d · up %s · clients %d · frames %d · live Pi sessions %d"
             emacs-version
             (cond ((and (daemonp) (pi-deck-server-running-p))
                    (format "daemon %S" (pi-deck-server-display-name)))
                   ((pi-deck-server-running-p)
                    (format "server %S" (pi-deck-server-display-name)))
                   (t "no server"))
             (emacs-pid) (emacs-uptime "%h:%.2m")
             (length (bound-and-true-p server-clients))
             (length (pi-deck--client-frames))
             sessions)
     (format "socket %s · orchestration %s · notifications %s"
             (if-let* ((socket (pi-deck-server-socket))) (abbreviate-file-name socket) "-")
             (cond ((not (featurep 'pi-orchestration)) "not loaded")
                   ((pi-deck-server-running-p) "emacs host ready")
                   (t "loaded, needs a server"))
             (pcase pi-deck-notify-method
               ('nil "off")
               ((or 'auto 'dbus) (if (eq pi-deck--dbus-available t) "dbus" "dbus/echo"))
               (_ "echo area")))
     (format "state %s%s" (abbreviate-file-name pi-deck-state-file)
             (if pi-deck--state-owner "" " (not owned: never restored or saved here)")))))

;;;###autoload
(defun pi-deck-daemon-info ()
  "Describe this Emacs server and the Pi integration in a temporary buffer."
  (interactive)
  (with-output-to-temp-buffer "*pi-deck daemon*"
    (princ (string-join (pi-deck-daemon-info-lines) "\n"))))

(defun pi-deck-live-sessions ()
  "Return live agents whose frontend-owned processes may die with Emacs.
Socket clients are views of independent runtimes, not owned child processes."
  (cl-remove-if-not
   (lambda (agent)
     (let ((process (pi-deck-agent-process agent)))
       (and (processp process) (process-live-p process)
            (not (and (eq (pi-deck-agent-kind agent) 'pi)
                      (eq (process-type process) 'network))))))
   (pi-deck-agents)))

;;;###autoload
(defun pi-deck-reload-config ()
  "Reload `user-init-file' in this Emacs."
  (interactive)
  (unless user-init-file (user-error "No init file to reload"))
  (when (or (not (called-interactively-p 'any))
            (yes-or-no-p (format "Reload %s? " (abbreviate-file-name user-init-file))))
    (load user-init-file nil t)
    (message "Reloaded %s" (abbreviate-file-name user-init-file))))

;;;###autoload
(defun pi-deck-restart-daemon (&optional force)
  "Restart this Emacs only after a verified replacement handoff.
Ask unless FORCE.  Manual and externally supervised replacement use their
explicit commands.  Detached RPC agents are not stopped; host-native
terminals/processes may be lost.  Desktop reconnection is a separate
frontend capability, never a reason to replay a prompt."
  (interactive)
  (unless (pi-deck-server-running-p)
    (user-error "This Emacs runs no server to restart"))
  (let* ((command (pi-deck-restart-command-line))
         (live (pi-deck-live-sessions))
         (names (mapconcat (lambda (agent)
                             (format "  %s %s (%s)" (pi-deck-agent-kind agent)
                                     (pi-deck-agent-name agent) (pi-deck-agent-status agent)))
                           live "\n")))
    (when (or force
              (yes-or-no-p
               (format "Restart daemon %S?%s\nIt runs: %s\nRestart? "
                       (pi-deck-server-display-name)
                       (if live (format "\nThese %d host-owned processes may stop; detached RPC agents survive:\n%s"
                                        (length live) names)
                         "\nDetached RPC agents are not stopped.")
                       (string-join command " "))))
      (let ((operation (pi-deck--prepare-restart command)))
        (unwind-protect
            (progn
              ;; Unlike an automatic save, restart must propagate write errors.
              (when pi-deck--state-owner
                (when pi-deck--restoring (user-error "Finish or cancel the deck restore before restarting"))
                (pi-deck-save-state))
              (unless (pi-deck--restart-helper-ready-p operation)
                (user-error "Prepared restart helper exited; this Emacs is still running"))
              (with-file-modes #o600
                (write-region "commit\n" nil (expand-file-name "commit" operation) nil 'silent))
              (let ((confirm-kill-processes nil)
                    (kill-emacs-query-functions nil))
                (kill-emacs)))
          ;; Normally kill-emacs does not return.  A failed/vetoed exit cancels
          ;; the helper rather than leaving a replacement waiting indefinitely.
          (when (file-directory-p operation) (delete-directory operation t)))))))

(provide 'pi-deck-daemon)
;;; pi-deck-daemon.el ends here
