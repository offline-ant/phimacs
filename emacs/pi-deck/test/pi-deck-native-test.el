;;; pi-deck-native-test.el --- Real detached runtime desktop regressions -*- lexical-binding: t; -*-
;; SPDX-License-Identifier: MIT

;;; Commentary:
;; Opt-in only: actual selected Pi with in-process faux inference, compiled
;; pimux and a direct socket Pilish frontend. No public API stubs or live user
;; discovery. A separate Node frontend changes authoritative runtime state.

;;; Code:
(require 'ert)
(require 'pi-deck)
(require 'ghostel)
(require 'json)

(declare-function pi-orchestration-dispatch "pi-orchestration" (encoded))
(declare-function pi-orchestration-targets "pi-orchestration" ())
(declare-function pi-orchestration-panel-command-state "pi-orchestration" (buffer))
(declare-function pi-orchestration-stop-target "pi-orchestration" (id &optional callback))

(defun pi-deck-native--wait (description predicate)
  "Handle process events until PREDICATE holds, or fail naming DESCRIPTION."
  (let ((deadline (+ (float-time) 45)))
    (while (and (not (funcall predicate)) (< (float-time) deadline))
      (accept-process-output nil 0.05)
      (pi-deck-refresh))
    (unless (funcall predicate) (ert-fail (format "Timed out: %s" description)))))

(defun pi-deck-native--peer (runtime command &optional run)
  "Send COMMAND through an independent socket peer to RUNTIME; optionally RUN."
  (with-temp-buffer
    (let ((status (process-file
                   (getenv "PHIMACS_TEST_NODE") nil t nil
                   (expand-file-name "test/support/pimux-peer.mjs" (getenv "PHIMACS_NATIVE_PILISH"))
                   (plist-get runtime :socket) (json-encode command) (if run "run" ""))))
      (unless (eql status 0) (error "Independent frontend failed: %s" (buffer-string)))
      (let ((result (json-parse-string (buffer-string) :object-type 'plist)))
        (should (eq (plist-get (plist-get result :response) :success) t))
        result))))

(defun pi-deck-native--users (runtime)
  "Return RUNTIME's authoritative user messages through the independent peer."
  (let* ((result (pi-deck-native--peer runtime '(:type "get_messages")))
         (messages (plist-get (plist-get (plist-get result :response) :data) :messages)))
    (seq-filter (lambda (message) (equal (plist-get message :role) "user")) (append messages nil))))

(defun pi-deck-native--live (agent)
  "Wait for AGENT's authoritative live snapshot and return its chat."
  (let ((chat (pi-deck-agent-buffer agent)))
    (pi-deck-native--wait
     "authoritative socket snapshot"
     (lambda () (equal (plist-get (pilish-session-runtime chat) :state) "live")))
    (should (eq (process-type (pilish-session-process chat)) 'network))
    (should-not (integerp (process-id (pilish-session-process chat))))
    chat))

(defun pi-deck-native--submit (chat text)
  "Explicitly submit faux TEXT to CHAT, without manipulating its local draft."
  (let (response)
    (pilish-submit-prompt chat text (lambda (result) (setq response result)))
    (pi-deck-native--wait "prompt acceptance" (lambda () response))
    (should (eq (plist-get response :success) t))))

(defun pi-deck-native--stop-owned ()
  "Stop only discovery entries inside this marked test namespace."
  (dolist (runtime (pilish-list-runtimes))
    (unless (string-prefix-p (concat (getenv "PHIMACS_TEST_ROOT") "/mux/")
                             (or (plist-get runtime :socket) ""))
      (error "Synthetic cleanup refuses a foreign runtime"))
    (with-temp-buffer
      (unless (eql 0 (process-file (getenv "PHIMACS_PIMUX_EXECUTABLE") nil t nil
                                   "stop" "--json" "--id" (plist-get runtime :mux-id)))
        (error "Synthetic runtime cleanup uncertain: %s" (buffer-string))))))

(defmacro pi-deck-native--with-desktop (&rest body)
  "Run BODY against an explicitly isolated real Pi/faux runtime."
  (declare (indent 0))
  `(progn
     (skip-unless (getenv "PHIMACS_NATIVE_DECK"))
     (should (string-prefix-p "/tmp/phimacs-test-" (or (getenv "PHIMACS_TEST_ROOT") "")))
     (let* ((root (getenv "PHIMACS_TEST_ROOT"))
            (default-directory (file-name-as-directory (expand-file-name "sessions" root)))
            (pi-deck-state-file (expand-file-name "desktop.eld" root))
            (pi-deck-preferences-file (expand-file-name "preferences.eld" root))
            (pi-deck--agents (make-hash-table :test 'eq))
            (pi-deck-spaces nil) (pi-deck--layouts nil) (pi-deck--last-space nil)
            (pi-deck--finished-workers nil) (pi-deck--state-claimed t)
            (pi-deck--state-owner (expand-file-name "synthetic-server" root))
            (pi-deck--state-backup-pending nil) (pi-deck--last-saved nil)
            (pi-deck--restoring nil) (pi-deck--restore-failures nil)
            (pi-deck--restored-buffers nil) (pi-deck--restored-links nil)
            (pi-deck--saved-structure nil) (pi-deck--pending-reveal nil)
            (pi-deck-save-delay nil) (pi-deck-restore-interval 0)
            (pi-deck-sidebar nil) (pi-deck-new-space-action 'dired)
            (pi-deck-notify-function #'ignore)
            (pilish-session-environment-functions nil)
            (pilish-runtime-mode 'detached)
            (pilish-quit-without-confirmation t)
            (kill-buffer-query-functions nil)
            (process-environment (copy-sequence process-environment))
            original-failure cleanup-failures
            (pilish-extra-args
             (list "--no-extensions" "--no-skills" "--no-prompt-templates" "--no-context-files"
                   "-e" (getenv "PHIMACS_FAUX_EXTENSION")
                   "--provider" "fx" "--model" "one" "--thinking" "off")))
       (setq process-environment
             (seq-remove (lambda (entry)
                           (string-match-p "\\`\\(?:PI_ORCHESTRATION_\\|PI_WORKER_\\|PHIMACS_PARENT_TASK\\(?:_\\|=\\)\\|PHIMACS_MANAGED_CLAIM=\\)" entry))
                         process-environment))
       ;; New-session RPCs allocate from Pi's session directory, not the initial
       ;; exact --session path. Keep every later allocation inside this fixture's
       ;; marked sessions root as well as the launcher's first conversation.
       (setenv "PI_CODING_AGENT_DIR" (expand-file-name "agent" root))
       (setenv "PI_CODING_AGENT_SESSION_DIR" default-directory)
       (setenv "PIMUX_DIR" (expand-file-name "mux" root))
       (pilish-configure-runtime :pi-executable (getenv "PHIMACS_PI_EXECUTABLE")
                                 :pimux-executable (getenv "PHIMACS_PIMUX_EXECUTABLE")
                                 :task-status-executable (getenv "PHIMACS_TASK_STATUS_EXECUTABLE"))
       (set-frame-size nil 160 50)
       (set-frame-parameter nil 'tabs nil)
       (unwind-protect
           (condition-case failure
               (progn
                 (pi-deck-mode 1)
                 (pi-deck-create-space default-directory "native")
                 ,@body)
             ((error quit) (setq original-failure failure)))
         (dolist (cleanup
                  (list (lambda () (pi-deck-mode -1))
                        #'pi-deck-native--stop-owned
                        (lambda ()
                          (dolist (buffer (buffer-list))
                            (when (or (pi-deck-pi-buffer-p buffer) (pi-deck-shell-buffer-p buffer))
                              (if (pi-deck-pi-buffer-p buffer) (pilish-disconnect-session buffer)
                                (kill-buffer buffer)))))
                        (lambda ()
                          (set-frame-parameter nil 'tabs nil)
                          (delete-other-windows)
                          (switch-to-buffer (get-scratch-buffer-create))
                          (when pi-deck--update-timer
                            (cancel-timer pi-deck--update-timer) (setq pi-deck--update-timer nil))
                          (set-frame-size nil 80 25))))
           (condition-case failure (funcall cleanup)
             ((error quit) (push failure cleanup-failures)))))
       (when cleanup-failures
         (ert-fail (format "Original: %S; cleanup: %S" original-failure (nreverse cleanup-failures))))
       (when original-failure (signal (car original-failure) (cdr original-failure))))))

(ert-deftest pi-deck-native-desktop-reconnect-adopts-moved-runtime-and-quarantines-draft ()
  (pi-deck-native--with-desktop
    (let* ((agent (pi-deck-new-agent "desktop"))
           (chat (pi-deck-native--live agent))
           (runtime (pilish-session-runtime chat))
           (identity (pilish-session-process-identity chat))
           (old-file (pilish-session-file chat))
           (marker (expand-file-name "shell-executions" root))
           (shell (pi-deck-start-shell default-directory "native-shell"
                                       (list "/bin/sh" "-c"
                                             (concat "printf x >> " (shell-quote-argument marker) "; exec cat")))))
      (setf (pi-deck-agent-assigned-space (pi-deck--track shell 'shell)) "native")
      (pi-deck-native--wait "one native shell execution" (lambda () (file-exists-p marker)))
      (pi-deck-native--submit chat "desktop first once")
      (pi-deck-native--wait "first faux reply" (lambda () (not (pilish-session-busy-p chat))))
      (should (= (length (pi-deck-native--users runtime)) 1))
      (with-current-buffer (pilish-session-input-buffer chat) (insert "draft belongs to old context"))
      (pi-deck-save-state)
      (let ((record (seq-find (lambda (record) (eq (plist-get record :kind) 'pi))
                              (plist-get (pi-deck-read-state) :agents))))
        (should (equal (plist-get (plist-get record :desktop-state) :draft) "draft belongs to old context")))
      ;; Closing the entire desktop, including its last socket, cannot stop Pi.
      (pi-deck-mode -1)
      (pilish-disconnect-session chat)
      (kill-buffer shell)
      (should-not (buffer-live-p chat))
      (should (process-attributes (plist-get runtime :pi-pid)))
      ;; The independent frontend changes context while no Emacs view exists.
      (pi-deck-native--peer runtime '(:type "new_session"))
      (pi-deck-native--peer runtime '(:type "prompt" :message "peer moved once") t)
      ;; Simulate a fresh desktop registry. Restoring may attach, never spawn.
      (setq pi-deck--agents (make-hash-table :test 'eq)
            pi-deck-spaces nil pi-deck--layouts nil pi-deck--last-space nil)
      (set-frame-parameter nil 'tabs nil)
      (delete-other-windows)
      (switch-to-buffer (get-scratch-buffer-create))
      (pi-deck-mode 1)
      (pi-deck-restore-state)
      (setq agent (seq-find (lambda (candidate) (eq (pi-deck-agent-kind candidate) 'pi)) (pi-deck-agents)))
      (should agent)
      (setq chat (pi-deck-native--live agent))
      (should (equal identity (pilish-session-process-identity chat)))
      (should (equal (plist-get runtime :mux-id) (plist-get (pilish-session-runtime chat) :mux-id)))
      (should-not (equal old-file (pilish-session-file chat)))
      (should (= (length (pilish-list-runtimes)) 1))
      (should (pilish-session-quarantine chat))
      (should (string-empty-p (plist-get (pilish-session-desktop-state chat) :draft)))
      (should (= (length (pi-deck-native--users runtime)) 1))
      (should-not (string-match-p "draft belongs" (json-encode (pi-deck-native--users runtime))))
      (let ((restored-shell (seq-find (lambda (candidate) (eq (pi-deck-agent-kind candidate) 'shell)) (pi-deck-agents))))
        (should restored-shell)
        (should (eq (buffer-local-value 'major-mode (pi-deck-agent-buffer restored-shell)) 'pi-deck-stopped-shell-mode))
        (should-not (pi-deck-agent-process restored-shell)))
      (should (equal (with-temp-buffer (insert-file-contents marker) (buffer-string)) "x"))
      (should-not pi-deck--restore-failures)
      (pi-deck-save-state)
      (let* ((record (seq-find (lambda (record) (eq (plist-get record :kind) 'pi))
                               (plist-get (pi-deck-read-state) :agents)))
             (desktop (plist-get record :desktop-state)))
        (should (equal (plist-get desktop :session-file) (pilish-session-file chat)))
        (should (plist-get desktop :quarantine))))))

(ert-deftest pi-deck-native-closed-desktop-is-retired-and-history-resume-is-explicit ()
  (pi-deck-native--with-desktop
    (let* ((agent (pi-deck-new-agent "stopped"))
           (chat (pi-deck-native--live agent))
           (runtime (pilish-session-runtime chat)) state stopped (callback-count 0))
      (pi-deck-native--submit chat "persist this once")
      (pi-deck-native--wait "persisted faux reply" (lambda () (not (pilish-session-busy-p chat))))
      (setq state (pilish-session-desktop-state chat))
      (pilish-stop-runtime chat (lambda (error) (cl-incf callback-count) (setq stopped (or error 'ok))))
      (pi-deck-native--wait "identity-bound stop callback" (lambda () stopped))
      (should (eq stopped 'ok))
      (should (= callback-count 1))
      (should-not (buffer-live-p chat))
      (should-not (pi-deck--restore-agent
                   (list :kind 'pi :buffer "saved-closed" :space "native" :desktop-state state)))
      (should-not (plist-get (pi-deck-state) :agents))
      (should-not (pilish-list-runtimes))
      ;; A stopped view without a runtime identity reopens its saved history
      ;; explicitly only. Automatic desktop restore must not resurrect the owner.
      (setq state (plist-put state :runtime '(:protocol 2 :state "stopped")))
      (setq agent (pi-deck--restore-agent (list :kind 'pi :buffer "saved-stopped" :space "native" :desktop-state state)))
      (setq chat (pi-deck-agent-buffer agent))
      (should (member (plist-get (pilish-session-runtime chat) :state) '("unavailable" "stopped")))
      (should (string-match-p "Resume" (pi-deck-agent-detail agent)))
      (should-not (process-live-p (pilish-session-process chat)))
      (should-not (pilish-list-runtimes))
      (let (error done)
        (pilish-reconnect-runtime chat (lambda (failure) (setq error failure done t)))
        (should done)
        (should error))
      (should-not (pilish-list-runtimes))
      (pi-deck-resume-agent agent)
      (pi-deck-native--live agent)
      (should-not (equal (plist-get runtime :mux-id) (plist-get (pilish-session-runtime chat) :mux-id)))
      (should (= (length (pilish-list-runtimes)) 1))
      (should (= (length (pi-deck-native--users (pilish-session-runtime chat))) 1)))))

(defun pi-deck-native--tree-browse (chat text)
  "Open CHAT's tree browser with idle C-c C-k and put point on TEXT's row."
  (with-current-buffer (pilish-session-input-buffer chat)
    (should (eq (key-binding (kbd "C-c C-k")) #'pilish-abort-or-tree-browser))
    (call-interactively #'pilish-abort-or-tree-browser))
  (let ((browser (seq-find (lambda (buffer)
                             (eq (buffer-local-value 'major-mode buffer) 'pilish-tree-browser-mode))
                           (buffer-list))))
    (should browser)
    (should (eq (window-buffer (selected-window)) browser))
    (with-current-buffer browser
      (pi-deck-native--wait "tree row" (lambda () (save-excursion (goto-char (point-min))
                                                                   (search-forward text nil t))))
      (goto-char (point-min))
      (search-forward text))
    browser))

(defun pi-deck-native--navigated (chat text)
  "Wait until CHAT's runtime move prefilled TEXT, then clear the input."
  (let ((input (pilish-session-input-buffer chat)))
    (pi-deck-native--wait "navigation prefill"
                          (lambda () (equal (with-current-buffer input (buffer-string)) text)))
    (with-current-buffer input (erase-buffer))))

(ert-deftest pi-deck-native-tree-navigation-moves-runtime-and-persists ()
  (pi-deck-native--with-desktop
    (let* ((agent (pi-deck-new-agent "tree"))
           (chat (pi-deck-native--live agent))
           state stopped)
      (dolist (text '("first once" "second once"))
        (pi-deck-native--submit chat text)
        (pi-deck-native--wait "faux reply" (lambda () (not (pilish-session-busy-p chat)))))
      (should (= (length (pi-deck-native--users (pilish-session-runtime chat))) 2))
      ;; RET on the second prompt moves the runtime to its parent and prefills it.
      (with-current-buffer (pi-deck-native--tree-browse chat "second once")
        (call-interactively (key-binding (kbd "RET"))))
      (pi-deck-native--navigated chat "second once")
      (should (= (length (pi-deck-native--users (pilish-session-runtime chat))) 1))
      (with-current-buffer chat
        (should (string-match-p "reply: first once" (buffer-string)))
        (should-not (string-match-p "second once" (buffer-string))))
      ;; The move survives stopping and resuming its root.
      (setq state (plist-put (pilish-session-desktop-state chat) :runtime '(:protocol 2 :state "stopped")))
      (pilish-stop-runtime chat (lambda (error) (setq stopped (or error 'ok))))
      (pi-deck-native--wait "stopped root" (lambda () stopped))
      (should (eq stopped 'ok))
      (should-not (pilish-list-runtimes))
      (setq agent (pi-deck--restore-agent (list :kind 'pi :buffer "tree-resumed" :space "native" :desktop-state state)))
      (pi-deck-resume-agent agent)
      (setq chat (pi-deck-native--live agent))
      (should (= (length (pi-deck-native--users (pilish-session-runtime chat))) 1))
      (with-current-buffer chat (should-not (string-match-p "second once" (buffer-string))))
      ;; S summarizes the abandoned branch on the resumed root.
      (with-current-buffer (pilish-session-input-buffer chat) (erase-buffer))
      (pi-deck-native--submit chat "third once")
      (pi-deck-native--wait "faux reply" (lambda () (not (pilish-session-busy-p chat))))
      (with-current-buffer (pi-deck-native--tree-browse chat "third once")
        (call-interactively (key-binding "S")))
      (pi-deck-native--navigated chat "third once")
      (let* ((result (pi-deck-native--peer (pilish-session-runtime chat) '(:type "get_messages")))
             (messages (append (plist-get (plist-get (plist-get result :response) :data) :messages) nil)))
        (should (= (length (seq-filter (lambda (m) (equal (plist-get m :role) "user")) messages)) 1))
        (should (seq-find (lambda (m) (equal (plist-get m :role) "branchSummary")) messages))))))

(ert-deftest pi-deck-native-close-idle-and-busy-without-confirmation ()
  (pi-deck-native--with-desktop
    (cl-letf (((symbol-function 'y-or-n-p) (lambda (&rest _) (ert-fail "Close asked")))
              ((symbol-function 'yes-or-no-p) (lambda (&rest _) (ert-fail "Close asked")))
              ((symbol-function 'x-popup-dialog) (lambda (&rest _) (ert-fail "Close asked"))))
      (let* ((agent (pi-deck-new-agent "idle-close"))
             (chat (pi-deck-native--live agent)))
        ;; Removing the last pair while its input is selected deletes that
        ;; input window. Cleanup must never use the deleted window afterwards.
        (let ((input-window (get-buffer-window (pilish-session-input-buffer chat))))
          (should (window-live-p input-window))
          (select-window input-window))
        (pi-deck-close-agent agent)
        (pi-deck-native--wait "acknowledged idle close" (lambda () (not (buffer-live-p chat))))
        (should-not (pi-deck-agent chat))
        (should-not (pilish-list-runtimes))
        (setq agent (pi-deck-new-agent "busy-close") chat (pi-deck-native--live agent))
        (pi-deck-native--submit chat "slow 8")
        (pi-deck-native--wait "working faux run" (lambda () (eq (pi-deck-agent-state agent) 'working)))
        (pi-deck-close-agent agent)
        (pi-deck-native--wait "acknowledged busy close" (lambda () (not (buffer-live-p chat))))
        (should-not (pi-deck-agent chat))
        (should-not (pilish-list-runtimes))
        (should-not (plist-get (pi-deck-state) :agents))))))

(defun pi-deck-native--panel-control (helper operation &rest values)
  "Ask the exact creator HELPER for panel OPERATION and VALUES."
  (let* ((buffer (process-buffer helper))
         (start (with-current-buffer buffer (point-max))) end)
    (process-send-string helper (concat (json-encode (append (list :operation operation) values)) "\n"))
    (pi-deck-native--wait
     "owned panel fixture response"
     (lambda ()
       (with-current-buffer buffer
         (save-excursion
           (goto-char start)
           (setq end (search-forward "\n" nil t))))))
    (let ((reply (json-parse-string
                  (with-current-buffer buffer (buffer-substring-no-properties start end))
                  :object-type 'plist)))
      (when (plist-get reply :error) (error "%s" (plist-get reply :error)))
      reply)))

(defun pi-deck-native--panel-create (helper name argv &optional parent)
  "Create real Ghostel panel NAME with ARGV through public companion dispatch.
HELPER remains its exact creator; PARENT is another managed panel's target ID."
  (let* ((created (pi-deck-native--panel-control
                   helper "create" :name name :argv (vconcat argv)
                   :cwd default-directory :parent parent))
         (id (plist-get created :id))
         (request (list :operation "start" :id id :endpoint "isolated-batch"
                        :spec (plist-get created :spec)))
         (reply (json-parse-string
                 (decode-coding-string
                  (base64-decode-string
                   (pi-orchestration-dispatch
                    (base64-encode-string (encode-coding-string (json-encode request) 'utf-8) t)))
                  'utf-8)
                 :object-type 'plist)))
    (should-not (plist-get reply :error))
    (should (equal (plist-get (plist-get reply :target) :id) id))
    (pi-deck-native--panel-control helper "activate" :id id)
    (pi-deck-refresh)
    (let ((buffer (plist-get (cl-find id (pi-orchestration-targets)
                                        :key (lambda (target) (plist-get target :id)) :test #'equal)
                            :buffer)))
      (should (buffer-live-p buffer))
      (list :id id :buffer buffer))))

(defmacro pi-deck-native--with-panels (&rest body)
  "Run BODY with real managed Ghostel panels and an exact live creator."
  (declare (indent 0))
  `(pi-deck-native--with-desktop
    (require 'pi-orchestration)
    (let* ((output (generate-new-buffer " *deck-panel-control*"))
           (diagnostics (generate-new-buffer " *deck-panel-errors*"))
           (helper (make-process
                    :name "deck-native-panel-creator" :buffer output :stderr diagnostics
                    :connection-type 'pipe :coding 'utf-8-unix :noquery t
                    :command (list (getenv "PHIMACS_TEST_NODE")
                                   (expand-file-name "test/support/panel-control.mjs"
                                                     (getenv "PHIMACS_TEST_DECK")))))
           failures)
      (unwind-protect
          (condition-case failure
              (progn ,@body)
            ((error quit) (push (error-message-string failure) failures)))
        (condition-case failure
            (progn
              (pi-deck-native--panel-control helper "finish")
              (pi-deck-native--wait "panel creator cleanup" (lambda () (not (process-live-p helper))))
              (should (zerop (process-exit-status helper))))
          ((error quit)
           (push (concat "Panel fixture cleanup: " (error-message-string failure)) failures)))
        (when (process-live-p helper) (delete-process helper))
        (when failures
          (push (with-current-buffer diagnostics (buffer-string)) failures))
        (kill-buffer output)
        (kill-buffer diagnostics))
      (when failures (ert-fail (string-join (nreverse failures) "\n"))))))

(ert-deftest pi-deck-native-managed-finished-panel-stays-listed-and-sidebar-close-acknowledges ()
  (pi-deck-native--with-panels
    (let* ((panel (pi-deck-native--panel-create
                   helper "finished" '("/bin/sh" "-c" "printf 'FINISHED_PANEL\\n'")))
           (id (plist-get panel :id))
           (buffer (plist-get panel :buffer))
           (agent (pi-deck-agent buffer)) completed)
      (pi-deck-native--wait
       "managed command exit while wrapper survives"
       (lambda () (equal (pi-orchestration-panel-command-state buffer) "exited")))
      (should (process-live-p (get-buffer-process buffer)))
      (should (pi-deck-agent-finished-shell-p agent))
      (should (memq agent (pi-deck-agents)))
      (let ((status (pi-deck-native--panel-control helper "status" :id id)))
        (should (equal (plist-get status :wrapper) "alive"))
        (should (string-match-p "FINISHED_PANEL" (plist-get status :output))))
      ;; Expand the normal folded finished-shell row, then use sidebar Close.
      (with-current-buffer (pi-deck-sidebar-buffer)
        (pi-deck-sidebar-refresh)
        (goto-char (text-property-not-all (point-min) (point-max) 'pi-deck-finished-shells nil))
        (should (memq agent (cdr (get-text-property (point) 'pi-deck-finished-shells))))
        (should (looking-at-p ".*1 finished shell"))
        (pi-deck-sidebar-toggle-fold)
        (goto-char (text-property-any (point-min) (point-max) 'pi-deck-agent agent))
        (pi-deck-sidebar-close))
      (pi-orchestration-stop-target id (lambda (error) (setq completed (list error))))
      (pi-deck-native--wait "sidebar Close acknowledgement" (lambda () completed))
      (should (equal completed '(nil)))
      (should-not (buffer-live-p buffer))
      (should-not (pi-deck-agent buffer))
      (let ((status (pi-deck-native--panel-control helper "status" :id id)))
        (should (eq (plist-get (plist-get status :state) :closed) t))
        (should (equal (plist-get status :wrapper) "dead"))))))

(ert-deftest pi-deck-native-managed-space-close-acknowledges-owned-children-first ()
  (pi-deck-native--with-panels
    (let* ((parent (pi-deck-native--panel-create
                    helper "parent" '("/bin/sh" "-c" "printf 'PARENT_READY\\n'; exec cat")))
           (parent-id (plist-get parent :id))
           (parent-buffer (plist-get parent :buffer))
           (finished (pi-deck-native--panel-create
                      helper "child-finished" '("/bin/sh" "-c" "printf 'CHILD_FINISHED\\n'") parent-id))
           (running (pi-deck-native--panel-create
                     helper "child-running" '("/bin/sh" "-c" "printf 'CHILD_RUNNING\\n'; exec cat") parent-id))
           (children (list finished running)) closed)
      (pi-deck-native--wait
       "finished child command"
       (lambda () (equal (pi-orchestration-panel-command-state (plist-get finished :buffer)) "exited")))
      (dolist (child children)
        (let ((id (plist-get child :id)) (buffer (plist-get child :buffer)))
          (should (eq (pi-deck-agent-parent (pi-deck-agent buffer)) parent-buffer))
          (with-current-buffer buffer
            (add-hook 'kill-buffer-hook
                      (lambda ()
                        (should (pi-deck-space "native"))
                        (push id closed)) nil t))))
      (with-current-buffer parent-buffer
        (add-hook 'kill-buffer-hook
                  (lambda ()
                    (should (pi-deck-space "native"))
                    (dolist (child children) (should-not (buffer-live-p (plist-get child :buffer))))
                    (push parent-id closed)) nil t))
      (pi-deck-close-space "native")
      (should (pi-deck-space "native"))
      (pi-deck-native--wait "space Close after owned child cleanup"
                            (lambda () (not (pi-deck-space "native"))))
      (should (equal (car closed) parent-id))
      (should (= (length closed) 3))
      (dolist (panel (cons parent children))
        (should-not (buffer-live-p (plist-get panel :buffer)))
        (let ((status (pi-deck-native--panel-control helper "status" :id (plist-get panel :id))))
          (should (equal (plist-get status :wrapper) "dead"))
          (should (eq (plist-get (plist-get status :state) :closed) t))))
      (should-not (plist-get (pi-deck-state) :agents)))))

(provide 'pi-deck-native-test)
;;; pi-deck-native-test.el ends here
