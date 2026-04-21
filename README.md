# GreenInvoice WhatsApp Agent

An AI-powered WhatsApp agent that connects to the [GreenInvoice](https://www.greeninvoice.co.il) Israeli invoicing API via Google Gemini and the Model Context Protocol (MCP). Send a WhatsApp message to your own number and the agent handles invoices, receipts, clients, and more — plus general-purpose AI tasks.

---

## Table of Contents

- [How It Works](#how-it-works)
- [Commands](#commands)
- [Architecture](#architecture)
- [File Structure](#file-structure)
- [Setup — Windows](#setup--windows)
- [Setup — Android (Termux)](#setup--android-termux)
- [Environment Variables](#environment-variables)
- [Adding New Commands](#adding-new-commands)
- [Adding New MCP Tools](#adding-new-mcp-tools)
- [Managing the Agent](#managing-the-agent)
- [Troubleshooting](#troubleshooting)

---

## How It Works

1. You send a WhatsApp message to your own linked number starting with a command prefix.
2. The agent (Node.js + `whatsapp-web.js`) receives the message.
3. For `mc` commands it passes the message to **Google Gemini** along with the available GreenInvoice MCP tools.
4. Gemini decides which tool to call, the MCP server executes the GreenInvoice API call, and the result is fed back to Gemini.
5. Gemini produces a final reply which is sent back to you on WhatsApp.
6. For `wc`/`gc` commands the agent handles the request directly (no MCP tools needed).

```
Your WhatsApp
      │
      ▼
  Message Router  ──── mc ───▶  Gemini + GreenInvoice MCP  ──▶  GreenInvoice API
      │
      ├── wc + phone  ──▶  wa.me link
      ├── wc + voice  ──▶  Gemini transcription
      ├── gc + text   ──▶  Gemini general response
      └── gc + image  ──▶  Gemini vision / OCR
```

---

## Commands

| Prefix | Input | What happens |
|--------|-------|-------------|
| `mc` | Any text | GreenInvoice invoicing task via Gemini + MCP |
| `wc 0541234567` | Israeli phone number | Returns `https://wa.me/972541234567` |
| `wc` | Voice note (ptt/audio) | Transcribes voice to text via Gemini |
| `gc what is X` | Any question | General Gemini answer (no invoicing tools) |
| `gc` + image | Image with caption | Gemini analyzes / extracts text from image |

### `mc` — Morning Command (GreenInvoice)

The agent replies in Hebrew or English depending on how you write.

Example messages:
```
mc צור חשבונית מס קבלה על סך 5000 שח לאגודה שיתופית עשהאל
mc list all open invoices from this month
mc send invoice #1234 to the client by email
```

Supported GreenInvoice document types:

| Code | Type |
|------|------|
| 300 | חשבון עסקה / דרישת תשלום |
| 305 | חשבונית מס |
| 320 | קבלה |
| 330 | חשבונית מס קבלה |

### `wc` — WhatsApp Command

```
wc 0541234567        →  https://wa.me/972541234567
wc +972-54-123-4567  →  https://wa.me/972541234567
```

Send a voice note (no text prefix needed) → transcription returned.

### `gc` — General Command

```
gc translate this to English: שלום עולם
gc what is the VAT rate in Israel?
```

Send an image with caption `gc` or `gc extract text` → OCR / image analysis.

---

## Architecture

```
greenInoviceAgent_gemini/
├── agent/               # Node.js WhatsApp agent
│   └── index.js         # Main entry point
└── GreenInvoice-MCP-main/  # TypeScript MCP server
    └── src/
        ├── index.ts     # MCP server entry
        ├── client.ts    # GreenInvoice API HTTP client
        └── tools.ts     # 10 MCP tools (66 API endpoints)
```

### Message Router (`agent/index.js`)

The `client.on('message')` handler is a clean router:

```javascript
// ptt/audio  →  handleVoiceTranscription(msg)
// mc         →  handleMorningCommand(msg)      ← uses MCP + Gemini
// wc         →  handleWcCommand(msg)
// gc         →  handleGcCommand(msg)
```

Each handler is a standalone `async function` — easy to add more.

### MCP Tools

The MCP server exposes 10 resource-based tools, each with an `action` parameter:

| Tool | Key actions |
|------|-------------|
| `document` | search, get, create, update, send, add_payment, download_links |
| `client` | search, get, create, update, delete, update_balance |
| `supplier` | search, get, create, update, delete |
| `item` | search, get, create, update, delete |
| `expense` | search, get, create, update, close |
| `payment` | create_link, charge_token, get_link_status |
| `business` | get, settings, upload_file |
| `account` | get, settings |
| `webhook` | create, get, delete |
| `reference_data` | countries, cities, currencies, occupations |

---

## File Structure

```
greenInoviceAgent_gemini/
│
├── agent/
│   ├── index.js            Main agent — router + all handlers
│   ├── package.json        Node.js dependencies
│   └── .env.example        Template for all environment variables
│
├── GreenInvoice-MCP-main/
│   ├── src/
│   │   ├── index.ts        MCP server entry point
│   │   ├── client.ts       GreenInvoice API client (auth, rate-limit, retry)
│   │   └── tools.ts        All 10 MCP tool registrations
│   ├── dist/               Compiled JS (created by npm run build)
│   └── package.json
│
├── setup-android.sh        One-shot Android/Termux setup script
├── start.sh                Foreground launcher (created by setup script)
├── start-background.sh     Background launcher (nohup + PID file)
├── stop.sh                 Stop the background agent
└── README.md               This file
```

---

## Setup — Windows

### Prerequisites
- Node.js 18+
- Google Chrome
- Git

### Steps

1. Clone the repo:
   ```powershell
   git clone https://github.com/Amihay11/greenInoviceAgent_gemini.git
   cd greenInoviceAgent_gemini
   ```

2. Build the MCP server:
   ```powershell
   cd GreenInvoice-MCP-main
   npm install
   npm run build
   cd ..
   ```

3. Install agent dependencies:
   ```powershell
   cd agent
   npm install
   ```

4. Create `agent/.env` from `agent/.env.example` and fill in all values — see [Environment Variables](#environment-variables).

5. Start for the first time (to pair WhatsApp):
   ```powershell
   node index.js
   ```
   Scan the QR code with WhatsApp → Linked Devices → Link a Device. Once you see `WhatsApp Client is ready!` press `Ctrl+C`.

6. **Run in background**: double-click `agent/run-agent-hidden.vbs`. A tray icon appears — right-click to view logs or stop.

7. **Auto-start on Windows boot**: copy `run-agent-hidden.vbs` to your `shell:startup` folder.

---

## Setup — Android (Termux)

Run the one-shot setup script — it installs everything and asks for credentials interactively:

```bash
curl -fsSL https://raw.githubusercontent.com/Amihay11/greenInoviceAgent_gemini/claude/whatsapp-agent-commands-hljQR/setup-android.sh | bash
```

### Auto-start on boot

1. Install **Termux:Boot** from [F-Droid](https://f-droid.org) (not the Play Store).
2. Open the Termux:Boot app once to activate it.
3. Done — the agent starts automatically on every reboot.

### Managing the agent on Android

```bash
~/greenInoviceAgent/start-background.sh   # start hidden
~/greenInoviceAgent/stop.sh               # stop
tail -f ~/greenInoviceAgent/agent.log     # live logs
```

---

## Environment Variables

Copy `agent/.env.example` to `agent/.env` and fill in:

| Variable | Required | Description |
|----------|----------|-------------|
| `GEMINI_API_KEY` | ✅ | Google Gemini API key |
| `GREENINVOICE_API_ID` | ✅ | GreenInvoice API ID |
| `GREENINVOICE_API_SECRET` | ✅ | GreenInvoice API secret |
| `MCP_SERVER_PATH` | ✅ | Absolute path to `GreenInvoice-MCP-main/dist/index.js` |
| `ENABLE_WHATSAPP` | ✅ | Set to `true` to enable WhatsApp listener |
| `WHATSAPP_PHONE` | — | Your number in international format without `+` (e.g. `972541234567`). When set, shows a pairing code instead of QR on first login. |
| `NODE_EXECUTABLE` | — | Path to `node` binary. Defaults to `node` on PATH (correct for Android/Linux). Windows may need the full path. |
| `CHROME_EXECUTABLE_PATH` | — | Path to Chrome/Chromium. Leave unset to use Puppeteer's bundled Chromium. |
| `GREENINVOICE_SANDBOX` | — | Set to `true` to use the GreenInvoice sandbox environment. |
| `EMAIL_USER` | — | Gmail address for the optional email agent. |
| `EMAIL_PASSWORD` | — | Gmail app password for the email agent. |

---

## Adding New Commands

All command handlers live in `agent/index.js`. To add a new prefix (e.g. `sc` for scheduling):

**1. Write the handler** — add it after the existing handlers (~line 255):

```javascript
async function handleScCommand(msg) {
  const commandBody = msg.body.trim().replace(/^sc\s*/i, '').trim();
  await client.sendMessage(msg.from, '⏳ Processing...');

  try {
    const result = await ai.models.generateContent({
      model: modelName,
      contents: [{ parts: [{ text: commandBody }] }],
      config: { systemInstruction: 'You are a scheduling assistant. Reply in the same language as the user.' }
    });
    await client.sendMessage(msg.from, result.text);
  } catch (err) {
    console.error('SC error:', err);
    await client.sendMessage(msg.from, 'Error processing request.');
  }
}
```

**2. Add it to the router** — in the `client.on('message')` block:

```javascript
} else if (msgText.startsWith('sc')) {
  await handleScCommand(msg);
}
```

No other files need to change.

### Handler patterns reference

| Pattern | Use when |
|---------|----------|
| `ai.models.generateContent({ contents: [{ parts }] })` | Stateless one-shot Gemini call |
| `ai.chats.create({ history })` + `chat.sendMessage()` | Multi-turn conversation with memory |
| Add `{ inlineData: { mimeType, data } }` to `parts` | Message has media (image/audio) to process |
| Add `tools: [{ functionDeclarations: mcpTools }]` to config | Command needs GreenInvoice API access |

---

## Adding New MCP Tools

MCP tools live in `GreenInvoice-MCP-main/src/tools.ts`.

**To add a new action to an existing tool** (e.g. a new document action):

```typescript
case "my_new_action":
  return json(await client.post("/documents/my-endpoint", data));
```

Add the new value to the `z.enum([...])` for that tool's `action` parameter.

**To register a brand-new tool:**

```typescript
server.tool(
  "my_tool",
  "Description of what this tool does",
  {
    action: z.enum(["list", "get", "create"]).describe("Action to perform"),
    data: z.string().optional().describe("JSON string of parameters"),
  },
  async ({ action, data: raw }) => {
    const data = parseData(raw);
    switch (action) {
      case "list":  return json(await client.get("/my-endpoint"));
      case "get":   return json(await client.get(`/my-endpoint/${data.id}`));
      case "create": return json(await client.post("/my-endpoint", data));
    }
  }
);
```

After any change, rebuild and restart:

```bash
cd GreenInvoice-MCP-main && npm run build
# then restart the agent
```

Gemini discovers all tools dynamically on startup via `mcpClient.listTools()` — no changes to `agent/index.js` needed.

---

## Managing the Agent

### Windows

Double-click `agent/run-agent-hidden.vbs` to start silently in the system tray.  
Right-click the tray icon → **View Logs** / **Stop Agent**.

To auto-start: copy `run-agent-hidden.vbs` to `shell:startup`.

### Android

```bash
~/greenInoviceAgent/start-background.sh          # start in background
~/greenInoviceAgent/stop.sh                      # stop
tail -f ~/greenInoviceAgent/agent.log            # live logs
~/greenInoviceAgent/stop.sh && ~/greenInoviceAgent/start-background.sh  # restart
```

### Re-pairing WhatsApp

The session is saved in `agent/whatsapp-auth/`. To re-pair:

```bash
rm -rf ~/greenInoviceAgent/agent/whatsapp-auth
~/greenInoviceAgent/start.sh
```

If `WHATSAPP_PHONE` is set you'll get a pairing code; otherwise scan the QR code.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `Cannot find package 'whatsapp-web.js'` | npm install incomplete | `cd agent && npm install` |
| `MCP_SERVER_PATH is not set` | Missing `.env` entry | Add `MCP_SERVER_PATH=` to `agent/.env` |
| Agent responds but says "authentication error" | Wrong GreenInvoice credentials | Re-enter `GREENINVOICE_API_ID` / `GREENINVOICE_API_SECRET` in `.env` |
| `window.onCodeReceivedEvent is not a function` | Outdated whatsapp-web.js npm version | `rm -rf agent/node_modules && cd agent && npm install` |
| Pairing code error, falls back to QR | WhatsApp API timing | Delete `agent/whatsapp-auth/`, restart, wait ~5s for the code |
| `chromium not found` on Android | Chromium not installed | `pkg install x11-repo && pkg update -y && pkg install chromium` |
| Hash mismatch on Termux package | Corrupted third-party mirror | Switch to official mirror: `echo "deb https://packages-cf.termux.dev/apt/termux-main stable main" > $PREFIX/etc/apt/sources.list && apt-get update` |
| Agent killed when phone sleeps | Missing wake lock | Ensure `~/.termux/boot/start-agent.sh` runs `termux-wake-lock` |
| `MCP server not starting` on Android | Wrong `MCP_SERVER_PATH` | Verify: `ls $(grep MCP_SERVER_PATH ~/greenInoviceAgent/agent/.env \| cut -d= -f2)` |
