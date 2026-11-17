#!/usr/bin/env bash
# run-bench.sh - Run Pilish table rendering benchmarks
#
# Usage:
#   ./bench/run-bench.sh              # GUI via xvfb (primary lane)
#   ./bench/run-bench.sh --batch      # batch mode (secondary comparison)
#   ./bench/run-bench.sh -c 10        # 10 repetitions instead of default 5
#   ./bench/run-bench.sh --batch -c 3 # batch with 3 reps
#
# The primary lane uses xvfb-run for GUI Emacs, because string-width and
# font-lock consult font metrics in GUI mode.  Batch numbers are faster
# (~2x) but less realistic.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
EMACS_BIN="${EMACS:-emacs}"
# These UI checks do not test accessibility or own an AT-SPI service.
export NO_AT_BRIDGE=1 GTK_A11Y=none

BATCH=0
REPS=5

while [[ $# -gt 0 ]]; do
    case "$1" in
        --batch) BATCH=1; shift ;;
        -c) shift; REPS="${1:-5}"; shift ;;
        *) shift ;;
    esac
done

for name in PACKAGE_USER_DIR GRAMMAR_DIR PILISH_TEST_CACHE_DIR; do
    value="${!name:-}"
    if [[ "$value" != /* || ! -d "$value" ]]; then
        printf 'ERROR: Set %s to an existing absolute private directory\n' "$name" >&2
        exit 2
    fi
done

EMACS_INIT=(
    -Q -L "$PROJECT_DIR" -L "$PROJECT_DIR/scripts"
    --eval '(setq load-prefer-newer t)'
    -l pilish-build --eval '(pilish-build-test-environment)'
    -l "$SCRIPT_DIR/pilish-bench.el"
)

echo "=== Pilish Table Rendering Benchmarks ==="
echo "Project: $PROJECT_DIR"

if [ "$BATCH" = "1" ]; then
    echo "Mode: batch (secondary lane), $REPS reps"
    echo ""
    "$EMACS_BIN" "${EMACS_INIT[@]}" --batch \
        -f pilish-bench-run-batch -c "$REPS" 2>&1
else
    echo "Mode: GUI via xvfb (primary lane), $REPS reps"
    echo ""
    if ! command -v xvfb-run &>/dev/null; then
        echo "ERROR: xvfb-run not found. Install xvfb or use --batch."
        exit 1
    fi
    xvfb-run -a env GDK_BACKEND=x11 PATH="$PATH" \
        "$EMACS_BIN" "${EMACS_INIT[@]}" \
        --eval "(progn
                  (let ((standard-output #'external-debugging-output))
                    (pilish-bench-run $REPS))
                  (kill-emacs 0))" </dev/null 2>&1
fi
