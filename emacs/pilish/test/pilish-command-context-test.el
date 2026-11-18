;;; pilish-command-context-test.el --- Delayed action contexts -*- lexical-binding: t; -*-
;; SPDX-License-Identifier: GPL-3.0-or-later
;;; Commentary:
;; Menu/input/browser actions must keep the snapshot token captured before
;; yielding.  The owning mux, not a client-side identity guess, accepts or rejects
;; the resulting RPC.  The core helpers are explicit test doubles here: core's
;; validation and wire contract have their own suite.
;;; Code:
(require 'ert)
(require 'pilish)
(require 'pilish-test-common)

(defconst pilish-command-context-test--a
  '(:sessionFile "/tmp/command-a.jsonl" :leafId "branch-a" :contextId "context-a"))
(defconst pilish-command-context-test--b
  '(:sessionFile "/tmp/command-b.jsonl" :leafId "branch-b" :contextId "context-b"))

(defmacro pilish-command-context-test--with-view (&rest body)
  "Evaluate BODY with a synthetic ready shared view and explicit core doubles."
  (declare (indent 0) (debug t))
  `(let* ((chat (generate-new-buffer " *pilish-command-context-chat*"))
          (input (generate-new-buffer " *pilish-command-context-input*"))
          (proc (make-pipe-process :name "pilish-command-context-peer" :noquery t))
          (pilish-input-markdown-highlighting nil)
          (pilish-quit-without-confirmation t))
     (unwind-protect
         (with-current-buffer chat
           (pilish-chat-mode)
           (pilish--set-chat-session-identity temporary-file-directory "context")
           (setq pilish--process proc pilish--input-buffer input
                 pilish--status 'idle pilish--state
                 '(:session-file "/tmp/command-a.jsonl" :leaf-id "branch-a"))
           (with-current-buffer input
             (pilish-input-mode)
             (setq pilish--chat-buffer chat)
             (insert "original draft"))
           (process-put proc 'pilish-chat-buffer chat)
           (process-put proc 'pilish-mux '(:protocol 2 :muxId "context-owner"))
           (process-put proc 'pilish-input-context (copy-tree pilish-command-context-test--a))
           (cl-letf (((symbol-function 'pilish--capture-input-context)
                      (lambda (process)
                        (when (pilish--process-shared-p process)
                          (copy-tree (process-get process 'pilish-input-context)))))
                     ((symbol-function 'pilish--bind-input-context)
                      (lambda (command context)
                        (if context
                            (plist-put (copy-sequence command) :pimuxContext (copy-tree context))
                          (copy-sequence command))))
                     ((symbol-function 'pilish--shared-input-ready-p) (lambda (_) t)))
             ,@body))
       (when (process-live-p proc) (delete-process proc))
       (dolist (buffer (list input chat))
         (when (buffer-live-p buffer)
           (with-current-buffer buffer (setq pilish--process nil))
           (kill-buffer buffer))))))

(defmacro pilish-command-context-test--with-picker-dispatch (callback &rest body)
  "Capture the zero-time picker in CALLBACK; execute it only after BODY."
  (declare (indent 1))
  `(let (,callback)
     (cl-letf (((symbol-function 'run-at-time)
                (lambda (seconds repeat function &rest arguments)
                  (should (equal seconds 0))
                  (should-not repeat)
                  (setq ,callback (lambda () (apply function arguments))))))
       ,@body)
     (when ,callback (funcall ,callback))))

(ert-deftest pilish-command-context-test-transition-captures-before-confirmation ()
  (pilish-command-context-test--with-view
    (let (sent)
      (cl-letf (((symbol-function 'y-or-n-p)
                 (lambda (_)
                   (process-put proc 'pilish-input-context pilish-command-context-test--b) t))
                ((symbol-function 'pilish--rpc-async)
                 (lambda (_ command _callback) (setq sent command))))
        (pilish-new-session))
      (should (equal (plist-get sent :pimuxContext) pilish-command-context-test--a))
      (should (equal (plist-get sent :type) "new_session")))))

(ert-deftest pilish-command-context-test-model-picker-refuses-stale-discovery ()
  (pilish-command-context-test--with-view
    (process-put proc 'pilish-mux '(:protocol 2 :capabilities ["models"]))
    (let (reply requests)
      (cl-letf (((symbol-function 'pilish--rpc-async)
                 (lambda (_ command callback) (push command requests) (setq reply callback)))
                ((symbol-function 'completing-read)
                 (lambda (&rest _) (ert-fail "Stale model catalog opened a selector"))))
        (pilish-select-model)
        (process-put proc 'pilish-input-context pilish-command-context-test--b)
        (funcall reply '(:success t :data (:models [(:id "model" :name "Model" :provider "fake")]))))
      (should (equal requests '((:type "pimux_models" :action "list")))))))

(ert-deftest pilish-command-context-test-thinking-picker-retains-pre-getter-context ()
  (pilish-command-context-test--with-view
    (let (sent)
      (cl-letf (((symbol-function 'pilish--get-available-thinking-levels)
                 (lambda (&rest _)
                   (process-put proc 'pilish-input-context pilish-command-context-test--b)
                   '("off" "high")))
                ((symbol-function 'completing-read) (lambda (&rest _) "high"))
                ((symbol-function 'pilish--rpc-async)
                 (lambda (_ command _callback) (setq sent command))))
        (pilish-select-thinking))
      (should (equal (plist-get sent :type) "set_thinking_level"))
      (should (equal (plist-get sent :pimuxContext) pilish-command-context-test--a)))))

(ert-deftest pilish-command-context-test-name-prompt-retains-origin-and-does-not-relabel-new-context ()
  (pilish-command-context-test--with-view
    (let (sent)
      (cl-letf (((symbol-function 'read-string)
                 (lambda (&rest _)
                   (process-put proc 'pilish-input-context pilish-command-context-test--b)
                   (setq pilish--session-name "new context name") "old context name"))
                ((symbol-function 'pilish--rpc-async)
                 (lambda (_ command callback)
                   (setq sent command) (funcall callback '(:success t)))))
        (call-interactively #'pilish-set-session-name))
      (should (equal (plist-get sent :pimuxContext) pilish-command-context-test--a))
      (should (equal pilish--session-name "new context name")))))

(ert-deftest pilish-command-context-test-fork-binds-before-asynchronous-getter ()
  (pilish-command-context-test--with-view
    (let (getter sent)
      (cl-letf (((symbol-function 'pilish--rpc-async)
                 (lambda (_ command callback)
                   (if (equal (plist-get command :type) "get_fork_messages")
                       (setq getter callback)
                     (setq sent command))))
                ((symbol-function 'completing-read)
                 (lambda (_ choices &rest _) (car (all-completions "" choices))))
                ((symbol-function 'y-or-n-p) (lambda (_) t)))
        (pilish-fork)
        (process-put proc 'pilish-input-context pilish-command-context-test--b)
        (funcall getter '(:success t :data (:messages [(:entryId "old-entry" :text "old turn")]))))
      (should (equal (plist-get sent :type) "fork"))
      (should (equal (plist-get sent :entryId) "old-entry"))
      (should (equal (plist-get sent :pimuxContext) pilish-command-context-test--a)))))

(ert-deftest pilish-command-context-test-resume-preserves-explicit-selection-context ()
  (pilish-command-context-test--with-view
    (let (sent)
      (process-put proc 'pilish-input-context pilish-command-context-test--b)
      (cl-letf (((symbol-function 'y-or-n-p) (lambda (_) t))
                ((symbol-function 'pilish--rpc-async)
                 (lambda (_ command _callback) (setq sent command))))
        (pilish--resume-selected-session proc chat "/tmp/selected.jsonl"
                                         pilish-command-context-test--a))
      (should (equal (plist-get sent :pimuxContext) pilish-command-context-test--a)))))

(ert-deftest pilish-command-context-test-custom-arguments-do-not-send-to-adopted-conversation ()
  (pilish-command-context-test--with-view
    (cl-letf (((symbol-function 'read-string)
               (lambda (&rest _)
                 (process-put proc 'pilish-input-context pilish-command-context-test--b)
                 "old arguments"))
              ((symbol-function 'pilish--prepare-and-send)
               (lambda (&rest _) (ert-fail "Stale slash command reached submission"))))
      (should-error (pilish--run-custom-command '(:name "custom")) :type 'user-error))
    (should (equal (with-current-buffer input (buffer-string)) "original draft"))))

(ert-deftest pilish-command-context-test-custom-picker-does-not-rebind-before-arguments ()
  (pilish-command-context-test--with-view
    (let ((pilish--commands '((:name "custom" :description "test"))))
      (cl-letf (((symbol-function 'completing-read)
                 (lambda (_ choices &rest _)
                   (process-put proc 'pilish-input-context pilish-command-context-test--b)
                   (caar choices)))
                ((symbol-function 'read-string) (lambda (&rest _) "old arguments"))
                ((symbol-function 'pilish--prepare-and-send)
                 (lambda (&rest _) (ert-fail "Picker rebound an old command"))))
        (should-error (pilish-run-custom-command) :type 'user-error)))))

(ert-deftest pilish-command-context-test-close-cannot-accept-a-replacement-receipt ()
  (pilish-command-context-test--with-view
    (setq pilish--runtime '(:protocol 2 :mux-id "old-runtime" :state "live" :placement "root"))
    (let (outcome)
      (cl-letf (((symbol-function 'yes-or-no-p)
                 (lambda (_) (ert-fail "Close yielded to a confirmation")))
                ((symbol-function 'pilish--runtime-call)
                 (lambda (args _directory _env callback)
                   (should (equal args '("stop" "--json" "--id" "old-runtime")))
                   (funcall callback '(:muxId "replacement" :state "stopped") nil))))
        (pilish-close-session chat (lambda (error) (setq outcome error))))
      (should (string-match-p "uncertain" outcome))
      (should (buffer-live-p chat))
      (should (equal (with-current-buffer input (buffer-string)) "original draft")))))

(ert-deftest pilish-command-context-test-browser-rename-does-not-change-dispatch-after-prompt ()
  (pilish-command-context-test--with-view
    (let ((browser (generate-new-buffer " *pilish-command-context-browser*")) sent)
      (unwind-protect
          (with-current-buffer browser
            (setq pilish--chat-buffer chat)
            (cl-letf (((symbol-function 'pilish--session-browser-path-at-point)
                       (lambda () "/tmp/command-a.jsonl"))
                      ((symbol-function 'pilish--browse-session-file-matches-p) (lambda (&rest _) t))
                      ((symbol-function 'pilish-storage-managed-p) (lambda () t))
                      ((symbol-function 'read-string)
                       (lambda (&rest _)
                         (process-put proc 'pilish-input-context pilish-command-context-test--b)
                         (with-current-buffer chat
                           (setq pilish--state '(:session-file "/tmp/command-b.jsonl")))
                         "old name"))
                      ((symbol-function 'pilish--session-browser-fetch-and-render) #'ignore)
                      ((symbol-function 'pilish-storage-append-entry)
                       (lambda (&rest _) (ert-fail "Live rename fell back to disk")))
                      ((symbol-function 'pilish--rpc-async)
                       (lambda (_ command callback)
                         (setq sent command) (funcall callback '(:success :false :error "stale")))))
              (pilish-session-browser-rename)))
        (kill-buffer browser))
      (should (equal (plist-get sent :pimuxContext) pilish-command-context-test--a)))))

(ert-deftest pilish-command-context-test-browser-switch-binds-before-yielding-guard ()
  (pilish-command-context-test--with-view
    (let ((pilish--chat-buffer chat) sent)
      (cl-letf (((symbol-function 'pilish--browse-transition-refused-p)
                 (lambda (&rest _)
                   (process-put proc 'pilish-input-context pilish-command-context-test--b) nil))
                ((symbol-function 'pilish--browse-quit-when-settled) #'ignore)
                ((symbol-function 'y-or-n-p) (lambda (_) t))
                ((symbol-function 'pilish--rpc-async)
                 (lambda (_ command _callback) (setq sent command))))
        (pilish--browse-switch-session "/tmp/selected.jsonl"))
      (should (equal (plist-get sent :pimuxContext) pilish-command-context-test--a)))))

(ert-deftest pilish-command-context-test-selected-image-does-not-attach-to-an-adopted-draft ()
  (pilish-command-context-test--with-view
    (with-current-buffer input
      (cl-letf (((symbol-function 'read-file-name)
                 (lambda (&rest _)
                   (process-put proc 'pilish-input-context pilish-command-context-test--b)
                   "/synthetic/image.png"))
                ((symbol-function 'pilish--read-prompt-image) (lambda (_) 'selected-image))
                ((symbol-function 'pilish--set-prompt-image)
                 (lambda (&rest _) (ert-fail "Old-context image attached to new draft"))))
        (should-error (pilish-attach-image) :type 'user-error)))))

(ert-deftest pilish-command-context-test-steering-rejection-recovers-only-to-origin ()
  (pilish-command-context-test--with-view
    (let (sent reply recovery)
      (setq pilish--status 'streaming)
      (cl-letf (((symbol-function 'pilish--rpc-async)
                 (lambda (_ command callback) (setq sent command reply callback)))
                ((symbol-function 'pilish--quarantine-input)
                 (lambda (reason context &rest payload) (setq recovery (list reason context payload)))))
        (should (pilish--send-steer-message "old instruction"))
        (process-put proc 'pilish-input-context pilish-command-context-test--b)
        (funcall reply '(:success :false :delivery "rejected" :error "stale context")))
      (should (equal (plist-get sent :pimuxContext) pilish-command-context-test--a))
      (should (equal (plist-get (cadr recovery) :session-file) "/tmp/command-a.jsonl"))
      (should (equal (plist-get (caddr recovery) :draft) "old instruction"))
      (should-not (plist-get (caddr recovery) :uncertain)))))

(ert-deftest pilish-command-context-test-live-export-retains-pre-prompt-token ()
  (pilish-command-context-test--with-view
    (let (sent)
      (cl-letf (((symbol-function 'read-string)
                 (lambda (&rest _)
                   (process-put proc 'pilish-input-context pilish-command-context-test--b)
                   "/tmp/old-export.html"))
                ((symbol-function 'pilish--rpc-async)
                 (lambda (_ command _callback) (setq sent command))))
        (call-interactively #'pilish-export-html))
      (should (equal (plist-get sent :pimuxContext) pilish-command-context-test--a)))))

(ert-deftest pilish-command-context-test-stopped-export-does-not-retarget-after-prompt ()
  (pilish-command-context-test--with-view
    (setq pilish--process nil)
    (cl-letf (((symbol-function 'read-string)
               (lambda (&rest _)
                 (setq pilish--state '(:session-file "/tmp/replacement.jsonl")) ""))
              ((symbol-function 'pilish-storage-export-session)
               (lambda (&rest _) (ert-fail "Export silently selected replacement file"))))
      (should-error (call-interactively #'pilish-export-html) :type 'user-error))))

(ert-deftest pilish-command-context-test-tree-label-refuses-replaced-projection ()
  (let ((section (pilish-tree-node-section :type 'tree-node))
        (pilish--tree-browser-loaded-file "/tmp/old-tree.jsonl")
        (pilish--tree-browser-fetch-token 1))
    (oset section value "shared-id")
    (cl-letf (((symbol-function 'magit-current-section) (lambda () section))
              ((symbol-function 'read-string)
               (lambda (&rest _)
                 (setq pilish--tree-browser-loaded-file "/tmp/new-tree.jsonl"
                       pilish--tree-browser-fetch-token 2)
                 "old label"))
              ((symbol-function 'pilish--browse-set-label)
               (lambda (&rest _) (ert-fail "Stale label reached another tree"))))
      (should-error (pilish-tree-browser-set-label) :type 'user-error))))

(ert-deftest pilish-command-context-test-generated-menu-action-retains-menu-origin ()
  (pilish-command-context-test--with-view
    (let* ((section (pilish--build-command-section
                     "Test" '((:name "old-custom")) 1 3 "E" 'ignore))
           (action (nth 2 (aref section 2))))
      (process-put proc 'pilish-input-context pilish-command-context-test--b)
      (cl-letf (((symbol-function 'read-string) (lambda (&rest _) "old arguments"))
                ((symbol-function 'pilish--prepare-and-send)
                 (lambda (&rest _) (ert-fail "Transient action rebound its context"))))
        (should-error (funcall action) :type 'user-error)))))

(ert-deftest pilish-command-context-test-late-command-catalog-does-not-rebuild-for-new-context ()
  (pilish-command-context-test--with-view
    (let (reply applied)
      (cl-letf (((symbol-function 'pilish--rpc-async)
                 (lambda (_ _command callback) (setq reply callback))))
        (pilish--fetch-commands proc (lambda (_) (setq applied t))))
      (process-put proc 'pilish-input-context pilish-command-context-test--b)
      (funcall reply '(:success t :data (:commands [(:name "old-catalog-command")])))
      (should-not applied))))

(ert-deftest pilish-command-context-test-unshared-command-keeps-native-behavior ()
  (pilish-command-context-test--with-view
    (let (sent)
      (process-put proc 'pilish-mux nil)
      (cl-letf (((symbol-function 'read-string) (lambda (&rest _) "native args"))
                ((symbol-function 'pilish--prepare-and-send) (lambda (text) (setq sent text))))
        (pilish--run-custom-command '(:name "native")))
      (should (equal sent "/native native args")))))

(ert-deftest pilish-command-context-test-model-picker-discovers-asynchronously-and-selects-exact-provider ()
  (pilish-command-context-test--with-view
    (process-put proc 'pilish-mux '(:protocol 2 :capabilities ["models"]))
    (let (reply requests model-reply)
      (cl-letf (((symbol-function 'pilish--rpc-sync)
                 (lambda (&rest _) (ert-fail "Managed model discovery blocked Emacs")))
                ((symbol-function 'pilish--rpc-async)
                 (lambda (_ command callback)
                   (push command requests)
                   (if (equal (plist-get command :action) "list")
                       (setq reply callback)
                     (setq model-reply callback))))
                ((symbol-function 'completing-read)
                 (lambda (&rest _) (ert-fail "Exact provider/model opened a selector"))))
        (pilish-select-model "openai/gpt-6.2-sol")
        (should (equal requests '((:type "pimux_models" :action "list"))))
        (pilish-command-context-test--with-picker-dispatch deferred
          (with-temp-buffer
            (funcall reply '(:success t :data (:models
                                             [(:id "gpt-6.2-sol" :name "Sol 6.2" :provider "openrouter")
                                              (:id "gpt-6.2-sol" :name "Sol 6.2" :provider "openai")])))))
        (should (equal (car requests)
                       (list :type "pimux_models" :action "set" :provider "openai"
                             :modelId "gpt-6.2-sol" :pimuxContext pilish-command-context-test--a)))
        (should (pilish--model-change-pending-p chat))
        (funcall model-reply '(:success t :data (:model (:id "gpt-6.2-sol" :provider "openai")
                                                       :thinkingLevel "high")))
        (should-not (pilish--model-change-pending-p chat))
        (should (= (length requests) 2))
        (should (equal (with-current-buffer input (buffer-string)) "original draft"))))))

(ert-deftest pilish-command-context-test-model-picker-prefix-forces-live-refresh ()
  (pilish-command-context-test--with-view
    (process-put proc 'pilish-mux '(:protocol 2 :capabilities ["models"]))
    (let ((current-prefix-arg '(4)) sent)
      (cl-letf (((symbol-function 'pilish--rpc-async)
                 (lambda (_ command _callback) (setq sent command))))
        (call-interactively #'pilish-select-model))
      (should (equal sent '(:type "pimux_models" :action "list" :force t))))))

(ert-deftest pilish-command-context-test-model-picker-refuses-old-capability-without-input ()
  (pilish-command-context-test--with-view
    (cl-letf (((symbol-function 'pilish--rpc-async)
               (lambda (&rest _) (ert-fail "Unsupported runtime received model input"))))
      (should-error (pilish-select-model) :type 'user-error))))

(ert-deftest pilish-command-context-test-model-picker-reports-refresh-failure-without-selection ()
  (pilish-command-context-test--with-view
    (process-put proc 'pilish-mux '(:protocol 2 :capabilities ["models"]))
    (let (reply messages)
      (cl-letf (((symbol-function 'pilish--rpc-async)
                 (lambda (_ _command callback) (setq reply callback)))
                ((symbol-function 'completing-read)
                 (lambda (&rest _) (ert-fail "Failed catalog opened a selector")))
                ((symbol-function 'message)
                 (lambda (format &rest args) (push (apply #'format format args) messages))))
        (pilish-select-model)
        (funcall reply '(:success :false :error (:code "refresh_failed" :message "Faux catalog failed"))))
      (should (string-match-p "Faux catalog failed" (car messages)))
      (should-not (pilish--model-change-pending-p chat)))))

(ert-deftest pilish-command-context-test-model-picker-retains-context-through-minibuffer ()
  (pilish-command-context-test--with-view
    (process-put proc 'pilish-mux '(:protocol 2 :capabilities ["models"]))
    (let (reply requests)
      (cl-letf (((symbol-function 'pilish--rpc-async)
                 (lambda (_ command callback) (push command requests) (setq reply callback)))
                ((symbol-function 'completing-read)
                 (lambda (&rest _)
                   (process-put proc 'pilish-input-context pilish-command-context-test--b)
                   "Model [fake]")))
        (pilish-select-model)
        (pilish-command-context-test--with-picker-dispatch deferred
          (funcall reply '(:success t :data (:models [(:id "model" :name "Model" :provider "fake")])))))
      (should (= (length requests) 1))
      (should-not (pilish--model-change-pending-p chat)))))

(ert-deftest pilish-command-context-test-model-picker-refuses-replaced-session-generation ()
  (pilish-command-context-test--with-view
    (process-put proc 'pilish-mux '(:protocol 2 :capabilities ["models"]))
    (let (reply requests)
      (cl-letf (((symbol-function 'pilish--rpc-async)
                 (lambda (_ command callback) (push command requests) (setq reply callback)))
                ((symbol-function 'completing-read)
                 (lambda (&rest _) (ert-fail "Superseded model selector opened"))))
        (pilish-select-model)
        (cl-incf pilish--session-transition-generation)
        (funcall reply '(:success t :data (:models [(:id "model" :name "Model" :provider "fake")]))))
      (should (= (length requests) 1)))))

(ert-deftest pilish-command-context-test-model-switch-failure-settles-without-prompt ()
  (pilish-command-context-test--with-view
    (process-put proc 'pilish-mux '(:protocol 2 :capabilities ["models"]))
    (let (reply model-reply requests messages)
      (cl-letf (((symbol-function 'pilish--rpc-async)
                 (lambda (_ command callback)
                   (push command requests)
                   (if (equal (plist-get command :action) "list")
                       (setq reply callback)
                     (setq model-reply callback))))
                ((symbol-function 'message)
                 (lambda (format &rest args) (push (apply #'format format args) messages))))
        (pilish-select-model "fake/model")
        (pilish-command-context-test--with-picker-dispatch deferred
          (funcall reply '(:success t :data (:models [(:id "model" :name "Model" :provider "fake")]))))
        (funcall model-reply '(:success :false :error (:code "model_unavailable" :message "Faux model unavailable"))))
      (should (string-match-p "Faux model unavailable" (car messages)))
      (should-not (pilish--model-change-pending-p chat))
      (should (cl-every (lambda (command) (equal (plist-get command :type) "pimux_models")) requests))
      (should (equal (with-current-buffer input (buffer-string)) "original draft")))))

(ert-deftest pilish-command-context-test-model-picker-correlates-control-over-core-transport ()
  (pilish-command-context-test--with-view
    (process-put proc 'pilish-mux '(:protocol 2 :capabilities ["models"]))
    (let (wire)
      (cl-letf (((symbol-function 'pilish--send-string)
                 (lambda (_ text)
                   (push (json-parse-string text :object-type 'plist) wire))))
        (pilish-select-model "openai/gpt-6.2-sol")
        (let ((request (car wire)))
          (should (equal (plist-get request :type) "pimux_models"))
          (should (equal (plist-get request :action) "list"))
          (pilish-command-context-test--with-picker-dispatch deferred
            (pilish--dispatch-response
             proc (list :type "response" :id (plist-get request :id) :command "pimux_models"
                        :success t :data '(:models [(:id "gpt-6.2-sol" :name "Sol 6.2" :provider "openai")])))))
        (let ((request (car wire)))
          (should (equal (plist-get request :action) "set"))
          (should (equal (plist-get request :provider) "openai"))
          (should (equal (plist-get request :modelId) "gpt-6.2-sol"))
          (should (equal (plist-get request :pimuxContext) pilish-command-context-test--a))
          (pilish--dispatch-response
           proc (list :type "response" :id (plist-get request :id) :command "pimux_models"
                      :success t :data '(:model (:id "gpt-6.2-sol" :provider "openai") :thinkingLevel "high"))))
        (should (= (length wire) 2))
        (should (= (hash-table-count (pilish--get-pending-requests proc)) 0))
        (should-not (pilish--model-change-pending-p chat))
        (should (equal (with-current-buffer input (buffer-string)) "original draft"))))))

(ert-deftest pilish-command-context-test-model-picker-defers-completion-outside-response ()
  (pilish-command-context-test--with-view
    (process-put proc 'pilish-mux '(:protocol 2 :capabilities ["models"]))
    (let (reply requests selected)
      (cl-letf (((symbol-function 'pilish--rpc-async)
                 (lambda (_ command callback) (push command requests) (setq reply callback)))
                ((symbol-function 'completing-read)
                 (lambda (&rest _) (setq selected t) "Model [fake]")))
        (pilish-select-model)
        (pilish-command-context-test--with-picker-dispatch deferred
          (funcall reply '(:success t :data (:models [(:id "model" :name "Model" :provider "fake")])))
          (should (functionp deferred))
          (should-not selected)
          (should (= (length requests) 1)))
        (should selected)
        (should (equal (plist-get (car requests) :action) "set"))))))

(ert-deftest pilish-command-context-test-model-picker-rechecks-context-after-deferral ()
  (pilish-command-context-test--with-view
    (process-put proc 'pilish-mux '(:protocol 2 :capabilities ["models"]))
    (let (reply requests messages)
      (cl-letf (((symbol-function 'pilish--rpc-async)
                 (lambda (_ command callback) (push command requests) (setq reply callback)))
                ((symbol-function 'completing-read)
                 (lambda (&rest _) (ert-fail "Deferred picker ignored changed context")))
                ((symbol-function 'message)
                 (lambda (format &rest args) (push (apply #'format format args) messages))))
        (pilish-select-model)
        (pilish-command-context-test--with-picker-dispatch deferred
          (funcall reply '(:success t :data (:models [(:id "model" :name "Model" :provider "fake")])))
          (should (functionp deferred))
          (process-put proc 'pilish-input-context pilish-command-context-test--b)))
      (should (string-match-p "changed before model selection" (car messages)))
      (should (= (length requests) 1)))))

(ert-deftest pilish-command-context-test-model-picker-does-not-steal-active-minibuffer ()
  (pilish-command-context-test--with-view
    (process-put proc 'pilish-mux '(:protocol 2 :capabilities ["models"]))
    (let (reply requests messages)
      (cl-letf (((symbol-function 'pilish--rpc-async)
                 (lambda (_ command callback) (push command requests) (setq reply callback)))
                ((symbol-function 'completing-read)
                 (lambda (&rest _) (ert-fail "Model picker stole the active minibuffer")))
                ((symbol-function 'active-minibuffer-window) (lambda () (selected-window)))
                ((symbol-function 'message)
                 (lambda (format &rest args) (push (apply #'format format args) messages))))
        (pilish-select-model)
        (pilish-command-context-test--with-picker-dispatch deferred
          (funcall reply '(:success t :data (:models [(:id "model" :name "Model" :provider "fake")])))))
      (should (string-match-p "Minibuffer is active" (car messages)))
      (should (= (length requests) 1)))))

(provide 'pilish-command-context-test)
;;; pilish-command-context-test.el ends here
