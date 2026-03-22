#!/usr/bin/env bash
set -euo pipefail

# VEEPEE Code Installer
# Usage: curl -fsSL https://vitorpontual.com/install.sh | bash

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

# ─── Quick Update Mode ──────────────────────────────────────────────────────

if [ "${1:-}" = "--update" ]; then
  echo ""
  echo -e "  ${BOLD}⚡ VEEPEE Code Updater${NC}"
  echo ""
  if [ -d "$INSTALL_DIR" ]; then
    cd "$INSTALL_DIR"
    info "Pulling latest..."
    git pull --ff-only
    info "Installing dependencies..."
    npm ci --ignore-scripts 2>/dev/null || npm install
    info "Building..."
    npm run build
    echo ""
    ok "Updated to $(git log --oneline -1 | cut -d' ' -f1)"
    echo ""
  else
    fail "VEEPEE Code not installed at $INSTALL_DIR"
    echo "  Run the full installer first."
  fi
  exit 0
fi

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
fi

# ─── Step 3: Clone / Update ─────────────────────────────────────────────────

if [ -d "$INSTALL_DIR/.git" ]; then
  info "Updating existing installation..."
  cd "$INSTALL_DIR"
  git pull --ff-only
else
  if [ -d "$INSTALL_DIR" ]; then
    # Directory exists but isn't a git repo (e.g. just config files)
    # Move config files aside, clone, restore
    info "Backing up existing config..."
    [ -f "$INSTALL_DIR/.env" ] && cp "$INSTALL_DIR/.env" /tmp/veepee-code-env-backup
    rm -rf "$INSTALL_DIR"
  fi
  info "Cloning repository..."
  git clone "$CLONE_URL" "$INSTALL_DIR"
  cd "$INSTALL_DIR"
  # Restore config if backed up
  [ -f /tmp/veepee-code-env-backup ] && mv /tmp/veepee-code-env-backup "$INSTALL_DIR/.env"
fi
ok "Source ready"

# ─── Step 4: Build ───────────────────────────────────────────────────────────

info "Installing dependencies..."
npm ci --ignore-scripts 2>/dev/null || npm install --ignore-scripts

info "Building..."
npm run build
ok "Build complete"

# ─── Step 5: Link binary ────────────────────────────────────────────────────

# Prefer npm link (uses nvm's bin dir, no sudo needed)
info "Linking vcode command..."
npm link 2>/dev/null && {
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
