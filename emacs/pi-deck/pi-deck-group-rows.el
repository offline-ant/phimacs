;;; pi-deck-group-rows.el --- Terminal-cell layout for space group bands -*- lexical-binding: t; -*-

;; SPDX-License-Identifier: MIT

;;; Commentary:

;; A group band is one full-width sidebar row: the group's name and blank
;; padding fold it, each status badge visits a matching agent, and the
;; single cells between badges are inert.  Each target highlights apart.

;;; Code:

(require 'pi-deck-available)

(declare-function pi-deck-jump "pi-deck-goto" (agent))

(defface pi-deck-group-band
  '((((class color) (min-colors 88) (background dark))
     :background "#374550" :foreground "#e7f2fa" :weight bold :extend t)
    (((class color) (min-colors 88) (background light))
     :background "#d3dee6" :foreground "#1d2b35" :weight bold :extend t)
    (((class color) (min-colors 8))
     :background "blue" :foreground "white" :weight bold :extend t)
    (t :inverse-video t :weight bold :extend t))
  "Face for the full-width group headings in the sidebar.
It has its own background: borrowed mode-line faces often differ from the
buffer only by a box, which text terminals do not draw."
  :group 'pi-deck)

(defun pi-deck-group-runtime-status-p (runtime status)
  "Whether RUNTIME advertises STATUS or has the separate `new' mark."
  (if (eq status 'new) (pi-deck-available-new-p runtime)
    (eq (pi-deck-available-status runtime) status)))

(defun pi-deck-group-row (group agents runtimes statuses width folded)
  "Return GROUP's band with buttons for its AGENTS and available RUNTIMES.
Show STATUSES in attention order.  Use WIDTH text cells, reserving one
for the name; omit lower-priority badges before splitting any badge.
FOLDED affects the accessible description, not the width.  The name and
padding are one fold target; each badge, without the blank cell before
it, is its own target."
  (let ((remaining width) badges)
    (catch 'full
      (dolist (status (append (seq-intersection pi-deck-statuses statuses) '(new)))
        (let ((count (+ (cl-count status agents :key #'pi-deck-agent-status)
                        (cl-count-if (lambda (r) (pi-deck-group-runtime-status-p r status)) runtimes))))
          (when (> count 0)
            (let* ((label (concat (pi-deck-status-icon status)
                                  (when (> count 1) (format " %d" count))))
                   (cost (1+ (string-width label))))
              (when (>= cost remaining) (throw 'full nil))
              (push (concat (propertize " " 'mouse-face nil 'pi-deck-button 'none)
                            (propertize label 'pi-deck-group-status status
                                        'face (pi-deck-status-face status)
                                        'mouse-face 'highlight 'pointer 'hand
                                        'help-echo (format "%s: %d %s; mouse-1: visit"
                                                           group count status)))
                    badges)
              (setq remaining (- remaining cost)))))))
    (let* ((name (truncate-string-to-width group remaining nil nil "…"))
           (fold (propertize (concat name (make-string (- remaining (string-width name)) ?\s))
                             'mouse-face 'highlight 'pointer 'hand
                             'help-echo (format "%s: mouse-1: %s; mouse-3: menu"
                                                group (if folded "unfold" "fold"))))
           (line (concat fold (string-join (nreverse badges) "") "\n")))
      (add-face-text-property 0 (length line) 'pi-deck-group-band t line)
      (put-text-property 0 (length line) 'pi-deck-group group line)
      line)))

(defun pi-deck-group-visit-status (group status)
  "Visit a matching agent in GROUP, or explicitly attach a matching runtime.
Prefer the newest tracked match.  Resolve STATUS again at click time."
  (let* ((homes (pi-deck-group-members group))
         (index (pi-deck-tab-index))
         (agents (cl-loop for a in (pi-deck-agents)
                          when (and (eq (pi-deck-agent-status a) status)
                                    (member (pi-deck-agent-space a index) homes)) collect a)))
    (if agents (pi-deck-jump (car (sort agents :key #'pi-deck-agent-changed :lessp #'>)))
      (if-let* ((runtime (seq-find (lambda (r) (and (pi-deck-group-runtime-status-p r status)
                                                    (member (pi-deck-available-space r) homes)))
                                   (reverse (pi-deck-available-runtimes)))))
          (pi-deck-attach-available runtime)
        (message "No %s target in %s" status group)))))

(provide 'pi-deck-group-rows)
;;; pi-deck-group-rows.el ends here
