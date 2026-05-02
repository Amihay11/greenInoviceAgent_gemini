// Multi-turn interview state machine. Reads/writes interview_sessions row.

import { db } from '../../db/client.js';
import { writeProfileFromInterview } from './profileWriter.js';

const getSession = db.prepare(`SELECT * FROM interview_sessions WHERE id = ?`);
const setStateInProgress = db.prepare(`UPDATE interview_sessions SET state = 'in_progress', current_index = 0 WHERE id = ?`);
const setAbandoned = db.prepare(`UPDATE interview_sessions SET state = 'abandoned', ended_at = strftime('%s','now') WHERE id = ?`);
const setCompleted = db.prepare(`UPDATE interview_sessions SET state = 'completed', current_index = ?, questions_json = ?, ended_at = strftime('%s','now') WHERE id = ?`);
const advance = db.prepare(`UPDATE interview_sessions SET current_index = ?, questions_json = ? WHERE id = ?`);
const dismissGap = db.prepare(`UPDATE profile_gaps SET status = 'dismissed', resolved_at = strftime('%s','now') WHERE id = ?`);

const YES_RE = /^\s*(yes|y|ok|okay|sure|let'?s do it|go|בוא נתחיל|כן|בסדר|יאללה)\b/i;
const NO_RE  = /^\s*(no|n|skip|later|לא|דלג|לא עכשיו)\b/i;

export async function runInterview({ profile, sessionId, text }) {
  const sess = getSession.get(sessionId);
  if (!sess) return 'Interview session not found.';

  const qs = JSON.parse(sess.questions_json);

  if (sess.state === 'pending_consent') {
    if (NO_RE.test(text)) {
      setAbandoned.run(sess.id);
      if (sess.gap_id) dismissGap.run(sess.gap_id);
      return profile.locale === 'he'
        ? 'בסדר — לא נחזור לזה אלא אם תבקש.'
        : "No worries — I won't bring it up again unless you ask.";
    }
    if (YES_RE.test(text)) {
      setStateInProgress.run(sess.id);
      return formatQuestion(qs, 0, profile.locale);
    }
    return profile.locale === 'he'
      ? 'רק כן או לא — להריץ את הראיון עכשיו?'
      : "Just a yes or no — should we run the interview now?";
  }

  // in_progress: store the answer, advance
  qs[sess.current_index].a = text;
  qs[sess.current_index].answered_at = Math.floor(Date.now() / 1000);
  const next = sess.current_index + 1;

  if (next >= qs.length) {
    setCompleted.run(next, JSON.stringify(qs), sess.id);
    await writeProfileFromInterview(profile, sess.id);
    return profile.locale === 'he'
      ? 'תודה — עדכנתי את הפרופיל שלך.'
      : "Got it — I've updated your profile. Thanks!";
  }

  advance.run(next, JSON.stringify(qs), sess.id);
  return formatQuestion(qs, next, profile.locale);
}

function formatQuestion(qs, idx, locale) {
  const total = qs.length;
  const head  = locale === 'he' ? `שאלה ${idx + 1}/${total}:` : `Question ${idx + 1}/${total}:`;
  return `${head} ${qs[idx].q}`;
}

export async function maybeOfferInterview({ profile }) {
  const { buildOfferIfAny } = await import('./consentPrompter.js');
  return buildOfferIfAny({ profile });
}
