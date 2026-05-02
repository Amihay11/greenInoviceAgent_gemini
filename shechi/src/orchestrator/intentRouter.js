// Classifies an inbound message into one of:
//   COMPANION | TUTOR | TOOL_CALL | INTERVIEW
// An active interview always takes precedence over content-based routing.

import { gemini } from '../adapters/llm/geminiAdapter.js';
import { db } from '../db/client.js';

// Hebrew patterns intentionally omit \b — JS \b is ASCII-only and won't
// fire at Hebrew letter boundaries. The tokens chosen are morpheme-unique.
const TUTOR_TRIGGERS     = [/\b(teach|explain|syllabus|derive|prove|why does|how does)\b/i, /^[\s]*\?/, /(תלמד|תסביר|הסבר|למד|תוכנית לימוד)/];
const COMPANION_TRIGGERS = [/\b(I (feel|think|decided|can't|cannot))\b/i, /\b(brain[- ]?dump|stuck|confused|should I)\b/i, /(אני (מרגיש|חושב|תקוע|לא יודע))/];
const TOOL_TRIGGERS      = [/```mermaid/i, /\b(run python|sandbox|arxiv|fetch (price|stock)|anki)\b/i];
// "learn" alone is ambiguous ("should I learn X" is decision-making, not tutoring),
// so it's only a TUTOR signal when paired with imperative phrasing.
const LEARN_AS_TUTOR     = [/\b(teach|tell|show)\s+me\s+(?:about\s+)?\w+/i, /\blearn(?:ing)?\s+(?:about|how\s+to)\b/i];

export async function routeIntent({ text, profile }) {
  // 0) Active interview ALWAYS wins — user is mid Q&A
  const live = db.prepare(`
    SELECT id FROM interview_sessions
    WHERE user_id = ? AND state IN ('pending_consent','in_progress')
    ORDER BY id DESC LIMIT 1
  `).get(profile.user_id);
  if (live) return { domain: 'INTERVIEW', persona: 'interviewer', session_id: live.id };

  // 1) Cheap deterministic pass.
  // COMPANION is checked BEFORE TUTOR so "Should I learn X?" — a decision
  // question — wins over the bare "learn" keyword.
  if (TOOL_TRIGGERS.some(r => r.test(text)))      return { domain: 'TOOL_CALL', persona: detectTool(text) };
  if (COMPANION_TRIGGERS.some(r => r.test(text))) return { domain: 'COMPANION', persona: detectCompanionPersona(text) };
  if (TUTOR_TRIGGERS.some(r => r.test(text)) || LEARN_AS_TUTOR.some(r => r.test(text)))
    return { domain: 'TUTOR', persona: detectTutorPersona(text) };

  // 2) Honour explicit user override
  if (profile.preferred_personas && profile.preferred_personas !== 'auto') {
    return { domain: profile.preferred_personas.toUpperCase(), persona: 'default' };
  }

  // 3) LLM fallback for ambiguous cases
  const decision = await gemini.classify({
    instruction: 'Classify the user message into one of: COMPANION, TUTOR, TOOL_CALL. Return JSON {"domain":"...","persona":"...","confidence":0..1}.',
    message: text,
  });
  return decision;
}

function detectTutorPersona(t)     { return /syllabus|outline|curriculum|תוכנית/i.test(t) ? 'syllabus' : 'socratic'; }
function detectCompanionPersona(t) { return /should I|decide|trade[- ]?off|בין .* לבין/i.test(t) ? 'sparring' : 'mirror'; }
function detectTool(t) {
  if (/```mermaid/i.test(t)) return 'mermaid';
  if (/python|numpy|scipy/i.test(t)) return 'python';
  if (/arxiv|pdf/i.test(t)) return 'pdf';
  if (/anki/i.test(t)) return 'anki';
  return 'search';
}
