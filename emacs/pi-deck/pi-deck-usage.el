;;; pi-deck-usage.el --- Subscription usage section of the sidebar -*- lexical-binding: t; -*-

;; SPDX-License-Identifier: MIT

;;; Commentary:

;; A foldable "usage" section at the bottom of the sidebar shows, per
;; account, how much of each subscription window (such as five hours or a
;; week) is used and how long until it resets.  The numbers come from
;; `pi-deck-usage-command', run in the background every
;; `pi-deck-usage-interval' seconds while `pi-deck-mode' is on; deck itself
;; knows no accounts, credentials or endpoints.  The command prints one
;; JSON object and exits 0:
;;
;;   {"fetchedAt": 1795110000,
;;    "accounts": [{"label": "claude original",
;;                  "windows": [{"name": "5h", "usedPercent": 63,
;;                               "resetsAt": 1795110599}]},
;;                 {"label": "codex", "windows": [], "error": "token expired"}]}
;;
;; `fetchedAt' and `resetsAt' are Unix seconds (`resetsAt' may be null).
;; An account reported with an error and no windows keeps its last numbers,
;; shown with their age and the error; a failed run keeps all of them.

;;; Code:

(require 'pi-deck-core)
(require 'pi-deck-sidebar)

(defcustom pi-deck-usage-command nil
  "Command printing subscription usage as JSON, or nil for no usage section.
A list of the program and its arguments, run without a shell; see the
commentary of pi-deck-usage.el for its output.  It takes effect when
`pi-deck-mode' is enabled."
  :type '(choice (const :tag "No usage section" nil) (repeat string))
  :group 'pi-deck)

(defcustom pi-deck-usage-interval 300
  "Seconds between runs of `pi-deck-usage-command'."
  :type 'natnum
  :group 'pi-deck)

(defvar pi-deck-usage--accounts nil
  "Accounts in the order of the last output: plists (:label :windows :time :error).
`:windows' are the last reported (:name :usedPercent :resetsAt) plists and
`:time' the `fetchedAt' of the run that reported them.")

(defvar pi-deck-usage--error nil
  "Why the last run of the usage command produced no data, or nil.")

(defvar pi-deck-usage--process nil
  "The running usage command, or nil.")

(defvar pi-deck-usage--timer nil
  "Repeating fetch timer while `pi-deck-mode' is on, or nil.")

(defvar pi-deck-usage--folded nil
  "Whether the sidebar's usage section is folded.")

;;;; Fetching

(defun pi-deck-usage-start ()
  "Fetch usage now and every `pi-deck-usage-interval' seconds, when configured."
  (when (and pi-deck-usage-command (not pi-deck-usage--timer))
    (setq pi-deck-usage--timer
          (run-with-timer 0 (max 1 pi-deck-usage-interval) #'pi-deck-usage-fetch))))

(defun pi-deck-usage-stop ()
  "Cancel the fetch timer and a running fetch, keeping the last data."
  (when (timerp pi-deck-usage--timer) (cancel-timer pi-deck-usage--timer))
  (setq pi-deck-usage--timer nil)
  (when-let* ((process pi-deck-usage--process))
    (setq pi-deck-usage--process nil)
    (set-process-sentinel process #'ignore)
    (delete-process process)
    (pi-deck-usage--dispose process)))

(defun pi-deck-usage-fetch ()
  "Run `pi-deck-usage-command' once in the background, unless it already runs."
  (interactive)
  (when (and pi-deck-usage-command (not (process-live-p pi-deck-usage--process)))
    (let* ((default-directory (expand-file-name "~/"))
           (stdout (generate-new-buffer " *pi-deck-usage*" t))
           (stderr (make-pipe-process
                    :name "pi-deck-usage-stderr" :noquery t :sentinel #'ignore
                    :buffer (generate-new-buffer " *pi-deck-usage-stderr*" t))))
      (condition-case error
          (let ((process (make-process :name "pi-deck-usage" :buffer stdout
                                       :command pi-deck-usage-command
                                       :connection-type 'pipe :coding 'utf-8
                                       :noquery t :stderr stderr
                                       :sentinel #'pi-deck-usage--sentinel)))
            (process-put process 'pi-deck-usage-stderr stderr)
            (setq pi-deck-usage--process process))
        (error
         (kill-buffer stdout)
         (delete-process stderr)
         (kill-buffer (process-buffer stderr))
         (pi-deck-usage--failed (format "%s: %s" (car pi-deck-usage-command)
                                        (error-message-string error))))))))

(defun pi-deck-usage--dispose (process)
  "Kill the buffers and stderr pipe of the usage command PROCESS."
  (when-let* ((stderr (process-get process 'pi-deck-usage-stderr)))
    (delete-process stderr)
    (when (buffer-live-p (process-buffer stderr)) (kill-buffer (process-buffer stderr))))
  (when (buffer-live-p (process-buffer process)) (kill-buffer (process-buffer process))))

(defun pi-deck-usage--sentinel (process _event)
  "Take the result of the usage command PROCESS once it ended."
  (unless (process-live-p process)
    (unwind-protect
        (when (eq process pi-deck-usage--process)
          (setq pi-deck-usage--process nil)
          (condition-case error
              (if (and (eq (process-status process) 'exit)
                       (zerop (process-exit-status process)))
                  (let ((data (with-current-buffer (process-buffer process)
                                (pi-deck-usage--parse))))
                    (pi-deck-usage--receive (car data) (cdr data)))
                (pi-deck-usage--failed (pi-deck-usage--exit-reason process)))
            (error (pi-deck-usage--failed (error-message-string error)))))
      (pi-deck-usage--dispose process))))

(defun pi-deck-usage--exit-reason (process)
  "Return why the usage command PROCESS failed: its last stderr line or status."
  (let* ((stderr (process-get process 'pi-deck-usage-stderr))
         (lines (and stderr (buffer-live-p (process-buffer stderr))
                     (with-current-buffer (process-buffer stderr)
                       (split-string (buffer-string) "\n" t "[ \t\r]+")))))
    (or (car (last lines))
        (format "%s %s" (if (eq (process-status process) 'signal) "killed by signal" "exit")
                (process-exit-status process)))))

(defun pi-deck-usage--parse ()
  "Parse the usage command's output in the current buffer.
Return (FETCHED-AT . ACCOUNTS); signal an error for any other shape."
  (goto-char (point-min))
  (let* ((data (json-parse-buffer :object-type 'plist :array-type 'list
                                  :null-object nil :false-object nil))
         (fetched (plist-get data :fetchedAt))
         (accounts (plist-get data :accounts)))
    ;; Trust boundary: the output of an external command.
    (unless (and (numberp fetched) (listp accounts)
                 (cl-every #'pi-deck-usage--account-p accounts))
      (error "Unexpected usage output"))
    (cons fetched accounts)))

(defun pi-deck-usage--account-p (account)
  "Return non-nil when ACCOUNT has the usage command's account shape."
  (and (listp account)
       (stringp (plist-get account :label))
       (listp (plist-get account :windows))
       (cl-every (lambda (window)
                   (and (listp window)
                        (stringp (plist-get window :name))
                        (numberp (plist-get window :usedPercent))
                        (let ((reset (plist-get window :resetsAt)))
                          (or (null reset) (numberp reset)))))
                 (plist-get account :windows))
       (let ((error (plist-get account :error)))
         (or (null error) (stringp error)))))

(defun pi-deck-usage--receive (fetched accounts)
  "Adopt ACCOUNTS fetched at FETCHED, keeping last numbers of failed ones."
  (setq pi-deck-usage--error nil
        pi-deck-usage--accounts
        (mapcar (lambda (account)
                  (let* ((label (plist-get account :label))
                         (windows (plist-get account :windows))
                         (error (plist-get account :error))
                         (old (cl-find label pi-deck-usage--accounts
                                       :key (lambda (old) (plist-get old :label))
                                       :test #'equal)))
                    (if (and error (null windows) old)
                        (list :label label :windows (plist-get old :windows)
                              :time (plist-get old :time) :error error)
                      (list :label label :windows windows :time fetched :error error))))
                accounts))
  (pi-deck-sidebar-refresh-visible))

(defun pi-deck-usage--failed (reason)
  "Record REASON for a run without data, keeping the last numbers."
  (setq pi-deck-usage--error reason)
  (pi-deck-sidebar-refresh-visible))

;;;; Rendering

(defun pi-deck-usage-insert ()
  "Insert the sidebar's usage section when `pi-deck-usage-command' is set."
  (when pi-deck-usage-command
    (insert "\n" (pi-deck-usage--header))
    (unless pi-deck-usage--folded
      (let ((width (pi-deck-usage--width)))
        (when pi-deck-usage--error
          (insert (pi-deck-usage--note 1 (concat "failed: " pi-deck-usage--error) width)))
        (if pi-deck-usage--accounts
            (insert (pi-deck-usage-rows pi-deck-usage--accounts width (float-time)))
          (unless pi-deck-usage--error
            (insert (pi-deck-usage--note 1 "fetching…" width))))))))

(defun pi-deck-usage--width ()
  "Return the columns every window showing the sidebar can display.
Before the sidebar is shown, estimate them from `pi-deck-sidebar-width'."
  (if-let* ((buffer (get-buffer pi-deck-sidebar-buffer-name))
            (windows (get-buffer-window-list buffer nil t)))
      (apply #'min (mapcar #'window-max-chars-per-line windows))
    (- pi-deck-sidebar-width 3)))

(defun pi-deck-usage--header ()
  "Return the usage section's header row: fold arrow, name and fetch button."
  (pi-deck-sidebar--clickable
   (propertize
    (concat (pi-deck-sidebar--button (if pi-deck-usage--folded "▸" "▾")
                                     'fold "mouse-1: fold or unfold")
            " " (propertize "usage" 'face 'bold)
            (pi-deck-sidebar--right
             (pi-deck-sidebar--button "↻" 'usage-fetch "mouse-1: fetch usage now"))
            "\n")
    'pi-deck-usage t)
   "mouse-1: fold or unfold"))

(defun pi-deck-usage--note (indent text width)
  "Return a dim row of TEXT after INDENT columns, cut to WIDTH, TEXT on hover."
  (concat (make-string indent ?\s)
          (propertize (truncate-string-to-width text (max 1 (- width indent)) nil nil "…")
                      'face 'shadow 'help-echo text)
          "\n"))

(defun pi-deck-usage-rows (accounts width now)
  "Return the rows of ACCOUNTS fitting WIDTH columns at time NOW.
Each account's label row is followed by one indented row per window
\(name, bar, percent used, time to reset) and a dim note when its numbers
are old, failed or missing."
  (let* ((windows (mapcan (lambda (account) (copy-sequence (plist-get account :windows)))
                          accounts))
         (name-width (apply #'max 1 (mapcar (lambda (w) (string-width (plist-get w :name)))
                                            windows)))
         (percent-width (apply #'max 3 (mapcar (lambda (w) (length (pi-deck-usage--percent w)))
                                               windows)))
         (reset-width (apply #'max 0 (mapcar (lambda (w) (length (pi-deck-usage--until
                                                                 (plist-get w :resetsAt) now)))
                                             windows)))
         ;; Indent and the spaces after name, bar and percent.
         (other (+ 3 name-width 1 1 percent-width (if (> reset-width 0) (1+ reset-width) 0)))
         (widths (list name-width (max 3 (- width other)) percent-width)))
    (mapconcat (lambda (account) (pi-deck-usage--account-rows account width now widths))
               accounts "")))

(defun pi-deck-usage--account-rows (account width now widths)
  "Return ACCOUNT's label row, window rows and note in WIDTH columns at NOW.
WIDTHS are the window name, bar and percent widths."
  (let ((label (plist-get account :label))
        (time (plist-get account :time))
        (error (plist-get account :error))
        (windows (plist-get account :windows)))
    (concat
     " " (propertize (truncate-string-to-width label (max 1 (1- width)) nil nil "…")
                    'help-echo label)
     "\n"
     (mapconcat (lambda (window) (pi-deck-usage--window-row account window now widths))
                windows "")
     (cond ((null windows) (pi-deck-usage--note 3 (or error "no data") width))
           ((or error (> (- now time) (* 2 pi-deck-usage-interval)))
            (pi-deck-usage--note 3 (concat (pi-deck-usage--duration
                                            (max 0 (floor (- now time) 60)))
                                           " ago" (and error (concat ": " error)))
                                 width))))))

(defun pi-deck-usage--window-row (account window now widths)
  "Return the indented row of ACCOUNT's WINDOW at time NOW.
WIDTHS are the window name, bar and percent widths."
  (pcase-let* ((`(,name-width ,bar-width ,percent-width) widths)
               (percent (min 100 (max 0 (plist-get window :usedPercent))))
               (reset (plist-get window :resetsAt))
               (face (cond ((>= percent 90) 'pi-deck-blocked)
                           ((>= percent 75) 'pi-deck-working)))
               (until (pi-deck-usage--until reset now)))
    (propertize
     (concat "   " (string-pad (plist-get window :name) name-width)
             " " (pi-deck-usage--bar percent bar-width face)
             " " (propertize (string-pad (pi-deck-usage--percent window) percent-width nil t)
                             'face face)
             (unless (string-empty-p until) (concat " " until))
             "\n")
     'help-echo
     (format "%s %s: %s used%s; as of %s"
             (plist-get account :label) (plist-get window :name)
             (pi-deck-usage--percent window)
             (if reset (format-time-string ", resets %a %F %R %Z" reset) "")
             (format-time-string "%R" (plist-get account :time))))))

(defun pi-deck-usage--percent (window)
  "Return WINDOW's used percentage as text, such as \"63%\"."
  (format "%d%%" (round (min 100 (max 0 (plist-get window :usedPercent))))))

(defun pi-deck-usage--bar (percent width face)
  "Return a WIDTH-column bar filled to PERCENT in FACE."
  (let* ((eighths (round (* percent width 8) 100))
         (full (/ eighths 8))
         (part (% eighths 8)))
    (concat (propertize (concat (make-string full ?█)
                                (if (> part 0) (string (aref "▏▎▍▌▋▊▉" (1- part))) ""))
                        'face face)
            (propertize (make-string (- width full (if (> part 0) 1 0)) ?░)
                        'face 'shadow))))

(defun pi-deck-usage--until (time now)
  "Return the compact time from NOW until TIME, such as 45m, 3h15m or 3d2h.
Empty when TIME is nil."
  (let ((minutes (and time (ceiling (- time now) 60))))
    (cond ((null minutes) "")
          ((<= minutes 0) "now")
          (t (pi-deck-usage--duration minutes)))))

(defun pi-deck-usage--duration (minutes)
  "Return MINUTES compactly, such as 45m, 3h15m or 3d2h."
  (cond ((< minutes 60) (format "%dm" minutes))
        ((< minutes 1440)
         (let ((rest (% minutes 60)))
           (format "%dh%s" (/ minutes 60) (if (zerop rest) "" (format "%dm" rest)))))
        (t (let ((hours (/ (% minutes 1440) 60)))
             (format "%dd%s" (/ minutes 1440) (if (zerop hours) "" (format "%dh" hours)))))))

(defun pi-deck-usage-toggle-fold ()
  "Fold or unfold the sidebar's usage section."
  (setq pi-deck-usage--folded (not pi-deck-usage--folded)))

(provide 'pi-deck-usage)
;;; pi-deck-usage.el ends here
