#!/data/data/com.termux/files/usr/bin/bash
# Termux setup script for GreenInvoice WhatsApp Agent on Android
# Usage: bash setup-android.sh

set -euo pipefail

# ── colour helpers ─────────────────────────────────────────────────────────────
R='\033[0;31m' G='\033[0;32m' Y='\033[1;33m' B='\033[0;34m' N='\033[0m'
step() { printf "\n${B}▶  %s${N}\n" "$*"; }
ok()   { printf "${G}✓  %s${N}\n"   "$*"; }
warn() { printf "${Y}⚠  %s${N}\n"   "$*"; }
err()  { printf "${R}✗  %s${N}\n"   "$*" >&2; exit 1; }

REPO="https://github.com/Amihay11/greenInoviceAgent_gemini.git"
BRANCH="claude/whatsapp-agent-commands-hljQR"
INSTALL_DIR="$HOME/greenInoviceAgent"

printf "\n${B}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${N}\n"
printf "${B}  GreenInvoice WhatsApp Agent — Android Setup${N}\n"
printf "${B}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${N}\n"

# ── 1. system packages ─────────────────────────────────────────────────────────
step "Switching to official Termux mirror (avoids hash-mismatch on third-party mirrors)"
echo "deb https://packages-cf.termux.dev/apt/termux-main stable main" \
  > "$PREFIX/etc/apt/sources.list"
pkg update -y
pkg install -y nodejs git python make clang binutils
ok "System packages ready"

# chromium lives in x11-repo — add the repo, refresh package lists, then install
step "Adding Termux x11 repository and installing Chromium"
pkg install -y x11-repo
pkg update -y
pkg install -y chromium
ok "Chromium installed"

# ── 2. clone or update repo ────────────────────────────────────────────────────
step "Setting up repository at $INSTALL_DIR"
if [ -d "$INSTALL_DIR/.git" ]; then
  warn "Repo already exists — pulling latest changes"
  git -C "$INSTALL_DIR" fetch origin
  git -C "$INSTALL_DIR" checkout "$BRANCH"
  git -C "$INSTALL_DIR" pull origin "$BRANCH"
else
  git clone --branch "$BRANCH" "$REPO" "$INSTALL_DIR"
fi
ok "Repository ready"

# ── 3. install agent dependencies ─────────────────────────────────────────────
# PUPPETEER_SKIP_DOWNLOAD prevents puppeteer from downloading an x86 Chromium
# binary that won't run on Android ARM — we use system chromium instead.
step "Installing agent Node.js dependencies"
cd "$INSTALL_DIR/agent"
PUPPETEER_SKIP_DOWNLOAD=1 PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=1 npm install
ok "Agent dependencies installed"

# ── 4. build MCP server ────────────────────────────────────────────────────────
step "Installing and building GreenInvoice MCP server (TypeScript → JS)"
cd "$INSTALL_DIR/GreenInvoice-MCP-main"
npm install
npm run build
ok "MCP server built — $(ls dist/index.js)"

# ── 5. locate chromium ─────────────────────────────────────────────────────────
CHROMIUM_BIN="$(which chromium-browser 2>/dev/null \
  || which chromium 2>/dev/null \
  || ls "$PREFIX/bin/chromium"* 2>/dev/null | head -1 \
  || true)"
[ -z "$CHROMIUM_BIN" ] && err "chromium not found. Run: ls \$PREFIX/bin/chromium* to check."
ok "Chromium found at $CHROMIUM_BIN"

# ── 6. collect credentials ─────────────────────────────────────────────────────
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
read -rp  "Gmail address (Enter to skip) : " EMAIL_USER
EMAIL_PASS=""
if [ -n "$EMAIL_USER" ]; then
  read -rsp "Gmail app password            : " EMAIL_PASS; echo
fi

# ── 7. write .env ──────────────────────────────────────────────────────────────
step "Writing agent/.env"
MCP_PATH="$INSTALL_DIR/GreenInvoice-MCP-main/dist/index.js"

cat > "$INSTALL_DIR/agent/.env" <<ENVEOF
GEMINI_API_KEY=${GEMINI_KEY}
GREENINVOICE_API_ID=${GI_ID}
GREENINVOICE_API_SECRET=${GI_SECRET}
MCP_SERVER_PATH=${MCP_PATH}
CHROME_EXECUTABLE_PATH=${CHROMIUM_BIN}
ENABLE_WHATSAPP=true
WHATSAPP_PHONE=${WHATSAPP_PHONE}
ENVEOF

if [ -n "$EMAIL_USER" ] && [ -n "$EMAIL_PASS" ]; then
  printf "EMAIL_USER=%s\nEMAIL_PASSWORD=%s\n" "$EMAIL_USER" "$EMAIL_PASS" \
    >> "$INSTALL_DIR/agent/.env"
fi
ok ".env written to $INSTALL_DIR/agent/.env"

# ── 8. create launchers ────────────────────────────────────────────────────────
step "Creating start.sh and start-background.sh launchers"
cat > "$INSTALL_DIR/start.sh" <<'STARTEOF'
#!/data/data/com.termux/files/usr/bin/bash
cd "$(dirname "$0")/agent"
echo "Starting GreenInvoice WhatsApp Agent..."
node index.js
STARTEOF
chmod +x "$INSTALL_DIR/start.sh"
chmod +x "$INSTALL_DIR/start-background.sh"
chmod +x "$INSTALL_DIR/stop.sh"
ok "Launchers created"

# ── 9. set up Termux:Boot auto-start ───────────────────────────────────────────
step "Setting up Termux:Boot auto-start"
mkdir -p "$HOME/.termux/boot"
cat > "$HOME/.termux/boot/start-agent.sh" <<BOOTEOF
#!/data/data/com.termux/files/usr/bin/bash
termux-wake-lock
$INSTALL_DIR/start-background.sh
BOOTEOF
chmod +x "$HOME/.termux/boot/start-agent.sh"
ok "Boot script created at ~/.termux/boot/start-agent.sh"

# ── done ───────────────────────────────────────────────────────────────────────
printf "\n${G}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${N}\n"
printf "${G}  Setup complete!${N}\n"
printf "${G}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${N}\n\n"
printf "  Run now (foreground):   ${Y}$INSTALL_DIR/start.sh${N}\n"
printf "  Run now (background):   ${Y}$INSTALL_DIR/start-background.sh${N}\n"
printf "  Stop background agent:  ${Y}$INSTALL_DIR/stop.sh${N}\n"
printf "  View logs:              ${Y}tail -f $INSTALL_DIR/agent.log${N}\n\n"
printf "  ${Y}Auto-start on boot:${N}\n"
printf "  1. Install Termux:Boot from F-Droid (NOT Play Store)\n"
printf "  2. Open Termux:Boot once to activate it\n"
printf "  3. Done — agent starts automatically on every reboot\n\n"
printf "  Commands:\n"
printf "    ${Y}mc${N}  <request>    — GreenInvoice / invoicing tasks\n"
printf "    ${Y}wc${N}  <number>     — get a WhatsApp link (e.g. wc 0545684800)\n"
printf "    ${Y}wc${N}  (voice note) — transcribe voice message to text\n"
printf "    ${Y}gc${N}  <question>   — general AI query\n"
printf "    ${Y}gc${N}  (+ image)    — extract / analyse image text\n\n"
