// Loads the user's profile (DB first, JSON fallback) and injects their
// known_domains + custom_learning_rules into a generic system prompt.
// The base prompt MUST NOT contain user-specific text — separation of concerns.

import fs from 'node:fs';
import path from 'node:path';
import { db } from '../db/client.js';

const PROFILES_DIR = path.resolve('profiles');

export function loadProfile(userId) {
  const row = db.prepare(`
    SELECT u.user_id, u.display_name, u.locale, u.channel,
           p.known_domains_json, p.custom_rules_json,
           p.preferred_personas, p.voice_default
    FROM users u
    LEFT JOIN user_profiles p ON p.user_id = u.user_id
    WHERE u.user_id = ?
  `).get(userId);

  if (row) {
    return {
      user_id: row.user_id,
      display_name: row.display_name,
      locale: row.locale ?? 'en',
      channel: row.channel,
      known_domains: JSON.parse(row.known_domains_json ?? '[]'),
      custom_learning_rules: JSON.parse(row.custom_rules_json ?? '[]'),
      preferred_personas: row.preferred_personas ?? 'auto',
      voice_default: !!row.voice_default,
    };
  }

  const file = path.join(PROFILES_DIR, `${userId}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));

  throw new Error(`No profile found for user_id=${userId}`);
}

export function injectProfile(baseSystemPrompt, profile, { isAudio = false } = {}) {
  const domainsBlock = profile.known_domains
    .map(d => `- ${d.name}${d.tags ? ` (${d.tags.join(', ')})` : ''}`)
    .join('\n');

  const rulesBlock = profile.custom_learning_rules
    .map(r => `- [${r.id}] WHEN ${r.trigger}: ${r.action}${r.negative ? ` (NEVER: ${r.negative})` : ''}`)
    .join('\n');

  const voiceBlock = isAudio
    ? 'OUTPUT MODE: AUDIO. Conversational tone. NO Markdown, NO code blocks, NO LaTeX.'
    : 'OUTPUT MODE: TEXT. Rich Markdown allowed. Format formal math with LaTeX ($ inline, $$ display).';

  return [
    baseSystemPrompt.trim(),
    '',
    '## DYNAMIC USER CONTEXT (injected at runtime)',
    `User: ${profile.display_name} (locale=${profile.locale})`,
    '',
    '### Known domains — use for cross-pollination analogies:',
    domainsBlock || '(none)',
    '',
    '### Custom learning rules — apply BEFORE persona logic:',
    rulesBlock || '(none)',
    '',
    `### ${voiceBlock}`,
  ].join('\n');
}
