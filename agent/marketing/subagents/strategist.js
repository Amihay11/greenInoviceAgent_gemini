// Strategist sub-agent.
// Two modes:
//   onboard()        — runs the discovery interview (one question at a time).
//   refineProfile()  — given a freeform user message, distill it into profile updates.
//
// The interview is INCREMENTAL: each call returns the NEXT question + any fields
// already extractable from the answer. State lives in business_profile.onboarding_step.

import { buildPrompt, runSubagent } from './common.js';
import { getProfile, updateProfile, ensureProfile } from '../memory.js';

const QUESTIONS = [
  { step: 1, key: 'business_name', q: 'מה שם העסק שלך ובקצרה — מה הוא עושה?' },
  { step: 2, key: 'industry',      q: 'באיזה תחום אתה? (לדוגמה: SaaS B2B, מסעדה, ייעוץ, מוצר פיזי וכו׳)' },
  { step: 3, key: 'offer',         q: 'מה ההצעה הראשית שאתה מוכר היום? מחיר ממוצע ללקוח?' },
  { step: 4, key: 'icp',           q: 'מי הלקוח האידיאלי? תאר אותו במשפט-שניים — גיל, תפקיד, כאב מרכזי.' },
  { step: 5, key: 'goals_summary', q: 'מה המטרה ל-90 הימים הקרובים? (לידים, מכירות, מודעות, משהו אחר)' },
  { step: 6, key: 'monthly_budget', q: 'כמה תקציב חודשי לשיווק (כולל מדיה ממומנת)? אם אפס — נעבוד אורגני.' },
  { step: 7, key: 'channels',      q: 'איפה אתה היום? פייסבוק, אינסטגרם, לינקדאין, גוגל, איזה משולב?' },
  { step: 8, key: 'brand_voice',   q: 'איך אתה רוצה להישמע? (רציני, חברי, מצחיק, מקצועי-קר וכו׳)' },
  { step: 9, key: 'constraints',   q: 'יש משהו שאסור לעשות? (תחרות מסוימת, נושאים, סגנון שאתה לא אוהב)' },
];

export function nextQuestion(profile) {
  const step = profile?.onboarding_step || 0;
  if (step >= QUESTIONS.length) return null;
  return QUESTIONS[step];
}

export async function startOnboarding(userId) {
  ensureProfile(userId);
  updateProfile(userId, { onboarding_step: 0, onboarding_done: 0 });
  const first = QUESTIONS[0];
  return {
    intro: '⏳ אני שאול. כדי להיות מנטור טוב באמת, אני צריך להכיר אותך. אני אשאל כמה שאלות — ענה קצר וענייני. אתה יכול לכתוב "דלג" כדי לדלג על שאלה.',
    question: first.q,
    step: first.step,
    total: QUESTIONS.length,
  };
}

export async function answerOnboarding({ userId, answer, ai, modelName }) {
  const profile = getProfile(userId);
  const step = profile?.onboarding_step || 0;
  const current = QUESTIONS[step];
  if (!current) return { done: true };

  const trimmed = (answer || '').trim();
  const skip = /^(דלג|skip|-)$/i.test(trimmed);

  if (!skip && trimmed.length > 0) {
    // For numeric / short fields use the raw answer; for narrative ones distill.
    let value = trimmed;
    if (current.key === 'monthly_budget') {
      const num = parseFloat(trimmed.replace(/[^\d.]/g, ''));
      value = isNaN(num) ? null : num;
    } else if (['icp', 'offer', 'goals_summary', 'brand_voice', 'constraints'].includes(current.key)) {
      // Light distill: keep user's words but trim filler.
      value = trimmed.length > 280 ? await distill(trimmed, current.key, ai, modelName) : trimmed;
    }
    updateProfile(userId, { [current.key]: value });
  }

  const nextStep = step + 1;
  updateProfile(userId, { onboarding_step: nextStep });

  if (nextStep >= QUESTIONS.length) {
    updateProfile(userId, { onboarding_done: 1 });
    return {
      done: true,
      message: '✅ קיבלתי את כל מה שצריך. הפרופיל שלך שמור. עכשיו אני יודע למי אני מדבר. שלח "mk plan <מטרה>" כדי שאבנה לך קמפיין, או פשוט תכתוב לי מה על הפרק.',
    };
  }

  const next = QUESTIONS[nextStep];
  return {
    done: false,
    saved: !skip,
    nextQuestion: next.q,
    step: next.step,
    total: QUESTIONS.length,
  };
}

async function distill(text, key, ai, modelName) {
  const prompt = `Compress this answer into one tight Hebrew sentence (≤200 chars) capturing the ${key}. Return only the sentence, no quotes, no preamble.\n\nAnswer:\n${text}`;
  const res = await ai.models.generateContent({
    model: modelName,
    contents: [{ parts: [{ text: prompt }] }],
    config: { temperature: 0.3 },
  });
  return (res.text || text).trim().slice(0, 280);
}

// Mid-conversation profile refinement: given a freeform message, propose updates.
// Phase 3: also extracts goals, entity mentions, and attendance signals.
export async function proposeProfileUpdates({ userId, userMessage, ai, modelName }) {
  const prompt = buildPrompt({
    userId,
    role: 'You are the Strategist. Read the user message and silently extract any business-relevant data the user revealed. Be conservative — only emit something when the user clearly stated it. This runs in the background; it does not generate user-visible text.',
    task: `User just said:\n"${userMessage}"\n\nExtract everything you can about their business, goals, customers, and KPIs.`,
    schemaHint: `{
  "updates": { "field_name": "new value", ... },
  "new_insights": [ { "topic": "string", "insight": "string", "confidence": 0.0-1.0 } ],
  "new_goals":    [ { "title": "...", "metric": "..."|null, "target": number|null, "deadline": "YYYY-MM-DD"|null } ],
  "entities":     [ { "kind": "person|product|competitor|venue|partner|other", "name": "...", "details": "..."|null } ],
  "attendance":   { "session_label": "...", "session_date": "YYYY-MM-DD"|null, "headcount": number, "revenue": number|null, "notes": string|null } | null
}
Profile fields: business_name, industry, offer, icp, brand_voice, goals_summary, monthly_budget, channels, constraints.
Goals: only when user states an explicit objective ("I want X", "המטרה היא Y").
Attendance: only when user reports an actual headcount ("היו 12 ילדים בסדנה היום", "12 kids attended").
Return empty objects/arrays/null when nothing to extract.`,
  });
  const { json } = await runSubagent({ ai, modelName, prompt });
  return json || { updates: {}, new_insights: [], new_goals: [], entities: [], attendance: null };
}

// Phase 3: dynamic discovery — Director asks the next best question instead of
// the hardcoded onboarding form. The Strategist picks the highest-value gap.
export async function nextDiscoveryQuestion({ userId, ai, modelName }) {
  const prompt = buildPrompt({
    userId,
    role: `You are the Strategist running an EXPERT discovery interview. Your job is to figure out what you don't yet know about this user's business and ask ONE targeted question to fill the most valuable gap.

Order of priority (most valuable gap first):
  1. What they sell (offer) — without this, nothing else matters
  2. Who their ICP is — age, role, pain, where they are
  3. Goals (specific number + deadline)
  4. Brand voice / tone preferences
  5. Current channels and what worked / didn't
  6. Budget for paid media
  7. Constraints (taboo topics, competitors, formats they hate)
  8. Attendance / KPI baselines

Skip a topic ONLY if the profile already has it.
Phrase the question naturally — like a senior consultant talking, not a form. ONE question. Hebrew unless profile.brand_voice says English.`,
    task: 'Based on what you know, what is the single most useful question to ask next?',
    schemaHint: `{
  "topic": "offer|icp|goals|brand_voice|channels|budget|constraints|attendance|done",
  "question": "the question, in Hebrew unless brand_voice says otherwise",
  "rationale": "one sentence on why this is the highest-value gap right now"
}
If you have enough to start working (offer + icp + at least one goal), return topic = "done" with question = "" — Shaul has enough to operate.`,
  });
  const { json } = await runSubagent({ ai, modelName, prompt });
  return json || { topic: 'offer', question: 'מה העסק שלך מוכר בעצם? תאר במשפט.', rationale: 'fallback' };
}
