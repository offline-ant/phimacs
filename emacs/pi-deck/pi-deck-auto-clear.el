;;; pi-deck-auto-clear.el --- Clear a parent's finished children after its run -*- lexical-binding: t; -*-

;; SPDX-License-Identifier: MIT

;;; Commentary:

;; When a parent agent's run has ended and the user has seen it (its status
;; changes to idle), its results are known to have been used.  With
;; auto-clear on for the parent's home space, the deck then forgets the
;; parent's finished worker records and closes its exited panels and shells,
;; through the same path as the sidebar's global cleanup.  The parent itself,
;; live shells and Pi views stay.
;;
;; The setting resolves per space: the space's override, else its group's
;; override, else `pi-deck-auto-clear-finished'.  The check runs on
;; `pi-deck-update-hook', so it follows state and seen changes, never a timer.

;;; Code:

(require 'pi-deck-finished)

(declare-function pi-deck-save-preference "pi-deck-sidebar" (variable))

(defcustom pi-deck-auto-clear-finished nil
  "Whether finished children are cleared once their parent's run is seen.
This is the default for spaces and groups without their own override.
Toggling it from the sidebar header's menu saves it as a preference."
  :type 'boolean
  :group 'pi-deck)

(defun pi-deck-auto-clear-inherited (space)
  "Return whether SPACE inherits auto-clear.
That is its group's override, else `pi-deck-auto-clear-finished'."
  (pcase (alist-get (plist-get (pi-deck-space space) :group) pi-deck--group-auto-clear
                    nil nil #'equal)
    ('on t)
    ('off nil)
    (_ pi-deck-auto-clear-finished)))

(defun pi-deck-auto-clear-p (space)
  "Return whether auto-clear is on for SPACE (nil for agents without a space)."
  (pcase (plist-get (pi-deck-space space) :auto-clear)
    ('on t)
    ('off nil)
    (_ (pi-deck-auto-clear-inherited space))))

(defun pi-deck-set-space-auto-clear (space value)
  "Set SPACE's auto-clear override to VALUE: `on', `off' or nil to inherit."
  (cl-loop for tail on pi-deck-spaces
           when (equal space (plist-get (car tail) :name))
           do (setf (plist-get (car tail) :auto-clear) value)
           (pi-deck--schedule-update)))

(defun pi-deck-set-group-auto-clear (group value)
  "Set GROUP's auto-clear override to VALUE: `on', `off' or nil to inherit."
  (when (pi-deck-group-members group)
    (setf (alist-get group pi-deck--group-auto-clear nil t #'equal) value)
    (pi-deck--schedule-update)))

(defun pi-deck-toggle-auto-clear-finished ()
  "Toggle the default auto-clear of finished children and save it."
  (interactive)
  (setq pi-deck-auto-clear-finished (not pi-deck-auto-clear-finished))
  (pi-deck--schedule-update)
  (with-demoted-errors "pi-deck: %S"
    (pi-deck-save-preference 'pi-deck-auto-clear-finished)))

(defvar pi-deck--auto-clear-settled nil
  "Alist of agent buffers and whether their status was idle at the last check.")

(defun pi-deck-auto-clear-check ()
  "Clear the finished children of parents whose seen run has just ended.
An agent the previous check did not know (new or restored) only records
its status, so restored entries stay until a run ends again."
  (let ((previous pi-deck--auto-clear-settled) tab-index next)
    (dolist (agent (pi-deck-agents))
      (let* ((buffer (pi-deck-agent-buffer agent))
             (settled (eq (pi-deck-agent-status agent) 'idle))
             (known (assq buffer previous)))
        (push (cons buffer settled) next)
        (when (and settled known (not (cdr known))
                   (pi-deck-auto-clear-p
                    (pi-deck-agent-space agent (or tab-index (setq tab-index (pi-deck-tab-index))))))
          (pi-deck--auto-clear-children agent))))
    (setq pi-deck--auto-clear-settled next)))

(defun pi-deck--auto-clear-children (parent)
  "Forget PARENT's finished workers and close its finished terminals.
Report only failures; they stay listed for the global cleanup."
  (let ((buffer (pi-deck-agent-buffer parent)))
    (pi-deck-clear-finished-workers buffer)
    (when-let* ((shells (seq-filter (lambda (child)
                                      (and (eq (pi-deck-agent-parent child) buffer)
                                           (pi-deck-agent-finished-shell-p child)))
                                    (pi-deck-agents))))
      (pi-deck-close-finished-terminals
       shells
       (lambda (_closed failures)
         (when failures
           (message "pi-deck: auto-clear under %s failed: %s"
                    (buffer-name buffer) (string-join failures "; "))))))))

(provide 'pi-deck-auto-clear)
;;; pi-deck-auto-clear.el ends here
