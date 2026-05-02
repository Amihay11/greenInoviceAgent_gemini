// Generates a structured Markdown syllabus table for a topic and persists it.
import { db } from '../../db/client.js';
import { gemini } from '../../adapters/llm/geminiAdapter.js';

const PERSONA = `
You are Shechi in SYLLABUS GENERATOR mode.
Output a single Markdown table with columns:
| # | Module | Goal | Prerequisite | Mastery checkpoint |
6–10 rows, ordered prerequisite-first. Skip basics the user already masters
(use the user's known_domains and any provided mastery hints).
After the table, add a 2-line "How we'll proceed" note in plain prose.
`.trim();

const insertSyllabus = db.prepare(`
  INSERT INTO syllabus (user_id, topic, outline_md) VALUES (?, ?, ?)
`);

export async function runSyllabus({ systemPrompt, profile, text }) {
  const md = await gemini.generate({
    system: `${systemPrompt}\n\n${PERSONA}`,
    user: text,
  });
  const topic = (text.match(/(?:teach|learn|syllabus|outline)\s+(?:me\s+)?(?:about\s+)?([\w\s\-]{2,60})/i)?.[1] ?? 'general').trim();
  insertSyllabus.run(profile.user_id, topic, md);
  return md;
}
