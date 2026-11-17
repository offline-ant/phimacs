;;; pi-deck-runtime.el --- Detached runtime and stopped view actions -*- lexical-binding: t; -*-

;; SPDX-License-Identifier: MIT

;;; Commentary:

;; Deck owns views, never the lifetime of a socket transport's Pi process.
;; Pilish owns runtime validation, snapshot adoption, draft quarantine and the
;; identity-bound launch/control protocol.  All callbacks below follow its public
;; convention: one argument, nil on acknowledged success or an error string.

;;; Code:

(require 'pi-deck-core)
(require 'pi-deck-spaces)
(require 'pilish-jsonl)

(declare-function pilish-session-runtime "pilish" (buffer))
(declare-function pilish-session-desktop-state "pilish" (buffer))
(declare-function pilish-restore-session-state "pilish" (state))
(declare-function pilish-list-runtimes "pilish" ())
(declare-function pilish-runtime-configured-p "pilish-runtime-process" ())
(declare-function pilish-start-session "pilish" (directory name &rest options))
(declare-function pilish-attach-runtime "pilish" (runtime &optional name))
(declare-function pilish-reconnect-runtime "pilish" (buffer &optional callback))
(declare-function pilish-resume-stopped-session "pilish" (buffer &optional callback))
(declare-function pilish-stop-runtime "pilish" (buffer &optional callback))
(declare-function pilish-disconnect-session "pilish" (buffer))
(declare-function pi-deck--remap-layout-buffers "pi-deck-persist" (mapping))
(declare-function pi-deck--current-agent "pi-deck-goto" ())
(declare-function pi-deck-reveal "pi-deck-spaces" (agent))
(declare-function pi-deck-schedule-save "pi-deck-persist" (&rest ignored))

(defvar-local pi-deck--stopped-shell nil
  "Saved host-native terminal record, never an automatically replayed command.")

(define-derived-mode pi-deck-stopped-shell-mode special-mode "Stopped terminal"
  "A saved host-native terminal whose process was not restarted.")

(defun pi-deck-agent-runtime (agent)
  "Return the Pi AGENT's public runtime identity, not its transport process."
  (when (eq (pi-deck-agent-kind agent) 'pi)
    (pilish-session-runtime (pi-deck-agent-buffer agent))))

(defun pi-deck--runtime-agent (runtime)
  "Return a tracked view of RUNTIME, irrespective of its current session file.
A view whose Close awaits acknowledgement counts: it still holds the runtime.
So does a view whose launch of RUNTIME awaits its receipt: discovery lists
the runtime before the receipt names its mux ID, and until then the launch
operation ID chosen by the view identifies it."
  (let ((id (plist-get runtime :mux-id))
        (operation (plist-get runtime :operation-id)))
    (when (or id operation)
      (cl-find-if (lambda (agent)
                    (let ((held (pi-deck-agent-runtime agent)))
                      (if (plist-get held :mux-id)
                          (and id (equal id (plist-get held :mux-id)))
                        (and operation
                             (equal operation (plist-get held :operation-id))
                             (pi-deck-agent-runtime-pending-p agent)))))
                  (pi-deck-agents t)))))

(defun pi-deck-attach-runtime (runtime)
  "Attach to existing RUNTIME, or reveal its already attached view.
Never start Pi or reopen the discovery entry's saved session file."
  (interactive
   (let* ((runtimes (pilish-list-runtimes))
          (choices (mapcar (lambda (runtime)
                             (cons (format "%s  %s" (plist-get runtime :mux-id)
                                           (or (plist-get runtime :session-file) "starting"))
                                   runtime))
                           runtimes)))
     (unless choices (user-error "No detached runtimes are discoverable"))
     (list (cdr (assoc (completing-read "Attach runtime: " choices nil t) choices)))))
  (pi-deck-refresh)
  (let* ((existing (pi-deck--runtime-agent runtime))
         (agent (or existing
                    (pi-deck--track (pilish-attach-runtime runtime) 'pi))))
    (when (pi-deck-agent-closing agent)
      (user-error "This agent is closing; its Close awaits acknowledgement"))
    (unless existing
      (setf (pi-deck-agent-assigned-space agent)
            (or (pi-deck--space-for-dir (pi-deck-agent-directory agent))
                (pi-deck-current-space))))
    (pi-deck-reveal agent)
    (pi-deck--schedule-update)
    agent))

(defun pi-deck--session-agent (file &optional closing)
  "Return the Pi agent that has session FILE open, or nil.
CLOSING also considers agents whose Close awaits acknowledgement."
  (let ((file (file-truename file)))
    (cl-find-if (lambda (agent)
                  (when-let* ((open (pi-deck-agent-session-file agent)))
                    (equal (file-truename open) file)))
                (pi-deck-agents closing))))

(defun pi-deck--open-session-file (file dir space)
  "Reveal the agent that has session FILE open, else start FILE in DIR.
A started session is an ordinary Pi agent of SPACE in a new pane of its
layout.  Return the agent."
  (if-let* ((open (pi-deck--session-agent file)))
      (progn (pi-deck-reveal open) open)
    (let* ((chat (pilish-start-session dir (pi-deck--unique-session-name dir)
                                       :session-file file))
           (agent (pi-deck--track chat 'pi)))
      (setf (pi-deck-agent-assigned-space agent) space)
      (when (and space (not (equal space (pi-deck-current-space))))
        (pi-deck-select-space space))
      (pi-deck--display-agent-in-window agent (pi-deck--new-pane-window))
      (select-window (pi-deck--input-or-chat-window agent))
      agent)))

(defun pi-deck-reopen-agent ()
  "Reopen the current space's most recently closed top-level Pi agent.
That is the newest session file of the space's own directory that no
tracked agent (idle and stopped views included) has open, excluding
orchestration workers; forks count.  A live runtime without a view here
that holds it is attached; otherwise the session starts in a new pane.
Return its agent."
  (interactive (progn (pi-deck--enter-pane-space) nil))
  (let* ((space (pi-deck-current-space))
         (dir (file-name-as-directory (expand-file-name (pi-deck--current-space-dir))))
         (file (or (pi-deck--reopen-candidate (file-truename dir))
                   (user-error "No closed agent session in %s" (abbreviate-file-name dir)))))
    (if-let* ((runtime (pi-deck--session-runtime file)))
        (pi-deck-attach-runtime runtime)
      (pi-deck--open-session-file file dir space))))

(defun pi-deck--reopen-candidate (dir)
  "Return the newest top-level session file of true directory DIR not open here."
  (let* ((sessions (pilish-jsonl-session-directory (directory-file-name dir)))
         (files (mapcar (lambda (file)
                          (cons (file-attribute-modification-time (file-attributes file))
                                file))
                        (and (file-directory-p sessions)
                             (directory-files sessions t "\\.jsonl\\'" t)))))
    ;; Newest first, stopping at the first match: most files are never read.
    (cdr (seq-find (lambda (entry)
                     (and (not (pi-deck--session-agent (cdr entry) t))
                          (pi-deck--top-level-session-p (cdr entry) dir)))
                   (sort files (lambda (a b) (time-less-p (car b) (car a))))))))

(defun pi-deck--top-level-session-p (file dir)
  "Return non-nil when FILE is a session of true directory DIR owned by no worker.
Fresh orchestration workers (delegate, fresh_look) start with a
`pi-orchestration:delegate' entry.  Inheriting workers (do, microdo) have a
parent session and name their own file as `childSession' of a
`pi-orchestration:delegate-runtime' entry.  Forks also have a parent
session but no such entry."
  (when-let* ((header (pilish-jsonl-read-session-header file))
              (cwd (plist-get header :cwd)))
    (and (stringp cwd)
         (equal (file-name-as-directory (file-truename cwd)) dir)
         (with-temp-buffer
           (if (plist-get header :parentSession)
               (let ((file (file-truename file)) worker)
                 (insert-file-contents file)
                 (while (and (not worker)
                             (search-forward "\"pi-orchestration:delegate-runtime\"" nil t))
                   (let* ((entry (pi-deck--json-line))
                          (child (plist-get (plist-get entry :data) :childSession)))
                     (setq worker (and (equal (plist-get entry :customType)
                                              "pi-orchestration:delegate-runtime")
                                       (stringp child)
                                       (equal (file-truename child) file)))))
                 (not worker))
             ;; The marker is the entry after the header; a long first line
             ;; beyond this prefix cannot be it.
             (insert-file-contents file nil 0 65536)
             (goto-char (point-min))
             (forward-line 1)
             (not (equal (plist-get (pi-deck--json-line) :customType)
                         "pi-orchestration:delegate")))))))

(defun pi-deck--json-line ()
  "Return the current line parsed as a JSON object plist, or nil."
  (condition-case nil
      (let ((entry (json-parse-string
                    (buffer-substring-no-properties (line-beginning-position)
                                                    (line-end-position))
                    :object-type 'plist :null-object nil)))
        (and (listp entry) entry))
    (json-error nil)))

(defun pi-deck--session-runtime (file)
  "Return a discoverable live runtime holding session FILE, or nil."
  (when (pilish-runtime-configured-p)
    (let ((file (file-truename file)))
      (seq-find (lambda (runtime)
                  (let ((held (plist-get runtime :session-file)))
                    (and (not (equal (plist-get runtime :state) "stopped"))
                         (stringp held)
                         (equal (file-truename held) file))))
                (pilish-list-runtimes)))))

(defun pi-deck--action-agent (agent)
  "Return AGENT or the selected pane's agent, otherwise signal a user error."
  (or agent (pi-deck--current-agent) (user-error "No agent in this pane")))

(defun pi-deck--runtime-action (agent action)
  "Run public Pilish ACTION on AGENT without discarding its view on failure."
  (let ((buffer (pi-deck-agent-buffer agent)))
    (funcall action buffer
             (lambda (error)
               (when (buffer-live-p buffer)
                 (pi-deck-refresh-agent buffer)
                 (pi-deck--schedule-update)
                 (pi-deck-schedule-save))
               (when error (message "pi-deck: %s" error))))))

(defun pi-deck-reconnect-agent (&optional agent)
  "Reconnect AGENT's existing runtime; never create a missing runtime."
  (interactive)
  (let* ((agent (pi-deck--action-agent agent))
         (runtime (pi-deck-agent-runtime agent)))
    (unless (and (eq (pi-deck-agent-kind agent) 'pi)
                 (equal (plist-get runtime :protocol) 2)
                 (plist-get runtime :mux-id)
                 (not (equal (plist-get runtime :state) "stopped")))
      (user-error "This stopped view has no runtime to reconnect; use Resume"))
    (pi-deck--runtime-action agent #'pilish-reconnect-runtime)))

(defun pi-deck--restore-shell-view (record)
  "Create a stopped host-native terminal view from RECORD without spawning."
  (let ((buffer (generate-new-buffer (plist-get record :buffer)))
        (dir (plist-get record :dir)))
    (with-current-buffer buffer
      (pi-deck-stopped-shell-mode)
      (setq pi-deck--stopped-shell (copy-tree record))
      (when (and (stringp dir) (file-directory-p dir))
        (setq default-directory (file-name-as-directory dir)))
      (let ((inhibit-read-only t))
        (insert "This host-native terminal did not survive the frontend.\n\n"
                "No saved command was executed. Use Resume explicitly to start\n"
                "a new ordinary shell. Managed panels must be recreated by their owner.\n\n"
                (format "Directory: %s\nCommand: %S\n" dir (plist-get record :command)))))
    buffer))

(defun pi-deck-resume-agent (&optional agent)
  "Explicitly start AGENT's stopped conversation or ordinary terminal.
No prompt, queue, worker request or shell command is replayed by restoration."
  (interactive)
  (let* ((agent (pi-deck--action-agent agent))
         (buffer (pi-deck-agent-buffer agent)))
    (when (or (pi-deck-agent-worker-p agent)
              (equal (pi-deck-agent-placement agent) "worker"))
      (user-error "This worker/panel belongs to its parent; use the parent's recovery protocol"))
    (if (eq (pi-deck-agent-kind agent) 'pi)
        (pi-deck--runtime-action agent #'pilish-resume-stopped-session)
      (let* ((record (buffer-local-value 'pi-deck--stopped-shell buffer))
             (dir (plist-get record :dir)))
        (unless record (user-error "This shell is not a stopped restored view"))
        (unless (and (stringp dir) (file-directory-p dir))
          (user-error "The saved shell directory is unavailable"))
        (when (yes-or-no-p "Start a new shell and execute its saved command? ")
          ;; Create first: a failed spawn must leave the saved view intact.
          (let* ((new (pi-deck-start-shell dir (string-trim (buffer-name buffer) "\\*" "\\*")
                                          (plist-get record :command)))
                 (replacement (pi-deck--track new 'shell)))
            (setf (pi-deck-agent-assigned-space replacement) (pi-deck-agent-assigned-space agent))
            (pi-deck--remap-layout-buffers (list (cons (buffer-name buffer) (buffer-name new))))
            (dolist (window (get-buffer-window-list buffer nil t))
              (set-window-buffer window new))
            (kill-buffer buffer)
            (pi-deck-reveal replacement)))))))

(provide 'pi-deck-runtime)
;;; pi-deck-runtime.el ends here
