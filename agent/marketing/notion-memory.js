// Notion write-through layer for human-readable memory.
//
// Syncs 4 tables to Notion databases under NOTION_MEMORY_PARENT_PAGE_ID:
//   business_profile  → "🏢 פרופיל עסקי"   (single row, updated in place)
//   learned_insights  → "💡 תובנות שאול"    (one page per insight)
//   goals             → "🎯 מטרות עסקיות"   (one page per goal)
//   agenda_items      → "📋 אג׳נדה שאול"    (one page per item, status synced)
//
// All writes are fire-and-forget — a Notion failure never blocks the agent.
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
