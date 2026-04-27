// Gemini provider — thin pass-through over @google/genai. Returned object
// matches the GoogleGenAI shape (.models.generateContent, .chats.create), so
// it can be swapped with the Claude adapter without changing call sites.

import { GoogleGenAI } from '@google/genai';

export const GEMINI_DEFAULT_MODEL = 'gemini-2.5-pro';

// Models retired for new users (Gemini 2.0 family). When set in env, fall
// back to the working default and warn instead of crashing on first call.
const RETIRED_GEMINI_MODELS = /^gemini-2\.0-(flash|pro)/i;

export function resolveGeminiModel(model) {
  const m = (model || '').trim();
  if (!m) return GEMINI_DEFAULT_MODEL;
  if (RETIRED_GEMINI_MODELS.test(m)) {
    console.warn(`[provider] Gemini model "${m}" is no longer available to new users. Using "${GEMINI_DEFAULT_MODEL}" instead.`);
    return GEMINI_DEFAULT_MODEL;
  }
  return m;
}

export function createGeminiAI({ apiKey }) {
  return new GoogleGenAI({ apiKey });
}
