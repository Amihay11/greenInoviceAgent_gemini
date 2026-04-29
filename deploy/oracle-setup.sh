#!/bin/bash
# Oracle Cloud Always-Free Ubuntu 22.04 — one-time setup script
# Run as a non-root user with sudo rights (default oracle-cloud user: ubuntu)
#
# Usage:
#   chmod +x oracle-setup.sh
#   ./oracle-setup.sh

set -e

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
AGENT_DIR="$REPO_DIR/agent"
MCP_DIR="$REPO_DIR/GreenInvoice-MCP-main"
ENV_FILE="$AGENT_DIR/.env"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

info()    { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
section() { echo -e "\n${GREEN}══════════════════════════════════════${NC}"; echo -e "${GREEN} $*${NC}"; echo -e "${GREEN}══════════════════════════════════════${NC}"; }

# ── 1. System packages ────────────────────────────────────────────────────────
section "1. Updating system packages"
sudo apt-get update -y
sudo apt-get upgrade -y
sudo apt-get install -y curl git build-essential python3 ca-certificates gnupg

# ── 2. Node.js 20 LTS ─────────────────────────────────────────────────────────
section "2. Installing Node.js 20 LTS"
if ! command -v node &>/dev/null || [[ "$(node -e 'process.exit(+process.versions.node.split(".")[0] < 18)')" ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
info "Node $(node -v)  |  npm $(npm -v)"

# ── 3. Chromium (headless browser for WhatsApp Web) ───────────────────────────
section "3. Installing Chromium"
sudo apt-get install -y \
  chromium-browser \
  libnss3 libatk-bridge2.0-0 libdrm2 libxkbcommon0 libgbm1 \
  libxshmfence1 libasound2 libx11-xcb1 libxrandr2 libgtk-3-0
CHROME_BIN="$(which chromium-browser 2>/dev/null || which chromium 2>/dev/null || echo '')"
info "Chrome binary: $CHROME_BIN"

# ── 4. pm2 (process manager) ──────────────────────────────────────────────────
section "4. Installing pm2"
sudo npm install -g pm2
info "pm2 $(pm2 -v)"

# ── 5. Install npm dependencies ───────────────────────────────────────────────
section "5. Installing agent dependencies"
cd "$AGENT_DIR"
npm install
info "Agent dependencies installed."

section "6. Building GreenInvoice MCP server"
cd "$MCP_DIR"
npm install
npm run build
info "MCP server compiled to $MCP_DIR/dist/index.js"

# ── 6. Create .env ────────────────────────────────────────────────────────────
section "7. Configuring environment"

if [ -f "$ENV_FILE" ]; then
  warn ".env already exists at $ENV_FILE — skipping creation."
  warn "Edit it manually if you need to change values."
else
  cp "$AGENT_DIR/.env.example" "$ENV_FILE"

  read -rp "  Enter your GEMINI_API_KEY: " GEMINI_KEY
  read -rp "  Enter your GREENINVOICE_API_ID: " GI_ID
  read -rp "  Enter your GREENINVOICE_API_SECRET: " GI_SECRET
  read -rp "  Enter your WhatsApp phone (e.g. 972501234567, leave blank for QR): " WA_PHONE

  # Replace placeholders
  sed -i "s|GEMINI_API_KEY=.*|GEMINI_API_KEY=$GEMINI_KEY|" "$ENV_FILE"
  sed -i "s|GREENINVOICE_API_ID=.*|GREENINVOICE_API_ID=$GI_ID|" "$ENV_FILE"
  sed -i "s|GREENINVOICE_API_SECRET=.*|GREENINVOICE_API_SECRET=$GI_SECRET|" "$ENV_FILE"
  sed -i "s|MCP_SERVER_PATH=.*|MCP_SERVER_PATH=$MCP_DIR/dist/index.js|" "$ENV_FILE"
  sed -i "s|ENABLE_WHATSAPP=.*|ENABLE_WHATSAPP=true|" "$ENV_FILE"

  if [ -n "$WA_PHONE" ]; then
    sed -i "s|WHATSAPP_PHONE=.*|WHATSAPP_PHONE=$WA_PHONE|" "$ENV_FILE"
  fi

  if [ -n "$CHROME_BIN" ]; then
    echo "CHROME_EXECUTABLE_PATH=$CHROME_BIN" >> "$ENV_FILE"
  fi

  info ".env written to $ENV_FILE"
fi

# ── 7. Start with pm2 ─────────────────────────────────────────────────────────
section "8. Starting agent with pm2"
cd "$REPO_DIR"

# Stop any previous instance
pm2 stop greeninvoice-agent 2>/dev/null || true
pm2 delete greeninvoice-agent 2>/dev/null || true

pm2 start ecosystem.config.cjs
pm2 save

# Register pm2 to start on reboot
info "Registering pm2 startup service..."
PM2_STARTUP=$(pm2 startup | tail -n 1)
if [[ "$PM2_STARTUP" == sudo* ]]; then
  eval "$PM2_STARTUP"
else
  warn "Run this manually to enable auto-start on reboot:"
  echo "  $PM2_STARTUP"
fi

# ── Done ──────────────────────────────────────────────────────────────────────
section "Setup complete!"
echo ""
echo "  Monitor agent:    pm2 logs greeninvoice-agent"
echo "  Status:           pm2 status"
echo "  Stop:             pm2 stop greeninvoice-agent"
echo "  Restart:          pm2 restart greeninvoice-agent"
echo ""
if grep -q "^WHATSAPP_PHONE=" "$ENV_FILE" && [ -n "$(grep '^WHATSAPP_PHONE=' "$ENV_FILE" | cut -d= -f2)" ]; then
  echo "  WhatsApp:  A pairing code will appear in the logs. Enter it in WhatsApp"
  echo "             Settings → Linked Devices → Link a Device → Link with phone number."
  echo "  View logs: pm2 logs greeninvoice-agent --lines 50"
else
  echo "  WhatsApp:  A QR code will appear in the logs. Scan it with WhatsApp."
  echo "  View logs: pm2 logs greeninvoice-agent --lines 50"
fi
echo ""
