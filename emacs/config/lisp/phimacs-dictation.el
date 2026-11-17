;;; phimacs-dictation.el --- Dictation into Pilish inputs and questions -*- lexical-binding: t; -*-

;;; Commentary:

;; Connects pi-sound dictation to Pilish through public functions of both:
;; Pilish inputs and editor questions submit what is dictated into them, and
;; an inline Pi question at point is answered by the transcript (a choice's
;; number, label or yes/no, else the text for questions asking for text).
;; Inline questions get a dictation button row.  pi-sound's own targets
;; cover prompts, terminals and all other buffers.

;;; Code:

(require 'pi-sound)
(require 'pilish)

(defun phimacs-dictation-target ()
  "Return the dictation target of the Pilish buffer at point, or nil.
For `pi-sound-target-functions'."
  (cond
   ((derived-mode-p 'pilish-input-mode)
    (list :submit (lambda () (call-interactively #'pilish-send)) :command 'pilish-send))
   ((derived-mode-p 'pilish-editor-mode)
    (list :submit (lambda () (call-interactively #'pilish-editor-submit))
          :command 'pilish-editor-submit))
   ((pilish-dialog-at)
    (let ((position (point-marker)))
      (list :insert (lambda (text)
                      (unless (pilish-dialog-answer-text text position #'pi-sound-format-dictated)
                        (error "No answer of this question matches")))
            ;; Free text answers take the format themselves; choices never.
            :format nil
            :auto-stop t
            :valid-p (lambda ()
                       (when-let* ((buffer (marker-buffer position)))
                         (with-current-buffer buffer (pilish-dialog-at position)))))))))

(defun phimacs-dictation-dialog-row (_id)
  "Return the dictation button row of an inline Pi question.
For `pilish-dialog-row-functions'."
  (make-text-button "🎤 Say an answer" nil
                    'action (lambda (button)
                              (goto-char button)
                              (pi-sound-dictate))
                    'follow-link t
                    'help-echo "mouse-1, RET: dictate a choice's number or name, yes or no, or the text"))

(defun phimacs-enable-dictation ()
  "Dictate anywhere, with Pilish targets, keys and buttons."
  (add-hook 'pi-sound-target-functions #'phimacs-dictation-target)
  (add-hook 'pilish-dialog-row-functions #'phimacs-dictation-dialog-row)
  (add-hook 'pilish-input-mode-hook #'pi-sound-input-button-setup)
  (add-hook 'pilish-editor-mode-hook #'pi-sound-input-button-setup)
  ;; Minor mode keys take precedence in prompts, where M-v would otherwise
  ;; switch to the completions.
  (keymap-set pi-sound-mode-map "C-c v" #'pi-sound-dictate)
  (keymap-set pi-sound-mode-map "M-v" #'pi-sound-dictate)
  (pi-sound-mode 1))

(provide 'phimacs-dictation)
;;; phimacs-dictation.el ends here
