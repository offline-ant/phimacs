;;; pi-deck-clear-immediately-test.el --- Immediate clearing of finished children -*- lexical-binding: t; -*-

;; SPDX-License-Identifier: MIT

(require 'pi-deck-finished-test)

(defmacro pi-deck-clear-immediately-test--with-state (&rest body)
  "Run BODY in the finished-entry fixture with nothing cleared immediately."
  (declare (indent 0))
  `(let ((pi-deck-clear-finished-immediately nil)
         (pi-deck--group-clear-finished nil)
         (pi-deck--clear-held nil))
     (pi-deck-finished-test--with-state
       (let ((pi-deck-preferences-file (expand-file-name "preferences.eld" directory)))
         ,@body))))

(defconst pi-deck-clear-immediately-test--label
  "Clear finished workers and shells immediately")

(defun pi-deck-clear-immediately-test--binding (menu label)
  "Return MENU's menu-item binding LABEL."
  (catch 'found
    (map-keymap (lambda (_key binding)
                  (when (equal (nth 1 binding) label) (throw 'found binding)))
                menu)
    (ert-fail (format "No menu item %s" label))))

(defun pi-deck-clear-immediately-test--button (menu label)
  "Return the :button of MENU's item LABEL."
  (plist-get (nthcdr 3 (pi-deck-clear-immediately-test--binding menu label)) :button))

(defun pi-deck-clear-immediately-test--choose (menu label)
  "Run MENU's item LABEL."
  (funcall (nth 2 (pi-deck-clear-immediately-test--binding menu label))))

(defun pi-deck-clear-immediately-test--worker (parent directory)
  "Track a closing worker of PARENT with a session file in DIRECTORY."
  (let ((worker (pi-deck-finished-test--agent "worker" 'pi))
        (file (expand-file-name "worker.jsonl" directory)))
    (with-temp-file file (insert "transcript\n"))
    (setf (pi-deck-agent-parent worker) (pi-deck-agent-buffer parent)
          (pi-deck-agent-target worker) "worker")
    (cl-letf (((symbol-function 'pi-deck-agent-session-file) (lambda (_) file))
              ((symbol-function 'pi-deck-agent-runtime) (lambda (_) nil))
              ((symbol-function 'pi-deck-agent-name) (lambda (_) "worker"))
              ((symbol-function 'pi-deck-agent-directory) (lambda (_) directory))
              ((symbol-function 'pi-deck--remove-views) #'ignore))
      (kill-buffer (pi-deck-agent-buffer worker)))))

(ert-deftest pi-deck-clear-immediately-resolves-any-level-from-menus ()
  (pi-deck-clear-immediately-test--with-state
    (setq pi-deck-spaces (list (list :name "sn" :dir directory :group "Lace")
                               (list :name "pi" :dir directory)))
    (should-not (pi-deck-clear-finished-p "sn"))
    (should-not (pi-deck-clear-finished-p nil))
    (let ((label pi-deck-clear-immediately-test--label))
      ;; Each level is one checkbox, unchecked by default.
      (should (equal (pi-deck-clear-immediately-test--button (pi-deck-space-menu "sn") label)
                     '(:toggle . nil)))
      (should (equal (pi-deck-clear-immediately-test--button (pi-deck-group-menu "Lace") label)
                     '(:toggle . nil)))
      (pi-deck-clear-immediately-test--choose (pi-deck-group-menu "Lace") label)
      (should (equal pi-deck--group-clear-finished '("Lace")))
      (should (pi-deck-clear-finished-p "sn"))
      (should-not (pi-deck-clear-finished-p "pi"))
      (should (equal (pi-deck-clear-immediately-test--button (pi-deck-group-menu "Lace") label)
                     '(:toggle . t)))
      (pi-deck-clear-immediately-test--choose (pi-deck-space-menu "pi") label)
      (should (eq (plist-get (pi-deck-space "pi") :clear-finished) t))
      (should (pi-deck-clear-finished-p "pi"))
      (should (equal (pi-deck-clear-immediately-test--button (pi-deck-space-menu "pi") label)
                     '(:toggle . t)))
      ;; An unchecked space still clears when its group does.
      (pi-deck-set-space-clear-finished "sn" nil)
      (should (pi-deck-clear-finished-p "sn"))
      (pi-deck-set-group-clear-finished "Lace" nil)
      (should-not (pi-deck-clear-finished-p "sn")))
    (let ((label "Clear finished workers and shells immediately in all spaces"))
      (should (equal (pi-deck-clear-immediately-test--button (pi-deck-summary-menu) label)
                     '(:toggle . nil)))
      (pi-deck-clear-immediately-test--choose (pi-deck-summary-menu) label)
      (should (pi-deck-clear-finished-p "sn"))
      (should (pi-deck-clear-finished-p nil))
      (should (equal (pi-deck-clear-immediately-test--button (pi-deck-summary-menu) label)
                     '(:toggle . t))))
    (should (eq (lookup-key pi-deck-sidebar--summary-map [header-line mouse-3])
                #'pi-deck-sidebar-summary-menu))
    ;; The global setting is a saved preference.
    (setq pi-deck-clear-finished-immediately nil)
    (pi-deck-load-preferences)
    (should (eq pi-deck-clear-finished-immediately t))))

(ert-deftest pi-deck-clear-immediately-group-flag-follows-rename-and-persists ()
  (pi-deck-clear-immediately-test--with-state
    (setq pi-deck-spaces (list (list :name "sn" :dir directory :group "Lace")
                               (list :name "pi" :dir directory :group "Env")
                               (list :name "dev" :dir directory :group "Env")))
    (pi-deck-set-group-clear-finished "Lace" t)
    (pi-deck-set-group-clear-finished "Env" t)
    (pi-deck-set-space-clear-finished "pi" t)
    (pi-deck-rename-group "Lace" "Games")
    (should (equal (sort (copy-sequence pi-deck--group-clear-finished) #'string<)
                   '("Env" "Games")))
    (should (pi-deck-clear-finished-p "sn"))
    (pi-deck--save-now)
    (setq pi-deck-spaces nil pi-deck--group-clear-finished nil)
    (pi-deck-restore-state)
    (should (eq (plist-get (pi-deck-space "pi") :clear-finished) t))
    (should-not (plist-get (pi-deck-space "sn") :clear-finished))
    (should (equal (sort (copy-sequence pi-deck--group-clear-finished) #'string<)
                   '("Env" "Games")))
    ;; Dissolving drops the group's flag; the space keeps its own.
    (pi-deck-dissolve-group "Env")
    (should (equal pi-deck--group-clear-finished '("Games")))
    (should (pi-deck-clear-finished-p "pi"))
    (should-not (pi-deck-clear-finished-p "dev"))))

(ert-deftest pi-deck-clear-immediately-default-keeps-finished-children ()
  (pi-deck-clear-immediately-test--with-state
    (setq pi-deck-spaces (list (list :name "one" :dir directory)))
    (let* ((parent (pi-deck-finished-test--agent "parent" 'pi))
           (panel (pi-deck-finished-test--agent "exited-panel" 'shell)))
      (setf (pi-deck-agent-assigned-space parent) "one"
            (pi-deck-agent-parent panel) (pi-deck-agent-buffer parent))
      (pi-deck-clear-immediately-test--worker parent directory)
      (pi-deck-clear-finished-shells)
      (should (= (length (pi-deck-finished-workers (pi-deck-agent-buffer parent))) 1))
      (should (buffer-live-p (pi-deck-agent-buffer panel))))))

(ert-deftest pi-deck-clear-immediately-skips-worker-records-and-closes-agent-panels ()
  (pi-deck-clear-immediately-test--with-state
    (setq pi-deck-spaces (list (list :name "one" :dir directory :group "G")
                               (list :name "two" :dir directory)))
    (pi-deck-set-group-clear-finished "G" t)
    (let* ((parent (pi-deck-finished-test--agent "parent" 'pi))
           (buffer (pi-deck-agent-buffer parent))
           (other (pi-deck-finished-test--agent "other-parent" 'pi))
           (panel (pi-deck-finished-test--agent "exited-panel" 'shell))
           (running (pi-deck-finished-test--agent "live-panel" 'shell t))
           (kept (pi-deck-finished-test--agent "other-space-panel" 'shell))
           (user (pi-deck-finished-test--agent "user-shell" 'shell)))
      (setf (pi-deck-agent-assigned-space parent) "one"
            (pi-deck-agent-assigned-space other) "two"
            (pi-deck-agent-assigned-space user) "one"
            (pi-deck-agent-parent panel) buffer
            (pi-deck-agent-parent running) buffer
            (pi-deck-agent-parent kept) (pi-deck-agent-buffer other))
      ;; A worker closing under a clearing parent leaves no record.
      (pi-deck-clear-immediately-test--worker parent directory)
      (should-not pi-deck--finished-workers)
      (pi-deck-clear-immediately-test--worker other directory)
      (should (pi-deck-finished-workers (pi-deck-agent-buffer other)))
      ;; Only the clearing parent's exited panel closes; live panels, other
      ;; spaces' children and shells the user opened stay.
      (pi-deck-clear-finished-shells)
      (should-not (buffer-live-p (pi-deck-agent-buffer panel)))
      (should (equal (pi-deck-agents) (list parent other running kept user)))
      (should (process-live-p (pi-deck-agent-process running)))
      (delete-process (pi-deck-agent-process running))
      (pi-deck-clear-finished-shells)
      (should-not (buffer-live-p (pi-deck-agent-buffer running)))
      (should (buffer-live-p (pi-deck-agent-buffer user))))))

(ert-deftest pi-deck-clear-immediately-closes-a-managed-panel-exiting-at-its-prompt ()
  (pi-deck-clear-immediately-test--with-state
    (setq pi-deck-clear-finished-immediately t)
    (let* ((parent (pi-deck-finished-test--agent "parent" 'pi))
           ;; The persistent wrapper stays live after the command ends.
           (panel (pi-deck-finished-test--agent "managed-panel" 'shell t))
           (buffer (pi-deck-agent-buffer panel))
           (command "running")
           stopped)
      (setf (pi-deck-agent-parent panel) (pi-deck-agent-buffer parent)
            (pi-deck-agent-target panel) "panel")
      (with-current-buffer buffer
        (setq major-mode 'ghostel-mode
              pi-deck--shell-phase 'prompt))
      (cl-letf (((symbol-function 'pi-orchestration-panel-command-state)
                 (lambda (panel-buffer) (and (eq panel-buffer buffer) command)))
                ((symbol-function 'pi-orchestration-stop-target)
                 (lambda (id &optional callback)
                   (push id stopped)
                   (funcall callback nil))))
        (pi-deck-refresh)
        (should (eq (pi-deck-agent-state panel) 'idle))
        (should-not pi-deck--update-timer)
        ;; Idle at its prompt before and after: only the command's end changes.
        (setq command "exited")
        (pi-deck-refresh)
        (should (eq (pi-deck-agent-state panel) 'idle))
        (should (timerp pi-deck--update-timer))
        ;; What the scheduled `pi-deck-update-hook' run does.
        (pi-deck-clear-finished-shells))
      (should (equal stopped '("panel")))
      (should-not (buffer-live-p buffer)))))

(ert-deftest pi-deck-clear-immediately-reports-a-failed-close-once ()
  (pi-deck-clear-immediately-test--with-state
    (setq pi-deck-clear-finished-immediately t)
    (let* ((parent (pi-deck-finished-test--agent "parent" 'pi))
           (bad (pi-deck-finished-test--agent "unavailable-panel" 'shell))
           calls reports)
      (setf (pi-deck-agent-parent bad) (pi-deck-agent-buffer parent)
            (pi-deck-agent-target bad) "unavailable")
      (cl-letf (((symbol-function 'pi-orchestration-stop-target)
                 (lambda (id &optional callback)
                   (push id calls)
                   (funcall callback "Synthetic owner unavailable")))
                ((symbol-function 'message)
                 (lambda (format &rest arguments)
                   (push (apply #'format format arguments) reports))))
        (pi-deck-clear-finished-shells)
        (pi-deck-clear-finished-shells))
      (should (equal calls '("unavailable")))
      (should (eq (pi-deck-agent (pi-deck-agent-buffer bad)) bad))
      (should (equal pi-deck--clear-held (list (pi-deck-agent-buffer bad))))
      (should (cl-some (lambda (report)
                         (string-match-p "clearing finished shells failed:.*Synthetic owner unavailable"
                                         report))
                       reports)))))

(provide 'pi-deck-clear-immediately-test)
;;; pi-deck-clear-immediately-test.el ends here
