;;; pi-deck-auto-clear-test.el --- Scoped auto-clear of finished children -*- lexical-binding: t; -*-

;; SPDX-License-Identifier: MIT

(require 'pi-deck-finished-test)

(defmacro pi-deck-auto-clear-test--with-state (&rest body)
  "Run BODY in the finished-entry fixture with default auto-clear settings."
  (declare (indent 0))
  `(let ((pi-deck-auto-clear-finished nil)
         (pi-deck--group-auto-clear nil)
         (pi-deck--auto-clear-settled nil))
     (pi-deck-finished-test--with-state
       (let ((pi-deck-preferences-file (expand-file-name "preferences.eld" directory)))
         ,@body))))

(defun pi-deck-auto-clear-test--item (menu label)
  "Return the :button of MENU's item LABEL."
  (catch 'found
    (map-keymap (lambda (_key binding)
                  (when (equal (nth 1 binding) label)
                    (throw 'found (plist-get (nthcdr 3 binding) :button))))
                menu)
    (ert-fail (format "No menu item %s" label))))

(ert-deftest pi-deck-auto-clear-resolves-space-then-group-then-default ()
  (pi-deck-auto-clear-test--with-state
    (setq pi-deck-spaces (list (list :name "sn" :dir directory :group "Lace")
                               (list :name "pi" :dir directory)))
    (should-not (pi-deck-auto-clear-p "sn"))
    (pi-deck-toggle-auto-clear-finished)
    (should (pi-deck-auto-clear-p "sn"))
    (should (pi-deck-auto-clear-p "pi"))
    (should (pi-deck-auto-clear-p nil))
    (pi-deck-set-group-auto-clear "Lace" 'off)
    (should-not (pi-deck-auto-clear-p "sn"))
    (should (pi-deck-auto-clear-p "pi"))
    (pi-deck-set-space-auto-clear "sn" 'on)
    (should (pi-deck-auto-clear-p "sn"))
    (should-not (pi-deck-auto-clear-inherited "sn"))
    ;; Menus show the override as a radio choice and the inherited value.
    (let ((space (pi-deck-space-menu "sn"))
          (group (pi-deck-group-menu "Lace")))
      (should (equal (pi-deck-auto-clear-test--item space "Auto-clear finished: on") '(:radio . t)))
      (should (equal (pi-deck-auto-clear-test--item space "Auto-clear finished: inherit (off)")
                     '(:radio . nil)))
      (should (equal (pi-deck-auto-clear-test--item group "Auto-clear finished: off") '(:radio . t)))
      (should (pi-deck-auto-clear-test--item group "Auto-clear finished: inherit (on)")))
    (should (equal (pi-deck-auto-clear-test--item
                    (pi-deck-summary-menu) "Auto-clear finished workers and shells by default")
                   '(:toggle . t)))
    (should (eq (lookup-key pi-deck-sidebar--summary-map [header-line mouse-3])
                #'pi-deck-sidebar-summary-menu))
    ;; The default is a saved preference.
    (setq pi-deck-auto-clear-finished nil)
    (pi-deck-load-preferences)
    (should (eq pi-deck-auto-clear-finished t))))

(ert-deftest pi-deck-auto-clear-group-override-follows-rename-and-persists ()
  (pi-deck-auto-clear-test--with-state
    (setq pi-deck-spaces (list (list :name "sn" :dir directory :group "Lace")
                               (list :name "pi" :dir directory :group "Env")))
    (pi-deck-set-group-auto-clear "Lace" 'on)
    (pi-deck-set-group-auto-clear "Env" 'off)
    (pi-deck-set-space-auto-clear "pi" 'on)
    (pi-deck-rename-group "Lace" "Games")
    (should (equal pi-deck--group-auto-clear '(("Env" . off) ("Games" . on))))
    (should (pi-deck-auto-clear-p "sn"))
    (pi-deck--save-now)
    (setq pi-deck-spaces nil pi-deck--group-auto-clear nil)
    (pi-deck-restore-state)
    (should (equal (plist-get (pi-deck-space "pi") :auto-clear) 'on))
    (should-not (plist-get (pi-deck-space "sn") :auto-clear))
    (should (equal (sort (copy-sequence pi-deck--group-auto-clear)
                         :key #'car :lessp #'string<)
                   '(("Env" . off) ("Games" . on))))
    ;; Dissolving drops the group's override; the space keeps its own.
    (pi-deck-dissolve-group "Env")
    (should (equal pi-deck--group-auto-clear '(("Games" . on))))
    (should (equal (plist-get (pi-deck-space "pi") :auto-clear) 'on))))

(ert-deftest pi-deck-auto-clear-runs-when-the-parent-run-is-seen ()
  (pi-deck-auto-clear-test--with-state
    (setq pi-deck-spaces (list (list :name "one" :dir directory :group "G")))
    (pi-deck-set-group-auto-clear "G" 'on)
    (let* ((parent (pi-deck-finished-test--agent "parent" 'pi))
           (buffer (pi-deck-agent-buffer parent))
           (panel (pi-deck-finished-test--agent "exited-panel" 'shell))
           (server (pi-deck-finished-test--agent "live-panel" 'shell t))
           (loose (pi-deck-finished-test--agent "unparented" 'shell))
           (other (generate-new-buffer " *other-parent*"))
           (kept (list :parent other :name "kept")))
      (push other pi-deck-finished-test--buffers)
      (setf (pi-deck-agent-assigned-space parent) "one"
            (pi-deck-agent-state parent) 'working
            (pi-deck-agent-parent panel) buffer
            (pi-deck-agent-parent server) buffer)
      (setq pi-deck--finished-workers (list (list :parent buffer :name "worker") kept))
      (pi-deck-auto-clear-check)
      ;; The run ends unseen: its results are not used yet.
      (setf (pi-deck-agent-state parent) 'idle (pi-deck-agent-seen parent) nil)
      (pi-deck-auto-clear-check)
      (should (= (length pi-deck--finished-workers) 2))
      (should (buffer-live-p (pi-deck-agent-buffer panel)))
      (setf (pi-deck-agent-seen parent) t)
      (pi-deck-auto-clear-check)
      (should (equal pi-deck--finished-workers (list kept)))
      (should-not (buffer-live-p (pi-deck-agent-buffer panel)))
      (should (equal (pi-deck-agents) (list parent server loose)))
      (should (process-live-p (pi-deck-agent-process server))))))

(ert-deftest pi-deck-auto-clear-needs-a-seen-transition-and-the-setting ()
  (pi-deck-auto-clear-test--with-state
    (setq pi-deck-spaces (list (list :name "one" :dir directory :group "G" :auto-clear 'off)))
    (pi-deck-set-group-auto-clear "G" 'on)
    (let* ((parent (pi-deck-finished-test--agent "restored-parent" 'pi))
           (buffer (pi-deck-agent-buffer parent))
           (panel (pi-deck-finished-test--agent "restored-panel" 'shell)))
      (setf (pi-deck-agent-assigned-space parent) "one"
            (pi-deck-agent-parent panel) buffer)
      (setq pi-deck--finished-workers (list (list :parent buffer :name "worker")))
      ;; An agent the check meets already idle (restored, new) is left alone.
      (pi-deck-set-space-auto-clear "one" nil)
      (pi-deck-auto-clear-check)
      (should pi-deck--finished-workers)
      (should (buffer-live-p (pi-deck-agent-buffer panel)))
      ;; The space's own Off beats its group's On.
      (pi-deck-set-space-auto-clear "one" 'off)
      (setf (pi-deck-agent-state parent) 'working)
      (pi-deck-auto-clear-check)
      (setf (pi-deck-agent-state parent) 'idle)
      (pi-deck-auto-clear-check)
      (should pi-deck--finished-workers)
      (should (buffer-live-p (pi-deck-agent-buffer panel))))))

(provide 'pi-deck-auto-clear-test)
;;; pi-deck-auto-clear-test.el ends here
