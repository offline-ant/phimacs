#!/bin/sh
# Native faux-only smoke from explicit verified assets and a compiled checkout.
set -eu
exec node "$(dirname "$0")/smoke.mjs" "$@"
