import { runSyllabus } from './syllabusGenerator.js';
import { runSocratic } from './socraticEngine.js';

export async function runTutor({ systemPrompt, profile, intent, text }) {
  if (intent.persona === 'syllabus') return runSyllabus({ systemPrompt, profile, text });
  return runSocratic({ systemPrompt, profile, text });
}
