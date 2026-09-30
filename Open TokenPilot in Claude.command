#!/bin/zsh
set -e
PILOT_PLUGIN_DIR="${0:A:h}"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v claude >/dev/null; then
  print "Install Claude Code first, then open this launcher again."
  read "?Press Return to close."
  exit 1
fi
if [[ ! -d "$PILOT_PLUGIN_DIR/node_modules/@modelcontextprotocol/sdk" ]]; then
  cd "$PILOT_PLUGIN_DIR"
  npm ci
fi
cd "$HOME"
exec claude --plugin-dir "$PILOT_PLUGIN_DIR"
