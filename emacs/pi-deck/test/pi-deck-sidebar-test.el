;;; pi-deck-sidebar-test.el --- Stable sidebar and focus regressions -*- lexical-binding: t; -*-
;; SPDX-License-Identifier: MIT

(require 'ert)
(require 'hl-line)
(require 'pi-deck)

(declare-function evil-mode "evil-core" (&optional arg))
(declare-function evil-normal-state "evil-states" (&optional arg))

(defvar pi-deck-sidebar-test--buffers nil)

(defun pi-deck-sidebar-test--shell (number)
  "Track a live fake shell with creation NUMBER."
  (let* ((buffer (generate-new-buffer (format "*sidebar-shell-%03d*" number)))
         (agent (pi-deck-agent--make :buffer buffer :kind 'shell :state 'idle
                                     :number number :seen t)))
    (push buffer pi-deck-sidebar-test--buffers)
    (make-pipe-process :name (buffer-name buffer) :buffer buffer :noquery t)
    (puthash buffer agent pi-deck--agents)
    agent))

(defun pi-deck-sidebar-test--pi (number)
  "Track an undisplayed Pilish chat and input pair with creation NUMBER."
  (let* ((chat (generate-new-buffer (format " *sidebar-chat-%d*" number)))
         (input (generate-new-buffer (format " *sidebar-input-%d*" number)))
         (agent (pi-deck-agent--make :buffer chat :kind 'pi :number number :state 'idle :seen t)))
    (push chat pi-deck-sidebar-test--buffers)
    (push input pi-deck-sidebar-test--buffers)
    (with-current-buffer input
      (pilish-input-mode)
      (pilish--set-chat-buffer chat))
    (with-current-buffer chat
      (pilish-chat-mode)
      (pilish--set-chat-session-identity temporary-file-directory (format "focus-%d" number))
      (pilish--set-input-buffer input))
    (puthash chat agent pi-deck--agents)
    agent))

(defmacro pi-deck-sidebar-test--with-view (&rest body)
  "Run BODY with an isolated sidebar, registry and window configuration."
  (declare (indent 0))
  `(let ((pi-deck--agents (make-hash-table :test 'eq))
         (pi-deck--finished-workers nil)
         (pi-deck-spaces nil)
         (pi-deck--layouts nil)
         (pi-deck-sidebar-test--buffers nil)
         (pi-deck--update-timer nil)
         (pi-deck-save-delay nil)
         (pi-deck-sidebar-width 28)
         (kill-buffer-query-functions nil)
         (width (frame-width)) (height (frame-height))
         (pairing-was-on (bound-and-true-p pilish-window-pairing-mode)))
     (save-window-excursion
       (set-frame-size nil 160 50)
       (pilish-window-pairing-mode 1)
       (unwind-protect
           (let* ((buffer (generate-new-buffer " *sidebar-view-test*"))
                  (main (selected-window))
                  (sidebar (progn
                             (push buffer pi-deck-sidebar-test--buffers)
                             (with-current-buffer buffer (pi-deck-sidebar-mode))
                             (display-buffer-in-side-window buffer '((side . left) (window-width . 28))))))
             ,@body
             (should (window-live-p main))
             (should (window-live-p sidebar))
             (should (eq (window-buffer sidebar) buffer)))
         (dolist (buffer pi-deck-sidebar-test--buffers)
           (when (buffer-live-p buffer)
             (when-let* ((process (get-buffer-process buffer))) (delete-process process))
             (kill-buffer buffer)))
         (when (timerp pi-deck--update-timer) (cancel-timer pi-deck--update-timer))
         (unless pairing-was-on (pilish-window-pairing-mode -1))
         (set-frame-size nil width height)))))

(defun pi-deck-sidebar-test--row (buffer agent)
  "Return the beginning of AGENT's row in BUFFER."
  (with-current-buffer buffer
    (text-property-any (point-min) (point-max) 'pi-deck-agent agent)))

(ert-deftest pi-deck-sidebar-preserves-each-window-point-and-scroll ()
  (pi-deck-sidebar-test--with-view
    (let* ((agents (cl-loop for n from 1 to 90 collect (pi-deck-sidebar-test--shell n)))
           (other (split-window main nil 'right)))
      (pi-deck-sidebar-refresh buffer)
      (set-window-buffer other buffer)
      (set-window-point sidebar (pi-deck-sidebar-test--row buffer (nth 55 agents)))
      (set-window-start sidebar (pi-deck-sidebar-test--row buffer (nth 50 agents)) t)
      (set-window-point other (pi-deck-sidebar-test--row buffer (nth 30 agents)))
      (set-window-start other (pi-deck-sidebar-test--row buffer (nth 25 agents)) t)
      (select-window main)
      (let ((points (mapcar #'window-point (list sidebar other)))
            (starts (mapcar #'window-start (list sidebar other))))
        (setf (pi-deck-agent-state (nth 70 agents)) 'working)
        (pi-deck-sidebar-refresh buffer)
        (should (equal points (mapcar #'window-point (list sidebar other))))
        (should (equal starts (mapcar #'window-start (list sidebar other)))))
      ;; Insertion/removal above each view moves its markers with the text.
      (let ((new (pi-deck-sidebar-test--shell 0)))
        (pi-deck-sidebar-refresh buffer)
        (should (= (window-point sidebar) (pi-deck-sidebar-test--row buffer (nth 55 agents))))
        (should (= (window-start sidebar) (pi-deck-sidebar-test--row buffer (nth 50 agents))))
        (should (= (window-point other) (pi-deck-sidebar-test--row buffer (nth 30 agents))))
        (should (= (window-start other) (pi-deck-sidebar-test--row buffer (nth 25 agents))))
        (remhash (pi-deck-agent-buffer new) pi-deck--agents)
        (pi-deck-sidebar-refresh buffer)
        (should (= (window-point sidebar) (pi-deck-sidebar-test--row buffer (nth 55 agents))))
        (should (= (window-start other) (pi-deck-sidebar-test--row buffer (nth 25 agents))))))))

(ert-deftest pi-deck-sidebar-fitting-view-shows-from-top-and-column-zero ()
  (pi-deck-sidebar-test--with-view
    (let* ((agents (cl-loop for n from 1 to 60 collect (pi-deck-sidebar-test--shell n))))
      (pi-deck-sidebar-refresh buffer)
      ;; Scrolled down while the sidebar was longer than its window.
      (set-window-start sidebar (pi-deck-sidebar-test--row buffer (nth 40 agents)) t)
      (set-window-point sidebar (pi-deck-sidebar-test--row buffer (nth 45 agents)))
      (dolist (agent (seq-drop agents 10)) (remhash (pi-deck-agent-buffer agent) pi-deck--agents))
      (pi-deck-sidebar-refresh buffer)
      (should (= (window-start sidebar) (with-current-buffer buffer (point-min))))
      ;; A click near the right edge must not scroll rows sideways.
      (should (local-variable-p 'auto-hscroll-mode buffer))
      (should-not (buffer-local-value 'auto-hscroll-mode buffer)))))

(ert-deftest pi-deck-sidebar-refreshes-properties-on-unchanged-text ()
  (pi-deck-sidebar-test--with-view
    (let* ((agent (pi-deck-sidebar-test--shell 1))
           (replacement (pi-deck-agent--make :buffer (pi-deck-agent-buffer agent)
                                              :kind 'shell :number 1 :state 'idle :seen t)))
      (pi-deck-sidebar-refresh buffer)
      (let ((text (with-current-buffer buffer (buffer-string))))
        ;; Highlighting and the object used by clicks can both change while
        ;; the rendered characters remain identical.
        (puthash (pi-deck-agent-buffer agent) replacement pi-deck--agents)
        (set-window-buffer main (pi-deck-agent-buffer replacement))
        (pi-deck-sidebar-refresh buffer)
        (with-current-buffer buffer
          (should (equal text (buffer-string)))
          (let ((row (pi-deck-sidebar-test--row buffer replacement)))
            (should row)
            (should-not (pi-deck-sidebar-test--row buffer agent))
            (should (eq 'pi-deck-shown-agent (get-text-property row 'face)))))
        (set-window-buffer main (get-buffer-create "*scratch*"))
        (pi-deck-sidebar-refresh buffer)
        (with-current-buffer buffer
          (should-not (get-text-property (pi-deck-sidebar-test--row buffer replacement) 'face)))))))

(ert-deftest pi-deck-sidebar-highlights-follow-view-changes ()
  "A switch to an already-seen agent moves the shown highlight; the cursor
line shows only in the selected sidebar."
  (pi-deck-sidebar-test--with-view
    (let ((pi-deck-sidebar-buffer-name (buffer-name buffer))
          (a (pi-deck-sidebar-test--shell 1))
          (b (pi-deck-sidebar-test--shell 2))
          (shown (lambda (agent)
                   (eq 'pi-deck-shown-agent
                       (get-text-property (pi-deck-sidebar-test--row buffer agent) 'face buffer)))))
      (set-window-buffer main (pi-deck-agent-buffer a))
      (pi-deck-sidebar-refresh buffer)
      (should (funcall shown a))
      ;; Batch Emacs runs no redisplay, so call the window-change hook directly.
      (pi-deck-sidebar-track-shown)
      (should-not pi-deck--update-timer)
      (set-window-buffer main (pi-deck-agent-buffer b))
      (pi-deck-sidebar-track-shown)
      (should (timerp pi-deck--update-timer))
      (cancel-timer pi-deck--update-timer)
      (setq pi-deck--update-timer nil)
      (pi-deck-sidebar-refresh buffer)
      (should (funcall shown b))
      (should-not (funcall shown a))
      (pi-deck-sidebar-track-shown)
      (should-not pi-deck--update-timer)
      (with-current-buffer buffer
        (should hl-line-mode)
        (should-not hl-line-sticky-flag)))))

(defconst pi-deck-sidebar-test--press-events
  '(down-mouse-1 down-double-mouse-1 down-triple-mouse-1 triple-mouse-1
    double-drag-mouse-1 triple-drag-mouse-1)
  "Mouse-1 events that must never start a text selection in the sidebar.")

(defun pi-deck-sidebar-test--check-mouse-bindings (buffer row)
  "Check BUFFER's mouse-1 bindings at the agent ROW and on blank space."
  (with-current-buffer buffer
    (dolist (position (list row (point-max)))
      (dolist (event pi-deck-sidebar-test--press-events)
        (should (eq (key-binding (vector event) t nil position) #'ignore))))
    (should (eq (key-binding [drag-mouse-1] t nil row) #'pi-deck-sidebar-mouse-1))
    (should (eq (key-binding [drag-mouse-1] t nil (point-max)) #'ignore))
    (should (eq (key-binding [mouse-1] t nil row) #'pi-deck-sidebar-mouse-1))
    (should (eq (key-binding [double-mouse-1] t nil row) #'pi-deck-sidebar-mouse-only))
    (should (eq (key-binding [mouse-2] t nil row) #'pi-deck-sidebar-mouse-show))
    (should (eq (key-binding [mouse-3] t nil row) #'pi-deck-sidebar-mouse-3))))

(ert-deftest pi-deck-sidebar-mouse-never-selects-text ()
  "Presses select nothing, with or without Evil; a drag acts as a click on
the row where it began."
  (pi-deck-sidebar-test--with-view
    (let ((a (pi-deck-sidebar-test--shell 1))
          (b (pi-deck-sidebar-test--shell 2))
          (kill-ring nil)
          (mouse-drag-copy-region 'non-empty)
          (posn (lambda (position) (list sidebar position '(0 . 0) 0)))
          jumped)
      (pi-deck-sidebar-refresh buffer)
      (let ((row-a (pi-deck-sidebar-test--row buffer a))
            (row-b (pi-deck-sidebar-test--row buffer b)))
        (with-selected-window sidebar
          (pi-deck-sidebar-test--check-mouse-bindings buffer row-a)
          (require 'evil)
          (let ((evil-was-on (bound-and-true-p evil-mode)))
            (evil-mode 1)
            (unwind-protect
                (progn
                  (with-current-buffer buffer (evil-normal-state))
                  (pi-deck-sidebar-test--check-mouse-bindings buffer row-a))
              (unless evil-was-on (evil-mode -1))))
          (cl-letf (((symbol-function 'pi-deck-sidebar-jump)
                     (lambda () (setq jumped (get-text-property (point) 'pi-deck-agent)))))
            (call-interactively
             (with-current-buffer buffer (key-binding [drag-mouse-1] t nil row-a))
             nil
             (vector (list 'drag-mouse-1 (funcall posn row-a) (funcall posn (+ 2 row-b)))))))
        (should (eq jumped a))
        (should-not (buffer-local-value 'mark-active buffer))
        (should-not kill-ring)))))

(ert-deftest pi-deck-sidebar-keeps-fold-state-and-deleted-row-cursor-valid ()
  (pi-deck-sidebar-test--with-view
    (let ((agents (cl-loop for n from 1 to 30 collect (pi-deck-sidebar-test--shell n))))
      (pi-deck-sidebar-refresh buffer)
      (set-window-point sidebar (pi-deck-sidebar-test--row buffer (nth 15 agents)))
      (remhash (pi-deck-agent-buffer (nth 15 agents)) pi-deck--agents)
      (pi-deck-sidebar-refresh buffer)
      (with-current-buffer buffer
        (should (<= (point-min) (window-point sidebar) (point-max)))
        (should (get-text-property (window-point sidebar) 'pi-deck-agent))
        (setq pi-deck-sidebar--collapsed '("other")))
      (pi-deck-sidebar-refresh buffer)
      (should-not (pi-deck-sidebar-test--row buffer (car agents)))
      (with-current-buffer buffer (setq pi-deck-sidebar--collapsed nil))
      (pi-deck-sidebar-refresh buffer)
      (should (pi-deck-sidebar-test--row buffer (car agents))))))

(ert-deftest pi-deck-sidebar-cleanup-forgets-only-empty-finished-folds ()
  (pi-deck-sidebar-test--with-view
    (let* ((parent (pi-deck-sidebar-test--shell 1))
           (shell (pi-deck-sidebar-test--shell 2))
           (parent-buffer (pi-deck-agent-buffer parent)))
      (delete-process (pi-deck-agent-process shell))
      (setf (pi-deck-agent-target shell) "finished-panel")
      (setq pi-deck--finished-workers (list (list :parent parent-buffer :name "worker")))
      (with-current-buffer buffer
        (setq pi-deck-sidebar--expanded-workers (list parent-buffer)
              pi-deck-sidebar--expanded-shells '("other")))
      (cl-letf (((symbol-function 'pi-orchestration-stop-target)
                 (lambda (_ &optional callback) (funcall callback "Owner unavailable"))))
        (pi-deck-clear-finished))
      (pi-deck-sidebar-refresh buffer)
      (with-current-buffer buffer
        (should-not pi-deck-sidebar--expanded-workers)
        (should (equal pi-deck-sidebar--expanded-shells '("other"))))
      (setf (pi-deck-agent-target shell) nil)
      (pi-deck-clear-finished)
      (pi-deck-sidebar-refresh buffer)
      (with-current-buffer buffer (should-not pi-deck-sidebar--expanded-shells)))))

(ert-deftest pi-deck-sidebar-header-keeps-cleanup-and-optional-items ()
  (pi-deck-sidebar-test--with-view
    (let* ((item-map (define-keymap "<header-line> <mouse-1>" #'ignore))
           (pi-deck-sidebar-header-items
            (list (lambda () (propertize "item" 'local-map item-map
                                        'help-echo "Optional item"))
                  (lambda () nil)))
           (line (with-selected-window sidebar (pi-deck-sidebar-header))))
      (should (string-match-p "item \\[×\\]\\'" line))
      (should (eq (get-text-property (string-search "item" line) 'local-map line) item-map))
      (should (equal (get-text-property (string-search "item" line) 'help-echo line)
                     "Optional item"))
      (should (equal (get-text-property (string-search "[×]" line) 'help-echo line)
                     "No finished workers or shells to clear"))
      (should (eq (lookup-key (get-text-property (string-search "[×]" line) 'local-map line)
                             [header-line mouse-1]) #'ignore)))))

(ert-deftest pi-deck-sidebar-double-click-obeys-automatic-positioning ()
  (pi-deck-sidebar-test--with-view
    (let* ((chat (generate-new-buffer " *sidebar-focus-chat*"))
           (input (generate-new-buffer " *sidebar-focus-input*"))
           (agent (pi-deck-agent--make :buffer chat :kind 'pi :number 1 :state 'idle :seen t))
           target)
      (push chat pi-deck-sidebar-test--buffers)
      (push input pi-deck-sidebar-test--buffers)
      (with-current-buffer input
        (pilish-input-mode)
        (pilish--set-chat-buffer chat)
        (insert "draft stays"))
      (with-current-buffer chat
        (pilish-chat-mode)
        (pilish--set-chat-session-identity temporary-file-directory "focus")
        (pilish--set-input-buffer input)
        (let ((inhibit-read-only t))
          (dotimes (_ 60) (insert "old output\n"))
          (setq target (point))
          (dotimes (_ 100) (insert "final answer\n")))
        (setq-local pilish-jump-to-answer t)
        (pilish--answer-arm target)
        (setq pilish--answer-settled t))
      (puthash chat agent pi-deck--agents)
      (pi-deck--display-agent-in-window agent main)
      (pi-deck-sidebar-refresh buffer)
      (let* ((row (pi-deck-sidebar-test--row buffer agent))
             (event (lambda (type) (list type (list sidebar row '(0 . 0) 0)))))
        (dolist (enabled '(t nil))
          (with-current-buffer chat (setq pilish-jump-to-answer enabled))
          (set-window-point (get-buffer-window chat) 1)
          (set-window-start (get-buffer-window chat) 1 t)
          (select-window sidebar)
          (pi-deck-sidebar-mouse-1 (funcall event 'mouse-1))
          (pi-deck-sidebar-mouse-only (funcall event 'double-mouse-1))
          (should (= (window-point (get-buffer-window chat)) (if enabled target 1)))
          (should (eq (window-buffer) input))
          (should (equal (with-current-buffer input (buffer-string)) "draft stays")))
        (with-current-buffer chat
          (let ((pi-deck-mode t))
            (should (string-match-p "\\[J\\]" (pi-deck-pane-header)))))
        ;; Explicit latest output remains unconditional, even with [J] off.
        (pi-deck-header-latest (list 'mouse-1 (list (get-buffer-window chat) 'header-line)))
        (should (= (window-point (get-buffer-window chat)) (with-current-buffer chat (point-max))))))))

(ert-deftest pi-deck-sidebar-removing-the-selected-pane-focuses-an-input ()
  "Close removes the selected pane; typing then edits a draft, not a chat."
  (pi-deck-sidebar-test--with-view
    (let* ((a (pi-deck-sidebar-test--pi 1))
           (b (pi-deck-sidebar-test--pi 2))
           (b-input (pilish-session-input-buffer (pi-deck-agent-buffer b))))
      (pi-deck--display-agent-in-window b main)
      (pi-deck--show-beside a main)
      ;; B's chat was used last before A's input: Emacs selects it next.
      (select-window main)
      (select-window (get-buffer-window (pilish-session-input-buffer (pi-deck-agent-buffer a))))
      (pi-deck--remove-views (pi-deck-agent-windows-buffers a))
      (should-not (get-buffer-window (pi-deck-agent-buffer a)))
      (should (eq (window-buffer) b-input))
      ;; Removing a pane that was not selected keeps the selection.
      (let ((c (pi-deck-sidebar-test--pi 3)))
        (pi-deck--show-beside c main)
        (select-window main)
        (pi-deck--remove-views (pi-deck-agent-windows-buffers c))
        (should (eq (selected-window) main)))
      ;; A sidebar-initiated close keeps the sidebar selected.
      (let ((d (pi-deck-sidebar-test--pi 4)))
        (pi-deck--show-beside d main)
        (select-window sidebar)
        (pi-deck--remove-views (pi-deck-agent-windows-buffers d))
        (should (eq (selected-window) sidebar))))))

(ert-deftest pi-deck-sidebar-restored-layout-focuses-the-pane-input ()
  "Pair repair replaces a restored layout's selected input window."
  (pi-deck-sidebar-test--with-view
    (let* ((agent (pi-deck-sidebar-test--pi 1))
           (input (pilish-session-input-buffer (pi-deck-agent-buffer agent)))
           (dir (file-name-as-directory (make-temp-file "deck-focus-" t))))
      (unwind-protect
          (progn
            (pi-deck--register-space "space" dir)
            (push (dired-noselect dir) pi-deck-sidebar-test--buffers)
            ;; As `pi-deck--sidebar-show' sets it: layouts never delete the sidebar.
            (set-window-parameter sidebar 'no-delete-other-windows t)
            (pi-deck--display-agent-in-window agent main)
            (select-window (get-buffer-window input))
            (pi-deck--remember-layout "space" (window-state-get (window-main-window) t))
            (pi-deck--apply-layout "space")
            (should (eq (window-buffer) input))
            (should (eq (cdr (pilish-window-pair (selected-window))) (selected-window))))
        (delete-directory dir t)))))

(ert-deftest pi-deck-sidebar-finished-worker-rows-keep-their-age-in-the-width ()
  (pi-deck-sidebar-test--with-view
    (let ((parent (pi-deck-agent-buffer (pi-deck-sidebar-test--shell 1))))
      (setq pi-deck--finished-workers
            (list (list :parent parent :time (- (float-time) 125)
                        :name "In wordcount, python3 -m unittest fails; fix the root cause")
                  (list :parent parent :name "short" :time (float-time))))
      (with-current-buffer buffer (setq pi-deck-sidebar--expanded-workers (list parent)))
      (pi-deck-sidebar-refresh buffer)
      (let ((rows (seq-filter (lambda (row) (string-search "✓" row))
                              (split-string (with-current-buffer buffer (buffer-string)) "\n"))))
        (should (equal (car rows) "     ✓ In wordcount, …  2m"))
        (should (string-match-p "\\`     ✓ short  [0-9]+s\\'" (cadr rows)))
        ;; Text terminals reserve a row's last column, as for the ✕ buttons.
        (dolist (row rows)
          (should (<= (string-width row) (- pi-deck-sidebar-width 2))))))))

(provide 'pi-deck-sidebar-test)
;;; pi-deck-sidebar-test.el ends here
