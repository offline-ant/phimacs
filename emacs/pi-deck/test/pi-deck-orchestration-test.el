;;; pi-deck-orchestration-test.el --- Orchestration tests -*- lexical-binding: t; -*-

;; SPDX-License-Identifier: MIT

;;; Commentary:

;; Forks, workers, panels, waiting workers and finished-worker records.
;; Fixtures: pi-deck-test-fixtures.el.

;;; Code:

(require 'pi-deck-test-fixtures)

;;;; Orchestration

(ert-deftest pi-deck-test-forks-join-their-parent-space ()
  (require 'pi-orchestration)
  (pi-deck-test--with-deck
    (pi-deck-create-space dir "space")
    (let ((pi-orchestration--targets (make-hash-table :test 'equal))
          (parent (pi-deck-test--session dir "root"))
          attached)
      (switch-to-buffer parent)
      ;; This is a placement-only test. The host receives an already committed
      ;; launcher receipt and actual Pi identity, then attaches a public view.
      ;; It must not start a writer or substitute the transport process's PID.
      (cl-letf (((symbol-function 'pilish-start-session)
                 (lambda (&rest _) (ert-fail "Placement attached a runtime by starting Pi")))
                ((symbol-function 'pilish-attach-runtime)
                 (lambda (runtime &optional name)
                   (should (equal (plist-get runtime :protocol) 2))
                   (should (equal (plist-get runtime :directory) "/tmp/"))
                   (should (equal (plist-get runtime :pi-start-time) "12345"))
                   (should (equal (plist-get runtime :pi-boot-id)
                                  "00000000-0000-4000-8000-000000000003"))
                   (push (copy-tree runtime) attached)
                   (let ((chat (pi-deck-test--session (plist-get runtime :directory) name)))
                     (with-current-buffer chat
                       ;; A complete public snapshot/live boundary reports live,
                       ;; never the old host's mismatched connected spelling.
                       (setq pi-deck-test--runtime (plist-put (copy-tree runtime) :state "live")
                             pilish--state (plist-put pilish--state :session-file
                                                      (plist-get runtime :session-file))))
                     chat))))
        (unwind-protect
            (progn
              (dolist (spec '(("fork-1" "interactive-fork" 12001 11001)
                              ("do-1" "worker" 12002 11002)))
                (let* ((name (car spec))
                       (file (expand-file-name (concat name ".jsonl") dir))
                       (identity (list :pid (nth 2 spec) :startTime "12345"
                                       :bootId "00000000-0000-4000-8000-000000000003"))
                       (receipt (list :protocol 2 :operationId (concat "operation-" name)
                                      :muxId (concat "mux-" name)
                                      :socket (expand-file-name (concat name ".sock") dir)
                                      :pid (nth 3 spec) :piPid (plist-get identity :pid)
                                      :sessionFile file :state "committed" :outcome "started")))
                  (pi-orchestration--start
                   (list :id name :endpoint "test"
                         :spec (list :kind "pi" :name name :cwd "/tmp/" :placement (cadr spec)
                                     :sessionFile file :runtime receipt :process identity
                                     :parent (list :id (pi-orchestration--root-id parent)))))))
              (should (equal (mapcar (lambda (runtime) (plist-get runtime :mux-id))
                                    (reverse attached))
                             '("mux-fork-1" "mux-do-1")))
              (should (equal (mapcar (lambda (runtime) (plist-get runtime :pi-pid))
                                    (reverse attached))
                             '(12001 12002)))
              (pi-deck-test--settle)
              ;; Neither gets a layout of its own or a pane.
              (should (= (length (tab-bar-tabs)) 1))
              (should (one-window-p))
              (should (eq (window-buffer) parent))
              (let ((fork (pi-deck-agent (plist-get (pi-orchestration--target "fork-1") :buffer))))
                (should (equal (pi-deck-agent-assigned-space fork) "space"))
                (should-not (pi-deck-agent-worker-p fork)))
              (let ((worker (plist-get (pi-orchestration--target "do-1") :buffer)))
                (should (pi-deck-agent-worker-p (pi-deck-agent worker)))
                (should (equal (pi-deck-agent-space (pi-deck-agent worker)) "space"))
                ;; A finished worker does not notify.
                (setq pi-deck-test--notifications nil)
                (pi-deck-test--phase worker "thinking")
                (pi-deck-test--phase worker "idle")
                (should-not pi-deck-test--notifications)))
          (maphash (lambda (id _) (pi-orchestration--close id t)) pi-orchestration--targets))))))

(ert-deftest pi-deck-test-orchestration-workers-nest-under-parent ()
  (require 'pi-orchestration)
  (pi-deck-test--with-deck
    (pi-deck-create-space dir "space")
    (let* ((pi-orchestration--targets (make-hash-table :test 'equal))
           (parent (pi-deck-test--session dir "root")))
      (unwind-protect
          (progn
            (pi-orchestration--start
             (list :id "panel-1" :endpoint "test"
                   :spec (list :kind "shell" :name "build" :cwd "/tmp/"
                               :parent (list :id (pi-orchestration--root-id parent))
                               :argv ["/bin/sh" "-c" "read line"])))
            (let ((panel (pi-deck-agent (plist-get (pi-orchestration--target "panel-1") :buffer))))
              (should panel)
              (should (eq (pi-deck-agent-parent panel) parent))
              (should (equal (pi-deck-agent-target panel) "panel-1"))
              (should (equal (pi-deck-agent-space panel) "space"))
              (let ((saved (pi-deck--agent-record panel (pi-deck-tab-index))))
                (should (eq (plist-get saved :kind) 'shell))
                (should (equal (plist-get saved :target) "panel-1"))
                (should (equal (plist-get saved :parent) (buffer-name parent))))
              ;; A session move renames the parent's chat: the link stays.
              (let ((name (buffer-name parent)))
                (with-current-buffer parent (rename-buffer "*pilish-chat:/moved/*"))
                (pi-deck-refresh)
                (should (eq (pi-deck-agent-parent panel) parent))
                (with-current-buffer parent (rename-buffer name)))
              (with-current-buffer (pi-deck-sidebar-buffer)
                (pi-deck-sidebar-refresh)
                (should (string-match-p "○ root .*\n   [^ \n]+ build "
                                        (buffer-substring-no-properties (point-min) (point-max)))))))
        (pi-orchestration--close "panel-1")))))

(ert-deftest pi-deck-test-panels-open-beside-their-parent-and-close ()
  (require 'pi-orchestration)
  (pi-deck-test--with-deck
    (pi-deck-create-space dir "space")
    (let* ((pi-orchestration--targets (make-hash-table :test 'equal))
           (parent (pi-deck-test--session dir "root"))
           (start (lambda (id)
                    (pi-orchestration--start
                     (list :id id :endpoint "test"
                           :spec (list :kind "shell" :name id :cwd "/tmp/"
                                       :parent (list :id (pi-orchestration--root-id parent))
                                       :argv ["/bin/sh" "-c" "read line"])))
                    (plist-get (pi-orchestration--target id) :buffer))))
      (unwind-protect
          (progn
            ;; The parent is on screen: the panel takes half of its pane, to the
            ;; right when the pane is at least twice as wide as high, unfocused.
            (switch-to-buffer parent)
            (let ((panel (funcall start "p1"))
                  (direction (pi-deck--panel-direction (selected-window))))
              (should (pi-deck-test--wait (lambda () (get-buffer-window panel))))
              (should (eq (window-buffer) parent))
              ;; The panel starts where the parent's pane ends.
              (let ((pane (window-edges (pi-deck--pane-of (get-buffer-window parent))))
                    (edges (window-edges (get-buffer-window panel)))
                    (side (if (eq direction 'right) 0 1)))
                (should (= (nth side edges) (nth (+ side 2) pane))))
              (pi-orchestration--close "p1")
              (should (= 1 (length (window-list nil 'no-minibuf)))))
            ;; The parent is not on screen: the panel is only listed, in
            ;; its parent's space, until it is revealed.
            (switch-to-buffer "*scratch*")
            (let ((panel (funcall start "p2")))
              (pi-deck-test--settle)
              (should-not (get-buffer-window panel))
              (should (= (length (tab-bar-tabs)) 1))
              (should (equal (pi-deck-agent-space (pi-deck-agent panel)) "space"))
              (pi-deck-reveal (pi-deck-agent panel))
              (should (eq (window-buffer) panel))
              ;; When Pi closes it, its pane goes.
              (pi-orchestration--close "p2")
              (should (one-window-p))
              (should (pi-deck-test--in-dired-p))))
        (maphash (lambda (id _) (pi-orchestration--close id t)) pi-orchestration--targets)))))

(defun pi-deck-test--waiting (chat text)
  "Set the worker status of CHAT to TEXT as Pi's RPC does."
  (with-current-buffer chat
    (pilish--extension-ui-set-status
     (list :statusKey "worker-frame" :statusText text))))

(ert-deftest pi-deck-test-waiting-worker-needs-attention ()
  "An interrupted worker is blocked until a new run changes its status."
  (pi-deck-test--with-deck
    (pi-deck-create-space dir "space")
    (let* ((parent (pi-deck-test--session dir "root"))
           (worker (pi-deck-test--session dir "do-1"))
           (agent (pi-deck-agent worker))
           (pilish-extension-status-functions
            (list #'pi-deck--on-extension-status)))
      (setf (pi-deck-agent-parent agent) parent
            (pi-deck-agent-target agent) "t-1")
      (should (eq (pi-deck-agent-state agent) 'idle))
      (pi-deck-test--waiting worker "worker:auto")
      (should (eq (pi-deck-agent-state agent) 'idle))
      (should-not (pi-deck-agent-detail agent))
      (let ((pi-deck-agent-change-functions (list #'pi-deck-notify-transition)))
        (pi-deck-test--waiting worker "worker:waiting · interrupted"))
      (should (eq (pi-deck-agent-status agent) 'blocked))
      (should (equal (pi-deck-agent-detail agent) "waiting for you"))
      (should (equal (car (car pi-deck-test--notifications)) "do-1 needs attention"))
      (should (equal (cadr (car pi-deck-test--notifications)) "waiting for you"))
      (should (memq agent (pi-deck--attention-agents)))
      (with-current-buffer (pi-deck-sidebar-buffer)
        (pi-deck-sidebar-refresh)
        (should (string-match-p "◉ do-1" (buffer-string))))
      ;; Other extensions' statuses are not read as waiting.
      (with-current-buffer worker
        (pilish--extension-ui-set-status
         '(:statusKey "other" :statusText "worker:waiting")))
      ;; A new run sets another status.
      (pi-deck-test--waiting worker "worker:auto")
      (should (eq (pi-deck-agent-state agent) 'idle))
      (with-current-buffer worker
        (pilish--extension-ui-set-status
         '(:statusKey "other" :statusText "worker:waiting")))
      (should (eq (pi-deck-agent-state agent) 'idle))
      ;; A shared process's snapshot clears a status it did not replay.
      (pi-deck-test--waiting worker "worker:waiting · interrupted")
      (should (eq (pi-deck-agent-state agent) 'blocked))
      (pi-deck-test--waiting worker nil)
      (should (eq (pi-deck-agent-state agent) 'idle)))))

(ert-deftest pi-deck-test-session-identity-change-is-saved ()
  "A session replaced in place, also by another frontend, is saved."
  (pi-deck-test--with-deck
    (pi-deck-create-space dir "space")
    (let* ((chat (pi-deck-test--session dir "root"))
           (pi-deck-save-delay 1000)
           (pilish-session-identity-functions (list #'pi-deck--on-session-identity)))
      (pi-deck--save-now)
      (should-not pi-deck--save-timer)
      (with-current-buffer chat
        (pilish--note-session-identity)
        (pi-deck--save-now)
        (setq pilish--state (plist-put pilish--state :session-file
                                       (expand-file-name "other.jsonl" dir)))
        (pilish--note-session-identity))
      (should pi-deck--save-timer)
      (pi-deck--save-now)
      (should (equal (plist-get (car (plist-get (pi-deck-read-state) :agents)) :session-file)
                     (expand-file-name "other.jsonl" dir))))))

(ert-deftest pi-deck-test-mode-listens-to-session-identity ()
  (should (member '(pilish-session-identity-functions . pi-deck--on-session-identity)
                  pi-deck--hooks)))

(ert-deftest pi-deck-test-mode-listens-to-extension-status ()
  (should (member '(pilish-extension-status-functions . pi-deck--on-extension-status)
                  pi-deck--hooks)))

(ert-deftest pi-deck-test-dialog-detail-beats-waiting ()
  "A question names itself even when the worker also waits."
  (pi-deck-test--with-deck
    (let* ((worker (pi-deck-test--session dir "do-1"))
           (agent (pi-deck-agent worker)))
      (pi-deck-test--waiting worker "worker:waiting")
      (cl-letf (((symbol-function 'message) #'ignore))
        (with-current-buffer worker
          (pilish--handle-extension-ui-request
           '(:type "extension_ui_request" :id "q" :method "input" :title "Name"))))
      (should (equal (pi-deck-agent-detail agent) "asks: Name")))))

(ert-deftest pi-deck-test-resume-finished-worker ()
  "Resume opens the session in a new pane of the parent's space, once."
  (pi-deck-test--with-deck
    (pi-deck-create-space dir "space")
    (let* ((parent (pi-deck-test--session dir "root"))
           (record (pi-deck-test--finished-worker dir parent "do-1"))
           (file (plist-get record :session-file))
           (other (make-temp-file "pi-deck-other-" t))
           started)
      (should (equal (plist-get record :directory) (file-name-as-directory dir)))
      (setf (pi-deck-agent-assigned-space (pi-deck-agent parent)) "space")
      (pi-deck--display-agent-in-window (pi-deck-agent parent) (selected-window))
      (pi-deck-create-space other "elsewhere")
      (should (equal (pi-deck-current-space) "elsewhere"))
      (cl-letf (((symbol-function 'pilish-start-session)
                 (lambda (directory name &rest options)
                   (push (list directory name options) started)
                   (let ((chat (pi-deck-test--session directory name)))
                     (with-current-buffer chat
                       (setq pilish--state
                             (plist-put pilish--state :session-file
                                        (plist-get options :session-file))))
                     chat))))
        (let ((agent (pi-deck-resume-finished-worker record)))
          (should (equal started (list (list (file-name-as-directory dir) "1"
                                             (list :session-file file)))))
          (should (equal (pi-deck-agent-space agent) "space"))
          (should (equal (pi-deck-current-space) "space"))
          (should-not (pi-deck-agent-worker-p agent))
          (should (pi-deck--input-or-chat-window agent))
          ;; The parent stays on screen beside it.
          (should (pi-deck--input-or-chat-window (pi-deck-agent parent)))
          ;; A second resume jumps instead of starting a second session.
          (pi-deck-select-space "elsewhere")
          (should (eq (pi-deck-resume-finished-worker record) agent))
          (should (equal (pi-deck-current-space) "space"))
          (should (= (length started) 1)))))))

(ert-deftest pi-deck-test-resume-needs-the-session-and-directory ()
  (pi-deck-test--with-deck
    (cl-letf (((symbol-function 'pilish-start-session)
               (lambda (&rest _) (ert-fail "Started a session"))))
      (should-error (pi-deck-resume-finished-worker
                     (list :name "do-1" :session-file (expand-file-name "gone.jsonl" dir)
                           :directory dir))
                    :type 'user-error)
      (let ((file (expand-file-name "there.jsonl" dir)))
        (write-region "" nil file)
        (should-error (pi-deck-resume-finished-worker
                       (list :name "do-1" :session-file file
                             :directory (expand-file-name "gone" dir)))
                      :type 'user-error)))))

(defun pi-deck-test--write-session (file age &rest entries)
  "Write session FILE of JSON ENTRIES, last modified AGE seconds ago."
  (with-temp-file file
    (dolist (entry entries)
      (insert (json-serialize entry) "\n")))
  (set-file-times file (time-subtract nil age))
  file)

(defun pi-deck-test--with-session-file (chat file)
  "Make fake CHAT report session FILE; return CHAT."
  (with-current-buffer chat
    (setq pilish--state (plist-put pilish--state :session-file file)))
  chat)

(ert-deftest pi-deck-test-reopen-agent ()
  "Reopen picks the space's newest closed top-level session, workers excluded."
  (pi-deck-test--with-deck
    ;; Pi's flat custom session directory holds every cwd's sessions.
    (let* ((process-environment
            (cons (format "PI_CODING_AGENT_SESSION_DIR=%s" (expand-file-name "sessions" dir))
                  process-environment))
           (project (file-name-as-directory (file-truename (expand-file-name "project" dir))))
           (cwd (directory-file-name project))
           (sessions (pilish-jsonl-session-directory cwd))
           (path (lambda (name) (expand-file-name (format "%s.jsonl" name) sessions)))
           (header (lambda (&optional parent at)
                     `(:type "session" :version 3 :id "s" :cwd ,(or at cwd)
                       ,@(and parent (list :parentSession parent)))))
           (runtime-marker (lambda (child)
                             `(:type "custom" :customType "pi-orchestration:delegate-runtime"
                               :data (:childSession ,child))))
           (prompt '(:type "message" :message (:role "user" :content "hi")))
           (root (funcall path "root"))
           (fork (funcall path "fork"))
           (open (funcall path "open"))
           (runtimes nil)
           started)
      (make-directory project)
      (make-directory sessions t)
      ;; Newest first: open, do worker, delegate worker, subdirectory, fork, root.
      (pi-deck-test--write-session open 1 (funcall header))
      (pi-deck-test--write-session (funcall path "do") 2 (funcall header root) prompt
                                   (funcall runtime-marker (funcall path "do")))
      (pi-deck-test--write-session (funcall path "delegate") 3 (funcall header)
                                   '(:type "custom" :customType "pi-orchestration:delegate"))
      (pi-deck-test--write-session (funcall path "sub") 4
                                   (funcall header nil (expand-file-name "sub" project)))
      ;; A fork of a worker keeps the worker's marker naming another child.
      (pi-deck-test--write-session fork 5 (funcall header root)
                                   (funcall runtime-marker (funcall path "do"))
                                   '(:type "custom" :customType "pi-orchestration:fork"))
      (pi-deck-test--write-session root 6 (funcall header) prompt)
      (pi-deck-create-space project "space")
      ;; An idle tracked agent counts as open.
      (pi-deck-test--with-session-file (pi-deck-test--session project "open") open)
      (cl-letf (((symbol-function 'pilish-runtime-configured-p) (lambda () t))
                ((symbol-function 'pilish-list-runtimes) (lambda () runtimes))
                ((symbol-function 'pilish-start-session)
                 (lambda (directory name &rest options)
                   (push (list directory name options) started)
                   (pi-deck-test--with-session-file (pi-deck-test--session directory name)
                                                    (plist-get options :session-file))))
                ((symbol-function 'pilish-attach-runtime)
                 (lambda (runtime &optional _name)
                   (pi-deck-test--with-session-file (pi-deck-test--session project "tau")
                                                    (plist-get runtime :session-file)))))
        (let ((agent (pi-deck-reopen-agent)))
          (should (equal started (list (list project "1" (list :session-file fork)))))
          (should (equal (pi-deck-agent-space agent) "space"))
          (should (pi-deck--input-or-chat-window agent)))
        ;; A live runtime without a view here is attached, not started again.
        (setq runtimes (list (list :protocol 2 :mux-id "tau" :session-file root :state "live")))
        (let ((agent (pi-deck-reopen-agent)))
          (should (= (length started) 1))
          (should (equal (pi-deck-agent-session-file agent) root))
          (should (equal (pi-deck-agent-space agent) "space")))
        (should-error (pi-deck-reopen-agent) :type 'user-error)))))

(ert-deftest pi-deck-test-closed-workers-are-hidden-and-readable ()
  (pi-deck-test--with-deck
    (pi-deck-create-space dir "space")
    (let* ((parent (pi-deck-test--session dir "root"))
           (worker (pi-deck-test--session dir "do-1"))
           (file (expand-file-name "do-1.jsonl" dir))
           opened)
      (with-temp-file file
        (insert "{\"type\":\"session\",\"version\":3,\"id\":\"s-1\",\"cwd\":\"/tmp\"}\n"))
      (setf (pi-deck-agent-parent (pi-deck-agent worker)) parent
            (pi-deck-agent-target (pi-deck-agent worker)) "t-1")
      (let ((pilish-quit-without-confirmation t))
        (delete-process (pilish-session-process worker))
        (kill-buffer (pilish-session-input-buffer worker))
        (kill-buffer worker))
      (should-not (cl-find "do-1" (pi-deck-agents) :key #'pi-deck-agent-name :test #'equal))
      (should (equal (mapcar (lambda (record) (plist-get record :name))
                             (pi-deck-finished-workers parent))
                     '("do-1")))
      (with-current-buffer (pi-deck-sidebar-buffer)
        (pi-deck-sidebar-refresh)
        (goto-char (point-min))
        (should (search-forward "▸ 1 finished worker" nil t))
        (goto-char (point-min))
        (should (search-forward "1 finished worker" nil t))
        (should-not (string-match-p "✓ do-1" (buffer-string)))
        (pi-deck-sidebar-jump)
        (should (search-forward "✓ do-1" nil t))
        (cl-letf (((symbol-function 'pilish-open-subagent-snapshot)
                   (lambda (target) (setq opened target))))
          (pi-deck-sidebar-jump)))
      (should (equal (pilish--snapshot-target-session-id opened) "s-1"))
      (should (equal (pilish--snapshot-target-file opened) "do-1.jsonl"))
      ;; Closing the parent forgets its workers.
      (let ((pilish-quit-without-confirmation t))
        (delete-process (pilish-session-process parent))
        (kill-buffer parent))
      (should-not pi-deck--finished-workers))))

(ert-deftest pi-deck-test-clear-finished-workers ()
  (pi-deck-test--with-large-frame
   (let ((dir (make-temp-file "pi-deck-test-" t)))
     (pi-deck-test--with-deck
      (pi-deck-create-space dir "space")
      (let* ((parent (pi-deck-test--session dir "parent"))
             (other (pi-deck-test--session dir "other"))
             (record (pi-deck-test--finished-worker dir parent "do-1"))
             (other-record (pi-deck-test--finished-worker dir other "do-2")))
        (pi-deck-test--finished-worker dir parent "do-3")
        (pi-deck-sidebar-toggle)
        (let* ((sidebar (get-buffer-window pi-deck-sidebar-buffer-name))
               (buffer (window-buffer sidebar))
               (clear (lambda (chat)
                        (with-current-buffer buffer
                          (let ((row (text-property-any (point-min) (point-max)
                                                        'pi-deck-finished chat)))
                            (next-single-property-change row 'pi-deck-button))))))
          (with-current-buffer buffer
            (pi-deck-sidebar-refresh)
            (goto-char (text-property-any (point-min) (point-max) 'pi-deck-finished parent))
            (pi-deck-sidebar-toggle-fold)
            (should (string-match-p "✓ do-1" (buffer-string))))
          ;; The ✕ clears only its parent's list, without opening anything.
          (should (eq (get-text-property (funcall clear parent) 'pi-deck-button buffer)
                      'clear-workers))
          (should (string-match-p "^ *▾ 2 finished workers +✕$"
                                  (with-current-buffer buffer (buffer-string))))
          (let ((window (selected-window)))
            (pi-deck-sidebar-mouse-1 (pi-deck-test--click sidebar (funcall clear parent)))
            (should (eq (selected-window) window)))
          (should-not (pi-deck-finished-workers parent))
          (should (equal (pi-deck-finished-workers other) (list other-record)))
          (with-current-buffer buffer
            (should-not (string-match-p "do-1\\|2 finished" (buffer-string)))
            (should (string-match-p "1 finished worker" (buffer-string)))
            (should-not pi-deck-sidebar--expanded-workers))
          (should (file-readable-p (plist-get record :session-file)))
          ;; The next worker of the parent starts folded again.
          (pi-deck-test--finished-worker dir parent "do-4")
          (with-current-buffer buffer
            (pi-deck-sidebar-refresh)
            (should (string-match-p "▸ 1 finished worker" (buffer-string))))))))))

(ert-deftest pi-deck-test-finished-shells ()
  (pi-deck-test--with-large-frame
   (let ((dir (make-temp-file "pi-deck-test-" t)))
     (pi-deck-test--with-deck
      (pi-deck-create-space dir "space")
      (let* ((one (pi-deck-start-shell dir "shell:one" '("/bin/sh" "-c" "true")))
             (two (pi-deck-start-shell dir "shell:two" '("/bin/sh" "-c" "true")))
             (live (pi-deck-start-shell dir "shell:live" '("/bin/sh" "-c" "read a"))))
        (should (pi-deck-test--wait
                 (lambda () (pi-deck-refresh)
                   (not (or (get-buffer-process one) (get-buffer-process two))))))
        (pi-deck-sidebar-toggle)
        (let* ((sidebar (get-buffer-window pi-deck-sidebar-buffer-name))
               (buffer (window-buffer sidebar))
               (text (lambda ()
                       (with-current-buffer buffer
                         (pi-deck-sidebar-refresh)
                         (buffer-substring-no-properties (point-min) (point-max))))))
          ;; Ended shells fold into one row at the end of their space; the
          ;; live one stays a row of its own.
          (should (string-match-p "^ . shell:live.*\n ▸ 2 finished shells +✕\n\n\\+ New space"
                                  (funcall text)))
          (should-not (string-match-p "exited" (funcall text)))
          (with-current-buffer buffer
            (goto-char (text-property-not-all (point-min) (point-max)
                                              'pi-deck-finished-shells nil))
            (pi-deck-sidebar-jump))
          (should (string-match-p "▾ 2 finished shells" (funcall text)))
          (should (= 2 (with-current-buffer buffer
                         (how-many "exited 0" (point-min) (point-max)))))
          ;; A shown shell keeps its row's ✕ and jump.
          (with-current-buffer buffer
            (should (text-property-any (point-min) (point-max)
                                       'pi-deck-agent (pi-deck-agent one))))
          ;; The ✕ closes the ended shells only and leaves the list folded.
          (let ((clear (with-current-buffer buffer
                         (text-property-any (point-min) (point-max)
                                            'pi-deck-button 'close-shells))))
            (pi-deck-sidebar-mouse-1 (pi-deck-test--click sidebar clear)))
          (should-not (or (buffer-live-p one) (buffer-live-p two)))
          (should (buffer-live-p live))
          (should-not (string-match-p "finished shell" (funcall text)))
          (should-not (buffer-local-value 'pi-deck-sidebar--expanded-shells buffer))))))))

(provide 'pi-deck-orchestration-test)
;;; pi-deck-orchestration-test.el ends here
