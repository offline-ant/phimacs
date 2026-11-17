;;; pi-deck-available.el --- Live root runtimes without a view here -*- lexical-binding: t; -*-

;; SPDX-License-Identifier: MIT

;;; Commentary:

;; Pilish's runtime watch reports every live runtime.  A root without a
;; tracked view here (closing views included) is available: the sidebar lists
;; it under the space of its directory, or "other", and selecting it attaches
;; it.  Workers arrive through their parent; interactive forks through their
;; creator.
;;
;; A root appearing after the first snapshot since enable is new until it is
;; selected or attached.  Marks are keyed by session file, so a pimux service
;; restart, which restores roots under new mux IDs, keeps a root's mark and
;; does not mark it again: a key that left and comes back from a different
;; pimux service is a restoration, while one coming back from the same service
;; was started anew.  Nothing here starts, attaches or stops a runtime by
;; itself.

;;; Code:

(require 'pi-deck-core)
(require 'pi-deck-spaces)
(require 'pi-deck-runtime)

(declare-function pilish-runtime-configured-p "pilish-runtime-process" ())
(declare-function pilish-runtime-watch-start "pilish-runtime-watch" ())
(declare-function pilish-runtime-watch-stop "pilish-runtime-watch" ())

(defface pi-deck-new '((t :inherit success :weight bold))
  "Face for the new mark of runtimes that appeared while Emacs ran."
  :group 'pi-deck)

(defvar pi-deck--available nil
  "Live root runtimes of the latest snapshot, or nil without one.")
(defvar pi-deck--available-primed nil
  "Non-nil once a snapshot arrived since the mode was enabled.")
(defvar pi-deck--available-present (make-hash-table :test 'equal)
  "Keys of the latest snapshot's roots, mapped to their pimux service.")
(defvar pi-deck--available-gone (make-hash-table :test 'equal)
  "Keys of roots that left a snapshot, mapped to the service they had.")
(defvar pi-deck--available-new (make-hash-table :test 'equal)
  "Keys of roots marked new.")

(defun pi-deck--available-key (runtime)
  "Return RUNTIME's mark key: its session file, else its mux ID."
  (or (plist-get runtime :session-file) (plist-get runtime :mux-id)))

(defun pi-deck--available-root-p (runtime)
  "Return non-nil when RUNTIME is a live root."
  (and (equal (plist-get runtime :placement) "root")
       (not (equal (plist-get runtime :state) "stopped"))
       (plist-get runtime :mux-id)))

(defun pi-deck--on-runtimes (runtimes failure)
  "Record the RUNTIMES snapshot, or forget the listing after a watch FAILURE.
For `pilish-runtime-discovery-functions'."
  (if failure
      (setq pi-deck--available nil)
    (let ((roots (seq-filter #'pi-deck--available-root-p runtimes))
          (present (make-hash-table :test 'equal)))
      (dolist (runtime roots)
        (let ((key (pi-deck--available-key runtime))
              (service (plist-get runtime :service)))
          (puthash key service present)
          (when (eq (gethash key pi-deck--available-present 'absent) 'absent)
            (let ((gone (gethash key pi-deck--available-gone 'never)))
              (remhash key pi-deck--available-gone)
              ;; Unknown, or back from the same service: started anew.
              ;; Back from another service: restored, keeping its mark.
              (when (and pi-deck--available-primed
                         (or (eq gone 'never) (equal gone service)))
                (puthash key t pi-deck--available-new))))
          ;; A view holding its mux ID has seen it.  A launch still awaiting
          ;; its receipt only hides it: if that launch fails, it stays new.
          (when-let* ((agent (pi-deck--runtime-agent runtime))
                      ((plist-get (pi-deck-agent-runtime agent) :mux-id)))
            (remhash key pi-deck--available-new))))
      (maphash (lambda (key service)
                 (when (eq (gethash key present 'absent) 'absent)
                   (puthash key service pi-deck--available-gone)))
               pi-deck--available-present)
      (setq pi-deck--available roots
            pi-deck--available-present present
            pi-deck--available-primed t)))
  (pi-deck--schedule-update))

(defun pi-deck-available-runtimes ()
  "Return live root runtimes without a tracked view here, oldest first.
A view launching a runtime holds it before its receipt arrives (see
`pi-deck--runtime-agent'), so its own runtime is never listed beside it."
  (sort (seq-remove #'pi-deck--runtime-agent pi-deck--available)
        :key (lambda (runtime) (or (plist-get runtime :started-at) ""))))

(defun pi-deck-available-new-p (runtime)
  "Return non-nil when RUNTIME is marked new."
  (gethash (pi-deck--available-key runtime) pi-deck--available-new))

(defun pi-deck-available-new ()
  "Return the available runtimes marked new, newest first."
  (reverse (seq-filter #'pi-deck-available-new-p (pi-deck-available-runtimes))))

(defun pi-deck-available-space (runtime)
  "Return the space of RUNTIME's directory, or nil for \"other\"."
  (pi-deck--space-for-dir (plist-get runtime :directory)))

(defun pi-deck-available-label (runtime)
  "Return RUNTIME's row label: its session name, else directory and short ID."
  (or (plist-get runtime :session-name)
      (let ((dir (plist-get runtime :directory)))
        (concat (if (stringp dir) (file-name-nondirectory (directory-file-name dir)) "?")
                " " (substring (plist-get runtime :mux-id)
                               0 (min 8 (length (plist-get runtime :mux-id))))))))

(defun pi-deck-available-status (runtime)
  "Return RUNTIME's attention status from its advertised activity."
  (cond ((or (plist-get runtime :blocked) (equal (plist-get runtime :state) "blocked")) 'blocked)
        ((member (plist-get runtime :state) '("working" "starting")) 'working)
        ((equal (plist-get runtime :state) "idle") 'idle)
        (t 'unknown)))

(defun pi-deck-attach-available (runtime)
  "Attach available RUNTIME and clear its new mark; return its agent."
  (remhash (pi-deck--available-key runtime) pi-deck--available-new)
  (prog1 (pi-deck-attach-runtime runtime)
    (pi-deck--schedule-update)))

(defun pi-deck--available-start ()
  "Follow live runtimes when detached runtimes are configured."
  (clrhash pi-deck--available-present)
  (clrhash pi-deck--available-gone)
  (clrhash pi-deck--available-new)
  (setq pi-deck--available nil pi-deck--available-primed nil)
  (when (pilish-runtime-configured-p)
    (pilish-runtime-watch-start)))

(defun pi-deck--available-stop ()
  "Stop following live runtimes and forget the listing."
  (pilish-runtime-watch-stop)
  (setq pi-deck--available nil pi-deck--available-primed nil))

(provide 'pi-deck-available)
;;; pi-deck-available.el ends here
