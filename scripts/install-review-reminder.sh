#!/usr/bin/env bash
# Install a daily macOS notification for pending memory candidates.
set -euo pipefail

LABEL="com.shameless.mem.review"
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
    <string>$SERVER_DIR/src/cli/memctl.ts</string>
    <string>review</string>
    <string>--notify</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$SERVER_DIR</string>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>10</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>$STORE/logs/review.log</string>
  <key>StandardErrorPath</key>
  <string>$STORE/logs/review.err.log</string>
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
echo "installed $LABEL (daily 10:00)"
