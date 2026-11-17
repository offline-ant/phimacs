;;; pi-deck-persistence-test.el --- Persistence and daemon tests -*- lexical-binding: t; -*-

;; SPDX-License-Identifier: MIT

;;; Commentary:

;; Saved state, restore ownership and daemon integration.
;; Fixtures: pi-deck-test-fixtures.el.

;;; Code:

(require 'pi-deck-test-fixtures)

;;;; Persistence and daemon

(ert-deftest pi-deck-test-finished-workers-survive-restart ()
  (pi-deck-test--with-large-frame
   (pi-deck-test--with-deck
    (pi-deck-create-space dir "space")
    (let* ((parent (pi-deck-test--session dir "keep"))
           (nested (pi-deck-test--session dir "nested"))
           (parent-name (buffer-name parent))
           (kept (pi-deck-test--finished-worker dir parent "do-1"))
           (unreadable (pi-deck-test--finished-worker dir parent "do-2")))
      (pi-deck-test--finished-worker dir nested "do-3")
      ;; A task-owned worker view and its parent association also survive;
      ;; its closed workers return under that view without promoting the task.
      (setf (pi-deck-agent-target (pi-deck-agent nested)) "t-2"
            (pi-deck-agent-placement (pi-deck-agent nested)) "worker")
      (let ((saved (plist-get (progn (pi-deck-save-state) (pi-deck-read-state))
                              :finished-workers)))
        (should (equal (mapcar (lambda (record) (plist-get record :name)) saved)
                       '("do-3" "do-2" "do-1")))
        (should (equal (plist-get (nth 2 saved) :parent) parent-name)))
      (delete-file (plist-get unreadable :session-file))
      ;; Simulate a restart.
      (setf (pi-deck-agent-target (pi-deck-agent nested)) nil
            (pi-deck-agent-placement (pi-deck-agent nested)) nil)
      (pi-deck-stop-agent (pi-deck-agent parent))
      (pi-deck-stop-agent (pi-deck-agent nested))
      (should-not pi-deck--finished-workers)
      (set-frame-parameter nil 'tabs nil)
      (pi-deck--single-window)
      (switch-to-buffer "*scratch*")
      (setq pi-deck-spaces nil pi-deck--layouts nil pi-deck--last-space nil)
      (cl-letf (((symbol-function 'pilish-start-session)
                 (lambda (&rest _) (ert-fail "Restoring worker views must not start Pi"))))
        (pi-deck-restore-state)
        (let* ((restored (get-buffer parent-name))
               (records (pi-deck-finished-workers restored)))
          (should (equal records (list (plist-put (copy-sequence kept) :parent restored))))
          (should (equal (length pi-deck--finished-workers) 2))
          ;; Its row and links work as before; restoring again adds nothing.
          (with-current-buffer (pi-deck-sidebar-buffer)
            (pi-deck-sidebar-refresh)
            (should (string-match-p "▸ 1 finished worker" (buffer-string))))
          (pi-deck-restore-state)
          (should (equal (length pi-deck--finished-workers) 2))
          ;; Clearing the list is saved like any other change.
          (pi-deck--save-on-structure-change)
          (pi-deck--save-now)
          (let ((pi-deck-save-delay 1000))
            (pi-deck-clear-finished-workers restored)
            (pi-deck--save-on-structure-change)
            (should pi-deck--save-timer)
            (pi-deck--save-now))
          (should (equal (mapcar (lambda (record) (plist-get record :name))
                                (plist-get (pi-deck-read-state) :finished-workers))
                         '("do-3")))))))))

(ert-deftest pi-deck-test-save-and-restore-state ()
  (pi-deck-test--with-large-frame
   (pi-deck-test--with-deck
    (let ((two (make-temp-file "pi-deck-two-" t)))
      (pi-deck-create-space two "two")
      (pi-deck-create-space dir "space")
      (let* ((chat (pi-deck-test--session dir "keep"))
             (fresh (pi-deck-test--session dir "fresh"))
             (shell-buffer (pi-deck-start-shell dir "shell:space" '("/bin/sh" "-c" "read line")))
             (chat-name (buffer-name chat))
             restored)
        (with-current-buffer (pilish-session-input-buffer chat)
          (insert "recoverable draft"))
        (pi-deck-refresh)
        (pi-deck--display-agent-in-window (pi-deck-agent chat) (selected-window))
        (pi-deck-show-beside (pi-deck-agent shell-buffer))
        (let* ((state (pi-deck-save-state))
               (records (plist-get state :agents)))
          (should (eq (plist-get state :version) 3))
          (should (equal (plist-get state :space) "space"))
          (should (equal (sort (mapcar #'car (plist-get state :layouts))) '("space" "two")))
          (should (member chat-name (window-state-buffers
                                     (cdr (assoc "space" (plist-get state :layouts))))))
          (should (equal (sort (mapcar (lambda (record) (plist-get record :kind)) records))
                         '(pi pi shell)))
          (let ((keep (seq-find (lambda (record) (equal (plist-get record :name) "keep")) records)))
            (should (equal (plist-get keep :session-file) (expand-file-name "keep.jsonl" dir)))
            (let ((desktop (plist-get keep :desktop-state)))
              (should (equal (plist-get desktop :directory) (file-name-as-directory dir)))
              (should (equal (plist-get desktop :draft) "recoverable draft"))
              (should-not (plist-get desktop :runtime))))
          (should (equal (plist-get (seq-find (lambda (record) (eq (plist-get record :kind) 'shell))
                                              records)
                                    :command)
                         '("/bin/sh" "-c" "read line"))))
        ;; Simulate a restart: processes, buffers, tabs and spaces are gone.
        (pi-deck-stop-agent (pi-deck-agent shell-buffer))
        (pi-deck-stop-agent (pi-deck-agent chat))
        (pi-deck-stop-agent (pi-deck-agent fresh))
        (set-frame-parameter nil 'tabs nil)
        (pi-deck--single-window)
        (switch-to-buffer "*scratch*")
        (setq pi-deck-spaces nil pi-deck--layouts nil pi-deck--last-space nil)
        (with-temp-file (expand-file-name "keep.jsonl" dir) (insert "{}\n"))
        (cl-letf (((symbol-function 'pilish-restore-session-state)
                   (lambda (state)
                     (push (copy-tree state) restored)
                     (pi-deck-test--restore-view state)))
                  ((symbol-function 'pilish-start-session)
                   (lambda (&rest _) (ert-fail "Desktop restore started Pi")))
                  ((symbol-function 'pi-deck-start-shell)
                   (lambda (&rest _) (ert-fail "Desktop restore replayed a shell command"))))
          (pi-deck-restore-state))
        ;; Both file identities remain recoverable, including an unwritten
        ;; file. Neither becomes an implicitly started fresh conversation.
        (should (equal (sort (mapcar (lambda (state) (list (plist-get state :name)
                                                          (plist-get state :session-file))) restored)
                            :key #'car)
                       `(("fresh" ,(expand-file-name "fresh.jsonl" dir))
                         ("keep" ,(expand-file-name "keep.jsonl" dir)))))
        (should (equal (pi-deck-space-names) '("two" "space")))
        (should (equal (pi-deck-space-dir "space") (file-name-as-directory dir)))
        ;; The frame shows the saved space with its layout, paired again.
        (should (equal (pi-deck-current-space) "space"))
        (should (= (length (tab-bar-tabs)) 1))
        (should (pilish-window-pair (get-buffer-window chat-name)))
        (should (equal (with-current-buffer (pilish-session-input-buffer (get-buffer chat-name))
                         (buffer-string))
                       "recoverable draft"))
        (should (get-buffer-window "*shell:space*"))
        (should (eq (buffer-local-value 'major-mode (get-buffer "*shell:space*"))
                    'pi-deck-stopped-shell-mode))
        (should-not (get-buffer-process "*shell:space*"))
        (pi-deck-switch-space "two")
        (should (= (length (tab-bar-tabs)) 2)))
      (delete-directory two t)))))

(ert-deftest pi-deck-test-restart-daemon-saves-and-detaches ()
  (pi-deck-test--with-deck
    (pi-deck-create-space dir "space")
    (let ((operation (make-temp-file "pi-deck-prepared-restart-" t)) helper killed)
      (cl-letf (((symbol-function 'pi-deck-server-running-p) #'always)
                ((symbol-function 'pi-deck--prepare-restart)
                 (lambda (command) (setq helper command) operation))
                ((symbol-function 'pi-deck--restart-helper-ready-p) #'always)
                ((symbol-function 'kill-emacs)
                 (lambda (&rest _)
                   (should (file-exists-p (expand-file-name "commit" operation)))
                   (setq killed t))))
        (let ((server-name "pi-test")
              (server-socket-dir "/tmp/pi-deck-test-sockets"))
          (pi-deck-restart-daemon t)))
      (should killed)
      (should-not (file-exists-p operation))
      ;; The prepared replacement binds the running socket, not a new name.
      (should (equal helper '("emacs" "--daemon=/tmp/pi-deck-test-sockets/pi-test")))
      (should (file-exists-p pi-deck-state-file))
      (should (equal (plist-get (pi-deck-read-state) :owner) "/tmp/pi-deck-test-owner")))))

(defun pi-deck-test--write-state (file owner names dir)
  "Write a state to FILE owned by OWNER with Pi sessions NAMES in DIR."
  (with-temp-file file
    (prin1 (list :version 3 :owner owner
                 :spaces (list (list :name "space" :dir (file-name-as-directory dir)))
                 :space "space" :layouts nil
                 :agents (mapcar (lambda (name)
                                   (list :kind 'pi :buffer (format "*restored-%s*" name)
                                         :dir dir :name name :session-file nil :space "space"
                                         :desktop-state (list :directory dir :name name :session-file nil)))
                                 names))
           (current-buffer))))

(defmacro pi-deck-test--claiming (socket started &rest body)
  "Run BODY with a running server on SOCKET, recording session names in STARTED."
  (declare (indent 2))
  `(cl-letf (((symbol-function 'pi-deck-server-socket) (lambda () ,socket))
             ((symbol-function 'pilish-restore-session-state)
              (lambda (state)
                (push (plist-get state :name) ,started)
                (pi-deck-test--restore-view state))))
     (let ((pi-deck--state-claimed nil)
           (pi-deck--state-owner nil))
       ,@body)))

(ert-deftest pi-deck-test-owner-restores-on-start ()
  (pi-deck-test--with-deck
    ;; Check before the production restore's error boundary: otherwise an
    ;; ert-skip from its fake frontend could be caught as a recoverable error.
    (pi-deck-test--require-grammars)
    (let (started)
      (pi-deck-test--write-state pi-deck-state-file "/s/pi" '("a" "b") dir)
      (pi-deck-test--claiming "/s/pi" started
        (pi-deck-claim-state)
        (should (equal pi-deck--state-owner "/s/pi"))
        (should (equal (reverse started) '("a" "b")))
        (should (pi-deck-space "space"))
        ;; Claiming happens once per Emacs.
        (pi-deck-claim-state)
        (should (= (length started) 2))))))

(ert-deftest pi-deck-test-other-emacs-neither-restores-nor-saves ()
  (pi-deck-test--with-deck
    (let ((pi-deck-save-delay 0.01) started)
      (pi-deck-test--write-state pi-deck-state-file "/s/pi" '("a") dir)
      (let ((before (with-temp-buffer (insert-file-contents pi-deck-state-file) (buffer-string))))
        ;; Another daemon, then an Emacs without a server.
        (dolist (socket '("/s/other" nil))
          (pi-deck-test--claiming socket started
            (pi-deck-claim-state)
            (should-not pi-deck--state-owner)
            (pi-deck-create-space dir (format "own-%s" (if socket "other" "none")))
            (pi-deck--save-now)
            (pi-deck-test--wait (lambda () nil) 0.1)))
        (should-not started)
        (should (equal (with-temp-buffer (insert-file-contents pi-deck-state-file) (buffer-string))
                       before))))))

(ert-deftest pi-deck-test-explicit-save-takes-over-the-state ()
  (pi-deck-test--with-deck
    (let (started)
      (dolist (owner '(nil "/s/pi"))
        (pi-deck-test--write-state pi-deck-state-file owner '("a") dir)
        (setq pi-deck--last-saved nil)
        (pi-deck-test--claiming "/s/other" started
          (pi-deck-claim-state)
          (should-not pi-deck--state-owner)
          (pi-deck-save-state)
          (should (equal pi-deck--state-owner "/s/other"))
          (should (equal (plist-get (pi-deck-read-state) :owner) "/s/other"))))
      (should-not started))))

(ert-deftest pi-deck-test-unrestored-state-is-backed-up ()
  (pi-deck-test--with-deck
    (let ((pi-deck-auto-restore nil) started)
      (pi-deck-test--write-state pi-deck-state-file "/s/pi" '("a") dir)
      (pi-deck-test--claiming "/s/pi" started
        (pi-deck-claim-state)
        (should (equal pi-deck--state-owner "/s/pi"))
        (should-not started)
        (pi-deck-create-space dir "new")
        (pi-deck--save-now)
        (let ((backup (concat pi-deck-state-file ".bak")))
          (should (equal (mapcar (lambda (r) (plist-get r :name))
                                 (plist-get (pi-deck-read-state backup) :agents))
                         '("a")))
          (should (pi-deck-space "new"))
          (should-not (plist-get (pi-deck-read-state) :agents))
          ;; Only the first save moves the old file away.
          (delete-file backup)
          (pi-deck-create-space dir "newer")
          (pi-deck-save-state)
          (should-not (file-exists-p backup)))))))

(ert-deftest pi-deck-test-restore-is-staggered ()
  (pi-deck-test--with-deck
    (pi-deck-test--require-grammars)
    (let ((pi-deck-restore-interval 0.05) started)
      (pi-deck-test--write-state pi-deck-state-file "/s/pi" '("a" "b" "c") dir)
      (pi-deck-test--claiming "/s/pi" started
        (pi-deck-claim-state)
        (should (equal started '("a")))
        (should (timerp pi-deck--restoring))
        ;; No save while sessions are still starting: the file lists them all.
        (pi-deck--save-now)
        (should (= 3 (length (plist-get (pi-deck-read-state) :agents))))
        (should-error (pi-deck-restore-state) :type 'user-error)
        (should (pi-deck-test--wait (lambda () (null pi-deck--restoring))))
        (should (equal (reverse started) '("a" "b" "c")))
        (pi-deck--save-now)
        (should (= 3 (length (plist-get (pi-deck-read-state) :agents))))))))

(ert-deftest pi-deck-test-daemon-claims-after-server-start ()
  (pi-deck-test--with-deck
    (pi-deck-mode -1)
    (let ((pi-deck--state-claimed nil)
          (emacs-startup-hook nil))
      (cl-letf (((symbol-function 'daemonp) #'always)
                ((symbol-function 'pi-deck-server-running-p) #'ignore))
        (pi-deck-mode 1))
      (should-not pi-deck--state-claimed)
      (should (memq #'pi-deck-claim-state emacs-startup-hook))
      (pi-deck-mode -1)
      (should-not (memq #'pi-deck-claim-state emacs-startup-hook)))))

(ert-deftest pi-deck-test-server-socket-absolute-name ()
  (cl-letf (((symbol-function 'pi-deck-server-running-p) #'always))
    (let ((server-name "/tmp/emacs1/pi")
          (server-socket-dir "/elsewhere"))
      (should (equal (pi-deck-server-socket) "/tmp/emacs1/pi"))
      (should (equal (pi-deck-server-display-name) "pi"))
      (should (equal (pi-deck-restart-command-line) '("emacs" "--daemon=/tmp/emacs1/pi"))))))

(ert-deftest pi-deck-test-daemon-info ()
  (pi-deck-test--with-deck
    (let ((lines (pi-deck-daemon-info-lines)))
      (should (string-match-p (format "pid %d" (emacs-pid)) (car lines)))
      (should (string-match-p "live Pi sessions 0" (car lines)))
      (should (string-match-p "orchestration" (cadr lines)))
      (pi-deck-daemon-info)
      (with-current-buffer "*pi-deck daemon*"
        (should (equal (string-trim-right (buffer-string)) (string-join lines "\n")))))))

(ert-deftest pi-deck-test-show-session-uses-or-creates-its-space ()
  (pi-deck-test--with-deck
    (should (eq pi-orchestration-show-session-function #'pi-deck-show-session))
    (let* ((other (file-name-as-directory (make-temp-file "pi-deck-switch-" t)))
           (other-space (file-name-nondirectory (directory-file-name other))))
      (cl-letf (((symbol-function 'pi-deck--client-frames) (lambda () (list (selected-frame))))
                ((symbol-function 'select-frame-set-input-focus) #'ignore))
        ;; A directory without a space gets one, showing the pair.
        (let ((agent (pi-deck-show-session (pi-deck-test--session other "switched"))))
          (should (equal (pi-deck-agent-assigned-space agent) other-space))
          (should (equal (pi-deck-current-space) other-space))
          (should (eq (window-buffer) (pilish-session-input-buffer (pi-deck-agent-buffer agent))))
          (should (get-buffer-window (pi-deck-agent-buffer agent))))
        ;; An existing space for the directory shows it, from elsewhere too.
        (pi-deck-create-space dir "space")
        (pi-deck-select-space other-space)
        (let ((agent (pi-deck-show-session (pi-deck-test--session dir "second"))))
          (should (equal (pi-deck-agent-assigned-space agent) "space"))
          (should (equal (pi-deck-current-space) "space"))
          (should (eq (window-buffer) (pilish-session-input-buffer (pi-deck-agent-buffer agent))))
          ;; Showing it again focuses it without adding panes.
          (let ((count (length (window-list nil 'no-minibuf))))
            (pi-deck-select-space other-space)
            (pi-deck-show-session (pi-deck-agent-buffer agent))
            (should (equal (pi-deck-current-space) "space"))
            (should (= (length (window-list nil 'no-minibuf)) count)))
          (should (= (length (tab-bar-tabs)) 2))))
      ;; Without a client frame, the next frame shows it.
      (cl-letf (((symbol-function 'pi-deck--client-frames) (lambda () nil)))
        (let ((agent (pi-deck-show-session (pi-deck-test--session other "later"))))
          (should (eq pi-deck--pending-reveal (pi-deck-agent-buffer agent)))))
      (cl-letf (((symbol-function 'pi-deck--client-frames) (lambda () (list (selected-frame)))))
        (pi-deck-setup-frame (selected-frame)))
      (should-not pi-deck--pending-reveal)
      (should (equal (pi-deck-current-space) other-space))
      (should (string-match-p "later" (buffer-name (window-buffer))))
      (delete-directory other t))))

(ert-deftest pi-deck-test-state-saves-after-changes ()
  (pi-deck-test--with-deck
    (let ((pi-deck-save-delay 0.05))
      (pi-deck-create-space dir "space")
      (should (pi-deck-test--wait (lambda () (file-exists-p pi-deck-state-file))))
      (should-not pi-deck--save-timer)
      (should (= (logand (file-modes pi-deck-state-file) #o077) 0))
      (delete-file pi-deck-state-file)
      ;; An agent finishing a turn saves again; nothing saves periodically.
      (let ((chat (pi-deck-test--session dir "a")))
        (pi-deck-test--wait (lambda () (file-exists-p pi-deck-state-file)))
        (delete-file pi-deck-state-file)
        (pi-deck-test--wait (lambda () nil) 0.2)
        (should-not (file-exists-p pi-deck-state-file))
        (pi-deck-test--phase chat "thinking")
        (pi-deck-test--phase chat "idle")
        (should (pi-deck-test--wait (lambda () (file-exists-p pi-deck-state-file))))
        (should (cl-find "a" (plist-get (pi-deck-read-state) :agents)
                         :key (lambda (record) (plist-get record :name)) :test #'equal))))))

(provide 'pi-deck-persistence-test)
;;; pi-deck-persistence-test.el ends here
