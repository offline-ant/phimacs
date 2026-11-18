;;; pilish-model.el --- Live model discovery and selection -*- lexical-binding: t; -*-
;; Copyright (C) 2026 Daniel Nouri
;; SPDX-License-Identifier: GPL-3.0-or-later

;;; Commentary:

;; Managed model choices refresh through the owning runtime, without blocking
;; Emacs or submitting an inference prompt.  Delayed selection keeps the input
;; context captured before discovery and completion.  Explicit unshared Pi
;; retains its native RPC catalog behavior.

;;; Code:

(require 'cl-lib)
(require 'pilish-render)

(declare-function pilish--session-transition-ready-p "pilish-menu" (chat-buf action))

;;;###autoload
(defun pilish-select-model (&optional initial-input force)
  "Select a model, optionally filtering with INITIAL-INPUT.
Managed sessions refresh their catalog asynchronously before completion.
With a prefix argument, FORCE a refresh past the provider freshness limit.
Explicit unshared Pi uses its current RPC catalog; it has no refresh RPC."
  (interactive (list nil current-prefix-arg))
  (let ((proc (pilish--get-process))
        (chat (pilish--get-chat-buffer)))
    (unless proc (user-error "No pi process running"))
    (when (pilish--model-change-pending-p chat)
      (user-error "A model change is already pending"))
    (when (pilish--session-transition-ready-p chat "change models")
      (let ((context (pilish--capture-input-context proc))
            (generation (buffer-local-value 'pilish--session-transition-generation chat)))
        (if (not (pilish--process-shared-p proc))
            (let ((response (pilish--rpc-sync proc '(:type "get_available_models") 5)))
              (pilish--select-model-from-list
               proc chat context generation initial-input
               (plist-get (plist-get response :data) :models)))
          (unless (member "models" (append (plist-get (pilish--process-shared-p proc)
                                                      :capabilities) nil))
            (user-error "This agent lacks live model control; reconnecting cannot update its loaded runtime"))
          (message "Pi: Refreshing available models...")
          (pilish--rpc-async
           proc (append '(:type "pimux_models" :action "list")
                        (when force '(:force t)))
           (lambda (response)
             (cond
              ((not (pilish--model-picker-current-p proc chat context generation))
               (message "Pi: Conversation changed while fetching models; nothing was selected"))
              ((not (eq (plist-get response :success) t))
               (message "Pi: Failed to refresh models: %s"
                        (pilish--model-response-error response)))
              (t
               ;; Completion may run a nested event loop.  Leave the socket
               ;; filter first so the rest of its records dispatch in order.
               (run-at-time
                0 nil
                (lambda ()
                  (cond
                   ((not (pilish--model-picker-current-p proc chat context generation))
                    (message "Pi: Conversation changed before model selection; nothing was sent"))
                   ((active-minibuffer-window)
                    (message "Pi: Minibuffer is active; run model selection again when it closes"))
                   (t
                    (with-current-buffer chat
                      (pilish--select-model-from-list
                       proc chat context generation initial-input
                       (plist-get (plist-get response :data) :models))))))))))))))))

(defun pilish--model-picker-current-p (proc chat context generation)
  "Whether PROC, CHAT, CONTEXT and GENERATION still own a delayed picker."
  (and (buffer-live-p chat)
       (pilish--session-transition-current-p chat proc generation)
       (or (not (pilish--process-shared-p proc))
           (equal context (process-get proc 'pilish-input-context)))))

(defun pilish--model-response-error (response)
  "Return the error message in a model-control RESPONSE."
  (let ((failure (plist-get response :error)))
    (or (and (listp failure) (plist-get failure :message))
        failure "unknown error")))

(defun pilish--select-model-from-list
    (proc chat context generation initial-input models)
  "Choose from MODELS and switch PROC in its original CHAT and CONTEXT.
GENERATION pins the session before discovery.  INITIAL-INPUT filters choices."
  (when (and (pilish--model-picker-current-p proc chat context generation)
             (not (pilish--model-change-pending-p chat))
             (pilish--session-transition-ready-p chat "change models"))
    (if (seq-empty-p models)
        (message "Pi: No authenticated chat models available")
      (let* ((state (buffer-local-value 'pilish--state chat))
             (current (plist-get state :model))
             (current-display
              (when (and (plist-get current :name) (plist-get current :provider))
                (format "%s [%s]" (pilish--shorten-model-name (plist-get current :name))
                        (plist-get current :provider))))
             (choices
              (mapcar (lambda (model)
                        (cons (format "%s [%s]"
                                      (pilish--shorten-model-name (plist-get model :name))
                                      (or (plist-get model :provider) "?"))
                              model))
                      models))
             (names (mapcar #'car choices))
             (exact (and initial-input
                         (cl-remove-if-not
                          (lambda (entry)
                            (let ((model (cdr entry)))
                              (member initial-input
                                      (list (plist-get model :id)
                                            (format "%s/%s" (plist-get model :provider)
                                                    (plist-get model :id))))))
                          choices)))
             (choice
              (if (= (length exact) 1)
                  (caar exact)
                (let ((completion-ignore-case t)
                      (completion-styles '(basic flex))
                      (prompt (format "Model (current: %s): "
                                      (or current-display "unknown"))))
                  (if (not initial-input)
                      (completing-read prompt names nil t)
                    (let ((matches (completion-all-completions
                                    initial-input names nil (length initial-input))))
                      (when (consp matches) (setcdr (last matches) nil))
                      (cond
                       ((= (length matches) 1) (car matches))
                       ((null matches)
                        (message "Pi: No model matching \"%s\"" initial-input) nil)
                       (t (completing-read prompt names nil t initial-input)))))))))
        (when (and choice (not (equal choice current-display)))
          (if (not (pilish--model-picker-current-p proc chat context generation))
              (message (if (and (buffer-live-p chat)
                                (eq proc (buffer-local-value 'pilish--process chat)))
                           "Pi: Conversation changed while selecting a model; nothing was sent"
                         "Pi: Process changed while selecting a model; try again"))
            (when (and (not (pilish--model-change-pending-p chat))
                       (pilish--session-transition-ready-p chat "change models"))
              (pilish--set-selected-model proc chat context generation
                                          (cdr (assoc choice choices)) choice))))))))

(defun pilish--set-selected-model (proc chat context generation model label)
  "Set PROC's MODEL, displayed as LABEL, for captured CHAT and CONTEXT.
Only a response in the original session GENERATION updates local state."
  (let ((token (pilish--begin-model-change proc chat))
        (shared (pilish--process-shared-p proc)))
    (if (not token)
        (message "Pi: Process changed while selecting a model; try again")
      (condition-case err
          (progn
            (message "Pi: Setting model to %s..." label)
            (pilish--rpc-async
             proc (pilish--bind-input-context
                   (append (if shared '(:type "pimux_models" :action "set")
                             '(:type "set_model"))
                           (list :provider (plist-get model :provider)
                                 :modelId (plist-get model :id)))
                   context)
             (lambda (response)
               (when (pilish--model-change-current-p token chat)
                 (let ((success (eq (plist-get response :success) t))
                       applied)
                   (unwind-protect
                       (when (and success (pilish--model-picker-current-p
                                           proc chat context generation))
                         (with-current-buffer chat
                           (unless shared
                             (pilish--update-state-from-response response))
                           ;; Managed model/thinking events are authoritative for
                           ;; all frontends; the acknowledgement only settles input.
                           (force-mode-line-update))
                         (setq applied t))
                     (when (pilish--finish-model-change token chat)
                       (when (buffer-live-p chat)
                         (with-current-buffer chat
                           (if applied
                               (pilish--process-followup-queue)
                             (pilish--restore-followup-queue-to-input))))
                     (cond
                      (applied (message "Pi: Model set to %s" label))
                      ((not success)
                       (message "Pi: Failed to set model: %s"
                                (pilish--model-response-error response)))
                      (t (message "Pi: Model response belongs to an older conversation"))))))))))
        ((error quit)
         (when (pilish--finish-model-change token chat)
           (with-current-buffer chat
             (pilish--restore-followup-queue-to-input)))
         (signal (car err) (cdr err)))))))

(provide 'pilish-model)
;;; pilish-model.el ends here
