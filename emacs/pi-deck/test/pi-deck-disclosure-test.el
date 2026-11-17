;;; pi-deck-disclosure-test.el --- Sidebar disclosure and worker names -*- lexical-binding: t; -*-

;; SPDX-License-Identifier: MIT

;;; Commentary:

;; Exercise disclosure arrows and live/finished worker names through the real
;; sidebar and isolated fake Pilish/real Ghostel fixtures.  No Pi calls.

;;; Code:

(require 'pi-deck-test-fixtures)

(ert-deftest pi-deck-test-space-arrow-folds-all-children-without-navigation ()
  (pi-deck-test--with-large-frame
   (pi-deck-test--with-deck
    (pi-deck-create-space dir "space")
    (let* ((parent (pi-deck-test--session dir "root"))
           (worker (pi-deck-test--session dir "worker"))
           (panel (pi-deck-start-shell dir "shell:panel" '("/bin/sh" "-c" "read line")))
           (ended (pi-deck-start-shell dir "shell:ended" '("/bin/sh" "-c" "true")))
           (record (pi-deck-test--finished-worker dir parent "closed")))
      (pi-deck-refresh)
      (should (pi-deck-test--wait
               (lambda () (pi-deck-refresh)
                 (pi-deck-agent-finished-shell-p (pi-deck-agent ended)))))
      (setf (pi-deck-agent-parent (pi-deck-agent worker)) parent
            (pi-deck-agent-target (pi-deck-agent worker)) "worker-target"
            (pi-deck-agent-parent (pi-deck-agent panel)) worker
            (pi-deck-agent-target (pi-deck-agent panel)) "panel-target")
      (pi-deck-test--phase worker "thinking")
      (pi-deck--display-agent-in-window (pi-deck-agent parent) (selected-window))
      (pi-deck-sidebar-toggle)
      (let* ((sidebar (get-buffer-window pi-deck-sidebar-buffer-name))
             (buffer (window-buffer sidebar))
             (selected (selected-window))
             (panes (mapcar #'window-buffer (pi-deck-test--main-windows)))
             (agents (mapcar #'pi-deck-agent (list parent worker panel ended))))
        (with-current-buffer buffer
          (setq pi-deck-sidebar--expanded-workers (list parent)
                pi-deck-sidebar--expanded-shells '("space"))
          (pi-deck-sidebar-refresh))
        (cl-labels
            ((arrow () (with-current-buffer buffer
                         (pi-deck-test--position 'pi-deck-space "space")))
             (header () (with-current-buffer buffer
                          (save-excursion
                            (goto-char (arrow))
                            (buffer-substring-no-properties (point) (line-end-position)))))
             (children-visible-p ()
               (with-current-buffer buffer
                 (and (cl-every
                       (lambda (agent) (text-property-any (point-min) (point-max) 'pi-deck-agent agent))
                       agents)
                      (text-property-any (point-min) (point-max) 'pi-deck-finished parent)
                      (text-property-any (point-min) (point-max) 'pi-deck-worker-record record)
                      (text-property-not-all (point-min) (point-max) 'pi-deck-finished-shells nil)))))
          (should (equal (header) "▾ space (4) ◐ +"))
          (should (children-visible-p))
          (should (eq (get-text-property (arrow) 'pi-deck-button buffer) 'fold))
          (should (eq (keymap-lookup (get-text-property (arrow) 'keymap buffer) "<mouse-1>")
                      #'pi-deck-sidebar-mouse-1))
          (pi-deck-sidebar-mouse-1 (pi-deck-test--click sidebar (arrow)))
          (should (equal (header) "▸ space (4) ◐ +"))
          (should (eq (selected-window) selected))
          (should (equal (pi-deck-current-space) "space"))
          (should (equal (mapcar #'window-buffer (pi-deck-test--main-windows)) panes))
          (with-current-buffer buffer
            (should (member "space" pi-deck-sidebar--collapsed))
            (dolist (property '(pi-deck-agent pi-deck-finished pi-deck-worker-record pi-deck-finished-shells))
              (should-not (text-property-not-all (point-min) (point-max) property nil)))
            ;; Count, rolled-up status and the menu remain clickable/visible.
            (should (text-property-any (point-min) (point-max) 'pi-deck-button 'space-menu))
            (pi-deck-sidebar-refresh))
          (should (equal (header) "▸ space (4) ◐ +"))
          (pi-deck-sidebar-mouse-1 (pi-deck-test--click sidebar (arrow)))
          (should (eq (selected-window) selected))
          (should (equal (header) "▾ space (4) ◐ +"))
          ;; Child expansion choices survive the enclosing space's fold.
          (should (children-visible-p))
          ;; Count clicks and TAB still use the same fold state as the arrow.
          (let ((count (with-current-buffer buffer
                         (save-excursion (goto-char (arrow)) (search-forward "(") (1- (point))))))
            (should (eq (get-text-property count 'pi-deck-button buffer) 'fold))
            (pi-deck-sidebar-mouse-1 (pi-deck-test--click sidebar count)))
          (should (equal (header) "▸ space (4) ◐ +"))
          (with-current-buffer buffer
            (goto-char (arrow))
            (call-interactively (keymap-lookup pi-deck-sidebar-mode-map "TAB")))
          (should (equal (header) "▾ space (4) ◐ +"))
          (should (children-visible-p))))))))

(ert-deftest pi-deck-test-space-arrows-include-empty-and-unassigned-groups ()
  (pi-deck-test--with-deck
    (let ((project (expand-file-name "project" dir)))
      (make-directory project)
      (pi-deck-create-space project "empty")
      (let ((loose (pi-deck-test--session dir "loose")))
        (should-not (pi-deck-agent-space (pi-deck-agent loose)))
        (pi-deck-sidebar-toggle)
        (let* ((sidebar (get-buffer-window pi-deck-sidebar-buffer-name))
               (buffer (window-buffer sidebar))
               (selected (selected-window)))
          (dolist (space '("empty" "other"))
            (let ((row (with-current-buffer buffer
                         (pi-deck-sidebar-refresh)
                         (pi-deck-test--position 'pi-deck-space space))))
              (should (= (with-current-buffer buffer (char-after row)) ?▾))
              (pi-deck-sidebar-mouse-1 (pi-deck-test--click sidebar row))
              (should (eq (selected-window) selected))
              (should (equal (pi-deck-current-space) "empty"))
              (with-current-buffer buffer
                (should (member space pi-deck-sidebar--collapsed))
                (goto-char (pi-deck-test--position 'pi-deck-space space))
                (should (looking-at (concat "▸ " space " (" (if (equal space "empty") "0" "1") ") ○")))
                (when (equal space "other")
                  (should-not (text-property-any (point-min) (point-max) 'pi-deck-agent (pi-deck-agent loose)))))
              (pi-deck-sidebar-mouse-1 (pi-deck-test--click sidebar row))))
          (with-current-buffer buffer
            (should-not pi-deck-sidebar--collapsed)
            (should (text-property-any (point-min) (point-max) 'pi-deck-agent (pi-deck-agent loose)))))))))

(ert-deftest pi-deck-test-sidebar-worker-titles-survive-completion ()
  "Conversation titles label workers, without renaming untitled root agents."
  (pi-deck-test--with-deck
    (pi-deck-create-space dir "space")
    (let* ((root (pi-deck-test--session dir "1"))
           (handle "do-generated-worker-id")
           (worker (pi-deck-test--session dir handle))
           (root-agent (pi-deck-agent root))
           (worker-agent (pi-deck-agent worker))
           (file (pilish-session-file worker)))
      (with-temp-file file
        (insert "{\"type\":\"session\",\"version\":3,\"id\":\"worker\",\"cwd\":\"/tmp\"}\n"))
      (setf (pi-deck-agent-parent worker-agent) root
            (pi-deck-agent-target worker-agent) "worker-target")
      (pi-deck-sidebar-toggle)
      (let ((sidebar (get-buffer pi-deck-sidebar-buffer-name)))
        (cl-labels
            ((row (property value)
               (with-current-buffer sidebar
                 (save-excursion
                   (goto-char (pi-deck-test--position property value))
                   (buffer-substring-no-properties (line-beginning-position) (line-end-position))))))
          ;; Use the public name setter; only the fake transport's acknowledgement
          ;; is stubbed.  Both the generated task title and a human rename render.
          (cl-letf (((symbol-function 'pilish--rpc-async)
                     (lambda (process command callback)
                       (should (eq process (pilish-session-process worker)))
                       (should (equal (plist-get command :type) "set_session_name"))
                       (funcall callback '(:success t)))))
            (dolist (title '("Review sidebar" "Sidebar audit"))
              (with-current-buffer worker (pilish-set-session-name title nil))
              (should (equal (pilish-session-title worker) title))
              (should (equal (pilish-session-name worker) handle))
              (should (equal (pi-deck-agent-name worker-agent) title))
              (with-current-buffer sidebar (pi-deck-sidebar-refresh))
              (should (equal (row 'pi-deck-agent worker-agent) (concat "   ○ " title " ✕")))
              (should-not (pilish-session-title root))
              (should (equal (pi-deck-agent-name root-agent) "1"))
              (should (equal (row 'pi-deck-agent root-agent) " ○ 1 ✕"))))
          ;; The real close hook remembers the last display title, not the handle.
          (let ((pilish-quit-without-confirmation t))
            (delete-process (pilish-session-process worker))
            (kill-buffer (pilish-session-input-buffer worker))
            (kill-buffer worker))
          (should-not (buffer-live-p worker))
          (let ((record (car (pi-deck-finished-workers root))))
            (should (equal (plist-get record :name) "Sidebar audit"))
            (should (equal (plist-get record :session-file) file))
            (with-current-buffer sidebar
              (setq pi-deck-sidebar--expanded-workers (list root))
              (pi-deck-sidebar-refresh))
            (should (string-match-p "\\`     ✓ Sidebar audit  " (row 'pi-deck-worker-record record)))
            (should (equal (row 'pi-deck-agent root-agent) " ○ 1 ✕"))))))))

(provide 'pi-deck-disclosure-test)
;;; pi-deck-disclosure-test.el ends here
