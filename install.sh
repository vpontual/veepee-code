#!/usr/bin/env bash
set -euo pipefail

# VEEPEE Code Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/vpontual/veepee-code/main/install.sh | bash

REPO="vpontual/veepee-code"
INSTALL_DIR="${VEEPEE_CODE_DIR:-$HOME/.veepee-code}"
BIN_DIR="${VEEPEE_CODE_BIN:-/usr/local/bin}"

# Quick update mode: vcode --update calls this with --update
if [ "${1:-}" = "--update" ]; then
  echo ""
  echo "  ⚡ VEEPEE Code Updater"
  echo ""
  if [ -d "$INSTALL_DIR" ]; then
    cd "$INSTALL_DIR"
    echo "  Pulling latest..."
    git pull --ff-only
    echo "  Installing dependencies..."
    npm ci --ignore-scripts 2>/dev/null || npm install
    echo "  Building..."
    npm run build
    echo ""
    echo "  ✓ Updated to $(git log --oneline -1 | cut -d' ' -f1)"
    echo ""
  else
    echo "  ✗ VEEPEE Code not installed at $INSTALL_DIR"
    echo "  Run the full installer first."
  fi
  exit 0
fi

echo ""
echo "  ⚡ VEEPEE Code Installer"
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
  echo "  ✗ Node.js is required but not installed."
  echo ""
  echo "  We recommend using nvm (Node Version Manager) so you don't"
  echo "  mess with your system's Node installation:"
  echo ""
  echo "    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash"
  echo "    source ~/.bashrc   # or ~/.zshrc"
  echo "    nvm install --lts"
  echo ""
  echo "  This installs Node in your home directory — safe and isolated."
  echo ""
  exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
  echo "  ✗ Node.js 20+ is required (found v$(node -v))"
  echo ""
  echo "  Update with nvm:"
  echo "    nvm install --lts"
  echo "    nvm use --lts"
  echo ""
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

  # Ensure GitHub CLI is installed and authenticated
  if ! command -v gh &> /dev/null; then
    echo "  ✗ GitHub CLI (gh) is required for private repo access."
    echo ""
    echo "  Install it with one of:"
    echo "    brew install gh                # macOS"
    echo "    sudo apt install gh            # Debian/Ubuntu"
    echo "    sudo dnf install gh            # Fedora"
    echo "    https://cli.github.com         # Other"
    echo ""
    exit 1
  fi

  if ! gh auth status &> /dev/null; then
    echo "  GitHub authentication required..."
    gh auth login
  fi

  # Ensure git uses gh credentials
  gh auth setup-git

  echo "  ✓ GitHub authenticated"

  # Clone or update
  if [ -d "$INSTALL_DIR" ]; then
    echo "  Updating existing installation..."
    cd "$INSTALL_DIR"
    git pull --ff-only
  else
    echo "  Cloning repository..."
    gh repo clone "$REPO" "$INSTALL_DIR"
    cd "$INSTALL_DIR"
  fi

  # Install deps and build
  echo "  Installing dependencies..."
  npm ci --ignore-scripts 2>/dev/null || npm install

  echo "  Building..."
  npm run build

  # Create symlinks (veepee-code and vcode)
  if [ -w "$BIN_DIR" ]; then
    ln -sf "$INSTALL_DIR/dist/index.js" "$BIN_DIR/veepee-code"
    ln -sf "$INSTALL_DIR/dist/index.js" "$BIN_DIR/vcode"
    chmod +x "$BIN_DIR/veepee-code" "$BIN_DIR/vcode"
  else
    echo "  Creating symlinks (requires sudo)..."
    sudo ln -sf "$INSTALL_DIR/dist/index.js" "$BIN_DIR/veepee-code"
    sudo ln -sf "$INSTALL_DIR/dist/index.js" "$BIN_DIR/vcode"
    sudo chmod +x "$BIN_DIR/veepee-code" "$BIN_DIR/vcode"
  fi
fi

# Create config directory (wizard will create .env on first launch)
CONFIG_DIR="$HOME/.veepee-code"
mkdir -p "$CONFIG_DIR"

echo ""
echo "  ✓ VEEPEE Code installed successfully!"
echo ""
echo "  Get started:"
echo "    vcode                           # Launch (setup wizard runs on first launch)"
echo "    vcode --help                    # Show help"
echo "    vcode --wizard                  # Re-run the setup wizard"
echo ""
