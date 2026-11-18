;;; pi-deck-group-editor-test.el --- Group checklist regressions -*- lexical-binding: t; -*-

;; SPDX-License-Identifier: MIT

(require 'ert)
(require 'pi-deck-test-fixtures)

(defmacro pi-deck-group-editor-test--with-spaces (&rest body)
  "Run BODY with three spaces and isolated window/model state."
  (declare (indent 0) (debug t))
  `(save-window-excursion
     (let ((pi-deck-spaces (copy-tree '((:name "pi" :group "Environment")
                                        (:name "devices" :group "Environment")
                                        (:name "sn" :group nil))))
           (pi-deck--update-timer 'no-timer))
       (unwind-protect (progn ,@body)
         (dolist (win (window-list nil 'no-minibuf))
           (when (eq (buffer-local-value 'major-mode (window-buffer win)) 'pi-deck-group-editor-mode)
             (quit-window t win)))))))

(defun pi-deck-group-editor-test--click (label)
  "Click the final letter of LABEL via its actual widget mouse binding."
  (let* ((pos (save-excursion (goto-char (point-min)) (1- (search-forward label))))
         (command (key-binding [down-mouse-1] nil nil pos))
         (where (list (selected-window) pos '(0 . 0) 0))
         (unread-command-events (list (list 'mouse-1 where))))
    (funcall command (list 'down-mouse-1 where))))

(ert-deftest pi-deck-group-editor-test-create-from-terminal-rows ()
  (pi-deck-group-editor-test--with-spaces
    (select-window (split-window-right))
    (let* ((origin (selected-window)) (layout (window-tree))
           (form (pi-deck-new-group)))
      (should (window-parameter (selected-window) 'window-side))
      (insert "Lace")
      (pi-deck-group-editor-test--click "sn")
      (pi-deck-group-editor-test--click "devices  (Environment)")
      (should (equal (plist-get (pi-deck-space "devices") :group) "Environment"))
      (pi-deck-group-editor-test--click "Create (2)")
      (should-not (buffer-live-p form))
      (should (eq origin (selected-window)))
      (should (equal layout (window-tree)))
      (should (equal (mapcar (lambda (s) (plist-get s :group)) pi-deck-spaces)
                     '("Environment" "Lace" "Lace"))))))

(ert-deftest pi-deck-group-editor-test-keyboard-and-cancel ()
  (pi-deck-group-editor-test--with-spaces
    (let* ((origin (selected-window)) (before (copy-tree pi-deck-spaces))
           (form (pi-deck-edit-group "Environment")))
      (widget-forward 1 t)
      (execute-kbd-macro (kbd "RET"))
      (should (equal (pi-deck-group-editor--selection) '("devices")))
      (call-interactively (key-binding (kbd "C-g")))
      (should-not (buffer-live-p form))
      (should (eq origin (selected-window)))
      (should (equal pi-deck-spaces before)))))

(ert-deftest pi-deck-group-editor-test-save-rename-and-membership-atomically ()
  (pi-deck-group-editor-test--with-spaces
    (let ((updates 0))
      (pi-deck-edit-group "Environment")
      (widget-value-set pi-deck-group-editor--name "Tools")
      (widget-setup)
      (pi-deck-group-editor-test--click "pi")
      (pi-deck-group-editor-test--click "sn")
      (cl-letf (((symbol-function 'pi-deck--schedule-update) (lambda () (cl-incf updates))))
        (pi-deck-group-editor-test--click "Save (2)"))
      (should (= updates 1))
      (should (equal (mapcar (lambda (s) (plist-get s :group)) pi-deck-spaces)
                     '(nil "Tools" "Tools"))))))

(ert-deftest pi-deck-group-editor-test-invalid-create-and-dissolve ()
  (pi-deck-group-editor-test--with-spaces
    (let ((before (copy-tree pi-deck-spaces)) (form (pi-deck-new-group)))
      (insert "Environment")
      (should-error (pi-deck-group-editor-test--click "Create (0)") :type 'user-error)
      (pi-deck-group-editor-test--click "sn")
      (should-error (pi-deck-group-editor-test--click "Create (1)") :type 'user-error)
      (should (equal pi-deck-spaces before))
      (should (eq form (current-buffer)))
      (pi-deck-group-editor-test--click "Cancel"))
    (pi-deck-edit-group "Environment")
    (pi-deck-group-editor-test--click "Dissolve group")
    (should (equal (pi-deck-space-names) '("pi" "devices" "sn")))
    (should (equal (mapcar (lambda (s) (plist-get s :group)) pi-deck-spaces)
                   '(nil nil nil)))))

(ert-deftest pi-deck-group-editor-test-stale-checklist-refuses-save-and-dissolve ()
  (pi-deck-group-editor-test--with-spaces
    (let ((form (pi-deck-edit-group "Environment")))
      (pi-deck-set-space-group "Lace" '("devices"))
      (dolist (action '("Save (2)" "Dissolve group"))
        (should-error (pi-deck-group-editor-test--click action) :type 'user-error)
        (should (eq form (current-buffer)))
        (should (equal (mapcar (lambda (s) (plist-get s :group)) pi-deck-spaces)
                       '("Environment" "Lace" nil)))))))

(ert-deftest pi-deck-group-editor-test-disable-clears-forms-from-all-frame-tabs ()
  (pi-deck-test--with-deck
    (pi-deck--register-space "sn" dir)
    ;; The same test also runs in a real multi-frame editor when not in batch.
    (let ((other-frame (and (not noninteractive) (make-frame)))
          (foreign (generate-new-buffer "*unrelated tools*")) forms)
      (unwind-protect
          (progn
            (display-buffer-in-side-window foreign '((side . left)))
            (push (pi-deck-new-group) forms)
            (tab-bar-new-tab)
            (push (pi-deck-new-group) forms)
            (when other-frame
              (with-selected-frame other-frame (push (pi-deck-new-group) forms)))
            (pi-deck-mode -1)
            (should-not (seq-some #'buffer-live-p forms))
            (should (eq 'current-tab (car (nth 1 (tab-bar-tabs)))))
            (dolist (frame (delq nil (list (selected-frame) other-frame)))
              (with-selected-frame frame
                (dotimes (i (length (tab-bar-tabs)))
                  (pi-deck--select-tab (1+ i))
                  (dolist (win (window-list nil 'no-minibuf))
                    (when (window-parameter win 'window-side)
                      (should (eq (window-buffer win) foreign)))))))
            (pi-deck--select-tab 1)
            (should (get-buffer-window foreign)))
        (when other-frame (delete-frame other-frame))
        (when (buffer-live-p foreign) (kill-buffer foreign))))))

(provide 'pi-deck-group-editor-test)
;;; pi-deck-group-editor-test.el ends here
