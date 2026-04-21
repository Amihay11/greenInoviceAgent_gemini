import { Client as NotionClient } from '@notionhq/client';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REMINDERS_FILE = join(__dirname, 'reminders.json');

// Notion client — only initialised if credentials are present
const notion = process.env.NOTION_API_KEY
  ? new NotionClient({ auth: process.env.NOTION_API_KEY })
  : null;

// ── router ────────────────────────────────────────────────────────────────────

export async function handleNoteCommand(msg, ai, modelName, waClient) {
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

  const body = msg.body.trim().replace(/^note\s*/i, '').trim();
  const lower = body.toLowerCase();

  if (lower.startsWith('search '))  return searchNotes(body.slice(7).trim(), msg, ai, modelName, waClient);
  if (lower === 'summary')          return getDailySummary(msg, ai, modelName, waClient);
  if (lower === 'weekly')           return getWeeklySummary(msg, ai, modelName, waClient);
  if (lower.startsWith('chat '))    return chatWithNotes(body.slice(5).trim(), msg, ai, modelName, waClient);
  if (lower.startsWith('remind '))  return scheduleReminder(body.slice(7).trim(), msg, ai, modelName, waClient);
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

async function fetchAllNotes() {
  const pages = [];
  let cursor;
  do {
    const res = await notion.databases.query({
      database_id: process.env.NOTION_NOTES_DB_ID,
      start_cursor: cursor,
      page_size: 100
    });
    pages.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return pages;
}

function pageToText(page) {
  const title = page.properties.Title?.title?.[0]?.plain_text || '(no title)';
  const content = page.properties.Content?.rich_text?.[0]?.plain_text || '';
  const tags = (page.properties.Tags?.multi_select || []).map(t => t.name).join(', ');
  const date = page.properties.Created?.date?.start || '';
  return `[${date}] ${title}${tags ? ' (' + tags + ')' : ''}: ${content}`;
}

// ── save note ─────────────────────────────────────────────────────────────────

async function saveNote(body, msg, ai, modelName, waClient) {
  await waClient.sendMessage(msg.from, '💾 שומר רעיון...');

  const { tags: userTags, clean } = extractHashtags(body);

  // Ask Gemini for a short title + auto-tags
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

  await notion.pages.create({
    parent: { database_id: process.env.NOTION_NOTES_DB_ID },
    properties: {
      Title:   { title:        [{ text: { content: title } }] },
      Content: { rich_text:   [{ text: { content: clean } }] },
      Tags:    { multi_select: allTags.map(t => ({ name: t })) },
      Created: { date:         { start: new Date().toISOString() } },
      Type:    { select:       { name: 'idea' } }
    }
  });

  const tagStr = allTags.length ? ` | תגיות: ${allTags.join(', ')}` : '';
  await waClient.sendMessage(msg.from, `✅ נשמר: *${title}*${tagStr}`);
}

// ── search notes ──────────────────────────────────────────────────────────────

async function searchNotes(query, msg, ai, modelName, waClient) {
  await waClient.sendMessage(msg.from, '🔍 מחפש ברעיונות שלך...');

  const pages = await fetchAllNotes();
  if (pages.length === 0) {
    await waClient.sendMessage(msg.from, 'עדיין אין רעיונות שמורים.');
    return;
  }

  const notesText = pages.map(pageToText).join('\n');
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
  const pages = await fetchAllNotes();
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

  const notesText = filtered.map(pageToText).join('\n');
  const label = range === 'today' ? 'היום' : 'השבוע האחרון';
  const summary = await geminiText(ai, modelName,
    `סכם את הרעיונות הבאים שנשמרו ${label}. כתוב בעברית, בצורה ברורה ומאורגנת עם נקודות:\n\n${notesText}`
  );
  await waClient.sendMessage(msg.from, summary);
}

// ── chat with notes ───────────────────────────────────────────────────────────

async function chatWithNotes(question, msg, ai, modelName, waClient) {
  await waClient.sendMessage(msg.from, '💬 חושב על הרעיונות שלך...');

  const pages = await fetchAllNotes();
  const notesText = pages.length
    ? pages.map(pageToText).join('\n')
    : '(אין רעיונות שמורים עדיין)';

  const answer = await geminiText(ai, modelName,
    `You are a personal knowledge assistant. Here are all the user's saved notes:\n\n${notesText}\n\nUser question: "${question}"\n\nAnswer thoughtfully in the same language as the question. Connect ideas, find patterns, and be insightful.`
  );
  await waClient.sendMessage(msg.from, answer);
}

// ── reminders ────────────────────────────────────────────────────────────────

async function scheduleReminder(text, msg, ai, modelName, waClient) {
  // Ask Gemini to parse the natural-language time expression
  const parsed = await geminiText(ai, modelName,
    `Today is ${new Date().toISOString()}. The user wants to set a reminder: "${text}".\nReturn ONLY valid JSON: {"iso": "<ISO 8601 datetime>", "text": "<reminder text in original language>"}. No markdown.`
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
