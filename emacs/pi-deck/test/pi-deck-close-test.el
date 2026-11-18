;;; pi-deck-close-test.el --- Close tests -*- lexical-binding: t; -*-

;; SPDX-License-Identifier: MIT

;;; Commentary:

;; Closing agents and spaces without confirmation, with runtime acknowledgement.
;; Fixtures: pi-deck-test-fixtures.el.

;;; Code:

(require 'pi-deck-test-fixtures)

;;;; Closing

(defmacro pi-deck-test--without-confirmation (&rest body)
  "Run BODY, failing if a keyboard or mouse confirmation is requested."
  (declare (indent 0))
  `(cl-letf (((symbol-function 'y-or-n-p)
              (lambda (&rest _) (ert-fail "Close requested keyboard confirmation")))
             ((symbol-function 'yes-or-no-p)
              (lambda (&rest _) (ert-fail "Close requested keyboard confirmation")))
             ((symbol-function 'x-popup-dialog)
              (lambda (&rest _) (ert-fail "Close requested mouse confirmation"))))
     ,@body))

(ert-deftest pi-deck-test-close-busy-agent-removes-views-everywhere-without-confirmation ()
  (pi-deck-test--with-large-frame
   (pi-deck-test--with-deck
    (let ((two (make-temp-file "pi-deck-two-" t)))
      (pi-deck-create-space two "two")
      (pi-deck-create-space dir "space")
      (let* ((a (pi-deck-test--session dir "a"))
             (worker (pi-deck-test--session dir "w"))
             (fork (pi-deck-test--session dir "fork"))
             (c (pi-deck-test--session dir "c")))
        (setf (pi-deck-agent-parent (pi-deck-agent worker)) a
              (pi-deck-agent-parent (pi-deck-agent fork)) a
              (pi-deck-agent-target (pi-deck-agent fork)) "fork-target"
              (pi-deck-agent-placement (pi-deck-agent fork)) "interactive-fork")
        ;; "space" shows A and C; "two" shows C and the worker.
        (pi-deck--display-agent-in-window (pi-deck-agent a) (selected-window))
        (pi-deck-show-beside (pi-deck-agent c))
        (pi-deck-select-space "two")
        (pi-deck--display-agent-in-window (pi-deck-agent c) (pi-deck--pane-window))
        (pi-deck-show-beside (pi-deck-agent worker))
        (pi-deck-select-space "space")
        ;; Working owned children close with the root; independent forks do not.
        (pi-deck-test--phase worker "thinking")
        (pi-deck-test--without-confirmation
          (pi-deck-close-agent (pi-deck-agent a)))
        (should-not (buffer-live-p a))
        (should-not (buffer-live-p worker))
        (should (buffer-live-p fork))
        (should (pi-deck-agent fork))
        (should (get-buffer-window c))
        (should (= (length (pi-deck-test--main-windows)) 2))
        ;; Idle agents use the same Close; the only pane shows Dired.
        (pi-deck-test--without-confirmation
          (pi-deck-close-agent (pi-deck-agent c)))
        (should-not (buffer-live-p c))
        (should (one-window-p))
        (should (pi-deck-test--in-dired-p))
        ;; The other space's layout lost them too.
        (pi-deck-switch-space "two")
        (should (one-window-p))
        (should (pi-deck-test--in-dired-p))
        (should (= (length (tab-bar-tabs)) 2)))
      (delete-directory two t)))))

(ert-deftest pi-deck-test-close-space-closes-busy-agents-without-confirmation ()
  (pi-deck-test--with-deck
    (pi-deck-create-space dir "space")
    (let ((a (pi-deck-test--session dir "a"))
          (loose (pi-deck-test--session (make-temp-file "pi-deck-loose-" t) "loose")))
      (pi-deck--display-agent-in-window (pi-deck-agent a) (selected-window))
      (pi-deck-test--phase a "thinking")
      (pi-deck-test--without-confirmation (pi-deck-close-space "space"))
      (should-not (pi-deck-space "space"))
      (should-not (buffer-live-p a))
      (should (buffer-live-p loose)))))

(ert-deftest pi-deck-test-close-space-waits-for-shared-runtime-acknowledgement ()
  (pi-deck-test--with-deck
    (pi-deck-create-space dir "space")
    (let* ((chat (pi-deck-test--session dir "shared"))
           (agent (pi-deck-agent chat))
           stopped callback)
      (with-current-buffer chat
        (setq pi-deck-test--runtime '(:protocol 2 :mux-id "synthetic-root" :state "committed")))
      (setf (pi-deck-agent-assigned-space agent) "space")
      (pi-deck--display-agent-in-window agent (selected-window))
      (pi-deck--remember-current-layout)
      (cl-letf (((symbol-function 'pilish-stop-runtime)
                 (lambda (buffer &optional done) (setq stopped buffer callback done))))
        (pi-deck-test--without-confirmation (pi-deck-close-space "space")))
      (should (eq stopped chat))
      (should (buffer-live-p chat))
      (should (pi-deck-space "space"))
      ;; The agent is hidden at once; the space waits for its acknowledgement.
      (should (equal (pi-deck-agents t) (list agent)))
      (should-not (pi-deck-agents))
      (funcall callback nil)
      (should-not (buffer-live-p chat))
      (should-not (pi-deck-space "space"))
      (should-not (assoc "space" pi-deck--layouts))
      (should-not (plist-get (pi-deck-state) :agents)))))

(ert-deftest pi-deck-test-close-idle-shared-agent-without-confirmation ()
  (pi-deck-test--with-deck
    (let* ((chat (pi-deck-test--session dir "shared"))
           (agent (pi-deck-agent chat))
           stopped)
      (with-current-buffer chat
        (setq pi-deck-test--runtime '(:protocol 2 :mux-id "synthetic-root" :state "committed")))
      (should (eq (pi-deck-agent-state agent) 'idle))
      (cl-letf (((symbol-function 'pilish-stop-runtime)
                 (lambda (buffer &optional callback)
                   (push buffer stopped)
                   (funcall callback nil))))
        (pi-deck-test--without-confirmation (pi-deck-close-agent agent)))
      (should (equal stopped (list chat)))
      (should-not (buffer-live-p chat))
      (should-not (pi-deck-agent chat)))))

(ert-deftest pi-deck-test-close-hides-at-once-and-lists-failed-agent-again ()
  (pi-deck-test--with-deck
    (pi-deck-create-space dir "space")
    (let* ((chat (pi-deck-test--session dir "shared"))
           (agent (pi-deck-agent chat))
           callback)
      (with-current-buffer chat
        (setq pi-deck-test--runtime '(:protocol 2 :mux-id "synthetic-root" :state "live")))
      (pi-deck--display-agent-in-window agent (selected-window))
      (cl-letf (((symbol-function 'pilish-stop-runtime)
                 (lambda (_buffer &optional done) (setq callback done)))
                ((symbol-function 'message) #'ignore))
        (pi-deck-close-agent agent))
      ;; Dispatched only: the pane and sidebar entry are gone, the buffer stays.
      (should (functionp callback))
      (should-not (get-buffer-window chat))
      (should-not (memq agent (pi-deck-agents)))
      (should (buffer-live-p chat))
      (cl-letf (((symbol-function 'message) #'ignore))
        (funcall callback "Stop outcome uncertain"))
      (should (memq agent (pi-deck-agents)))
      (should (buffer-live-p chat))
      (should-not (get-buffer-window chat)))))

(ert-deftest pi-deck-test-header-close-closes-clicked-agent-without-confirmation ()
  (pi-deck-test--with-deck
    (pi-deck-create-space dir "space")
    (let* ((chat (pi-deck-test--session dir "clicked"))
           (other (pi-deck-test--session dir "other"))
           (agent (pi-deck-agent chat)))
      (pi-deck--display-agent-in-window agent (selected-window))
      (pi-deck-test--phase chat "thinking")
      (pi-deck-test--without-confirmation
        (pi-deck-header-close (pi-deck-test--click (get-buffer-window chat) 1)))
      (should-not (buffer-live-p chat))
      (should-not (pi-deck-agent chat))
      (should (buffer-live-p other))
      (should (pi-deck-agent other)))))

(ert-deftest pi-deck-test-close-and-hide-keybindings ()
  (should (eq (keymap-lookup pi-deck-command-map "X") #'pi-deck-close-agent))
  (should (eq (keymap-lookup pi-deck-command-map "K") #'pi-deck-close-space))
  (should (eq (keymap-lookup pi-deck-command-map "x") #'pi-deck-hide-pane))
  (should (eq (keymap-lookup pi-deck-sidebar-mode-map "K") #'pi-deck-sidebar-close))
  (dolist (binding '(("K" pi-deck-close-space "close")
                     ("X" pi-deck-close-agent "close")
                     ("x" pi-deck-hide-pane "hide pane")))
    (let ((suffix (cdr (transient-get-suffix 'pi-deck-menu (car binding)))))
      (should (eq (plist-get suffix :command) (nth 1 binding)))
      (should (equal (plist-get suffix :description) (nth 2 binding))))))

(ert-deftest pi-deck-test-terminal-view-removal-keeps-owning-task-acknowledgement ()
  "Pilish owns worker Close; terminal view removal never settles it early.
A registered orchestration target does not redirect the Close, and the
closing space is held until Pilish settles every joined Close once."
  (skip-unless (require 'pi-orchestration nil t))
  (let ((pi-orchestration--targets (make-hash-table :test 'equal)))
    (pi-deck-test--with-deck
      (dolist (failure '(nil "Parent cleanup incomplete"))
        (let* ((space (if failure "failed" "closed"))
               (chat (pi-deck-test--session dir space))
               (agent (pi-deck-agent chat))
               (id (concat "task-" space))
               (mux (concat "runtime-" space))
               (runtime (list :protocol 2 :mux-id mux :state "live" :placement "worker"))
               (target (list :kind "pi" :placement "worker" :mux-id mux
                             :buffer chat :runtime runtime :owns-view t))
               (registered (copy-sequence target))
               close-callbacks results)
          (pi-deck--register-space space dir)
          (setf (pi-deck-agent-target agent) id
                (pi-deck-agent-placement agent) "worker"
                (pi-deck-agent-assigned-space agent) space)
          (with-current-buffer chat (setq pi-deck-test--runtime runtime))
          (puthash id target pi-orchestration--targets)
          (cl-letf (((symbol-function 'pilish-close-session)
                     ;; Like Pilish, a concurrent Close joins the pending one.
                     (lambda (buffer &optional callback)
                       (should (eq buffer chat))
                       (push callback close-callbacks)))
                    ((symbol-function 'pilish-stop-runtime)
                     (lambda (&rest _) (ert-fail "Worker Close used root stop")))
                    ((symbol-function 'pi-orchestration-stop-target)
                     (lambda (&rest _)
                       (ert-fail "Worker Close bypassed Pilish task evidence"))))
            (pi-deck-test--without-confirmation
              (pi-deck-stop-agent agent (lambda (error) (push error results)))
              (pi-deck-close-space space))
            (should (= (length close-callbacks) 2))
            (should (cl-every #'functionp close-callbacks))
            (should-not results)
            (should (pi-deck-space space))
            ;; Pi has exited, but its owning task has not completed.  Removing
            ;; active UI must not settle the pending Close or forget the space.
            (with-current-buffer chat
              (setq pi-deck-test--runtime (plist-put runtime :state "stopped")))
            (run-hook-with-args 'pilish-session-closed-functions chat)
            (pi-deck-test--dispose chat)
            (should-not (pi-deck-agent chat))
            (should-not results)
            (should (pi-deck-space space))
            ;; Pilish settles each joined caller; repeating a settlement cannot
            ;; complete either caller twice.
            (dolist (callback close-callbacks)
              (funcall callback failure)
              (funcall callback failure))
            (should (equal results (list failure)))
            (if failure
                (should (pi-deck-space space))
              (should-not (pi-deck-space space)))
            ;; The parent's registry is orchestration-owned; deck Close never
            ;; consults or edits it for a Pi worker.
            (should (eq (gethash id pi-orchestration--targets) target))
            (should (equal target registered))))))))

(ert-deftest pi-deck-test-close-reports-retained-failure-after-view-removal ()
  "An owner that removed the view with an earlier failure is not reported unconfirmed."
  (pi-deck-test--with-deck
    (dolist (removed '(t nil))
      (let* ((chat (pi-deck-test--session dir (if removed "removed" "retained")))
             (agent (pi-deck-agent chat))
             (name (pi-deck-agent-name agent))
             (failure "Worker task cleanup failed: timed out")
             results messages)
        (with-current-buffer chat
          (setq pi-deck-test--runtime
                (list :protocol 2 :mux-id (concat "mux-" name) :state "stopped" :placement "worker")))
        (setf (pi-deck-agent-placement agent) "worker")
        (cl-letf (((symbol-function 'pilish-close-session)
                   (lambda (buffer callback)
                     (when removed
                       (run-hook-with-args 'pilish-session-closed-functions buffer)
                       (pi-deck-test--dispose buffer))
                     (funcall callback failure)))
                  ((symbol-function 'message)
                   (lambda (format &rest args) (push (apply #'format-message format args) messages))))
          (pi-deck-test--without-confirmation
            (pi-deck-stop-agent agent (lambda (error) (push error results)))))
        (should (equal results (list failure)))
        (if removed
            (progn
              (should-not (buffer-live-p chat))
              (should-not (pi-deck-agent chat))
              (should (pi-deck-agent-closing agent))
              (should (member (format "pi-deck: closed %s; its cleanup had failed: %s" name failure)
                              messages)))
          (should (eq (pi-deck-agent chat) agent))
          (should-not (pi-deck-agent-closing agent))
          (should (member (concat "pi-deck: close/view cleanup not confirmed: " failure) messages))
          (pi-deck-test--dispose chat))))))

(ert-deftest pi-deck-test-remote-termination-removes-panes-sidebar-and-saved-layouts ()
  (pi-deck-test--with-large-frame
   (pi-deck-test--with-deck
    (let ((two (make-temp-file "pi-deck-remote-space-" t)))
      (unwind-protect
          (progn
            (pi-deck-create-space two "two")
            (pi-deck-create-space dir "space")
            (let* ((chat (pi-deck-test--session dir "remote"))
                   (input (pilish-session-input-buffer chat))
                   (name (buffer-name chat))
                   (input-name (buffer-name input))
                   (agent (pi-deck-agent chat)))
              (with-current-buffer chat
                (setq pi-deck-test--runtime
                      '(:protocol 2 :mux-id "remote-runtime" :state "live")))
              (with-current-buffer input (insert "retained until terminal evidence"))
              (pi-deck--display-agent-in-window agent (selected-window))
              (pi-deck-select-space "two")
              (pi-deck--display-agent-in-window agent (pi-deck--pane-window))
              (pi-deck-select-space "space")
              (pi-deck-sidebar-toggle)
              (select-window (get-buffer-window input))
              (cl-letf (((symbol-function 'pilish-stop-runtime)
                         (lambda (&rest _) (ert-fail "Remote cleanup requested another stop"))))
                ;; A broken connection is not authoritative termination.
                (with-current-buffer chat
                  (setq pi-deck-test--runtime
                        (plist-put pi-deck-test--runtime :state "disconnected")))
                (run-hook-with-args 'pilish-session-desktop-state-functions chat)
                (should (pi-deck-agent chat))
                (should (get-buffer-window input))
                (should (equal (plist-get (plist-get (car (plist-get (pi-deck-state) :agents))
                                                     :desktop-state) :draft)
                               "retained until terminal evidence"))
                ;; Pilish notifies authoritative closure before disposing its buffers.
                (with-current-buffer chat
                  (setq pi-deck-test--runtime
                        (plist-put pi-deck-test--runtime :state "stopped")))
                (run-hook-with-args 'pilish-session-closed-functions chat)
                (run-hook-with-args 'pilish-session-closed-functions chat)
                (should-not (pi-deck-agent chat))
                (should-not (get-buffer-window chat))
                (should-not (get-buffer-window input))
                (with-current-buffer (pi-deck-sidebar-buffer)
                  (pi-deck-sidebar-refresh)
                  (should-not (text-property-any (point-min) (point-max)
                                                 'pi-deck-agent agent)))
                (pi-deck-test--dispose chat)
                (pi-deck-refresh)
                (should-not (pi-deck-agent chat)))
              (pi-deck-switch-space "two")
              (should (= (length (pi-deck-test--main-windows)) 1))
              (should (pi-deck-test--in-dired-p))
              (pi-deck-save-state)
              (let ((saved (pi-deck-read-state)))
                (should-not (plist-get saved :agents))
                (dolist (layout (plist-get saved :layouts))
                  (should-not (member name (window-state-buffers (cdr layout))))
                  (should-not (member input-name (window-state-buffers (cdr layout))))))))
        (delete-directory two t))))))

(provide 'pi-deck-close-test)
;;; pi-deck-close-test.el ends here
