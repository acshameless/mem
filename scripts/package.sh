#!/usr/bin/env bash
# Build a distributable zip for macOS/Windows deployment.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(node -p "require('$ROOT/package.json').version")"
NAME="mem-v$VERSION"
OUT="$ROOT/dist"
STAGE="$OUT/$NAME"

mkdir -p "$OUT"
if [[ -d "$STAGE" ]]; then rm -r "$STAGE"; fi
if [[ -f "$OUT/$NAME.zip" ]]; then rm "$OUT/$NAME.zip"; fi
mkdir -p "$STAGE"

rsync -a \
  --exclude '.git' \
  --exclude 'var' \
  --exclude 'node_modules' \
  --exclude 'dist' \
  --exclude '.DS_Store' \
  "$ROOT/" "$STAGE/"

COMMIT="unknown"
if command -v git >/dev/null 2>&1 && git -C "$ROOT" rev-parse --short HEAD >/dev/null 2>&1; then
  COMMIT="$(git -C "$ROOT" rev-parse --short HEAD)"
fi
cat > "$STAGE/PACKAGE.json" <<EOF
{
  "name": "mem",
  "version": "$VERSION",
  "commit": "$COMMIT",
  "built_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "platforms": ["macos", "windows"]
}
EOF

(cd "$OUT" && zip -qr "$NAME.zip" "$NAME")
(cd "$OUT" && shasum -a 256 "$NAME.zip" > "$NAME.zip.sha256")

echo "package : $OUT/$NAME.zip"
echo "sha256  : $(cat "$OUT/$NAME.zip.sha256")"
echo "size    : $(du -h "$OUT/$NAME.zip" | cut -f1)"
