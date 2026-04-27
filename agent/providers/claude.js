// Claude (Anthropic) provider, exposed through a GoogleGenAI-compatible facade.
//
// The rest of the codebase was written against @google/genai's API:
//   ai.models.generateContent({ model, contents, config })
//   ai.chats.create({ model, history, config }).sendMessage({ message })
//   chat.getHistory()
//   result.text / result.functionCalls
//
// This file re-implements that surface area on top of @anthropic-ai/sdk so we
// can flip providers via env var without touching call sites. Translations:
//   - Gemini "model" role            → Claude "assistant"
//   - { text }                       → { type: 'text', text }
//   - { inlineData }                 → { type: 'image', source: base64 }
//   - { functionCall }               → { type: 'tool_use' }
//   - { functionResponse }           → { type: 'tool_result' }
//   - functionDeclarations           → tools (lower-cased JSON Schema types)
//   - googleSearch (built-in tool)   → dropped (Claude uses different web tools)

import Anthropic from '@anthropic-ai/sdk';

export const CLAUDE_DEFAULT_MODEL = 'claude-sonnet-4-5';
const DEFAULT_MAX_TOKENS = 4096;

let _idCounter = 0;
function generateId(prefix = 'toolu') {
  _idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${_idCounter.toString(36)}`;
}

// ── Type/format helpers ──────────────────────────────────────────────────────

function geminiTypeToJsonSchema(t) {
  if (!t) return 'string';
  return String(t).toLowerCase();
}

function declarationToClaudeTool(decl) {
  const properties = {};
  for (const [k, v] of Object.entries(decl.parameters?.properties || {})) {
    const prop = {
      type: geminiTypeToJsonSchema(v.type),
      description: v.description || '',
    };
    if (v.items) prop.items = { type: geminiTypeToJsonSchema(v.items.type) };
    if (v.enum) prop.enum = v.enum;
    properties[k] = prop;
  }
  return {
    name: decl.name,
    description: decl.description || '',
    input_schema: {
      type: 'object',
      properties,
      required: decl.parameters?.required || [],
    },
  };
}

function buildClaudeTools(toolsArr) {
  const out = [];
  for (const t of toolsArr || []) {
    if (t?.functionDeclarations) {
      for (const d of t.functionDeclarations) out.push(declarationToClaudeTool(d));
    }
    // googleSearch / urlContext have no clean Claude equivalent here. Drop
    // them silently — flows that depend on web search degrade to no search.
  }
  return out;
}

function systemInstructionToString(si) {
  if (!si) return undefined;
  if (typeof si === 'string') return si;
  if (Array.isArray(si)) {
    return si.map(systemInstructionToString).filter(Boolean).join('\n');
  }
  if (si.parts) return si.parts.map(p => p.text || '').join('\n');
  if (si.text) return si.text;
  return undefined;
}

function partsToClaudeContent(parts) {
  const blocks = [];
  for (const p of parts || []) {
    if (p == null) continue;
    if (typeof p === 'string') {
      blocks.push({ type: 'text', text: p });
    } else if (p.text != null) {
      blocks.push({ type: 'text', text: p.text });
    } else if (p.inlineData) {
      blocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: p.inlineData.mimeType || p.inlineData.media_type,
          data: p.inlineData.data,
        },
      });
    } else if (p.functionCall) {
      blocks.push({
        type: 'tool_use',
        id: p.functionCall._claudeId || generateId('toolu'),
        name: p.functionCall.name,
        input: p.functionCall.args || {},
      });
    } else if (p.functionResponse) {
      const raw = p.functionResponse.response;
      const content = typeof raw === 'string' ? raw : JSON.stringify(raw);
      blocks.push({
        type: 'tool_result',
        tool_use_id: p.functionResponse._claudeId,
        content,
      });
    }
  }
  return blocks;
}

// Walk the Gemini-format history once to ensure every functionCall has a
// _claudeId and every functionResponse is paired to the matching call. Used
// when ingesting an existing history that may have been created by the real
// Gemini SDK (no _claudeId fields).
function ensureClaudeIds(history) {
  const out = [];
  const pending = []; // [{ id, name }]
  for (const turn of history || []) {
    const newParts = [];
    for (const p of turn.parts || []) {
      if (p?.functionCall) {
        const id = p.functionCall._claudeId || generateId('toolu');
        newParts.push({ functionCall: { ...p.functionCall, _claudeId: id } });
        pending.push({ id, name: p.functionCall.name });
      } else if (p?.functionResponse) {
        let id = p.functionResponse._claudeId;
        if (!id) {
          const idx = pending.findIndex(x => x.name === p.functionResponse.name);
          if (idx !== -1) {
            id = pending[idx].id;
            pending.splice(idx, 1);
          } else {
            id = generateId('toolu');
          }
        }
        newParts.push({ functionResponse: { ...p.functionResponse, _claudeId: id } });
      } else {
        newParts.push(p);
      }
    }
    out.push({ role: turn.role, parts: newParts });
  }
  return out;
}

// Convert Gemini-format history into a Claude `messages` array. Consecutive
// same-role turns are merged so the request still satisfies Claude's strict
// user/assistant alternation.
function historyToClaudeMessages(history) {
  const out = [];
  for (const turn of history || []) {
    const role = turn.role === 'model' ? 'assistant' : 'user';
    const blocks = partsToClaudeContent(turn.parts || []);
    if (blocks.length === 0) continue;
    if (out.length && out[out.length - 1].role === role) {
      out[out.length - 1].content.push(...blocks);
    } else {
      out.push({ role, content: blocks });
    }
  }
  return out;
}

// ── Models API (one-shot generateContent) ────────────────────────────────────

class ClaudeModelsAPI {
  constructor(client) { this.client = client; }

  async generateContent({ model, contents, config = {} }) {
    const messages = [];
    for (const turn of contents || []) {
      const role = turn.role === 'model' ? 'assistant' : 'user';
      const content = partsToClaudeContent(turn.parts || []);
      if (content.length === 0) continue;
      if (messages.length && messages[messages.length - 1].role === role) {
        messages[messages.length - 1].content.push(...content);
      } else {
        messages.push({ role, content });
      }
    }

    const params = {
      model,
      max_tokens: config.maxOutputTokens || DEFAULT_MAX_TOKENS,
      messages,
    };
    const sys = systemInstructionToString(config.systemInstruction);
    if (sys) params.system = sys;
    if (config.temperature != null) params.temperature = config.temperature;
    const tools = buildClaudeTools(config.tools);
    if (tools.length > 0) params.tools = tools;

    const resp = await this.client.messages.create(params);
    const text = (resp.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');
    return { text };
  }
}

// ── Chats API (multi-turn with tool loop) ────────────────────────────────────

class ClaudeChat {
  constructor({ client, model, history, config }) {
    this.client = client;
    this.model = model;
    this.config = config || {};
    this.tools = buildClaudeTools(this.config.tools);
    this.system = systemInstructionToString(this.config.systemInstruction);
    this.history = ensureClaudeIds(history);
    // tool_use blocks the assistant emitted that the caller still has to
    // answer. We expose them one at a time (matching how the existing tool
    // loop in index.js consumes Gemini's functionCalls[0]).
    this._pendingToolUses = [];
  }

  async sendMessage({ message }) {
    if (Array.isArray(message) && message.length > 0 && message[0]?.functionResponse) {
      return this._handleFunctionResponse(message[0].functionResponse);
    }

    let parts;
    if (typeof message === 'string') parts = [{ text: message }];
    else if (Array.isArray(message)) parts = message;
    else if (message?.parts) parts = message.parts;
    else parts = [{ text: String(message) }];

    this.history.push({ role: 'user', parts });
    return this._callClaude();
  }

  async _handleFunctionResponse(fr) {
    const tu = this._pendingToolUses.shift();
    if (!tu) throw new Error('Claude adapter: no pending tool_use to match function response');

    this.history.push({
      role: 'user',
      parts: [{
        functionResponse: {
          name: fr.name || tu.name,
          response: fr.response,
          _claudeId: tu.id,
        },
      }],
    });

    if (this._pendingToolUses.length > 0) {
      const next = this._pendingToolUses[0];
      return { text: '', functionCalls: [{ name: next.name, args: next.input || {} }] };
    }
    return this._callClaude();
  }

  async _callClaude() {
    const messages = historyToClaudeMessages(this.history);
    const params = {
      model: this.model,
      max_tokens: DEFAULT_MAX_TOKENS,
      messages,
    };
    if (this.system) params.system = this.system;
    if (this.config.temperature != null) params.temperature = this.config.temperature;
    if (this.tools.length > 0) params.tools = this.tools;

    const resp = await this.client.messages.create(params);

    const text = (resp.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');
    const toolUses = (resp.content || []).filter(b => b.type === 'tool_use');

    const parts = [];
    for (const b of resp.content || []) {
      if (b.type === 'text') parts.push({ text: b.text });
      else if (b.type === 'tool_use') {
        parts.push({ functionCall: { name: b.name, args: b.input || {}, _claudeId: b.id } });
      }
    }
    if (parts.length === 0) parts.push({ text: '' });
    this.history.push({ role: 'model', parts });

    if (toolUses.length > 0) {
      this._pendingToolUses = [...toolUses];
      const first = this._pendingToolUses[0];
      return { text, functionCalls: [{ name: first.name, args: first.input || {} }] };
    }
    return { text, functionCalls: undefined };
  }

  async getHistory() {
    return this.history;
  }
}

class ClaudeChatsAPI {
  constructor(client) { this.client = client; }
  create({ model, history, config }) {
    return new ClaudeChat({ client: this.client, model, history, config });
  }
}

// ── Top-level facade ─────────────────────────────────────────────────────────

class ClaudeGenAI {
  constructor({ apiKey, baseURL }) {
    this.client = new Anthropic({ apiKey, ...(baseURL ? { baseURL } : {}) });
    this.models = new ClaudeModelsAPI(this.client);
    this.chats = new ClaudeChatsAPI(this.client);
  }
}

export function createClaudeAI({ apiKey, baseURL } = {}) {
  return new ClaudeGenAI({ apiKey, baseURL });
}
