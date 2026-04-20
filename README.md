# Morning AI Agent (GreenInvoice & WhatsApp/Email)

An autonomous AI agent powered by Gemini that listens to WhatsApp messages and Emails, interpreting natural language to perform accounting operations via the GreenInvoice (Morning) API.

## Features
- **Multi-Channel**: Listens to WhatsApp (messages starting with "morning command" or "mc") and Emails (subject "morning command").
- **GreenInvoice Integration**: Uses the Model Context Protocol (MCP) to seamlessly interact with Morning APIs (create clients, generate invoices/receipts, check balances, etc).
- **Background Tray App**: Runs silently in the Windows background with a system tray icon for easy management.

---

## Installation on a New Computer

### 1. Prerequisites
Ensure the following are installed on your Windows machine:
- [Node.js](https://nodejs.org/en) (v20+)
- [Git for Windows](https://git-scm.com/download/win)
- Google Chrome

### 2. Download the Repository
Open PowerShell and clone the repository:
```powershell
git clone https://github.com/Amihay11/greenInoviceAgent_gemini.git
cd greenInoviceAgent_gemini
```

### 3. Update Hardcoded Paths
By default, the scripts are configured for a specific Windows user profile path. You must update these paths to match your current system:
1. **`agent/index.js`**: Update the `command` and `args` pointing to the MCP `dist/index.js` (around line 35). Update the Chrome `executablePath` if necessary.
2. **`agent/agent-tray.ps1`**: Update `$workspaceDir` at the top of the file to point to your new installation folder.
3. **`agent/run-agent-hidden.vbs`**: Update the absolute path pointing to `agent-tray.ps1`.

### 4. Create your `.env` File
Create a new file named `.env` inside the `agent/` folder and populate it with your credentials:
```env
GEMINI_API_KEY=your_gemini_api_key_here
EMAIL_USER=your_email@gmail.com
EMAIL_PASSWORD=your_gmail_app_password
ENABLE_WHATSAPP=true
GREENINVOICE_API_ID=your_morning_api_id
GREENINVOICE_API_SECRET=your_morning_api_secret
```

### 5. Install Dependencies & Build
Install the required packages for both the MCP server and the agent:
```powershell
# Setup the MCP Server
cd GreenInvoice-MCP-main
npm install
npm run build

# Setup the Agent
cd ../agent
npm install
```

### 6. First Run (WhatsApp QR Code)
For the very first run, you must execute the agent manually to link your WhatsApp account:
```powershell
node index.js
```
Scan the QR code that appears in the console with your WhatsApp app. Once you see "WhatsApp Client is ready!", press `Ctrl+C` to stop the script.

### 7. Run in the Background
Double-click `agent/run-agent-hidden.vbs`. The agent will launch silently, and a green icon will appear in your Windows System Tray. Right-click the icon to view live logs or stop the agent safely. 
*(Tip: Copy the `.vbs` file to your `shell:startup` folder to have the agent start automatically when you turn on your PC!)*
