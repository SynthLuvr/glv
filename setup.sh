#!/bin/sh
# Thin wrapper kept for backwards compatibility. The real, cross-platform
# setup logic lives in scripts/setup.mjs — plain Node ESM, so it runs on a
# fresh clone before dependencies are installed and works on Windows too.
# Primary entry point:  node scripts/setup.mjs
exec node "$(dirname "$0")/scripts/setup.mjs" "$@"
