#!/bin/zsh
set -e
PILOT_APP_DIR="${0:A:h}"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "$PILOT_APP_DIR"
print "Keep this window open while using TokenPilot."
print "Open the local address printed below in your browser."
exec node src/cli.cjs serve
