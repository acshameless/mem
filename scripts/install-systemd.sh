#!/usr/bin/env bash
# Install mem daemon and review reminder as systemd user units (Linux).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
NODE_BIN="${MEM_NODE_BIN:-$(command -v node)}"
mkdir -p "$UNIT_DIR"

cat > "$UNIT_DIR/mem-daemon.service" <<EOF
[Unit]
Description=mem daemon (personal LLM memory for Cline)
After=default.target

[Service]
Type=simple
WorkingDirectory=$ROOT
ExecStart=$NODE_BIN $ROOT/src/daemon/memd.ts
Restart=always
RestartSec=5
Environment=MEM_LOG_FILE=1

[Install]
WantedBy=default.target
EOF

cat > "$UNIT_DIR/mem-review.service" <<EOF
[Unit]
Description=mem review reminder

[Service]
Type=oneshot
WorkingDirectory=$ROOT
ExecStart=$NODE_BIN $ROOT/src/cli/memctl.ts review --notify
EOF

cat > "$UNIT_DIR/mem-review.timer" <<EOF
[Unit]
Description=Daily mem review reminder

[Timer]
OnCalendar=*-*-* 10:00:00
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now mem-daemon.service
systemctl --user enable --now mem-review.timer
echo "installed mem-daemon.service and mem-review.timer"
systemctl --user --no-pager status mem-daemon.service | head -6 || true
echo
echo "Logs: journalctl --user -u mem-daemon -f"
echo "Keep running after logout: sudo loginctl enable-linger $USER"
