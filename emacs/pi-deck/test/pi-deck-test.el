;;; pi-deck-test.el --- pi-deck unit and integration tests -*- lexical-binding: t; -*-

;; SPDX-License-Identifier: MIT

;;; Commentary:

;; Loads the imported UI suite: one file per mechanism, sharing
;; pi-deck-test-fixtures.el.

;;; Code:

(require 'pi-deck-status-test)
(require 'pi-deck-layout-test)
(require 'pi-deck-ui-test)
(require 'pi-deck-group-sidebar-test)
(require 'pi-deck-group-editor-test)
(require 'pi-deck-close-test)
(require 'pi-deck-orchestration-test)
(require 'pi-deck-persistence-test)
(require 'pi-deck-group-model-test)

(provide 'pi-deck-test)
;;; pi-deck-test.el ends here
