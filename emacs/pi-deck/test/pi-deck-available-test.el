;;; pi-deck-available-test.el --- Live runtimes without a view here -*- lexical-binding: t; -*-
;; SPDX-License-Identifier: MIT

;; Deck's side of the runtime watch with stubbed Pilish; the watch process
;; itself is Pilish's (test/pilish-runtime-watch-test.el).

(require 'ert)
(require 'pi-deck)
(require 'pi-deck-detached-test)

;; The fixture binds these dynamically; declare them special here too.
(defvar pi-deck-detached--views)
(defvar pi-deck-detached--calls)
(defvar pi-deck-detached--stop-callback)

(defun pi-deck-available-test--runtime (id &rest overrides)
  "Return a normalized live root runtime ID with OVERRIDES."
  (let ((runtime (list :protocol 2 :mux-id id :socket (format "/private/%s.sock" id)
                       :session-file (format "/private/%s.jsonl" id)
                       :directory "/private/elsewhere/" :placement "root" :state "idle"
                       :service '(:pid 1 :startTime "1" :bootId "boot")
                       :started-at (format "2026-11-12T20:00:%s.000Z" id))))
    (while overrides
      (setq runtime (plist-put runtime (pop overrides) (pop overrides))))
    runtime))

(defmacro pi-deck-available-test--with (&rest body)
  "Run BODY in the detached desktop fixture with fresh availability state."
  (declare (indent 0))
  `(let ((pi-deck--available nil) (pi-deck--available-primed nil)
         (pi-deck--available-present (make-hash-table :test 'equal))
         (pi-deck--available-gone (make-hash-table :test 'equal))
         (pi-deck--available-new (make-hash-table :test 'equal)))
     (pi-deck-detached--with-desktop ,@body)))

(defun pi-deck-available-test--ids (runtimes)
  "Return the mux IDs of RUNTIMES."
  (mapcar (lambda (runtime) (plist-get runtime :mux-id)) runtimes))

(defun pi-deck-available-test--sidebar ()
  "Return the rendered sidebar text of the current deck state."
  (with-temp-buffer
    (pi-deck-sidebar-mode)
    (pi-deck-sidebar--render)
    (buffer-string)))

(ert-deftest pi-deck-available-lists-unviewed-roots-and-marks-later-ones-new ()
  (pi-deck-available-test--with
    (let ((old (pi-deck-available-test--runtime "1"))
          (worker (pi-deck-available-test--runtime "2" :placement "worker"))
          (fork (pi-deck-available-test--runtime "3" :placement "interactive-fork"))
          (stopped (pi-deck-available-test--runtime "4" :state "stopped"))
          (viewed (pi-deck-available-test--runtime "5"))
          (closing (pi-deck-available-test--runtime "6"))
          (later (pi-deck-available-test--runtime "7")))
      (pi-deck-detached--agent directory "viewed" viewed)
      (setf (pi-deck-agent-closing (pi-deck-detached--agent directory "closing" closing)) t)
      (pi-deck--on-runtimes (list old worker fork stopped viewed closing) nil)
      ;; Roots only; tracked views, closing ones included, are not available.
      (should (equal (pi-deck-available-test--ids (pi-deck-available-runtimes)) '("1")))
      (should-not (pi-deck-available-new))
      (pi-deck--on-runtimes (list old viewed closing later) nil)
      (should (equal (pi-deck-available-test--ids (pi-deck-available-runtimes)) '("1" "7")))
      (should (equal (pi-deck-available-test--ids (pi-deck-available-new)) '("7")))
      ;; A runtime that leaves takes its row with it.
      (pi-deck--on-runtimes (list later) nil)
      (should (equal (pi-deck-available-test--ids (pi-deck-available-runtimes)) '("7"))))))

(ert-deftest pi-deck-available-new-marks-follow-the-session-file-across-restarts ()
  (pi-deck-available-test--with
    (let* ((restarted '(:pid 2 :startTime "2" :bootId "boot"))
           (thread (pi-deck-available-test--runtime "1" :session-file "/private/thread.jsonl"))
           (other (pi-deck-available-test--runtime "2")))
      (pi-deck--on-runtimes (list other) nil)
      (pi-deck--on-runtimes (list other thread) nil)
      (should (pi-deck-available-new-p thread))
      ;; The service restarts: roots leave and come back under new mux IDs.
      (pi-deck--on-runtimes nil nil)
      (pi-deck--on-runtimes
       (list (plist-put (plist-put (copy-sequence other) :mux-id "other-successor")
                        :service restarted)
             (plist-put (plist-put (copy-sequence thread) :mux-id "thread-successor")
                        :service restarted))
       nil)
      (should (equal (pi-deck-available-test--ids (pi-deck-available-new)) '("thread-successor")))
      ;; Selecting clears the mark; a restored root never gets one back.
      (pi-deck-attach-available (car (pi-deck-available-new)))
      (should-not (pi-deck-available-new))
      ;; A conversation started again by the running service is new again.
      (let ((again (plist-put (copy-sequence thread) :mux-id "thread-again")))
        (plist-put again :service restarted)
        (pi-deck--on-runtimes nil nil)
        (pi-deck--on-runtimes (list again) nil)
        (should (pi-deck-available-new-p again))))))

(ert-deftest pi-deck-available-watch-failure-hides-rows-without-forgetting-marks ()
  (pi-deck-available-test--with
    (let ((one (pi-deck-available-test--runtime "1"))
          (two (pi-deck-available-test--runtime "2")))
      ;; A failure before the first snapshot does not prime the marks.
      (pi-deck--on-runtimes nil "watch failed")
      (pi-deck--on-runtimes (list one) nil)
      (should-not (pi-deck-available-new))
      (pi-deck--on-runtimes (list one two) nil)
      (pi-deck--on-runtimes nil "watch failed")
      (should-not (pi-deck-available-runtimes))
      (pi-deck--on-runtimes (list one two) nil)
      (should (equal (pi-deck-available-test--ids (pi-deck-available-new)) '("2"))))))

(ert-deftest pi-deck-available-sidebar-rows-sit-in-their-space-and-attach-on-selection ()
  (pi-deck-available-test--with
    (pi-deck--register-space "project" directory)
    (let ((pi-deck-sidebar-width 40)
          (here (pi-deck-available-test--runtime
                 "1" :directory (expand-file-name "sub/" directory) :session-name "rs thread"))
          (elsewhere (pi-deck-available-test--runtime "2" :mux-id "abcdef0123456789")))
      (pi-deck--on-runtimes nil nil)
      (pi-deck--on-runtimes (list here elsewhere) nil)
      (should (equal (pi-deck-available-space here) "project"))
      (should-not (pi-deck-available-space elsewhere))
      (let ((text (pi-deck-available-test--sidebar)))
        (should (string-match-p "project (0)[^\n]*\n[^\n]*rs thread new\n" text))
        (should (string-match-p "other (0)[^\n]*\n[^\n]*elsewhere abcdef01 new\n" text)))
      (should (string-match-p "2 new" (pi-deck-sidebar-header)))
      (with-temp-buffer
        (pi-deck-sidebar-mode)
        (pi-deck-sidebar--render)
        (goto-char (point-min))
        (pi-deck-sidebar-next 1)
        (should (equal (plist-get (get-text-property (point) 'pi-deck-available) :mux-id) "1"))
        (pi-deck-sidebar-next 1)
        (pi-deck-sidebar-next 1)
        (should (equal (plist-get (get-text-property (point) 'pi-deck-available) :mux-id)
                       "abcdef0123456789"))
        (pi-deck-sidebar-next -1)
        (pi-deck-sidebar-jump))
      (should (equal (cadr (assq 'attach pi-deck-detached--calls)) here))
      (let ((agent (pi-deck--runtime-agent here)))
        (should agent)
        (should (equal (pi-deck-agent-space agent) "project")))
      (should (equal (pi-deck-available-test--ids (pi-deck-available-runtimes)) '("abcdef0123456789")))
      (should (string-match-p "1 new" (pi-deck-sidebar-header))))))

(ert-deftest pi-deck-available-hides-only-the-runtime-a-view-is-launching ()
  (pi-deck-available-test--with
    (pi-deck--register-space "project" directory)
    ;; A second space on the same directory: discovery places every runtime of
    ;; the directory in the first, while the launching view belongs to the second.
    (pi-deck--register-space "project<2>" directory)
    (let* ((older (pi-deck-available-test--runtime "1" :directory directory :operation-id "older-op"
                                                   :session-name "older"))
           (concurrent (pi-deck-available-test--runtime "2" :directory directory
                                                        :operation-id "unrelated-op"
                                                        :session-name "concurrent"))
           (started (pi-deck-available-test--runtime "3" :directory directory
                                                     :operation-id "launch-op"
                                                     :session-name "started"))
           (elsewhere (pi-deck-available-test--runtime "4" :operation-id "elsewhere-op"))
           (pending t)
           view)
      (cl-letf (((symbol-function 'pilish-session-runtime-pending-p)
                 (lambda (buffer) (and pending view (eq buffer (pi-deck-agent-buffer view))))))
        (pi-deck--on-runtimes nil nil)
        ;; A root of the directory is new before anything launches there.
        (pi-deck--on-runtimes (list older) nil)
        (should (pi-deck-available-new-p older))
        ;; The view launches with only its chosen operation ID, no mux ID yet.
        (setq view (pi-deck-detached--agent
                    directory "launching" '(:protocol 2 :state "starting" :operation-id "launch-op")))
        (setf (pi-deck-agent-assigned-space view) "project<2>")
        (should (equal (pi-deck-available-space started) "project"))
        ;; The pre-existing new root stays listed during the unrelated launch.
        (should (equal (pi-deck-available-test--ids (pi-deck-available-runtimes)) '("1")))
        (should (equal (pi-deck-available-test--ids (pi-deck-available-new)) '("1")))
        ;; Discovery lists the launched runtime before the view has its receipt,
        ;; together with a concurrently started unrelated root of the directory.
        (pi-deck--on-runtimes (list older concurrent started elsewhere) nil)
        (should (eq (pi-deck--runtime-agent started) view))
        (should-not (pi-deck--runtime-agent concurrent))
        (should-not (pi-deck--runtime-agent older))
        (should (equal (pi-deck-available-test--ids (pi-deck-available-runtimes)) '("1" "2" "4")))
        (should (equal (pi-deck-available-test--ids (pi-deck-available-new)) '("4" "2" "1")))
        (should (string-match-p "3 new" (pi-deck-sidebar-header)))
        (let ((text (pi-deck-available-test--sidebar)))
          ;; The launching agent has one row (its view), never a second new one.
          (should-not (string-search (pi-deck-available-label started) text))
          (should (string-search (pi-deck-available-label concurrent) text))
          (should (string-search (pi-deck-available-label older) text)))
        ;; A failed launch that never claimed it lists it again, still new.
        (setq pending nil)
        (should-not (pi-deck--runtime-agent started))
        (should (equal (pi-deck-available-test--ids (pi-deck-available-runtimes)) '("1" "2" "3" "4")))
        (should (equal (pi-deck-available-test--ids (pi-deck-available-new)) '("4" "3" "2" "1")))
        ;; A launch whose receipt named its runtime holds it by mux ID; the
        ;; next snapshot clears its mark.
        (setq pending t)
        (puthash (pi-deck-agent-buffer view)
                 (plist-put (gethash (pi-deck-agent-buffer view) pi-deck-detached--views)
                            :runtime (list :protocol 2 :state "starting" :mux-id "3"
                                           :operation-id "launch-op"))
                 pi-deck-detached--views)
        (should (eq (pi-deck--runtime-agent started) view))
        (pi-deck--on-runtimes (list older concurrent started elsewhere) nil)
        (should-not (pi-deck-available-new-p started))
        (should (equal (pi-deck-available-test--ids (pi-deck-available-runtimes)) '("1" "2" "4")))
        ;; A view holding a mux ID never claims another runtime by operation ID.
        (should-not (pi-deck--runtime-agent
                     (pi-deck-available-test--runtime "5" :directory directory
                                                      :operation-id "launch-op")))))))

(ert-deftest pi-deck-available-next-attention-attaches-the-newest-new-runtime ()
  (pi-deck-available-test--with
    (let ((older (pi-deck-available-test--runtime "1"))
          (newer (pi-deck-available-test--runtime "2")))
      (pi-deck--on-runtimes nil nil)
      (pi-deck--on-runtimes (list older newer) nil)
      (pi-deck-next-attention)
      (should (equal (pi-deck-available-test--ids
                      (mapcar #'cadr (seq-filter (lambda (call) (eq (car call) 'attach))
                                                 pi-deck-detached--calls)))
                     '("2")))
      (pi-deck-next-attention)
      (pi-deck--on-runtimes nil nil)
      (should-error (pi-deck-next-attention) :type 'user-error))))

(ert-deftest pi-deck-available-attach-refuses-a-view-whose-close-is-pending ()
  (pi-deck-available-test--with
    (let* ((runtime (pi-deck-available-test--runtime "1"))
           (agent (pi-deck-detached--agent directory "closing" runtime)))
      (setf (pi-deck-agent-closing agent) t)
      (should-error (pi-deck-attach-runtime runtime) :type 'user-error)
      (should-not (assq 'attach pi-deck-detached--calls)))))

(ert-deftest pi-deck-available-mode-follows-the-watch-only-when-configured ()
  (pi-deck-available-test--with
    (let (calls)
      (pi-deck-mode -1)
      (cl-letf (((symbol-function 'pilish-runtime-watch-start) (lambda () (push 'start calls)))
                ((symbol-function 'pilish-runtime-watch-stop) (lambda () (push 'stop calls))))
        (pi-deck-mode 1)
        (pi-deck-mode -1)
        (should (equal calls '(stop)))
        (setq calls nil)
        (cl-letf (((symbol-function 'pilish-runtime-configured-p) (lambda () t)))
          (pi-deck-mode 1)
          (should (memq #'pi-deck--on-runtimes pilish-runtime-discovery-functions))
          (pi-deck-mode -1))
        (should (equal calls '(stop start)))
        (should-not (memq #'pi-deck--on-runtimes pilish-runtime-discovery-functions)))
      (pi-deck-mode 1))))

(provide 'pi-deck-available-test)
;;; pi-deck-available-test.el ends here
