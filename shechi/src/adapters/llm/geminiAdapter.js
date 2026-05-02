// Thin wrapper around @google/genai exposing two methods:
//   gemini.generate({ system, user, json? })  → string
//   gemini.classify({ instruction, message })  → { domain, persona, confidence }
//
// The wrapper is the single seam for swapping LLM providers. It must stay
// stateless so adapters can be unit-tested with a mock.

import 'dotenv/config';

const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-pro';
const API_KEY = process.env.GEMINI_API_KEY;

let client = null;
async function getClient() {
  if (client) return client;
  const { GoogleGenAI } = await import('@google/genai');
  client = new GoogleGenAI({ apiKey: API_KEY });
  return client;
}

export const gemini = {
  async generate({ system, user, json = false }) {
    if (!API_KEY) {
      // Offline fallback so the boilerplate runs without a key during dev/tests.
      return json ? '{}' : '[offline:gemini] ' + (user ?? '');
    }
    const c = await getClient();
    const res = await c.models.generateContent({
      model: MODEL,
      contents: [
        { role: 'user', parts: [{ text: user ?? '' }] },
      ],
      config: {
        systemInstruction: system,
        responseMimeType: json ? 'application/json' : 'text/plain',
      },
    });
    return res.text ?? (json ? '{}' : '');
  },

  async classify({ instruction, message }) {
    const raw = await this.generate({ system: instruction, user: message, json: true });
    try {
      const parsed = JSON.parse(raw);
      return {
        domain: String(parsed.domain ?? 'COMPANION').toUpperCase(),
        persona: parsed.persona ?? 'default',
        confidence: Number(parsed.confidence ?? 0.5),
      };
    } catch {
      return { domain: 'COMPANION', persona: 'mirror', confidence: 0.0 };
    }
  },
};
