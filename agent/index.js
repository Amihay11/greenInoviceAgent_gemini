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
  buildToolsBlock,
  GREETING_HE,
  EMAIL_GREETING_HE,
  READY_MESSAGE,
  CANCEL_MESSAGE,
  CONFIRM_MENU_HEADER,
  PROCESSING_MESSAGES,
  INTENT_LABELS,
  HELP_TEXT,
} from './personality/shaul.js';
import {
  handleMarketingMessage, processScheduledPosts, getDailyBriefingsToSend,
  registerSendWhatsappPending, hasPendingSendWhatsapp,
  canSendProactive, consumeProactiveBudget,
} from './marketing/cmo.js';
import { parseAllowList, normalizeJid } from './marketing/jid.js';
import { logCalendarEvent, bumpAgendaNudge, setAgendaMute, setAgendaMuteByTopic, setAgendaStatus, listAgenda, getMemory, setMemory, listAllUserIds } from './marketing/memory.js';
import { startNotionPollLoop } from './marketing/notion-memory.js';
import { runForgettingSweep } from './marketing/forgetting.js';

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

// Computed once at startup — which tools are active drives both the system
// prompt and Shaul's proactive tool suggestions in conversation.
const TOOLS_BLOCK = buildToolsBlock({
  hasGreenInvoice: Boolean(process.env.MCP_SERVER_PATH),
  hasCalendar:     Boolean(process.env.CALENDAR_MCP_PATH),
  hasCanva:        Boolean(process.env.CANVA_CLIENT_ID && process.env.CANVA_CLIENT_SECRET && process.env.CANVA_REFRESH_TOKEN),
  hasMeta:         Boolean(process.env.META_PAGE_TOKEN && (process.env.META_PAGE_ID || process.env.IG_BUSINESS_ID)),
  hasNotion:       Boolean(process.env.NOTION_API_KEY && process.env.NOTION_MEMORY_PARENT_PAGE_ID),
  hasEmail:        Boolean(process.env.GMAIL_USER && process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_SECRET && process.env.GMAIL_REFRESH_TOKEN),
});

const DEPRECATED_MODELS = {
  'gemini-1.5-pro':          'gemini-1.5-pro',
  'gemini-1.5-flash':        'gemini-1.5-flash',
  'gemini-2.0-flash-exp':    'gemini-2.0-flash',
};

let modelName = process.env.GEMINI_MODEL || 'gemini-2.5-pro';
if (DEPRECATED_MODELS[modelName]) {
  console.warn(`⚠️  Model '${modelName}' is deprecated or unavailable. Auto-upgrading to '${DEPRECATED_MODELS[modelName]}'.`);
  modelName = DEPRECATED_MODELS[modelName];
}
console.log(`Shaul is running on model: ${modelName}`);

// --- MCP Setup (multi-server) ---
const mcpClients = [];           // [{ name, client }]
let mcpTools = [];                // Gemini function declarations from all servers
const toolToClientMap = new Map(); // toolName -> MCPClient
const toolServerMap = new Map();   // toolName -> server name (for audit + routing)

function toolToGeminiDeclaration(tool) {
  return {
    name: tool.name,
    description: tool.description,
    parameters: {
      type: "OBJECT",
      properties: Object.fromEntries(
        Object.entries(tool.inputSchema?.properties || {}).map(([key, value]) => {
          const prop = {
            type: (value.type || 'string').toUpperCase(),
            description: value.description || "",
          };
          if (value.type === 'array' && value.items) {
            prop.items = { type: (value.items.type || 'string').toUpperCase() };
          }
          return [key, prop];
        })
      ),
      required: tool.inputSchema?.required || [],
    },
  };
}

async function setupMCP() {
  const servers = [
    process.env.MCP_SERVER_PATH && {
      name: 'GreenInvoice',
      path: process.env.MCP_SERVER_PATH,
      env: {
        GREENINVOICE_API_ID: process.env.GREENINVOICE_API_ID,
        GREENINVOICE_API_SECRET: process.env.GREENINVOICE_API_SECRET,
      },
    },
    process.env.CALENDAR_MCP_PATH && {
      name: 'GoogleCalendar',
      path: process.env.CALENDAR_MCP_PATH,
      env: {
        GOOGLE_CALENDAR_CREDENTIALS: process.env.GOOGLE_CALENDAR_CREDENTIALS,
        GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
        GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
        GOOGLE_REFRESH_TOKEN: process.env.GOOGLE_REFRESH_TOKEN,
      },
    },
    process.env.CANVA_MCP_PATH && {
      name: 'Canva',
      path: process.env.CANVA_MCP_PATH,
      env: { CANVA_API_KEY: process.env.CANVA_API_KEY },
    },
    process.env.META_MCP_PATH && {
      name: 'Meta',
      path: process.env.META_MCP_PATH,
      env: {
        META_PAGE_TOKEN: process.env.META_PAGE_TOKEN,
        META_PAGE_ID: process.env.META_PAGE_ID,
        IG_BUSINESS_ID: process.env.IG_BUSINESS_ID,
      },
    },
  ].filter(Boolean);

  for (const server of servers) {
    try {
      console.log(`Starting ${server.name} MCP server...`);
      const transport = new StdioClientTransport({
        command: process.env.NODE_EXECUTABLE || 'node',
        args: [server.path],
        env: { ...process.env, ...server.env },
      });
      const client = new MCPClient({ name: 'whatsapp-agent', version: '1.0.0' }, { capabilities: {} });
      await client.connect(transport);
      const toolsResponse = await client.listTools();
      for (const tool of toolsResponse.tools) {
        toolToClientMap.set(tool.name, client);
        toolServerMap.set(tool.name, server.name);
        mcpTools.push(toolToGeminiDeclaration(tool));
      }
      mcpClients.push({ name: server.name, client });
      console.log(`Connected to ${server.name} MCP — ${toolsResponse.tools.length} tools.`);
    } catch (err) {
      console.error(`Failed to start ${server.name} MCP:`, err.message);
    }
  }
  console.log(`Total MCP tools loaded: ${mcpTools.length}`);
}

// Convenience: the GreenInvoice client for code paths that need it directly
// (e.g. contact lookup for send_whatsapp_message).
function getGreenInvoiceClient() {
  const entry = mcpClients.find(c => c.name === 'GreenInvoice');
  return entry?.client || null;
}

// --- Local function-tool: send_email ---
const SEND_EMAIL_DECL = {
  name: 'send_email',
  description: 'Send an email from ortaladler5@gmail.com to one recipient. Use for outbound marketing emails, follow-ups, and campaign outreach. Always show the user what you are about to send and get confirmation first — unless the user explicitly said "שלח עכשיו" or "תשלח".',
  parameters: {
    type: 'OBJECT',
    properties: {
      to:      { type: 'STRING', description: 'Recipient email address.' },
      subject: { type: 'STRING', description: 'Email subject line.' },
      body:    { type: 'STRING', description: 'Plain-text email body.' },
    },
    required: ['to', 'subject', 'body'],
  },
};

async function handleSendEmailLocal({ args }) {
  const { to, subject, body } = args || {};
  if (!to || !subject || !body) {
    return { status: 'error', error: 'Missing to/subject/body' };
  }
  if (!emailTransporter) {
    return { status: 'error', error: 'Gmail not configured — run agent/scripts/gmail-oauth.js first.' };
  }
  try {
    await emailTransporter.sendMail({
      from: process.env.GMAIL_USER,
      to,
      subject,
      text: body,
    });
    console.log(`[email] Sent to ${to} — "${subject}"`);
    return { status: 'sent', to, subject };
  } catch (err) {
    console.error('[email] Send failed:', err.message);
    return { status: 'error', error: err.message };
  }
}

// --- Local function-tools: agenda control (snooze / mute / done / pin) ---
const SNOOZE_AGENDA_DECL = {
  name: 'snooze_agenda_item',
  description: 'Defer an agenda item by id for N days so Shaul stops mentioning it temporarily.',
  parameters: {
    type: 'OBJECT',
    properties: {
      id:   { type: 'NUMBER', description: 'Agenda item id' },
      days: { type: 'NUMBER', description: 'How many days to snooze (default 3)' },
    },
    required: ['id'],
  },
};

const MUTE_TOPIC_DECL = {
  name: 'mute_topic',
  description: 'Silence all agenda items of a given topic for N days.',
  parameters: {
    type: 'OBJECT',
    properties: {
      topic: { type: 'STRING', description: 'Topic slug (e.g. budget, campaign, post_ig)' },
      days:  { type: 'NUMBER', description: 'Mute duration in days (default 7)' },
    },
    required: ['topic'],
  },
};

const MARK_AGENDA_DONE_DECL = {
  name: 'mark_agenda_done',
  description: 'Mark an agenda item as done by id.',
  parameters: {
    type: 'OBJECT',
    properties: {
      id: { type: 'NUMBER', description: 'Agenda item id' },
    },
    required: ['id'],
  },
};

const PIN_FACT_DECL = {
  name: 'pin_fact',
  description: 'Pin a key fact so it appears in every Shaul reply context. Use for things the user tells Shaul to always remember.',
  parameters: {
    type: 'OBJECT',
    properties: {
      key:   { type: 'STRING', description: 'Short label for the fact' },
      value: { type: 'STRING', description: 'The fact value' },
    },
    required: ['key', 'value'],
  },
};

const UNPIN_FACT_DECL = {
  name: 'unpin_fact',
  description: 'Remove a previously pinned fact by key.',
  parameters: {
    type: 'OBJECT',
    properties: {
      key: { type: 'STRING', description: 'The fact label to remove' },
    },
    required: ['key'],
  },
};

function handleAgendaControlLocal({ chatId, toolName, args }) {
  const userId = chatId;
  switch (toolName) {
    case 'snooze_agenda_item': {
      const days = Number(args.days) || 3;
      const until = new Date(Date.now() + days * 86400_000).toISOString();
      setAgendaMute(Number(args.id), until);
      return { status: 'ok', message: `Snoozed for ${days} days.` };
    }
    case 'mute_topic': {
      const days = Number(args.days) || 7;
      setAgendaMuteByTopic(userId, String(args.topic), days);
      return { status: 'ok', message: `Topic "${args.topic}" muted for ${days} days.` };
    }
    case 'mark_agenda_done': {
      setAgendaStatus(Number(args.id), 'done');
      return { status: 'ok', message: 'Marked done.' };
    }
    case 'pin_fact': {
      const existing = getMemory(userId, '_pinned_facts');
      const pins = existing ? JSON.parse(existing) : {};
      pins[String(args.key)] = String(args.value);
      setMemory(userId, '_pinned_facts', JSON.stringify(pins));
      return { status: 'ok', message: `Pinned: ${args.key} = ${args.value}` };
    }
    case 'unpin_fact': {
      const existing = getMemory(userId, '_pinned_facts');
      if (existing) {
        const pins = JSON.parse(existing);
        delete pins[String(args.key)];
        setMemory(userId, '_pinned_facts', JSON.stringify(pins));
      }
      return { status: 'ok', message: `Unpinned: ${args.key}` };
    }
    default:
      return { error: 'Unknown local tool' };
  }
}

const AGENDA_CONTROL_TOOLS = [
  SNOOZE_AGENDA_DECL, MUTE_TOPIC_DECL, MARK_AGENDA_DONE_DECL, PIN_FACT_DECL, UNPIN_FACT_DECL,
];
const AGENDA_CONTROL_NAMES = new Set(AGENDA_CONTROL_TOOLS.map(t => t.name));

// --- Local function-tool: send_whatsapp_message ---
// Approval-gated: when Gemini calls this, we DO NOT send. We register the
// pending approval in cmo.js and wait for the user to type אשר/בטל. The user's
// next message routes through cmo.js where the approval gate fires.
const SEND_WHATSAPP_DECL = {
  name: 'send_whatsapp_message',
  description: 'Propose sending a WhatsApp message to a client (NOT to the user themselves). The user will see a preview and must approve with "אשר" before the message is actually sent. Use AFTER looking up the phone via the GreenInvoice client tool. Never use to message the user — they are already in this conversation.',
  parameters: {
    type: 'OBJECT',
    properties: {
      phone: { type: 'STRING', description: 'Client phone in E.164 (972…) or local (0XX-XXX-XXXX). Will be normalized.' },
      target_label: { type: 'STRING', description: 'Display name for the client (e.g. "דנה כהן"). Used in the approval preview.' },
      message: { type: 'STRING', description: 'The full message body in the user\'s language (default Hebrew).' },
    },
    required: ['phone', 'message'],
  },
};

async function handleSendWhatsappLocal({ chatId, args }) {
  const { phone, message, target_label } = args || {};
  const jid = normalizeJid(phone);
  if (!jid) {
    return { status: 'error', error: 'invalid phone number — could not normalize' };
  }
  if (!message || !String(message).trim()) {
    return { status: 'error', error: 'empty message' };
  }
  // Don't let Gemini DM the user themselves.
  if (jid === chatId) {
    return { status: 'error', error: 'cannot send to the user themselves — they are already in this chat' };
  }
  registerSendWhatsappPending(chatId, { jid, message, targetLabel: target_label || null });
  // Show the user the preview. The actual send happens in cmo.executeApproved
  // when the user types אשר.
  const preview = `📤 *לאשר שליחה ל${target_label ? ` *${target_label}*` : ''} (${phone})*?\n\n${message}\n\n_שלח *אשר* לשליחה, או *בטל* לביטול._`;
  try { await client.sendMessage(chatId, preview); } catch (_) {}
  return { status: 'pending_approval', preview_shown_to_user: true, message: 'Preview shown; awaiting user approval. Do NOT call this tool again — the user will reply אשר/בטל and the system will handle it.' };
}

// --- Shared Gemini tool-call loop ---
function parseMcpResult(mcpResponse) {
  if (mcpResponse?.content && mcpResponse.content.length > 0) {
    try {
      return JSON.parse(mcpResponse.content[0].text);
    } catch (_) {
      return { result: mcpResponse.content[0].text };
    }
  }
  if (mcpResponse?.isError) return { error: 'The tool returned an error.' };
  return { result: 'Tool executed but no specific output returned.' };
}

// Best-effort audit log for Calendar mutations. We can't reliably know which
// tool name a given Calendar MCP exposes, so we match by server name.
function maybeLogCalendarMutation({ chatId, toolName, args, response }) {
  const server = toolServerMap.get(toolName);
  if (server !== 'GoogleCalendar') return;
  if (!/create|insert|update|delete|move|patch/i.test(toolName)) return;
  try {
    const ev = response?.event || response;
    logCalendarEvent({
      userId: chatId,
      gcalEventId: ev?.id || ev?.eventId || null,
      summary: ev?.summary || args?.summary || null,
      startAt: ev?.start?.dateTime || ev?.start?.date || args?.start || args?.startDateTime || null,
      endAt: ev?.end?.dateTime || ev?.end?.date || args?.end || args?.endDateTime || null,
      toolName,
      rawArgs: args,
      rawResponse: response,
    });
  } catch (e) {
    console.error('[calendar audit] failed:', e.message);
  }
}

async function runGeminiWithTools({ chatId, history, message, systemInstruction, extraTools = [], includeSendWhatsapp = false, includeSendEmail = false, includeAgendaTools = false, toolScope = 'all' }) {
  const scopedMcp = toolScope === 'marketing' ? [] : mcpTools;
  const declarations = [...scopedMcp, ...extraTools];
  if (includeSendWhatsapp) declarations.push(SEND_WHATSAPP_DECL);
  if (includeSendEmail && isEmailConfigured()) declarations.push(SEND_EMAIL_DECL);
  if (includeAgendaTools) declarations.push(...AGENDA_CONTROL_TOOLS);

  const chat = ai.chats.create({
    model: modelName,
    history,
    config: {
      tools: declarations.length > 0 
        ? [{ functionDeclarations: declarations }] 
        : [{ googleSearch: {} }],
      systemInstruction,
    },
  });

  let result = await chat.sendMessage({ message });

  while (result.functionCalls && result.functionCalls.length > 0) {
    const fc = result.functionCalls[0];
    console.log(`Gemini is calling tool: ${fc.name}`);
    let response;
    try {
      if (fc.name === 'send_whatsapp_message') {
        response = await handleSendWhatsappLocal({ chatId, args: fc.args || {} });
      } else if (fc.name === 'send_email') {
        response = await handleSendEmailLocal({ args: fc.args || {} });
      } else if (AGENDA_CONTROL_NAMES.has(fc.name)) {
        response = handleAgendaControlLocal({ chatId, toolName: fc.name, args: fc.args || {} });
      } else {
        const c = toolToClientMap.get(fc.name);
        if (!c) throw new Error(`No MCP client registered for tool: ${fc.name}`);
        const mcpResponse = await c.callTool({ name: fc.name, arguments: fc.args || {} });
        response = parseMcpResult(mcpResponse);
        maybeLogCalendarMutation({ chatId, toolName: fc.name, args: fc.args, response });
      }
    } catch (err) {
      console.error(`Error executing tool ${fc.name}:`, err.message);
      response = { error: err.message };
    }
    result = await chat.sendMessage({
      message: [{ functionResponse: { name: fc.name, response } }],
    });
  }

  return { text: result.text, history: await chat.getHistory() };
}

// --- WhatsApp Setup ---
const puppeteerConfig = {
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-accelerated-2d-canvas',
    '--disable-gpu',
    '--no-first-run',
    '--no-zygote',
    '--single-process',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-default-apps',
    '--disable-sync',
    '--disable-translate',
    '--metrics-recording-only',
    '--mute-audio',
    '--safebrowsing-disable-auto-update',
  ],
};
if (process.env.CHROME_EXECUTABLE_PATH) {
  puppeteerConfig.executablePath = process.env.CHROME_EXECUTABLE_PATH;
}

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: join(__dirname, 'whatsapp-auth') }),
  puppeteer: puppeteerConfig,
  webVersion: '2.3000.1017054612-alpha',
  webVersionCache: {
    type: 'local',
    path: join(__dirname, 'whatsapp-web-cache'),
  },
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
- marketing: ANY conversation about the user's business, products, services, customers (ICP),
  goals, competitors, brand, content, posts, ads, campaigns, social channels, marketing
  strategy, workshop attendance ("היו 12 ילדים"), OR asking Shaul for marketing/business
  advice. If the message is ABOUT THEIR BUSINESS or strategy, this is marketing.
- note_remind: setting a reminder for a specific future time
- note_search: searching through saved notes or ideas
- note_summary_day: summarizing today's saved notes
- note_summary_week: summarizing this week's saved notes
- note_chat: asking a question about or discussing saved notes
- note_save: a personal memo UNRELATED to the business — a fleeting thought, a TODO, a
  link to remember later. Do NOT use this for statements about the business itself.
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

const MAX_MK_HISTORY = 20; // keep last 10 user+model turns

async function handleMkRouted(originalMsg, msgText, ai, modelName, waClient) {
  const sessionHistory = chatHistories.get(originalMsg.from) || [];
  try {
    const reply = await handleMarketingMessage({
      chatId: originalMsg.from,
      text: msgText,
      ai,
      modelName,
      runGeminiWithTools,
      getGreenInvoiceClient,
      waClient,
      toolsBlock: TOOLS_BLOCK,
      sessionHistory,
    });
    if (reply) {
      // Maintain a rolling session window so the next turn has context.
      const updated = [
        ...sessionHistory,
        { role: 'user', parts: [{ text: msgText }] },
        { role: 'model', parts: [{ text: reply }] },
      ].slice(-MAX_MK_HISTORY);
      chatHistories.set(originalMsg.from, updated);
      await waClient.sendMessage(originalMsg.from, reply);
    }
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

    const { text: finalResponse, history: updatedHistory } = await runGeminiWithTools({
      chatId: msg.from,
      history,
      message: msg.body,
      systemInstruction: buildSystemPrompt({ channel: 'whatsapp', task: 'invoice', tools: TOOLS_BLOCK }),
    });

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
        systemInstruction: buildSystemPrompt({ channel: 'whatsapp', task: 'general', tools: TOOLS_BLOCK })
      }
    });
    await client.sendMessage(msg.from, result.text || "No response generated.");
  } catch (err) {
    console.error("GC command error:", err);
    await client.sendMessage(msg.from, "Sorry, I encountered an error.");
  }
}

// Phone allow-list. Empty = accept everyone (preserves prior behaviour for
// users who haven't configured it). Set SHAUL_ALLOWED_NUMBERS in .env to
// restrict — e.g. SHAUL_ALLOWED_NUMBERS=0527203222,0546736909
const ALLOW_LIST = parseAllowList(process.env.SHAUL_ALLOWED_NUMBERS);
if (ALLOW_LIST.length > 0) {
  console.log(`Allow-list active: ${ALLOW_LIST.join(', ')}`);
}

client.on('message', async msg => {
  if (msg.from === 'status@broadcast') return;

  if (ALLOW_LIST.length > 0 && !ALLOW_LIST.includes(msg.from)) {
    console.log(`[acl] dropped message from ${msg.from}`);
    return;
  }

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

  // Classify intent. Conversational intents (general / marketing) route
  // directly to Shaul's CMO/Mentor with memory — no menu friction. The menu
  // only fires for high-stakes intents (invoice, note actions) where a wrong
  // classification would cause real damage.
  let intent = 'general';
  try { intent = await classifyIntent(msgText, ai, modelName); } catch (_) {}

  if (intent === 'general' || intent === 'marketing') {
    await handleMkRouted(msg, msgText, ai, modelName, client);
    return;
  }

  const { options, menuText } = buildConfirmMenu(intent);
  pendingIntentConfirm.set(msg.from, { options, originalMsg: msg, msgText });
  await client.sendMessage(msg.from, menuText);
});

// Start reminders after WhatsApp is ready (also fires on reconnect)
client.on('ready', () => {
  armAllReminders(client);
  setInterval(() => checkReminders(client), 30 * 1000);

  // Marketing: scheduled posts NEVER auto-publish. When a post hits its time,
  // we send the user a re-confirm nudge — final publishing requires explicit
  // "mk publish <id>" from the user. Phase 3 rule.
  setInterval(async () => {
    try {
      const nudges = await processScheduledPosts();
      for (const n of (nudges || [])) {
        try { await client.sendMessage(n.userId, n.text); }
        catch (e) { console.error(`Nudge send failed for ${n.userId}:`, e.message); }
      }
    } catch (err) {
      console.error('Scheduled-posts loop error:', err.message);
    }
  }, 60 * 1000);

  // Phase 3: proactive daily briefing — fire once when local hour first hits 8 each day.
  // Runs every minute but the Director's logBriefing() de-dupes per day.
  const BRIEFING_HOUR = parseInt(process.env.SHAUL_BRIEFING_HOUR || '8', 10);
  setInterval(async () => {
    try {
      const now = new Date();
      if (now.getHours() !== BRIEFING_HOUR) return;
      const briefings = await getDailyBriefingsToSend({ ai, modelName });
      for (const b of briefings) {
        if (!canSendProactive(b.userId)) {
          console.log(`[briefing] proactivity budget exhausted for ${b.userId}, skipping.`);
          continue;
        }
        try {
          await client.sendMessage(b.userId, b.text);
          consumeProactiveBudget(b.userId);
        } catch (e) { console.error(`Briefing send failed for ${b.userId}:`, e.message); }

        // Run forgetting sweep once per user per day (alongside the daily briefing)
        try { runForgettingSweep(b.userId); } catch (_) {}
      }
    } catch (err) {
      console.error('Daily-briefing loop error:', err.message);
    }
  }, 60 * 1000);

  // Start Notion bidirectional poll loop (Notion → SQLite, every 5 min)
  startNotionPollLoop(() => listAllUserIds());

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

function isEmailConfigured() {
  return Boolean(
    process.env.GMAIL_USER &&
    process.env.GMAIL_CLIENT_ID &&
    process.env.GMAIL_CLIENT_SECRET &&
    process.env.GMAIL_REFRESH_TOKEN
  );
}

async function setupEmail() {
  if (!isEmailConfigured()) {
    console.log("Gmail OAuth2 credentials not set. Skipping Email agent setup. Run agent/scripts/gmail-oauth.js to configure.");
    return;
  }

  const { google } = await import('googleapis');
  const oAuth2Client = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
  );
  oAuth2Client.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });

  // Set up SMTP for sending via OAuth2 — no password stored
  emailTransporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      type: 'OAuth2',
      user: process.env.GMAIL_USER,
      clientId: process.env.GMAIL_CLIENT_ID,
      clientSecret: process.env.GMAIL_CLIENT_SECRET,
      refreshToken: process.env.GMAIL_REFRESH_TOKEN,
    },
  });

  // Set up IMAP for listening via OAuth2
  const { token } = await oAuth2Client.getAccessToken();
  const imapClient = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: {
      user: process.env.GMAIL_USER,
      accessToken: token,
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

  // Run inbox setup in background — do NOT await, so WhatsApp starts immediately
  (async () => {
    try {
      await imapClient.mailboxOpen('INBOX');
      await checkUnreadEmails(imapClient);
      imapClient.on('exists', async () => {
        await checkUnreadEmails(imapClient);
      });
    } catch (err) {
      console.error('IMAP inbox setup failed:', err.message);
    }
  })();
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
    const { text: finalResponse, history: updatedHistory } = await runGeminiWithTools({
      chatId: sender,
      history,
      message: `Subject: ${subject}\n\n${text}`,
      systemInstruction: buildSystemPrompt({ channel: 'email', task: 'invoice', tools: TOOLS_BLOCK }),
    });

    emailHistories.set(sender, updatedHistory);
    
    // Reply via Email
    await emailTransporter.sendMail({
      from: process.env.GMAIL_USER,
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
