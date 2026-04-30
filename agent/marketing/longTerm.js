// Layer 3 — Long-term retrieval API (CoALA: episodic / semantic / procedural).
//
// Composite scoring (Generative-Agents pattern):
//   score = 0.5·similarity + 0.3·recency + 0.2·importance
//
//   similarity : token-overlap ratio (Hebrew + English, no vector DB needed)
//   recency    : 0.5^(age_days / half_life)  — half_life varies by store type
//   importance : confidence / priority field normalised to [0,1]
//
// Three retrievers mirror the three CoALA sub-stores:
//   recallEpisodic   — what happened (interactions, attendance, calendar, outbound)
//   recallSemantic   — what is known (insights, entities, goals, profile facts)
//   recallProcedural — what to do (campaigns, posts, agenda history, reflections)
//
// Mentor calls these ONLY when the user's message explicitly references the past
// or a specific topic — not on every turn. Default context comes from coreMemory.js.

import {
  recentInteractions, recentAttendance, listInsights,
  listGoals, listCampaigns, listPosts, recentReflections,
  getDb,
} from './memory.js';

// ── Similarity ────────────────────────────────────────────────────────────────

function tokenize(text) {
  return new Set(
    String(text || '').toLowerCase()
      .replace(/[^\wא-ת\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 1)
  );
}

function similarity(query, text) {
  const q = tokenize(query);
  const t = tokenize(text);
  if (!q.size || !t.size) return 0;
  let overlap = 0;
  for (const tok of q) { if (t.has(tok)) overlap++; }
  return overlap / Math.max(q.size, t.size);
}

// ── Recency decay ─────────────────────────────────────────────────────────────

function recency(isoDate, halfLifeDays = 7) {
  if (!isoDate) return 0.1;
  const ageDays = (Date.now() - new Date(isoDate).getTime()) / 86400_000;
  return Math.pow(0.5, ageDays / halfLifeDays);
}

// ── Composite score ───────────────────────────────────────────────────────────

function score(sim, rec, imp) {
  return 0.5 * sim + 0.3 * rec + 0.2 * Math.min(1, Math.max(0, imp));
}

// ── Episodic recall ───────────────────────────────────────────────────────────
// What happened: conversations, attendance, calendar events, outbound DMs.

export function recallEpisodic({ userId, query, k = 5 }) {
  const interactions = recentInteractions(userId, 60);
  const attendance   = recentAttendance(userId, 20);

  const candidates = [
    ...interactions.map(i => ({
      kind: 'interaction',
      text: `${i.role}: ${i.content}`,
      date: i.created_at,
      importance: i.role === 'user' ? 0.5 : 0.4,
    })),
    ...attendance.map(a => ({
      kind: 'attendance',
      text: `${a.session_label}: ${a.headcount} אנשים${a.revenue ? `, ₪${a.revenue}` : ''}`,
      date: a.session_date || a.created_at,
      importance: 0.7,
    })),
  ];

  return rank(candidates, query, k, 14);
}

// ── Semantic recall ───────────────────────────────────────────────────────────
// What is known: insights, entities, goals, profile notes.

export function recallSemantic({ userId, query, k = 5 }) {
  const insights  = listInsights(userId, 50);
  const goals     = listGoals(userId, 'active');
  const entities  = getDb().prepare(
    `SELECT * FROM entities WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`
  ).all(userId);

  const candidates = [
    ...insights.map(i => ({
      kind: 'insight',
      text: `[${i.topic}] ${i.insight}`,
      date: i.created_at,
      importance: i.confidence || 0.6,
    })),
    ...goals.map(g => ({
      kind: 'goal',
      text: `מטרה: ${g.title}${g.target ? ` (יעד: ${g.target} ${g.metric || ''})` : ''}`,
      date: g.created_at,
      importance: 0.8,
    })),
    ...entities.map(e => ({
      kind: 'entity',
      text: `[${e.kind}] ${e.name}${e.details ? ': ' + e.details : ''}`,
      date: e.created_at,
      importance: 0.5,
    })),
  ];

  return rank(candidates, query, k, 30);
}

// ── Procedural recall ─────────────────────────────────────────────────────────
// What to do / what was planned: campaigns, post history, reflections.

export function recallProcedural({ userId, query, k = 5 }) {
  const campaigns    = listCampaigns(userId);
  const posts        = listPosts(userId).slice(0, 30);
  const reflections  = recentReflections(userId, 10);

  const candidates = [
    ...campaigns.map(c => ({
      kind: 'campaign',
      text: `קמפיין "${c.name}" (${c.status}): ${c.objective || ''}`,
      date: c.created_at,
      importance: c.status === 'active' ? 0.9 : 0.5,
    })),
    ...posts.map(p => ({
      kind: 'post',
      text: `פוסט ${p.platform} (${p.status}): ${(p.caption || '').slice(0, 120)}`,
      date: p.created_at,
      importance: p.status === 'published' ? 0.7 : 0.4,
    })),
    ...reflections.map(r => ({
      kind: 'reflection',
      text: r.summary,
      date: r.created_at,
      importance: 0.6,
    })),
  ];

  return rank(candidates, query, k, 21);
}

// ── Shared ranker ─────────────────────────────────────────────────────────────

function rank(candidates, query, k, halfLifeDays) {
  return candidates
    .map(c => ({
      ...c,
      _score: score(
        similarity(query, c.text),
        recency(c.date, halfLifeDays),
        c.importance,
      ),
    }))
    .sort((a, b) => b._score - a._score)
    .slice(0, k)
    .map(({ _score, ...rest }) => rest);
}

// ── Convenience: format results for prompt injection ─────────────────────────

export function formatRecallForPrompt(items) {
  if (!items.length) return '';
  return items.map(i => `[${i.kind}] ${i.text}`).join('\n');
}
