#!/bin/sh
set -eu

if command -v node >/dev/null 2>&1; then
  exec node --env-file-if-exists=.env "$@"
fi

codex_node_path="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
if [ -x "$codex_node_path" ]; then
  exec "$codex_node_path" --env-file-if-exists=.env "$@"
fi

echo "Node.js 22 or newer is required and was not found." >&2
exit 127
