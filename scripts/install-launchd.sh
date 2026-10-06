#!/usr/bin/env bash
# Install the mem daemon as a launchd agent.
set -euo pipefail

LABEL="com.shameless.mem.daemon"
AGENTS_DIR="${LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
STORE="${MEM_HOME:-$HOME/.llm-memory}"
SERVER_DIR="${MEM_SERVER_DIR:-$HOME/Github/mem}"
NODE_BIN="${MEM_NODE_BIN:-$(command -v node)}"
PLIST="$AGENTS_DIR/$LABEL.plist"

mkdir -p "$AGENTS_DIR" "$STORE/logs"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$SERVER_DIR/src/daemon/memd.ts</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$SERVER_DIR</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$STORE/logs/memd.out.log</string>
  <key>StandardErrorPath</key>
  <string>$STORE/logs/memd.err.log</string>
</dict>
</plist>
EOF

plutil -lint "$PLIST"

if [[ "${MEM_LAUNCHCTL_DRY_RUN:-}" == "1" ]]; then
  echo "dry run: plist written, launchctl skipped"
  exit 0
fi

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || launchctl load -w "$PLIST"
launchctl kickstart -k "gui/$(id -u)/$LABEL" 2>/dev/null || true

echo "installed and started $LABEL"
echo "plist: $PLIST"
echo "logs:  $STORE/logs/memd.out.log"
echo
echo "If the manual daemon is still running in a terminal, stop it with Ctrl+C."
