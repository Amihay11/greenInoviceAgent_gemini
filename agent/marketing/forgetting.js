// Activation-based forgetting algorithm (Generative Agents + SM-2 hybrid).
//
// activation = ln(access_count + 1) × e^(−decay_rate × days_since_last_access)
//
// decay_rate = 0.1  for strong items  (confidence ≥ 0.7 OR access_count ≥ 5)
//            = 0.3  for weak/new items
//
// Archive threshold : activation < 0.05
// Near-forgetting   : 0.05 < activation < 0.15  (surfaced in Mentor reflection)
// Never archived    : published posts, pinned goals.
//
// Usage:
//   touchMemory(table, id)       — call after every retrieval (longTerm.js)
//   runForgettingSweep(userId)   — call once per day (index.js daily scheduler)
//   nearForgettingItems(userId)  — call in reflect() so Mentor can decide to recall or let fade

import { getDb, setMemory, getMemory } from './memory.js';

const VECTOR_THRESHOLD = parseInt(process.env.SHAUL_VECTOR_THRESHOLD || '150', 10);

const ARCHIVE_THRESHOLD = 0.05;
const NEAR_THRESHOLD    = 0.15;

// ── Core formula ──────────────────────────────────────────────────────────────

export function activation({ access_count, last_accessed_at, confidence = 0.5 }) {
  const days = last_accessed_at
    ? (Date.now() - new Date(last_accessed_at).getTime()) / 86400_000
    : 365; // treat never-accessed as very old
  const decayRate = (confidence >= 0.7 || access_count >= 5) ? 0.1 : 0.3;
  return Math.log(access_count + 1) * Math.exp(-decayRate * days);
}

// ── Touch (strengthen on retrieval) ──────────────────────────────────────────

export function touchMemory(table, id) {
  try {
    getDb().prepare(`
      UPDATE ${table}
      SET access_count     = access_count + 1,
          last_accessed_at = datetime('now')
      WHERE id = ?
    `).run(id);
  } catch (_) {}
}

// ── Daily sweep ───────────────────────────────────────────────────────────────
// Archives items whose activation has dropped below the threshold.
// Only operates on tables that support a status='archived' value.

export function runForgettingSweep(userId) {
  const db = getDb();
  _archiveWeak(db, userId, 'learned_insights', 'confidence');
  _archiveWeak(db, userId, 'entities',         null);
  _archiveWeak(db, userId, 'campaigns',        null);
  _checkMemoryHealth(db, userId);
}

function _checkMemoryHealth(db, userId) {
  try {
    let count;
    try {
      count = db.prepare(
        `SELECT COUNT(*) AS n FROM learned_insights
         WHERE user_id = ? AND (status IS NULL OR status != 'archived')`
      ).get(userId)?.n ?? 0;
    } catch (_) { return; }

    if (count <= VECTOR_THRESHOLD) return;

    // Guard: warn at most once per day.
    const today = new Date().toISOString().slice(0, 10);
    const existing = getMemory(userId, '_memory_health');
    if (existing?.warned_date === today) return;

    setMemory(userId, '_memory_health', {
      insight_count: count,
      threshold:     VECTOR_THRESHOLD,
      warned_date:   today,
    });
    console.warn(
      `[memory] ${userId}: learned_insights has ${count} active rows (threshold ${VECTOR_THRESHOLD}). ` +
      `Consider switching to vector embeddings (all-MiniLM via ONNX) for better semantic recall.`
    );
  } catch (_) {}
}

function _archiveWeak(db, userId, table, confidenceCol) {
  let rows;
  try {
    rows = db.prepare(`
      SELECT id, access_count, last_accessed_at${confidenceCol ? ', ' + confidenceCol : ''}
      FROM ${table}
      WHERE user_id = ?
        AND (status IS NULL OR status NOT IN (
              'archived', 'published', 'done', 'cancelled', 'active', 'completed'
            ))
      LIMIT 500
    `).all(userId);
  } catch (_) { return; }

  for (const row of rows) {
    const score = activation({
      access_count:     row.access_count || 0,
      last_accessed_at: row.last_accessed_at,
      confidence:       confidenceCol ? (row[confidenceCol] ?? 0.5) : 0.5,
    });
    if (score < ARCHIVE_THRESHOLD) {
      try {
        db.prepare(`UPDATE ${table} SET status = 'archived' WHERE id = ?`).run(row.id);
      } catch (_) {}
    }
  }
}

// ── Near-forgetting surface ───────────────────────────────────────────────────
// Returns items that are fading but not yet archived — Mentor can decide
// to explicitly recall them (strengthening) or let them fade naturally.

export function nearForgettingItems(userId, limit = 5) {
  const db = getDb();
  const results = [];

  const targets = [
    { table: 'learned_insights', confidenceCol: 'confidence', textCols: ['topic', 'insight'] },
    { table: 'entities',         confidenceCol: null,         textCols: ['kind', 'name']     },
    { table: 'campaigns',        confidenceCol: null,         textCols: ['name']              },
  ];

  for (const { table, confidenceCol, textCols } of targets) {
    let rows;
    try {
      rows = db.prepare(`
        SELECT id, access_count, last_accessed_at, ${textCols.join(', ')}
               ${confidenceCol ? ', ' + confidenceCol : ''}
        FROM ${table}
        WHERE user_id = ?
          AND (status IS NULL OR status NOT IN (
                'archived', 'done', 'cancelled', 'published', 'active', 'completed'
              ))
        LIMIT 200
      `).all(userId);
    } catch (_) { continue; }

    for (const row of rows) {
      const score = activation({
        access_count:     row.access_count || 0,
        last_accessed_at: row.last_accessed_at,
        confidence:       confidenceCol ? (row[confidenceCol] ?? 0.5) : 0.5,
      });
      if (score > ARCHIVE_THRESHOLD && score < NEAR_THRESHOLD) {
        const text = textCols.map(c => row[c]).filter(Boolean).join(' — ');
        results.push({ table, id: row.id, activation: score, text });
      }
    }
  }

  return results.sort((a, b) => a.activation - b.activation).slice(0, limit);
}
