;;; pi-deck-persist.el --- Save and restore spaces, layouts and sessions -*- lexical-binding: t; -*-

;; SPDX-License-Identifier: MIT

;;; Commentary:

;; The state file records registered spaces, each space's layout (a
;; writable window state), the current space, Pilish sessions with their
;; runtime identities and local drafts, stopped native terminal records and
;; closed workers. Pilish reconnects surviving runtimes or their service-recorded
;; root successors. Missing owners remain recoverable views; restore never launches Pi. Saved
;; input and shell commands never replay; workers retain their parent association.
;;
;; The file belongs to one Emacs server, recorded by its socket.  That
;; server restores it whenever it starts, however it stopped, and is the
;; only Emacs that saves it automatically.  Others (a plain `emacs', a
;; disposable test daemon) neither restore nor overwrite it.
;;
;; A new client frame shows the space selected last, with its last known
;; layout (see `pi-deck--layouts').

;;; Code:

(require 'pi-deck-core)
(require 'pi-deck-spaces)
(require 'pi-deck-sidebar)
(require 'pi-deck-runtime)

(declare-function pi-deck--client-frames "pi-deck-daemon" ())
(declare-function pi-deck-server-socket "pi-deck-daemon" ())
(declare-function pilish-session-desktop-state "pilish" (buffer))
(declare-function pilish-session-runtime "pilish" (buffer))
(declare-function pilish-restore-session-state "pilish" (state))
(declare-function pi-deck--forget-layout-buffers "pi-deck-close" (names))

(defcustom pi-deck-state-file (locate-user-emacs-file "var/pi-deck/state.eld")
  "File holding saved spaces, layouts and sessions."
  :type 'file
  :group 'pi-deck)

(defcustom pi-deck-auto-restore t
  "Whether the server owning the state file restores it when it starts.
Pilish reconnects surviving runtimes or service-recorded root successors.
Missing agents and native terminals remain recoverable views; saved input
and shell commands never replay. When nil, the saved state stays untouched
until the first save, which first moves it to a \".bak\" file."
  :type 'boolean
  :group 'pi-deck)

(defcustom pi-deck-restore-interval 0.15
  "Seconds between restoring desktop views; 0 restores all at once."
  :type 'number
  :group 'pi-deck)

(defcustom pi-deck-save-delay 2
  "Seconds after a change before the state is saved, or nil to save only on exit.
Changes are space edits, window layout changes, agents starting or
closing, and agents finishing a turn.  Nothing is saved periodically."
  :type '(choice (const nil) number)
  :group 'pi-deck)

(defvar pi-deck--state-owner nil
  "Server socket under which this Emacs owns `pi-deck-state-file', or nil.
Only the owner saves the state automatically.")

(defvar pi-deck--state-claimed nil
  "Non-nil once this Emacs decided whether it owns the state file.")

(defvar pi-deck--state-backup-pending nil
  "Non-nil while an owned but unrestored state file awaits its backup.")

(defvar pi-deck--restoring nil
  "Non-nil while a staggered desktop restore runs; its timer when waiting.")

(defvar pi-deck--restore-failures nil
  "Unrestored records retained verbatim until an explicit restore retries them.")

;;;; Serialization

(defun pi-deck--agent-record (agent tab-index)
  "Return the restorable record of AGENT, or nil.
TAB-INDEX caches `pi-deck-tab-index'."
  (let ((buffer (pi-deck-agent-buffer agent))
        (space (pi-deck-agent-space agent tab-index)))
    (append
     (list :kind (pi-deck-agent-kind agent) :buffer (buffer-name buffer)
           :dir (pi-deck-agent-directory agent) :space space
           :target (pi-deck-agent-target agent) :placement (pi-deck-agent-placement agent)
           :parent (when-let* ((parent (pi-deck-agent-parent agent))) (buffer-name parent)))
     (pcase (pi-deck-agent-kind agent)
       ('pi
        (list :name (pi-deck-agent-session-name agent)
              :session-file (pi-deck-agent-session-file agent)
              :input-buffer (when-let* ((input (pilish-session-input-buffer buffer)))
                              (buffer-name input))
              :desktop-state (pilish-session-desktop-state buffer)))
       ('shell
        (let ((saved (buffer-local-value 'pi-deck--stopped-shell buffer)))
          (list :command (if saved (plist-get saved :command)
                           (buffer-local-value 'pi-deck--shell-command buffer)))))))))

(defun pi-deck--finished-worker-records ()
  "Return the closed workers as saved: parents become buffer names."
  (mapcar (lambda (record)
            (plist-put (copy-sequence record) :parent
                       (buffer-name (plist-get record :parent))))
          pi-deck--finished-workers))

(defun pi-deck-state ()
  "Return the current deck state.
The layouts on screen are remembered first, the selected frame's last."
  (let ((frames (pi-deck--client-frames)))
    (dolist (frame (append (remq (selected-frame) frames)
                           (and (memq (selected-frame) frames) (list (selected-frame)))))
      (pi-deck--remember-current-layout frame))
    (list :version 3
          :owner (or pi-deck--state-owner (pi-deck-server-socket))
          :spaces pi-deck-spaces
          :space pi-deck--last-space
          :layouts pi-deck--layouts
          :agents (let ((tab-index (pi-deck-tab-index)))
                    (delq nil (mapcar (lambda (agent) (pi-deck--agent-record agent tab-index))
                                      (pi-deck-agents))))
          :unrestored (reverse (copy-tree pi-deck--restore-failures))
          :finished-workers (pi-deck--finished-worker-records))))

(defvar pi-deck--last-saved nil
  "Cons of the file and text last written by `pi-deck-save-state'.")

;;;###autoload
(defun pi-deck-save-state (&optional file)
  "Save spaces, layouts and sessions to FILE (default `pi-deck-state-file').
An unchanged state is not rewritten.  Saving the default file makes this
server its owner.  The first save over an owned state file that was not
restored keeps the old file as FILE.bak."
  (interactive)
  (when (member file (list nil pi-deck-state-file))
    (setq pi-deck--state-owner (or pi-deck--state-owner (pi-deck-server-socket))))
  (let* ((file (or file pi-deck-state-file))
         (state (pi-deck-state))
         (text (let ((print-length nil) (print-level nil) (print-circle nil))
                 (concat ";; pi-deck state -*- lisp-data -*-\n" (prin1-to-string state) "\n"))))
    (unless (and (equal pi-deck--last-saved (cons file text)) (file-exists-p file))
      (make-directory (file-name-directory file) t)
      (when (and pi-deck--state-backup-pending (equal file pi-deck-state-file))
        (setq pi-deck--state-backup-pending nil)
        (when (file-exists-p file) (rename-file file (concat file ".bak") t)))
      (let ((temporary (make-temp-file (concat file ".save-"))))
        (unwind-protect
            (progn
              (with-file-modes #o600 (write-region text nil temporary nil 'silent))
              (set-file-modes temporary #o600)
              (rename-file temporary file t))
          (when (file-exists-p temporary) (delete-file temporary))))
      (setq pi-deck--last-saved (cons file text)))
    (when (called-interactively-p 'any)
      (message "Saved %d spaces and %d sessions to %s"
               (length (plist-get state :spaces)) (length (plist-get state :agents))
               (abbreviate-file-name file)))
    state))

(defun pi-deck-read-state (&optional file)
  "Read the deck state from FILE (default `pi-deck-state-file'), or nil."
  (let ((file (or file pi-deck-state-file)))
    (when (file-readable-p file)
      (with-temp-buffer
        (insert-file-contents file)
        (read (current-buffer))))))

;;;; Saving after changes

(defvar pi-deck--save-timer nil
  "Pending state save after a change.")

(defun pi-deck-schedule-save (&rest _)
  "Save the state `pi-deck-save-delay' seconds after the first unsaved change.
Further changes before then join the same save, so one is never postponed
indefinitely by a stream of changes."
  (when (and pi-deck-save-delay (not pi-deck--save-timer))
    (setq pi-deck--save-timer (run-with-timer pi-deck-save-delay nil #'pi-deck--save-now))))

(defun pi-deck--save-now ()
  "Save the owned state, including an empty registry after its last deletion.
Nothing is saved during a restore: the file still lists what remains."
  (when pi-deck--save-timer
    (cancel-timer pi-deck--save-timer)
    (setq pi-deck--save-timer nil))
  (when (and pi-deck--state-owner (not pi-deck--restoring))
    (with-demoted-errors "pi-deck save: %S" (pi-deck-save-state))))

(defun pi-deck--save-on-agent-change (_agent _old new)
  "Schedule a save when an agent finishes a turn or exits (becomes NEW)."
  (when (memq new '(idle unknown))
    (pi-deck-schedule-save)))

(defvar pi-deck--saved-structure nil
  "Spaces, agent buffers and closed workers when a save was last scheduled.")

(defun pi-deck--save-on-structure-change ()
  "Schedule a save when spaces, the set of agents or closed workers changed."
  (let ((structure (list (copy-tree pi-deck-spaces)
                         (mapcar #'pi-deck-agent-buffer (pi-deck-agents))
                         pi-deck--finished-workers)))
    (unless (equal structure pi-deck--saved-structure)
      (setq pi-deck--saved-structure structure)
      (pi-deck-schedule-save))))

(defun pi-deck--on-session-identity (chat-buffer)
  "Save after CHAT-BUFFER adopts an authoritative runtime/session identity.
Runtime identity, not a stale saved filename, controls desktop reconnection."
  (when (buffer-live-p chat-buffer)
    (pi-deck-refresh-agent chat-buffer)
    (pi-deck--schedule-update)
    (pi-deck-schedule-save)))

;;;; Restoring

(defvar pi-deck--restored-buffers nil
  "Saved buffer-name to restored buffer-name mapping for this desktop restore.")
(defvar pi-deck--restored-links nil
  "Restored agent/record pairs whose stable parent links await all views.")

(defun pi-deck--remap-layout-buffers (mapping)
  "Apply saved-to-current buffer name MAPPING to remembered window states."
  (cl-labels ((walk (tree)
                (if (not (consp tree)) tree
                  (if (and (eq (car tree) 'buffer) (stringp (cadr tree)))
                      (cons 'buffer (cons (or (cdr (assoc (cadr tree) mapping)) (cadr tree))
                                          (mapcar #'walk (cddr tree))))
                    (cons (walk (car tree)) (walk (cdr tree)))))))
    (setq pi-deck--layouts
          (mapcar (lambda (layout) (cons (car layout) (walk (cdr layout))))
                  pi-deck--layouts))))

(defun pi-deck--restore-agent (record)
  "Restore RECORD through Pilish's desktop policy or as a stopped shell view."
  (condition-case err
      (let* ((desktop (plist-get record :desktop-state))
             (existing (and (eq (plist-get record :kind) 'pi)
                            (pi-deck--runtime-agent (plist-get desktop :runtime))))
             (buffer (and (not existing) (get-buffer (plist-get record :buffer))))
             (same-view
              (and buffer (pi-deck-agent buffer) (eq (plist-get record :kind) 'shell)
                   (eq (buffer-local-value 'major-mode buffer) 'pi-deck-stopped-shell-mode)))
             (agent
              (or existing
                  (and same-view (pi-deck-agent buffer))
                  (pcase (plist-get record :kind)
                    ('pi (when-let* ((chat (pilish-restore-session-state desktop)))
                           (pi-deck--track chat 'pi)))
                    ('shell (pi-deck--track (pi-deck--restore-shell-view record) 'shell))
                    (_ (error "Unknown saved agent kind %S" (plist-get record :kind)))))))
        (when agent
          (setf (pi-deck-agent-assigned-space agent) (plist-get record :space)
                (pi-deck-agent-target agent) (or (pi-deck-agent-target agent) (plist-get record :target))
                (pi-deck-agent-placement agent) (or (pi-deck-agent-placement agent) (plist-get record :placement)))
          (let ((chat (pi-deck-agent-buffer agent)))
            (push (cons (plist-get record :buffer) (buffer-name chat)) pi-deck--restored-buffers)
            (when-let* ((old (plist-get record :input-buffer))
                        (input (and (eq (pi-deck-agent-kind agent) 'pi)
                                    (pilish-session-input-buffer chat))))
              (push (cons old (buffer-name input)) pi-deck--restored-buffers)))
          (push (cons agent record) pi-deck--restored-links))
        ;; Pilish returns nil only after authoritative retained terminal
        ;; evidence. Do not retain or resurrect that active desktop view.
        (unless agent
          (pi-deck--forget-layout-buffers
           (delq nil (list (plist-get record :buffer) (plist-get record :input-buffer)))))
        agent)
    (error (push (copy-tree record) pi-deck--restore-failures)
           (message "pi-deck: view %s retained for explicit restore retry: %s"
                    (plist-get record :buffer) (error-message-string err))
           nil)))

;;;###autoload
(defun pi-deck-restore-state (&optional file)
  "Restore spaces, sessions and layouts saved in FILE.
FILE defaults to `pi-deck-state-file'.
Views restore `pi-deck-restore-interval' seconds apart. Pilish reconnects
surviving owners or service-recorded root successors. Missing owners and native
terminals remain recoverable views. No saved input or shell
command is replayed.
Frames then show their saved layouts."
  (interactive)
  (when pi-deck--restoring
    (user-error "A pi-deck restore is still running"))
  (let ((state (or (pi-deck-read-state file)
                   (user-error "No saved pi-deck state"))))
    (unless (equal (plist-get state :version) 3)
      (user-error "Desktop schema %S is not supported"
                  (plist-get state :version)))
    (setq pi-deck--restored-buffers nil pi-deck--restored-links nil
          pi-deck--restore-failures nil)
    (dolist (space (plist-get state :spaces))
      (unless (pi-deck-space (plist-get space :name))
        (pi-deck--register-space (plist-get space :name) (plist-get space :dir))))
    (dolist (layout (plist-get state :layouts))
      (unless (assoc (car layout) pi-deck--layouts)
        (pi-deck--remember-layout (car layout) (cdr layout))))
    (when (pi-deck-space (plist-get state :space))
      (setq pi-deck--last-space (plist-get state :space)))
    (setq pi-deck--restoring t)
    (pi-deck--restore-next (append (plist-get state :agents) (plist-get state :unrestored))
                          (length (plist-get state :spaces)) 0
                          (plist-get state :finished-workers))))

(defun pi-deck--restore-finished-workers (records)
  "Remember the saved closed workers RECORDS under their restored parents.
Records without a tracked parent or a readable session file are dropped,
and so are those already remembered."
  (let ((known (mapcar (lambda (record) (plist-get record :session-file))
                       pi-deck--finished-workers))
        restored)
    (dolist (record records)
      (let ((name (or (cdr (assoc (plist-get record :parent) pi-deck--restored-buffers))
                      (plist-get record :parent)))
            (file (plist-get record :session-file)))
        (when-let* ((parent (and name (get-buffer name))))
          (when (and (pi-deck-agent parent) (file-readable-p file) (not (member file known)))
            (push (plist-put (copy-sequence record) :parent parent) restored)))))
    (setq pi-deck--finished-workers
          (append pi-deck--finished-workers (nreverse restored)))))

(defun pi-deck--restore-next (records spaces restored workers)
  "Restore RECORDS one by one; report SPACES and RESTORED sessions.
After each started record, the rest wait `pi-deck-restore-interval'.
Afterwards the closed WORKERS return under their parents and client frames
showing no space show the current one."
  (setq pi-deck--restoring t)
  (while (and records (eq pi-deck--restoring t))
    (when (pi-deck--restore-agent (pop records))
      (cl-incf restored)
      (when (and records (> pi-deck-restore-interval 0))
        (setq pi-deck--restoring
              (run-with-timer pi-deck-restore-interval nil #'pi-deck--restore-next
                              records spaces restored workers)))))
  (unless (timerp pi-deck--restoring)
    (setq pi-deck--restoring nil)
    (dolist (link pi-deck--restored-links)
      (let* ((name (plist-get (cdr link) :parent))
             (current (or (cdr (assoc name pi-deck--restored-buffers)) name)))
        (setf (pi-deck-agent-parent (car link)) (and current (get-buffer current)))))
    (pi-deck--restore-finished-workers workers)
    (pi-deck--remap-layout-buffers pi-deck--restored-buffers)
    (setq pi-deck--restored-links nil pi-deck--restored-buffers nil)
    ;; Layouts name the restored buffers: show them only now.
    (mapc #'pi-deck--open-last-space (pi-deck--client-frames))
    (pi-deck--schedule-update)
    (pi-deck-schedule-save)
    (message "pi-deck: restored %d spaces and %d sessions" spaces restored)))

(defun pi-deck-cancel-restore ()
  "Stop a running staggered restore; the state file keeps the rest."
  (when (timerp pi-deck--restoring) (cancel-timer pi-deck--restoring))
  (setq pi-deck--restoring nil))

(defun pi-deck-claim-state ()
  "Decide once whether this Emacs owns the state file, and restore it if so.
Only a running server can own it: the one whose socket the file records,
or any server when there is no file.  The owner restores the file when
`pi-deck-auto-restore' is non-nil.  `pi-deck-save-state' takes over a file
another server owns."
  (unless pi-deck--state-claimed
    (setq pi-deck--state-claimed t)
    (when-let* ((socket (pi-deck-server-socket)))
      (let* ((state (condition-case nil (pi-deck-read-state) (error 'unreadable)))
             (owner (and (consp state) (plist-get state :owner))))
        (cond
         ((null state) (setq pi-deck--state-owner socket))
         ((eq state 'unreadable)
          (setq pi-deck--state-owner socket
                pi-deck--state-backup-pending t)
          (message "pi-deck: cannot read %s; it is kept as .bak at the first save"
                   (abbreviate-file-name pi-deck-state-file)))
         ((equal owner socket)
          (setq pi-deck--state-owner socket)
          (if pi-deck-auto-restore
              (pi-deck-restore-state)
            (setq pi-deck--state-backup-pending t)))
         (t (message "pi-deck: %s belongs to %s; not restoring or saving it"
                     (abbreviate-file-name pi-deck-state-file)
                     (or owner "no server"))))))))

;;;; Frames

(defvar pi-deck--pending-reveal nil
  "Chat buffer the next client frame shows, opened while no frame existed.")

(defun pi-deck--recent-client-frame ()
  "Return the most recently used client frame, or nil."
  (car (sort (cl-remove-if #'frame-parent (pi-deck--client-frames))
             :key (lambda (frame) (window-use-time (get-mru-window frame t)))
             :reverse t)))

(defun pi-deck--open-last-space (frame)
  "Show the space selected last in FRAME when FRAME shows no space."
  (with-selected-frame frame
    (when (and (null (pi-deck-current-space)) (pi-deck-space pi-deck--last-space))
      (pi-deck-select-space pi-deck--last-space))
    (pi-deck--sidebar-sync)))

;;;###autoload
(defun pi-deck-show-session (chat)
  "Show the Pi session CHAT in the space for its directory; return its agent.
That is the closest space containing the directory, created when missing.
The most recently used client frame shows the session in that space and
gets focus; without a client frame, the next one shows it.  While
`pi-deck-mode' is on, this is `pi-orchestration-show-session-function',
used by `/switch emacs'."
  (let* ((agent (pi-deck--track chat 'pi))
         (dir (pi-deck-agent-directory agent)))
    (setf (pi-deck-agent-assigned-space agent)
          (or (pi-deck--space-for-dir dir)
              (let ((name (pi-deck--unique-space-name
                           (file-name-nondirectory (directory-file-name dir)))))
                (pi-deck--register-space name dir)
                name)))
    (if-let* ((frame (pi-deck--recent-client-frame)))
        (progn
          (select-frame-set-input-focus frame)
          (pi-deck-reveal agent))
      (setq pi-deck--pending-reveal chat))
    (pi-deck--schedule-update)
    agent))

(defun pi-deck-setup-frame (&optional frame)
  "Show the space selected last in the new client FRAME.
During a restore, the restore shows it once all sessions exist."
  (let ((frame (or frame (selected-frame))))
    (when (memq frame (pi-deck--client-frames))
      (unless pi-deck--restoring
        (pi-deck--open-last-space frame))
      (with-selected-frame frame
        (pi-deck--sidebar-sync)
        (when-let* ((chat (prog1 pi-deck--pending-reveal (setq pi-deck--pending-reveal nil)))
                    (agent (pi-deck-agent chat)))
          (pi-deck-reveal agent))))))

(defun pi-deck-remember-frame (frame)
  "Remember the layout closing FRAME shows for its space."
  (when (memq frame (pi-deck--client-frames))
    (pi-deck--remember-current-layout frame)))

(provide 'pi-deck-persist)
;;; pi-deck-persist.el ends here
