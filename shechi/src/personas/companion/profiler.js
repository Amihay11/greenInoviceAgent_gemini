// Profiler — runs in the background after every interaction. Extracts behavioural
// patterns from recent messages and writes them to the `insights` table.
// Never produces user-facing output.

import { db } from '../../db/client.js';
import { gemini } from '../../adapters/llm/geminiAdapter.js';

const recentMessages = db.prepare(`
  SELECT body, intent, persona, direction, created_at
  FROM messages WHERE user_id = ?
  ORDER BY id DESC LIMIT 20
`);
const insertInsight = db.prepare(`
  INSERT INTO insights (user_id, pattern, evidence, confidence) VALUES (?, ?, ?, ?)
`);

const queue = [];
let busy = false;

export function queueProfilerRun({ user_id }) {
  queue.push({ user_id });
  if (!busy) drain();
}

async function drain() {
  busy = true;
  while (queue.length) {
    const { user_id } = queue.shift();
    try {
      await runOnce(user_id);
    } catch (err) {
      console.warn('profiler failed:', err.message);
    }
  }
  busy = false;
}

async function runOnce(user_id) {
  const msgs = recentMessages.all(user_id);
  if (msgs.length < 6) return;

  const transcript = msgs
    .reverse()
    .map(m => `[${m.direction === 'in' ? 'USER' : 'SHECHI'}|${m.intent ?? '-'}|${m.persona ?? '-'}] ${m.body}`)
    .join('\n');

  const result = await gemini.generate({
    system: 'You are a silent profiler. From the transcript, extract at most 2 behavioural patterns about THIS USER (not Shechi). Return strict JSON: [{"pattern":"...","confidence":0..1}] or []. Patterns must be specific and falsifiable.',
    user: transcript,
    json: true,
  });

  let patterns = [];
  try { patterns = JSON.parse(result); } catch { return; }

  for (const p of patterns) {
    if (!p?.pattern) continue;
    insertInsight.run(user_id, p.pattern, JSON.stringify({ window: 20 }), Number(p.confidence ?? 0.5));
  }
}
