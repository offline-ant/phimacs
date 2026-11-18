;;; pi-deck-group-editor.el --- Mouse-first space group checklist -*- lexical-binding: t; -*-

;; SPDX-License-Identifier: MIT

;;; Commentary:

;; All edits are local to the form until Save.  A temporary side window
;; keeps the checklist out of space layouts, including dedicated agent pairs.

;;; Code:

(require 'pi-deck-spaces)
(require 'wid-edit)

(declare-function evil-set-initial-state "evil-core" (mode state))

(defvar-local pi-deck-group-editor--original nil)
(defvar-local pi-deck-group-editor--snapshot nil)
(defvar-local pi-deck-group-editor--name nil)
(defvar-local pi-deck-group-editor--rows nil)
(defvar-local pi-deck-group-editor--submit nil)

(defvar-keymap pi-deck-group-editor-mode-map
  :parent widget-keymap
  "C-g" #'pi-deck-group-editor--quit)

(define-derived-mode pi-deck-group-editor-mode fundamental-mode "Space Group"
  "Edit one space group.  Tab navigates the form; Return activates a row."
  (setq-local truncate-lines t))

(with-eval-after-load 'evil
  (evil-set-initial-state 'pi-deck-group-editor-mode 'emacs))

(defun pi-deck-new-group ()
  "Choose spaces for a new named group without changing the current layout."
  (interactive)
  (unless pi-deck-spaces (user-error "Create a space first"))
  (pi-deck-group-editor--open nil))

(defun pi-deck-edit-group (name)
  "Edit the name and membership of space group NAME."
  (interactive
   (list (completing-read "Edit group: "
                          (delete-dups (delq nil (mapcar (lambda (s) (plist-get s :group))
                                                         pi-deck-spaces))) nil t)))
  (unless (and name (seq-find (lambda (s) (equal (plist-get s :group) name)) pi-deck-spaces))
    (user-error "No such group: %s" name))
  (pi-deck-group-editor--open name))

(defun pi-deck-group-editor--memberships ()
  "Return the space names and groups shown in the checklist."
  (mapcar (lambda (s) (cons (plist-get s :name) (plist-get s :group))) pi-deck-spaces))

(defun pi-deck-group-editor--check-current ()
  "Refuse to overwrite changes made since the checklist was opened."
  (unless (equal pi-deck-group-editor--snapshot (pi-deck-group-editor--memberships))
    (user-error "Spaces or groups changed; cancel and reopen this checklist")))

(defun pi-deck-group-editor--open (original)
  "Open a staged checklist for ORIGINAL, or an empty selection for a new group."
  (let ((buffer (generate-new-buffer "*Space group*")))
    (unwind-protect
        (progn
          (with-current-buffer buffer
            (pi-deck-group-editor-mode)
            (setq pi-deck-group-editor--original original
                  pi-deck-group-editor--snapshot (pi-deck-group-editor--memberships)
                  pi-deck-group-editor--name
                  (widget-create 'editable-field :format "Group name: %v" :value (or original "")))
            (widget-insert "Choose spaces:\n")
            (dolist (space pi-deck-spaces)
              (let* ((name (plist-get space :name)) (group (plist-get space :group))
                     (selected (and original (equal original group))))
                (push (cons name
                            (widget-create 'toggle :format "%[%v %t%]\n" :on "[X]" :off "[ ]"
                                           :button-prefix "" :button-suffix ""
                                           :tag (if (and group (not selected))
                                                    (format "%s  (%s)" name group) name)
                                           :value selected :notify #'pi-deck-group-editor--count))
                      pi-deck-group-editor--rows)))
            (setq pi-deck-group-editor--rows (nreverse pi-deck-group-editor--rows)
                  pi-deck-group-editor--submit
                  (widget-create 'push-button :notify #'pi-deck-group-editor--save ""))
            (pi-deck-group-editor--count)
            (widget-insert "  ")
            (widget-create 'push-button :notify #'pi-deck-group-editor--quit "Cancel")
            (when original
              (widget-insert "  ")
              (widget-create 'push-button :notify #'pi-deck-group-editor--dissolve "Dissolve group"))
            (widget-insert "\n")
            (widget-setup)
            (goto-char (widget-field-end pi-deck-group-editor--name)))
          (select-window
           (display-buffer-in-side-window
            buffer '((side . bottom) (slot . 1) (window-height . fit-window-to-buffer))))
          (prog1 buffer (setq buffer nil)))
      (when buffer (kill-buffer buffer)))))

(defun pi-deck-group-editor--selection ()
  "Return the names of the checked spaces, in registry order."
  (cl-loop for (name . row) in pi-deck-group-editor--rows when (widget-value row) collect name))

(defun pi-deck-group-editor--count (&rest _)
  "Update the visible number of selected spaces."
  (widget-value-set pi-deck-group-editor--submit
                    (format "%s (%d)" (if pi-deck-group-editor--original "Save" "Create")
                            (length (pi-deck-group-editor--selection)))))

(defun pi-deck-group-editor--save (&rest _)
  "Validate the staged name and selection, then apply the whole edit once."
  (pi-deck-group-editor--check-current)
  (let ((name (pi-deck--group-name (widget-value pi-deck-group-editor--name)))
        (spaces (pi-deck-group-editor--selection)))
    (unless spaces (user-error "Choose at least one space"))
    (when (and (not (equal name pi-deck-group-editor--original))
               (seq-find (lambda (s) (equal name (plist-get s :group))) pi-deck-spaces))
      (user-error "A group named %s already exists" name))
    (pi-deck-set-space-group name spaces pi-deck-group-editor--original)
    (pi-deck-group-editor--quit)))

(defun pi-deck-group-editor--dissolve (&rest _)
  "Ungroup all members of the original group without closing their spaces."
  (pi-deck-group-editor--check-current)
  (pi-deck-set-space-group nil (cl-loop for s in pi-deck-spaces
                                       when (equal (plist-get s :group) pi-deck-group-editor--original)
                                       collect (plist-get s :name)))
  (pi-deck-group-editor--quit))

(defun pi-deck-group-editor--quit (&rest _)
  "Discard the checklist buffer and restore its caller's window."
  (interactive)
  (quit-window t (get-buffer-window (current-buffer))))

(provide 'pi-deck-group-editor)
;;; pi-deck-group-editor.el ends here
