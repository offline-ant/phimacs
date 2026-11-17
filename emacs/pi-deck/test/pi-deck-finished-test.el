;;; pi-deck-finished-test.el --- Finished entry cleanup regressions -*- lexical-binding: t; -*-

;; SPDX-License-Identifier: MIT

(require 'ert)
(require 'pi-deck)
(require 'pi-deck-finished)

(defvar pi-deck-finished-test--buffers nil)

(defun pi-deck-finished-test--agent (name kind &optional live)
  "Track an isolated buffer NAME of KIND, optionally with a LIVE pipe."
  (let* ((buffer (generate-new-buffer (format " *deck-finished:%s*" name)))
         (agent (pi-deck-agent--make :buffer buffer :kind kind :state 'idle)))
    (push buffer pi-deck-finished-test--buffers)
    (when live
      (make-pipe-process :name name :buffer buffer :noquery t))
    (puthash buffer agent pi-deck--agents)
    agent))

(defmacro pi-deck-finished-test--with-state (&rest body)
  "Run BODY with isolated buffers, registry, persistence and update jobs."
  (declare (indent 0))
  `(let* ((directory (make-temp-file "deck-finished-test-" t))
          (pi-deck-finished-test--buffers nil)
          (pi-deck--agents (make-hash-table :test 'eq))
          (pi-deck--finished-workers nil)
          (pi-deck--layouts nil)
          (pi-deck-spaces nil)
          (pi-deck--last-space nil)
          (pi-deck--update-timer nil)
          (pi-deck--save-timer nil)
          (pi-deck--last-saved nil)
          (pi-deck--state-owner "/synthetic/finished-test")
          (pi-deck--state-backup-pending nil)
          (pi-deck--restoring nil)
          (pi-deck--restore-failures nil)
          (pi-deck-save-delay nil)
          (pi-deck-state-file (expand-file-name "state.eld" directory))
          (kill-buffer-query-functions nil)
          (kill-buffer-hook (list #'pi-deck--on-kill-buffer)))
     (cl-letf (((symbol-function 'pi-deck--client-frames) (lambda () nil)))
       (unwind-protect (progn ,@body)
         (dolist (buffer pi-deck-finished-test--buffers)
           (when (buffer-live-p buffer)
             (when-let* ((process (get-buffer-process buffer))) (delete-process process))
             (kill-buffer buffer)))
         (dolist (timer (list pi-deck--update-timer pi-deck--save-timer))
           (when (timerp timer) (cancel-timer timer)))
         (delete-directory directory t)))))

(ert-deftest pi-deck-finished-clears-all-spaces-and-keeps-worker-files ()
  (pi-deck-finished-test--with-state
    (setq pi-deck-spaces (list (list :name "one" :dir directory)
                               (list :name "folded" :dir directory)))
    (let* ((parent (pi-deck-finished-test--agent "parent" 'pi))
           (first (pi-deck-finished-test--agent "first" 'shell))
           (folded (pi-deck-finished-test--agent "folded" 'shell))
           (other (pi-deck-finished-test--agent "other" 'shell))
           (file (expand-file-name "worker.jsonl" directory)))
      (with-temp-file file (insert "retained transcript\n"))
      (setf (pi-deck-agent-assigned-space first) "one"
            (pi-deck-agent-assigned-space folded) "folded")
      (setq pi-deck--finished-workers
            (list (list :name "worker" :parent (pi-deck-agent-buffer parent)
                        :session-file file :time (float-time))))
      (with-temp-buffer
        (setq-local pi-deck-sidebar--collapsed '("one" "folded"))
        (pi-deck-clear-finished))
      (should (equal (pi-deck-agents) (list parent)))
      (dolist (agent (list first folded other))
        (should-not (buffer-live-p (pi-deck-agent-buffer agent))))
      (should-not pi-deck--finished-workers)
      (should (equal "retained transcript\n"
                     (with-temp-buffer (insert-file-contents file) (buffer-string))))
      (should (timerp pi-deck--update-timer)))))

(ert-deftest pi-deck-finished-does-not-close-live-shells-or-any-pi-view ()
  (pi-deck-finished-test--with-state
    (let* ((live (pi-deck-finished-test--agent "prompt" 'shell t))
           (working (pi-deck-finished-test--agent "working-shell" 'shell t))
           (done (pi-deck-finished-test--agent "done-chat" 'pi))
           (waiting (pi-deck-finished-test--agent "waiting-worker" 'pi))
           (disconnected (pi-deck-finished-test--agent "disconnected" 'pi))
           (stopped (pi-deck-finished-test--agent "stopped-chat" 'pi))
           (finished (pi-deck-finished-test--agent "exited-parent" 'shell)))
      (setf (pi-deck-agent-state working) 'working
            (pi-deck-agent-seen done) nil
            (pi-deck-agent-state waiting) 'blocked
            (pi-deck-agent-target waiting) "waiting-worker"
            (pi-deck-agent-placement waiting) "worker"
            (pi-deck-agent-parent waiting) (pi-deck-agent-buffer finished)
            (pi-deck-agent-state disconnected) 'unknown)
      (cl-letf (((symbol-function 'pilish-stop-runtime)
                 (lambda (&rest _) (ert-fail "Pi runtimes must not be stopped")))
                ((symbol-function 'pi-orchestration-stop-target)
                 (lambda (&rest _) (ert-fail "Live workers must not be cancelled"))))
        (pi-deck-clear-finished))
      (dolist (agent (list live working done waiting disconnected stopped))
        (should (eq (pi-deck-agent (pi-deck-agent-buffer agent)) agent))
        (should (buffer-live-p (pi-deck-agent-buffer agent))))
      (should (process-live-p (pi-deck-agent-process live)))
      (should (process-live-p (pi-deck-agent-process working)))
      (should-not (buffer-live-p (pi-deck-agent-buffer finished))))))

(ert-deftest pi-deck-finished-owner-failure-keeps-entry-and-clears-others ()
  (pi-deck-finished-test--with-state
    (let* ((bad (pi-deck-finished-test--agent "unavailable-panel" 'shell))
           (good (pi-deck-finished-test--agent "owned-panel" 'shell))
           (ordinary (pi-deck-finished-test--agent "ordinary" 'shell))
           calls report)
      (setf (pi-deck-agent-target bad) "unavailable"
            (pi-deck-agent-target good) "owned")
      (cl-letf (((symbol-function 'pi-orchestration-stop-target)
                 (lambda (id &optional callback)
                   (push id calls)
                   (if (equal id "unavailable")
                       (funcall callback "Synthetic owner unavailable")
                     (kill-buffer (pi-deck-agent-buffer good))
                     (funcall callback nil))))
                ((symbol-function 'message)
                 (lambda (format &rest arguments)
                   (setq report (apply #'format format arguments)))))
        (pi-deck-clear-finished))
      (should (equal (nreverse calls) '("unavailable" "owned")))
      (should (buffer-live-p (pi-deck-agent-buffer bad)))
      (should (eq (pi-deck-agent (pi-deck-agent-buffer bad)) bad))
      (should-not (buffer-live-p (pi-deck-agent-buffer good)))
      (should-not (buffer-live-p (pi-deck-agent-buffer ordinary)))
      (should (string-match-p "2 shells; 1 failed:.*Synthetic owner unavailable" report)))))

(ert-deftest pi-deck-finished-rechecks-terminals-after-owner-callbacks ()
  (pi-deck-finished-test--with-state
    (let* ((first (pi-deck-finished-test--agent "owned" 'shell))
           (resumed (pi-deck-finished-test--agent "resumed-during-cleanup" 'shell)))
      (setf (pi-deck-agent-target first) "owned")
      (cl-letf (((symbol-function 'pi-orchestration-stop-target)
                 (lambda (_ &optional callback)
                   (make-pipe-process :name "resumed" :noquery t
                                      :buffer (pi-deck-agent-buffer resumed))
                   (kill-buffer (pi-deck-agent-buffer first))
                   (funcall callback nil))))
        (pi-deck-clear-finished))
      (should-not (buffer-live-p (pi-deck-agent-buffer first)))
      (should (buffer-live-p (pi-deck-agent-buffer resumed)))
      (should (process-live-p (pi-deck-agent-process resumed))))))

(ert-deftest pi-deck-finished-parent-cleanup-keeps-other-records ()
  (pi-deck-finished-test--with-state
    (let* ((one (generate-new-buffer " *finished-parent-one*"))
           (two (generate-new-buffer " *finished-parent-two*"))
           (kept (list :parent two :name "kept")))
      (setq pi-deck-finished-test--buffers (list one two)
            pi-deck--finished-workers (list (list :parent one :name "cleared") kept))
      (pi-deck-clear-finished-workers one)
      (should (equal pi-deck--finished-workers (list kept)))
      (pi-deck-clear-finished-workers)
      (should-not pi-deck--finished-workers))))

(ert-deftest pi-deck-finished-placeholder-does-not-contact-retained-target ()
  (pi-deck-finished-test--with-state
    (let* ((placeholder (pi-deck-finished-test--agent "restored-panel" 'shell))
           (buffer (pi-deck-agent-buffer placeholder)))
      (with-current-buffer buffer
        (pi-deck-stopped-shell-mode)
        (setq pi-deck--stopped-shell (list :dir directory :command '("never-run"))))
      (setf (pi-deck-agent-target placeholder) "retained-old-panel")
      (cl-letf (((symbol-function 'pi-orchestration-stop-target)
                 (lambda (&rest _) (ert-fail "Placeholder must not contact an owner"))))
        (pi-deck-clear-finished))
      (should-not (buffer-live-p buffer))
      (should-not (pi-deck-agents)))))

(ert-deftest pi-deck-finished-keeps-selected-window-and-removes-visible-pane ()
  (pi-deck-finished-test--with-state
    (save-window-excursion
      (let* ((main (selected-window))
             (finished (pi-deck-finished-test--agent "visible-finished" 'shell))
             (pane (split-window main nil 'right)))
        (set-window-buffer pane (pi-deck-agent-buffer finished))
        (cl-letf (((symbol-function 'pi-deck--client-frames)
                   (lambda () (list (selected-frame)))))
          (pi-deck-clear-finished))
        (should (eq (selected-window) main))
        (should-not (window-live-p pane))
        (should-not (buffer-live-p (pi-deck-agent-buffer finished)))))))

(ert-deftest pi-deck-finished-save-excludes-cleared-entries ()
  (pi-deck-finished-test--with-state
    (let* ((parent (generate-new-buffer " *finished-parent*"))
           (file (expand-file-name "kept-worker.jsonl" directory)))
      (push parent pi-deck-finished-test--buffers)
      (with-temp-file file (insert "saved worker\n"))
      (setq pi-deck--finished-workers
            (list (list :parent parent :session-file file :name "worker")))
      (pi-deck-finished-test--agent "saved-finished" 'shell)
      (pi-deck--save-now)
      (should (plist-get (pi-deck-read-state) :finished-workers))
      (should (plist-get (pi-deck-read-state) :agents))
      (pi-deck-clear-finished)
      (pi-deck--save-now)
      (should-not (plist-get (pi-deck-read-state) :finished-workers))
      (should-not (plist-get (pi-deck-read-state) :agents))
      (should (file-readable-p file)))))

(ert-deftest pi-deck-finished-button-activation-and-release-bindings ()
  (pi-deck-finished-test--with-state
    (let* ((inactive (pi-deck-finished-button))
           (map (get-text-property 0 'local-map inactive)))
      (should (equal (substring-no-properties inactive) "[×]"))
      (should (eq (get-text-property 0 'face inactive) 'pi-deck-header-dim))
      (should (eq (lookup-key map [header-line mouse-1]) #'ignore)))
    (setq pi-deck--finished-workers (list (list :name "finished")))
    (let* ((active (pi-deck-finished-button))
           (map (get-text-property 0 'local-map active)))
      (should (eq (get-text-property 0 'face active) 'header-line-highlight))
      (should (eq (lookup-key map [header-line down-mouse-1]) #'ignore))
      (should (eq (lookup-key map [header-line mouse-1]) #'pi-deck-clear-finished)))
    (setq pi-deck--finished-workers nil)
    (pi-deck-finished-test--agent "finished" 'shell)
    (should (eq (get-text-property 0 'face (pi-deck-finished-button)) 'header-line-highlight))))

(provide 'pi-deck-finished-test)
;;; pi-deck-finished-test.el ends here
