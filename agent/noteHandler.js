import { Client as NotionClient } from '@notionhq/client';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REMINDERS_FILE = join(__dirname, 'reminders.json');

// Session state for two-menu voice note pipeline
const pendingVoiceMessages = new Map(); // chatId → original voice msg (waiting for Menu 1)
const pendingVoiceResults  = new Map(); // chatId → { transcription, analysis, brainstorm } (waiting for Menu 2)

// Lazy — dotenv runs after ES module imports, so we read the env var at call time
let _notion = undefined;
function getNotion() {
  if (_notion === undefined) {
    _notion = process.env.NOTION_API_KEY
      ? new NotionClient({ auth: process.env.NOTION_API_KEY })
      : null;
  }
  return _notion;
}

// ── router ────────────────────────────────────────────────────────────────────

export async function handleNoteCommand(msg, ai, modelName, waClient) {
  const body = msg.body.trim().replace(/^note\s*/i, '').trim();
  const lower = body.toLowerCase();

  // remind doesn't need Notion — handle it first
  if (lower.startsWith('remind ')) return scheduleReminder(body.slice(7).trim(), msg, ai, modelName, waClient);

  // all other sub-commands need Notion
  const notion = getNotion();
  if (!notion) {
    await waClient.sendMessage(msg.from,
      '⚠️ NOTION_API_KEY not set in .env — note commands are disabled.');
    return;
  }
  if (!process.env.NOTION_NOTES_DB_ID) {
    await waClient.sendMessage(msg.from,
      '⚠️ NOTION_NOTES_DB_ID not set in .env — note commands are disabled.');
    return;
  }

  if (lower.startsWith('search '))  return searchNotes(body.slice(7).trim(), msg, ai, modelName, waClient);
  if (lower === 'summary')          return getDailySummary(msg, ai, modelName, waClient);
  if (lower === 'weekly')           return getWeeklySummary(msg, ai, modelName, waClient);
  if (lower.startsWith('chat '))    return chatWithNotes(body.slice(5).trim(), msg, ai, modelName, waClient);
  return saveNote(body, msg, ai, modelName, waClient);
}

// ── helpers ───────────────────────────────────────────────────────────────────

function extractHashtags(text) {
  const tags = (text.match(/#[֐-׿a-zA-Z0-9_]+/g) || [])
    .map(t => t.slice(1));
  const clean = text.replace(/#[֐-׿a-zA-Z0-9_]+/g, '').trim();
  return { tags, clean };
}

async function geminiText(ai, modelName, prompt) {
  const res = await ai.models.generateContent({
    model: modelName,
    contents: [{ parts: [{ text: prompt }] }]
  });
  return res.text.trim();
}

// Detect the title property name (Notion uses 'Name' or 'Title' depending on how db was created)
let _titleProp = null;
async function getTitleProp() {
  if (_titleProp) return _titleProp;
  const db = await getNotion().databases.retrieve({ database_id: process.env.NOTION_NOTES_DB_ID });
  const titleEntry = Object.entries(db.properties).find(([, v]) => v.type === 'title');
  _titleProp = titleEntry ? titleEntry[0] : 'Name';
  return _titleProp;
}

// Add any missing columns to the database automatically
async function ensureSchema() {
  const db = await getNotion().databases.retrieve({ database_id: process.env.NOTION_NOTES_DB_ID });
  const existing = Object.keys(db.properties);
  const toAdd = {};
  if (!existing.includes('Content')) toAdd.Content = { rich_text: {} };
  if (!existing.includes('Tags'))    toAdd.Tags    = { multi_select: { options: [] } };
  if (!existing.includes('Type'))    toAdd.Type    = { select: { options: [] } };
  if (!existing.includes('Created')) toAdd.Created = { date: {} };
  if (Object.keys(toAdd).length > 0) {
    await getNotion().databases.update({
      database_id: process.env.NOTION_NOTES_DB_ID,
      properties: toAdd
    });
  }
}

let _schemaReady = false;
async function ensureSchemaOnce() {
  if (_schemaReady) return;
  await ensureSchema();
  _schemaReady = true;
}

async function fetchAllNotes() {
  const pages = [];
  let cursor;
  do {
    const res = await getNotion().databases.query({
      database_id: process.env.NOTION_NOTES_DB_ID,
      start_cursor: cursor,
      page_size: 100
    });
    pages.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return pages;
}

async function safeGetNotes(waClient, msg) {
  try {
    return await fetchAllNotes();
  } catch (err) {
    console.error('Notion fetch error:', err.message);
    await waClient.sendMessage(msg.from, `❌ שגיאת Notion: ${err.message}`);
    return null;
  }
}

function pageToText(page, titleProp = 'Name') {
  const title = page.properties[titleProp]?.title?.[0]?.plain_text || '(no title)';
  const content = page.properties.Content?.rich_text?.[0]?.plain_text || '';
  const tags = (page.properties.Tags?.multi_select || []).map(t => t.name).join(', ');
  const date = page.properties.Created?.date?.start || '';
  return `[${date}] ${title}${tags ? ' (' + tags + ')' : ''}: ${content}`;
}

// ── save note ─────────────────────────────────────────────────────────────────

async function saveNote(body, msg, ai, modelName, waClient) {
  await waClient.sendMessage(msg.from, '💾 שומר רעיון...');

  const { tags: userTags, clean } = extractHashtags(body);

  const metaRaw = await geminiText(ai, modelName,
    `You are a personal knowledge assistant. Given this note, return ONLY valid JSON with keys "title" (short Hebrew/English title, max 8 words) and "tags" (array of 2-3 relevant Hebrew or English tag strings, no # symbol).\n\nNote: "${clean}"`
  );

  let title = clean.slice(0, 60);
  let autoTags = [];
  try {
    const jsonMatch = metaRaw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const meta = JSON.parse(jsonMatch[0]);
      title = meta.title || title;
      autoTags = Array.isArray(meta.tags) ? meta.tags : [];
    }
  } catch (_) {}

  const allTags = [...new Set([...userTags, ...autoTags])];

  try {
    await ensureSchemaOnce();
    const titleProp = await getTitleProp();
    await getNotion().pages.create({
      parent: { database_id: process.env.NOTION_NOTES_DB_ID },
      properties: {
        [titleProp]: { title:      [{ text: { content: title } }] },
        Content:     { rich_text:  [{ text: { content: clean } }] },
        Tags:        { multi_select: allTags.map(t => ({ name: t })) },
        Created:     { date:       { start: new Date().toISOString() } },
        Type:        { select:     { name: 'idea' } }
      }
    });
  } catch (err) {
    console.error('Notion save error:', err.message);
    await waClient.sendMessage(msg.from, `❌ שגיאה בשמירה ל-Notion: ${err.message}`);
    return;
  }

  const tagStr = allTags.length ? ` | תגיות: ${allTags.join(', ')}` : '';
  await waClient.sendMessage(msg.from, `✅ נשמר: *${title}*${tagStr}`);
}

// ── search notes ──────────────────────────────────────────────────────────────

async function searchNotes(query, msg, ai, modelName, waClient) {
  await waClient.sendMessage(msg.from, '🔍 מחפש ברעיונות שלך...');

  const pages = await safeGetNotes(waClient, msg);
  if (!pages || pages.length === 0) {
    await waClient.sendMessage(msg.from, 'עדיין אין רעיונות שמורים.');
    return;
  }

  const tp = await getTitleProp();
  const notesText = pages.map(p => pageToText(p, tp)).join('\n');
  const answer = await geminiText(ai, modelName,
    `You are a personal knowledge assistant. The user's saved notes:\n\n${notesText}\n\nUser query: "${query}"\n\nAnswer in the same language as the query. Be concise and cite note titles when relevant.`
  );
  await waClient.sendMessage(msg.from, answer);
}

// ── summaries ─────────────────────────────────────────────────────────────────

async function getDailySummary(msg, ai, modelName, waClient) {
  await waClient.sendMessage(msg.from, '📋 מכין סיכום יומי...');
  await summariseByRange(msg, ai, modelName, waClient, 'today');
}

async function getWeeklySummary(msg, ai, modelName, waClient) {
  await waClient.sendMessage(msg.from, '📋 מכין סיכום שבועי...');
  await summariseByRange(msg, ai, modelName, waClient, 'week');
}

async function summariseByRange(msg, ai, modelName, waClient, range) {
  const pages = await safeGetNotes(waClient, msg);
  if (!pages) return;
  const now = new Date();
  const cutoff = new Date(now);
  if (range === 'today') {
    cutoff.setHours(0, 0, 0, 0);
  } else {
    cutoff.setDate(now.getDate() - 7);
  }

  const filtered = pages.filter(p => {
    const d = p.properties.Created?.date?.start;
    return d && new Date(d) >= cutoff;
  });

  if (filtered.length === 0) {
    const label = range === 'today' ? 'היום' : 'השבוע';
    await waClient.sendMessage(msg.from, `אין רעיונות שמורים ${label}.`);
    return;
  }

  const tp = await getTitleProp();
  const notesText = filtered.map(p => pageToText(p, tp)).join('\n');
  const label = range === 'today' ? 'היום' : 'השבוע האחרון';
  const summary = await geminiText(ai, modelName,
    `סכם את הרעיונות הבאים שנשמרו ${label}. כתוב בעברית, בצורה ברורה ומאורגנת עם נקודות:\n\n${notesText}`
  );
  await waClient.sendMessage(msg.from, summary);
}

// ── chat with notes ───────────────────────────────────────────────────────────

async function chatWithNotes(question, msg, ai, modelName, waClient) {
  await waClient.sendMessage(msg.from, '💬 חושב על הרעיונות שלך...');

  const pages = await safeGetNotes(waClient, msg);
  if (!pages) return;
  const tp = await getTitleProp();
  const notesText = pages.length
    ? pages.map(p => pageToText(p, tp)).join('\n')
    : '(אין רעיונות שמורים עדיין)';

  const answer = await geminiText(ai, modelName,
    `You are a personal knowledge assistant. Here are all the user's saved notes:\n\n${notesText}\n\nUser question: "${question}"\n\nAnswer thoughtfully in the same language as the question. Connect ideas, find patterns, and be insightful.`
  );
  await waClient.sendMessage(msg.from, answer);
}

// ── voice note pipeline ───────────────────────────────────────────────────────

const MENU1_TEXT = `🎙️ קיבלתי הודעה קולית — מה לעשות?

1️⃣ המרה לטקסט בלבד
2️⃣ ניתוח ועיקרי רעיונות
3️⃣ כיווני חשיבה נוספים
4️⃣ הכל (טקסט + ניתוח + חשיבה)

שלח מספר 1-4`;

const MENU2_TEXT = `💾 שמור ל-Notion?

1️⃣ שמור ניתוח מלא
2️⃣ שמור תמלול בלבד
3️⃣ לא לשמור

שלח מספר 1-3`;

async function transcribeAndClean(media, ai, modelName) {
  const raw = await ai.models.generateContent({
    model: modelName,
    contents: [{
      parts: [
        { inlineData: { mimeType: media.mimetype, data: media.data } },
        { text: 'Transcribe this voice message accurately. Reply with just the transcription, in the original language spoken.' }
      ]
    }]
  });
  const rawText = raw.text.trim();

  const cleaned = await ai.models.generateContent({
    model: modelName,
    contents: [{
      parts: [{ text: `You are a transcription cleanup assistant. The text was captured by speech-to-text and may contain filler words (um, uh, er, like, you know), missing punctuation, false starts, and repetitions.\n\nClean it:\n1. Remove filler words unless they carry meaning\n2. Fix punctuation and add paragraph breaks where natural\n3. Fix grammar while preserving the speaker's exact meaning and tone\n4. Remove repetitions and false starts\n\nOutput ONLY the cleaned transcription — no commentary, no labels.\n\nText:\n${rawText}` }]
    }]
  });
  return cleaned.text.trim();
}

async function analyzeIdeas(text, ai, modelName) {
  return geminiText(ai, modelName,
    `You are a practical note organizer. Read these spoken notes and extract what matters. Respond in the SAME language as the input.

Format exactly like this (keep Hebrew labels):

*משימות ופעולות:*
• [concrete task or action — if none write "לא צוינו"]

*רעיונות לשמור:*
• [idea worth keeping — omit this section entirely if there are no conceptual ideas]

*דחיפות:*
[What seems most urgent or time-sensitive in one line, or "לא צוין"]

Rules: extract only what is explicitly stated. Be short and concrete. Do NOT add themes, interpretations, or categories.

Notes:
${text}`
  );
}

async function brainstormIdeas(text, ai, modelName) {
  return geminiText(ai, modelName,
    `You are a helpful thinking partner. Read these notes and offer practical perspectives. Respond in the SAME language as the input.

Format exactly like this (keep Hebrew labels):

*זוויות נוספות:*
• [practical angle, missing step, or useful connection — grounded in the actual content]
• [another practical angle]
• [third angle only if clearly useful]

*שאלה לבירור:*
[One short, practical question that helps clarify or move the tasks forward]

Rules:
- Stay grounded in what was actually said. Do NOT philosophize mundane tasks.
- For task lists: note what might be missing, conflicts, or better ordering.
- For ideas: suggest related implications or next steps.
- Be concise and concrete.

Notes:
${text}`
  );
}

export async function handleVoiceNote(msg, ai, modelName, waClient) {
  pendingVoiceMessages.set(msg.from, msg);
  await waClient.sendMessage(msg.from, MENU1_TEXT);
}

// Returns true if message was handled as a pending voice reply
export async function handleVoiceReply(msg, ai, modelName, waClient) {
  const choice = msg.body.trim();

  // ── Menu 2 response ────────────────────────────────────────────────────────
  if (pendingVoiceResults.has(msg.from)) {
    const { transcription, analysis, brainstorm } = pendingVoiceResults.get(msg.from);
    pendingVoiceResults.delete(msg.from);

    if (choice === '2') {
      await saveNote(transcription, msg, ai, modelName, waClient);
    } else if (choice === '3') {
      await waClient.sendMessage(msg.from, '👍 בסדר, לא נשמר.');
    } else {
      const fullContent = [
        transcription,
        analysis   ? `\n\n--- ניתוח ---\n${analysis}`         : '',
        brainstorm ? `\n\n--- כיווני חשיבה ---\n${brainstorm}` : '',
      ].join('');
      await saveNote(fullContent, msg, ai, modelName, waClient);
    }
    return true;
  }

  // ── Menu 1 response ────────────────────────────────────────────────────────
  if (!pendingVoiceMessages.has(msg.from)) return false;
  if (!['1','2','3','4'].includes(choice)) return false;

  const voiceMsg = pendingVoiceMessages.get(msg.from);
  pendingVoiceMessages.delete(msg.from);

  await waClient.sendMessage(msg.from, '⏳ מעבד את ההודעה הקולית...');

  let media;
  try {
    media = await voiceMsg.downloadMedia();
    if (!media) throw new Error('Could not download audio');
  } catch (err) {
    await waClient.sendMessage(msg.from, `❌ שגיאה בהורדת ההודעה הקולית: ${err.message}`);
    return true;
  }

  let transcription, analysis, brainstorm;
  try {
    transcription = await transcribeAndClean(media, ai, modelName);
  } catch (err) {
    await waClient.sendMessage(msg.from, `❌ שגיאה בתמלול: ${err.message}`);
    return true;
  }

  if (choice === '1') {
    await waClient.sendMessage(msg.from, `📝 *תמלול:*\n${transcription}`);
    await waClient.sendMessage(msg.from, `לשמירה ב-Notion שלח:\n_note [הטקסט]_`);
    return true;
  }

  try {
    if (choice === '4') {
      [analysis, brainstorm] = await Promise.all([
        analyzeIdeas(transcription, ai, modelName),
        brainstormIdeas(transcription, ai, modelName),
      ]);
    } else if (choice === '2') {
      analysis = await analyzeIdeas(transcription, ai, modelName);
    } else if (choice === '3') {
      brainstorm = await brainstormIdeas(transcription, ai, modelName);
    }
  } catch (err) {
    await waClient.sendMessage(msg.from, `❌ שגיאה בניתוח: ${err.message}`);
    return true;
  }

  const parts = [`📝 *תמלול:*\n${transcription}`];
  if (analysis)   parts.push(`\n🧠 *ניתוח:*\n${analysis}`);
  if (brainstorm) parts.push(`\n💡 *כיווני חשיבה:*\n${brainstorm}`);
  await waClient.sendMessage(msg.from, parts.join('\n'));

  pendingVoiceResults.set(msg.from, { transcription, analysis, brainstorm });
  await waClient.sendMessage(msg.from, MENU2_TEXT);
  return true;
}

// ── reminders ────────────────────────────────────────────────────────────────

async function scheduleReminder(text, msg, ai, modelName, waClient) {
  // Ask Gemini to parse the natural-language time expression
  const nowIsrael = new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
  const parsed = await geminiText(ai, modelName,
    `Current date and time in Israel (Asia/Jerusalem, UTC+3): ${nowIsrael}. The user wants to set a reminder: "${text}".\nTreat any times the user mentions as Israel local time (UTC+3). Return ONLY valid JSON: {"iso": "<ISO 8601 datetime with +03:00 offset>", "text": "<reminder text in original language>"}. No markdown.`
  );

  let iso, reminderText;
  try {
    const jsonMatch = parsed.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('no JSON');
    const obj = JSON.parse(jsonMatch[0]);
    iso = obj.iso;
    reminderText = obj.text;
  } catch (_) {
    await waClient.sendMessage(msg.from, '⚠️ לא הצלחתי להבין את הזמן. נסה שוב (לדוגמה: "מחר ב-9 לקרוא מייל").');
    return;
  }

  const time = new Date(iso).getTime();
  if (isNaN(time) || time < Date.now()) {
    await waClient.sendMessage(msg.from, '⚠️ הזמן שהוזן כבר עבר. נסה שוב.');
    return;
  }

  const reminders = existsSync(REMINDERS_FILE)
    ? JSON.parse(readFileSync(REMINDERS_FILE))
    : [];
  reminders.push({ time, text: reminderText, to: msg.from });
  writeFileSync(REMINDERS_FILE, JSON.stringify(reminders, null, 2));

  const dateStr = new Date(iso).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
  await waClient.sendMessage(msg.from, `⏰ תזכורת נקבעה ל: *${dateStr}*\n${reminderText}`);
}

// ── reminder checker (called by setInterval in index.js) ─────────────────────

export function checkReminders(waClient) {
  if (!existsSync(REMINDERS_FILE)) return;
  try {
    const all = JSON.parse(readFileSync(REMINDERS_FILE));
    const now = Date.now();
    const due = all.filter(r => r.time <= now);
    const remaining = all.filter(r => r.time > now);
    for (const r of due) {
      waClient.sendMessage(r.to, `⏰ תזכורת: ${r.text}`).catch(console.error);
    }
    if (due.length > 0) {
      writeFileSync(REMINDERS_FILE, JSON.stringify(remaining, null, 2));
    }
  } catch (err) {
    console.error('Reminder check error:', err.message);
  }
}
