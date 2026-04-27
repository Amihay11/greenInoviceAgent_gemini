// Provider factory. Reads AI_PROVIDER from env (or accepts an override) and
// returns an `ai` instance whose shape matches the @google/genai SDK so that
// every existing call site (ai.models.generateContent / ai.chats.create) keeps
// working unchanged regardless of which provider is active.

import { createGeminiAI, GEMINI_DEFAULT_MODEL, resolveGeminiModel } from './gemini.js';
import { createClaudeAI, CLAUDE_DEFAULT_MODEL } from './claude.js';

export const SUPPORTED_PROVIDERS = ['gemini', 'claude'];

function normalizeProvider(p) {
  const v = (p || 'gemini').toLowerCase().trim();
  if (v === 'anthropic') return 'claude';
  if (v === 'google') return 'gemini';
  return v;
}

export function createAI({ provider, geminiApiKey, claudeApiKey, model } = {}) {
  const which = normalizeProvider(provider);

  if (which === 'claude') {
    if (!claudeApiKey) {
      throw new Error('AI_PROVIDER=claude but ANTHROPIC_API_KEY is not set in .env');
    }
    const ai = createClaudeAI({ apiKey: claudeApiKey });
    return { ai, modelName: model || CLAUDE_DEFAULT_MODEL, provider: 'claude' };
  }

  if (which === 'gemini') {
    if (!geminiApiKey) {
      throw new Error('AI_PROVIDER=gemini but GEMINI_API_KEY is not set in .env');
    }
    const ai = createGeminiAI({ apiKey: geminiApiKey });
    return { ai, modelName: resolveGeminiModel(model), provider: 'gemini' };
  }

  throw new Error(`Unknown AI_PROVIDER "${provider}". Supported: ${SUPPORTED_PROVIDERS.join(', ')}`);
}

export { GEMINI_DEFAULT_MODEL, CLAUDE_DEFAULT_MODEL };
