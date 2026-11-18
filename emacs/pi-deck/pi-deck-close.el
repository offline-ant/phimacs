;;; pi-deck-close.el --- Closing agents and hiding panes -*- lexical-binding: t; -*-

;; SPDX-License-Identifier: MIT

;;; Commentary:

;; Close stops an agent through its owner, without confirmation or waiting:
;; its panes and sidebar entry disappear at once while the stop runs.  Its
;; buffers are disposed only after acknowledgement; a failed or uncertain stop
;; lists the agent again.  Hide changes layout only.  Closing a space closes
;; its agents and owned descendants before forgetting its layouts.

;;; Code:

(require 'tab-bar)
(require 'pi-deck-core)
(require 'pi-deck-spaces)
(require 'pi-deck-runtime)

(declare-function pi-deck--client-frames "pi-deck-daemon" ())
(declare-function pi-orchestration-stop-target "pi-orchestration" (id &optional callback))
(declare-function pilish-stop-runtime "pilish" (buffer &optional callback))
(declare-function pilish-close-session "pilish" (buffer &optional callback))
(declare-function pilish-disconnect-session "pilish" (buffer))
(declare-function pi-deck--remember-worker "pi-deck-workers" (agent))
(declare-function pi-deck--target "pi-deck-workers" (id))
(declare-function pi-deck-clear-finished-workers "pi-deck-workers" (parent))
(declare-function pi-deck-schedule-save "pi-deck-persist" (&rest ignored))

(defvar pi-deck--pending-reveal)

;;;; Views

(defun pi-deck--shown-by-p (agent buffers)
  "Return non-nil when one of BUFFERS shows AGENT."
  (cl-some (lambda (buffer) (memq buffer buffers)) (pi-deck-agent-windows-buffers agent)))

(defun pi-deck--agents-shown-by (buffers)
  "Return the agents shown by BUFFERS."
  (cl-remove-if-not (lambda (agent) (pi-deck--shown-by-p agent buffers)) (pi-deck-agents)))

(defun pi-deck--hide-window-pane (window)
  "Remove WINDOW's pane from its layout.
The layout's only pane shows the space's directory instead.  When the pane
held the frame's selected window, focus moves to the input of the pane Emacs
selects instead, never to a chat window or a side window."
  (let* ((pane (pi-deck--pane-of window))
         (frame (window-frame window))
         (selected (frame-selected-window frame)))
    (if (eq pane (window-main-window frame))
        (with-selected-window (pilish-dissolve-window-pair window)
          (delete-other-windows)
          (switch-to-buffer (pi-deck--space-start-buffer
                             (pi-deck-current-space frame))
                            t t))
      (delete-window pane))
    (unless (window-live-p selected)
      (with-selected-frame frame (pi-deck--select-pane-input)))))

(defun pi-deck--remove-views-here (buffers)
  "Remove the panes showing BUFFERS from the selected frame's layout."
  (dolist (window (window-list nil 'no-minibuf))
    (when (and (window-live-p window)
               (memq (window-buffer window) buffers)
               (not (window-parameter window 'window-side)))
      (pi-deck--hide-window-pane window))))

(defun pi-deck--remove-views (buffers)
  "Remove the panes showing BUFFERS from every layout of every client frame.
Layouts of spaces not on screen are shown briefly to change them."
  (dolist (frame (pi-deck--client-frames))
    (with-selected-frame frame
      (pi-deck--remove-views-here buffers)
      (let ((current (1+ (tab-bar--current-tab-index))) (number 0))
        (dolist (tab (pi-deck--tabs))
          (cl-incf number)
          (when (and (not (eq (car tab) 'current-tab))
                     (cl-some (lambda (buffer) (memq buffer buffers))
                              (pi-deck--tab-buffers tab frame)))
            (pi-deck--select-tab number)
            (pi-deck--remove-views-here buffers)
            (pi-deck--select-tab current))))))
  ;; Remembered layouts of spaces no frame shows keep the buffers too.
  (pi-deck--forget-layout-buffers (delq nil (mapcar #'buffer-name buffers))))

(defun pi-deck--forget-layout-buffers (names)
  "Forget remembered layouts retaining any of the closed buffer NAMES."
  (setq pi-deck--layouts
        (cl-remove-if (lambda (cell)
                        (seq-intersection names (ignore-errors (window-state-buffers (cdr cell)))))
                      pi-deck--layouts)))

(defun pi-deck-hide-pane (&optional window)
  "Hide WINDOW's pane (default the selected pane); its agent keeps running.
A chat hides with its input.  The layout's only pane shows the space's
directory instead."
  (interactive)
  (pi-deck--hide-window-pane (or window (pi-deck--pane-window))))

(defun pi-deck--remove-agent-view (agent)
  "Remove acknowledged terminal AGENT's local UI once, without another stop.
Pilish owns buffer disposal; this also runs before remote terminal disposal."
  (let ((buffer (pi-deck-agent-buffer agent)))
    (when (eq agent (pi-deck-agent buffer))
      (pi-deck--remove-views (pi-deck-agent-windows-buffers agent))
      (when (and (pi-deck-agent-worker-p agent) (eq (pi-deck-agent-kind agent) 'pi))
        (pi-deck--remember-worker agent))
      (remhash buffer pi-deck--agents)
      (pi-deck-clear-finished-workers buffer)
      (when (eq pi-deck--pending-reveal buffer) (setq pi-deck--pending-reveal nil))
      (pi-deck--schedule-update)
      (pi-deck-schedule-save))))

(defun pi-deck--on-session-terminated (buffer)
  "Remove BUFFER's active views after authoritative Pilish termination.
Socket loss and stopped views without a runtime identity are not
terminal evidence."
  (when-let* ((agent (and (buffer-live-p buffer) (pi-deck-agent buffer))))
    (pi-deck--remove-agent-view agent)))

;;;; Closing

(defun pi-deck--hide-closing (agents)
  "Hide AGENTS while their Close runs: remove their panes and unlist them."
  (pi-deck--remove-views (apply #'append (mapcar #'pi-deck-agent-windows-buffers agents)))
  (dolist (agent agents) (setf (pi-deck-agent-closing agent) t))
  (pi-deck--schedule-update))

(defun pi-deck--unhide-failed (agents)
  "List AGENTS again after their Close failed or became uncertain."
  (dolist (agent agents) (setf (pi-deck-agent-closing agent) nil))
  (pi-deck--schedule-update)
  (pi-deck-schedule-save))

(defun pi-deck--runtime-owns-close-p (agent)
  "Return non-nil when Pi AGENT's runtime, not an unregistered target, owns Close.
A frontend restart forgets orchestration targets; roots and interactive forks
keep their identity-bound runtime, and identity-free views have none to stop.
Registered targets always close through orchestration."
  (let ((runtime (pi-deck-agent-runtime agent)))
    (and runtime
         (not (pi-deck--target (pi-deck-agent-target agent)))
         (or (not (plist-get runtime :mux-id))
             (member (plist-get runtime :placement) '("root" "interactive-fork"))))))

(defun pi-deck-stop-agent (agent &optional callback)
  "Close AGENT without asking or waiting; dispose it after acknowledgement.
AGENT is hidden at once; a failed or uncertain stop lists it again, without
its panes, unless the owner already removed its view while reporting an
earlier failure.  CALLBACK receives nil on success or an error string.  Pilish
owns Pi worker task cancellation and completion evidence, including
disconnected/restored views without a local target.  Native panels and
registered targets use orchestration cancellation; other Pi views use their
identity-bound runtime stop, or Pilish Close when identity-free.  No path
may promote a worker into a root stop."
  (let* ((buffer (pi-deck-agent-buffer agent))
         (name (and (buffer-live-p buffer) (pi-deck-agent-name agent)))
         done)
    (cl-labels
        ((finish (error)
           (unless done
             (setq done t)
             (unless error
               (condition-case failure
                   (progn
                     (when (buffer-live-p buffer)
                       (pi-deck--remove-agent-view agent)
                       (if (eq (pi-deck-agent-kind agent) 'pi)
                           (pilish-disconnect-session buffer)
                         (let ((kill-buffer-query-functions nil)) (kill-buffer buffer)))))
                 (error (setq error (error-message-string failure)))))
             (when error
               (if (and (buffer-live-p buffer) (eq (gethash buffer pi-deck--agents) agent))
                   (progn
                     (pi-deck--unhide-failed (list agent))
                     (message "pi-deck: close/view cleanup not confirmed: %s" error))
                 ;; The owner retired the view and reports a retained earlier
                 ;; failure, such as failed worker cleanup proven ended.
                 (message "pi-deck: closed %s; its cleanup had failed: %s" name error)))
             (when callback (funcall callback error)))))
      (condition-case error
          (progn
            (when (buffer-live-p buffer) (pi-deck--hide-closing (list agent)))
            (cond
             ((not (buffer-live-p buffer)) (finish nil))
             ;; Restoration creates inert terminal placeholders, not host-owned
             ;; panels.  Their retained target ID cannot cancel a new live owner.
             ((eq (buffer-local-value 'major-mode buffer) 'pi-deck-stopped-shell-mode)
              (finish nil))
             ((and (eq (pi-deck-agent-kind agent) 'pi)
                   (or (pi-deck-agent-worker-p agent)
                       (equal (pi-deck-agent-placement agent) "worker")
                       (equal (plist-get (pi-deck-agent-runtime agent) :placement) "worker")))
              ;; Saved deck links can outlive the local host registry. Pilish
              ;; validates durable task evidence before requiring a transport;
              ;; a stopped runtime receipt alone never proves task completion.
              (let* ((runtime (pi-deck-agent-runtime agent))
                     (id (plist-get runtime :mux-id)))
                (unless (and (equal (plist-get runtime :placement) "worker")
                             (stringp id) (not (string-empty-p id)))
                  (user-error "The worker's owning runtime identity is unavailable")))
              (pilish-close-session buffer #'finish))
             ((and (or (pi-deck-agent-target agent)
                       (equal (pi-deck-agent-placement agent) "worker"))
                   (not (pi-deck--runtime-owns-close-p agent)))
              (unless (and (pi-deck-agent-target agent)
                           (fboundp 'pi-orchestration-stop-target))
                (user-error "The parent task's cancellation control is unavailable"))
              ;; Dispatch is not an exit acknowledgement.  The owning API calls
              ;; finish only after terminal evidence or a failure/uncertainty.
              (pi-orchestration-stop-target (pi-deck-agent-target agent) #'finish))
             ((plist-get (pi-deck-agent-runtime agent) :mux-id)
              (pilish-stop-runtime buffer #'finish))
             ((pi-deck-agent-runtime agent)
              ;; Nothing to stop: Pilish retires an identity-free stopped view
              ;; with its unsent work and refuses any other identity-free state.
              (pilish-close-session buffer #'finish))
             (t
              (when-let* ((process (pi-deck-agent-process agent)))
                (set-process-query-on-exit-flag process nil))
              (finish nil))))
        (error (finish (error-message-string error)))))))

(defun pi-deck-stop-agents (agents &optional callback)
  "Hide AGENTS at once, then close them sequentially.
A failed or uncertain stop lists the remaining agents again.  CALLBACK
receives nil only when all closures were acknowledged, else an error."
  (when agents (pi-deck--hide-closing agents))
  (cl-labels ((next (remaining)
                (if (null remaining)
                    (when callback (funcall callback nil))
                  (pi-deck-stop-agent
                   (car remaining)
                   (lambda (error)
                     (if (not error) (next (cdr remaining))
                       (pi-deck--unhide-failed (cdr remaining))
                       (when callback (funcall callback error))))))))
    (next agents)))

(defun pi-deck--with-descendants (agents)
  "Return AGENTS and their owned workers/panels, children before parents.
Closing children first preserves their parent's cancellation control until
it is no longer needed. Independent interactive forks are not owned children."
  (let (result)
    (dolist (agent agents)
      (dolist (child (reverse (pi-deck-agent-descendants agent)))
        (unless (memq child result) (setq result (append result (list child)))))
      (unless (memq agent result) (setq result (append result (list agent)))))
    result))

(defun pi-deck-close-agent (&optional agent)
  "Close AGENT and its owned workers/panels everywhere, without confirmation.
AGENT defaults to the selected pane's agent."
  (interactive)
  (pi-deck-stop-agents (pi-deck--with-descendants (list (pi-deck--action-agent agent)))))

;;;; Spaces

(defun pi-deck--drop-space-tab (space frame)
  "Remove SPACE's layout tab from FRAME.
A frame showing SPACE shows its most recent other space instead, else
nothing: its tab leaves the space and shows *scratch*."
  (with-selected-frame frame
    (when-let* ((number (pi-deck--space-tab-number space)))
      (if (and (equal (pi-deck-current-space) space)
               (null (cdr (pi-deck--tabs))))
          (progn
            (pi-deck--set-tab-group nil)
            (pi-deck--single-window)
            (switch-to-buffer (get-scratch-buffer-create) t t))
        (let ((tab-bar-tab-prevent-close-functions nil)
              (tab-bar-close-tab-select 'recent))
          (tab-bar-close-tab number))))))

(defun pi-deck--forget-space (space)
  "Forget SPACE and its local layouts after its agents have closed."
  (dolist (frame (pi-deck--client-frames)) (pi-deck--drop-space-tab space frame))
  (setq pi-deck-spaces
        (cl-remove space pi-deck-spaces :key (lambda (s) (plist-get s :name)) :test #'equal)
        pi-deck--layouts (assoc-delete-all space pi-deck--layouts))
  (when (equal pi-deck--last-space space)
    (setq pi-deck--last-space (pi-deck-current-space)))
  (pi-deck--schedule-update)
  (pi-deck-schedule-save))

(defun pi-deck-close-space (space)
  "Close SPACE's agents and owned descendants, then forget its layouts.
No confirmation is requested. Failed or uncertain closure retains the space."
  (interactive (list (pi-deck--read-space "Close space: ")))
  (pi-deck-stop-agents
   ;; Agents already being closed hold the space until their stop settles.
   (pi-deck--with-descendants (pi-deck--space-agents space t))
   (lambda (error) (unless error (pi-deck--forget-space space)))))

(provide 'pi-deck-close)
;;; pi-deck-close.el ends here
