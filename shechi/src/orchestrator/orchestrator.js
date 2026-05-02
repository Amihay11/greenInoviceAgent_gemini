import fs from 'node:fs';
import path from 'node:path';
import { loadProfile, injectProfile } from './profileInjector.js';
import { routeIntent } from './intentRouter.js';
import { detectGaps } from './gapDetector.js';
import { formatForVoice } from './voiceFormatter.js';
import { runCompanion } from '../personas/companion/index.js';
import { runTutor } from '../personas/tutor/index.js';
import { runInterview, maybeOfferInterview } from '../personas/interview/index.js';
import { runTool } from '../tools/dispatcher.js';
import { db } from '../db/client.js';

const BASE_PROMPT = fs.readFileSync(path.resolve('src/prompts/system.base.md'), 'utf8');

const insertMessage = db.prepare(`
  INSERT INTO messages (user_id, direction, channel, is_audio, body, intent, persona)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

export async function handleMessage({ user_id, text, isAudio = false, mediaUrl = null }) {
  const profile = loadProfile(user_id);
  const systemPrompt = injectProfile(BASE_PROMPT, profile, { isAudio });
  const intent = await routeIntent({ text, profile });

  insertMessage.run(user_id, 'in', profile.channel, isAudio ? 1 : 0, text, intent.domain, intent.persona);

  // Detect gaps best-effort; never block the reply
  let newGaps = [];
  try {
    newGaps = await detectGaps({ profile, text, intent });
  } catch (err) {
    console.warn('gapDetector failed:', err.message);
  }

  let reply;
  switch (intent.domain) {
    case 'INTERVIEW':
      reply = await runInterview({ systemPrompt, profile, sessionId: intent.session_id, text });
      break;
    case 'TUTOR':
      reply = await runTutor({ systemPrompt, profile, intent, text });
      break;
    case 'COMPANION':
      reply = await runCompanion({ systemPrompt, profile, intent, text });
      break;
    case 'TOOL_CALL':
      reply = await runTool({ systemPrompt, profile, intent, text, mediaUrl });
      break;
    default:
      reply = await runCompanion({ systemPrompt, profile, intent: { domain: 'COMPANION', persona: 'mirror' }, text });
  }

  // Append a non-blocking interview offer if there are open gaps
  if (intent.domain !== 'INTERVIEW') {
    const suggestion = await maybeOfferInterview({ profile, newGaps });
    if (suggestion) reply = `${reply}\n\n${suggestion}`;
  }

  insertMessage.run(user_id, 'out', profile.channel, isAudio ? 1 : 0, reply, intent.domain, intent.persona);

  return formatForVoice(reply, { isAudio });
}
