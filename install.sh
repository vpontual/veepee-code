#!/usr/bin/env bash
set -euo pipefail

# VEEPEE Code Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/vpontual/veepee-code/main/install.sh | bash

REPO="vpontual/veepee-code"
INSTALL_DIR="${VEEPEE_CODE_DIR:-$HOME/.veepee-code}"
BIN_DIR="${VEEPEE_CODE_BIN:-/usr/local/bin}"

echo ""
echo "  ⚡ VEEPEE Code Installer"
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
  echo "  ✗ Node.js is required but not installed."
  echo ""
  echo "  Install it with one of:"
  echo "    brew install node          # macOS"
  echo "    curl -fsSL https://fnm.vercel.app/install | bash  # fnm (any OS)"
  echo "    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash  # nvm"
  echo ""
  exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
  echo "  ✗ Node.js 20+ is required (found v$(node -v))"
  exit 1
fi

echo "  ✓ Node.js $(node -v)"

# Check npm
if ! command -v npm &> /dev/null; then
  echo "  ✗ npm not found"
  exit 1
fi

echo "  ✓ npm $(npm -v)"

# Install from npm if published, otherwise from git
if npm view veepee-code version &> /dev/null 2>&1; then
  echo "  Installing from npm..."
  npm install -g veepee-code
else
  echo "  Installing from GitHub..."

  # Clone or update
  if [ -d "$INSTALL_DIR" ]; then
    echo "  Updating existing installation..."
    cd "$INSTALL_DIR"
    git pull --ff-only
  else
    echo "  Cloning repository..."
    git clone "https://github.com/$REPO.git" "$INSTALL_DIR"
    cd "$INSTALL_DIR"
  fi

  # Install deps and build
  echo "  Installing dependencies..."
  npm ci --ignore-scripts 2>/dev/null || npm install

  echo "  Building..."
  npm run build

  # Create symlink
  if [ -w "$BIN_DIR" ]; then
    ln -sf "$INSTALL_DIR/dist/index.js" "$BIN_DIR/veepee-code"
    chmod +x "$BIN_DIR/veepee-code"
  else
    echo "  Creating symlink (requires sudo)..."
    sudo ln -sf "$INSTALL_DIR/dist/index.js" "$BIN_DIR/veepee-code"
    sudo chmod +x "$BIN_DIR/veepee-code"
  fi
fi

# Create config directory
CONFIG_DIR="$HOME/.veepee-code"
mkdir -p "$CONFIG_DIR"

# Create default config if not exists
if [ ! -f "$CONFIG_DIR/.env" ]; then
  cat > "$CONFIG_DIR/.env" << 'ENVEOF'
# ─── Ollama Connection (required) ─────────────────────────────────────────────
# Point to your Ollama server or Ollama Fleet Manager proxy
VEEPEE_CODE_PROXY_URL=http://localhost:11434
# VEEPEE_CODE_DASHBOARD_URL=  # Only if using Ollama Fleet Manager

# ─── Model Preferences ────────────────────────────────────────────────────────
VEEPEE_CODE_AUTO_SWITCH=true
VEEPEE_CODE_MAX_MODEL_SIZE=40
VEEPEE_CODE_MIN_MODEL_SIZE=6

# ─── API Server ───────────────────────────────────────────────────────────────
VEEPEE_CODE_API_PORT=8484

# ─── Optional Integrations ────────────────────────────────────────────────────
# Run /setup inside vcode to see which integrations are available.
# Uncomment and fill in tokens for the ones you want.

# Home Assistant
# HA_URL=http://your-ha-server:8123
# HA_TOKEN=

# Mastodon
# MASTODON_URL=https://your.mastodon.instance
# MASTODON_TOKEN=

# Spotify (https://developer.spotify.com/dashboard)
# SPOTIFY_CLIENT_ID=
# SPOTIFY_CLIENT_SECRET=
# SPOTIFY_REFRESH_TOKEN=

# Google Workspace (https://console.cloud.google.com)
# GOOGLE_CLIENT_ID=
# GOOGLE_CLIENT_SECRET=
# GOOGLE_REFRESH_TOKEN=

# SearXNG web search (https://docs.searxng.org)
# SEARXNG_URL=http://localhost:8888

# AI Newsfeed
# NEWSFEED_URL=http://localhost:3333
ENVEOF
  echo "  ✓ Created config at $CONFIG_DIR/.env"
  echo "    Edit it to set your Ollama URL and optional integrations."
fi

echo ""
echo "  ✓ VEEPEE Code installed successfully!"
echo ""
echo "  Get started:"
echo "    veepee-code                    # Start in current directory"
echo "    veepee-code --help             # Show help"
echo ""
echo "  Configure:"
echo "    Edit $CONFIG_DIR/.env"
echo ""
echo "  API for other tools:"
echo "    Claude Code / Gemini CLI can connect to http://localhost:8484"
echo ""
