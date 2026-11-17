#!/usr/bin/env bash
# Quality checks for Pilish - run before commits
#
# Usage:
#   ./scripts/check.sh              # Full compile/lint/unit checks
#   ./scripts/check.sh --integration # Also run fake-backed subprocess checks
#
# Prepared package/grammar/cache inputs are required; see README.org.
#   ./scripts/check.sh -i            # Short form

set -e

cd "$(dirname "$0")/.."

for arg in "$@"; do
    case $arg in
        --integration|-i)
            RUN_INTEGRATION=true
            shift
            ;;
        --help|-h)
            echo "Usage: $0 [--integration|-i]"
            echo "  --integration, -i  Include fake-backed subprocess tests"
            exit 0
            ;;
    esac
done

make check

if [ "${RUN_INTEGRATION:-false}" = true ]; then
    make test-integration-fake
fi
