;;; pi-orchestration-test.el --- Native host contracts -*- lexical-binding: t; -*-

(require 'pi-orchestration)
(require 'pilish-test-common)

(ert-deftest pi-orchestration-native-shell-keys-output-exit-and-close ()
  (let* ((pi-orchestration--targets (make-hash-table :test 'equal))
         (id "ghostel-native-test")
         (window (selected-window)) (before (window-buffer))
         (response (pi-orchestration--start
                    (list :id id :endpoint "test"
                          :spec '(:kind "shell" :name "ghostel-test" :cwd "/tmp/"
                                        :argv ["/bin/bash" "-c" "stty -echo; false | true; printf 'READY:%s\\n' \"${PIPESTATUS[0]}\"; read line; printf 'RECEIVED:%s\\n' \"$line\""])))))
    (unwind-protect
        (progn
          (should (equal (plist-get (plist-get response :target) :id) id))
          (should (eq (selected-window) window))
          (should (eq (window-buffer) before))
          (should (pilish-test-wait-until
                   (lambda () (string-match-p "READY:1" (plist-get (pi-orchestration--read (list :id id)) :output))) 5))
          (pi-orchestration--send (list :id id :input '(:kind "text" :text "literal ctrl+c 'quoted'" :enter :false)))
          (pi-orchestration--send (list :id id :input '(:kind "keys" :keys ["Enter"])))
          (should (pilish-test-wait-until
                   (lambda () (equal (plist-get (pi-orchestration--state id) :state) "exited")) 5))
          (should (string-match-p (regexp-quote "RECEIVED:literal ctrl+c 'quoted'")
                                  (plist-get (pi-orchestration--read (list :id id)) :output)))
          (should-error (pi-orchestration--send (list :id id :input '(:kind "prompt" :text "bad")))))
      (pi-orchestration--close id))
    (should (equal (plist-get (pi-orchestration--state id) :state) "missing"))))

(ert-deftest pi-orchestration-terminal-keys-reach-the-program-as-bytes ()
  (let* ((pi-orchestration--targets (make-hash-table :test 'equal))
         (id "ghostel-keys-test")
         (keys ["ctrl+c" "Escape" "Up" "alt+x" "Tab" "F5" "A" "Alt+X" "shift+b" "PageDown" "Enter"])
         (expected "\3\e\e[A\ex\t\e[15~A\eXB\e[6~\r"))
    (pi-orchestration--start
     (list :id id :endpoint "test"
           :spec (list :kind "shell" :name "keys" :cwd "/tmp/"
                       :argv (vector "/bin/sh" "-c"
                                     (format "stty raw -echo; printf 'READY\\n'; dd bs=1 count=%d 2>/dev/null | od -An -tx1 | tr -d ' \\n'; printf '\\nEND\\n'; read line"
                                             (length expected))))))
    (unwind-protect
        (progn
          (should (pilish-test-wait-until
                   (lambda () (string-match-p "READY" (plist-get (pi-orchestration--read (list :id id)) :output))) 5))
          (pi-orchestration--send (list :id id :input (list :kind "keys" :keys keys)))
          (should (pilish-test-wait-until
                   (lambda () (string-match-p "END" (plist-get (pi-orchestration--read (list :id id)) :output))) 5))
          (should (string-match-p
                   (regexp-quote (mapconcat (lambda (byte) (format "%02x" byte)) expected ""))
                   (plist-get (pi-orchestration--read (list :id id)) :output)))
          (should-error (pi-orchestration--key "not-a-key"))
          (should-error (pi-orchestration--key "hyper+x")))
      (pi-orchestration--close id))))

(ert-deftest pi-orchestration-pilish-start-attaches-without-opening-a-writer ()
  (let* ((pi-orchestration--targets (make-hash-table :test 'equal))
         (chat (generate-new-buffer " *runtime-chat*"))
         (view '(:protocol 2 :mux-id "mux" :state "starting"))
         attached)
    (unwind-protect
        (cl-letf (((symbol-function 'pilish-list-runtimes) (lambda () nil))
                  ((symbol-function 'pilish-session-runtime) (lambda (_) view))
                  ((symbol-function 'pilish-stop-runtime) #'ignore)
                  ((symbol-function 'pilish-start-session)
                   (lambda (&rest _) (ert-fail "must not start a writer")))
                  ((symbol-function 'pilish-attach-runtime)
                   (lambda (runtime name)
                     (setq attached runtime)
                     (should (equal name "worker"))
                     chat))
                  ((symbol-function 'pilish-session-process) (lambda (_) nil))
                  ((symbol-function 'pilish-disconnect-session)
                   (lambda (_) (ert-fail "do not close a reused view"))))
          (let* ((spec '(:kind "pi" :name "worker" :cwd "/tmp/" :sessionFile "/tmp/s.jsonl"
                        :runtime (:protocol 2 :muxId "mux" :socket "/private/sock" :pid 100
                                  :piPid 101 :sessionFile "/tmp/s.jsonl" :state "committed")
                        :process (:pid 101 :startTime "123" :bootId "boot")))
                 (reply (pi-orchestration--start (list :id "w" :endpoint "test" :spec spec))))
            (should (equal (plist-get reply :muxId) "mux"))
            (should (equal (plist-get attached :pi-start-time) "123"))
            (should (equal (plist-get attached :pi-boot-id) "boot"))
            (should (equal (plist-get attached :session-file) "/tmp/s.jsonl"))
            (should (equal (plist-get (car (pi-orchestration-targets)) :mux-id) "mux"))
            (should (eq (plist-get (pi-orchestration--state "w") :ready) :json-false))
            (setq view '(:protocol 2 :mux-id "mux" :state "live"))
            (should (eq (plist-get (pi-orchestration--state "w") :ready) t))
            ;; View close never implies runtime stop.
            (pi-orchestration--close "w" nil "mux")
            (should-not (gethash "w" pi-orchestration--targets)))
          (should-error (pi-orchestration--start
                         '(:id "bad" :endpoint "test"
                           :spec (:kind "pi" :name "bad" :cwd "/tmp/")))))
      (when (buffer-live-p chat) (kill-buffer chat)))))

(ert-deftest pi-orchestration-targets-report-parents-and-lifecycle ()
  (let* ((pi-orchestration--targets (make-hash-table :test 'equal))
         (pi-orchestration--roots (make-hash-table :test 'equal))
         (root (generate-new-buffer "*pilish-chat:/tmp/root*"))
         (root-id (pi-orchestration--root-id root))
         (events nil)
         (pi-orchestration-target-functions
          (list (lambda (id event) (push (list id event) events)))))
    (unwind-protect
        (progn
          (pi-orchestration--start
           (list :id "panel-a" :endpoint "test"
                 :spec (list :kind "shell" :name "a" :cwd "/tmp/" :placement "worker"
                             :parent (list :id root-id)
                             :argv ["/bin/sh" "-c" "read line"])))
          (pi-orchestration--start
           (list :id "panel-b" :endpoint "test"
                 :spec '(:kind "shell" :name "b" :cwd "/tmp/" :parent (:id "panel-a")
                               :argv ["/bin/sh" "-c" "read line"])))
          (should (equal (reverse events) '(("panel-a" start) ("panel-b" start))))
          (let ((targets (pi-orchestration-targets)))
            (should (eq (plist-get (cl-find "panel-a" targets :key (lambda (target) (plist-get target :id)) :test #'equal) :parent)
                        root))
            (should (eq (plist-get (cl-find "panel-b" targets :key (lambda (target) (plist-get target :id)) :test #'equal) :parent)
                        (plist-get (pi-orchestration--target "panel-a") :buffer)))
            (should (equal (plist-get (car targets) :kind) "shell"))
            (should (equal (plist-get (cl-find "panel-a" targets :key (lambda (target) (plist-get target :id)) :test #'equal) :placement)
                           "worker")))
          (pi-orchestration-stop-target "panel-b")
          (should (equal (car events) '("panel-b" close)))
          (should (= (length (pi-orchestration-targets)) 1)))
      (pi-orchestration--close "panel-a")
      (pi-orchestration--close "panel-b")
      (kill-buffer root))))

(ert-deftest pi-orchestration-start-resolves-an-exact-discovered-parent ()
  (let* ((endpoint "/tmp/test-orchestration.sock")
         (parent-id "tau-root")
         (ref (list :host "emacs" :endpoint endpoint :id parent-id))
         (parent-runtime (list :protocol 2 :mux-id "parent-mux" :orchestration ref))
         (wrong-endpoint (list :protocol 2 :mux-id "other-mux"
                               :orchestration (plist-put (copy-sequence ref) :endpoint "/tmp/other.sock")))
         (unsupported (list :protocol 1 :mux-id "legacy-mux" :orchestration ref))
         (child-data (list :id "child" :endpoint endpoint :spec
                           (list :kind "pi" :name "worker" :cwd "/tmp/" :placement "worker" :parent ref
                                 :runtime '(:protocol 2 :muxId "child-mux" :socket "/tmp/worker.sock"
                                            :pid 100 :piPid 101 :sessionFile "/tmp/worker.jsonl" :state "committed")
                                 :process '(:pid 101 :startTime "123" :bootId "boot"))))
         (pi-orchestration--roots (make-hash-table :test 'equal))
         (pi-orchestration--targets (make-hash-table :test 'equal))
         (parent-view (generate-new-buffer " *attached root*"))
         (child-view (generate-new-buffer " *attached worker*"))
         discovered requested observed-parent
         (pi-orchestration-target-functions
          (list (lambda (_id event)
                  (when (eq event 'start)
                    (setq observed-parent
                          (plist-get (car (pi-orchestration-targets)) :parent)))))))
    (unwind-protect
        (cl-letf (((symbol-function 'pilish-list-runtimes) (lambda () discovered))
                  ((symbol-function 'pilish-start-session)
                   (lambda (&rest _) (ert-fail "must never start the parent")))
                  ((symbol-function 'pilish-session-runtime) (lambda (_) nil))
                  ((symbol-function 'pilish-session-process) (lambda (_) nil))
                  ((symbol-function 'pilish-attach-runtime)
                   (lambda (runtime &optional _name)
                     (push (plist-get runtime :mux-id) requested)
                     (if (equal (plist-get runtime :mux-id) "child-mux") child-view parent-view))))
          ;; Zero matches or two exact matches leave the worker independent of
          ;; an unknown parent view. Neither a root ID alone nor protocol 1 binds it.
          (dolist (snapshot (list (list unsupported wrong-endpoint)
                                  (list parent-runtime (plist-put (copy-sequence parent-runtime) :mux-id "ambiguous"))))
            (setq discovered snapshot requested nil)
            (pi-orchestration--start child-data)
            (should (equal requested '("child-mux")))
            (should-not (pi-orchestration-parent-buffer parent-id))
            (should-not observed-parent)
            (pi-orchestration--close "child" nil "child-mux"))
          ;; Pilish returns an already-open view if it has this identity. The
          ;; exact target must be registered before observers place the child.
          (setq discovered (list wrong-endpoint unsupported parent-runtime) requested nil)
          (pi-orchestration--start child-data)
          (should (equal requested '("parent-mux" "child-mux")))
          (should (eq (pi-orchestration-parent-buffer parent-id) parent-view))
          (should (eq observed-parent parent-view))
          (should (equal (pi-orchestration--root-id parent-view) parent-id))
          (pi-orchestration--close "child" nil "child-mux")
          ;; Subsequent children use the registered view without rediscovery.
          (setq requested nil)
          (cl-letf (((symbol-function 'pilish-list-runtimes)
                     (lambda () (ert-fail "a live native root does not need discovery"))))
            (pi-orchestration--start child-data))
          (should (equal requested '("child-mux")))
          (should (eq observed-parent parent-view))
          (pi-orchestration--close "child" nil "child-mux"))
      (kill-buffer parent-view)
      (kill-buffer child-view))))

(ert-deftest pi-orchestration-root-id-survives-a-rename ()
  "A session move renames its chat; workers still find their parent."
  (let* ((pi-orchestration--targets (make-hash-table :test 'equal))
         (pi-orchestration--roots (make-hash-table :test 'equal))
         (root (generate-new-buffer "*pilish-chat:/tmp/a/*"))
         (id (pi-orchestration--root-id root))
         (taken (buffer-name root))
         newcomer)
    (unwind-protect
        (progn
          (should (equal id "*pilish-chat:/tmp/a/*"))
          (with-current-buffer root (rename-buffer "*pilish-chat:/tmp/b/*"))
          (should (equal (pi-orchestration--root-id root) id))
          (should (eq (pi-orchestration-parent-buffer id) root))
          ;; Another chat opens under the name the first one left.
          (setq newcomer (generate-new-buffer taken))
          (should (equal (buffer-name newcomer) taken))
          (should (equal (pi-orchestration--root-id newcomer)
                         "*pilish-chat:/tmp/a/*<2>"))
          (should (eq (pi-orchestration-parent-buffer id) root))
          (let ((environment
                 (let ((server-process (make-pipe-process :name "pi-test-roots" :noquery t))
                       (server-name "s") (server-socket-dir "/tmp/"))
                   (unwind-protect
                       (pi-orchestration--session-environment root "/tmp/b/")
                     (delete-process server-process)))))
            (should (equal (alist-get "PI_ORCHESTRATION_TARGET" environment nil nil #'equal)
                           id)))
          (kill-buffer newcomer)
          (should-not (pi-orchestration-parent-buffer "*pilish-chat:/tmp/a/*<2>")))
      (kill-buffer root)
      (when (buffer-live-p newcomer) (kill-buffer newcomer)))))

(ert-deftest pi-orchestration-worker-process-is-never-replaced ()
  "Reload keeps a worker's process, which its parent tracks."
  (let* ((pi-orchestration--targets (make-hash-table :test 'equal))
         (worker (generate-new-buffer " *worker-chat*"))
         (fork (generate-new-buffer " *fork-chat*")))
    (unwind-protect
        (progn
          (puthash "w" (list :kind "pi" :name "do-1" :placement "worker" :buffer worker)
                   pi-orchestration--targets)
          (puthash "f" (list :kind "pi" :name "fork" :placement "interactive-fork" :buffer fork)
                   pi-orchestration--targets)
          (should (memq #'pi-orchestration--restart-refusal
                        pilish-restart-refusal-functions))
          (should (string-match-p "do({resume: \"do-1\"})"
                                  (pi-orchestration--restart-refusal worker)))
          (should-not (pi-orchestration--restart-refusal fork)))
      (kill-buffer worker)
      (kill-buffer fork))))

(ert-deftest pi-orchestration-dispatch-treats-arguments-as-data ()
  (let* ((text "\" ) (error \"injected\") ;\n你好")
         (request (base64-encode-string (encode-coding-string (json-encode (list :operation text)) 'utf-8) t))
         (response (json-parse-string
                    (decode-coding-string (base64-decode-string (pi-orchestration-dispatch request)) 'utf-8)
                    :object-type 'plist)))
    (should (equal (plist-get response :error) "Unknown orchestration operation"))))

(ert-deftest pi-orchestration-ghostel-fullscreen-snapshot-and-owned-close ()
  (let* ((pi-orchestration--targets (make-hash-table :test 'equal))
         (id "ghostel-fullscreen-test") process)
    (unwind-protect
        (progn
          (pi-orchestration--start
           (list :id id :endpoint "test"
                 :spec '(:kind "shell" :name "fullscreen" :cwd "/tmp/"
                               :argv ["/bin/sh" "-c" "printf '\\033[?1049hCURSES READY\\r\\n'; read line"])))
          (setq process (pi-orchestration--process (pi-orchestration--target id)))
          (should (pilish-test-wait-until
                   (lambda () (string-match-p "CURSES READY"
                                               (plist-get (pi-orchestration--read (list :id id)) :output))) 5))
          (should (equal (plist-get (pi-orchestration--state id) :state) "running"))
          (pi-orchestration--close id)
          (should-not (process-live-p process)))
      (pi-orchestration--close id))))

(ert-deftest pi-orchestration-close-detaches-and-explicit-stop-awaits-acknowledgement ()
  (let* ((pi-orchestration--targets (make-hash-table :test 'equal))
         (chat (generate-new-buffer " *runtime-close*"))
         callback closed)
    (unwind-protect
        (cl-letf (((symbol-function 'pilish-disconnect-session)
                   (lambda (buffer) (should (eq buffer chat)) (setq closed t)))
                  ((symbol-function 'signal-process)
                   (lambda (&rest _) (ert-fail "never signal a socket process")))
                  ((symbol-function 'pilish-stop-runtime)
                   (lambda (buffer settle) (should (eq buffer chat)) (setq callback settle))))
          (puthash "w" (list :kind "pi" :buffer chat :mux-id "mux" :owns-view t) pi-orchestration--targets)
          (should-error (pi-orchestration--close "w" nil "other"))
          (pi-orchestration-stop-target "w")
          (should callback)
          (should-not closed)
          (funcall callback "uncertain")
          (should (gethash "w" pi-orchestration--targets))
          (should-not closed)
          (pi-orchestration-stop-target "w")
          (funcall callback nil)
          (should closed)
          (should-not (gethash "w" pi-orchestration--targets)))
      (when (buffer-live-p chat) (kill-buffer chat)))))

(ert-deftest pi-orchestration-worker-close-awaits-parent-cleanup-not-dispatch ()
  (let* ((pi-orchestration--targets (make-hash-table :test 'equal))
         (chat (generate-new-buffer " *worker-cancel*"))
         (transport (make-pipe-process :name "worker-cancel-view" :noquery t))
         (runtime '(:protocol 2 :mux-id "worker-mux" :state "live" :placement "worker"))
         dispatch sent results detached)
    (unwind-protect
        (cl-letf (((symbol-function 'pilish-session-runtime) (lambda (_) runtime))
                  ((symbol-function 'pilish-session-process) (lambda (_) transport))
                  ((symbol-function 'pilish-stop-runtime)
                   (lambda (&rest _) (ert-fail "worker cannot become a root stop")))
                  ((symbol-function 'pilish-disconnect-session)
                   (lambda (_) (ert-fail "Worker completion must reconcile, not disconnect")))
                  ((symbol-function 'pilish-reconcile-worker-task)
                   (lambda (buffer captured)
                     (should (eq buffer chat)) (should (eq captured runtime))
                     (setq detached t)
                     nil))
                  ((symbol-function 'pilish-close-session)
                   (lambda (buffer settle)
                     (should (eq buffer chat)) (push "close" sent) (setq dispatch settle))))
          (puthash "w" (list :kind "pi" :name "do-test" :buffer chat :mux-id "worker-mux"
                             :placement "worker" :owns-view t :runtime runtime)
                   pi-orchestration--targets)
          (pi-orchestration-stop-target "w" (lambda (error) (push error results)))
          (pi-orchestration-stop-target "w" (lambda (error) (push error results)))
          (should (equal sent '("close")))
          (should-not results)
          (should-error (pi-orchestration--close "w" nil "worker-mux"))
          (should-error (pi-orchestration--task-finished "w" "other" nil))
          (should-not detached)
          ;; Parent has verified exit and cleaned its native view, but still
          ;; owns the task name. Neither command acceptance nor exit is enough.
          (pi-orchestration--close "w" nil "worker-mux" t)
          (should-not detached)
          (should (gethash "w" pi-orchestration--targets))
          (should-not results)
          (pi-orchestration--task-finished "w" "worker-mux" nil)
          (should detached)
          (should (equal results '(nil nil)))
          (funcall dispatch nil)
          (should (equal results '(nil nil)))
          (should-not (gethash "w" pi-orchestration--targets))
          (pi-orchestration--task-finished "w" "worker-mux" nil)
          (should (= (length results) 2)))
      (when (process-live-p transport) (delete-process transport))
      (when (buffer-live-p chat) (kill-buffer chat)))))

(ert-deftest pi-orchestration-worker-close-retains-failure-and-timeout ()
  (let* ((pi-orchestration--targets (make-hash-table :test 'equal))
         (chat (generate-new-buffer " *worker-close-failure*"))
         (transport (make-pipe-process :name "worker-close-failure" :noquery t))
         (runtime '(:protocol 2 :mux-id "mux" :state "live" :placement "worker"))
         dispatch expired-dispatch timer results)
    (unwind-protect
        (cl-letf (((symbol-function 'pilish-session-runtime) (lambda (_) runtime))
                  ((symbol-function 'pilish-session-process) (lambda (_) transport))
                  ((symbol-function 'pilish-close-session) (lambda (_ settle) (setq dispatch settle)))
                  ((symbol-function 'run-at-time) (lambda (_ _ callback) (setq timer callback) nil)))
          (puthash "w" (list :kind "pi" :buffer chat :mux-id "mux" :placement "worker")
                   pi-orchestration--targets)
          (pi-orchestration-stop-target "w" (lambda (error) (push error results)))
          (funcall dispatch "rejected")
          (should (equal results '("rejected")))
          (pi-orchestration-stop-target "w" (lambda (error) (push error results)))
          (setq expired-dispatch dispatch)
          (funcall timer)
          (should (string-match-p "uncertain" (car results)))
          (should (gethash "w" pi-orchestration--targets))
          (pi-orchestration-stop-target "w" (lambda (error) (push error results)))
          (funcall expired-dispatch "late old rejection")
          (should (= (length results) 2))
          (pi-orchestration--task-finished "w" "mux" "Original failure; cleanup failed")
          (should (equal (car results) "Original failure; cleanup failed"))
          (should (buffer-live-p chat))
          (should (gethash "w" pi-orchestration--targets)))
      (when (process-live-p transport) (delete-process transport))
      (when (buffer-live-p chat) (kill-buffer chat)))))

(ert-deftest pi-orchestration-late-task-cleanup-reconciles-after-timeout ()
  (let* ((pi-orchestration--targets (make-hash-table :test 'equal))
         (target (list :kind "pi" :mux-id "mux" :exit-cleaned t
                       :stop-pending nil :stop-operation 'expired)) events
         (pi-orchestration-target-functions (list (lambda (id event) (push (list id event) events)))))
    (puthash "worker" target pi-orchestration--targets)
    (pi-orchestration--task-finished "worker" "mux" nil)
    (should-not (gethash "worker" pi-orchestration--targets))
    (should (equal events '(("worker" close))))
    (pi-orchestration--task-finished "worker" "mux" nil)
    (should (= (length events) 1))))

(ert-deftest pi-orchestration-retry-retains-prior-exit-cleanup-evidence ()
  (let* ((pi-orchestration--targets (make-hash-table :test 'equal))
         (chat (generate-new-buffer " *cleanup-retry*"))
         (transport (make-pipe-process :name "cleanup-retry" :noquery t))
         (runtime '(:protocol 2 :mux-id "mux" :state "live" :placement "worker"))
         (target (list :kind "pi" :buffer chat :mux-id "mux" :placement "worker"
                       :stop-pending nil :stop-callbacks nil :stop-timer nil
                       :stop-operation 'expired :exit-cleaned t :runtime runtime)) result)
    (unwind-protect
        (cl-letf (((symbol-function 'pilish-session-runtime) (lambda (_) runtime))
                  ((symbol-function 'pilish-session-process) (lambda (_) transport))
                  ((symbol-function 'pilish-close-session) #'ignore)
                  ((symbol-function 'pilish-reconcile-worker-task)
                   (lambda (buffer captured)
                     (should (eq buffer chat)) (should (eq captured runtime))
                     nil)))
          (puthash "w" target pi-orchestration--targets)
          (pi-orchestration-stop-target "w" (lambda (error) (setq result (or error 'success))))
          (should (plist-get target :exit-cleaned))
          (pi-orchestration--task-finished "w" "mux" nil)
          (should (eq result 'success)))
      (delete-process transport) (kill-buffer chat))))

(ert-deftest pi-orchestration-managed-panel-disposal-requires-exact-control-ack ()
  (let* ((pi-orchestration--targets (make-hash-table :test 'equal))
         (buffer (generate-new-buffer " *managed-panel-disposal*"))
         (target (list :kind "shell" :buffer buffer :panel '(:id "panel-exact"))))
    (unwind-protect
        (cl-letf (((symbol-function 'signal-process)
                   (lambda (&rest _) (ert-fail "managed cleanup cannot signal a guessed native PID"))))
          (puthash "panel" target pi-orchestration--targets)
          (should-error (pi-orchestration--close "panel" nil nil nil "replacement"))
          (should (buffer-live-p buffer))
          (should (gethash "panel" pi-orchestration--targets))
          (pi-orchestration--close "panel" nil nil nil "panel-exact")
          (should-not (buffer-live-p buffer))
          (should-not (gethash "panel" pi-orchestration--targets)))
      (when (buffer-live-p buffer) (kill-buffer buffer)))))

(ert-deftest pi-orchestration-panel-close-keeps-stderr-out-of-the-json-receipt ()
  (let* ((pi-orchestration--targets (make-hash-table :test 'equal))
         (pi-orchestration-stop-timeout 3)
         (target (list :kind "shell" :panel '(:id "exact")
                       :panel-control
                       '("/bin/sh" "-c" "printf '%s\\n' '{\"success\":true,\"id\":\"exact\",\"warning\":\"Left running outside the panel\"}'; printf 'helper diagnostic\\n' >&2")))
         settled disposed messages)
    (cl-letf (((symbol-function 'message)
               (lambda (format &rest args) (push (apply #'format-message format args) messages)))
              ((symbol-function 'pi-orchestration--close)
               (lambda (id _force _mux task-owned panel-id)
                 (should (equal id "panel")) (should task-owned)
                 (should (equal panel-id "exact"))
                 (setq disposed t))))
      (puthash "panel" target pi-orchestration--targets)
      (pi-orchestration-stop-target "panel" (lambda (error) (setq settled (list error))))
      (should (pilish-test-wait-until (lambda () settled) 3))
      (should (equal settled '(nil)))
      (should disposed)
      (should (member "Panel Close: Left running outside the panel" messages)))))

(ert-deftest pi-orchestration-fork-shortcut-preserves-the-human-draft ()
  (let ((chat (generate-new-buffer " *shortcut-chat*"))
        (input (generate-new-buffer " *shortcut-input*"))
        sent)
    (unwind-protect
        (cl-letf (((symbol-function 'pilish-session-chat-buffer) (lambda (&optional _) chat))
                  ((symbol-function 'pilish-submit-prompt)
                   (lambda (buffer text callback &optional _behavior)
                     (should (eq buffer chat))
                     (push text sent)
                     (funcall callback '(:success t)))))
          (with-current-buffer input (insert "unsent draft"))
          (dolist (pair (list (cons chat pilish-chat-mode-map)
                             (cons input pilish-input-mode-map)))
            (with-current-buffer (car pair)
              (use-local-map (cdr pair))
              (should (eq (key-binding (kbd "C-M-f")) #'pi-orchestration-fork-here))
              (call-interactively (key-binding (kbd "C-M-f")))))
          (should (equal sent '("/fork-here" "/fork-here")))
          (should (equal (with-current-buffer input (buffer-string)) "unsent draft")))
      (kill-buffer chat) (kill-buffer input))))

(ert-deftest pi-orchestration-root-environment-hook-is-local-live-and-stable ()
  (let* ((pi-orchestration--roots (make-hash-table :test 'equal))
         (chat (generate-new-buffer " *environment-chat*"))
         (server-process (make-pipe-process :name "pi-test-server" :noquery t))
         (server-name "test-server") (server-socket-dir "/tmp/synthetic-server/"))
    (unwind-protect
        (progn
          (should (memq #'pi-orchestration--session-environment pilish-session-environment-functions))
          (should (equal (pi-orchestration--session-environment chat "/tmp/project/")
                         (list (cons "PI_ORCHESTRATION_HOST" "emacs")
                               (cons "PI_ORCHESTRATION_ENDPOINT" "/tmp/synthetic-server/test-server")
                               (cons "PI_ORCHESTRATION_TARGET" (buffer-name chat)))))
          (should-not (pi-orchestration--session-environment chat "/ssh:remote:/tmp/"))
          (delete-process server-process)
          (should-not (pi-orchestration--session-environment chat "/tmp/project/")))
      (when (process-live-p server-process) (delete-process server-process))
      (kill-buffer chat))))

(ert-deftest pi-orchestration-switch-attaches-and-validates-live-runtime-without-reload ()
  (let* ((pi-orchestration--switches (make-hash-table :test 'equal))
         (chat (generate-new-buffer " *switch-runtime*"))
         (runtime '(:protocol 2 :mux-id "mux" :session-file "/tmp/synthetic.jsonl" :state "starting"))
         (pi-orchestration-show-session-function #'ignore)
         closed)
    (unwind-protect
        (cl-letf (((symbol-function 'pilish-list-runtimes) (lambda () (list runtime)))
                  ((symbol-function 'pilish-session-runtime) (lambda (_) runtime))
                  ((symbol-function 'pilish-stop-runtime)
                   (lambda (&rest _) (ert-fail "attachment cleanup cannot stop")))
                  ((symbol-function 'pilish-start-session)
                   (lambda (&rest _) (ert-fail "attachment cannot open file")))
                  ((symbol-function 'pilish-reload)
                   (lambda (&rest _) (ert-fail "attachment cannot reload")))
                  ((symbol-function 'pilish-attach-runtime) (lambda (_runtime &optional _name) chat))
                  ((symbol-function 'pilish-disconnect-session) (lambda (_) (setq closed t))))
          (let ((reply (pi-orchestration--switch
                        '(:id "s" :muxId "mux" :sessionFile "/tmp/synthetic.jsonl"))))
            (should (equal (plist-get reply :muxId) "mux")))
          (should (eq (plist-get (pi-orchestration--switch-state '(:id "s")) :ready) :json-false))
          (setf (plist-get runtime :state) "live")
          (should (eq (plist-get (pi-orchestration--switch-state '(:id "s")) :ready) t))
          ;; Failed/uncertain new-view cleanup must identify exactly this mux.
          (setf (plist-get runtime :state) "starting")
          (pi-orchestration--switch
           '(:id "failure" :muxId "mux" :sessionFile "/tmp/synthetic.jsonl"))
          (should-error (pi-orchestration--switch-state '(:id "failure" :close t :detachOnly t :muxId "other")))
          (should-not closed)
          (pi-orchestration--switch-state '(:id "failure" :close t :detachOnly t :muxId "mux"))
          (should closed)
          (should-error (pi-orchestration--switch
                         '(:id "old" :sessionFile "/tmp/synthetic.jsonl"))))
      (kill-buffer chat))))

(ert-deftest pi-orchestration-switch-reuses-existing-owner-without-changing-busy-state ()
  (let* ((pi-orchestration--switches (make-hash-table :test 'equal))
         (chat (generate-new-buffer " *existing-runtime*"))
         (runtime '(:protocol 2 :mux-id "mux" :session-file "/tmp/synthetic.jsonl" :state "live"))
         (pi-orchestration-show-session-function #'ignore))
    (unwind-protect
        (cl-letf (((symbol-function 'pilish-list-runtimes) (lambda () (list runtime)))
                  ((symbol-function 'pilish-session-runtime) (lambda (_) runtime))
                  ((symbol-function 'pilish-stop-runtime) #'ignore)
                  ((symbol-function 'pi-orchestration--session-view) (lambda (_) chat))
                  ((symbol-function 'pilish-attach-runtime)
                   (lambda (&rest _) (ert-fail "reuse existing view")))
                  ((symbol-function 'pilish-disconnect-session)
                   (lambda (&rest _) (ert-fail "cannot clean up reused view"))))
          (should (eq (plist-get
                       (pi-orchestration--switch
                        '(:id "s" :muxId "mux" :sessionFile "/tmp/synthetic.jsonl"))
                       :refreshed) t))
          (should (eq (plist-get
                       (pi-orchestration--switch-state '(:id "s" :close t :detachOnly t :muxId "mux"))
                       :ready) t))
          (setf (plist-get runtime :mux-id) "different")
          (should-error (pi-orchestration--switch
                         '(:id "x" :muxId "mux" :sessionFile "/tmp/synthetic.jsonl"))))
      (kill-buffer chat))))

(ert-deftest pi-orchestration-switch-failure-retains-only-new-view-cleanup ()
  (dolist (existing '(nil t))
    (let* ((pi-orchestration--switches (make-hash-table :test 'equal))
           (chat (generate-new-buffer " *failed-switch-view*"))
           (runtime '(:protocol 2 :mux-id "mux" :session-file "/tmp/synthetic.jsonl"
                      :state "starting"))
           (pi-orchestration-show-session-function #'ignore)
           (cleanup-fails t)
           (disconnects 0))
      (unwind-protect
          (cl-letf (((symbol-function 'pilish-list-runtimes) (lambda () (list runtime)))
                    ((symbol-function 'pilish-session-runtime) (lambda (_) runtime))
                    ((symbol-function 'pi-orchestration--session-view)
                     (lambda (_) (and existing chat)))
                    ((symbol-function 'pilish-attach-runtime)
                     (lambda (&rest _) (should-not existing) chat))
                    ((symbol-function 'pilish-stop-runtime)
                     (lambda (&rest _) (ert-fail "Attachment failure cannot stop the source")))
                    ((symbol-function 'pilish-disconnect-session)
                     (lambda (buffer)
                       (should-not existing)
                       (should (eq buffer chat))
                       (cl-incf disconnects)
                       (when cleanup-fails (error "Synthetic detach failure"))
                       (kill-buffer buffer))))
            (pi-orchestration--switch
             '(:id "failure" :muxId "mux" :sessionFile "/tmp/synthetic.jsonl"))
            (setf (plist-get runtime :state) "unavailable")
            (let ((state (pi-orchestration--switch-state '(:id "failure"))))
              (should (equal (plist-get state :failure) "Runtime is stopped or unavailable"))
              (should (eq (plist-get state :ready) :json-false)))
            (should (buffer-live-p chat))
            (should (= disconnects 0))
            (if existing
                (should-not (gethash "failure" pi-orchestration--switches))
              (should (gethash "failure" pi-orchestration--switches))
              (should-error (pi-orchestration--switch-state
                             '(:id "failure" :close t :detachOnly t :muxId "other")))
              (should (= disconnects 0))
              (should-error (pi-orchestration--switch-state
                             '(:id "failure" :close t :detachOnly t :muxId "mux"))
                            :type 'error)
              (should (= disconnects 1))
              (should (gethash "failure" pi-orchestration--switches))
              (should (buffer-live-p chat))
              (setq cleanup-fails nil)
              (pi-orchestration--switch-state
               '(:id "failure" :close t :detachOnly t :muxId "mux"))
              (should (= disconnects 2))
              (should-not (buffer-live-p chat))
              (should-not (gethash "failure" pi-orchestration--switches))))
        (when (buffer-live-p chat) (kill-buffer chat))))))

(ert-deftest pi-orchestration-panel-command-completion-is-not-wrapper-exit ()
  (let* ((pi-orchestration--targets (make-hash-table :test 'equal))
         (directory (make-temp-file "panel-command-state-" t))
         (file (expand-file-name "state.json" directory))
         (buffer (generate-new-buffer " *command-state*"))
         (process (make-pipe-process :name "panel-owner-alive" :noquery t)))
    (unwind-protect
        (progn
          (puthash "panel" (list :kind "shell" :buffer buffer :process process
                                :panel (list :id "owned" :directory directory))
                   pi-orchestration--targets)
          (dolist (command '("held" "running" "exited"))
            (with-temp-file file
              (insert (json-encode (list :schema 1 :id "owned" :command command))))
            (set-file-modes file #o600)
            (should (process-live-p process))
            (should (equal (pi-orchestration-panel-command-state buffer) command))
            (should (equal (plist-get (car (pi-orchestration-targets)) :command-state) command)))
          (set-file-modes file #o644)
          (should (equal (pi-orchestration-panel-command-state buffer) "unknown"))
          (with-temp-file file (insert "{\"schema\":1,\"id\":\"replacement\",\"command\":\"exited\"}"))
          (set-file-modes file #o600)
          (should (equal (pi-orchestration-panel-command-state buffer) "unknown"))
          (should-not (pi-orchestration-panel-command-state (current-buffer))))
      (delete-process process)
      (kill-buffer buffer)
      (delete-directory directory t))))

(provide 'pi-orchestration-test)
;;; pi-orchestration-test.el ends here
