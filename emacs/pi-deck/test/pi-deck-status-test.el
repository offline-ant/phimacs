;;; pi-deck-status-test.el --- Status model tests -*- lexical-binding: t; -*-

;; SPDX-License-Identifier: MIT

;;; Commentary:

;; Status rollup, notifications, dialogs and shell prompt marks.
;; Fixtures: pi-deck-test-fixtures.el.

;;; Code:

(require 'pi-deck-test-fixtures)

;;;; Status model

(ert-deftest pi-deck-test-priority-rollup-and-summary ()
  (should (eq (pi-deck-rollup '(idle done working)) 'done))
  (should (eq (pi-deck-rollup '(idle working blocked)) 'blocked))
  (should (eq (pi-deck-rollup '(unknown idle)) 'idle))
  (should (eq (pi-deck-rollup '(waiting idle)) 'waiting))
  (should (eq (pi-deck-rollup '(waiting working)) 'working))
  (should-not (pi-deck-rollup nil))
  (should (equal (mapcar #'pi-deck-status-priority pi-deck-statuses) '(5 4 3 2 1 0))))

(defun pi-deck-test--orchestration-waiting (chat waiting)
  "Set or clear CHAT's orchestration waiting status as Pi's RPC does."
  (with-current-buffer chat
    (pilish--extension-ui-set-status
     (list :statusKey "orchestration-waiting" :statusText (and waiting "waiting")))))

(ert-deftest pi-deck-test-waiting-on-orchestration-is-not-working ()
  "A busy agent whose tools only wait on orchestration work is waiting."
  (pi-deck-test--with-deck
    (let* ((chat (pi-deck-test--session dir "a"))
           (agent (pi-deck-agent chat))
           (pilish-extension-status-functions (list #'pi-deck--on-extension-status)))
      (pi-deck-test--phase chat "running")
      (should (eq (pi-deck-agent-status agent) 'working))
      (pi-deck-test--orchestration-waiting chat t)
      (should (eq (pi-deck-agent-status agent) 'waiting))
      (should (equal (pi-deck-summary) '((waiting . 1))))
      (with-current-buffer (pi-deck-sidebar-buffer)
        (pi-deck-sidebar-refresh)
        (should (string-match-p "◌ a" (buffer-string))))
      (pi-deck-test--orchestration-waiting chat nil)
      (should (eq (pi-deck-agent-status agent) 'working))
      (pi-deck-test--orchestration-waiting chat t)
      ;; Finishing from waiting while invisible is done, like finishing work.
      (pi-deck-test--orchestration-waiting chat nil)
      (pi-deck-test--orchestration-waiting chat t)
      (pi-deck-test--phase chat "idle")
      (should (eq (pi-deck-agent-status agent) 'done))
      ;; An idle agent is idle, whatever a stale status says.
      (should (eq (pi-deck-agent-state agent) 'idle)))))

(ert-deftest pi-deck-test-working-done-seen-and-notifications ()
  (pi-deck-test--with-deck
    (let* ((chat (pi-deck-test--session dir "a"))
           (agent (pi-deck-agent chat)))
      (should (eq (pi-deck-agent-status agent) 'idle))
      (pi-deck-test--phase chat "thinking")
      (should (eq (pi-deck-agent-status agent) 'working))
      (pi-deck-test--phase chat "idle")
      ;; Finished while invisible: done until shown.
      (should (eq (pi-deck-agent-status agent) 'done))
      (should (string-match-p "a finished" (car (car pi-deck-test--notifications))))
      ;; `pi-deck-notify-functions' see the same transitions, with the kind,
      ;; also when the notification itself is off.
      (let* ((events nil)
             (pi-deck-notify-functions
              (list (lambda (&rest args) (push args events))))
             (pi-deck-notify-method nil))
        (setq pi-deck-test--notifications nil)
        (pi-deck-test--phase chat "thinking")
        (pi-deck-test--phase chat "idle")
        (should-not pi-deck-test--notifications)
        (should (equal (mapcar (lambda (event) (seq-take event 2)) events)
                       '((finished "a finished"))))
        (should (eq (nth 3 (car events)) agent)))
      (switch-to-buffer chat)
      (pi-deck-mark-visible-seen)
      (should (eq (pi-deck-agent-status agent) 'idle))
      ;; Finishing while visible is seen at once and does not notify.
      (setq pi-deck-test--notifications nil)
      (pi-deck-test--phase chat "running")
      (pi-deck-test--phase chat "idle")
      (should (eq (pi-deck-agent-status agent) 'idle))
      (should-not pi-deck-test--notifications)
      ;; Sending before any event counts as work.
      (with-current-buffer chat (setq pilish--status 'sending))
      (pi-deck-refresh)
      (should (eq (pi-deck-agent-state agent) 'working)))))

(ert-deftest pi-deck-test-blocked-from-pending-dialogs ()
  (pi-deck-test--with-deck
    (let* ((pilish-extension-dialog-style 'inline)
           (chat (pi-deck-test--session dir "b"))
           (agent (pi-deck-agent chat))
           (process (pilish-session-process chat))
           responses)
      (cl-letf (((symbol-function 'pilish--send-extension-ui-response)
                 (lambda (_ response) (push response responses)))
                ((symbol-function 'message) #'ignore))
        (pi-deck-test--phase chat "running")
        (with-current-buffer chat
          (pilish--handle-extension-ui-request
           '(:type "extension_ui_request" :id "q1" :method "confirm"
             :title "Delete it?" :message "")))
        (should (eq (pi-deck-agent-status agent) 'blocked))
        (should (equal (pi-deck-agent-detail agent) "asks: Delete it?"))
        (should (string-match-p "b needs attention" (car (car pi-deck-test--notifications))))
        ;; Jumping puts point on the inline question; answering is a key press.
        (pi-deck-jump agent)
        (should (eq (window-buffer) chat))
        (should (get-text-property (point) 'pilish-dialog-choice))
        (call-interactively (key-binding (kbd "y")))
        (should (eq (plist-get (car responses) :confirmed) t))
        (should (eq (pi-deck-agent-state agent) 'working))
        (pi-deck-test--phase chat "idle")
        (delete-process process)
        (pi-deck-refresh)
        (should (eq (pi-deck-agent-state agent) 'unknown))))))

(ert-deftest pi-deck-test-shell-prompt-marks-and-exit ()
  (pi-deck-test--with-deck
    (let* ((buffer (pi-deck-start-shell
                    dir "shell:test"
                    '("/bin/sh" "-c" "printf '\\033]133;A\\007$ '; read a; printf '\\033]133;C\\007'; read b")))
           (agent (progn (pi-deck-refresh) (pi-deck-agent buffer))))
      (should (eq (pi-deck-agent-kind agent) 'shell))
      (should (equal (buffer-local-value 'pi-deck--shell-command buffer)
                     '("/bin/sh" "-c" "printf '\\033]133;A\\007$ '; read a; printf '\\033]133;C\\007'; read b")))
      (should (pi-deck-test--wait (lambda () (eq (pi-deck-agent-state agent) 'idle))))
      (with-current-buffer buffer (ghostel-send-string "go\n"))
      (should (pi-deck-test--wait (lambda () (eq (pi-deck-agent-state agent) 'working))))
      (with-current-buffer buffer (ghostel-send-string "end\n"))
      (should (pi-deck-test--wait (lambda () (pi-deck-refresh)
                                    (not (process-live-p (get-buffer-process buffer))))))
      (pi-deck-refresh)
      (should (eq (pi-deck-agent-state agent) 'idle))
      (should (string-match-p "exited 0" (pi-deck-agent-detail agent))))))

(provide 'pi-deck-status-test)
;;; pi-deck-status-test.el ends here
