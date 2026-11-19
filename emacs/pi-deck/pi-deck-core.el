;;; pi-deck-core.el --- Agent registry and status model -*- lexical-binding: t; -*-

;; SPDX-License-Identifier: MIT

;;; Commentary:

;; Agents are Pilish sessions (identified by their chat buffer) and ghostel
;; terminal buffers.  Each agent has a base state (idle, working, waiting,
;; blocked, unknown) and a seen flag; an idle agent that worked while nobody
;; was looking is "done" until its buffer is shown.  A busy Pi agent whose
;; running tools only wait on orchestration work is waiting, not working.
;; Attention priority is blocked > done > working > waiting > idle > unknown,
;; and rolls up to spaces as a maximum.  This file derives the state; observers subscribe to
;; `pi-deck-agent-change-functions' and `pi-deck-update-hook'.

;;; Code:

(require 'cl-lib)
(require 'subr-x)
(require 'pilish)
;; The detached runtime API ships with this deck; stock Pilish lacks it.
(require 'pilish-runtime)

(declare-function pi-orchestration-targets "pi-orchestration" ())
(declare-function pi-orchestration-panel-command-state "pi-orchestration" (buffer))
(declare-function pilish-session-runtime "pilish" (buffer))
(declare-function pilish-session-runtime-pending-p "pilish-runtime" (buffer))
(declare-function pi-deck-schedule-save "pi-deck-persist" (&rest ignored))

(defgroup pi-deck nil
  "Spaces and an agent sidebar for Pi sessions."
  :group 'tools
  :prefix "pi-deck-")

(defcustom pi-deck-status-icons
  '((blocked . "◉") (done . "●") (working . "◐") (waiting . "◌") (idle . "○")
    (unknown . "·") (new . "✦"))
  "Icons shown for each attention status and for new available runtimes."
  :type '(alist :key-type symbol :value-type string)
  :group 'pi-deck)

(defcustom pi-deck-include-shells t
  "Whether ghostel terminal buffers are agents in the sidebar."
  :type 'boolean
  :group 'pi-deck)

(defface pi-deck-blocked '((t :inherit error :weight bold))
  "Face for blocked agents."
  :group 'pi-deck)
(defface pi-deck-done '((t :inherit success :weight bold))
  "Face for finished, unseen agents."
  :group 'pi-deck)
(defface pi-deck-working '((t :inherit warning))
  "Face for working agents."
  :group 'pi-deck)
(defface pi-deck-waiting '((t :inherit warning :weight light))
  "Face for agents only waiting on their workers or other orchestration work."
  :group 'pi-deck)
(defface pi-deck-idle '((t :inherit shadow))
  "Face for idle agents."
  :group 'pi-deck)
(defface pi-deck-unknown '((t :inherit shadow))
  "Face for agents whose state is unknown."
  :group 'pi-deck)
(defface pi-deck-header-dim '((t :inherit shadow))
  "Face for dim text in pi-deck header lines.
It covers pane title bar details and switched-off buttons and the
sidebar header's separators.  Header lines usually have the mode line's
background, on which some themes' `shadow' is hard to read."
  :group 'pi-deck)

(defun pi-deck--escape-percent (string)
  "Return STRING with every `%' doubled, keeping its text properties.
The result shows as STRING in a mode or header line."
  (let ((parts nil) (start 0))
    (while-let ((index (string-search "%" string start)))
      (push (substring string start (1+ index)) parts)
      (push (substring string index (1+ index)) parts)
      (setq start (1+ index)))
    (push (substring string start) parts)
    (apply #'concat (nreverse parts))))

(defconst pi-deck-statuses '(blocked done working waiting idle unknown)
  "Attention statuses, most urgent first.")

(defconst pi-deck--waiting-status-key "worker-frame"
  "Key of the extension status that tells a worker waits for the user.")

(defconst pi-deck--waiting-status-prefix "worker:waiting"
  "Start of that status's text while an interrupted worker waits for the user.")

(defconst pi-deck--orchestration-waiting-key "orchestration-waiting"
  "Key of the extension status set while an agent only waits on orchestration work.")

(defun pi-deck-status-priority (status)
  "Return the attention priority of STATUS; higher is more urgent."
  (pcase status ('blocked 5) ('done 4) ('working 3) ('waiting 2) ('idle 1) (_ 0)))

(defun pi-deck-rollup (statuses)
  "Return the most urgent of STATUSES, or nil when there are none."
  (car (sort (copy-sequence statuses)
             (lambda (a b) (> (pi-deck-status-priority a)
                              (pi-deck-status-priority b))))))

(defun pi-deck-status-face (status)
  "Return the face for STATUS."
  (intern (format "pi-deck-%s" (or status 'unknown))))

(defun pi-deck-status-icon (status)
  "Return STATUS's icon string, propertized with its face."
  (propertize (or (alist-get status pi-deck-status-icons) "·")
              'face (pi-deck-status-face status)))

;;;; Agents

(defvar pi-deck--agent-count 0
  "Number of agents tracked so far; the next one gets the next number.")

(cl-defstruct (pi-deck-agent (:constructor pi-deck-agent--make)
                             (:copier nil))
  "A Pi session or terminal tracked by pi-deck."
  buffer            ; chat buffer (pi) or terminal buffer (shell); identity
  (number (cl-incf pi-deck--agent-count)) ; creation order, see `pi-deck-agents'
  kind              ; `pi' or `shell'
  (state 'unknown)  ; base state: idle, working, waiting, blocked, unknown
  (seen t)          ; nil after finishing work unobserved
  (changed (float-time)) ; time of the last base-state change
  assigned-space    ; space explicitly assigned by pi-deck, or nil
  parent            ; parent agent buffer (orchestration), or nil
  target            ; orchestration target ID, or nil
  placement         ; orchestration placement: "worker", "interactive-fork" or nil
  closing           ; non-nil while a Close awaits its stop acknowledgement
  ended)            ; non-nil when a shell's command had ended at the last refresh

(defvar pi-deck--agents (make-hash-table :test 'eq)
  "Tracked agents, keyed by their buffer.")

(defvar pi-deck-agent-change-functions nil
  "Functions called with AGENT, OLD-STATE and NEW-STATE after a state change.")

(defvar pi-deck-update-hook nil
  "Hook run (debounced) after agents, states or seen flags changed.")

(defun pi-deck-agent-status (agent)
  "Return AGENT's attention status: its base state, or `done'."
  (let ((state (pi-deck-agent-state agent)))
    (if (and (eq state 'idle) (not (pi-deck-agent-seen agent))) 'done state)))

(defun pi-deck-agents (&optional closing)
  "Return all live agents in creation order, oldest first.
Agents being closed are left out until their Close fails, unless CLOSING
is non-nil.  The order is stable: showing, selecting or renaming an agent
never moves it.  Saved state lists agents in this order and restores them
in it."
  (let (agents)
    (maphash (lambda (buffer agent)
               (when (and (buffer-live-p buffer)
                          (or closing (not (pi-deck-agent-closing agent))))
                 (push agent agents)))
             pi-deck--agents)
    (sort agents :key #'pi-deck-agent-number)))

(defun pi-deck-agent (buffer)
  "Return the agent tracked for BUFFER, or nil."
  (and buffer (gethash buffer pi-deck--agents)))

(defun pi-deck-pi-buffer-p (buffer)
  "Return non-nil when BUFFER is a Pilish chat buffer."
  (and (buffer-live-p buffer)
       (eq (buffer-local-value 'major-mode buffer) 'pilish-chat-mode)))

(defun pi-deck-shell-buffer-p (buffer)
  "Return non-nil when BUFFER is a ghostel terminal buffer."
  (and (buffer-live-p buffer)
       (or (eq (buffer-local-value 'major-mode buffer) 'pi-deck-stopped-shell-mode)
           (provided-mode-derived-p (buffer-local-value 'major-mode buffer) 'ghostel-mode))))

(defun pi-deck-agent-directory (agent)
  "Return AGENT's working directory."
  (let ((buffer (pi-deck-agent-buffer agent)))
    (if (eq (pi-deck-agent-kind agent) 'pi)
        (pilish-session-directory buffer)
      (if (eq (buffer-local-value 'major-mode buffer) 'pi-deck-stopped-shell-mode)
          (plist-get (buffer-local-value 'pi-deck--stopped-shell buffer) :dir)
        (buffer-local-value 'default-directory buffer)))))

(defun pi-deck-agent-process (agent)
  "Return AGENT's process, or nil."
  (let ((buffer (pi-deck-agent-buffer agent)))
    (if (eq (pi-deck-agent-kind agent) 'pi)
        (pilish-session-process buffer)
      (get-buffer-process buffer))))

(defun pi-deck-agent-session-name (agent)
  "Return the Pilish named-session suffix of AGENT, or nil."
  (when (eq (pi-deck-agent-kind agent) 'pi)
    (pilish-session-name (pi-deck-agent-buffer agent))))

(defun pi-deck-agent-name (agent)
  "Return a short display name for AGENT."
  (let ((buffer (pi-deck-agent-buffer agent)))
    (if (eq (pi-deck-agent-kind agent) 'pi)
        (or (pilish-session-title buffer)
            (pi-deck-agent-session-name agent)
            (file-name-nondirectory
             (directory-file-name (pi-deck-agent-directory agent))))
      (let ((name (buffer-name buffer)))
        ;; Orchestration panels are "pi-panel:NAME:ID".
        (if (string-match "\\`pi-panel:\\(.*\\):[^:]*\\'" name)
            (match-string 1 name)
          (string-trim name "\\*" "\\*"))))))

(defun pi-deck-agent-model (agent)
  "Return AGENT's model ID, or nil."
  (when (eq (pi-deck-agent-kind agent) 'pi)
    (plist-get (pilish-session-model (pi-deck-agent-buffer agent)) :id)))

(defun pi-deck-agent-session-file (agent)
  "Return AGENT's Pi session file, or nil."
  (when (eq (pi-deck-agent-kind agent) 'pi)
    (pilish-session-file (pi-deck-agent-buffer agent))))

(defun pi-deck-agent-dialogs (agent)
  "Return the extension dialogs AGENT awaits the user for."
  (when (eq (pi-deck-agent-kind agent) 'pi)
    (pilish-session-pending-dialogs (pi-deck-agent-buffer agent))))

(defun pi-deck--waiting-p (buffer)
  "Return non-nil when the Pilish chat BUFFER is a worker waiting for the user."
  (when-let* ((status (pilish-session-extension-status
                       buffer pi-deck--waiting-status-key)))
    (string-prefix-p pi-deck--waiting-status-prefix status)))

(defun pi-deck--panel-command-state (buffer)
  "Return BUFFER's public managed command state, or nil when unmanaged.
A persistent panel wrapper's liveness is not its command's state."
  (when (fboundp 'pi-orchestration-panel-command-state)
    (pi-orchestration-panel-command-state buffer)))

(defun pi-deck-agent-runtime-pending-p (agent)
  "Return non-nil while the Pi AGENT's runtime launch or reconnection runs.
Its view has no transport yet, but it is starting, not disconnected."
  (and (eq (pi-deck-agent-kind agent) 'pi)
       (pilish-session-runtime-pending-p (pi-deck-agent-buffer agent))))

(defun pi-deck-agent-detail (agent)
  "Return a one-line detail for AGENT: dialog title, waiting, exit status, or nil."
  (let ((dialog (car (pi-deck-agent-dialogs agent)))
        (process (pi-deck-agent-process agent))
        (command-state (and (eq (pi-deck-agent-kind agent) 'shell)
                            (pi-deck--panel-command-state (pi-deck-agent-buffer agent)))))
    (cond
     ;; Titles may add context lines before the question.
     (dialog (format "asks: %s" (car (last (split-string (or (plist-get dialog :title)
                                                             (plist-get dialog :method))
                                                         "\n")))))
     ((and (eq (pi-deck-agent-kind agent) 'pi)
           (pi-deck--waiting-p (pi-deck-agent-buffer agent)))
      "waiting for you")
     ((and (eq (pi-deck-agent-kind agent) 'shell)
           (eq (buffer-local-value 'major-mode (pi-deck-agent-buffer agent))
               'pi-deck-stopped-shell-mode))
      "stopped terminal; explicit Resume required")
     ((and (eq (pi-deck-agent-kind agent) 'pi)
           (not (and (processp process) (process-live-p process))))
      (let* ((runtime (pilish-session-runtime (pi-deck-agent-buffer agent)))
             (state (plist-get runtime :state)))
        (cond
         ((pi-deck-agent-runtime-pending-p agent)
          (if (equal state "starting") "starting" "connecting"))
         ((or (null runtime) (equal state "stopped")) "stopped view; explicit Resume required")
         ((equal state "unavailable") "unavailable; Reconnect or explicitly Resume after reconciling ownership")
         (t "disconnected; Reconnect existing runtime (no restart)"))))
     (command-state
      (pcase command-state
        ("exited" "exited")
        ("held" "waiting for activation")
        ("unknown" "command state unknown")))
     ((and (eq (pi-deck-agent-kind agent) 'shell)
           (buffer-local-value 'pi-deck--shell-exit (pi-deck-agent-buffer agent)))
      (format "exited %s" (buffer-local-value 'pi-deck--shell-exit
                                              (pi-deck-agent-buffer agent))))
     ((and (processp process) (not (process-live-p process)))
      (format "exited %s" (process-exit-status process)))
     ((not process) "no process"))))

(defun pi-deck-agent-finished-shell-p (agent)
  "Return non-nil when AGENT's shell command ended.
Managed panels retain a live wrapper after command exit. Unknown managed
command state is not completion. Unmanaged terminals use process liveness."
  (and (eq (pi-deck-agent-kind agent) 'shell)
       (if-let* ((state (pi-deck--panel-command-state (pi-deck-agent-buffer agent))))
           (equal state "exited")
         (let ((process (pi-deck-agent-process agent)))
           (not (and (processp process) (process-live-p process)))))))

(defun pi-deck-agent-windows-buffers (agent)
  "Return the buffers whose display counts as showing AGENT."
  (let ((buffer (pi-deck-agent-buffer agent)))
    (delq nil (list buffer
                    (and (eq (pi-deck-agent-kind agent) 'pi)
                         (pilish-session-input-buffer buffer))))))

(defun pi-deck-agent-worker-p (agent)
  "Return non-nil when AGENT is an orchestration worker or panel of another agent.
Interactive forks are peers, not workers."
  (and (pi-deck-agent-target agent)
       (not (equal (pi-deck-agent-placement agent) "interactive-fork"))))

(defun pi-deck-agent-descendants (agent)
  "Return AGENT's owned descendants, including those being closed.
Independent interactive forks are peers."
  (let ((result nil) (queue (list agent)))
    (while queue
      (let ((buffer (pi-deck-agent-buffer (pop queue))))
        (dolist (child (pi-deck-agents t))
          (when (and (eq (pi-deck-agent-parent child) buffer)
                     (not (equal (pi-deck-agent-placement child) "interactive-fork"))
                     (not (memq child result)) (not (eq child agent)))
            (push child result)
            (push child queue)))))
    (nreverse result)))

(defun pi-deck-agent-visible-p (agent)
  "Return non-nil when AGENT is shown in a window of a visible frame.
Only the layout a frame shows has windows, so this means the user can see
it now."
  (cl-some (lambda (buffer)
             (and (buffer-live-p buffer) (get-buffer-window buffer 'visible)))
           (pi-deck-agent-windows-buffers agent)))

;;;; State derivation

(defvar-local pi-deck--shell-phase nil
  "Shell prompt phase from OSC 133 marks: nil, `prompt' or `running'.")

(defvar-local pi-deck--shell-exit nil
  "Exit status of the terminal's process once it exited, else nil.")

(defun pi-deck--pi-state (buffer)
  "Derive the base state of the Pilish chat BUFFER."
  (let ((process (pilish-session-process buffer)))
    (cond
     ((not (and (processp process) (process-live-p process))) 'unknown)
     ((or (pilish-session-pending-dialogs buffer) (pi-deck--waiting-p buffer)) 'blocked)
     ((pilish-session-busy-p buffer)
      (if (pilish-session-extension-status buffer pi-deck--orchestration-waiting-key)
          'waiting 'working))
     (t 'idle))))

(defun pi-deck--shell-state (buffer)
  "Derive BUFFER's command state, not a managed panel wrapper's liveness."
  (let ((command-state (pi-deck--panel-command-state buffer))
        (phase (buffer-local-value 'pi-deck--shell-phase buffer)))
    (if command-state
        (pcase command-state
          ("exited" 'idle)
          ("running" (if (eq phase 'prompt) 'idle 'working))
          (_ 'unknown))
      (let ((process (get-buffer-process buffer)))
        (if (not (and process (process-live-p process))) 'idle
          (pcase phase ('running 'working) ('prompt 'idle) (_ 'unknown)))))))

(defun pi-deck--shell-mark (type &rest _)
  "Record OSC 133 mark TYPE of the current ghostel buffer.
A (prompt) and D (command finished) mean the shell waits at its prompt;
C (command output) means a command runs.  Ghostel parses the marks and
calls `ghostel--osc133-marker' with the terminal buffer current; it has no
public hook for A, which a freshly started shell's first prompt needs."
  (let ((phase (pcase type ("C" 'running) ((or "A" "D") 'prompt)))
        (buffer (current-buffer)))
    (when (and phase (not (eq phase pi-deck--shell-phase)))
      (setq pi-deck--shell-phase phase)
      (when (pi-deck-agent buffer) (pi-deck-refresh-agent buffer)))))

(defun pi-deck--shell-exited (buffer event)
  "Record the exit of terminal BUFFER's process described by EVENT.
EVENT is the process status text, such as \"finished\" or \"exited
abnormally with code 2\"."
  (when (buffer-live-p buffer)
    (with-current-buffer buffer
      (setq pi-deck--shell-exit
            (cond ((string-prefix-p "finished" event) 0)
                  ((string-match "code \\([0-9]+\\)" event)
                   (string-to-number (match-string 1 event)))
                  (t (string-trim event)))))
    (when (pi-deck-agent buffer) (pi-deck-refresh-agent buffer))))

(defun pi-deck--install-terminal-hooks ()
  "Record all terminal marks while deck is enabled, even before tracking."
  (when (featurep 'ghostel)
    (unless (advice-member-p #'pi-deck--shell-mark 'ghostel--osc133-marker)
      (advice-add 'ghostel--osc133-marker :after #'pi-deck--shell-mark))
    (add-hook 'ghostel-exit-functions #'pi-deck--shell-exited)))

(defun pi-deck--remove-terminal-hooks ()
  "Remove only deck's terminal observers."
  (advice-remove 'ghostel--osc133-marker #'pi-deck--shell-mark)
  (remove-hook 'ghostel-exit-functions #'pi-deck--shell-exited)
  ;; A command can start while observers are absent.  Keep no prompt/running
  ;; cache that would look authoritative on the next enable; await a new mark.
  (dolist (buffer (buffer-list))
    (when (pi-deck-shell-buffer-p buffer)
      (with-current-buffer buffer (setq pi-deck--shell-phase nil)))))

(with-eval-after-load 'ghostel
  (when (bound-and-true-p pi-deck-mode) (pi-deck--install-terminal-hooks)))

;;;; Updates

(defvar pi-deck--update-timer nil
  "Pending debounced `pi-deck-update-hook' run.")

(defun pi-deck--schedule-update ()
  "Run `pi-deck-update-hook' soon, coalescing bursts of changes."
  (unless pi-deck--update-timer
    (setq pi-deck--update-timer
          (run-with-timer 0.05 nil #'pi-deck--run-update))))

(defun pi-deck--run-update ()
  "Run `pi-deck-update-hook' now."
  (setq pi-deck--update-timer nil)
  (run-hooks 'pi-deck-update-hook)
  (force-mode-line-update t))

(defun pi-deck--derive (agent)
  "Return AGENT's current base state."
  (let ((buffer (pi-deck-agent-buffer agent)))
    (if (eq (pi-deck-agent-kind agent) 'pi)
        (pi-deck--pi-state buffer)
      (pi-deck--shell-state buffer))))

(defun pi-deck--apply (agent state)
  "Record base STATE for AGENT, running observers on change.
Leaving work (working, waiting or blocked to idle) while invisible makes
it done.  A shell whose command ends also updates views: one exiting at
its prompt stays idle, yet it is now finished."
  (let ((old (pi-deck-agent-state agent))
        (ended (pi-deck-agent-finished-shell-p agent)))
    (unless (eq old state)
      (setf (pi-deck-agent-state agent) state
            (pi-deck-agent-changed agent) (float-time))
      (when (and (eq state 'idle) (memq old '(working waiting blocked)))
        (setf (pi-deck-agent-seen agent) (pi-deck-agent-visible-p agent)))
      (run-hook-with-args 'pi-deck-agent-change-functions agent old state)
      (pi-deck--schedule-update))
    (unless (eq ended (pi-deck-agent-ended agent))
      (setf (pi-deck-agent-ended agent) ended)
      (pi-deck--schedule-update))))

(defun pi-deck--track (buffer kind)
  "Return the agent for BUFFER of KIND, creating it if necessary."
  (or (gethash buffer pi-deck--agents)
      (let ((agent (pi-deck-agent--make :buffer buffer :kind kind)))
        (puthash buffer agent pi-deck--agents)
        (setf (pi-deck-agent-state agent) (pi-deck--derive agent))
        (pi-deck--schedule-update)
        agent)))

(defun pi-deck-refresh-agent (buffer)
  "Refresh the state of the agent for BUFFER (chat or terminal)."
  (cond
   ((pi-deck-pi-buffer-p buffer)
    (when-let* ((input (pilish-session-input-buffer buffer)))
      (when (and (buffer-live-p input) (bound-and-true-p pi-deck-mode))
        (with-current-buffer input
          (add-hook 'after-change-functions #'pi-deck-schedule-save nil t))))
    (pi-deck--apply (pi-deck--track buffer 'pi) (pi-deck--pi-state buffer)))
   ((and pi-deck-include-shells (pi-deck-shell-buffer-p buffer))
    (pi-deck--apply (pi-deck--track buffer 'shell) (pi-deck--shell-state buffer)))))

(defun pi-deck--orchestration-links ()
  "Return (BUFFER ID PARENT-BUFFER PLACEMENT) lists for orchestration targets."
  (when (fboundp 'pi-orchestration-targets)
    (mapcar (lambda (target)
              (list (plist-get target :buffer) (plist-get target :id)
                    (plist-get target :parent) (plist-get target :placement)))
            (pi-orchestration-targets))))

(defun pi-deck-refresh ()
  "Reconcile all agents with live buffers and refresh their states."
  (interactive)
  (let ((links (pi-deck--orchestration-links)))
    (dolist (buffer (buffer-list))
      (pi-deck-refresh-agent buffer))
    (maphash (lambda (buffer agent)
               (if (or (not (buffer-live-p buffer))
                       (and (eq (pi-deck-agent-kind agent) 'shell)
                            (not pi-deck-include-shells)))
                   (progn (remhash buffer pi-deck--agents)
                          (pi-deck--schedule-update))
                 ;; A frontend can reconnect before its host re-registers the
                 ;; view. Absence from the local registry cannot promote a
                 ;; task-owned worker into an ordinary independently resumed root.
                 (when-let* ((link (assq buffer links)))
                   (pcase-let ((`(,id ,parent ,placement) (cdr link)))
                     (unless (and (equal id (pi-deck-agent-target agent))
                                  (eq parent (pi-deck-agent-parent agent))
                                  (equal placement (pi-deck-agent-placement agent)))
                       (setf (pi-deck-agent-target agent) id
                             (pi-deck-agent-parent agent) parent
                             (pi-deck-agent-placement agent) placement)
                       (pi-deck--schedule-update))))))
             pi-deck--agents)))

(defun pi-deck-mark-visible-seen (&rest _)
  "Mark agents shown in a visible frame as seen."
  (maphash (lambda (_buffer agent)
             (when (and (not (pi-deck-agent-seen agent))
                        (pi-deck-agent-visible-p agent))
               (setf (pi-deck-agent-seen agent) t)
               (pi-deck--schedule-update)))
           pi-deck--agents))

(defun pi-deck-mark-seen (agent)
  "Mark AGENT as seen."
  (unless (pi-deck-agent-seen agent)
    (setf (pi-deck-agent-seen agent) t)
    (pi-deck--schedule-update)))

(defun pi-deck--on-activity (chat-buffer _input _old _new _reason)
  "Refresh CHAT-BUFFER's agent after a Pilish activity phase change."
  (when (buffer-live-p chat-buffer)
    (pi-deck-refresh-agent chat-buffer)))

(defun pi-deck--on-dialog (chat-buffer _request _state)
  "Refresh CHAT-BUFFER's agent after an extension dialog opened or closed."
  (when (buffer-live-p chat-buffer)
    (pi-deck-refresh-agent chat-buffer)))

(defun pi-deck--on-extension-status (chat-buffer key _text)
  "Refresh CHAT-BUFFER's agent after a status KEY its state reads changed."
  (when (and (member key (list pi-deck--waiting-status-key pi-deck--orchestration-waiting-key))
             (buffer-live-p chat-buffer))
    (pi-deck-refresh-agent chat-buffer)))

(defun pi-deck--main-window (&optional frame)
  "Return FRAME's main-area window: the selected one unless it is a side window.
From a side window such as the sidebar, return the main view: the most
recently used Pilish chat and input pair, else the most recently used
window outside side windows (such as a terminal).  Side windows cannot be
split or hold panes."
  (let ((selected (frame-selected-window frame)))
    (if (not (window-parameter selected 'window-side))
        selected
      (let ((windows (sort (cl-remove-if (lambda (window) (window-parameter window 'window-side))
                                         (window-list frame 'no-mini))
                           :key #'window-use-time :reverse t)))
        (or (cl-find-if #'pilish-window-pair windows) (car windows) selected)))))

(defun pi-deck--select-ordinary-window ()
  "Select the main-area window when the selected one is a side window.
`delete-other-windows' and new tabs fail in side windows (the sidebar)."
  (when (window-parameter nil 'window-side)
    (select-window (pi-deck--main-window))))

(defun pi-deck--single-window ()
  "Reduce the layout to one plain window besides side windows and select it.
A Pilish chat and input pair becomes its chat window alone."
  (pi-deck--select-ordinary-window)
  (select-window (pilish-dissolve-window-pair (selected-window)))
  (delete-other-windows))

(defun pi-deck-summary (&optional agents)
  "Return an alist of (STATUS . COUNT) over AGENTS (default all), urgent first."
  (let ((agents (or agents (pi-deck-agents))))
    (cl-loop for status in pi-deck-statuses
             for count = (cl-count status agents :key #'pi-deck-agent-status)
             when (> count 0) collect (cons status count))))

(defun pi-deck-age (time)
  "Return a short description of how long ago TIME was."
  (let ((seconds (max 0 (- (float-time) time))))
    (cond ((< seconds 60) (format "%ds" seconds))
          ((< seconds 3600) (format "%dm" (/ seconds 60)))
          ((< seconds 86400) (format "%dh" (/ seconds 3600)))
          (t (format "%dd" (/ seconds 86400))))))

(provide 'pi-deck-core)
;;; pi-deck-core.el ends here
