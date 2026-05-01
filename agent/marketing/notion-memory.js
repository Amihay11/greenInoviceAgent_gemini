// Notion bidirectional sync layer.
//
// SQLite → Notion (write-through, fire-and-forget):
//   business_profile  → "🏢 פרופיל עסקי"
//   learned_insights  → "💡 תובנות שאול"
//   goals             → "🎯 מטרות עסקיות"
//   agenda_items      → "📋 אג׳נדה שאול"
//   content_edges     → "🕸️ גרף תוכן שאול"
//
// Notion → SQLite (pull, called by the polling scheduler):
//   pullAgendaFromNotion  — picks up Status/Priority edits made directly in Notion
//   pullGoalsFromNotion   — picks up Status/Target edits
//   pullProfileFromNotion — picks up any field edits
//   pullEdgesFromNotion   — syncs archived state back from Notion
//
// All writes are fire-and-forget — a Notion failure never blocks the agent.
// Polling runs every 5 minutes via startNotionPollLoop() called from index.js.
// Notion database IDs and page IDs are cached in SQLite's marketing_memory table
// so they survive process restarts.

import { Client as NotionClient } from '@notionhq/client';
import * as cache from './notion-id-cache.js';

let _notion;
function getNotion() {
  if (!_notion && process.env.NOTION_API_KEY) {
    _notion = new NotionClient({ auth: process.env.NOTION_API_KEY });
  }
  return _notion;
}

export function isEnabled() {
  return !!(process.env.NOTION_API_KEY && process.env.NOTION_MEMORY_PARENT_PAGE_ID);
}

// ── Database bootstrap ────────────────────────────────────────────────────────
// On first call: search Notion for an existing DB with the given title under
// the parent page. If found, cache its ID. If not, create it and cache the ID.

async function getOrCreateDb(userId, cacheKey, title, properties) {
  const cached = cache.get(userId, cacheKey);
  if (cached) return cached;

  const notion = getNotion();
  const parentId = process.env.NOTION_MEMORY_PARENT_PAGE_ID;

  const search = await notion.search({
    query: title,
    filter: { value: 'database', property: 'object' },
  });
  const existing = search.results.find(r =>
    r.object === 'database' &&
    r.parent?.page_id?.replace(/-/g, '') === parentId.replace(/-/g, '') &&
    r.title?.[0]?.plain_text === title
  );

  let dbId;
  if (existing) {
    dbId = existing.id;
  } else {
    const db = await notion.databases.create({
      parent: { type: 'page_id', page_id: parentId },
      title: [{ type: 'text', text: { content: title } }],
      properties,
    });
    dbId = db.id;
  }

  cache.set(userId, cacheKey, dbId);
  return dbId;
}

function rt(text) {
  return { rich_text: [{ text: { content: String(text || '') } }] };
}

async function profileDbId(userId) {
  return getOrCreateDb(userId, 'notion_profile_db_id', '🏢 פרופיל עסקי', {
    Name:          { title: {} },
    Industry:      { rich_text: {} },
    Offer:         { rich_text: {} },
    ICP:           { rich_text: {} },
    'Brand Voice': { rich_text: {} },
    Goals:         { rich_text: {} },
    Budget:        { number: { format: 'shekel' } },
    Channels:      { rich_text: {} },
    Constraints:   { rich_text: {} },
  });
}

async function insightsDbId(userId) {
  return getOrCreateDb(userId, 'notion_insights_db_id', '💡 תובנות שאול', {
    Name:       { title: {} },
    Topic:      { select: {} },
    Confidence: { number: { format: 'number' } },
    Source:     { rich_text: {} },
    Date:       { date: {} },
  });
}

async function goalsDbId(userId) {
  return getOrCreateDb(userId, 'notion_goals_db_id', '🎯 מטרות עסקיות', {
    Name:     { title: {} },
    Metric:   { rich_text: {} },
    Target:   { number: { format: 'number' } },
    Deadline: { date: {} },
    Status:   { select: { options: [
      { name: 'active',    color: 'green' },
      { name: 'done',      color: 'blue'  },
      { name: 'cancelled', color: 'gray'  },
    ]}},
  });
}

async function agendaDbId(userId) {
  return getOrCreateDb(userId, 'notion_agenda_db_id', '📋 אג׳נדה שאול', {
    Name:     { title: {} },
    Detail:   { rich_text: {} },
    Kind:     { select: {} },
    Priority: { number: { format: 'number' } },
    Status:   { select: { options: [
      { name: 'pending', color: 'yellow' },
      { name: 'done',    color: 'green'  },
      { name: 'skipped', color: 'gray'   },
    ]}},
    Due:      { date: {} },
  });
}

async function edgesDbId(userId) {
  return getOrCreateDb(userId, 'notion_edges_db_id', '🕸️ גרף תוכן שאול', {
    Name:     { title: {} },
    To:       { rich_text: {} },
    Relation: { select: { options: [
      { name: 'repurposed_from', color: 'blue'   },
      { name: 'part_of',        color: 'green'  },
      { name: 'similar_to',     color: 'yellow' },
      { name: 'mentions',       color: 'orange' },
      { name: 'outcome_of',     color: 'purple' },
      { name: 'follows_up',     color: 'pink'   },
    ]}},
    Weight:   { number: { format: 'number' } },
    Date:     { date: {} },
  });
}

// ── Sync functions ────────────────────────────────────────────────────────────

export async function syncProfileToNotion(userId, profile) {
  if (!isEnabled()) return;
  const notion = getNotion();
  try {
    const dbId    = await profileDbId(userId);
    const pageKey = `notion_profile_page_id`;
    const pageId  = cache.get(userId, pageKey);

    const props = {
      Name:          { title: [{ text: { content: profile.business_name || 'פרופיל עסקי' } }] },
      Industry:      rt(profile.industry),
      Offer:         rt(profile.offer),
      ICP:           rt(profile.icp),
      'Brand Voice': rt(profile.brand_voice),
      Goals:         rt(profile.goals_summary),
      Channels:      rt(profile.channels),
      Constraints:   rt(profile.constraints),
    };
    if (profile.monthly_budget != null) props.Budget = { number: profile.monthly_budget };

    if (pageId) {
      await notion.pages.update({ page_id: pageId, properties: props });
    } else {
      const page = await notion.pages.create({ parent: { database_id: dbId }, properties: props });
      cache.set(userId, pageKey, page.id);
    }
  } catch (err) {
    console.error('[Notion] profile sync failed:', err.message);
  }
}

export async function syncInsightToNotion(userId, { id, topic, insight, confidence, source, created_at }) {
  if (!isEnabled()) return;
  const notion = getNotion();
  try {
    const dbId = await insightsDbId(userId);
    const page = await notion.pages.create({
      parent: { database_id: dbId },
      properties: {
        Name:       { title: [{ text: { content: insight } }] },
        Topic:      { select: { name: topic || 'כללי' } },
        Confidence: { number: confidence ?? 0.6 },
        Source:     rt(source),
        Date:       { date: { start: (created_at || new Date().toISOString()).slice(0, 10) } },
      },
    });
    cache.set(userId, `notion_insight_${id}`, page.id);
  } catch (err) {
    console.error('[Notion] insight sync failed:', err.message);
  }
}

export async function syncGoalToNotion(userId, { id, title, metric, target, deadline, status }) {
  if (!isEnabled()) return;
  const notion = getNotion();
  try {
    const dbId = await goalsDbId(userId);
    const props = {
      Name:   { title: [{ text: { content: title } }] },
      Metric: rt(metric),
      Status: { select: { name: status || 'active' } },
    };
    if (target   != null) props.Target   = { number: target };
    if (deadline)         props.Deadline = { date: { start: deadline.slice(0, 10) } };

    const page = await notion.pages.create({ parent: { database_id: dbId }, properties: props });
    cache.set(userId, `notion_goal_${id}`, page.id);
  } catch (err) {
    console.error('[Notion] goal sync failed:', err.message);
  }
}

export async function syncAgendaToNotion(userId, { id, title, detail, kind, priority, due_at, status }) {
  if (!isEnabled()) return;
  const notion = getNotion();
  try {
    const dbId = await agendaDbId(userId);
    const props = {
      Name:     { title: [{ text: { content: title } }] },
      Detail:   rt(detail),
      Priority: { number: priority ?? 5 },
      Status:   { select: { name: status || 'pending' } },
    };
    if (kind)  props.Kind = { select: { name: kind } };
    if (due_at) props.Due = { date: { start: due_at.slice(0, 10) } };

    const page = await notion.pages.create({ parent: { database_id: dbId }, properties: props });
    cache.set(userId, `notion_agenda_${id}`, page.id);
  } catch (err) {
    console.error('[Notion] agenda sync failed:', err.message);
  }
}

export async function syncAgendaStatusToNotion(userId, id, status) {
  if (!isEnabled()) return;
  const notion  = getNotion();
  const pageId  = cache.get(userId, `notion_agenda_${id}`);
  if (!pageId) return;
  try {
    await notion.pages.update({
      page_id:    pageId,
      properties: { Status: { select: { name: status } } },
    });
  } catch (err) {
    console.error('[Notion] agenda status sync failed:', err.message);
  }
}

export async function syncEdgeToNotion(userId, edge) {
  if (!isEnabled()) return;
  const notion = getNotion();
  try {
    const dbId = await edgesDbId(userId);
    const props = {
      Name:     { title: [{ text: { content: `${edge.from_type}:${edge.from_id} → ${edge.relation}` } }] },
      To:       rt(`${edge.to_type}:${edge.to_id}`),
      Relation: { select: { name: edge.relation } },
      Weight:   { number: edge.weight ?? 1.0 },
      Date:     { date: { start: (edge.created_at || new Date().toISOString()).slice(0, 10) } },
    };
    const cached = cache.get(userId, `notion_edge_${edge.id}`);
    if (cached) {
      await notion.pages.update({ page_id: cached, properties: props });
    } else {
      const page = await notion.pages.create({ parent: { database_id: dbId }, properties: props });
      cache.set(userId, `notion_edge_${edge.id}`, page.id);
    }
  } catch (err) {
    console.error('[Notion] edge sync failed:', err.message);
  }
}

// ── Bidirectional pull: Notion → SQLite ───────────────────────────────────────
// Each function reads the Notion DB and writes changed values back to SQLite.
// Uses dynamic import to break the circular dependency (memory.js → notion-memory.js).

// Helpers to extract plain text from Notion property types.
function plainText(prop) {
  if (!prop) return null;
  if (prop.type === 'title')     return prop.title?.[0]?.plain_text || null;
  if (prop.type === 'rich_text') return prop.rich_text?.[0]?.plain_text || null;
  if (prop.type === 'select')    return prop.select?.name || null;
  if (prop.type === 'number')    return prop.number ?? null;
  if (prop.type === 'date')      return prop.date?.start || null;
  return null;
}

export async function pullAgendaFromNotion(userId) {
  if (!isEnabled()) return;
  const notion = getNotion();
  try {
    const dbId = cache.get(userId, 'notion_agenda_db_id');
    if (!dbId) return; // DB not yet created, nothing to pull

    const { results } = await notion.databases.query({ database_id: dbId });
    // Lazy-import memory to avoid circular dep
    const { setAgendaStatus: setStatus, getDb } = await import('./memory.js');
    const db = getDb();

    for (const page of results) {
      const p = page.properties;
      // Find the agenda item id from our cache (reverse lookup)
      const status = plainText(p.Status);
      const priority = plainText(p.Priority);
      // Find the SQLite row this page corresponds to by scanning the cache
      // We stored: notion_agenda_<id> → pageId
      const sqliteId = findCachedSqliteId(userId, 'notion_agenda_', page.id);
      if (!sqliteId) continue;

      // Apply status changes (done/skipped set in Notion flow back)
      if (status && ['done', 'skipped', 'pending'].includes(status)) {
        const row = db.prepare('SELECT status FROM agenda_items WHERE id = ?').get(sqliteId);
        if (row && row.status !== status) {
          setStatus(sqliteId, status);
        }
      }
      // Apply priority changes
      if (priority != null) {
        const pNum = Math.max(1, Math.min(10, Number(priority)));
        db.prepare(`UPDATE agenda_items SET priority = ?, updated_at = datetime('now') WHERE id = ? AND priority != ?`)
          .run(pNum, sqliteId, pNum);
      }
    }
  } catch (err) {
    console.error('[Notion←] agenda pull failed:', err.message);
  }
}

export async function pullGoalsFromNotion(userId) {
  if (!isEnabled()) return;
  const notion = getNotion();
  try {
    const dbId = cache.get(userId, 'notion_goals_db_id');
    if (!dbId) return;

    const { results } = await notion.databases.query({ database_id: dbId });
    const { getDb } = await import('./memory.js');
    const db = getDb();

    for (const page of results) {
      const p = page.properties;
      const sqliteId = findCachedSqliteId(userId, 'notion_goal_', page.id);
      if (!sqliteId) continue;

      const status   = plainText(p.Status);
      const target   = plainText(p.Target);
      const deadline = plainText(p.Deadline);

      const updates = [];
      const vals = [];
      if (status && ['active', 'done', 'cancelled'].includes(status)) {
        updates.push('status = ?'); vals.push(status);
      }
      if (target != null) { updates.push('target = ?'); vals.push(Number(target)); }
      if (deadline)       { updates.push('deadline = ?'); vals.push(deadline); }
      if (updates.length) {
        vals.push(sqliteId);
        db.prepare(`UPDATE goals SET ${updates.join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...vals);
      }
    }
  } catch (err) {
    console.error('[Notion←] goals pull failed:', err.message);
  }
}

export async function pullProfileFromNotion(userId) {
  if (!isEnabled()) return;
  const notion = getNotion();
  try {
    const pageId = cache.get(userId, 'notion_profile_page_id');
    if (!pageId) return;

    const page = await notion.pages.retrieve({ page_id: pageId });
    const p = page.properties;
    const { updateProfile } = await import('./memory.js');

    const fields = {
      business_name: plainText(p.Name),
      industry:      plainText(p.Industry),
      offer:         plainText(p.Offer),
      icp:           plainText(p.ICP),
      brand_voice:   plainText(p['Brand Voice']),
      goals_summary: plainText(p.Goals),
      channels:      plainText(p.Channels),
      constraints:   plainText(p.Constraints),
      monthly_budget: p.Budget?.number ?? null,
    };
    // Only write non-null changes
    const delta = Object.fromEntries(Object.entries(fields).filter(([, v]) => v != null));
    if (Object.keys(delta).length) updateProfile(userId, delta);
  } catch (err) {
    console.error('[Notion←] profile pull failed:', err.message);
  }
}

export async function pullEdgesFromNotion(userId) {
  if (!isEnabled()) return;
  const notion = getNotion();
  try {
    const dbId = cache.get(userId, 'notion_edges_db_id');
    if (!dbId) return;

    const { results } = await notion.databases.query({ database_id: dbId });
    const { getDb } = await import('./memory.js');
    const db = getDb();
    for (const page of results) {
      if (!page.archived) continue;
      const sqliteId = findCachedSqliteId(userId, 'notion_edge_', page.id);
      if (!sqliteId) continue;
      try {
        db.prepare(`DELETE FROM content_edges WHERE id = ?`).run(sqliteId);
        cache.set(userId, `notion_edge_${sqliteId}`, null);
      } catch (_) {}
    }
  } catch (err) {
    console.error('[Notion←] edges pull failed:', err.message);
  }
}

// Reverse-lookup: find the SQLite numeric id for a Notion page id by scanning
// the in-memory cache keys matching the given prefix.
function findCachedSqliteId(userId, prefix, notionPageId) {
  // cache.list(userId) would be ideal, but our cache module only has get/set.
  // We brute-force scan ids 1..9999 — cheap since it's an in-memory Map.
  for (let i = 1; i < 10000; i++) {
    if (cache.get(userId, `${prefix}${i}`) === notionPageId) return i;
  }
  return null;
}

// ── Polling loop ──────────────────────────────────────────────────────────────
// Call this once from index.js after the WhatsApp client is ready.
// Polls every 5 minutes and syncs all known users.

export function startNotionPollLoop(getUserIds, intervalMs = 5 * 60 * 1000) {
  if (!isEnabled()) return;
  setInterval(async () => {
    const ids = getUserIds();
    for (const userId of ids) {
      await pullAgendaFromNotion(userId).catch(() => {});
      await pullGoalsFromNotion(userId).catch(() => {});
      await pullProfileFromNotion(userId).catch(() => {});
      await pullEdgesFromNotion(userId).catch(() => {});
    }
  }, intervalMs);
  console.log('[Notion←] Bidirectional poll loop started (every', intervalMs / 60000, 'min)');
}
