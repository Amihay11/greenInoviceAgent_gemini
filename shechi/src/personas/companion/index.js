import { runMirror } from './mirror.js';
import { runSparring } from './sparringPartner.js';
import { queueProfilerRun } from './profiler.js';

export async function runCompanion({ systemPrompt, profile, intent, text }) {
  queueProfilerRun({ user_id: profile.user_id });
  if (intent.persona === 'sparring') return runSparring({ systemPrompt, text });
  return runMirror({ systemPrompt, text });
}

export { queueProfilerRun };
