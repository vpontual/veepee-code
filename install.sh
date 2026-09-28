#!/usr/bin/env bash
set -euo pipefail

# VEEPEE Code Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/vpontual/veepee-code/main/install.sh | bash

REPO="vpontual/veepee-code"
INSTALL_DIR="${VEEPEE_CODE_DIR:-$HOME/.veepee-code}"
MIN_NODE=20
NVM_VERSION="v0.40.3"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
DIM='\033[2m'
BOLD='\033[1m'
NC='\033[0m'

ok()   { echo -e "  ${GREEN}✓${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; }
info() { echo -e "  ${BLUE}▸${NC} $1"; }
warn() { echo -e "  ${YELLOW}⚠${NC} $1"; }

# Run a slow step with its output in a log and a running timer, so it never
# looks frozen: `npm ci` printed nothing for minutes and read as a hang (and
# once really was one — see NPM_FLAGS). On failure the log's tail is shown
# instead of being thrown away. Usage: run_step "Label" command args...
run_step() {
  local label="$1"; shift
  local log start pid rc
  log="$(mktemp)"
  start=$SECONDS
  "$@" >"$log" 2>&1 &
  pid=$!
  if [ -t 1 ]; then
    while kill -0 "$pid" 2>/dev/null; do
      printf "\r  ${BLUE}▸${NC} %s ${DIM}%ss${NC} " "$label" "$((SECONDS - start))"
      sleep 1
    done
    printf "\r\033[K"
  else
    info "$label"
  fi
  if wait "$pid"; then rc=0; else rc=$?; fi
  if [ "$rc" -eq 0 ]; then
    ok "${label%...} ${DIM}($((SECONDS - start))s)${NC}"
  else
    fail "${label%...} failed after $((SECONDS - start))s:"
    tail -n 20 "$log" | sed 's/^/      /'
  fi
  rm -f "$log"
  return "$rc"
}

# A fingerprint of a lock file, to skip reinstalling unchanged dependencies.
lock_sum() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1
}

# --no-audit / --no-fund: the audit is a POST to the registry after the install,
# and a stale connection left one hanging for 10+ minutes with every package
# already in place. Nothing here needs it. A fetch timeout turns any other dead
# connection into a retry instead of a hang.
NPM_FLAGS=(--ignore-scripts --no-audit --no-fund --fetch-timeout=60000 --fetch-retries=2)
install_deps() { npm ci "${NPM_FLAGS[@]}" || npm install "${NPM_FLAGS[@]}"; }

# ─── Full Install ────────────────────────────────────────────────────────────

echo ""
echo -e "  ${BOLD}⚡ VEEPEE Code Installer${NC}"
echo ""

# ─── Step 1: Node.js ─────────────────────────────────────────────────────────

ensure_node() {
  # Source nvm if available
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

  if command -v node &> /dev/null; then
    local ver
    ver=$(node -v | sed 's/v//' | cut -d. -f1)
    if [ "$ver" -ge "$MIN_NODE" ]; then
      ok "Node.js $(node -v)"
      return 0
    else
      warn "Node.js $(node -v) is too old (need v${MIN_NODE}+)"
    fi
  fi

  # Install nvm if needed
  if ! command -v nvm &> /dev/null; then
    info "Installing nvm..."
    curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_VERSION}/install.sh" | bash 2>/dev/null
    export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
    . "$NVM_DIR/nvm.sh"
  fi

  # Install Node via nvm
  info "Installing Node.js 22 via nvm..."
  nvm install 22 2>/dev/null
  nvm use 22 > /dev/null
  nvm alias default 22 > /dev/null
  ok "Node.js $(node -v) installed"
}

ensure_node

# Check npm
if ! command -v npm &> /dev/null; then
  fail "npm not found (should come with Node.js)"
  exit 1
fi
ok "npm $(npm -v)"

# ─── Step 2: Git + GitHub Auth ───────────────────────────────────────────────

if ! command -v git &> /dev/null; then
  fail "git is required"
  echo -e "  ${DIM}Install: brew install git (macOS) or sudo apt install git (Linux)${NC}"
  exit 1
fi
ok "git $(git --version | awk '{print $3}')"

CLONE_URL="https://github.com/${REPO}.git"

# ─── Step 3: Clone / Update ─────────────────────────────────────────────────

if [ -d "$INSTALL_DIR/.git" ]; then
  info "Updating existing installation..."
  cd "$INSTALL_DIR"
  git pull --ff-only
elif [ -d "$INSTALL_DIR" ]; then
  # Directory exists but isn't a git repo. ~/.veepee-code is also the CONFIG
  # dir (settings.json, sessions, skills, checkpoints), so it is adopted, never
  # deleted: this used to `rm -rf` it after saving only vcode.config.json and
  # .env. Clone beside it, move the .git in, and check out the tracked files;
  # untracked files (all of the config) are left exactly as they were.
  info "Adopting existing directory (config is kept)..."
  CLONE_TMP="$(mktemp -d)"
  git clone "$CLONE_URL" "$CLONE_TMP/repo"
  mv "$CLONE_TMP/repo/.git" "$INSTALL_DIR/.git"
  rm -rf "$CLONE_TMP"
  cd "$INSTALL_DIR"
  git reset --hard -q HEAD
else
  info "Cloning repository..."
  git clone "$CLONE_URL" "$INSTALL_DIR"
  cd "$INSTALL_DIR"
fi
ok "Source ready"

# ─── Step 4: Build ───────────────────────────────────────────────────────────

# npm ci wipes node_modules and reinstalls everything, which is minutes of work
# when nothing changed. The stamp lives inside node_modules, so any real
# reinstall (or a deleted node_modules) clears it.
DEPS_STAMP="node_modules/.vcode-lock-sha"
if [ -f "$DEPS_STAMP" ] && [ "$(cat "$DEPS_STAMP")" = "$(lock_sum package-lock.json)" ]; then
  ok "Dependencies unchanged"
else
  run_step "Installing dependencies..." install_deps
  lock_sum package-lock.json > "$DEPS_STAMP"
fi

run_step "Building..." npm run build

# The Remote Connect web UI is a separate Vite app that builds into dist/web.
#
# Best-effort on purpose. It needs its own npm install (React, Vite), which is
# a lot of bytes for someone who only ever uses the terminal — and rc.ts falls
# back to the legacy inline page when dist/web is absent, so a failure here
# costs the new UI and nothing else. Never let it fail the whole install.
#
# Skipped entirely with VEEPEE_SKIP_WEB=1.
if [ "${VEEPEE_SKIP_WEB:-0}" != "1" ] && [ -d web ]; then
  build_web() {
    cd web || return 1
    if ! { [ -f node_modules/.vcode-lock-sha ] && [ "$(cat node_modules/.vcode-lock-sha)" = "$(lock_sum package-lock.json)" ]; }; then
      install_deps && lock_sum package-lock.json > node_modules/.vcode-lock-sha || return 1
    fi
    npm run build
  }
  if ! run_step "Building the web UI..." build_web; then
    warn "Web UI build failed — /rc will serve the legacy page. Build it later with: (cd web && npm install && npm run build)"
  fi
fi

# ─── Step 5: Link binary ────────────────────────────────────────────────────

# Prefer npm link (uses nvm's bin dir, no sudo needed)
info "Linking vcode command..."
npm link --no-audit --no-fund >/dev/null 2>&1 && {
  ok "vcode linked via npm"
} || {
  # Fallback: manual symlink
  BIN_DIR="/usr/local/bin"
  if [ -w "$BIN_DIR" ]; then
    ln -sf "$INSTALL_DIR/dist/index.js" "$BIN_DIR/vcode"
    chmod +x "$BIN_DIR/vcode"
  else
    sudo ln -sf "$INSTALL_DIR/dist/index.js" "$BIN_DIR/vcode"
    sudo chmod +x "$BIN_DIR/vcode"
  fi
  ok "vcode linked to $BIN_DIR/vcode"
}

# ─── Step 6: Shell integration ──────────────────────────────────────────────

# If using nvm, ensure the shell profile sources it so vcode is always in PATH
SHELL_RC=""
if [ -n "${ZSH_VERSION:-}" ] || [ "$(basename "${SHELL:-}")" = "zsh" ]; then
  SHELL_RC="$HOME/.zshrc"
elif [ -n "${BASH_VERSION:-}" ] || [ "$(basename "${SHELL:-}")" = "bash" ]; then
  SHELL_RC="$HOME/.bashrc"
fi

if [ -n "$SHELL_RC" ] && [ -f "$NVM_DIR/nvm.sh" ]; then
  if ! grep -q 'NVM_DIR' "$SHELL_RC" 2>/dev/null; then
    echo '' >> "$SHELL_RC"
    echo '# nvm (added by VEEPEE Code installer)' >> "$SHELL_RC"
    echo 'export NVM_DIR="$HOME/.nvm"' >> "$SHELL_RC"
    echo '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"' >> "$SHELL_RC"
    ok "Added nvm to $SHELL_RC"
  fi
fi

# ─── Done ────────────────────────────────────────────────────────────────────

echo ""
echo -e "  ${GREEN}${BOLD}✓ VEEPEE Code installed!${NC}"
echo ""
echo -e "  ${DIM}Get started:${NC}"
echo -e "    ${BOLD}vcode${NC}              Launch (setup wizard runs on first launch)"
echo -e "    ${BOLD}vcode --wizard${NC}     Re-run setup wizard"
echo -e "    ${BOLD}vcode --update${NC}     Update to latest version"
echo ""
if [ -n "${NVM_DIR:-}" ] && [ -f "$NVM_DIR/nvm.sh" ]; then
  echo -e "  ${DIM}If 'vcode' isn't found, restart your terminal or run:${NC}"
  echo -e "  ${DIM}  source ${SHELL_RC:-~/.bashrc}${NC}"
  echo ""
fi
