;;; pi-deck-ui-test.el --- Sidebar, title bar and menu tests -*- lexical-binding: t; -*-

;; SPDX-License-Identifier: MIT

;;; Commentary:

;; Sidebar tree, clicks, order and width; pane title bars and context menus.
;; Fixtures: pi-deck-test-fixtures.el.

;;; Code:

(require 'pi-deck-test-fixtures)

;;;; Sidebar

(ert-deftest pi-deck-test-sidebar-follows-spaces ()
  (pi-deck-test--with-deck
    (pi-deck-create-space dir "space")
    (pi-deck-test--session dir "a")
    (pi-deck-sidebar-toggle)
    (should (get-buffer-window pi-deck-sidebar-buffer-name))
    (with-current-buffer pi-deck-sidebar-buffer-name
      (should (string-match-p "○ a" (buffer-string))))
    (pi-deck-create-space (make-temp-file "pi-deck-two-" t) "two")
    (should (get-buffer-window pi-deck-sidebar-buffer-name))
    (pi-deck-sidebar-toggle)
    (should-not (get-buffer-window pi-deck-sidebar-buffer-name))
    (pi-deck-switch-space "space")
    (should-not (get-buffer-window pi-deck-sidebar-buffer-name))))

(ert-deftest pi-deck-test-sidebar-width-is-shared-and-narrow-frames-hide-it ()
  (pi-deck-test--with-large-frame
   (pi-deck-test--with-deck
    (setq pi-deck-sidebar-width 30)
    (let ((sidebar (lambda () (get-buffer-window pi-deck-sidebar-buffer-name))))
      (pi-deck-create-space dir "space")
      (pi-deck-sidebar-toggle)
      (should (= (window-total-width (funcall sidebar)) 30))
      (pi-deck-create-space (make-temp-file "pi-deck-two-" t) "two")
      (should (= (window-total-width (funcall sidebar)) 30))
      ;; A drag: the sidebar changes width in an unchanged frame.
      (let ((window (funcall sidebar)))
        (window-resize window 6 t t)
        (cl-letf (((symbol-function 'window-old-pixel-width)
                   (lambda (window*)
                     (if (eq window* window) 1 (window-pixel-width window*)))))
          (pi-deck--on-window-size-change (selected-frame))))
      (should (= pi-deck-sidebar-width 36))
      ;; The dragged width is saved.
      (let ((pi-deck-sidebar-width 0))
        (pi-deck-load-preferences)
        (should (= pi-deck-sidebar-width 36)))
      ;; Every space's sidebar gets the new width.
      (pi-deck-switch-space "space")
      (should (= (window-total-width (funcall sidebar)) 36))
      ;; Frames without room for panes beside it hide it; it comes back.
      (set-frame-size nil (+ 36 pi-deck-sidebar-min-pane-width) 50)
      (pi-deck--sidebar-sync)
      (should (funcall sidebar))
      (set-frame-size nil (+ 35 pi-deck-sidebar-min-pane-width) 50)
      (pi-deck--sidebar-sync)
      (should-not (funcall sidebar))
      (should pi-deck-sidebar)
      (set-frame-size nil 160 50)
      ;; A frame resize resyncs after the redisplay.
      (cl-letf (((symbol-function 'window-old-pixel-width) (lambda (_) 1)))
        (pi-deck--on-window-size-change (selected-frame)))
      (should (pi-deck-test--wait (lambda () (funcall sidebar))))
      (should (= (window-total-width (funcall sidebar)) 36))))))

(ert-deftest pi-deck-test-sidebar-header-summary-and-items ()
  (pi-deck-test--with-deck
    (setq pi-deck-sidebar-width 36)
    (pi-deck-create-space dir "space")
    (pi-deck-sidebar-toggle)
    (let* ((sidebar (get-buffer-window pi-deck-sidebar-buffer-name))
           (header (lambda () (with-selected-window sidebar (pi-deck-sidebar-header))))
           (text (lambda () (substring-no-properties (funcall header)))))
      (should (equal (buffer-local-value 'header-line-format (window-buffer sidebar))
                     '(:eval (pi-deck-sidebar-header))))
      (should (equal (funcall text) " no agents [×]"))
      (let ((a (pi-deck-test--session dir "a"))
            (b (pi-deck-test--session dir "b")))
        (should (equal (funcall text) " all idle [×]"))
        (pi-deck-test--phase a "thinking")
        (pi-deck-test--phase b "thinking")
        (pi-deck-test--phase b "idle")
        (should (equal (funcall text) " ● 1 done · ◐ 1 working [×]"))
        ;; Clicking the summary goes to the next agent needing attention.
        (let ((summary (funcall header)))
          (should (eq (keymap-lookup (get-text-property 1 'local-map summary)
                                     "<header-line> <mouse-1>")
                      #'pi-deck-next-attention)))
        ;; Extra items go right, before cleanup; nil items are left out, and % is
        ;; escaped for the header line.
        (let* ((map (make-sparse-keymap))
               (pi-deck-sidebar-header-items
                (list (lambda () (propertize "item 5%" 'local-map map)) #'ignore)))
          (should (string-match-p "working .*item 5%% \\[×\\]\\'" (funcall text)))
          (let ((line (funcall header)))
            (should (eq (get-text-property (string-search "item" line) 'local-map line) map))))
        ;; Without room, status names are left out.
        (let ((pi-deck-sidebar-header-items (list (lambda () (make-string 25 ?x)))))
          (should (string-prefix-p " ● 1 · ◐ 1" (funcall text))))))))

(defun pi-deck-test--space-name-position (space)
  "Return SPACE's name position in the current sidebar, after its arrow."
  (save-excursion
    (goto-char (pi-deck-test--position 'pi-deck-space space))
    (search-forward space (line-end-position))
    (- (point) (length space))))

(ert-deftest pi-deck-test-sidebar-click-shows-agents ()
  (pi-deck-test--with-large-frame
   (pi-deck-test--with-deck
    (pi-deck-create-space dir "space")
    (let* ((parent (pi-deck-test--session dir "parent"))
           (worker (pi-deck-test--session dir "worker"))
           (other (pi-deck-test--session dir "other"))
           (row-of (lambda (sidebar chat)
                     (with-current-buffer (window-buffer sidebar)
                       (pi-deck-sidebar-refresh)
                       (text-property-any (point-min) (point-max)
                                          'pi-deck-agent (pi-deck-agent chat))))))
      (setf (pi-deck-agent-parent (pi-deck-agent worker)) parent
            (pi-deck-agent-target (pi-deck-agent worker)) "t-1")
      (pi-deck--display-agent-in-window (pi-deck-agent parent) (selected-window))
      (pi-deck-sidebar-toggle)
      (let ((sidebar (get-buffer-window pi-deck-sidebar-buffer-name)))
        (should (eq (window-parameter sidebar 'window-side) 'left))
        ;; A worker opens beside its shown parent.
        (select-window sidebar)
        (pi-deck-sidebar-mouse-1 (pi-deck-test--click sidebar (funcall row-of sidebar worker)))
        (should (eq (pilish-session-chat-buffer (window-buffer)) worker))
        (should (get-buffer-window parent))
        ;; Another agent replaces the main view.
        (select-window sidebar)
        (pi-deck-sidebar-mouse-1 (pi-deck-test--click sidebar (funcall row-of sidebar other)))
        (should (eq (pilish-session-chat-buffer (window-buffer)) other))
        (should-not (get-buffer-window worker))
        (should (eq (get-buffer-window pi-deck-sidebar-buffer-name) sidebar))
        ;; Middle-click shows a row beside the current pane, keeping focus.
        (select-window sidebar)
        (pi-deck-sidebar-mouse-show
         (pi-deck-test--click sidebar (funcall row-of sidebar worker) 'mouse-2))
        (should (eq (selected-window) sidebar))
        (should (get-buffer-window worker))
        (should (get-buffer-window other))
        ;; Pane commands from the sidebar act on the main view.
        (let ((count (length (pi-deck-test--main-windows))))
          (pi-deck-split-right)
          (should-not (window-parameter nil 'window-side))
          (should (> (length (pi-deck-test--main-windows)) count))
          (should (eq (get-buffer-window pi-deck-sidebar-buffer-name) sidebar))))))))

(ert-deftest pi-deck-test-sidebar-double-click-shows-only-that-agent ()
  (pi-deck-test--with-large-frame
   (pi-deck-test--with-deck
    (pi-deck-create-space dir "space")
    (let* ((a (pi-deck-test--session dir "a"))
           (b (pi-deck-test--session dir "b")))
      (pi-deck--display-agent-in-window (pi-deck-agent a) (selected-window))
      (pi-deck-show-beside (pi-deck-agent b))
      (pi-deck-sidebar-toggle)
      (let* ((sidebar (get-buffer-window pi-deck-sidebar-buffer-name))
             (row (with-current-buffer (window-buffer sidebar)
                    (pi-deck-sidebar-refresh)
                    (text-property-any (point-min) (point-max) 'pi-deck-agent (pi-deck-agent b)))))
        (should (eq (lookup-key pi-deck-sidebar-row-map [double-mouse-1])
                    #'pi-deck-sidebar-mouse-only))
        ;; A double click arrives as mouse-1, then double-mouse-1.
        (select-window sidebar)
        (pi-deck-sidebar-mouse-1 (pi-deck-test--click sidebar row))
        (pi-deck-sidebar-mouse-only (pi-deck-test--click sidebar row 'double-mouse-1))
        (should (equal (mapcar (lambda (window) (pilish-session-chat-buffer (window-buffer window)))
                               (pi-deck-test--main-windows))
                       (list b b)))
        (should-not (get-buffer-window a))
        (should (eq (get-buffer-window pi-deck-sidebar-buffer-name) sidebar))
        ;; Zoom brings the other agent back.
        (pi-deck-zoom)
        (should (get-buffer-window a))
        (should (get-buffer-window b))
        ;; Terminals too.
        (let* ((shell (pi-deck-start-shell dir "shell:space" '("/bin/sh" "-c" "read line")))
               (shell-row (progn
                            (pi-deck-refresh)
                            (pi-deck-show-beside (pi-deck-agent shell))
                            (with-current-buffer (window-buffer sidebar)
                              (pi-deck-sidebar-refresh)
                              (text-property-any (point-min) (point-max)
                                                 'pi-deck-agent (pi-deck-agent shell))))))
          (should (get-buffer-window shell))
          (select-window sidebar)
          (pi-deck-sidebar-mouse-1 (pi-deck-test--click sidebar shell-row))
          (pi-deck-sidebar-mouse-only (pi-deck-test--click sidebar shell-row 'double-mouse-1))
          (should (equal (mapcar #'window-buffer (pi-deck-test--main-windows)) (list shell)))
          (should (eq (get-buffer-window pi-deck-sidebar-buffer-name) sidebar))))))))

;; The sidebar lists agents by home space in creation order: showing,
;; revealing or moving them between spaces never reorders it.
(defun pi-deck-test--sidebar-rows (sidebar)
  "Return SIDEBAR's agent rows as (SPACE NAME MARK) in display order.
MARK is `shown' (highlighted: the frame shows it) or nil."
  (with-current-buffer (window-buffer sidebar)
    (pi-deck-sidebar-refresh)
    (let (rows space)
      (goto-char (point-min))
      (while (not (eobp))
        (let ((agent (get-text-property (line-beginning-position) 'pi-deck-agent)))
          (when-let* ((header (get-text-property (line-beginning-position) 'pi-deck-space)))
            (setq space header))
          (when agent
            (let* ((line (buffer-substring (line-beginning-position) (line-end-position)))
                   (name (pi-deck-agent-name agent))
                   (start (string-search name line)))
              (push (list space name
                          (and (memq 'pi-deck-shown-agent
                                     (ensure-list (get-text-property start 'face line)))
                               'shown))
                    rows))))
        (forward-line 1))
      (nreverse rows))))

(ert-deftest pi-deck-test-sidebar-order-is-stable ()
  (pi-deck-test--with-deck
    (let ((two (make-temp-file "pi-deck-two-" t)))
      (pi-deck-create-space dir "space")
      (pi-deck-create-space two "two")
      (pi-deck-select-space "space")
      (let* ((zeta (pi-deck-agent (pi-deck-test--session dir "zeta")))
             (alpha (pi-deck-agent (pi-deck-test--session dir "alpha")))
             (mid (pi-deck-agent (pi-deck-test--session dir "mid")))
             (beta (pi-deck-agent (pi-deck-test--session dir "beta")))
             (order '(("space" "zeta") ("space" "mid") ("space" "alpha") ("space" "beta"))))
        (setf (pi-deck-agent-parent mid) (pi-deck-agent-buffer zeta)
              (pi-deck-agent-target mid) "t-1")
        (should (equal (pi-deck-agents) (list zeta alpha mid beta)))
        (pi-deck-sidebar-toggle)
        (let* ((sidebar (lambda () (get-buffer-window pi-deck-sidebar-buffer-name)))
               (rows (lambda () (mapcar (lambda (row) (take 2 row))
                                        (pi-deck-test--sidebar-rows (funcall sidebar)))))
               (marks (lambda () (mapcar #'cdr (pi-deck-test--sidebar-rows (funcall sidebar))))))
          ;; Creation order, the worker under its parent; not by name.
          (should (equal (funcall rows) order))
          ;; Revealing agents one after another in the same pane keeps it.
          (dolist (agent (list alpha beta zeta))
            (pi-deck-reveal agent)
            (should (equal (funcall rows) order)))
          ;; Only rows of agents the frame shows are highlighted.
          (should (equal (assoc-default "zeta" (funcall marks)) '(shown)))
          (should (equal (assoc-default "beta" (funcall marks)) '(nil)))
          ;; Shown in another space's layout, alpha stays home and in place.
          (pi-deck-select-space "two")
          (pi-deck--display-agent-in-window alpha (pi-deck--pane-window))
          (should (equal (pi-deck-agent-space alpha) "space"))
          (should (equal (funcall rows) order))
          (should (equal (assoc-default "alpha" (funcall marks)) '(shown)))
          (should (equal (assoc-default "zeta" (funcall marks)) '(nil)))
          (should-not (assoc "two" (pi-deck-space-statuses)))
          (pi-deck-select-space "space")
          (should (equal (assoc-default "alpha" (funcall marks)) '(nil)))
          ;; A new agent goes to the bottom.
          (pi-deck-test--session dir "aardvark")
          (should (equal (funcall rows) (append order '(("space" "aardvark"))))))))))

(ert-deftest pi-deck-test-agent-order-survives-restore ()
  (pi-deck-test--with-deck
    (pi-deck-create-space dir "space")
    (dolist (name '("b" "a" "c")) (pi-deck-test--session dir name))
    (let ((state (pi-deck-save-state)))
      (should (equal (mapcar (lambda (record) (plist-get record :name)) (plist-get state :agents))
                     '("b" "a" "c"))))
    (dolist (agent (pi-deck-agents)) (pi-deck-stop-agent agent))
    (should-not (pi-deck-agents))
    (cl-letf (((symbol-function 'pilish-start-session)
               (lambda (&rest _) (ert-fail "Desktop restoration started Pi"))))
      (pi-deck-restore-state))
    (pi-deck-test--session dir "0")
    (should (equal (mapcar #'pi-deck-agent-name (pi-deck-agents)) '("b" "a" "c" "0")))))

(ert-deftest pi-deck-test-clicking-current-space-shows-its-directory ()
  (pi-deck-test--with-large-frame
   (pi-deck-test--with-deck
    (let ((two (make-temp-file "pi-deck-two-" t)))
      (pi-deck-create-space two "two")
      (pi-deck-create-space dir "space")
      (let ((chat (pi-deck-test--session dir "a")))
        (pi-deck--display-agent-in-window (pi-deck-agent chat) (pi-deck--pane-window))
        (pi-deck-sidebar-toggle)
        (let* ((sidebar (get-buffer-window pi-deck-sidebar-buffer-name))
               (name (lambda (space)
                       (with-current-buffer (window-buffer sidebar)
                         (pi-deck-sidebar-refresh)
                         (pi-deck-test--space-name-position space)))))
          (select-window sidebar)
          ;; Folded, the first click only unfolds.
          (with-current-buffer (window-buffer sidebar)
            (push "space" pi-deck-sidebar--collapsed))
          (pi-deck-sidebar-mouse-1 (pi-deck-test--click sidebar (funcall name "space")))
          (should-not (member "space" (buffer-local-value 'pi-deck-sidebar--collapsed
                                                          (window-buffer sidebar))))
          (should (get-buffer-window chat))
          (should-not (pi-deck-test--in-dired-p))
          ;; The directory opens beside the chat and gets the focus.
          (pi-deck-sidebar-mouse-1 (pi-deck-test--click sidebar (funcall name "space")))
          (should (get-buffer-window chat))
          (should (pi-deck-test--in-dired-p))
          (should (equal default-directory (file-name-as-directory dir)))
          ;; Again, it is only selected.
          (let ((count (length (pi-deck-test--main-windows)))
                (dired (selected-window)))
            (select-window (get-buffer-window chat))
            (pi-deck-sidebar-mouse-1 (pi-deck-test--click sidebar (funcall name "space")))
            (should (= (length (pi-deck-test--main-windows)) count))
            (should (eq (selected-window) dired)))
          ;; Another space's name still just switches.
          (pi-deck-sidebar-mouse-1 (pi-deck-test--click sidebar (funcall name "two")))
          (should (equal (pi-deck-current-space) "two"))
          (should (= (length (pi-deck-test--main-windows)) 1))))
      (delete-directory two t)))))

(ert-deftest pi-deck-test-sidebar-is-a-space-tree ()
  (pi-deck-test--with-deck
    (let ((two (make-temp-file "pi-deck-two-" t)))
      (pi-deck-create-space two "two")
      (pi-deck-create-space dir "space")
      (let* ((chat (pi-deck-test--session dir "a"))
             (panel (pi-deck-test--session dir "p"))
             popped stopped)
        (setf (pi-deck-agent-parent (pi-deck-agent panel)) chat)
        (pi-deck-sidebar-toggle)
        (let* ((sidebar (get-buffer-window pi-deck-sidebar-buffer-name))
               (at (lambda (property value)
                     (with-current-buffer (window-buffer sidebar)
                       (pi-deck-test--position property value))))
               (button (lambda (row action)
                         (with-current-buffer (window-buffer sidebar)
                           (text-property-any row (save-excursion (goto-char row) (line-end-position)) 'pi-deck-button action)))))
          (with-current-buffer (window-buffer sidebar)
            (pi-deck-sidebar-refresh)
            (let ((text (buffer-substring-no-properties (point-min) (point-max))))
              (should (string-match-p "\\`▾ two (0) ○ \\+\n" text))
              (should (string-match-p "^▾ space (2) ○ \\+\n ○ a ✕\n   ○ p ✕\n" text))
              (should (string-suffix-p "\n+ New space  + New Group\n" text))))
          ;; The current space's name is highlighted.
          (should (eq (get-text-property (with-current-buffer (window-buffer sidebar)
                                           (pi-deck-test--space-name-position "space")) 'face
                                         (window-buffer sidebar))
                      'pi-deck-current-space))
          (cl-letf (((symbol-function 'pi-deck-popup) (lambda (menu &rest _) (setq popped menu)))
                    ((symbol-function 'pi-deck-close-agent) (lambda (agent) (setq stopped agent))))
            ;; ✕ closes its row's agent, + opens its space's menu.
            (pi-deck-sidebar-mouse-1
             (pi-deck-test--click sidebar (funcall button (funcall at 'pi-deck-agent (pi-deck-agent panel)) 'close)))
            (should (eq stopped (pi-deck-agent panel)))
            (pi-deck-sidebar-mouse-1
             (pi-deck-test--click sidebar (funcall button (funcall at 'pi-deck-space "two") 'space-menu)))
            (should (keymapp popped))
            ;; The count folds and says so on hover; the name visits the
            ;; space and unfolds it.
            (let ((count (with-current-buffer (window-buffer sidebar)
                           (save-excursion
                             (goto-char (funcall at 'pi-deck-space "space"))
                             (search-forward "(")
                             (1- (point))))))
              (should (equal (get-text-property count 'help-echo (window-buffer sidebar))
                             "mouse-1: fold or unfold"))
              (pi-deck-sidebar-mouse-1 (pi-deck-test--click sidebar count)))
            (should (member "space" (buffer-local-value 'pi-deck-sidebar--collapsed (window-buffer sidebar))))
            (pi-deck-sidebar-mouse-1
             (pi-deck-test--click sidebar (with-current-buffer (window-buffer sidebar)
                                           (pi-deck-test--space-name-position "two"))))
            (should (equal (pi-deck-current-space) "two"))
            (let ((sidebar (get-buffer-window pi-deck-sidebar-buffer-name)))
              (pi-deck-sidebar-mouse-1
               (pi-deck-test--click sidebar (with-current-buffer (window-buffer sidebar)
                                              (pi-deck-test--space-name-position "space"))))
              (should (equal (pi-deck-current-space) "space"))
              (should-not (member "space" (buffer-local-value 'pi-deck-sidebar--collapsed
                                                              (get-buffer pi-deck-sidebar-buffer-name)))))))
        (delete-directory two t)))))

(ert-deftest pi-deck-test-sidebar-rows-are-clickable ()
  (pi-deck-test--with-deck
    (pi-deck-create-space dir "space")
    (let ((chat (pi-deck-test--session dir "a")) jumped popped)
      (pi-deck-sidebar-toggle)
      (let* ((sidebar (get-buffer-window pi-deck-sidebar-buffer-name))
             (row (with-current-buffer (window-buffer sidebar)
                    (pi-deck-sidebar-refresh)
                    (text-property-any (point-min) (point-max) 'pi-deck-agent (pi-deck-agent chat)))))
        (with-current-buffer (window-buffer sidebar)
          (should (eq (get-text-property row 'mouse-face) 'highlight))
          (should (eq (keymap-lookup (get-text-property row 'keymap) "<mouse-1>")
                      #'pi-deck-sidebar-mouse-1)))
        (cl-letf (((symbol-function 'pi-deck-jump) (lambda (agent) (setq jumped agent)))
                  ((symbol-function 'pi-deck-popup) (lambda (menu &rest _) (setq popped menu))))
          (pi-deck-sidebar-mouse-1 (pi-deck-test--click sidebar row))
          (should (eq jumped (pi-deck-agent chat)))
          ;; mouse-3 opens the row's menu.
          (pi-deck-sidebar-mouse-3 (pi-deck-test--click sidebar row 'mouse-3))
          (should (equal (keymap-prompt popped) "a")))))))

(ert-deftest pi-deck-test-sidebar-default-and-saved-toggle ()
  (pi-deck-test--with-deck
    (setq pi-deck-sidebar t)
    (pi-deck-create-space dir "space")
    (should (get-buffer-window pi-deck-sidebar-buffer-name))
    (pi-deck-create-space (make-temp-file "pi-deck-two-" t) "two")
    (should (get-buffer-window pi-deck-sidebar-buffer-name))
    (pi-deck-sidebar-toggle)
    (should-not (get-buffer-window pi-deck-sidebar-buffer-name))
    (pi-deck-switch-space "space")
    (should-not (get-buffer-window pi-deck-sidebar-buffer-name))
    (setq pi-deck-sidebar t)
    (pi-deck-load-preferences)
    (should-not pi-deck-sidebar)))

(ert-deftest pi-deck-test-goto-candidates-group-by-space ()
  (pi-deck-test--with-deck
    (pi-deck-create-space dir "space")
    (let ((chat (pi-deck-test--session dir "a"))
          (other (pi-deck-test--session "/tmp/" "b")))
      (pi-deck-test--phase other "thinking")
      (let ((candidates (pi-deck-goto-candidates)))
        (should (= (length candidates) 2))
        (should (equal (get-text-property 0 'pi-deck-space (car (car candidates))) "space"))
        (should (eq (cdr (car candidates)) (pi-deck-agent chat)))
        (should (equal (get-text-property 0 'pi-deck-space (car (cadr candidates))) "other")))
      (should (equal (mapcar #'cdr (pi-deck-goto-candidates 'working))
                     (list (pi-deck-agent other))))
      (cl-letf (((symbol-function 'completing-read)
                 (lambda (_prompt table &rest _)
                   (should (eq (alist-get 'group-function (cdr (funcall table "" nil 'metadata)))
                               (alist-get 'group-function (cdr (funcall table "" nil 'metadata)))))
                   (car (car (pi-deck-goto-candidates 'working))))))
        (should (eq (pi-deck-read-agent "Agent: ") (pi-deck-agent other)))))))

(ert-deftest pi-deck-test-next-attention-prefers-blocked ()
  (pi-deck-test--with-deck
    (pi-deck-create-space dir "space")
    (let ((done (pi-deck-test--session dir "done"))
          (blocked (pi-deck-test--session dir "blocked"))
          (pilish-extension-dialog-style 'inline)
          (pi-deck-answer-on-jump nil))
      (pi-deck-test--phase done "thinking")
      (pi-deck-test--phase done "idle")
      (cl-letf (((symbol-function 'message) #'ignore))
        (with-current-buffer blocked
          (pilish--handle-extension-ui-request
           '(:type "extension_ui_request" :id "q" :method "input" :title "Name"))))
      (pi-deck-next-attention)
      (should (eq (pilish-session-chat-buffer (window-buffer)) blocked))
      (pi-deck-next-attention)
      (should (eq (pilish-session-chat-buffer (window-buffer)) done))
      (should (eq (pi-deck-agent-status (pi-deck-agent done)) 'idle)))))

(ert-deftest pi-deck-test-layout-grid ()
  (pi-deck-test--with-deck
    (pi-deck-create-space dir "space")
    (let ((agents (mapcar (lambda (name) (pi-deck-test--session dir name)) '("a" "b" "c"))))
      (pi-deck-layout-grid)
      ;; Each agent's cell is its chat over its input.
      (should (= (length (window-list nil 'no-minibuf)) 6))
      (should (cl-every (lambda (chat)
                          (equal (pilish-window-pair (get-buffer-window chat))
                                 (cons (get-buffer-window chat)
                                       (get-buffer-window (pilish-session-input-buffer chat)))))
                        agents)))
    (pi-deck-create-space (make-temp-file "pi-deck-empty-" t) "empty")
    (should-error (pi-deck-layout-grid) :type 'user-error)))

;;;; Title bars and menus

(ert-deftest pi-deck-test-pane-title-bars ()
  (let ((pilish-header-line-location 'input))
   (pi-deck-test--with-deck
    (pi-deck-create-space dir "space")
    (let* ((chat (pi-deck-test--session dir "main"))
           (original-header (buffer-local-value 'header-line-format chat)))
      (pi-deck--run-update)
      (with-current-buffer chat
        (should (equal (car header-line-format) pi-deck--header-construct))
        (setq pilish--cached-stats '(:contextUsage (:percent 41.4 :tokens 10)))
        (let ((header (pi-deck-pane-header)))
          (should (string-match-p "\\` ○ main · faux-model · 41%% .*\\[⤢\\] \\[✕\\] \\( │ \\)?\\'"
                                  (substring-no-properties header)))
          ;; Details are dim, including the escaped `%'.
          (let ((detail (string-search "faux-model" header)))
            (should (eq (get-text-property detail 'face header) 'pi-deck-header-dim))
            (dolist (index (list (string-search "%%" header) (1+ (string-search "%%" header))))
              (should (eq (get-text-property index 'face header) 'pi-deck-header-dim))))
          (let ((zoom (string-search "[⤢]" header))
                (close (string-search "[✕]" header)))
            (should (eq (keymap-lookup (get-text-property zoom 'local-map header)
                                       "<header-line> <mouse-1>")
                        #'pi-deck-header-zoom))
            (should (eq (keymap-lookup (get-text-property close 'local-map header)
                                       "<header-line> <mouse-1>")
                        #'pi-deck-header-close)))))
      ;; [⑂] forks through /fork-here without touching the draft; a
      ;; prefix function puts e.g. the window number first.
      (with-current-buffer chat
        (let* ((pi-deck-pane-header-prefix-function (lambda () "7"))
               (header (pi-deck-pane-header))
               (fork (string-search "[⑂]" header))
               submitted)
          (should (string-prefix-p "7 " (substring-no-properties header)))
          (should (eq (keymap-lookup (get-text-property fork 'local-map header)
                                     "<header-line> <mouse-1>")
                      #'pi-deck-header-fork))
          (cl-letf (((symbol-function 'pilish-submit-prompt)
                     (lambda (buffer text _callback &optional _behavior)
                       (push (list buffer text) submitted))))
            (pi-deck-fork-agent (pi-deck-agent chat))
            (should (member "Fork" (pi-deck-test--menu-labels (pi-deck-agent-menu (pi-deck-agent chat))))))
          (should (equal submitted (list (list chat "/fork-here"))))
          ;; [J] toggles automatic positioning on completion and focus,
          ;; for this session only.
          (let ((toggle (string-search "[J]" header)))
            (should (string-prefix-p "Automatic jump on completion and focus: off"
                                     (get-text-property toggle 'help-echo header)))
            (should (eq (keymap-lookup (get-text-property toggle 'local-map header)
                                       "<header-line> <mouse-1>")
                        #'pi-deck-header-jump-to-answer))
            (should (memq 'pi-deck-header-dim (ensure-list (get-text-property toggle 'face header))))
            (switch-to-buffer chat)
            (unwind-protect
                (progn
                  (pi-deck-header-jump-to-answer (pi-deck-test--click (selected-window) 1))
                  (should (local-variable-p 'pilish-jump-to-answer))
                  (should pilish-jump-to-answer)
                  (should-not (default-value 'pilish-jump-to-answer))
                  (let ((header (pi-deck-pane-header)))
                    (let ((toggle (string-search "[J]" header)))
                      (should (eq (get-text-property toggle 'face header) 'header-line-highlight))
                      (should (string-prefix-p "Automatic jump on completion and focus: on"
                                               (get-text-property toggle 'help-echo header))))))
              (kill-local-variable 'pilish-jump-to-answer)))
          ;; [↓] puts point at the end, so Pilish follows output again.
          (let ((latest (string-search "[↓]" header)))
            (should (eq (keymap-lookup (get-text-property latest 'local-map header)
                                       "<header-line> <mouse-1>")
                        #'pi-deck-header-latest))
            (switch-to-buffer chat)
            (let ((inhibit-read-only t)) (insert (make-string 50 ?\n) "end"))
            (goto-char (point-min))
            (pi-deck-header-latest (pi-deck-test--click (selected-window) 1))
            (should (= (window-point) (point-max))))
          (should (eq (keymap-lookup pi-deck-command-map "f") #'pi-deck-fork))))
      ;; A long name is truncated, never the buttons.
      (let ((long (pi-deck-test--session dir (make-string 80 ?x))))
        (switch-to-buffer long)
        (pi-deck--run-update)
        (let ((header (substring-no-properties (pi-deck-pane-header))))
          (should (string-match-p "x… *\\[J\\] \\[↓\\] \\[⑂\\] \\[⤢\\] \\[✕\\] \\( │ \\)?\\'" header))
          (should (<= (string-width (car (split-string header "\\[⤢\\]")))
                      (window-total-width)))))
      ;; Disabling the mode restores the header line.
      (pi-deck-mode -1)
      (should (equal (buffer-local-value 'header-line-format chat) original-header))
      (pi-deck-mode 1)))))

(defun pi-deck-test--menu-labels (menu)
  "Return the item labels of MENU, \"--\" for separators."
  (let (labels)
    (map-keymap (lambda (_key binding)
                  (when (eq (car-safe binding) 'menu-item)
                    (push (nth 1 binding) labels)))
                menu)
    (nreverse labels)))

(defun pi-deck-test--menu-item (menu label)
  "Return the menu-item binding of MENU labelled LABEL."
  (catch 'found
    (map-keymap (lambda (_key binding)
                  (when (and (eq (car-safe binding) 'menu-item) (equal (nth 1 binding) label))
                    (throw 'found binding)))
                menu)
    (ert-fail (format "No menu item %s" label))))

(defun pi-deck-test--menu-command (menu label)
  "Return the command of MENU's item LABEL."
  (nth 2 (pi-deck-test--menu-item menu label)))

(ert-deftest pi-deck-test-space-menu-acts-in-its-space ()
  (pi-deck-test--with-deck
    (let ((two (make-temp-file "pi-deck-two-" t)))
      (pi-deck-create-space two "two")
      (pi-deck-create-space dir "space")
      (funcall (pi-deck-test--menu-command (pi-deck-space-menu "two") "New shell"))
      (should (equal (pi-deck-current-space) "two"))
      (should (= (length (tab-bar-tabs)) 2))
      (let ((shell (pi-deck-agent (window-buffer))))
        (should (eq (pi-deck-agent-kind shell) 'shell))
        (should (equal (pi-deck-agent-assigned-space shell) "two")))
      (delete-directory two t))))

(ert-deftest pi-deck-test-context-menus ()
  (pi-deck-test--with-deck
    (pi-deck-create-space dir "space")
    (let ((chat (pi-deck-test--session dir "a")))
      (should (equal (pi-deck-test--menu-labels (pi-deck-agent-menu (pi-deck-agent chat)))
                     '("Jump" "Show beside" "Show alone" "Rename…" "--" "Fork" "Compact"
                       "Copy session file" "--" "Close")))
      ;; Recovery actions appear once the view is disconnected.
      (with-current-buffer chat
        (setq pi-deck-test--runtime '(:protocol 2 :mux-id "offline" :state "disconnected")))
      (cl-letf (((symbol-function 'pilish-session-process) #'ignore))
        (should (equal (seq-take (pi-deck-test--menu-labels (pi-deck-agent-menu (pi-deck-agent chat))) 6)
                       '("Jump" "Show beside" "Show alone" "Rename…"
                         "Reconnect existing runtime (no restart)" "Resume stopped view explicitly"))))
      (cl-letf (((symbol-function 'message) #'ignore))
        (with-current-buffer chat
          (pilish--handle-extension-ui-request
           '(:type "extension_ui_request" :id "q" :method "input" :title "Name"))))
      (should (member "Answer question"
                      (pi-deck-test--menu-labels (pi-deck-agent-menu (pi-deck-agent chat)))))
      (should (equal (pi-deck-test--menu-labels (pi-deck-space-menu "space"))
                     '("New agent" "New shell" "Reopen agent" "--" "Rename…"
                       "Close" "--" "Clear finished workers and shells immediately")))
      (should (equal (pi-deck-test--menu-labels
                      (pi-deck-finished-worker-menu '(:name "do-1" :session-file "/tmp/x")))
                     '("Open transcript" "Resume")))
      ;; Renaming a terminal renames its buffer.
      (let ((shell (pi-deck-new-shell)))
        (pi-deck-rename-agent shell "logs")
        (should (equal (pi-deck-agent-name shell) "logs"))))))

(provide 'pi-deck-ui-test)
;;; pi-deck-ui-test.el ends here
