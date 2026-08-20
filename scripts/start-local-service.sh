#!/bin/sh
set -eu

cd "$(dirname "$0")/.."
export DEMO_MODE=true
exec sh scripts/run-node.sh src/server.mjs
