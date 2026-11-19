;;; pi-orchestration.el --- Native Pilish and ghostel host operations -*- lexical-binding: t; -*-

;; SPDX-License-Identifier: MIT

;; Author: offline-ant
;; Version: 0.1.0
;; Package-Requires: ((emacs "30.1") (pilish "3.4.2") (ghostel "0.59.0"))
;; Keywords: tools, processes
;; URL: https://github.com/offline-ant/phimacs

;;; Commentary:

;; Fixed, short operations invoked by emacsclient. Pi owns worker scheduling
;; and completion; detached pimux owns Pi lifetime. This library owns socket
;; views and host-native shell targets, never a Pi inferred from a socket PID.
;; Arguments and results are base64-encoded UTF-8 JSON, never executable Lisp.

;;; Code:

(require 'cl-lib)
(require 'json)
(require 'pilish)
(require 'pilish-runtime)
(require 'ghostel)
(require 'server)

(declare-function pilish-session-runtime "pilish-runtime" (buffer))
(declare-function pilish-list-runtimes "pilish-runtime" ())
(declare-function pilish-attach-runtime "pilish-runtime" (runtime &optional name))
(defvar pilish-history-hidden-before)
(declare-function pilish-stop-runtime "pilish-runtime" (buffer &optional callback))
(declare-function pilish-disconnect-session "pilish" (buffer))
(declare-function pilish-close-session "pilish" (buffer &optional callback))
(declare-function pilish-reconcile-worker-task "pilish-runtime-task" (buffer runtime))

(defun pi-orchestration--runtime (receipt identity directory)
  "Normalize a committed launcher RECEIPT and Pi IDENTITY for DIRECTORY."
  (unless (and (= (or (plist-get receipt :protocol) 0) 2)
               (equal (plist-get receipt :state) "committed")
               (stringp (plist-get receipt :muxId))
               (stringp (plist-get receipt :socket))
               (equal (plist-get receipt :piPid) (plist-get identity :pid))
               (stringp (plist-get identity :startTime))
               (stringp (plist-get identity :bootId)))
    (error "A committed protocol-2 runtime and actual Pi identity are required"))
  (list :protocol 2 :mux-id (plist-get receipt :muxId)
        :socket (plist-get receipt :socket) :pid (plist-get receipt :pid)
        :pi-pid (plist-get identity :pid)
        :pi-start-time (plist-get identity :startTime)
        :pi-boot-id (plist-get identity :bootId)
        :session-file (plist-get receipt :sessionFile)
        :directory directory :cwd directory :state "starting"))

(defun pi-orchestration--view-ready-p (buffer mux-id)
  "Whether BUFFER has reached protocol-2 live state for MUX-ID.
The public runtime state becomes live only after pimux_live."
  (when (buffer-live-p buffer)
    (let ((runtime (pilish-session-runtime buffer)))
      (and (equal (plist-get runtime :protocol) 2)
           (equal (plist-get runtime :mux-id) mux-id)
           (equal (plist-get runtime :state) "live")))))

;; Ghostel exposes no public accessors for these; they are the terminal's own
;; child process ID and its full plain-text contents (scrollback and the
;; active screen), which are also current for buffers never displayed.
(defvar ghostel--pid)
(defvar ghostel--term)
(declare-function ghostel--copy-all-text "ghostel-module" (term))

(defvar pi-orchestration--roots (make-hash-table :test 'equal :weakness 'value)
  "Chat buffers of root sessions by target ID.")

(defun pi-orchestration--root-id (chat-buffer)
  "Return the stable target ID of CHAT-BUFFER.
It is the buffer's first name, readable in other frontends, kept when
the session moves and renames the buffer.  A chat that took over the name
of one that moved gets a numbered ID."
  (or (cl-loop for id being the hash-keys of pi-orchestration--roots
               using (hash-values buffer)
               when (eq buffer chat-buffer) return id)
      (let* ((name (buffer-name chat-buffer))
             (id name)
             (number 1))
        (while (buffer-live-p (gethash id pi-orchestration--roots))
          (setq id (format "%s<%d>" name (cl-incf number))))
        (puthash id chat-buffer pi-orchestration--roots)
        id)))

(defun pi-orchestration--session-environment (chat-buffer directory)
  "Return local host identity for CHAT-BUFFER in DIRECTORY before Pi spawns.
Remote sessions cannot use the shared local filesystem or Emacs server."
  (when (and (not (file-remote-p directory))
             (bound-and-true-p server-process)
             (process-live-p server-process))
    (list (cons "PI_ORCHESTRATION_HOST" "emacs")
          (cons "PI_ORCHESTRATION_ENDPOINT"
                (expand-file-name server-name server-socket-dir))
          (cons "PI_ORCHESTRATION_TARGET" (pi-orchestration--root-id chat-buffer)))))

(add-hook 'pilish-session-environment-functions
          #'pi-orchestration--session-environment)

;;;###autoload
(defun pi-orchestration-fork-here ()
  "Open an independent fork without touching this session's input draft."
  (interactive)
  (let ((chat (pilish-session-chat-buffer)))
    (unless (buffer-live-p chat)
      (user-error "No Pi session in this buffer"))
    (pilish-submit-prompt
     chat "/fork-here"
     (lambda (response)
       (unless (eq (plist-get response :success) t)
         (message "Pi: Fork failed: %s" (plist-get response :error)))))))

(define-key pilish-chat-mode-map (kbd "C-M-f") #'pi-orchestration-fork-here)
(define-key pilish-input-mode-map (kbd "C-M-f") #'pi-orchestration-fork-here)

(defvar pi-orchestration--targets (make-hash-table :test 'equal)
  "Native targets created by this adapter, indexed by opaque target ID.")

(defvar pi-orchestration-target-functions nil
  "Functions called with a target ID and `start' or `close' after either.
User interfaces use this to refresh their view of `pi-orchestration-targets'.")

(defun pi-orchestration--run-target-functions (id event)
  "Report target ID's lifecycle EVENT without letting observers break it."
  (dolist (function pi-orchestration-target-functions)
    (with-demoted-errors "pi-orchestration observer: %S"
      (funcall function id event))))

(defun pi-orchestration-parent-buffer (parent)
  "Return the live native buffer of PARENT, a target ID, or nil."
  (when parent
    (let ((target-view (plist-get (gethash parent pi-orchestration--targets) :buffer))
          (root-view (gethash parent pi-orchestration--roots)))
      (cond ((buffer-live-p target-view) target-view)
            ((buffer-live-p root-view) root-view)))))

(defun pi-orchestration--attach-discovered-parent (parent endpoint)
  "Register PARENT's exact live runtime as a background view on ENDPOINT.
A browser-only parent has no native buffer until a child needs one.
Keep the child independent of view discovery or attachment failure."
  (let ((id (plist-get parent :id)))
    (when (and (stringp id) (not (string-empty-p id))
               (equal (plist-get parent :host) "emacs")
               (stringp endpoint) (file-name-absolute-p endpoint)
               (equal (plist-get parent :endpoint) endpoint)
               (not (pi-orchestration-parent-buffer id)))
      (with-demoted-errors "pi-orchestration parent view: %S"
        (let ((matches (cl-loop for runtime in (pilish-list-runtimes)
                                for ref = (plist-get runtime :orchestration)
                                when (and (equal (plist-get runtime :protocol) 2)
                                          (equal (plist-get ref :host) "emacs")
                                          (equal (plist-get ref :endpoint) endpoint)
                                          (equal (plist-get ref :id) id))
                                collect runtime)))
          (when (= (length matches) 1)
            ;; The public attach path rechecks identity and reuses a matching view.
            (puthash id (pilish-attach-runtime (car matches)) pi-orchestration--roots)))))))

(defun pi-orchestration-panel-command-state (buffer)
  "Return BUFFER's managed command state, independent of wrapper lifetime.
Return \"held\", \"running\", \"exited\" or \"unknown\" for a managed panel;
return nil for an unmanaged buffer. Unknown evidence never means completion."
  (when-let* ((target (cl-loop for target being the hash-values of pi-orchestration--targets
                              when (and (equal (plist-get target :kind) "shell")
                                        (eq (plist-get target :buffer) buffer)
                                        (plist-get target :panel)) return target))
              (panel (plist-get target :panel)))
    (condition-case nil
        (let* ((directory (plist-get panel :directory))
               (file (expand-file-name "state.json" directory))
               (attributes (file-attributes file 'integer)))
          (unless (and (file-name-absolute-p directory)
                       (not (file-remote-p directory))
                       (equal (directory-file-name directory)
                              (directory-file-name (file-truename directory)))
                       (eq (file-modes directory) #o700)
                       (not (file-symlink-p file)) (file-regular-p file)
                       (eq (file-modes file) #o600)
                       (equal (file-attribute-user-id attributes) (user-uid))
                       (<= (file-attribute-size attributes) 65536))
            (error "Unsafe managed panel state"))
          (let ((state (with-temp-buffer
                         (insert-file-contents file)
                         (json-parse-buffer :object-type 'plist))))
            (unless (and (equal (plist-get state :schema) 1)
                         (equal (plist-get state :id) (plist-get panel :id))
                         (member (plist-get state :command) '("held" "running" "exited")))
              (error "Managed panel state identity changed"))
            (plist-get state :command)))
      (error "unknown"))))

(defun pi-orchestration-targets ()
  "Return native targets as plists.
Keys: :id, :kind, :name, :placement, :buffer, :parent, :mux-id and :runtime.
:runtime is public normalized identity, retained when its view disconnects.
:placement is the start spec's placement (\"worker\" or \"interactive-fork\"),
:parent the parent's live native buffer, or nil when unknown or gone."
  (let (targets)
    (maphash (lambda (id target)
               (push (list :id id :kind (plist-get target :kind)
                           :name (plist-get target :name)
                           :placement (plist-get target :placement)
                           :buffer (plist-get target :buffer)
                           :command-state (pi-orchestration-panel-command-state (plist-get target :buffer))
                           :mux-id (plist-get target :mux-id)
                           :runtime (if (and (plist-get target :mux-id)
                                             (buffer-live-p (plist-get target :buffer)))
                                        (pilish-session-runtime (plist-get target :buffer))
                                      (plist-get target :runtime))
                           :parent (pi-orchestration-parent-buffer
                                    (plist-get target :parent)))
                     targets))
             pi-orchestration--targets)
    targets))

(defun pi-orchestration--restart-refusal (chat-buffer)
  "Return why CHAT-BUFFER's process must stay, when it is a worker's.
A worker's parent watches that process for its result, so a new process
would look like the worker died."
  (let (name)
    (maphash (lambda (_id target)
               (when (and (eq (plist-get target :buffer) chat-buffer)
                          (equal (plist-get target :placement) "worker"))
                 (setq name (plist-get target :name))))
             pi-orchestration--targets)
    (when name
      (format "The parent of worker %s tracks its process: resume it there with do({resume: \"%s\"}) once it stopped"
              name name))))

(add-hook 'pilish-restart-refusal-functions
          #'pi-orchestration--restart-refusal)

(defun pi-orchestration--environment (values)
  "Convert JSON object VALUES to an environment alist."
  (let (result)
    (while values
      (let ((key (pop values)) (value (pop values)))
        (push (cons (substring (symbol-name key) 1) value) result)))
    (nreverse result)))

(defun pi-orchestration--target (id)
  "Return owned target ID or signal a missing-target error."
  (or (gethash id pi-orchestration--targets)
      (error "Missing orchestration target: %s" id)))

(defun pi-orchestration--process (target)
  "Return the current native process for TARGET."
  (if (equal (plist-get target :kind) "pi")
      (pilish-session-process (plist-get target :buffer))
    (plist-get target :process)))

(defun pi-orchestration--state (id)
  "Return native VIEW liveness/readiness for ID, never detached Pi liveness."
  (let* ((target (gethash id pi-orchestration--targets))
         (buffer (plist-get target :buffer))
         (process (and target (pi-orchestration--process target)))
         (mux-id (plist-get target :mux-id)))
    (list :state (cond ((not (buffer-live-p buffer)) "missing")
                       ((and process (process-live-p process)) "running")
                       (t "exited"))
          :ready (if (if mux-id (pi-orchestration--view-ready-p buffer mux-id)
                       (plist-get target :ready)) t :json-false)
          :muxId mux-id :error (plist-get target :error))))

(defun pi-orchestration--start (data)
  "Create a native target described by DATA, returning immediately."
  (let* ((id (plist-get data :id))
         (spec (plist-get data :spec))
         (kind (plist-get spec :kind))
         (name (plist-get spec :name))
         (directory (file-name-as-directory (plist-get spec :cwd)))
         (endpoint (plist-get data :endpoint))
         (environment
          (append (list (cons "PI_ORCHESTRATION_HOST" "emacs")
                        (cons "PI_ORCHESTRATION_ENDPOINT" endpoint)
                        (cons "PI_ORCHESTRATION_TARGET" id))
                  (pi-orchestration--environment (plist-get spec :env))))
         (target (list :kind kind :name name
                       :placement (plist-get spec :placement)
                       :parent (plist-get (plist-get spec :parent) :id)
                       :responses (make-hash-table :test 'equal)
                       :ready nil :error nil :buffer nil :process nil :pid nil :mux-id nil :runtime nil :owns-view nil
                       :panel (plist-get spec :panel) :panel-control (append (plist-get spec :panelControl) nil))))
    (when (file-remote-p directory)
      (error "Orchestration requires a local directory and shared filesystem"))
    (when (gethash id pi-orchestration--targets)
      (error "Target already exists: %s" id))
    (puthash id target pi-orchestration--targets)
    (condition-case err
        (if (equal kind "pi")
            (progn
              (let* ((runtime (pi-orchestration--runtime
                               (plist-get spec :runtime) (plist-get spec :process) directory))
                     (previous (buffer-list))
                     (buffer (pilish-attach-runtime runtime name))
                     (hidden-before (plist-get spec :hiddenHistoryBefore)))
                ;; Attachment is asynchronous: a new view has drawn no history yet.
                (when (and (numberp hidden-before) (not (memq buffer previous)))
                  (with-current-buffer buffer
                    (setq-local pilish-history-hidden-before hidden-before)))
                (setf (plist-get target :buffer) buffer
                      (plist-get target :mux-id) (plist-get runtime :mux-id)
                      (plist-get target :runtime) runtime
                      (plist-get target :owns-view) (not (memq buffer previous)))))
          (unless (equal kind "shell") (error "Unknown target kind: %s" kind))
          (let ((default-directory directory)
                (process-environment (copy-sequence process-environment))
                (argv (append (plist-get spec :argv) nil))
                (buffer (generate-new-buffer (concat "pi-panel:" name ":" id))))
            (dolist (entry (reverse environment))
              (setenv (car entry) (cdr entry)))
            (setf (plist-get target :buffer) buffer)
            (with-current-buffer buffer (setq default-directory directory))
            (let ((process (ghostel-exec buffer (car argv) (cdr argv))))
              (with-current-buffer buffer
                ;; Exited panels stay readable until closed, and closing
                ;; never asks about a running command.
                (setq-local ghostel-kill-buffer-on-exit nil
                            ghostel-query-before-killing nil)
                (setf (plist-get target :process) process
                      (plist-get target :pid) ghostel--pid
                      (plist-get target :ready) t)))))
      (error
       (condition-case cleanup
           (pi-orchestration--close id)
         (error (error "%s; target cleanup failed: %s"
                       (error-message-string err) (error-message-string cleanup))))
       (signal (car err) (cdr err))))
    (pi-orchestration--attach-discovered-parent (plist-get spec :parent) endpoint)
    (pi-orchestration--run-target-functions id 'start)
    (list :muxId (plist-get target :mux-id)
          :target (list :host "emacs" :endpoint endpoint :id id
                        :kind kind :name name
                        :sessionFile (plist-get spec :sessionFile)))))

(defun pi-orchestration--key (key)
  "Translate one neutral terminal KEY name to ghostel (NAME MODIFIERS).
NAME is a key for `ghostel-send-key'; MODIFIERS a comma-separated string."
  (let* ((parts (split-string key "+"))
         (literal (car (last parts)))
         (base (downcase literal))
         (modifiers (mapcar
                     (lambda (modifier)
                       (pcase (downcase modifier)
                         ("ctrl" "ctrl") ("alt" "alt") ("shift" "shift")
                         (_ (error "Unsupported key modifier: %s" modifier))))
                     (butlast parts)))
         (name (cond
                ((= (length base) 1) literal)
                ((equal base "enter") "return")
                ((equal base "pageup") "prior")
                ((equal base "pagedown") "next")
                ((member base '("tab" "space" "escape" "backspace"
                                "up" "down" "left" "right" "home" "end"
                                "insert" "delete"))
                 base)
                ((string-match-p "\\`f[1-9][0-9]?\\'" base) base)
                (t (error "Unsupported terminal key: %s" key)))))
    (list name (string-join modifiers ","))))

(defun pi-orchestration--send-key (name modifiers)
  "Send key NAME with MODIFIERS to the current ghostel terminal.
Printable characters without Ctrl or Alt are typed as text, so their case
is exact; everything else goes through the terminal's key encoder."
  (if (and (= (length name) 1)
           (not (string-match-p "ctrl\\|alt" modifiers)))
      (ghostel-send-string (if (string-search "shift" modifiers) (upcase name) name))
    (ghostel-send-key name modifiers)))

(defun pi-orchestration--send (data)
  "Submit typed input from DATA without reading or modifying a Pi draft."
  (let* ((target (pi-orchestration--target (plist-get data :id)))
         (buffer (plist-get target :buffer))
         (input (plist-get data :input))
         (kind (plist-get input :kind)))
    (unless (and (buffer-live-p buffer)
                 (process-live-p (pi-orchestration--process target)))
      (error "Target process is not running"))
    (when (plist-get target :panel)
      (error "Managed panel input requires its identity-bound wrapper control"))
    (if (equal (plist-get target :kind) "pi")
        (progn
          (unless (equal kind "prompt")
            (error "Pilish Pi targets accept prompts, not terminal text or keys"))
          (let* ((request (plist-get data :request))
                 (responses (plist-get target :responses)))
            (puthash request :pending responses)
            (condition-case err
                (pilish-submit-prompt
                 buffer (plist-get input :text)
                 (lambda (response) (puthash request response responses)))
              (error
               (remhash request responses)
               (signal (car err) (cdr err))))
            (list :pending t)))
      (with-current-buffer buffer
        (pcase kind
          ("text"
           (ghostel-send-string
            (encode-coding-string (plist-get input :text) 'utf-8))
           (when (eq (plist-get input :enter) t)
             (ghostel-send-key "return")))
          ("keys"
           (let ((keys (mapcar #'pi-orchestration--key
                               (append (plist-get input :keys) nil))))
             (dolist (key keys)
               (apply #'pi-orchestration--send-key key))))
          (_ (error "Shell targets accept only terminal text or keys"))))
      (list :success t))))

(defun pi-orchestration--response (data)
  "Return an asynchronous prompt receipt identified by DATA.
A settled receipt stays until its target closes: a stalled Emacs can answer a
client that already timed out, so the next poll must get the same answer."
  (let* ((target (pi-orchestration--target (plist-get data :id)))
         (responses (plist-get target :responses))
         (request (plist-get data :request))
         (response (gethash request responses)))
    (cond
     ((eq response :pending) (list :pending t))
     (response
      (list :success (plist-get response :success)
            :error (plist-get response :error)))
     (t (error "Missing prompt receipt: %s" request)))))

(defun pi-orchestration--tail (lines)
  "Return the last LINES lines of the current buffer, at most 50 KiB."
  (save-excursion
    (save-restriction
      (widen)
      (goto-char (point-max))
      (forward-line (- lines))
      (buffer-substring-no-properties
       (max (point) (- (point-max) 51200)) (point-max)))))

(defun pi-orchestration--read (data)
  "Read a bounded rendered snapshot for the target in DATA.
Ghostel renders a terminal into its buffer only while displayed, so
terminal text comes from the terminal itself, including hidden panels."
  (let* ((target (pi-orchestration--target (plist-get data :id)))
         (buffer (plist-get target :buffer))
         (lines (min 2000 (max 1 (or (plist-get data :lines) 80)))))
    (unless (buffer-live-p buffer) (error "Target buffer is missing"))
    (list :output
          (with-current-buffer buffer
            (if (and (derived-mode-p 'ghostel-mode) ghostel--term)
                (let ((text (or (ghostel--copy-all-text ghostel--term) "")))
                  (with-temp-buffer
                    (insert (string-trim-right text))
                    (pi-orchestration--tail lines)))
              (pi-orchestration--tail lines))))))

(defun pi-orchestration--close (id &optional _force mux-id task-owned panel-id)
  "Disconnect target ID's owned view; panels retain native host lifetime.
MUX-ID, when supplied, prevents cleanup against a different runtime.
This never signals a Pi using its network-client process ID."
  (let* ((target (gethash id pi-orchestration--targets))
         (pi-target (equal (plist-get target :kind) "pi")))
    (when target
      (when (and mux-id (not (equal mux-id (plist-get target :mux-id))))
        (error "Refusing to detach a different runtime"))
      (when (and (plist-get target :stop-pending) (not task-owned))
        (error "Close is awaiting owning-task acknowledgement; view retained"))
      (let ((buffer (plist-get target :buffer)))
        (if pi-target
            (when (and (plist-get target :owns-view) (buffer-live-p buffer)
                       ;; Final parent-task evidence owns worker view retirement,
                       ;; whether or not Close was requested. Do not dispose the
                       ;; view before that evidence is published.
                       (not (and task-owned
                                 (equal (plist-get target :placement) "worker"))))
              (pilish-disconnect-session buffer))
          (let ((process (pi-orchestration--process target))
                (pid (plist-get target :pid))
                (panel (plist-get target :panel)))
            (if panel
                (progn
                  (unless (equal panel-id (plist-get panel :id))
                    (error "Managed panel disposal requires its exact acknowledged control identity"))
                  (when (and process (process-live-p process))
                    (let ((deadline (+ (float-time) 1)))
                      (while (and (process-live-p process) (< (float-time) deadline))
                        (accept-process-output process 0.05))))
                  (when (and process (process-live-p process))
                    (error "Panel wrapper has not exited; retaining its native view")))
              (when (and process (process-live-p process))
                (when (and pid (not (zerop (signal-process (- pid) 'SIGKILL))))
                  (error "Native panel process-group termination was not acknowledged"))
                (delete-process process)
                (when (process-live-p process)
                  (error "Native panel exit is uncertain")))))
          (when (buffer-live-p buffer) (kill-buffer buffer))))
      (if (and pi-target task-owned (equal (plist-get target :placement) "worker"))
          ;; Actual exit/native cleanup precedes the parent's registry/name
          ;; cleanup. Keep its waiter until task-finished confirms both.
          (progn
            (unless (plist-member target :exit-cleaned) (nconc target (list :exit-cleaned nil)))
            (setf (plist-get target :exit-cleaned) t))
        (remhash id pi-orchestration--targets)
        (pi-orchestration--run-target-functions id 'close)))
    (list :success t)))


(defvar pi-orchestration-stop-timeout 45
  "Maximum seconds awaiting acknowledged native/task Close cleanup.")

(defun pi-orchestration--finish-stop (id target failure &optional operation)
  "Settle TARGET's pending Close with FAILURE for OPERATION, when supplied."
  (when (and (plist-get target :stop-pending)
             (or (null operation) (eq operation (plist-get target :stop-operation))))
    (setf (plist-get target :stop-pending) nil)
    (when-let* ((timer (plist-get target :stop-timer))) (cancel-timer timer))
    (let ((callbacks (plist-get target :stop-callbacks)))
      (setf (plist-get target :stop-callbacks) nil)
      (unless failure
        (when (eq target (gethash id pi-orchestration--targets))
          (remhash id pi-orchestration--targets)
          (pi-orchestration--run-target-functions id 'close)))
      (dolist (callback callbacks)
        (with-demoted-errors "pi-orchestration Close callback: %S"
          (funcall callback failure))))))

(defun pi-orchestration--task-finished (id mux-id failure)
  "Acknowledge parent task cleanup for ID/MUX-ID with FAILURE or nil.
The parent sends this only after exit, native cleanup and releasing its name.
Reconcile retained worker views using read-only final evidence, even when their
transport disconnected before termination and never received pimux_exit."
  (when-let* ((target (gethash id pi-orchestration--targets)))
    (unless (equal mux-id (plist-get target :mux-id))
      (error "Refusing cleanup acknowledgement for another runtime"))
    (let* ((failure (or failure (unless (plist-get target :exit-cleaned)
                                  "Task exit/native cleanup was not acknowledged")))
           (cleanup-error
            (unless failure
              (condition-case error
                  (when (and (equal (plist-get target :kind) "pi")
                             (equal (plist-get target :placement) "worker")
                             (buffer-live-p (plist-get target :buffer)))
                    (pilish-reconcile-worker-task (plist-get target :buffer)
                                                  (plist-get target :runtime)))
                (error (error-message-string error))))))
      (setq failure (or failure cleanup-error))
      (pi-orchestration--finish-stop id target failure)
      ;; A timeout settles a waiter, not the agent's lifecycle. Final owning-task
      ;; evidence still retires the exact target, without calling old callbacks.
      (unless failure
        (when (eq target (gethash id pi-orchestration--targets))
          (remhash id pi-orchestration--targets)
          (pi-orchestration--run-target-functions id 'close)))
      (when cleanup-error (error "%s" cleanup-error))))
  (list :success t))

(defun pi-orchestration--stop-panel (id target operation)
  "Close TARGET through its persistent control, then retire its native view."
  (let ((output (generate-new-buffer " *pi-panel-close*"))
        (diagnostics (generate-new-buffer " *pi-panel-close-errors*"))
        (panel-id (plist-get (plist-get target :panel) :id)))
    (condition-case failure
        (make-process
         :name "pi-panel-close" :buffer output :stderr diagnostics :noquery t
         :command (plist-get target :panel-control)
         :sentinel
         (lambda (process _event)
           (when (memq (process-status process) '(exit signal))
             (let (failure)
               (condition-case error
                   (let* ((text (with-current-buffer output (buffer-string)))
                          (receipt (and (zerop (process-exit-status process))
                                        (json-parse-string text :object-type 'plist))))
                     (unless (and (eq (plist-get receipt :success) t)
                                  (equal (plist-get receipt :id) panel-id))
                       (error "Panel Close was not acknowledged: %s" (string-trim text)))
                     (unless (eq target (gethash id pi-orchestration--targets))
                       (error "Panel target changed during Close"))
                     (when-let* ((warning (plist-get receipt :warning)))
                       (message "Panel Close: %s" warning))
                     (pi-orchestration--close id nil nil t panel-id))
                 (error
                  (setq failure
                        (concat (error-message-string error)
                                (with-current-buffer diagnostics
                                  (if (zerop (buffer-size)) ""
                                    (concat "; " (string-trim (buffer-string)))))))))
               (kill-buffer output)
               (kill-buffer diagnostics)
               (pi-orchestration--finish-stop id target failure operation)))))
      (error
       (kill-buffer output)
       (kill-buffer diagnostics)
       (pi-orchestration--finish-stop id target (error-message-string failure) operation)))))

;;;###autoload
(cl-defun pi-orchestration-stop-target (id &optional callback)
  "Close ID without confirmation.
CALLBACK receives nil or an error exactly once. Roots settle after acknowledged
exit and native-view cleanup. Workers cancel only their exact parent task and
settle after its exit, cleanup and name release, never on command acceptance.
Failed/uncertain cleanup retains the target.
Concurrent callers join the same operation. The return value is not success."
  (let* ((target (gethash id pi-orchestration--targets))
         (buffer (plist-get target :buffer))
         (mux-id (plist-get target :mux-id))
         (operation (make-symbol "close"))
         (callback (or callback (lambda (error) (when error (message "Pi Close: %s" error))))))
    (unless target
      (funcall callback (format "Missing orchestration target: %s" id))
      (cl-return-from pi-orchestration-stop-target nil))
    ;; Keep the registered plist's cons identity while adding waiter fields.
    (unless (plist-member target :stop-pending)
      (nconc target (list :stop-pending nil :stop-callbacks nil
                          :stop-timer nil :exit-cleaned nil :stop-operation nil)))
    (push callback (plist-get target :stop-callbacks))
    (unless (plist-get target :stop-pending)
      (setf (plist-get target :stop-pending) t
            (plist-get target :stop-operation) operation
            (plist-get target :stop-timer)
            (run-at-time pi-orchestration-stop-timeout nil
                         (lambda () (pi-orchestration--finish-stop
                                     id target "Close outcome uncertain; target retained" operation))))
      (condition-case err
          (if (equal (plist-get target :kind) "pi")
              (if (or (equal (plist-get target :placement) "worker")
                      (and (buffer-live-p buffer)
                           (equal (plist-get (pilish-session-runtime buffer) :placement) "worker")))
                  (progn
                    (unless (and (buffer-live-p buffer) mux-id
                                 (pi-orchestration--view-ready-p buffer mux-id)
                                 (process-live-p (pilish-session-process buffer)))
                      (error "Reconnect this worker or cancel its parent's active request"))
                    ;; Public Close validates a fresh get_commands response
                    ;; advertising worker-cancel for this exact input context.
                    ;; Missing capability must never become an inference prompt.
                    (pilish-close-session
                     buffer (lambda (failure)
                              (pi-orchestration--finish-stop id target failure operation))))
                (unless (and mux-id (buffer-live-p buffer))
                  (error "Reconnect this agent before closing it"))
                (pilish-stop-runtime
                 buffer (lambda (failure)
                          (unless failure
                            (condition-case cleanup
                                (pi-orchestration--close id nil mux-id t)
                              (error (setq failure (error-message-string cleanup)))))
                          (pi-orchestration--finish-stop id target failure operation))))
            (if (plist-get target :panel)
                (pi-orchestration--stop-panel id target operation)
              (pi-orchestration--close id nil nil t)
              (pi-orchestration--finish-stop id target nil operation)))
        (error (pi-orchestration--finish-stop id target (error-message-string err) operation))))
    nil))


;;;; Ordinary sessions opened by `/switch emacs'

(defvar pi-orchestration-show-session-function #'pi-orchestration-show-session
  "Function called with the chat buffer of a session opened by `/switch emacs'.
It shows the session; pi-deck replaces it to use the space for the
session's directory.")

(defvar pi-orchestration--switches (make-hash-table :test 'equal)
  "`/switch emacs' openings by request ID: plists with :buffer, :ready, :failure.")

(defun pi-orchestration--client-frame ()
  "Return the most recently used client frame, or nil when none exists."
  (let (best best-time)
    (dolist (frame (frame-list))
      (unless (or (equal (terminal-name (frame-terminal frame)) "initial_terminal")
                  (frame-parent frame))
        (let ((time (window-use-time (get-mru-window frame t))))
          (when (or (null best) (> time best-time))
            (setq best frame best-time time)))))
    best))

(defun pi-orchestration-show-session (chat)
  "Show CHAT with its input in the most recently used client frame.
Without a client frame the session stays open in the background."
  (when-let* ((frame (pi-orchestration--client-frame)))
    (select-frame-set-input-focus frame)
    (pop-to-buffer chat)
    (let ((input (pilish-session-input-buffer chat)))
      (unless (get-buffer-window input frame)
        (pilish-split-input-window (get-buffer-window chat frame) input))
      (when-let* ((window (get-buffer-window input frame)))
        (select-window window)))))

(defun pi-orchestration--canonical-file (file)
  "Return FILE's true name, or its absolute name when it does not exist."
  (if (file-exists-p file) (file-truename file) (expand-file-name file)))

(defun pi-orchestration--session-view (file)
  "Return a live Pilish chat buffer that has session FILE open, or nil."
  (let ((file (pi-orchestration--canonical-file file)))
    (cl-find-if (lambda (buffer)
                  (and (eq (buffer-local-value 'major-mode buffer) 'pilish-chat-mode)
                       (when-let* ((open (pilish-session-file buffer)))
                         (and (not (file-remote-p open))
                              (equal (pi-orchestration--canonical-file open) file)))))
                (buffer-list))))

(defun pi-orchestration--switch (data)
  "Attach the runtime in DATA, never open or reload its session writer."
  (unless (stringp (plist-get data :muxId))
    (error "/switch emacs requires a runtime to attach"))
  (let* ((id (plist-get data :id))
         (mux-id (plist-get data :muxId))
         (file (pi-orchestration--canonical-file (plist-get data :sessionFile)))
         (runtime (cl-find mux-id (pilish-list-runtimes)
                           :key (lambda (entry) (plist-get entry :mux-id))
                           :test #'equal))
         (existing (pi-orchestration--session-view file))
         (existing-runtime (and existing (pilish-session-runtime existing)))
         (record (list :buffer nil :mux-id mux-id :refreshed nil)))
    (unless (and runtime (equal (plist-get runtime :protocol) 2)
                 (stringp (plist-get runtime :session-file))
                 (equal (pi-orchestration--canonical-file
                         (plist-get runtime :session-file)) file))
      (error "Requested runtime is absent or now serves another conversation"))
    (when (gethash id pi-orchestration--switches)
      (error "Switch already exists: %s" id))
    (when (and existing (not (equal (plist-get existing-runtime :mux-id) mux-id)))
      (error "The existing view has a different owner; it was not reloaded"))
    (setf (plist-get record :buffer)
          (or existing (pilish-attach-runtime runtime))
          (plist-get record :refreshed) (and existing t))
    (puthash id record pi-orchestration--switches)
    (with-demoted-errors "pi-orchestration show session: %S"
      (funcall pi-orchestration-show-session-function (plist-get record :buffer)))
    (list :buffer (buffer-name (plist-get record :buffer)) :muxId mux-id
          :refreshed (if existing t :json-false))))

(defun pi-orchestration--switch-state (data)
  "Report attachment readiness; failure cleanup disconnects only its new view."
  (let* ((id (plist-get data :id))
         (record (or (gethash id pi-orchestration--switches)
                     (error "Missing switch: %s" id)))
         (buffer (plist-get record :buffer))
         (mux-id (plist-get record :mux-id))
         (ready (pi-orchestration--view-ready-p buffer mux-id))
         (runtime (and (buffer-live-p buffer) (pilish-session-runtime buffer)))
         (failure (cond ((not (buffer-live-p buffer)) "Attachment view was closed")
                        ((not (equal (plist-get runtime :mux-id) mux-id))
                         "Attachment runtime identity changed")
                        ((member (plist-get runtime :state) '("stopped" "unavailable"))
                         "Runtime is stopped or unavailable"))))
    (when (eq (plist-get data :close) t)
      (unless (and (eq (plist-get data :detachOnly) t)
                   (equal (plist-get data :muxId) mux-id))
        (error "Failed attachment cleanup requires the exact runtime identity"))
      (when (and (not (plist-get record :refreshed)) (buffer-live-p buffer))
        (pilish-disconnect-session buffer)))
    ;; A failed new attachment still owns a view. Retain its exact identity
    ;; until cleanup succeeds; a reused view has nothing for us to dispose.
    (when (or ready (and failure (plist-get record :refreshed))
              (eq (plist-get data :close) t))
      (remhash id pi-orchestration--switches))
    (list :state (if (buffer-live-p buffer) "running" "missing")
          :ready (if ready t :json-false) :muxId mux-id :failure failure)))

;;;###autoload
(defun pi-orchestration-dispatch (encoded)
  "Execute one fixed operation from base64 JSON ENCODED and encode its result."
  (let ((result
         (condition-case err
             (let* ((data (json-parse-string
                           (decode-coding-string (base64-decode-string encoded) 'utf-8)
                           :object-type 'plist))
                    (id (plist-get data :id)))
               (pcase (plist-get data :operation)
                 ("start" (pi-orchestration--start data))
                 ("send" (pi-orchestration--send data))
                 ("response" (pi-orchestration--response data))
                 ("read" (pi-orchestration--read data))
                 ("state" (pi-orchestration--state id))
                 ("close" (pi-orchestration--close id nil (plist-get data :muxId)
                                                    (eq (plist-get data :taskOwned) t)
                                                    (plist-get data :panelId)))
                 ("task-finished" (pi-orchestration--task-finished
                                   id (plist-get data :muxId) (plist-get data :error)))
                 ("switch" (pi-orchestration--switch data))
                 ("switch-state" (pi-orchestration--switch-state data))
                 (_ (error "Unknown orchestration operation"))))
           (error (list :error (error-message-string err))))))
    (base64-encode-string (encode-coding-string (json-encode result) 'utf-8) t)))

(provide 'pi-orchestration)
;;; pi-orchestration.el ends here
