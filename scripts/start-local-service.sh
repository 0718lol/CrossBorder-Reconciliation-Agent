#!/bin/sh
set -eu

cd "$(dirname "$0")/.."
exec sh scripts/run-node.sh src/server.mjs
