#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
#  Oracle Cloud Ubuntu VM — GreenInvoice WhatsApp Agent setup
#  Tested on: Ubuntu 22.04 / 24.04 LTS (OCI free-tier ARM & AMD shapes)
#
#  Usage (run on the VM after SSH-ing in):
#    bash setup-oracle.sh
#
#  What it does:
#    1. Installs system deps (Node 20, Chromium, Git …)
#    2. Clones / updates the repo
#    3. Builds the MCP TypeScript server
#    4. Installs agent Node.js deps (skipping Puppeteer's bundled Chromium)
#    5. Collects your API credentials interactively and writes agent/.env
#    6. Creates two systemd services:
#         shaul-agent.service   — the WhatsApp agent
#         shaul-dashboard.service — the web dashboard (port 3001)
#    7. Opens firewall rules so the dashboard is reachable from outside
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── colour helpers ─────────────────────────────────────────────────────────────
R='\033[0;31m' G='\033[0;32m' Y='\033[1;33m' B='\033[0;34m' N='\033[0m'
step() { printf "\n${B}▶  %s${N}\n" "$*"; }
ok()   { printf "${G}✓  %s${N}\n"   "$*"; }
warn() { printf "${Y}⚠  %s${N}\n"   "$*"; }
err()  { printf "${R}✗  %s${N}\n"   "$*" >&2; exit 1; }

# ── config ─────────────────────────────────────────────────────────────────────
REPO="https://github.com/Amihay11/greenInoviceAgent_gemini.git"
BRANCH="claude/whatsapp-agent-commands-hljQR"
INSTALL_DIR="$HOME/greenInoviceAgent"
DASHBOARD_PORT="${DASHBOARD_PORT:-3001}"
SERVICE_USER="${SUDO_USER:-$(whoami)}"

printf "\n${B}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${N}\n"
printf "${B}  GreenInvoice WhatsApp Agent — Oracle Cloud Setup${N}\n"
printf "${B}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${N}\n"

# ── must NOT run as root (systemd --user won't work) ──────────────────────────
if [ "$(id -u)" -eq 0 ]; then
  err "Run this script as a normal user (ubuntu / opc), not root.
       If you need sudo for apt, the script calls it internally."
fi

# ── 1. system packages ─────────────────────────────────────────────────────────
step "Updating apt and installing system dependencies"

sudo apt-get update -y
sudo apt-get install -y \
  curl git build-essential python3 make g++ \
  chromium-browser \
  ca-certificates gnupg lsb-release ufw

ok "System packages installed"

# ── 2. Node.js 20 via NodeSource ──────────────────────────────────────────────
step "Installing Node.js 20 LTS"

if ! node --version 2>/dev/null | grep -qE '^v(18|19|20|21|22)'; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
else
  ok "Node.js $(node --version) already present — skipping"
fi

node --version
npm --version
ok "Node.js ready"

# ── 3. Locate Chromium ────────────────────────────────────────────────────────
step "Locating Chromium binary"
CHROMIUM_BIN="$(which chromium-browser 2>/dev/null \
  || which chromium 2>/dev/null \
  || which google-chrome 2>/dev/null \
  || true)"
[ -z "$CHROMIUM_BIN" ] && err "Chromium not found after install. Check: which chromium-browser"
ok "Chromium → $CHROMIUM_BIN"

# ── 4. clone or update repo ───────────────────────────────────────────────────
step "Setting up repository at $INSTALL_DIR"

if [ -d "$INSTALL_DIR/.git" ]; then
  warn "Repo already exists — pulling latest"
  git -C "$INSTALL_DIR" fetch origin
  git -C "$INSTALL_DIR" checkout "$BRANCH"
  git -C "$INSTALL_DIR" pull origin "$BRANCH"
else
  git clone --branch "$BRANCH" "$REPO" "$INSTALL_DIR"
fi
ok "Repository ready"

# ── 5. build MCP server ───────────────────────────────────────────────────────
step "Installing and building GreenInvoice MCP server (TypeScript → JS)"

cd "$INSTALL_DIR/GreenInvoice-MCP-main"
npm install
npm run build
ok "MCP server built → $(ls dist/index.js)"

# ── 6. install agent dependencies ─────────────────────────────────────────────
step "Installing agent Node.js dependencies (skipping Puppeteer bundled Chromium)"

cd "$INSTALL_DIR/agent"
PUPPETEER_SKIP_DOWNLOAD=1 PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=1 npm install
ok "Agent dependencies installed"

# ── 7. collect credentials ────────────────────────────────────────────────────
printf "\n${B}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${N}\n"
printf "${B}  Enter your API credentials${N}\n"
printf "${B}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${N}\n\n"

read -rp  "Gemini API key                : " GEMINI_KEY
[ -z "$GEMINI_KEY" ] && err "Gemini API key is required"

read -rp  "GreenInvoice API ID           : " GI_ID
[ -z "$GI_ID" ] && err "GreenInvoice API ID is required"

read -rsp "GreenInvoice API Secret       : " GI_SECRET; echo
[ -z "$GI_SECRET" ] && err "GreenInvoice API Secret is required"

echo ""
read -rp  "Your WhatsApp number (international, no + e.g. 972545684800): " WHATSAPP_PHONE

echo ""
printf "${Y}Optional — Meta (Facebook / Instagram publishing)${N}\n"
read -rp  "Meta Page ID        (Enter to skip): " META_PAGE_ID
META_PAGE_TOKEN="" IG_BUSINESS_ID=""
if [ -n "$META_PAGE_ID" ]; then
  read -rsp "Meta Page Token                    : " META_PAGE_TOKEN; echo
  read -rp  "Instagram Business Account ID      : " IG_BUSINESS_ID
fi

echo ""
printf "${Y}Optional — Notion (for the 'note' command)${N}\n"
printf "  Get token from https://www.notion.so/my-integrations — press Enter to skip\n"
read -rp  "Notion API key (secret_...)   : " NOTION_KEY
NOTION_DB=""
if [ -n "$NOTION_KEY" ]; then
  read -rp  "Notion database ID            : " NOTION_DB
fi

read -rp  "Gmail address (Enter to skip) : " EMAIL_USER
EMAIL_PASS=""
if [ -n "$EMAIL_USER" ]; then
  read -rsp "Gmail app password            : " EMAIL_PASS; echo
fi

# Allowed WhatsApp numbers (allow-list — leave empty = accept everyone)
echo ""
printf "${Y}Optional — inbound allow-list${N} (comma-separated numbers, e.g. 0527203222,0541234567)\n"
printf "  Leave empty to accept messages from anyone.\n"
read -rp  "SHAUL_ALLOWED_NUMBERS         : " SHAUL_ALLOWED

# ── 8. write .env ─────────────────────────────────────────────────────────────
step "Writing agent/.env"

MCP_PATH="$INSTALL_DIR/GreenInvoice-MCP-main/dist/index.js"
NODE_BIN="$(which node)"

cat > "$INSTALL_DIR/agent/.env" <<ENVEOF
# ── Core ───────────────────────────────────────────────────────────────────────
GEMINI_API_KEY=${GEMINI_KEY}
GREENINVOICE_API_ID=${GI_ID}
GREENINVOICE_API_SECRET=${GI_SECRET}
MCP_SERVER_PATH=${MCP_PATH}
NODE_EXECUTABLE=${NODE_BIN}

# ── WhatsApp ───────────────────────────────────────────────────────────────────
ENABLE_WHATSAPP=true
WHATSAPP_PHONE=${WHATSAPP_PHONE}
CHROME_EXECUTABLE_PATH=${CHROMIUM_BIN}
PUPPETEER_SKIP_DOWNLOAD=1
PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=1
# Headless Chromium flags required on a server (no display)
CHROME_ARGS=--no-sandbox,--disable-setuid-sandbox,--disable-dev-shm-usage,--disable-gpu

# ── Privacy ────────────────────────────────────────────────────────────────────
SHAUL_ALLOWED_NUMBERS=${SHAUL_ALLOWED}

# ── Proactive briefing ─────────────────────────────────────────────────────────
SHAUL_BRIEFING_HOUR=8
ENVEOF

if [ -n "$META_PAGE_ID" ]; then
  printf "META_PAGE_ID=%s\nMETA_PAGE_TOKEN=%s\nIG_BUSINESS_ID=%s\n" \
    "$META_PAGE_ID" "$META_PAGE_TOKEN" "$IG_BUSINESS_ID" \
    >> "$INSTALL_DIR/agent/.env"
fi

if [ -n "$NOTION_KEY" ] && [ -n "$NOTION_DB" ]; then
  printf "NOTION_API_KEY=%s\nNOTION_NOTES_DB_ID=%s\n" \
    "$NOTION_KEY" "$NOTION_DB" >> "$INSTALL_DIR/agent/.env"
fi

if [ -n "$EMAIL_USER" ] && [ -n "$EMAIL_PASS" ]; then
  printf "EMAIL_USER=%s\nEMAIL_PASSWORD=%s\n" \
    "$EMAIL_USER" "$EMAIL_PASS" >> "$INSTALL_DIR/agent/.env"
fi

chmod 600 "$INSTALL_DIR/agent/.env"
ok ".env written (permissions 600)"

# ── 9. systemd service — WhatsApp agent ───────────────────────────────────────
step "Creating shaul-agent systemd service"

mkdir -p "$HOME/.config/systemd/user"

cat > "$HOME/.config/systemd/user/shaul-agent.service" <<SVCEOF
[Unit]
Description=Shaul WhatsApp Marketing Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${INSTALL_DIR}/agent
ExecStart=${NODE_BIN} index.js
Restart=on-failure
RestartSec=10
StandardOutput=append:${INSTALL_DIR}/agent.log
StandardError=append:${INSTALL_DIR}/agent.log
Environment=HOME=${HOME}

[Install]
WantedBy=default.target
SVCEOF

ok "shaul-agent.service created"

# ── 10. systemd service — dashboard ───────────────────────────────────────────
step "Creating shaul-dashboard systemd service"

cat > "$HOME/.config/systemd/user/shaul-dashboard.service" <<DASHEOF
[Unit]
Description=Shaul Dashboard (port ${DASHBOARD_PORT})
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${INSTALL_DIR}
ExecStart=${NODE_BIN} dashboard.js
Restart=on-failure
RestartSec=10
StandardOutput=append:${INSTALL_DIR}/dashboard.log
StandardError=append:${INSTALL_DIR}/dashboard.log
Environment=HOME=${HOME}
Environment=DASHBOARD_PORT=${DASHBOARD_PORT}

[Install]
WantedBy=default.target
DASHEOF

ok "shaul-dashboard.service created"

# ── 11. enable & start services ───────────────────────────────────────────────
step "Enabling services (auto-start on reboot)"

# Enable lingering so user services survive logout
sudo loginctl enable-linger "$SERVICE_USER"

systemctl --user daemon-reload
systemctl --user enable shaul-agent.service shaul-dashboard.service
systemctl --user start  shaul-agent.service shaul-dashboard.service

ok "Services enabled and started"

# ── 12. firewall — open dashboard port ────────────────────────────────────────
step "Configuring UFW firewall (port ${DASHBOARD_PORT})"

sudo ufw allow OpenSSH
sudo ufw allow "${DASHBOARD_PORT}/tcp" comment "Shaul Dashboard"
sudo ufw --force enable

ok "UFW rules applied"

# OCI also has a Virtual Cloud Network (VCN) Security List.
# You must ALSO open port ${DASHBOARD_PORT} in the OCI Console:
#   Networking → VCN → Security Lists → Ingress Rules → Add Ingress Rule
#   Protocol: TCP  |  Destination Port: ${DASHBOARD_PORT}
warn "Remember to open port ${DASHBOARD_PORT} in the OCI Console Security List (see below)."

# ── 13. create convenience helpers ────────────────────────────────────────────
step "Creating helper scripts"

cat > "$INSTALL_DIR/logs.sh" <<'LOGEOF'
#!/usr/bin/env bash
INSTALL_DIR="$(cd "$(dirname "$0")" && pwd)"
echo "=== Agent log ===" && tail -f "$INSTALL_DIR/agent.log"
LOGEOF
chmod +x "$INSTALL_DIR/logs.sh"

cat > "$INSTALL_DIR/restart.sh" <<'RESTEOF'
#!/usr/bin/env bash
systemctl --user restart shaul-agent.service shaul-dashboard.service
echo "Restarted."
RESTEOF
chmod +x "$INSTALL_DIR/restart.sh"

cat > "$INSTALL_DIR/stop.sh" <<'STOPEOF'
#!/usr/bin/env bash
systemctl --user stop shaul-agent.service shaul-dashboard.service
echo "Stopped."
STOPEOF
chmod +x "$INSTALL_DIR/stop.sh"

ok "Helper scripts created"

# ── done ──────────────────────────────────────────────────────────────────────
PUBLIC_IP=$(curl -sf https://checkip.amazonaws.com 2>/dev/null || echo "<your-vm-public-ip>")

printf "\n${G}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${N}\n"
printf "${G}  Setup complete!${N}\n"
printf "${G}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${N}\n\n"
printf "  Dashboard:   ${Y}http://${PUBLIC_IP}:${DASHBOARD_PORT}${N}\n\n"
printf "  Manage services:\n"
printf "    ${Y}systemctl --user status  shaul-agent${N}      # check agent\n"
printf "    ${Y}systemctl --user restart shaul-agent${N}      # restart agent\n"
printf "    ${Y}systemctl --user stop    shaul-agent${N}      # stop agent\n"
printf "    ${Y}tail -f $INSTALL_DIR/agent.log${N}   # live logs\n\n"
printf "  ${Y}Pair WhatsApp (first time only):${N}\n"
printf "    1. Watch the log: ${Y}tail -f $INSTALL_DIR/agent.log${N}\n"
printf "    2. A QR code or pairing code will appear\n"
printf "    3. On your phone: WhatsApp → Linked Devices → Link a Device\n\n"
printf "  ${Y}OCI Console — open port ${DASHBOARD_PORT}:${N}\n"
printf "    Networking → Virtual Cloud Networks → your VCN\n"
printf "    → Security Lists → Default Security List\n"
printf "    → Add Ingress Rule:\n"
printf "        Source CIDR: 0.0.0.0/0\n"
printf "        Protocol:    TCP\n"
printf "        Dest port:   ${DASHBOARD_PORT}\n\n"
