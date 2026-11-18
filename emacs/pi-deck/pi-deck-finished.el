;;; pi-deck-finished.el --- Clear completed sidebar entries -*- lexical-binding: t; -*-

;; SPDX-License-Identifier: MIT

;;; Commentary:

;; Finished workers are transcript records, not live agents.  Finished shells
;; are terminals without live processes.  Clearing these entries never selects
;; ordinary Pi agents by attention status, disconnects a runtime or expands a
;; terminal's descendants.  Terminal cleanup still goes through its owner.

;;; Code:

(require 'pi-deck-workers)
(require 'pi-deck-close)

;;;###autoload
(defun pi-deck-clear-finished ()
  "Forget finished workers and close exited terminals in all spaces.
Worker session files stay on disk; terminal output is discarded.  Live
shells and all Pi views remain untouched.  No confirmation is required.
Failed terminal cleanup retains that entry, reports the error and does not
prevent clearing the other finished terminals.  Keep the selected window
when it survives cleanup."
  (interactive)
  (let ((workers (length pi-deck--finished-workers)))
    (pi-deck-clear-finished-workers)
    (pi-deck-close-finished-terminals
     (seq-filter #'pi-deck-agent-finished-shell-p (pi-deck-agents))
     (lambda (closed failures)
       (message "pi-deck: cleared %d finished worker%s and %d shell%s%s"
                workers (if (= workers 1) "" "s")
                closed (if (= closed 1) "" "s")
                (if failures
                    (format "; %d failed: %s" (length failures)
                            (string-join failures "; "))
                  ""))))))

(defun pi-deck-close-finished-terminals (agents callback)
  "Close those of AGENTS that are still finished terminals, one by one.
A failed close retains its entry and does not stop the others.  Then call
CALLBACK with the number closed and the failure descriptions, in order."
  (let ((closed 0) failures)
    (cl-labels
        ((next (remaining)
           (if-let* ((agent (car remaining)))
               ;; A preceding owner callback may have run the event loop.
               ;; Never close a terminal that has since been resumed.
               (if (not (and (buffer-live-p (pi-deck-agent-buffer agent))
                             (pi-deck-agent-finished-shell-p agent)))
                   (next (cdr remaining))
                 (let ((name (pi-deck-agent-name agent)))
                   (save-selected-window
                     (pi-deck-stop-agent
                      agent
                      (lambda (error)
                        (if error (push (format "%s: %s" name error) failures)
                          (cl-incf closed))
                        (next (cdr remaining)))))))
             (pi-deck--schedule-update)
             (funcall callback closed (nreverse failures)))))
      (next agents))))

(defvar-keymap pi-deck-finished--button-map
  :doc "Sidebar header bindings for clearing finished entries."
  "<header-line> <down-mouse-1>" #'ignore
  "<header-line> <mouse-1>" #'pi-deck-clear-finished)

(defvar-keymap pi-deck-finished--inactive-map
  :doc "Ignore clicks on the empty finished-entry cleanup button."
  "<header-line> <down-mouse-1>" #'ignore
  "<header-line> <mouse-1>" #'ignore)

(defun pi-deck-finished-button ()
  "Return the global finished-entry cleanup button for the sidebar header.
It is dimmed and inactive when there are no finished workers or terminals."
  (let ((available (or pi-deck--finished-workers
                       (seq-some #'pi-deck-agent-finished-shell-p (pi-deck-agents)))))
    (propertize "[×]"
                'face (if available 'header-line-highlight 'pi-deck-header-dim)
                'mouse-face (and available 'mode-line-highlight)
                'pointer (and available 'hand)
                'help-echo (if available
                               "Clear finished workers and shells in all spaces; worker session files stay on disk; terminal output is discarded"
                             "No finished workers or shells to clear")
                'local-map (if available pi-deck-finished--button-map
                             pi-deck-finished--inactive-map))))

(provide 'pi-deck-finished)
;;; pi-deck-finished.el ends here
