;;; pi-deck-group-rows.el --- Terminal-cell layout for space group bands -*- lexical-binding: t; -*-

;; SPDX-License-Identifier: MIT

;;; Code:

(require 'pi-deck-available)

(defface pi-deck-group-band '((t :inherit mode-line-inactive :weight bold :extend t))
  "Face for the full-width group headings in the sidebar."
  :group 'pi-deck)

(defun pi-deck-group-runtime-status-p (runtime status)
  "Whether RUNTIME advertises STATUS or has the separate `new' mark."
  (if (eq status 'new) (pi-deck-available-new-p runtime)
    (eq (pi-deck-available-status runtime) status)))

(defun pi-deck-group-row (group agents runtimes statuses width folded)
  "Return GROUP's band with buttons for its AGENTS and available RUNTIMES.
Show STATUSES in attention order.  Use WIDTH text cells, reserving one
for the name; omit lower-priority badges before splitting any badge.
FOLDED affects the accessible description, not the width."
  (let ((remaining width) badges)
    (catch 'full
      (dolist (status (append (seq-intersection pi-deck-statuses statuses) '(new)))
        (let ((count (+ (cl-count status agents :key #'pi-deck-agent-status)
                        (cl-count-if (lambda (r) (pi-deck-group-runtime-status-p r status)) runtimes))))
          (when (> count 0)
            (let* ((label (concat " " (pi-deck-status-icon status)
                                  (when (> count 1) (format " %d" count))))
                   (cost (string-width label)))
              (when (>= cost remaining) (throw 'full nil))
              (push (propertize label 'pi-deck-group-status status
                                'face (pi-deck-status-face status)
                                'help-echo (format "%s: %d %s; mouse-1: visit" group count status))
                    badges)
              (setq remaining (- remaining cost)))))))
    (let* ((name (truncate-string-to-width group remaining nil nil "…"))
           (line (concat name (make-string (- remaining (string-width name)) ?\s)
                         (string-join (nreverse badges) "") "\n")))
      (add-face-text-property 0 (length line) 'pi-deck-group-band t line)
      (put-text-property 0 (length line) 'pi-deck-group group line)
      (put-text-property 0 (length name) 'help-echo
                         (format "%s: mouse-1: %s; mouse-3: edit group"
                                 group (if folded "unfold" "fold")) line)
      line)))

(provide 'pi-deck-group-rows)
;;; pi-deck-group-rows.el ends here
