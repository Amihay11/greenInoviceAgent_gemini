// At interview completion, writes structured updates back to the profile,
// memory, and (for mastery interviews) progress. Resolves the originating gap.

import { db } from '../../db/client.js';
import { gemini } from '../../adapters/llm/geminiAdapter.js';

const getSession = db.prepare(`SELECT * FROM interview_sessions WHERE id = ?`);
const getGap = db.prepare(`SELECT * FROM profile_gaps WHERE id = ?`);
const getProfileRow = db.prepare(`SELECT known_domains_json, custom_rules_json FROM user_profiles WHERE user_id = ?`);

const updateProfile = db.prepare(`
  UPDATE user_profiles
  SET known_domains_json = ?, custom_rules_json = ?, updated_at = strftime('%s','now')
  WHERE user_id = ?
`);
const insertMemory = db.prepare(`INSERT INTO memory (user_id, kind, content, salience) VALUES (?, ?, ?, ?)`);
const upsertProgress = db.prepare(`
  INSERT INTO progress (user_id, topic, subtopic, mastery_level, last_seen)
  VALUES (?, ?, NULL, ?, strftime('%s','now'))
  ON CONFLICT(user_id, topic, subtopic) DO UPDATE SET mastery_level = excluded.mastery_level, last_seen = excluded.last_seen
`);
const setSessionSummary = db.prepare(`UPDATE interview_sessions SET result_summary = ?, ended_at = strftime('%s','now') WHERE id = ?`);
const resolveGap = db.prepare(`UPDATE profile_gaps SET status = 'resolved', resolved_at = strftime('%s','now') WHERE id = ?`);

export async function writeProfileFromInterview(profile, sessionId) {
  const sess = getSession.get(sessionId);
  if (!sess) return;
  const gap = sess.gap_id ? getGap.get(sess.gap_id) : null;
  const qs  = JSON.parse(sess.questions_json);

  const transcript = qs.map((x, i) => `Q${i + 1}: ${x.q}\nA${i + 1}: ${x.a ?? ''}`).join('\n\n');

  const json = await gemini.generate({
    system: `Summarise this interview into structured profile updates. Return strict JSON:
{
  "memory":[{"kind":"fact|preference|goal|event","content":"...","salience":0..1}],
  "domain":{"name":"...","tags":["..."]} | null,
  "rule":{"id":"...","trigger":"...","action":"...","negative":"..."} | null,
  "mastery":{"topic":"...","level":0..1} | null,
  "summary":"one-line recap"
}`,
    user: `Gap kind: ${gap?.gap_kind ?? 'unknown'}\nSubject: ${gap?.gap_subject ?? ''}\n\n${transcript}`,
    json: true,
  });

  let parsed;
  try { parsed = JSON.parse(json); } catch { parsed = { memory: [], summary: 'interview completed' }; }

  // memory rows
  for (const m of parsed.memory ?? []) {
    if (!m?.content) continue;
    insertMemory.run(profile.user_id, m.kind ?? 'fact', m.content, Number(m.salience ?? 0.6));
  }

  // profile updates (atomic)
  if (parsed.domain || parsed.rule) {
    const row = getProfileRow.get(profile.user_id) ?? { known_domains_json: '[]', custom_rules_json: '[]' };
    const domains = JSON.parse(row.known_domains_json);
    const rules   = JSON.parse(row.custom_rules_json);
    if (parsed.domain?.name && !domains.find(d => d.name.toLowerCase() === parsed.domain.name.toLowerCase())) {
      domains.push(parsed.domain);
    }
    if (parsed.rule?.id && !rules.find(r => r.id === parsed.rule.id)) {
      rules.push(parsed.rule);
    }
    updateProfile.run(JSON.stringify(domains), JSON.stringify(rules), profile.user_id);
  }

  // mastery
  if (parsed.mastery?.topic && typeof parsed.mastery.level === 'number') {
    upsertProgress.run(profile.user_id, parsed.mastery.topic, Number(parsed.mastery.level));
  }

  setSessionSummary.run(parsed.summary ?? 'interview completed', sessionId);
  if (gap?.id) resolveGap.run(gap.id);
}
