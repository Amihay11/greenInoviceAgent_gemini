// Decides whether to append a "want to do a 3-q interview?" suggestion to a reply,
// and creates the pending_consent session if so.

import { db } from '../../db/client.js';
import { questionsFor } from './questionBank.js';

const findOpenGap = db.prepare(`
  SELECT * FROM profile_gaps
  WHERE user_id = ? AND status = 'open'
  ORDER BY detected_at DESC LIMIT 1
`);

const recentlyOffered = db.prepare(`
  SELECT 1 FROM profile_gaps
  WHERE user_id = ?
    AND status IN ('offered','interviewing')
  LIMIT 1
`);

const markOffered = db.prepare(`UPDATE profile_gaps SET status = 'offered' WHERE id = ?`);
const insertSession = db.prepare(`
  INSERT INTO interview_sessions (user_id, gap_id, topic, state, questions_json)
  VALUES (?, ?, ?, 'pending_consent', ?)
`);

export function buildOfferIfAny({ profile }) {
  // Don't pile up offers — at most one outstanding per user
  if (recentlyOffered.get(profile.user_id)) return null;

  const gap = findOpenGap.get(profile.user_id);
  if (!gap) return null;

  const questions = questionsFor(gap);
  if (!questions.length) return null;

  markOffered.run(gap.id);
  insertSession.run(profile.user_id, gap.id, describeGap(gap), JSON.stringify(questions));

  return offerText(gap, questions.length, profile.locale);
}

function describeGap(g) {
  switch (g.gap_kind) {
    case 'domain_unknown':     return `Calibrate domain: ${g.gap_subject}`;
    case 'mastery_unknown':    return `Calibrate mastery: ${g.gap_subject}`;
    case 'preference_unknown': return `Capture preference: ${g.gap_subject}`;
    case 'goal_unclear':       return `Clarify goal: ${g.gap_subject}`;
    case 'rule_unknown':       return `Capture rule: ${g.gap_subject}`;
    default:                   return g.gap_subject;
  }
}

function offerText(gap, n, locale) {
  const subject = gap.gap_subject;
  const en = `_By the way — I noticed I don't yet know your **${labelFor(gap.gap_kind)}** for "${subject}". Want to do a quick ${n}-question interview? (yes / no)_`;
  const he = `_דרך אגב — שמתי לב שאני עדיין לא יודע את **${labelFor(gap.gap_kind)}** שלך לגבי "${subject}". רוצה ראיון קצר של ${n} שאלות? (כן / לא)_`;
  return locale === 'he' ? he : en;
}

function labelFor(kind) {
  return {
    domain_unknown:     'background in this domain',
    mastery_unknown:    'mastery level',
    preference_unknown: 'preference',
    goal_unclear:       'goal',
    rule_unknown:       'rule',
  }[kind] ?? 'context';
}
