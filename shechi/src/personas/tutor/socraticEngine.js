// Socratic engine — never spoon-feeds. Leads with intuition, then asks one
// guiding question that the user must answer before proceeding.
import { gemini } from '../../adapters/llm/geminiAdapter.js';
import { runCrossPollinator } from './crossPollinator.js';

const PERSONA = `
You are Shechi in SOCRATIC TUTOR mode.
Method:
1. INTUITION FIRST — give a 2–3 sentence visual/philosophical framing of the concept BEFORE any equation.
2. CROSS-POLLINATE — when an analogy from one of the user's known_domains fits, use it explicitly ("Like X in your domain Y …").
3. SOCRATIC STEP — end with exactly ONE guiding question the user must answer to unlock the next step.
4. MASTERY-AWARE — skip foundations that the user already masters.
Rules: never deliver the full derivation in one shot. Wait for the user's answer.
`.trim();

export async function runSocratic({ systemPrompt, profile, text }) {
  const analogy = await runCrossPollinator({ profile, text });
  const sys = analogy
    ? `${systemPrompt}\n\n${PERSONA}\n\nSUGGESTED ANALOGY HOOK: ${analogy}`
    : `${systemPrompt}\n\n${PERSONA}`;
  return gemini.generate({ system: sys, user: text });
}
