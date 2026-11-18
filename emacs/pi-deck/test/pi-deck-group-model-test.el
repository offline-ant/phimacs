;;; pi-deck-group-model-test.el --- Space group membership and desktop state -*- lexical-binding: t; -*-

;; SPDX-License-Identifier: MIT

;;; Code:

(require 'pi-deck-test-fixtures)

(ert-deftest pi-deck-group-model-move-and-ungroup-without-switching ()
  (pi-deck-test--with-deck
    (dolist (name '("pi" "devices" "sn")) (pi-deck--register-space name dir))
    (pi-deck-select-space "pi")
    (let ((updates 0) (pane (selected-window)) (buffer (current-buffer)))
      (cl-letf (((symbol-function 'pi-deck--schedule-update) (lambda () (cl-incf updates))))
        (should (pi-deck-set-space-group " Environment " '("devices" "pi")))
        (should-not (pi-deck-set-space-group "Environment" '("pi")))
        (should (pi-deck-set-space-group "Lace" '("sn" "devices")))
        (should (pi-deck-set-space-group nil '("pi")))
        (should (= updates 3)))
      (should (equal (pi-deck-space-names) '("pi" "devices" "sn")))
      (should (equal (mapcar (lambda (s) (plist-get s :group)) pi-deck-spaces)
                     '(nil "Lace" "Lace")))
      (should (equal (pi-deck-current-space) "pi"))
      (should (eq (selected-window) pane))
      (should (eq (current-buffer) buffer)))))

(ert-deftest pi-deck-group-model-edit-replaces-original-membership ()
  (pi-deck-test--with-deck
    (dolist (n '("sn" "supaplex" "pi" "devices")) (pi-deck--register-space n dir))
    (pi-deck-set-space-group "Lace" '("sn" "supaplex"))
    (pi-deck-set-space-group "Environment" '("pi" "devices"))
    (pi-deck-set-space-group "Release" '("supaplex" "pi") "Lace")
    (should (equal (mapcar (lambda (s) (plist-get s :group)) pi-deck-spaces)
                   '(nil "Release" "Release" "Environment")))))

(ert-deftest pi-deck-group-model-invalid-selection-is-atomic ()
  (let ((pi-deck-spaces (list (list :name "sn" :dir nil :group "Lace"))))
    (dolist (invalid '("" "  " "a\nb" "a\tb" 4))
      (should-error (pi-deck-set-space-group invalid '("sn")) :type 'user-error))
    (should-error (pi-deck-set-space-group "Other" nil) :type 'user-error)
    (should-error (pi-deck-set-space-group "Other" '("sn" "missing")) :type 'user-error)
    (should (equal (plist-get (pi-deck-space "sn") :group) "Lace"))))

(ert-deftest pi-deck-group-model-renamed-member-persists-through-autosave-and-restore ()
  (pi-deck-test--with-deck
    (pi-deck--register-space "pi" dir)
    (pi-deck--register-space "sn" dir)
    (pi-deck-select-space "sn")
    (pi-deck-set-space-group "Environment" '("sn"))
    (pi-deck--register-space "sn" dir)
    (pi-deck-rename-space "supaplex")
    (should (equal (plist-get (pi-deck-space "supaplex") :group) "Environment"))
    ;; Establish a saved baseline.  Only membership changes from this point.
    (pi-deck--save-on-structure-change)
    (pi-deck-save-state)
    (let ((pi-deck-save-delay 0.01))
      (pi-deck-set-space-group "Lace" '("supaplex"))
      (should (pi-deck-test--wait
               (lambda ()
                 (equal "Lace" (plist-get (cadr (plist-get (pi-deck-read-state) :spaces)) :group))))))
    (setq pi-deck-spaces nil)
    (pi-deck-restore-state)
    (should (equal (pi-deck-space-names) '("pi" "supaplex")))
    (should (equal (plist-get (pi-deck-space "supaplex") :group) "Lace"))
    (should-not (plist-get (pi-deck-space "pi") :group))))

(ert-deftest pi-deck-group-model-restore-plain-schema-3-space ()
  (pi-deck-test--with-deck
    (with-temp-file pi-deck-state-file
      (prin1 (list :version 3 :spaces (list (list :name "pi" :dir dir))) (current-buffer)))
    (pi-deck-restore-state)
    (should (equal (pi-deck-space-names) '("pi")))
    (should-not (plist-get (pi-deck-space "pi") :group))))

(provide 'pi-deck-group-model-test)
;;; pi-deck-group-model-test.el ends here
