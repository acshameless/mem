#!/usr/bin/env bash
# mem one-command installer for macOS and Linux.
# Local:  bash install.sh
# Remote: MEM_REPO_URL=<git-url> bash install.sh
#         MEM_PACKAGE_URL=<zip-url> bash install.sh
set -euo pipefail

MEM_DIR="${MEM_DIR:-$HOME/Github/mem}"
MEM_REPO_URL="${MEM_REPO_URL:-}"
MEM_PACKAGE_URL="${MEM_PACKAGE_URL:-}"
SKIP_MODEL="${MEM_SKIP_MODEL:-0}"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"

log() { printf '%s %s\n' "$(date +%H:%M:%S)" "$*"; }
fail() { echo "ERROR: $*" >&2; exit 1; }
is_repo() { [[ -f "$1/package.json" && -d "$1/src" ]]; }

ensure_node() {
  if command -v node >/dev/null 2>&1; then
    local major
    major="$(node -p 'process.versions.node.split(".")[0]')"
    if [[ "$major" -ge 24 ]]; then
      log "Node $(node -v) ok"
      return 0
    fi
    log "Node $(node -v) is too old; trying to install Node 24"
  else
    log "Node.js not found; trying to install Node 24"
  fi

  if [[ "$(uname -s)" == "Darwin" ]] && command -v brew >/dev/null 2>&1; then
    log "installing Node via Homebrew"
    brew install node >/dev/null 2>&1 || true
  fi
  if command -v node >/dev/null 2>&1 && [[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 24 ]]; then
    log "Node $(node -v) installed"
    return 0
  fi

  log "falling back to the official Node 24 tarball (~/.local/node)"
  local os arch ver url
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"
  case "$arch" in
    arm64|aarch64) arch="arm64" ;;
    x86_64|amd64) arch="x64" ;;
    *) fail "unsupported architecture: $arch" ;;
  esac
  ver="$(curl -fsSL https://nodejs.org/dist/index.json \
    | tr ',' '\n' | grep -o '"version":"v24[^"]*"' | head -1 | sed 's/.*"v\([0-9.]*\)"/v\1/')"
  [[ -n "$ver" ]] || fail "cannot detect a Node 24 release; install Node 24 manually from https://nodejs.org"
  url="https://nodejs.org/dist/$ver/node-$ver-$os-$arch.tar.gz"
  mkdir -p "$HOME/.local/node"
  log "downloading $url"
  curl -fsSL "$url" | tar -xz -C "$HOME/.local/node" --strip-components=1
  export PATH="$HOME/.local/node/bin:$PATH"
  command -v node >/dev/null 2>&1 || fail "portable Node install failed"
  log "Node $(node -v) installed to ~/.local/node"
  log 'add this to your shell profile:  export PATH="$HOME/.local/node/bin:$PATH"'
}

ensure_repo() {
  if is_repo "$script_dir"; then
    cd "$script_dir"
    log "installing from $script_dir"
    return 0
  fi
  mkdir -p "$(dirname "$MEM_DIR")"
  if is_repo "$MEM_DIR"; then
    cd "$MEM_DIR"
    if [[ -d .git && -n "$MEM_REPO_URL" ]]; then
      log "updating existing checkout"
      git pull --ff-only --quiet || log "git pull skipped"
    fi
    return 0
  fi
  if [[ -n "$MEM_PACKAGE_URL" ]]; then
    local tmp root
    tmp="$(mktemp -d)"
    log "downloading package"
    curl -fsSL "$MEM_PACKAGE_URL" -o "$tmp/pkg"
    mkdir -p "$tmp/out"
    case "$MEM_PACKAGE_URL" in
      *.zip) unzip -q "$tmp/pkg" -d "$tmp/out" ;;
      *) tar -xzf "$tmp/pkg" -C "$tmp/out" ;;
    esac
    root="$(find "$tmp/out" -maxdepth 2 -name package.json -print -quit | xargs dirname)"
    [[ -n "$root" && -d "$root" ]] || fail "package does not contain package.json"
    mkdir -p "$MEM_DIR"
    cp -R "$root/." "$MEM_DIR/"
    cd "$MEM_DIR"
    log "installed to $MEM_DIR"
    return 0
  fi
  if [[ -n "$MEM_REPO_URL" ]]; then
    log "cloning $MEM_REPO_URL"
    git clone --depth 1 "$MEM_REPO_URL" "$MEM_DIR"
    cd "$MEM_DIR"
    return 0
  fi
  fail "run inside the repo, or set MEM_REPO_URL / MEM_PACKAGE_URL"
}

install_platform() {
  local here="$PWD"
  chmod +x bin/memctl.mjs bin/memd.mjs 2>/dev/null || true
  bash "$here/scripts/install-cli.sh"
  if [[ "$SKIP_MODEL" != "1" ]]; then
    bash "$here/scripts/configure-model.sh"
  fi
  bash "$here/scripts/install-hook.sh"
  bash "$here/scripts/install-precompact-hook.sh"
  bash "$here/scripts/install-mcp.sh"
  if [[ "$(uname -s)" == "Darwin" ]]; then
    bash "$here/scripts/install-launchd.sh"
    bash "$here/scripts/install-review-reminder.sh"
  else
    bash "$here/scripts/install-systemd.sh"
  fi
}

log "== mem installer =="
ensure_repo
ensure_node
if [[ "${MEM_DRY_RUN:-0}" == "1" ]]; then
  log "dry run: repo ready at $PWD"
  exit 0
fi
install_platform
if [[ "${MEM_SKIP_EMBEDDING:-0}" != "1" ]]; then
  log "preparing local EmbeddingGemma 2 (skip with MEM_SKIP_EMBEDDING=1)"
  node "$PWD/src/cli/memctl.ts" embedding-install || log "embedding bootstrap skipped"
fi
node "$PWD/src/cli/memctl.ts" status || true
echo
echo "Done. Restart VS Code and check Cline Settings > Hooks / MCP Servers."
if [[ "$SKIP_MODEL" == "1" ]]; then
  echo "Model key skipped (MEM_SKIP_MODEL=1). Configure later: bash scripts/configure-model.sh"
fi
