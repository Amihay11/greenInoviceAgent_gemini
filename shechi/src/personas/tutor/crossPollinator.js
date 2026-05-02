// Picks an analogy from the user's known_domains for the current concept.
// Reads `edge_graph` first; if no stored edge exists, asks the LLM for one
// and writes it back so the analogy can be re-used.

import { db } from '../../db/client.js';
import { gemini } from '../../adapters/llm/geminiAdapter.js';

const findEdge = db.prepare(`
  SELECT dst_concept, relation FROM edge_graph
  WHERE user_id = ? AND src_concept = ? AND relation = 'analogy_of'
  ORDER BY weight DESC LIMIT 1
`);
const insertEdge = db.prepare(`
  INSERT INTO edge_graph (user_id, src_concept, dst_concept, relation, weight)
  VALUES (?, ?, ?, 'analogy_of', ?)
`);

export async function runCrossPollinator({ profile, text }) {
  if (!profile.known_domains?.length) return null;

  const concept = (text.match(/\b(?:explain|teach|learn|about)\s+(?:me\s+)?(?:about\s+)?([\w\-\s]{2,40})/i)?.[1] ?? '').trim();
  if (!concept) return null;

  const cached = findEdge.get(profile.user_id, concept.toLowerCase());
  if (cached) return `Use the analogy "${cached.dst_concept}".`;

  const domainList = profile.known_domains.map(d => d.name).join(', ');
  const json = await gemini.generate({
    system: 'Pick the SINGLE best analogy for the given concept from the user\'s known domains. Return strict JSON: {"analogy":"...","domain":"..."} or {} if none fits.',
    user: `Concept: ${concept}\nUser's known domains: ${domainList}`,
    json: true,
  });

  let parsed = {};
  try { parsed = JSON.parse(json); } catch { return null; }
  if (!parsed.analogy) return null;

  insertEdge.run(profile.user_id, concept.toLowerCase(), parsed.analogy, 1.0);
  return `Use the analogy "${parsed.analogy}" from ${parsed.domain}.`;
}
