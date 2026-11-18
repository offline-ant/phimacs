;;; pi-deck-layout-test.el --- Space, layout and pane tests -*- lexical-binding: t; -*-

;; SPDX-License-Identifier: MIT

;;; Commentary:

;; Spaces with their hidden layouts, new agents and shells, and chat/input panes.
;; Fixtures: pi-deck-test-fixtures.el.

;;; Code:

(require 'pi-deck-test-fixtures)

;;;; Spaces and layouts

(ert-deftest pi-deck-test-spaces-have-one-hidden-layout-each ()
  (pi-deck-test--with-deck
    (let ((one (file-name-as-directory (expand-file-name "one" dir)))
          (two (file-name-as-directory (expand-file-name "two" dir))))
      (make-directory one) (make-directory two)
      (should-not tab-bar-show)
      (should-not (pi-deck-current-space))
      ;; The first space takes the frame's ungrouped tab.
      (should (equal (pi-deck-create-space one) "one"))
      (should (= (length (tab-bar-tabs)) 1))
      (should (equal (pi-deck-current-space) "one"))
      (should (equal (pi-deck-space-dir "one") one))
      (should (pi-deck-test--in-dired-p))
      (pi-deck-create-space two "two")
      (should (equal (pi-deck-space-names) '("one" "two")))
      (should (equal (mapcar #'pi-deck--tab-group (tab-bar-tabs)) '("one" "two")))
      (should (equal pi-deck--last-space "two"))
      ;; Each space keeps its own layout; leaving one remembers it.
      (split-window-right)
      (with-current-buffer (messages-buffer)
        (let ((inhibit-read-only t)) (erase-buffer)))
      (pi-deck-switch-space "one")
      (should (one-window-p))
      ;; The hidden tab bar does not report the switch in the echo area.
      (should-not (with-current-buffer (messages-buffer)
                    (string-search "Selected tab" (buffer-string))))
      (should (equal pi-deck--last-space "one"))
      (should (assoc "two" pi-deck--layouts))
      (pi-deck-switch-space "two")
      (should (= (length (window-list nil 'no-minibuf)) 2))
      (should (= (length (tab-bar-tabs)) 2))
      (pi-deck-rename-space "deux")
      (should (equal (pi-deck-current-space) "deux"))
      (should (equal (pi-deck-space-dir "deux") two))
      (should (equal pi-deck--last-space "deux"))
      (should (assoc "deux" pi-deck--layouts))
      (should-not (assoc "two" pi-deck--layouts))
      ;; Closing a space drops its layout everywhere.
      (pi-deck-close-space "deux")
      (should-not (pi-deck-space "deux"))
      (should-not (assoc "deux" pi-deck--layouts))
      (should (equal (mapcar #'pi-deck--tab-group (tab-bar-tabs)) '("one")))
      (should (equal (pi-deck-current-space) "one"))
      (should (equal pi-deck--last-space "one"))
      ;; Without spaces the frame keeps one ungrouped tab.
      (pi-deck-close-space "one")
      (should (= (length (tab-bar-tabs)) 1))
      (should-not (pi-deck-current-space))
      (should-not pi-deck--last-space))))

(ert-deftest pi-deck-test-layouts-seed-frames-without-the-space ()
  (pi-deck-test--with-large-frame
   (pi-deck-test--with-deck
    (pi-deck-create-space dir "space")
    (let ((a (pi-deck-test--session dir "a"))
          (b (pi-deck-test--session dir "b")))
      (pi-deck--display-agent-in-window (pi-deck-agent a) (selected-window))
      (pi-deck-show-beside (pi-deck-agent b))
      (pi-deck-sidebar-toggle)
      (pi-deck--remember-current-layout)
      ;; The sidebar is no part of a layout.
      (should-not (member pi-deck-sidebar-buffer-name
                          (window-state-buffers (cdr (assoc "space" pi-deck--layouts)))))
      ;; A new frame: one ungrouped tab with one window.
      (set-frame-parameter nil 'tabs nil)
      (pi-deck--single-window)
      (switch-to-buffer "*scratch*")
      (should-not (pi-deck-current-space))
      (pi-deck-setup-frame)
      (should (equal (pi-deck-current-space) "space"))
      (should (= (length (tab-bar-tabs)) 1))
      (should (pilish-window-pair (get-buffer-window a)))
      (should (pilish-window-pair (get-buffer-window b)))
      (should (get-buffer-window pi-deck-sidebar-buffer-name))))))

(ert-deftest pi-deck-test-new-frames-open-the-last-space ()
  (pi-deck-test--with-deck
    (let ((two (make-temp-file "pi-deck-two-" t)))
      ;; Nothing to open yet.
      (pi-deck-setup-frame)
      (should-not (pi-deck-current-space))
      (pi-deck-create-space dir "one")
      (pi-deck-create-space two "two")
      (pi-deck-switch-space "one")
      ;; A new frame shows the space selected last.
      (set-frame-parameter nil 'tabs nil)
      (pi-deck-setup-frame)
      (should (equal (pi-deck-current-space) "one"))
      (should (= (length (tab-bar-tabs)) 1))
      ;; A frame already showing a space keeps it.
      (pi-deck-switch-space "two")
      (setq pi-deck--last-space "one")
      (pi-deck-setup-frame)
      (should (equal (pi-deck-current-space) "two"))
      ;; A closing frame leaves its layout to later frames.
      (set-window-buffer (split-window-right) "*scratch*")
      (pi-deck-remember-frame (selected-frame))
      (should (member "*scratch*" (window-state-buffers (cdr (assoc "two" pi-deck--layouts)))))
      (delete-directory two t))))

(ert-deftest pi-deck-test-agent-space-resolution-and-rollup ()
  (pi-deck-test--with-deck
    (let* ((project (file-name-as-directory (expand-file-name "proj" dir)))
           (sub (expand-file-name "sub" project)))
      (make-directory sub t)
      (pi-deck-create-space project "proj")
      (let* ((by-dir (pi-deck-agent (pi-deck-test--session sub "nested")))
             (parent (pi-deck-agent (pi-deck-test--session dir "parent")))
             (child (pi-deck-agent (pi-deck-test--session dir "child"))))
        (should (equal (pi-deck-agent-space by-dir) "proj"))
        (should-not (pi-deck-agent-space parent))
        (setf (pi-deck-agent-assigned-space parent) "proj"
              (pi-deck-agent-parent child) (pi-deck-agent-buffer parent))
        (should (equal (pi-deck-agent-space child) "proj"))
        (pi-deck-test--phase (pi-deck-agent-buffer child) "thinking")
        (should (eq (cdr (assoc "proj" (pi-deck-space-statuses))) 'working))
        (pi-deck-create-space (make-temp-file "pi-deck-elsewhere-" t) "elsewhere")
        (switch-to-buffer (pi-deck-agent-buffer by-dir))
        (should (equal (pi-deck-agent-space by-dir) "proj"))
        ;; Only an agent nothing else places takes the space showing it.
        (let ((loose (pi-deck-agent (pi-deck-test--session (make-temp-file "pi-deck-loose-" t) "loose"))))
          (should-not (pi-deck-agent-space loose))
          (switch-to-buffer (pi-deck-agent-buffer loose))
          (should (equal (pi-deck-agent-space loose) "elsewhere")))))))

(ert-deftest pi-deck-test-new-agent-and-shell-in-space ()
  (pi-deck-test--with-large-frame
   (pi-deck-test--with-deck
    (pi-deck-create-space dir "space")
    (let (started)
      (cl-letf (((symbol-function 'pilish-start-session)
                 (lambda (directory name &rest _)
                   (push (list directory name) started)
                   (pi-deck-test--session directory name))))
        ;; The first agent takes the space's only pane.
        (let ((agent (pi-deck-new-agent nil)))
          (should (equal (car started) (list (file-name-as-directory dir) "1")))
          (should (eq (window-buffer) (pilish-session-input-buffer (pi-deck-agent-buffer agent))))
          (should (equal (pi-deck-agent-space agent) "space"))
          (should (= (length (window-list nil 'no-minibuf)) 2))
          ;; A second agent opens beside it in the same layout.
          (let ((second (pi-deck-new-agent "two")))
            (should (= (length (tab-bar-tabs)) 1))
            (should (= (length (window-list nil 'no-minibuf)) 4))
            (should (pilish-window-pair (get-buffer-window (pi-deck-agent-buffer agent))))
            (should (eq (window-buffer)
                        (pilish-session-input-buffer (pi-deck-agent-buffer second))))))))
    (let ((shell (pi-deck-new-shell)))
      (should (eq (window-buffer) (pi-deck-agent-buffer shell)))
      (should (equal (pi-deck-agent-assigned-space shell) "space"))
      (should (= (length (window-list nil 'no-minibuf)) 5))
      (pi-deck-zoom)
      (should (one-window-p))
      (pi-deck-zoom)
      (should-not (one-window-p))))))

(ert-deftest pi-deck-test-new-agent-outside-a-space-reads-one ()
  (pi-deck-test--with-deck
    (let ((other (make-temp-file "pi-deck-other-" t)) started)
      (pi-deck-create-space other "other-space")
      (pi-deck-create-space dir "space")
      (cl-letf (((symbol-function 'pilish-start-session)
                 (lambda (directory name &rest _)
                   (push (list directory name) started)
                   (pi-deck-test--session directory name)))
                ((symbol-function 'read-string) (lambda (&rest _) "")))
        ;; The sidebar starts agents in the space at point and shows them.
        (with-current-buffer (pi-deck-sidebar-buffer)
          (pi-deck-sidebar-refresh)
          (goto-char (point-min))
          (search-forward "other-space")
          (pi-deck-sidebar-new-agent))
        (should (equal (car started) (list (file-name-as-directory other) "1")))
        (should (equal (pi-deck-current-space) "other-space"))
        ;; A frame showing no space reads the space first.
        (set-frame-parameter nil 'tabs nil)
        (cl-letf (((symbol-function 'completing-read) (lambda (&rest _) "space")))
          (call-interactively #'pi-deck-new-agent))
        (should (equal (car started) (list (file-name-as-directory dir) "1")))
        (should (equal (pi-deck-current-space) "space"))
        ;; The picker lists the spaces and a "New space…" entry, which
        ;; creates a space for a picked directory.
        (set-frame-parameter nil 'tabs nil)
        (let ((fresh (make-temp-file "pi-deck-fresh-" t)) offered)
          (cl-letf (((symbol-function 'completing-read)
                     (lambda (prompt table &rest _)
                       (if (string-prefix-p "Space:" prompt)
                           (progn (setq offered (all-completions "" table))
                                  pi-deck--new-space-choice)
                         fresh)))
                    ((symbol-function 'read-directory-name) (lambda (&rest _) fresh)))
            (call-interactively #'pi-deck-new-agent))
          (should (equal offered (list "other-space" "space" pi-deck--new-space-choice)))
          (should (equal (car started) (list (file-name-as-directory fresh) "1")))
          (should (equal (pi-deck-current-space) (file-name-nondirectory fresh)))
          (delete-directory fresh t)))
      (delete-directory other t))))

(ert-deftest pi-deck-test-space-directory-prompt-offers-typed-directory ()
  (let* ((root (directory-file-name (make-temp-file "pi-deck-root-" t)))
         (project (file-name-as-directory (expand-file-name "proj" root)))
         (projects (list project))
         (table (pi-deck--project-dir-table projects root)))
    (unwind-protect
        (progn
          (make-directory project)
          ;; An existing directory that is no project comes first, annotated.
          (should (equal (all-completions root table) (list root project)))
          (let ((metadata (completion-metadata "" table nil)))
            (should (eq (completion-metadata-get metadata 'display-sort-function) #'identity))
            (should (equal (funcall (completion-metadata-get metadata 'annotation-function) root)
                           "  (typed)"))
            (should-not (funcall (completion-metadata-get metadata 'annotation-function) project)))
          ;; Empty, missing and already listed directories add nothing.
          (should (equal (all-completions "" table) projects))
          (should (equal (all-completions (expand-file-name "nope" root) table) nil))
          (should (equal (all-completions (directory-file-name project) table) projects))
          (should (equal (all-completions project table) projects))
          ;; Relative and ~ input is checked against the base directory and home.
          (should (equal (all-completions ".." (pi-deck--project-dir-table projects project))
                         (list "..")))
          (should (equal (all-completions "~" table) (list "~")))
          ;; Styles that call the table with an empty string still see the input.
          (cl-letf (((symbol-function 'minibufferp) (lambda (&rest _) t))
                    ((symbol-function 'minibuffer-contents-no-properties) (lambda () root)))
            (let* ((completion-styles '(substring))
                   (all (completion-all-completions root table nil (length root))))
              (setcdr (last all) nil)   ; drop the base size
              (should (equal (mapcar #'substring-no-properties all) (list root project)))))
          ;; The prompt returns the expanded choice; empty input takes the default.
          (let ((default-directory (file-name-as-directory root)) answer read-dir)
            (cl-letf (((symbol-function 'project-known-project-roots) (lambda () projects))
                      ((symbol-function 'completing-read)
                       (lambda (_prompt _table _pred _req _init _hist default)
                         (if (string-empty-p answer) default answer))))
              (dolist (case `(("proj" . ,(directory-file-name project))
                              ("~" . ,(expand-file-name "~"))
                              ("" . ,(file-name-as-directory root))))
                (setq answer (car case))
                (should (equal (pi-deck--read-project-dir) (cdr case)))))
            ;; Without known projects it reads a plain directory name.
            (cl-letf (((symbol-function 'project-known-project-roots) #'ignore)
                      ((symbol-function 'read-directory-name)
                       (lambda (&rest _) (setq read-dir t) "proj/")))
              (should (equal (pi-deck--read-project-dir) project))
              (should read-dir))))
      (delete-directory root t))))

;;;; Panes

(ert-deftest pi-deck-test-panes-keep-chat-and-input-together ()
  (pi-deck-test--with-deck
    (pi-deck-create-space dir "space")
    (cl-letf (((symbol-function 'pilish-start-session)
               (lambda (directory name &rest _) (pi-deck-test--session directory name))))
      (let* ((agent (pi-deck-new-agent "a"))
             (chat-window (get-buffer-window (pi-deck-agent-buffer agent)))
             (input-window (selected-window))
             (height (window-height input-window)))
        (should-not (eq chat-window input-window))
        (should (eq (pi-deck--pane-of input-window) (window-parent chat-window)))
        ;; Splitting splits the whole pane; the input keeps its height.
        (pi-deck-split-right)
        (let ((new (selected-window)))
          (should-not (memq new (list chat-window input-window)))
          (should-not (eq (window-parent new) (window-parent chat-window)))
          (should (= (window-height input-window) height))
          ;; Zooming the chat pane keeps chat and input; zooming again restores.
          (select-window input-window)
          (pi-deck-zoom)
          (should-not (window-live-p new))
          (should (and (window-live-p chat-window) (window-live-p input-window)))
          (pi-deck-zoom)
          (should (= (length (window-list nil 'no-minibuf)) 3)))))))

(ert-deftest pi-deck-test-hiding-panes-keeps-agents ()
  (pi-deck-test--with-large-frame
   (pi-deck-test--with-deck
    (pi-deck-create-space dir "space")
    (let* ((a (pi-deck-test--session dir "a"))
           (b (pi-deck-test--session dir "b"))
           (shell (pi-deck-start-shell dir "shell:space" '("/bin/sh" "-c" "read line"))))
      (pi-deck-refresh)
      (pi-deck--display-agent-in-window (pi-deck-agent a) (selected-window))
      (pi-deck-show-beside (pi-deck-agent b))
      (should (pilish-window-pair (get-buffer-window a)))
      (should (pilish-window-pair (get-buffer-window b)))
      ;; A terminal takes the place of the whole pair it is shown in.
      (pi-deck--display-agent-in-window (pi-deck-agent shell) (get-buffer-window b))
      (should-not (get-buffer-window b))
      (should-not (get-buffer-window (pilish-session-input-buffer b)))
      (should (pilish-window-pair (get-buffer-window a)))
      ;; Hiding a pane hides a chat with its input; the agent runs on.
      (pi-deck-hide-pane (get-buffer-window a))
      (should-not (get-buffer-window a))
      (should-not (get-buffer-window (pilish-session-input-buffer a)))
      (should (buffer-live-p a))
      (should (pi-deck-agent a))
      ;; The only pane shows the space's directory instead.
      (select-window (get-buffer-window shell))
      (pi-deck-hide-pane)
      (should (one-window-p))
      (should (pi-deck-test--in-dired-p))
      (should (process-live-p (get-buffer-process shell)))))))

(ert-deftest pi-deck-test-repair-panes-rebuilds-pairs ()
  (pi-deck-test--with-deck
    (pi-deck-create-space dir "space")
    (let* ((chat (pi-deck-test--session dir "a"))
           (input (pilish-session-input-buffer chat)))
      (pi-deck--display-agent-in-window (pi-deck-agent chat) (selected-window))
      (delete-window (get-buffer-window input))
      (should-not (get-buffer-window input))
      (pi-deck-repair-panes)
      (should (eq (cdr (pilish-window-pair (get-buffer-window chat)))
                  (get-buffer-window input)))
      ;; An input shown alone gets its chat back above it.
      (pi-deck--single-window)
      (switch-to-buffer input)
      (pi-deck-repair-panes)
      (should (eq (car (pilish-window-pair (selected-window))) (get-buffer-window chat))))))

(ert-deftest pi-deck-test-reveal-focuses-switches-or-replaces ()
  (pi-deck-test--with-large-frame
   (pi-deck-test--with-deck
    (let ((two (make-temp-file "pi-deck-two-" t)))
      (pi-deck-create-space two "two")
      (pi-deck-create-space dir "space")
      (let* ((parent (pi-deck-agent (pi-deck-test--session dir "parent")))
             (worker (pi-deck-agent (pi-deck-test--session "/tmp/" "worker")))
             (other (pi-deck-agent (pi-deck-test--session dir "other")))
             (far (pi-deck-agent (pi-deck-test--session two "far")))
             (shown (lambda (agent) (get-buffer-window (pi-deck-agent-buffer agent)))))
        (setf (pi-deck-agent-parent worker) (pi-deck-agent-buffer parent)
              (pi-deck-agent-target worker) "t-1")
        (pi-deck--display-agent-in-window parent (selected-window))
        ;; A worker opens beside its parent on screen, focused.
        (pi-deck-reveal worker)
        (should (funcall shown parent))
        (should (eq (pilish-session-chat-buffer (window-buffer)) (pi-deck-agent-buffer worker)))
        ;; An agent on screen is just focused.
        (let ((count (length (window-list nil 'no-minibuf))))
          (pi-deck-reveal parent)
          (should (= (length (window-list nil 'no-minibuf)) count))
          (should (eq (pilish-session-chat-buffer (window-buffer)) (pi-deck-agent-buffer parent))))
        ;; Others replace the most recently used pane.
        (pi-deck-reveal other)
        (should-not (funcall shown parent))
        (should (funcall shown worker))
        (should (eq (pilish-session-chat-buffer (window-buffer)) (pi-deck-agent-buffer other)))
        ;; An agent of another space shows in that space's layout.
        (pi-deck-reveal far)
        (should (equal (pi-deck-current-space) "two"))
        (should (funcall shown far))
        (pi-deck-reveal other)
        (should (equal (pi-deck-current-space) "space"))
        (should (funcall shown worker)))
      (delete-directory two t)))))

(provide 'pi-deck-layout-test)
;;; pi-deck-layout-test.el ends here
