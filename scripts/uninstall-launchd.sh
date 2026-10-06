#!/usr/bin/env bash
# Stop and remove the mem launchd agent. Keeps the database and logs.
set -euo pipefail

LABEL="com.shameless.mem.daemon"
AGENTS_DIR="${LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
PLIST="$AGENTS_DIR/$LABEL.plist"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || launchctl unload -w "$PLIST" 2>/dev/null || true
rm -f "$PLIST"
echo "removed $LABEL (database and logs kept)"
