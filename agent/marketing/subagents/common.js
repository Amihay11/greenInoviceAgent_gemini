// Shared helpers for marketing sub-agents.
// Each sub-agent is a thin wrapper around a Gemini call with:
//   1) Shaul's persona prefix (so voice stays consistent),
//   2) the sub-agent's specialized role rules,
//   3) the relevant slice of long-term memory injected as context.
//
// Sub-agents return STRUCTURED data (JSON parsed from a fenced code block).
// The CMO orchestrator decides what to do with the result. This keeps the
// orchestrator's context small (Anthropic multi-agent guidance, 2025).

import { formatContextForPrompt, buildContextBundle } from '../memory.js';

const PERSONA = `You are a sub-agent inside Shaul, an Israeli business and marketing mentor.
Shaul's voice: direct, concise, Israeli cadence, no flattery, native Hebrew, fluent English.
You speak ONLY in this voice. Reply in the SAME language as the user (default Hebrew).
You are a SPECIALIST. Stay in your lane. Return ONLY the JSON your role specifies, fenced as \`\`\`json ... \`\`\`.
Do not chat. Do not explain unless your schema includes an explanation field.`;

export function buildPrompt({ userId, role, task, schemaHint, extra = '' }) {
  const ctx = formatContextForPrompt(buildContextBundle(userId));
  return [
    PERSONA,
    `\n## YOUR ROLE\n${role}`,
    `\n## REQUIRED OUTPUT SCHEMA\nReturn a single JSON object inside a \`\`\`json fenced block.\n${schemaHint}`,
    ctx ? `\n## LONG-TERM MEMORY (use this to ground your output)\n${ctx}` : '',
    extra ? `\n## EXTRA CONTEXT\n${extra}` : '',
    `\n## TASK\n${task}`,
  ].filter(Boolean).join('\n');
}

// Set grounded=true to attach Google Search grounding for this call. Use only
// for sub-agents that benefit from real-time external info (Mentor, Director,
// Analyst). Strategist + Creative deliberately skip it to keep voice grounded
// in stored memory.
export async function runSubagent({ ai, modelName, prompt, grounded = false, temperature = 0.7 }) {
  const config = { temperature };
  if (grounded) {
    config.tools = [{ googleSearch: {} }];
  }
  const result = await ai.models.generateContent({
    model: modelName,
    contents: [{ parts: [{ text: prompt }] }],
    config,
  });
  const text = result.text || '';
  return { text, json: extractJson(text) };
}

export function extractJson(text) {
  if (!text) return null;
  const fenced = text.match(/```json\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1] : text;
  try {
    return JSON.parse(raw);
  } catch (_) {
    // Last resort: find first { ... } block.
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) {
      try { return JSON.parse(m[0]); } catch (_) { return null; }
    }
    return null;
  }
}
