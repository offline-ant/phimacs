;;; phimacs-ui.el --- Dracula, keys and completion -*- lexical-binding: t; -*-
;; SPDX-License-Identifier: MIT
(require 'cl-lib)
(require 'subr-x)
(require 'phimacs-environment)
(require 'winner)
(require 'savehist)
(require 'recentf)
(require 'saveplace)

(defvar evil-escape-key-sequence)
(defvar evil-escape-delay)
(defvar winum-auto-setup-mode-line)
(defvar vertico-cycle)
(defvar vertico-count)
(defvar vertico-map)
(defvar corfu-auto)
(defvar corfu-auto-delay)
(defvar corfu-auto-prefix)
(defvar corfu-cycle)
(defvar corfu-preselect)
(defvar which-key-idle-delay)
(defvar dracula-alternate-mode-line-and-minibuffer)
(defvar xterm-extra-capabilities)
(declare-function general-define-key "general" (&rest args))
(declare-function general-override-mode "general" (&optional arg))
(declare-function vertico-next "vertico")
(declare-function vertico-previous "vertico")
(declare-function vertico-directory-enter "vertico-directory")
(declare-function vertico-directory-delete-char "vertico-directory")
(declare-function corfu-popupinfo-mode "corfu-popupinfo")
(declare-function corfu-history-mode "corfu-history")

(defvar phimacs--ui-enabled nil)
(defvar phimacs-panel-visible nil)

(defun phimacs-show-messages ()
  "Show Messages in the reference bottom panel."
  (interactive)
  (setq phimacs-panel-visible t)
  (select-window (display-buffer-in-side-window (get-buffer-create "*Messages*")
                                                '((side . bottom) (slot . 0)
                                                  (window-height . 0.25)))))

(defun phimacs-toggle-panel ()
  "Toggle this frame's Messages/Help panel without changing agent panes."
  (interactive)
  (let ((panel (cl-find-if (lambda (window)
                           (eq 'bottom (window-parameter window 'window-side)))
                         (window-list))))
    (if panel (progn (delete-window panel) (setq phimacs-panel-visible nil))
      (phimacs-show-messages))))

(defun phimacs--answer-button (button)
  "Answer the minibuffer question with the clicked BUTTON's answer."
  (with-current-buffer (overlay-buffer button)
    (delete-minibuffer-contents)
    ;; The click put point on the read-only prompt.
    (goto-char (point-max))
    (insert (button-get button 'phimacs-answer))
    (exit-minibuffer)))

(defun phimacs-answer-buttons ()
  "Make the y/n or yes/no of a `y-or-n-p' or `yes-or-no-p' prompt clickable."
  (when (or (eq minibuffer-history-variable 'yes-or-no-p-history)
            (eq (keymap-lookup (current-local-map) "<remap> <self-insert-command>")
                'y-or-n-p-insert-other))
    (save-excursion
      (goto-char (minibuffer-prompt-end))
      ;; The prompt ends in "(y or n) ", "(y, n or C-h) " or "(yes or no) ".
      (when (re-search-backward "(\\(y\\|yes\\)\\(?:,\\| or\\) \\(n\\|no\\)\\_>"
                                (point-min) t)
        (dolist (group '(1 2))
          (let ((answer (match-string-no-properties group)))
            (make-button (match-beginning group) (match-end group)
                         'phimacs-answer answer
                         'action #'phimacs--answer-button
                         'follow-link t
                         'help-echo (format "mouse-1: answer %s" answer))))))))

(defun phimacs-remove-answer-buttons ()
  "Remove the answer buttons of the minibuffer being left."
  (dolist (overlay (overlays-in (point-min) (point-max)))
    (when (overlay-get overlay 'phimacs-answer) (delete-overlay overlay))))

(defun phimacs-modeline-chat ()
  "Use one blank chat-coloured row between chat and input."
  (setq-local mode-line-format '(" "))
  (dolist (face '(mode-line mode-line-inactive))
    (face-remap-set-base face '(:inherit default :box nil :overline nil :underline nil))))

(defun phimacs-modeline-input ()
  "Move Pilish's input status below its draft."
  (setq-local mode-line-format header-line-format
              header-line-format nil))

(defun phimacs-pane-prefix ()
  "Return the window number for the public deck pane-header hook."
  (let ((number (winum-get-number-string)))
    (unless (string-empty-p number) (propertize (concat " " number) 'face 'shadow))))

(defun phimacs-tty-frame (&optional frame)
  "Enable terminal mouse and readable borders in FRAME."
  (unless (display-graphic-p frame)
    (xterm-mouse-mode 1)
    (unless standard-display-table (setq standard-display-table (make-display-table)))
    (set-display-table-slot standard-display-table 'vertical-border (make-glyph-code ?│))))

(defun phimacs-leader (&rest bindings)
  "Bind BINDINGS under the selected profile's leader keys."
  (if phimacs-enable-evil
      (apply #'general-define-key :states '(normal insert visual motion emacs)
             :keymaps 'override :prefix "SPC" :non-normal-prefix "M-m" bindings)
    (apply #'general-define-key :keymaps 'override :prefix "M-m" bindings)))

(defun phimacs--enable-evil ()
  "Enable Evil and its reference companions."
  (setq evil-want-keybinding nil
        evil-want-integration t
        evil-want-C-u-scroll t
        evil-want-C-i-jump nil
        evil-want-Y-yank-to-eol t
        evil-undo-system 'undo-redo
        evil-mode-line-format nil
        evil-normal-state-cursor '("DarkGoldenrod2" box)
        evil-insert-state-cursor '("chartreuse3" (bar . 2))
        evil-motion-state-cursor '("plum3" box)
        evil-escape-key-sequence "fd"
        evil-escape-delay 0.1)
  (require 'evil)
  (evil-mode 1)
  (keymap-set evil-motion-state-map "<escape>" #'ignore)
  (require 'evil-collection)
  (evil-collection-init)
  (require 'evil-surround)
  (global-evil-surround-mode 1)
  (require 'evil-escape)
  (evil-escape-mode 1)
  (require 'evil-terminal-cursor-changer)
  (unless noninteractive (evil-terminal-cursor-changer-activate)))

(defun phimacs-enable-ui ()
  "Enable the reference UI once using the packages of `phimacs-packages'."
  (unless phimacs--ui-enabled
    (setq frame-background-mode 'dark
          use-dialog-box nil
          window-sides-vertical t
          delete-window-choose-selected 'pos
          mouse-drag-copy-region 'non-empty
          winum-auto-setup-mode-line nil
          vertico-cycle t
          vertico-count 15
          completion-styles '(orderless basic)
          completion-category-defaults nil
          completion-category-overrides '((file (styles partial-completion)))
          completion-ignore-case t
          corfu-auto t
          corfu-auto-delay 0.2
          corfu-auto-prefix 2
          corfu-cycle t
          corfu-preselect 'prompt
          tab-always-indent 'complete
          text-mode-ispell-word-completion nil
          which-key-idle-delay 0.4
          dracula-alternate-mode-line-and-minibuffer nil)
    (require 'dracula-theme)
    (load-theme 'dracula t)
    (when phimacs-enable-evil (phimacs--enable-evil))
    (require 'general)
    (general-override-mode 1)
    (phimacs-leader
      "SPC" #'execute-extended-command
      "ff" #'find-file "fs" #'save-buffer
      "bb" #'consult-buffer "bd" #'kill-current-buffer
      "bm" #'phimacs-show-messages
      "ss" #'consult-line "sp" #'consult-ripgrep
      "pf" #'project-find-file "pp" #'project-switch-project
      "gs" #'magit-status
      "ww" #'other-window "wd" #'delete-window
      "w/" #'split-window-right "w-" #'split-window-below
      "wh" #'windmove-left "wj" #'windmove-down
      "wk" #'windmove-up "wl" #'windmove-right
      "wu" #'winner-undo "wU" #'winner-redo
      "tp" #'phimacs-toggle-panel
      "qq" #'delete-frame "qQ" #'save-buffers-kill-emacs
      "hf" #'describe-function "hv" #'describe-variable "hk" #'describe-key
      "1" #'winum-select-window-1 "2" #'winum-select-window-2 "3" #'winum-select-window-3
      "4" #'winum-select-window-4 "5" #'winum-select-window-5 "6" #'winum-select-window-6
      "7" #'winum-select-window-7 "8" #'winum-select-window-8 "9" #'winum-select-window-9)
    (require 'winum)
    (winum-mode 1)
    (require 'which-key)
    (which-key-mode 1)
    (require 'vertico)
    (vertico-mode 1)
    (keymap-set vertico-map "C-j" #'vertico-next)
    (keymap-set vertico-map "C-k" #'vertico-previous)
    (require 'vertico-directory)
    (keymap-set vertico-map "RET" #'vertico-directory-enter)
    (keymap-set vertico-map "DEL" #'vertico-directory-delete-char)
    (require 'orderless)
    (require 'marginalia)
    (marginalia-mode 1)
    (require 'consult)
    (keymap-global-set "<remap> <switch-to-buffer>" #'consult-buffer)
    (keymap-global-set "<remap> <yank-pop>" #'consult-yank-pop)
    (require 'embark)
    (keymap-global-set "C-." #'embark-act)
    (keymap-global-set "M-." #'embark-dwim)
    (require 'embark-consult)
    (require 'corfu)
    (global-corfu-mode 1)
    (require 'corfu-popupinfo)
    (corfu-popupinfo-mode 1)
    (require 'corfu-history)
    (corfu-history-mode 1)
    (require 'cape)
    (add-hook 'completion-at-point-functions #'cape-file)
    (add-hook 'completion-at-point-functions #'cape-dabbrev 90)
    (autoload 'magit-status "magit" nil t)
    (setq-default indent-tabs-mode nil
                  fill-column 88
                  mode-line-format '("%e " (:eval (winum-get-number-string)) "  %b"
                                     (:eval (when (buffer-modified-p) " ●"))
                                     "  %m  " vc-mode mode-line-format-right-align "%l:%C "))
    (let ((backups (expand-file-name "backups" phimacs-state-directory))
          (autosaves (expand-file-name "autosaves" phimacs-state-directory)))
      (dolist (directory (list backups autosaves))
        (make-directory directory t) (set-file-modes directory #o700))
      (setq backup-directory-alist `(("." . ,backups))
            auto-save-file-name-transforms `((".*" ,autosaves t))))
    (setq savehist-file (expand-file-name "history.eld" phimacs-state-directory)
          recentf-save-file (expand-file-name "recentf.eld" phimacs-state-directory)
          save-place-file (expand-file-name "places.eld" phimacs-state-directory)
          custom-file (expand-file-name "custom.el" phimacs-state-directory)
          xterm-extra-capabilities (and phimacs-enable-osc52 '(setSelection)))
    ;; Emacs never loads `custom-file' itself; without this, saved answers such as
    ;; trusted directory-local variables are written but forgotten on restart.
    (load custom-file t t)
    (savehist-mode 1)
    (save-place-mode 1)
    (winner-mode 1)
    (column-number-mode 1)
    (add-to-list 'display-buffer-alist
                 '("\\*\\(?:Messages\\|Warnings\\|Help\\|Backtrace\\|Compile-Log\\)\\*"
                   display-buffer-in-side-window (side . bottom) (slot . 0) (window-height . 0.25)))
    (add-hook 'pilish-chat-mode-hook #'phimacs-modeline-chat)
    (add-hook 'pilish-input-mode-hook #'phimacs-modeline-input)
    (add-hook 'minibuffer-setup-hook #'phimacs-answer-buttons)
    (add-hook 'minibuffer-exit-hook #'phimacs-remove-answer-buttons)
    (add-hook 'after-make-frame-functions #'phimacs-tty-frame)
    (add-hook 'tty-setup-hook #'phimacs-tty-frame)
    (unless noninteractive (phimacs-tty-frame))
    (setq phimacs--ui-enabled t)))

(provide 'phimacs-ui)
;;; phimacs-ui.el ends here
