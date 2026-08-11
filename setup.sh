#!/bin/sh
# Backwards-compatible wrapper; the real logic is in scripts/setup.mjs.
exec node "$(dirname "$0")/scripts/setup.mjs" "$@"
