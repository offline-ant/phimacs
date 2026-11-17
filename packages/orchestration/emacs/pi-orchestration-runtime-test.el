;;; pi-orchestration-runtime-test.el --- Pinned Pilish socket contracts -*- lexical-binding: t; -*-
;; SPDX-License-Identifier: MIT

;;; Commentary:
;; Exercise public APIs against a synthetic peer, never a user's daemon.

;;; Code:

(require 'pi-orchestration)
(require 'pilish-runtime-test)

(ert-deftest pi-orchestration-readiness-follows-the-public-live-boundary ()
  (pilish-runtime-test--with-peer '(:no-live t)
    (cl-letf (((symbol-function 'pilish-list-runtimes) (lambda () (list runtime))))
      (setq pilish-runtime-test--chat (pilish-attach-runtime runtime "readiness"))
      (pilish-runtime-test--wait
       (lambda () (and pilish-runtime-test--clients
                       (equal (pilish-session-file pilish-runtime-test--chat) file)
                       (equal (plist-get (pilish-session-runtime pilish-runtime-test--chat) :state)
                              "synchronizing"))))
      (should-not (pi-orchestration--view-ready-p pilish-runtime-test--chat "test-runtime"))
      (dolist (client pilish-runtime-test--clients)
        (process-send-string client "{\"type\":\"pimux_live\",\"generation\":1}\n"))
      (pilish-runtime-test--wait
       (lambda () (equal (plist-get (pilish-session-runtime pilish-runtime-test--chat) :state)
                         "live")))
      (should (pi-orchestration--view-ready-p pilish-runtime-test--chat "test-runtime"))
      (should-not (pi-orchestration--view-ready-p pilish-runtime-test--chat "another-runtime"))
      (should-not (pi-orchestration-test--sent-input)))))

(defun pi-orchestration-test--command-types ()
  "Return the types of every synthetic-peer command, oldest first."
  (mapcar (lambda (line) (plist-get (json-parse-string line :object-type 'plist) :type))
          (split-string (mapconcat #'identity (reverse pilish-runtime-test--received) "")
                        "\n" t)))

(defun pi-orchestration-test--sent-input ()
  "Return command types other than read-only `get_commands' discovery."
  (remove "get_commands" (pi-orchestration-test--command-types)))

(defun pi-orchestration-test--command ()
  "Read the latest complete synthetic-peer command."
  (json-parse-string
   (car (last (split-string
               (mapconcat #'identity (reverse pilish-runtime-test--received) "") "\n" t)))
   :object-type 'plist))

(defun pi-orchestration-test--task-record (runtime state)
  "Return identity-bearing read-only task evidence for synthetic RUNTIME."
  (let ((worker (list :pid (plist-get runtime :pi-pid)
                      :startTime (plist-get runtime :pi-start-time)
                      :bootId (plist-get runtime :pi-boot-id))))
    (list :schema 1 :muxId (plist-get runtime :mux-id) :worker worker
          :parent (list :process worker :taskId "test-owning-task")
          :leaseFile (expand-file-name "parent-task.json" (plist-get runtime :directory))
          :state state)))

(ert-deftest pi-orchestration-worker-close-requires-advertised-cancellation ()
  (dolist (advertised '(nil t))
    (pilish-runtime-test--with-peer
        (list :commands (if advertised [(:name "worker-cancel" :source "extension")] []))
      (setq runtime (plist-put runtime :placement "worker"))
      (let ((pi-orchestration--targets (make-hash-table :test 'equal))
            (evidence (pi-orchestration-test--task-record runtime "pending")) settled)
        (cl-letf (((symbol-function 'pilish-list-runtimes) (lambda () (list runtime)))
                  ;; Task filesystem permissions/validation belong to Pilish's
                  ;; owning reader tests. Keep its public Close and real RPC.
                  ((symbol-function 'pilish--runtime-task-read)
                   (lambda (_) (copy-tree evidence))))
          (setq pilish-runtime-test--chat (pilish-attach-runtime runtime "task-worker"))
          (pilish-runtime-test--wait
           (lambda () (equal (plist-get (pilish-session-runtime pilish-runtime-test--chat) :state)
                             "live")))
          (puthash "worker" (list :kind "pi" :name "do-test" :placement "worker"
                                 :buffer pilish-runtime-test--chat :mux-id "test-runtime"
                                 :runtime (copy-tree runtime) :owns-view t)
                   pi-orchestration--targets)
          (pi-orchestration-stop-target "worker" (lambda (error) (push error settled)))
          (if advertised
              (progn
                (pilish-runtime-test--wait
                 (lambda () (and pilish-runtime-test--received
                                 (equal (plist-get (pi-orchestration-test--command) :type) "prompt"))))
                (let ((command (pi-orchestration-test--command)))
                  (should (equal (plist-get command :type) "prompt"))
                  (should (equal (plist-get command :message) "/worker-cancel"))
                  (dolist (client pilish-runtime-test--clients)
                    (process-send-string
                     client (concat (json-encode (list :type "response" :command "prompt"
                                                      :id (plist-get command :id) :success t)) "\n"))))
                (accept-process-output nil 0.02)
                (should-not settled)
                (pi-orchestration--close "worker" nil "test-runtime" t)
                (should-not settled)
                (setq evidence (plist-put evidence :state "complete"))
                (pi-orchestration--task-finished "worker" "test-runtime" nil)
                (should (equal settled '(nil))))
            (pilish-runtime-test--wait (lambda () settled))
            (should (string-match-p "advertise" (car settled)))
            ;; Only read-only discovery reached Pi: no cancellation prompt.
            (should (member "get_commands" (pi-orchestration-test--command-types)))
            (should-not (pi-orchestration-test--sent-input))
            (should (gethash "worker" pi-orchestration--targets)))
          (should (eq (buffer-live-p pilish-runtime-test--chat) (not advertised))))))))

(ert-deftest pi-orchestration-direct-pilish-close-defers-worker-view-until-final-task ()
  (pilish-runtime-test--with-peer '(:commands [(:name "worker-cancel" :source "extension")])
    (setq runtime (plist-put runtime :placement "worker"))
    (let ((pi-orchestration--targets (make-hash-table :test 'equal))
          (evidence (pi-orchestration-test--task-record runtime "pending")) settled)
      (cl-letf (((symbol-function 'pilish-list-runtimes) (lambda () (list runtime)))
                ((symbol-function 'pilish--runtime-task-read) (lambda (_) (copy-tree evidence)))
                ((symbol-function 'yes-or-no-p) (lambda (&rest _) (ert-fail "Close cannot ask")))
                ((symbol-function 'y-or-n-p) (lambda (&rest _) (ert-fail "Close cannot ask"))))
        (setq pilish-runtime-test--chat (pilish-attach-runtime runtime "direct-worker-close"))
        (pilish-runtime-test--wait
         (lambda () (equal (plist-get (pilish-session-runtime pilish-runtime-test--chat) :state) "live")))
        (let ((target (list :kind "pi" :name "direct-worker" :placement "worker"
                            :buffer pilish-runtime-test--chat :mux-id "test-runtime"
                            :runtime (copy-tree runtime) :owns-view t)))
          (puthash "worker" target pi-orchestration--targets)
          ;; This does not call pi-orchestration-stop-target, so the companion
          ;; has neither a pending waiter nor a local Close operation marker.
          (pilish-close-session pilish-runtime-test--chat (lambda (error) (push error settled)))
          (pilish-runtime-test--wait
           (lambda () (and pilish-runtime-test--received
                           (equal (plist-get (pi-orchestration-test--command) :type) "prompt"))))
          (let ((command (pi-orchestration-test--command)))
            (should (equal (plist-get command :message) "/worker-cancel"))
            (dolist (client pilish-runtime-test--clients)
              (process-send-string client
                                   (concat (json-encode (list :type "response" :command "prompt"
                                                              :id (plist-get command :id) :success t)) "\n"))))
          (dolist (client pilish-runtime-test--clients)
            (process-send-string client "{\"type\":\"pimux_exit\",\"code\":0,\"signal\":null}\n"))
          (pilish-runtime-test--wait
           (lambda () (equal (plist-get (pilish-session-runtime pilish-runtime-test--chat) :state) "stopped")))
          (should (buffer-live-p pilish-runtime-test--chat))
          (should-not settled)
          (should-not (plist-get target :stop-pending))
          (should-not (plist-get target :stop-operation))
          ;; Parent-owned runtime exit is not final task cleanup/name release.
          (pi-orchestration--close "worker" nil "test-runtime" t)
          (should (eq target (gethash "worker" pi-orchestration--targets)))
          (should (plist-get target :exit-cleaned))
          (should (buffer-live-p pilish-runtime-test--chat))
          (should-not settled)
          (setq evidence (plist-put evidence :state "complete"))
          (pi-orchestration--task-finished "worker" "test-runtime" nil)
          (pilish-runtime-test--wait (lambda () settled))
          (should (equal settled '(nil)))
          (should-not (buffer-live-p pilish-runtime-test--chat))
          (should-not (gethash "worker" pi-orchestration--targets))
          (let* ((lines (split-string (mapconcat #'identity
                                                 (reverse pilish-runtime-test--received) "") "\n" t))
                 (prompts (cl-count-if
                           (lambda (line) (equal (plist-get (json-parse-string line :object-type 'plist) :type)
                                                 "prompt")) lines)))
            (should (= prompts 1))))))))

(ert-deftest pi-orchestration-disconnected-worker-natural-completion-retires-retained-view ()
  (pilish-runtime-test--with-worker nil
    (let* ((pi-orchestration--targets (make-hash-table :test 'equal)) events
           (pi-orchestration-target-functions
           (list (lambda (id event) (push (list id event) events)))))
      (cl-letf (((symbol-function 'pilish-list-runtimes) (lambda () (list runtime)))
                ((symbol-function 'pilish-stop-runtime)
                 (lambda (&rest _) (ert-fail "Completion cannot stop a runtime")))
                ((symbol-function 'pilish-close-session)
                 (lambda (&rest _) (ert-fail "Completion cannot request cancellation")))
                ((symbol-function 'pilish-reconnect-runtime)
                 (lambda (&rest _) (ert-fail "Completion cannot reconnect"))))
        (setq pilish-runtime-test--chat (pilish-attach-runtime runtime "disconnected-worker"))
        (pilish-runtime-test--wait
         (lambda () (equal (plist-get (pilish-session-runtime pilish-runtime-test--chat) :state) "live")))
        (let* ((input (pilish-session-input-buffer pilish-runtime-test--chat))
               (captured (copy-tree runtime))
               (target (list :kind "pi" :placement "worker" :buffer pilish-runtime-test--chat
                             :mux-id "test-runtime" :runtime captured :owns-view t)))
          (puthash "worker" target pi-orchestration--targets)
          ;; Lose transport before natural completion: no Close and no pimux_exit
          ;; have started Pilish's read-only task polling.
          (delete-process (pilish-session-process pilish-runtime-test--chat))
          (pilish-runtime-test--wait
           (lambda () (equal (plist-get (pilish-session-runtime pilish-runtime-test--chat) :state)
                             "disconnected")))
          (should-not (buffer-local-value 'pilish--runtime-task-timer pilish-runtime-test--chat))
          (pi-orchestration--close "worker" nil "test-runtime" t)
          (should (buffer-live-p pilish-runtime-test--chat))
          (should (buffer-live-p input))
          (should (eq target (gethash "worker" pi-orchestration--targets)))
          ;; The notification is not itself final evidence. Pending proof must
          ;; retain both the disconnected view and the registered sidebar target.
          (should-error (pi-orchestration--task-finished "worker" "test-runtime" nil))
          (should (buffer-live-p pilish-runtime-test--chat))
          (should (eq target (gethash "worker" pi-orchestration--targets)))
          (should-not events)
          (setq task-record (plist-put task-record :state "complete"))
          (pilish-runtime-test--write-task task-file task-record)
          (pi-orchestration--task-finished "worker" "test-runtime" nil)
          (should-not (buffer-live-p pilish-runtime-test--chat))
          (should-not (buffer-live-p input))
          (should-not (pi-orchestration-targets))
          (should (equal events '(("worker" close))))
          (should-not (pi-orchestration-test--sent-input))
          (pi-orchestration--task-finished "worker" "test-runtime" nil)
          (should (= (length events) 1)))))))

(provide 'pi-orchestration-runtime-test)
;;; pi-orchestration-runtime-test.el ends here
