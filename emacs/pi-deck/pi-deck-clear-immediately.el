;;; pi-deck-clear-immediately.el --- Clear agent-started children when they finish -*- lexical-binding: t; -*-

;; SPDX-License-Identifier: MIT

;;; Commentary:

;; By default finished workers and exited shells stay listed until the
;; sidebar's global cleanup.  A space, a group or the global setting can
;; clear them immediately instead: then a closing worker started by an agent
;; leaves no finished-worker record, and an agent-started panel or shell is
;; closed as soon as its command ends, through the global cleanup's path.
;; Shells the user opened have no parent and always stay.  A child is
;; cleared when any of its parent's home space, that space's group or
;; `pi-deck-clear-finished-immediately' says so.

;;; Code:

(require 'pi-deck-finished)

(declare-function pi-deck-save-preference "pi-deck-sidebar" (variable))

(defcustom pi-deck-clear-finished-immediately nil
  "Whether agent-started children are cleared as they finish, in all spaces.
When nil, only spaces and groups that clear them do.  Toggling it from the
sidebar header's menu saves it as a preference."
  :type 'boolean
  :group 'pi-deck)

(defun pi-deck-clear-finished-p (space)
  "Return whether children of agents in SPACE are cleared as they finish.
That is when SPACE, its group or `pi-deck-clear-finished-immediately'
says so.  For agents without a space (nil SPACE) only the global setting
applies."
  (let ((record (pi-deck-space space)))
    (or pi-deck-clear-finished-immediately
        (plist-get record :clear-finished)
        (and (member (plist-get record :group) pi-deck--group-clear-finished) t))))

(defun pi-deck-clear-finished-child-p (parent)
  "Return whether finished children of PARENT's buffer are cleared at once."
  (let ((agent (pi-deck-agent parent)))
    (pi-deck-clear-finished-p (and agent (pi-deck-agent-space agent)))))

(defun pi-deck-set-space-clear-finished (space clear)
  "Set whether SPACE clears finished children immediately to CLEAR."
  (cl-loop for tail on pi-deck-spaces
           when (equal space (plist-get (car tail) :name))
           do (setf (plist-get (car tail) :clear-finished) (and clear t))
           (pi-deck--schedule-update)))

(defun pi-deck-set-group-clear-finished (group clear)
  "Set whether GROUP clears finished children immediately to CLEAR."
  (when (pi-deck-group-members group)
    (setq pi-deck--group-clear-finished
          (if clear (cl-adjoin group pi-deck--group-clear-finished :test #'equal)
            (remove group pi-deck--group-clear-finished)))
    (pi-deck--schedule-update)))

(defun pi-deck-toggle-clear-finished-immediately ()
  "Toggle clearing finished children immediately in all spaces and save it."
  (interactive)
  (setq pi-deck-clear-finished-immediately (not pi-deck-clear-finished-immediately))
  (pi-deck--schedule-update)
  (with-demoted-errors "pi-deck: %S"
    (pi-deck-save-preference 'pi-deck-clear-finished-immediately)))

(defvar pi-deck--clear-held nil
  "Terminal buffers being closed by, or whose close failed in, immediate clearing.
They are not closed again, so a failure is reported once and stays listed
for the global cleanup.")

(defun pi-deck-clear-finished-shells ()
  "Close agent-started terminals that finished where clearing is immediate.
Runs on `pi-deck-update-hook'.  Report only failures."
  (setq pi-deck--clear-held (seq-filter #'buffer-live-p pi-deck--clear-held))
  (when-let* ((shells (seq-filter
                       (lambda (agent)
                         (let ((parent (pi-deck-agent-parent agent)))
                           (and parent
                                (not (memq (pi-deck-agent-buffer agent) pi-deck--clear-held))
                                (pi-deck-agent-finished-shell-p agent)
                                (pi-deck-clear-finished-child-p parent))))
                       (pi-deck-agents))))
    (let ((buffers (mapcar #'pi-deck-agent-buffer shells)))
      (setq pi-deck--clear-held (append buffers pi-deck--clear-held))
      (pi-deck-close-finished-terminals
       shells
       (lambda (_closed failures)
         (setq pi-deck--clear-held
               (seq-remove (lambda (buffer)
                             ;; Keep only the failures: still tracked and finished.
                             (and (memq buffer buffers)
                                  (not (when-let* ((agent (pi-deck-agent buffer)))
                                         (pi-deck-agent-finished-shell-p agent)))))
                           pi-deck--clear-held))
         (when failures
           (message "pi-deck: clearing finished shells failed: %s"
                    (string-join failures "; "))))))))

(provide 'pi-deck-clear-immediately)
;;; pi-deck-clear-immediately.el ends here
