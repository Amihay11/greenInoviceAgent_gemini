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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '.env') });

// Ensure Gemini API Key is set
if (!process.env.GEMINI_API_KEY) {
  console.error("Error: GEMINI_API_KEY environment variable is not set. Please set it in a .env file.");
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const modelName = 'gemini-2.5-flash';

// --- MCP Setup ---
let mcpClient;
let mcpTools = [];

async function setupMCP() {
  console.log("Starting GreenInvoice MCP Server...");
  const transport = new StdioClientTransport({
    command: "c:\\Users\\User\\Documents\\morningMCP\\node\\node-v20.12.2-win-x64\\node.exe",
    args: ["c:\\Users\\User\\Documents\\morningMCP\\GreenInvoice-MCP-main\\dist\\index.js"],
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
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: join(__dirname, 'whatsapp-auth') }),
  puppeteer: {
    executablePath: "c:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", // Fallback if needed, usually omitted to use bundled
    args: ['--no-sandbox']
  }
});

client.on('qr', (qr) => {
  console.log('Scan the QR code below to authenticate with WhatsApp:');
  qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
  console.log('WhatsApp Client is ready!');
});

// Chat history per contact
const chatHistories = new Map();

client.on('message', async msg => {
  if (msg.from === 'status@broadcast') return;

  const msgText = msg.body.trim().toLowerCase();
  if (!msgText.startsWith('morning command') && !msgText.startsWith('mc')) {
    return; // Ignore messages not meant for this agent
  }

  const contact = await msg.getContact();
  const contactName = contact.pushname || contact.number || "User";
  console.log(`Received Morning Command message from ${contactName}: ${msg.body}`);

  const history = chatHistories.get(msg.from) || [
    { role: "user", parts: [{ text: `Hello, I am ${contactName}.` }] },
    { role: "model", parts: [{ text: "Hello! I am your Morning (GreenInvoice) assistant. How can I help you today?" }] }
  ];

  try {
    console.log(`Sending WhatsApp message to Gemini...`);
    
    // Truly instant acknowledgement before the LLM even starts thinking
    await client.sendMessage(msg.from, "⏳ מעבד את הבקשה... (Processing...)");

    const chat = ai.chats.create({
      model: modelName,
      history: history,
      config: {
        tools: [{ functionDeclarations: mcpTools }],
        systemInstruction: "You are an AI assistant integrated with WhatsApp and the Morning (GreenInvoice) Israeli invoicing system. IMPORTANT RULES:\n1. Always reply in the SAME LANGUAGE as the user. If they write in Hebrew, reply in Hebrew.\n2. When creating documents, use these standard GreenInvoice document types (type):\n   - 300: חשבון עסקה / דרישת תשלום (Transaction Account / Payment Request / Proforma)\n   - 320: קבלה (Receipt - use this if they are Osek Patur and ask for an invoice)\n   - 330: חשבונית מס קבלה (Tax Invoice Receipt)\n   - 305: חשבונית מס (Tax Invoice)\n3. Be concise and professional.\n4. When you need to call a tool, ALWAYS provide a short text acknowledgement (e.g. 'Working on it...') ALONG WITH the tool call, so the user gets an instant reply while you process."
      }
    });

    let result = await chat.sendMessage({ message: msg.body });

    // Handle tool calls
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
    
    // Save updated history
    const updatedHistory = await chat.getHistory();
    chatHistories.set(msg.from, updatedHistory);
    
    // Reply on WhatsApp
    await client.sendMessage(msg.from, finalResponse);

  } catch (error) {
    console.error("Error processing message:", error);
    await client.sendMessage(msg.from, "Sorry, I encountered an error while processing your request.");
  }
});

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
  const history = emailHistories.get(sender) || [
    { role: "user", parts: [{ text: `Hello, I am contacting you via email. My address is ${sender}.` }] },
    { role: "model", parts: [{ text: "Hello! I am your Morning (GreenInvoice) assistant. How can I help you today?" }] }
  ];

  try {
    console.log(`Sending Email message to Gemini...`);
    const chat = ai.chats.create({
      model: modelName,
      history: history,
      config: {
        tools: [{ functionDeclarations: mcpTools }],
        systemInstruction: "You are an AI assistant integrated with Email and the Morning (GreenInvoice) Israeli invoicing system. IMPORTANT RULES:\n1. Always reply in the SAME LANGUAGE as the user. If they write in Hebrew, reply in Hebrew.\n2. When creating documents, use these standard GreenInvoice document types (type):\n   - 300: חשבון עסקה / דרישת תשלום (Transaction Account / Payment Request / Proforma)\n   - 320: קבלה (Receipt - use this if they are Osek Patur and ask for an invoice)\n   - 330: חשבונית מס קבלה (Tax Invoice Receipt)\n   - 305: חשבונית מס (Tax Invoice)\n3. Be concise and professional."
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
