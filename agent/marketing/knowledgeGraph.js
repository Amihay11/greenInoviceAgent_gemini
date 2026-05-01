// Knowledge graph — tracks relationships between content items.
//
// Relation types:
//   part_of        — post/creative belongs to a campaign
//   repurposed_from — this post was derived from an older post/campaign
//   similar_to     — two posts share format/topic
//   mentions       — post caption mentions an entity
//   outcome_of     — insight was produced by a campaign's metrics
//   follows_up     — outbound DM follows up an entity/goal
//
// All graph data lives in the content_edges SQLite table (schema in memory.js).
// Edges are mirrored to a "🕸️ גרף תוכן שאול" Notion database (fire-and-forget).
//
// Auto-wiring happens in cmo.js at post-save, insight creation, and DM send.
// Repurposable campaigns are surfaced in longTerm.js:recallProcedural.

import { getDb } from './memory.js';
import { syncEdgeToNotion } from './notion-memory.js';

// ── Write ──────────────────────────────────────────────────────────────────────

export function addEdge({ userId, fromType, fromId, toType, toId, relation, weight = 1.0 }) {
  const db = getDb();
  try {
    db.prepare(`
      INSERT INTO content_edges (user_id, from_type, from_id, to_type, to_id, relation, weight)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, from_type, from_id, to_type, to_id, relation)
      DO UPDATE SET
        weight           = (content_edges.weight + excluded.weight) / 2.0,
        last_accessed_at = datetime('now')
    `).run(userId, fromType, fromId, toType, toId, relation, weight);

    const edge = db.prepare(`
      SELECT * FROM content_edges
      WHERE user_id = ? AND from_type = ? AND from_id = ?
        AND to_type = ? AND to_id = ? AND relation = ?
    `).get(userId, fromType, fromId, toType, toId, relation);

    if (edge) syncEdgeToNotion(userId, edge).catch(() => {});
    return edge?.id ?? null;
  } catch (e) {
    console.error('[KG] addEdge error:', e.message);
    return null;
  }
}

export function touchEdge(edgeId) {
  try {
    getDb().prepare(`
      UPDATE content_edges
      SET access_count     = access_count + 1,
          last_accessed_at = datetime('now')
      WHERE id = ?
    `).run(edgeId);
  } catch (_) {}
}

// ── Read ───────────────────────────────────────────────────────────────────────

export function getRelated({ userId, nodeType, nodeId, relation = null, limit = 10 }) {
  try {
    const rows = relation
      ? getDb().prepare(
          `SELECT * FROM content_edges
           WHERE user_id = ? AND from_type = ? AND from_id = ? AND relation = ?
           ORDER BY weight DESC LIMIT ?`
        ).all(userId, nodeType, nodeId, relation, limit)
      : getDb().prepare(
          `SELECT * FROM content_edges
           WHERE user_id = ? AND from_type = ? AND from_id = ?
           ORDER BY weight DESC LIMIT ?`
        ).all(userId, nodeType, nodeId, limit);

    for (const row of rows) touchEdge(row.id);
    return rows;
  } catch (_) { return []; }
}

// Returns campaigns/posts older than 30 days with no outbound repurposed_from edge,
// ordered by performance_score DESC (most successful content worth recycling first).
export function findRepurposable(userId, limit = 5) {
  try {
    return getDb().prepare(`
      SELECT c.* FROM campaigns c
      WHERE c.user_id = ?
        AND c.created_at < datetime('now', '-30 days')
        AND c.status IN ('active', 'completed')
        AND NOT EXISTS (
          SELECT 1 FROM content_edges e
          WHERE e.user_id = c.user_id
            AND e.to_type  = 'campaign'
            AND e.to_id    = c.id
            AND e.relation = 'repurposed_from'
        )
      ORDER BY c.updated_at DESC
      LIMIT ?
    `).all(userId, limit);
  } catch (_) { return []; }
}

// Returns the full lineage tree for a post (BFS up to 3 hops, following any edge).
export function getContentChain(userId, postId) {
  const db = getDb();
  const visited = new Set([`post:${postId}`]);
  const chain   = [];
  let frontier  = [{ type: 'post', id: postId }];

  for (let hop = 0; hop < 3 && frontier.length > 0; hop++) {
    const next = [];
    for (const node of frontier) {
      let edges = [];
      try {
        edges = db.prepare(`
          SELECT * FROM content_edges
          WHERE user_id = ?
            AND ((from_type = ? AND from_id = ?) OR (to_type = ? AND to_id = ?))
        `).all(userId, node.type, node.id, node.type, node.id);
      } catch (_) {}

      for (const e of edges) {
        chain.push(e);
        const neighbor = (e.from_type === node.type && e.from_id === node.id)
          ? { type: e.to_type,   id: e.to_id   }
          : { type: e.from_type, id: e.from_id };
        const key = `${neighbor.type}:${neighbor.id}`;
        if (!visited.has(key)) {
          visited.add(key);
          next.push(neighbor);
        }
      }
    }
    frontier = next;
  }
  return chain;
}
