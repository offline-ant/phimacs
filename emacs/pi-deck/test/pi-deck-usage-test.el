;;; pi-deck-usage-test.el --- Sidebar usage section -*- lexical-binding: t; -*-
;; SPDX-License-Identifier: MIT

;; Parsing, merging and rendering of `pi-deck-usage-command' output, folding
;; in the sidebar and the asynchronous fetch through real `sh' processes.

(require 'ert)
(require 'pi-deck)

(defconst pi-deck-usage-test--now 1795100000
  "Fixed time the fixture's reset times are relative to.")

(defun pi-deck-usage-test--json (&optional now)
  "Usage output of three accounts with data and one without, fetched at NOW.
NOW defaults to `pi-deck-usage-test--now'."
  (setq now (or now pi-deck-usage-test--now))
  (format "{\"fetchedAt\": %d, \"accounts\": [
 {\"label\": \"claude original\", \"windows\": [
   {\"name\": \"5h\", \"usedPercent\": 63, \"resetsAt\": %d},
   {\"name\": \"wk\", \"usedPercent\": 55.4, \"resetsAt\": %d}]},
 {\"label\": \"claude second\", \"windows\": [
   {\"name\": \"5h\", \"usedPercent\": 104, \"resetsAt\": %d},
   {\"name\": \"wk\", \"usedPercent\": 80, \"resetsAt\": null}]},
 {\"label\": \"codex\", \"windows\": [{\"name\": \"wk\", \"usedPercent\": 7, \"resetsAt\": %d}]},
 {\"label\": \"claude third\", \"windows\": [], \"error\": \"token expired\"}]}"
          now
          (+ now (* 45 60))
          (+ now (* 3 86400) (* 2 3600))
          (+ now (* 3 3600) 10)
          (+ now (* 6 86400))))

(defmacro pi-deck-usage-test--with (&rest body)
  "Run BODY with fresh usage state and no timer or process left behind."
  (declare (indent 0))
  `(let ((pi-deck-usage--accounts nil) (pi-deck-usage--error nil)
         (pi-deck-usage--process nil) (pi-deck-usage--timer nil)
         (pi-deck-usage--folded nil)
         (pi-deck-usage-command '("true"))
         (pi-deck-usage-interval 300)
         (pi-deck-sidebar-width 28)
         ;; No sidebar window: rows use the estimated width.
         (pi-deck-sidebar-buffer-name " *pi-deck-usage-test-sidebar*"))
     (unwind-protect (progn ,@body)
       (pi-deck-usage-stop))))

(defun pi-deck-usage-test--receive (json)
  "Adopt the usage output JSON as a finished run would."
  (with-temp-buffer
    (insert json)
    (let ((data (pi-deck-usage--parse)))
      (pi-deck-usage--receive (car data) (cdr data)))))

(defun pi-deck-usage-test--rows (&optional width now)
  "Return the account rows at WIDTH (default 25) and NOW, without properties."
  (substring-no-properties
   (pi-deck-usage-rows pi-deck-usage--accounts (or width 25) (or now pi-deck-usage-test--now))))

(defun pi-deck-usage-test--sidebar ()
  "Return the rendered sidebar text without agents or spaces."
  (let ((pi-deck--agents (make-hash-table :test 'eq))
        (pi-deck--finished-workers nil)
        (pi-deck-spaces nil))
    (with-temp-buffer
      (pi-deck-sidebar-mode)
      (pi-deck-sidebar--render)
      (buffer-string))))

(defun pi-deck-usage-test--wait ()
  "Wait until the running usage command has finished and been taken."
  (let ((deadline (+ (float-time) 10)))
    (while (and pi-deck-usage--process (< (float-time) deadline))
      (accept-process-output nil 0.05))
    (should-not pi-deck-usage--process)))

(ert-deftest pi-deck-usage-reset-durations ()
  (let ((now pi-deck-usage-test--now))
    (should (equal (pi-deck-usage--until nil now) ""))
    (dolist (case '((-1 . "now") (0 . "now") (1 . "1m")
                    (3540 . "59m") (3600 . "1h") (3601 . "1h1m")
                    (11700 . "3h15m") (86340 . "23h59m")
                    (86400 . "1d") (90000 . "1d1h")
                    (90120 . "1d1h") (266400 . "3d2h")))
      (should (equal (pi-deck-usage--until (+ now (car case)) now) (cdr case))))))

(ert-deftest pi-deck-usage-rows-fit-the-default-sidebar ()
  (pi-deck-usage-test--with
    (pi-deck-usage-test--receive (pi-deck-usage-test--json))
    (let ((rows (split-string (pi-deck-usage-test--rows) "\n" t)))
      ;; Full labels on their own rows, windows indented under them;
      ;; percentages clamp to 100 and resets read 45m, 3h1m, 3d2h or 6d.
      (should (equal rows
                     '(" claude original"
                       "   5h █████▋░░░  63% 45m"
                       "   wk █████░░░░  55% 3d2h"
                       " claude second"
                       "   5h █████████ 100% 3h1m"
                       "   wk ███████▎░  80%"
                       " codex"
                       "   wk ▋░░░░░░░░   7% 6d"
                       " claude third"
                       "   token expired")))
      ;; The row with the longest reset fills the width exactly.
      (should (= (string-width (nth 2 rows)) 25))
      (dolist (row rows) (should (<= (string-width row) 25))))
    ;; A narrow sidebar cuts labels; the full one shows on hover.
    (let ((text (pi-deck-usage-rows pi-deck-usage--accounts 12 pi-deck-usage-test--now)))
      (should (string-prefix-p " claude ori…\n" text))
      (should (equal (get-text-property 1 'help-echo text) "claude original")))))

(ert-deftest pi-deck-usage-rows-fit-hours-and-minutes ()
  (pi-deck-usage-test--with
    (pi-deck-usage-test--receive (pi-deck-usage-test--json))
    (setf (plist-get (car (plist-get (car pi-deck-usage--accounts) :windows)) :resetsAt)
          (+ pi-deck-usage-test--now (* 1439 60)))
    (dolist (width '(21 25 28))
      (let ((rows (split-string (pi-deck-usage-test--rows width) "\n" t)))
        (should (string-suffix-p " 23h59m" (nth 1 rows)))
        (should (= (string-width (nth 1 rows)) width))
        (dolist (row rows) (should (<= (string-width row) width)))))))

(ert-deftest pi-deck-usage-rows-fit-the-sidebar-window ()
  (pi-deck-usage-test--with
    ;; Rendering uses the real clock, so reset times must lie ahead of it.
    (pi-deck-usage-test--receive (pi-deck-usage-test--json (floor (float-time))))
    (save-window-excursion
      (let* ((buffer (get-buffer-create pi-deck-sidebar-buffer-name))
             (window (display-buffer-in-side-window
                      buffer '((side . left) (window-width . 28)))))
        (unwind-protect
            (with-current-buffer buffer
              (pi-deck-sidebar-mode)
              (pi-deck-sidebar--render)
              (should (= (pi-deck-usage--width) (window-max-chars-per-line window)))
              (should (= (apply #'max (mapcar #'string-width
                                              (split-string (buffer-string) "\n" t)))
                         (pi-deck-usage--width))))
          (kill-buffer buffer))))))

(ert-deftest pi-deck-usage-rows-show-severity-and-exact-reset-on-hover ()
  (pi-deck-usage-test--with
    (pi-deck-usage-test--receive (pi-deck-usage-test--json))
    (let* ((text (pi-deck-usage-rows pi-deck-usage--accounts 25 pi-deck-usage-test--now))
           (face-of (lambda (needle)
                      (get-text-property (string-search needle text) 'face text))))
      (should-not (funcall face-of "63%"))
      (should (eq (funcall face-of "100%") 'pi-deck-blocked))
      (should (eq (funcall face-of "80%") 'pi-deck-working))
      (should (string-match-p
               (concat "\\`claude original 5h: 63% used, resets "
                       (regexp-quote (format-time-string "%a %F %R" (+ pi-deck-usage-test--now 2700))))
               (get-text-property (string-search "63%" text) 'help-echo text))))))

(ert-deftest pi-deck-usage-keeps-last-numbers-and-shows-their-age ()
  (pi-deck-usage-test--with
    (pi-deck-usage-test--receive (pi-deck-usage-test--json))
    ;; Later: the original's token expired, the second account left the list.
    (pi-deck-usage-test--receive
     (format "{\"fetchedAt\": %d, \"accounts\": [
               {\"label\": \"claude original\", \"windows\": [], \"error\": \"HTTP 401\"},
               {\"label\": \"codex\", \"windows\": [{\"name\": \"wk\", \"usedPercent\": 9, \"resetsAt\": null}]}]}"
             (+ pi-deck-usage-test--now 1200)))
    (should (equal (mapcar (lambda (account) (plist-get account :label)) pi-deck-usage--accounts)
                   '("claude original" "codex")))
    (let ((rows (split-string (pi-deck-usage-test--rows 25 (+ pi-deck-usage-test--now 1800))
                              "\n" t)))
      (should (equal (nth 0 rows) " claude original"))
      (should (string-match-p "\\`   5h .* 63% 15m\\'" (nth 1 rows)))
      (should (equal (nth 3 rows) "   30m ago: HTTP 401"))
      (should (string-match-p "\\`   wk .*  9%\\'" (nth 5 rows))))
    ;; Numbers older than two intervals are marked without any error.
    (should (string-match-p "\n +2h ago\n\\'"
                            (pi-deck-usage-test--rows 25 (+ pi-deck-usage-test--now 1200 7200))))
    ;; A failed run keeps everything and says why.
    (with-temp-buffer
      (insert "{\"accounts\": 3}")
      (should-error (pi-deck-usage--parse)))
    (pi-deck-usage--failed "Unexpected usage output")
    (should (= (length pi-deck-usage--accounts) 2))
    (should (string-match-p "\n failed: Unexpected usag…\n claude original\n"
                            (pi-deck-usage-test--sidebar)))))

(ert-deftest pi-deck-usage-section-folds-like-a-space ()
  (pi-deck-usage-test--with
    (let ((pi-deck-usage-command nil))
      (should-not (string-search "usage" (pi-deck-usage-test--sidebar))))
    (should (string-match-p "New space\n\n▾ usage +↻\n fetching…\n\\'"
                            (pi-deck-usage-test--sidebar)))
    (pi-deck-usage-test--receive (pi-deck-usage-test--json))
    (with-temp-buffer
      (let ((pi-deck--agents (make-hash-table :test 'eq)) (pi-deck-spaces nil))
        (pi-deck-sidebar-mode)
        (pi-deck-sidebar--render)
        (should (string-search " claude original\n   5h" (buffer-string)))
        (goto-char (text-property-any (point-min) (point-max) 'pi-deck-usage t))
        ;; Account rows are not agents: navigation skips them.
        (should-not (pi-deck-sidebar--row-p))
        (pi-deck-sidebar-toggle-fold)
        (should (string-match-p "▸ usage +↻\n\\'" (buffer-string)))
        ;; The fold survives refresh; the row's action unfolds again.
        (pi-deck-sidebar--render)
        (should pi-deck-usage--folded)
        (goto-char (text-property-any (point-min) (point-max) 'pi-deck-usage t))
        (pi-deck-sidebar-jump)
        (should (string-search " claude original\n   5h" (buffer-string)))
        (should (eq (get-text-property (string-search "↻" (buffer-string)) 'pi-deck-button
                                       (buffer-string))
                    'usage-fetch))))))

(ert-deftest pi-deck-usage-fetch-runs-one-command-in-the-background ()
  (pi-deck-usage-test--with
    (let ((file (make-temp-file "pi-deck-usage" nil ".json" (pi-deck-usage-test--json))))
      (unwind-protect
          (progn
            (setq pi-deck-usage-command (list "sh" "-c" "sleep 0.2; cat \"$0\"" file))
            (pi-deck-usage-fetch)
            (let ((process pi-deck-usage--process))
              (should (process-live-p process))
              ;; At most one run at a time.
              (pi-deck-usage-fetch)
              (should (eq pi-deck-usage--process process))
              (pi-deck-usage-test--wait)
              (should-not (buffer-live-p (process-buffer process))))
            (should-not pi-deck-usage--error)
            (should (equal (mapcar (lambda (account) (plist-get account :label))
                                   pi-deck-usage--accounts)
                           '("claude original" "claude second" "codex" "claude third"))))
        (delete-file file)))
    ;; A failed run reports its last stderr line and keeps the numbers.
    (setq pi-deck-usage-command '("sh" "-c" "echo progress >&2; echo 'no login' >&2; exit 3"))
    (pi-deck-usage-fetch)
    (pi-deck-usage-test--wait)
    (should (equal pi-deck-usage--error "no login"))
    (should (= (length pi-deck-usage--accounts) 4))
    (setq pi-deck-usage-command '("/nonexistent/pi-deck-usage"))
    (pi-deck-usage-fetch)
    (should-not pi-deck-usage--process)
    (should (string-search "/nonexistent/pi-deck-usage" pi-deck-usage--error))))

(ert-deftest pi-deck-usage-stop-cancels-the-timer-and-a-running-fetch ()
  (pi-deck-usage-test--with
    (let ((pi-deck-usage-command nil))
      (pi-deck-usage-start)
      (should-not pi-deck-usage--timer))
    (setq pi-deck-usage-command '("sh" "-c" "sleep 30"))
    (pi-deck-usage-start)
    (should (timerp pi-deck-usage--timer))
    (should (memq pi-deck-usage--timer timer-list))
    (pi-deck-usage-fetch)
    (let ((process pi-deck-usage--process)
          (timer pi-deck-usage--timer))
      (should (process-live-p process))
      (pi-deck-usage-stop)
      (should-not (memq timer timer-list))
      (should-not pi-deck-usage--timer)
      (should-not pi-deck-usage--process)
      (should-not (process-live-p process))
      (should-not (buffer-live-p (process-buffer process)))
      (should-not pi-deck-usage--error))))

(provide 'pi-deck-usage-test)
;;; pi-deck-usage-test.el ends here
