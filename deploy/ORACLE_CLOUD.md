# Deploy to Oracle Cloud Always Free

## What you get (free forever)
- Ubuntu 22.04 VM — up to 4 OCPUs + 24 GB RAM (ARM) or 1 OCPU + 1 GB RAM (AMD)
- 200 GB block storage
- Always-on (never sleeps)

---

## Step 1 — Create an Oracle Cloud account

1. Go to **cloud.oracle.com** → click **Start for free**
2. Fill in your details — a credit card is required for identity verification but you will **not be charged** for Always Free resources
3. Select a home region (e.g., `eu-frankfurt-1`, `us-ashburn-1`) — **you cannot change this later**
4. Complete email verification and sign in

---

## Step 2 — Provision a free VM

1. In the Oracle Cloud Console: **Compute → Instances → Create instance**
2. **Name:** `greeninvoice-agent`
3. **Image:** Ubuntu 22.04 (Minimal recommended)
4. **Shape:**
   - ARM (more free resources): `VM.Standard.A1.Flex` → set **1 OCPU, 6 GB RAM**
   - AMD (simpler): `VM.Standard.E2.1.Micro` (1 OCPU, 1 GB RAM) — enough for light usage
5. **Networking:** keep defaults (public subnet, public IP assigned automatically)
6. **SSH keys:** upload your public key (`~/.ssh/id_rsa.pub`) or let Oracle generate one (download the private key)
7. Click **Create**

Wait ~2 minutes for the instance to reach **Running** state.

---

## Step 3 — Open firewall for the dashboard (optional)

Only needed if you want to access the web dashboard remotely.

1. **Networking → Virtual Cloud Networks → your VCN → Security Lists → Default Security List**
2. Add an **Ingress Rule**: Source `0.0.0.0/0`, Protocol TCP, Port `3001`

Also open the OS firewall on the VM:
```bash
sudo iptables -I INPUT 6 -p tcp --dport 3001 -j ACCEPT
sudo netfilter-persistent save
```

---

## Step 4 — SSH into the VM

```bash
ssh -i ~/.ssh/your-private-key ubuntu@<YOUR_VM_PUBLIC_IP>
```

For ARM instances the default user is `ubuntu`. For some Oracle Linux images it's `opc`.

---

## Step 5 — Clone the repo and run setup

```bash
# Clone the repo
git clone https://github.com/amihay11/greeninoviceagent_gemini.git
cd greeninoviceagent_gemini

# Switch to the deployment branch
git checkout claude/cloud-deployment-research-V1dSg

# Make the setup script executable and run it
chmod +x deploy/oracle-setup.sh
./deploy/oracle-setup.sh
```

The script will:
- Install Node.js 20 LTS, Chromium, and pm2
- Install all npm dependencies
- Build the GreenInvoice MCP server
- Prompt you for your API keys
- Start the agent under pm2 and configure auto-restart on reboot

---

## Step 6 — Authenticate WhatsApp

### Option A — Pairing code (recommended for headless servers)
Set `WHATSAPP_PHONE=972XXXXXXXXX` when prompted by the setup script.

After the agent starts, watch the logs:
```bash
pm2 logs greeninvoice-agent --lines 50
```

A **6-digit pairing code** will appear. On your phone:
> WhatsApp → Settings → Linked Devices → Link a Device → Link with phone number

Enter the code. Done — the session is saved to `agent/.wwebjs_cache/` and survives restarts.

### Option B — QR code
Leave `WHATSAPP_PHONE` blank. The QR code prints as ASCII art in the logs.
You have ~60 seconds to scan it.

---

## Day-to-day commands

```bash
pm2 status                          # agent health
pm2 logs greeninvoice-agent         # live logs
pm2 restart greeninvoice-agent      # restart after .env changes
pm2 stop greeninvoice-agent         # stop
pm2 start ecosystem.config.cjs      # start (if stopped)
```

---

## Updating the agent

```bash
cd ~/greeninoviceagent_gemini
git pull origin claude/cloud-deployment-research-V1dSg
cd GreenInvoice-MCP-main && npm install && npm run build && cd ..
pm2 restart greeninvoice-agent
```

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Chrome crashes / out of memory | Use the ARM shape with ≥4 GB RAM |
| WhatsApp session lost after reboot | Confirm pm2 startup was registered (`pm2 startup`, run printed command) |
| `CHROME_EXECUTABLE_PATH` error | Run `which chromium-browser` and add `CHROME_EXECUTABLE_PATH=<path>` to `agent/.env` |
| MCP server not found | Confirm `MCP_SERVER_PATH` in `.env` points to `GreenInvoice-MCP-main/dist/index.js` |
| Port 3001 unreachable | Check Oracle Security List **and** OS iptables rules |
