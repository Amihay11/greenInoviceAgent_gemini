import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import qrcode from 'qrcode-terminal';
import { GoogleGenAI } from '@google/genai';
import { Client as MCPClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dotenv from 'dotenv';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { simpleParser } from 'mailparser';
import {
  handleNoteCommand, checkReminders, armAllReminders, handleVoiceNote, handleVoiceReply,
  saveNote, searchNotes, getDailySummary, getWeeklySummary, chatWithNotes, scheduleReminder
} from './noteHandler.js';
import {
  buildSystemPrompt,
  GREETING_HE,
  EMAIL_GREETING_HE,
  READY_MESSAGE,
  CANCEL_MESSAGE,
  CONFIRM_MENU_HEADER,
  PROCESSING_MESSAGES,
  INTENT_LABELS,
  HELP_TEXT,
} from './personality/shaul.js';
import { handleMarketingMessage, processScheduledPosts } from './marketing/cmo.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '.env') });

// Ensure Gemini API Key is set
if (!process.env.GEMINI_API_KEY) {
  console.error("Error: GEMINI_API_KEY environment variable is not set. Please set it in a .env file.");
  process.exit(1);
}
if (!process.env.MCP_SERVER_PATH) {
  console.error("Error: MCP_SERVER_PATH environment variable is not set. Please set it in a .env file.");
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const modelName = process.env.GEMINI_MODEL || 'gemini-2.5-pro';
console.log(`Shaul is running on model: ${modelName}`);

// --- MCP Setup ---
let mcpClient;
let mcpTools = [];

async function setupMCP() {
  console.log("Starting GreenInvoice MCP Server...");
  const transport = new StdioClientTransport({
    command: process.env.NODE_EXECUTABLE || 'node',
    args: [process.env.MCP_SERVER_PATH],
    env: {
      ...process.env,
      GREENINVOICE_API_ID: process.env.GREENINVOICE_API_ID,
      GREENINVOICE_API_SECRET: process.env.GREENINVOICE_API_SECRET
    }
  });

  mcpClient = new MCPClient({ name: "whatsapp-agent", version: "1.0.0" }, { capabilities: {} });
  await mcpClient.connect(transport);
  console.log("Connected to GreenInvoice MCP.");

  // Fetch available tools from the MCP server
  const toolsResponse = await mcpClient.listTools();
  
  // Convert MCP tools to Gemini function declarations
  mcpTools = toolsResponse.tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    parameters: {
      type: "OBJECT",
      properties: Object.fromEntries(
        Object.entries(tool.inputSchema?.properties || {}).map(([key, value]) => [
          key,
          {
            type: value.type.toUpperCase(),
            description: value.description || "",
            // Gemini requires items for array type
            ...(value.type === 'array' && value.items ? { items: { type: value.items.type.toUpperCase() } } : {})
          }
        ])
      ),
      required: tool.inputSchema?.required || []
    }
  }));
  console.log(`Loaded ${mcpTools.length} tools from GreenInvoice MCP.`);
}

// --- WhatsApp Setup ---
const puppeteerConfig = { args: ['--no-sandbox', '--disable-dev-shm-usage'] };
if (process.env.CHROME_EXECUTABLE_PATH) {
  puppeteerConfig.executablePath = process.env.CHROME_EXECUTABLE_PATH;
}

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: join(__dirname, 'whatsapp-auth') }),
  puppeteer: puppeteerConfig
});

let pairingCodeRequested = false;
client.on('qr', async (qr) => {
  if (process.env.WHATSAPP_PHONE) {
    if (pairingCodeRequested) return;
    pairingCodeRequested = true;
    try {
      // Wait for WhatsApp's internal API to be ready before requesting
      await new Promise(r => setTimeout(r, 3000));
      const code = await client.requestPairingCode(process.env.WHATSAPP_PHONE);
      console.log('\n==========================================');
      console.log(`  Pairing code: ${code}`);
      console.log('==========================================');
      console.log('WhatsApp → Linked Devices → Link with phone number\n');
    } catch (err) {
      console.error('Pairing code error:', err.message || err);
      console.log('Falling back to QR:');
      qrcode.generate(qr, { small: true });
    }
  } else {
    console.log('Scan the QR code below to authenticate with WhatsApp:');
    qrcode.generate(qr, { small: true });
  }
});

client.on('ready', () => {
  console.log('WhatsApp Client is ready!');
});

// Chat history per contact
const chatHistories = new Map();

// ── Intent classification ──────────────────────────────────────────────────────

const pendingIntentConfirm = new Map(); // chatId → { options, originalMsg, msgText }

const INTENT_LABEL = INTENT_LABELS;

async function classifyIntent(text, ai, modelName) {
  const res = await ai.models.generateContent({
    model: modelName,
    contents: [{ parts: [{ text: `Classify this WhatsApp message into exactly one category. Reply with ONLY the category name, nothing else.

Categories:
- invoice: GreenInvoice tasks — creating invoices, receipts, tax documents, listing clients or documents
- marketing: anything about Facebook/Instagram, ads, posts, campaigns, audience, brand, content, marketing strategy, asking Shaul for marketing advice
- note_remind: setting a reminder for a specific future time
- note_search: searching through saved notes or ideas
- note_summary_day: summarizing today's saved notes
- note_summary_week: summarizing this week's saved notes
- note_chat: asking a question about or discussing saved notes
- note_save: saving a new idea, thought, or memo
- general: any other question, request, or conversation

Message: "${text.slice(0, 400)}"` }] }]
  });
  const clean = ((res.text || '').trim().toLowerCase()).replace(/[^a-z_]/g, '');
  return INTENT_LABEL[clean] ? clean : 'general';
}

function buildConfirmMenu(intent) {
  const primary = INTENT_LABEL[intent];
  const alts = ['marketing', 'note_save', 'invoice', 'general']
    .filter(k => k !== intent)
    .map(k => ({ key: k, label: INTENT_LABEL[k] }))
    .slice(0, 2);

  const opts = [intent, ...alts.map(o => o.key), 'cancel'];
  const lines = [
    `1️⃣  ${primary}`,
    ...alts.map((o, i) => `${i + 2}️⃣  ${o.label}`),
    `${opts.length}️⃣  ❌ ביטול`,
  ];

  return {
    options: opts,
    menuText: `${CONFIRM_MENU_HEADER}\n\n${lines.join('\n')}\n\nשלח מספר 1–${opts.length}`,
  };
}

async function executeIntent(intent, msgText, originalMsg, ai, modelName, waClient) {
  const needsNotion = ['note_save', 'note_search', 'note_summary_day', 'note_summary_week', 'note_chat'];
  if (needsNotion.includes(intent) && (!process.env.NOTION_API_KEY || !process.env.NOTION_NOTES_DB_ID)) {
    await waClient.sendMessage(originalMsg.from, '⚠️ Notion לא מוגדר — הוסף NOTION_API_KEY ו-NOTION_NOTES_DB_ID ל-.env');
    return;
  }
  switch (intent) {
    case 'invoice':           await handleMorningCommand(originalMsg); break;
    case 'marketing':         await handleMkRouted(originalMsg, msgText, ai, modelName, waClient); break;
    case 'note_save':         await saveNote(msgText, originalMsg, ai, modelName, waClient); break;
    case 'note_search':       await searchNotes(msgText, originalMsg, ai, modelName, waClient); break;
    case 'note_summary_day':  await getDailySummary(originalMsg, ai, modelName, waClient); break;
    case 'note_summary_week': await getWeeklySummary(originalMsg, ai, modelName, waClient); break;
    case 'note_chat':         await chatWithNotes(msgText, originalMsg, ai, modelName, waClient); break;
    case 'note_remind':       await scheduleReminder(msgText, originalMsg, ai, modelName, waClient); break;
    default:                  await handleGcCommand(originalMsg);
  }
}

async function handleMkRouted(originalMsg, msgText, ai, modelName, waClient) {
  try {
    const reply = await handleMarketingMessage({ chatId: originalMsg.from, text: msgText, ai, modelName });
    if (reply) await waClient.sendMessage(originalMsg.from, reply);
  } catch (err) {
    console.error('Marketing handler error:', err);
    await waClient.sendMessage(originalMsg.from, `שגיאה במחלקת השיווק: ${err.message}`);
  }
}

async function handleIntentConfirm(msg, ai, modelName, waClient) {
  if (!pendingIntentConfirm.has(msg.from)) return false;
  const choice = msg.body.trim();
  if (!/^\d$/.test(choice)) {
    pendingIntentConfirm.delete(msg.from);
    return false; // treat as a new message
  }

  const { options, originalMsg, msgText } = pendingIntentConfirm.get(msg.from);
  pendingIntentConfirm.delete(msg.from);

  const intent = options[parseInt(choice, 10) - 1];
  if (!intent || intent === 'cancel') {
    await waClient.sendMessage(msg.from, CANCEL_MESSAGE);
    return true;
  }
  await executeIntent(intent, msgText, originalMsg, ai, modelName, waClient);
  return true;
}

async function handleMorningCommand(msg) {
  const contact = await msg.getContact();
  const contactName = contact.pushname || contact.number || "User";
  console.log(`Received Morning Command message from ${contactName}: ${msg.body}`);

  const greet = GREETING_HE(contactName);
  const history = chatHistories.get(msg.from) || [
    { role: "user", parts: [{ text: greet.userSeed }] },
    { role: "model", parts: [{ text: greet.modelSeed }] }
  ];

  try {
    console.log(`Sending WhatsApp message to Gemini...`);

    await client.sendMessage(msg.from, PROCESSING_MESSAGES.invoice);

    const chat = ai.chats.create({
      model: modelName,
      history: history,
      config: {
        tools: [{ functionDeclarations: mcpTools }],
        systemInstruction: buildSystemPrompt({ channel: 'whatsapp', task: 'invoice' })
      }
    });

    let result = await chat.sendMessage({ message: msg.body });

    while (result.functionCalls && result.functionCalls.length > 0) {
      const functionCall = result.functionCalls[0];
      console.log(`Gemini is calling tool: ${functionCall.name}`);

      try {
        const mcpResponse = await mcpClient.callTool({
          name: functionCall.name,
          arguments: functionCall.args
        });

        let functionResponseData = { result: "Tool executed but no specific output returned." };
        if (mcpResponse.content && mcpResponse.content.length > 0) {
          try {
            functionResponseData = JSON.parse(mcpResponse.content[0].text);
          } catch(e) {
            functionResponseData = { result: mcpResponse.content[0].text };
          }
        } else if (mcpResponse.isError) {
          functionResponseData = { error: "The tool returned an error." };
        }

        console.log(`Sending tool result back to Gemini...`);
        result = await chat.sendMessage({
          message: [{
            functionResponse: {
              name: functionCall.name,
              response: functionResponseData
            }
          }]
        });
      } catch (error) {
        console.error(`Error calling MCP tool ${functionCall.name}:`, error);
        result = await chat.sendMessage({
          message: [{
            functionResponse: {
              name: functionCall.name,
              response: { error: error.message }
            }
          }]
        });
      }
    }

    const finalResponse = result.text;

    const updatedHistory = await chat.getHistory();
    chatHistories.set(msg.from, updatedHistory);

    await client.sendMessage(msg.from, finalResponse);

  } catch (error) {
    console.error("Error processing message:", error);
    await client.sendMessage(msg.from, "Sorry, I encountered an error while processing your request.");
  }
}

// gc command: general Gemini queries and image analysis
async function handleGcCommand(msg) {
  const commandBody = msg.body.trim();
  const parts = [];

  if (msg.hasMedia && msg.type === 'image') {
    await client.sendMessage(msg.from, PROCESSING_MESSAGES.image);
    const media = await msg.downloadMedia();
    if (media) parts.push({ inlineData: { mimeType: media.mimetype, data: media.data } });
  } else {
    await client.sendMessage(msg.from, PROCESSING_MESSAGES.generic);
  }

  const prompt = commandBody.length > 0 ? commandBody
    : parts.length > 0 ? "Analyze this image and describe or extract all visible text."
    : null;

  if (!prompt) {
    await client.sendMessage(msg.from, "Usage: gc <question> or send an image with gc as caption.");
    return;
  }
  parts.push({ text: prompt });

  try {
    const result = await ai.models.generateContent({
      model: modelName,
      contents: [{ parts }],
      config: {
        systemInstruction: buildSystemPrompt({ channel: 'whatsapp', task: 'general' })
      }
    });
    await client.sendMessage(msg.from, result.text || "No response generated.");
  } catch (err) {
    console.error("GC command error:", err);
    await client.sendMessage(msg.from, "Sorry, I encountered an error.");
  }
}

client.on('message', async msg => {
  if (msg.from === 'status@broadcast') return;

  // Voice notes → pipeline menu immediately (no processing yet)
  if (msg.type === 'ptt' || msg.type === 'audio') {
    await handleVoiceNote(msg, ai, modelName, client);
    return;
  }

  // Pending voice menu replies (Menu 1 and Menu 2)
  if (await handleVoiceReply(msg, ai, modelName, client)) return;

  // Pending intent confirmation menu
  if (await handleIntentConfirm(msg, ai, modelName, client)) return;

  const msgText = msg.body.trim();
  const lower = msgText.toLowerCase();

  if (lower === 'help' || lower === 'עזרה') {
    await handleHelpCommand(msg);
    return;
  }

  // Marketing department — explicit prefix bypasses intent classifier.
  if (lower.startsWith('mk ') || lower === 'mk') {
    await handleMkRouted(msg, msgText, ai, modelName, client);
    return;
  }

  // Image → analyze directly (intent is unambiguous)
  if (msg.hasMedia && msg.type === 'image') {
    await handleGcCommand(msg);
    return;
  }

  // Bare phone number → wa.me link directly
  const digits = msgText.replace(/\D/g, '');
  if (/^[+\d][\d\s\-(). ]+$/.test(msgText) && digits.length >= 7 && digits.length <= 15) {
    const normalized = digits.startsWith('972') ? digits
      : digits.startsWith('0') ? '972' + digits.slice(1)
      : '972' + digits;
    await client.sendMessage(msg.from, `https://wa.me/${normalized}`);
    return;
  }

  // Classify intent → show confirmation menu
  let intent = 'general';
  try { intent = await classifyIntent(msgText, ai, modelName); } catch (_) {}

  const { options, menuText } = buildConfirmMenu(intent);
  pendingIntentConfirm.set(msg.from, { options, originalMsg: msg, msgText });
  await client.sendMessage(msg.from, menuText);
});

// Start reminders after WhatsApp is ready (also fires on reconnect)
client.on('ready', () => {
  armAllReminders(client);
  setInterval(() => checkReminders(client), 30 * 1000);

  // Marketing: publish any due scheduled FB/IG posts every minute.
  setInterval(() => {
    processScheduledPosts().catch(err => console.error('Scheduled-posts loop error:', err.message));
  }, 60 * 1000);

  if (process.env.WHATSAPP_PHONE) {
    const me = `${process.env.WHATSAPP_PHONE}@c.us`;
    client.sendMessage(me, READY_MESSAGE).catch(console.error);
  }
});

async function handleHelpCommand(msg) {
  await client.sendMessage(msg.from, HELP_TEXT);
}

// --- Email Setup ---
let emailTransporter;
const emailHistories = new Map();

async function setupEmail() {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASSWORD) {
    console.log("Email credentials not set. Skipping Email agent setup. Set EMAIL_PASSWORD in .env to enable.");
    return;
  }

  // Set up SMTP for sending replies
  emailTransporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASSWORD
    }
  });

  // Set up IMAP for listening
  const imapClient = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASSWORD
    },
    logger: false
  });

  await imapClient.connect();
  console.log("Email listener connected!");

  imapClient.on('error', err => {
    console.error('IMAP Client Error:', err.message);
  });
  
  imapClient.on('close', () => {
    console.log('IMAP connection closed. Reconnecting in 5 seconds...');
    setTimeout(() => {
      imapClient.connect().then(() => {
        console.log('IMAP reconnected successfully.');
        return imapClient.mailboxOpen('INBOX');
      }).catch(err => console.error('IMAP reconnect failed:', err.message));
    }, 5000);
  });

  // Select INBOX
  await imapClient.mailboxOpen('INBOX');
  
  // Check for any unread messages immediately on start
  await checkUnreadEmails(imapClient);

  // Listen for new messages
  imapClient.on('exists', async () => {
    await checkUnreadEmails(imapClient);
  });
}

async function checkUnreadEmails(imapClient) {
  try {
    const messagesToProcess = [];
    
    // 1. Fetch all matching messages first
    for await (let msg of imapClient.fetch({ seen: false }, { uid: true, source: true, envelope: true })) {
      const subject = msg.envelope.subject || "";
      if (subject.toLowerCase().includes("morning command")) {
        // Collect them into an array to prevent IMAP connection deadlock
        messagesToProcess.push({
          uid: msg.uid,
          source: msg.source,
          subject: subject
        });
      }
    }

    // 2. Process them and execute other IMAP commands safely
    for (const msg of messagesToProcess) {
      const parsed = await simpleParser(msg.source);
      const sender = parsed.from.value[0].address;
      const text = parsed.text || parsed.html || "";
      console.log(`Received Morning Command email from ${sender}`);
      
      // Mark as read
      await imapClient.messageFlagsAdd({ uid: msg.uid }, ['\\Seen'], { uid: true });
      
      await processEmailMessage(sender, msg.subject, text);
    }
  } catch (err) {
    console.error('IMAP error during fetch:', err);
  }
}

// Function to handle Gemini logic for Emails
async function processEmailMessage(sender, subject, text) {
  const greet = EMAIL_GREETING_HE(sender);
  const history = emailHistories.get(sender) || [
    { role: "user", parts: [{ text: greet.userSeed }] },
    { role: "model", parts: [{ text: greet.modelSeed }] }
  ];

  try {
    console.log(`Sending Email message to Gemini...`);
    const chat = ai.chats.create({
      model: modelName,
      history: history,
      config: {
        tools: [{ functionDeclarations: mcpTools }],
        systemInstruction: buildSystemPrompt({ channel: 'email', task: 'invoice' })
      }
    });

    let result = await chat.sendMessage({ message: `Subject: ${subject}\n\n${text}` });

    while (result.functionCalls && result.functionCalls.length > 0) {
      const functionCall = result.functionCalls[0];
      console.log(`Gemini (Email) is calling tool: ${functionCall.name}`);
      try {
        const mcpResponse = await mcpClient.callTool({ name: functionCall.name, arguments: functionCall.args });
        let functionResponseData = { result: "Tool executed." };
        if (mcpResponse.content && mcpResponse.content.length > 0) {
          try { functionResponseData = JSON.parse(mcpResponse.content[0].text); }
          catch(e) { functionResponseData = { result: mcpResponse.content[0].text }; }
        } else if (mcpResponse.isError) {
          functionResponseData = { error: "The tool returned an error." };
        }
        result = await chat.sendMessage({ message: [{ functionResponse: { name: functionCall.name, response: functionResponseData } }] });
      } catch (error) {
        result = await chat.sendMessage({ message: [{ functionResponse: { name: functionCall.name, response: { error: error.message } } }] });
      }
    }

    const finalResponse = result.text;
    
    // Save updated history
    const updatedHistory = await chat.getHistory();
    emailHistories.set(sender, updatedHistory);
    
    // Reply via Email
    await emailTransporter.sendMail({
      from: process.env.EMAIL_USER,
      to: sender,
      subject: `Re: ${subject}`,
      text: finalResponse
    });
    console.log(`Replied to email from ${sender}`);

  } catch (error) {
    console.error("Error processing email message:", error);
  }
}

// Start everything
async function start() {
  await setupMCP();
  await setupEmail();
  
  if (process.env.ENABLE_WHATSAPP === 'true') {
    console.log("Initializing WhatsApp Client...");
    client.initialize();
  } else {
    console.log("Skipping WhatsApp Client. ENABLE_WHATSAPP is not 'true' in .env. Only Email is active.");
  }
}

start().catch(console.error);
