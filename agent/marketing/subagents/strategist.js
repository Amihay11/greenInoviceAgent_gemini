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
export async function proposeProfileUpdates({ userId, userMessage, ai, modelName }) {
  const prompt = buildPrompt({
    userId,
    role: 'You are the Strategist. Read the user message and decide if it implies any updates to the business profile. Be conservative — only propose changes when the user clearly stated something new.',
    task: `User just said:\n"${userMessage}"\n\nWhat profile fields (if any) should be updated?`,
    schemaHint: `{
  "updates": { "field_name": "new value", ... },
  "new_insights": [ { "topic": "string", "insight": "string", "confidence": 0.0-1.0 } ]
}
Field names must be one of: business_name, industry, offer, icp, brand_voice, goals_summary, monthly_budget, channels, constraints.
Return empty objects/arrays if nothing to change.`,
  });
  const { json } = await runSubagent({ ai, modelName, prompt });
  return json || { updates: {}, new_insights: [] };
}
