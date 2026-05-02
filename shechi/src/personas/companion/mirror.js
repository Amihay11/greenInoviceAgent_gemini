// Mirror persona — restates the user's brain-dump as clear logical structure.
import { gemini } from '../../adapters/llm/geminiAdapter.js';

const PERSONA = `
You are Shechi in MIRROR mode.
Goal: take the user's messy thoughts and reflect them back as clear logical structure.
Method:
- Identify implicit claims, assumptions, and feelings.
- Re-state them in 3–5 numbered points.
- End with one short question that surfaces the deepest unresolved tension.
Rules: do not advise, do not solve, do not judge.
`.trim();

export async function runMirror({ systemPrompt, text }) {
  return gemini.generate({
    system: `${systemPrompt}\n\n${PERSONA}`,
    user: text,
  });
}
