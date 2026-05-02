// Scans the inbound message + current profile and inserts rows into
// profile_gaps for things Shechi doesn't yet know about the user.
// Detection is best-effort and conservative — false negatives are fine,
// false positives would annoy the user.

import { db } from '../db/client.js';

const upsertGap = db.prepare(`
  INSERT INTO profile_gaps (user_id, gap_kind, gap_subject, evidence, status)
  VALUES (?, ?, ?, ?, 'open')
  ON CONFLICT(user_id, gap_kind, gap_subject) DO NOTHING
`);

const getProgressRow = db.prepare(`SELECT mastery_level FROM progress WHERE user_id = ? AND topic = ? AND subtopic IS NULL`);

const GOAL_PATTERNS = [
  /\bI (?:want|plan|am planning|hope) to\b/i,
  /\bshould I (?:learn|switch|start|stop|quit)\b/i,
  /\bמתכנן ל/i,
  /\bאני רוצה ל/i,
];

const RULE_CORRECTION = /\b(don'?t|stop|please don'?t|אל ת)\b.*\b(do|say|use|reply|תגיב|תגיד)\b/i;

export async function detectGaps({ profile, text, intent }) {
  const opened = [];

  // a) domain_unknown — capitalised noun phrases not in known_domains
  const knownDomainTokens = new Set(
    profile.known_domains.flatMap(d => [d.name, ...(d.tags ?? [])].map(s => s.toLowerCase()))
  );
  const candidates = (text.match(/\b[A-Z][A-Za-z0-9\-+]{2,}(?:\s+[A-Z][A-Za-z0-9\-+]{2,})?\b/g) ?? [])
    .filter(c => !knownDomainTokens.has(c.toLowerCase()))
    .filter(c => !/^(I|It|The|This|That|And|Or|But|So|If|When|Why|How|What|Yes|No)$/.test(c));
  for (const c of candidates.slice(0, 2)) {
    const info = upsertGap.run(profile.user_id, 'domain_unknown', c, text);
    if (info.changes) opened.push({ gap_kind: 'domain_unknown', gap_subject: c });
  }

  // b) mastery_unknown — TUTOR mode, but no progress row for the topic
  if (intent.domain === 'TUTOR') {
    const topic = extractTopic(text);
    if (topic) {
      const row = getProgressRow.get(profile.user_id, topic);
      if (!row) {
        const info = upsertGap.run(profile.user_id, 'mastery_unknown', topic, text);
        if (info.changes) opened.push({ gap_kind: 'mastery_unknown', gap_subject: topic });
      }
    }
  }

  // c) goal_unclear — explicit goal language with no matching memory entry
  if (GOAL_PATTERNS.some(r => r.test(text))) {
    const subject = text.slice(0, 80).replace(/\s+/g, ' ').trim();
    const info = upsertGap.run(profile.user_id, 'goal_unclear', subject, text);
    if (info.changes) opened.push({ gap_kind: 'goal_unclear', gap_subject: subject });
  }

  // d) rule_unknown — user is correcting Shechi's behaviour
  if (RULE_CORRECTION.test(text)) {
    const subject = text.slice(0, 80).replace(/\s+/g, ' ').trim();
    const info = upsertGap.run(profile.user_id, 'rule_unknown', subject, text);
    if (info.changes) opened.push({ gap_kind: 'rule_unknown', gap_subject: subject });
  }

  return opened;
}

function extractTopic(text) {
  const m = text.match(/\b(?:teach|explain|learn|about)\s+(?:me\s+)?(?:about\s+)?([A-Za-z][\w\s\-]{2,40})/i);
  if (!m) return null;
  return m[1].trim().replace(/[?.!,]+$/, '');
}
