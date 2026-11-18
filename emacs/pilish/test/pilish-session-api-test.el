;;; pilish-session-api-test.el --- Session API contracts -*- lexical-binding: t; -*-

(require 'pilish)
(require 'pilish-test-common)

(ert-deftest pilish-test-wire-input-uses-prompt-hook ()
  (let ((process (make-pipe-process :name "pilish-wire-test" :noquery t)))
    (unwind-protect
        (with-temp-buffer
          (pilish-chat-mode)
          (pilish--set-process process)
          (let (command)
            (cl-letf (((symbol-function 'pilish--rpc-async)
                       (lambda (_ cmd _cb) (setq command cmd))))
              (pilish-submit-prompt (current-buffer) "take over" #'ignore "steer")
              (should (equal command '(:type "prompt" :message "take over" :streamingBehavior "steer")))
              (pilish-submit-prompt (current-buffer) "follow" #'ignore)
              (should (equal (plist-get command :streamingBehavior) "followUp")))))
      (when (process-live-p process) (delete-process process)))))

(ert-deftest pilish-test-named-sessions-ready-and-close-independently ()
  "Each named session signals readiness, and closing one leaves its peer live."
  (let ((dir (pilish-test--make-temp-directory "pi-named-api-"))
        (pilish-executable (pilish-test-fake-pi-executable))
        (pilish-extra-args (pilish-test-fake-pi-extra-args "prompt-lifecycle"))
        chat1 chat2 ready1 ready2)
    (unwind-protect
        (cl-letf (((symbol-function 'pilish--check-dependencies) #'ignore))
          (setq chat1 (pilish-start-session dir "one" :on-ready
                                            (lambda (r) (setq ready1 r)))
                chat2 (pilish-start-session dir "two" :on-ready
                                            (lambda (r) (setq ready2 r))))
          (should (pilish-test-wait-until (lambda () (and ready1 ready2)) 5))
          (should (eq (plist-get ready1 :success) t))
          (should (eq (plist-get ready2 :success) t))
          (should-not (eq (pilish-session-process chat1) (pilish-session-process chat2)))
          (pilish-close-session chat1)
          (should-not (buffer-live-p chat1))
          (should (process-live-p (pilish-session-process chat2))))
      (pilish-close-session chat1)
      (pilish-close-session chat2)
      (delete-directory dir t))))

(ert-deftest pilish-test-background-start-never-prompts-for-grammars ()
  (let ((dir (pilish-test--make-temp-directory "pi-grammar-prompt-"))
        (treesit-auto-install-grammar 'ask)
        seen)
    (unwind-protect
        (cl-letf (((symbol-function 'pilish--setup-session)
                   (lambda (&rest _) (setq seen treesit-auto-install-grammar) nil)))
          (pilish-start-session dir "quiet")
          (should (eq seen 'never)))
      (delete-directory dir t))))

(ert-deftest pilish-test-managed-start-opens-exact-session-file ()
  "Managed starts use the current saved file and retain caller options."
  (let* ((dir (pilish-test--make-temp-directory "pi-managed-start-"))
         (file (expand-file-name "saved.jsonl" dir))
         (later (expand-file-name "later.jsonl" dir))
         (hook-value "initial")
         (pilish-session-environment-functions
          (list (lambda (_chat _dir) (list (cons "FROM_HOOK" hook-value)))))
         launches chat ready)
    (unwind-protect
        (cl-letf (((symbol-function 'pilish-runtime-configured-p)
                   (lambda () t))
                  ((symbol-function 'pilish--check-dependencies) #'ignore)
                  ((symbol-function 'pilish--runtime-call)
                   (lambda (command directory environment callback)
                     (push (list command directory environment) launches)
                     (funcall callback '(:protocol 2 :state "committed"
                                         :outcome "started") nil)
                     nil))
                  ((symbol-function 'pilish--runtime-connect-committed)
                   (lambda (_chat _receipt _dir _env callback)
                     (funcall callback nil)))
                  ((symbol-function 'pilish--resume-selected-session)
                   (lambda (&rest _) (ert-fail "Requested a second switch"))))
          (pilish-test--write-session-file file "Saved prompt" dir)
          (setq chat (pilish-start-session
                      nil "resumed" :session-file file :args '("--verbose")
                      :environment '(("PILISH_TEST" . "owner"))
                      :on-ready (lambda (response) (setq ready response))))
          (should (eq (plist-get ready :success) t))
          ;; The saved file can change while the runtime is alive.  Resume
          ;; starts the current one, not an argv cached during initial setup.
          (with-current-buffer chat
            (setq pilish--state (list :session-file later)
                  pilish--runtime '(:state "stopped")))
          (setq hook-value "resumed" ready :pending)
          (pilish-resume-stopped-session chat (lambda (error) (setq ready error)))
          (should-not ready)
          (should (= 2 (length launches)))
          (cl-loop for (command cwd env) in (reverse launches)
                   for target in (list file later)
                   for value in '("initial" "resumed") do
                   (should (equal cwd dir))
                   (should (= 1 (cl-count "--session" command :test #'equal)))
                   (should (equal (last command 3) (list "--session" target "--verbose")))
                   (should (equal env (list '("PILISH_TEST" . "owner")
                                            (cons "FROM_HOOK" value))))))
      (when (buffer-live-p chat) (kill-buffer chat))
      (delete-directory dir t))))

(ert-deftest pilish-test-session-environment-hook-precedes-spawn-and-survives-reload ()
  (let* ((dir (pilish-test--make-temp-directory "pi-launch-hook-"))
         (log (expand-file-name "wire.jsonl" dir))
         (pilish-executable (pilish-test-fake-pi-executable))
         (pilish-extra-args (pilish-test-fake-pi-extra-args "prompt-lifecycle"))
         (make-process (symbol-function 'make-process))
         (hook-count 0)
         (pilish-session-environment-functions
          (list (lambda (chat directory)
                  (should (buffer-live-p chat))
                  (should (equal directory (file-name-as-directory dir)))
                  (cl-incf hook-count)
                  '(("PILISH_TEST_OVERRIDE" . "hook") ("PILISH_TEST_HOOK" . "yes")))))
         launches chat ready)
    (unwind-protect
        (cl-letf (((symbol-function 'message) #'ignore)
                  ((symbol-function 'make-process)
                   (lambda (&rest options)
                     (when (equal (plist-get options :name) "pi")
                       (push (list (plist-get options :command)
                                   (getenv "PILISH_TEST_OVERRIDE")
                                   (getenv "PILISH_TEST_HOOK")) launches))
                     (apply make-process options))))
          (setq chat (pilish-start-session
                      dir "launch" :args (list "--log-file" log)
                      :environment '(("PILISH_TEST_OVERRIDE" . "explicit"))
                      :on-ready (lambda (r) (setq ready r))))
          (should (pilish-test-wait-until (lambda () ready) 5))
          (should (eq (plist-get ready :success) t))
          (should (file-exists-p log))
          (should (= hook-count 1))
          (should (equal (cdar launches) '("explicit" "yes")))
          (should (equal (last (caar launches) 2) (list "--log-file" log)))
          (should-not (getenv "PILISH_TEST_HOOK"))
          (with-current-buffer (pilish-session-input-buffer chat)
            (should (eq (pilish-session-chat-buffer) chat)))
          (with-current-buffer chat (pilish-reload))
          (should (pilish-test-wait-until
                   (lambda () (with-current-buffer chat
                                (not (pilish--session-transition-active-p)))) 5))
          (should (= (length launches) 2))
          (should (equal (car launches) (cadr launches)))
          (should (= hook-count 2)))
      (pilish-close-session chat)
      (delete-directory dir t))))

(ert-deftest pilish-test-session-api-rejects-unrelated-buffer-name-collision ()
  "Neither chat nor input buffer names may be taken from other buffers."
  (let ((dir (pilish-test--make-temp-directory "pi-buffer-collision-")))
    (unwind-protect
        (dolist (type '(:chat :input))
          (let ((buffer (generate-new-buffer (pilish--buffer-name type dir "taken")))
                (other (if (eq type :chat) :input :chat))
                started)
            (unwind-protect
                (cl-letf (((symbol-function 'pilish--setup-session)
                           (lambda (&rest _)
                             (setq started t)
                             (error "Unexpected startup"))))
                  (with-current-buffer buffer (insert "unrelated content"))
                  (should-error (pilish-start-session dir "taken"))
                  (should-not started)
                  (should (buffer-live-p buffer))
                  (should (equal (with-current-buffer buffer (buffer-string))
                                 "unrelated content"))
                  (should-not (get-buffer (pilish--buffer-name other dir "taken"))))
              (when (buffer-live-p buffer) (kill-buffer buffer)))))
      (delete-directory dir t))))

(ert-deftest pilish-test-closing-a-session-runs-kill-hooks-in-its-own-buffers ()
  "Global `kill-buffer-hook' functions never run in an unrelated buffer.
Chat and input kill each other; a cycle would kill one of them twice and run
the rest of its hook in whatever buffer became current."
  (dolist (killed '(chat input))
    (let* ((chat (generate-new-buffer " *pilish-kill-chat*"))
           (input (generate-new-buffer " *pilish-kill-input*"))
           (bystander (generate-new-buffer " *pilish-kill-bystander*"))
           seen
           (observer (lambda () (push (current-buffer) seen))))
      (unwind-protect
          (progn
            (with-current-buffer chat
              (pilish-chat-mode)
              (pilish--set-input-buffer input))
            (with-current-buffer input
              (pilish-input-mode)
              (pilish--set-chat-buffer chat))
            (add-hook 'kill-buffer-hook observer)
            (with-current-buffer bystander
              (kill-buffer (if (eq killed 'chat) chat input)))
            (should-not (buffer-live-p chat))
            (should-not (buffer-live-p input))
            (should-not (memq bystander seen))
            (should (= (length (cl-remove-if-not
                                (lambda (buffer) (memq buffer (list chat input)))
                                seen))
                       2)))
        (remove-hook 'kill-buffer-hook observer)
        (dolist (buffer (list chat input bystander))
          (when (buffer-live-p buffer) (kill-buffer buffer)))))))

(provide 'pilish-session-api-test)
;;; pilish-session-api-test.el ends here
