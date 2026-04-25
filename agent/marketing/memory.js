// Shaul long-term memory — SQLite layer.
//
// Memory model (after CrewAI's 4-tier pattern, adapted for a one-business
// marketing department):
//   business_profile   one row, the canonical brand/ICP/voice. Updated by Strategist + Mentor.
//   interactions       every user turn + agent reply (short-term, paginated)
//   learned_insights   distilled long-term lessons ("user prefers short reels")
//   entities           people, products, competitors mentioned over time
//   campaigns          planned/active/completed marketing campaigns
//   creatives          drafted ad copy / captions / image briefs (with status)
//   posts              actual published or scheduled FB/IG posts
//   insights_daily     daily metric pulls from Meta (reach, CTR, spend, ROAS)
//   goals              what the user is trying to achieve, with target + deadline
//   reflections        Mentor's weekly self-evaluations of what is working
//
// All writes are auditable: created_at + updated_at on every row.
// All tables are exposed read-only in the dashboard at /memory.

import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync, existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DATA_DIR = join(__dirname, '..', 'data');
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = process.env.SHAUL_DB_PATH || join(DATA_DIR, 'shaul-memory.db');

let db;

export function getDb() {
  if (db) return db;
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initSchema(db);
  return db;
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS business_profile (
      user_id           TEXT PRIMARY KEY,
      business_name     TEXT,
      industry          TEXT,
      offer             TEXT,
      icp               TEXT,
      brand_voice       TEXT,
      goals_summary     TEXT,
      monthly_budget    REAL,
      channels          TEXT,
      constraints       TEXT,
      onboarding_done   INTEGER NOT NULL DEFAULT 0,
      onboarding_step   INTEGER NOT NULL DEFAULT 0,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS interactions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     TEXT NOT NULL,
      role        TEXT NOT NULL,
      agent       TEXT,
      channel     TEXT,
      content     TEXT NOT NULL,
      meta        TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_interactions_user_time
      ON interactions(user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS learned_insights (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     TEXT NOT NULL,
      topic       TEXT NOT NULL,
      insight     TEXT NOT NULL,
      confidence  REAL NOT NULL DEFAULT 0.5,
      source      TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_insights_user_topic
      ON learned_insights(user_id, topic);

    CREATE TABLE IF NOT EXISTS entities (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     TEXT NOT NULL,
      kind        TEXT NOT NULL,
      name        TEXT NOT NULL,
      details     TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, kind, name)
    );

    CREATE TABLE IF NOT EXISTS campaigns (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       TEXT NOT NULL,
      name          TEXT NOT NULL,
      objective     TEXT,
      audience      TEXT,
      budget        REAL,
      starts_on     TEXT,
      ends_on       TEXT,
      status        TEXT NOT NULL DEFAULT 'draft',
      plan_json     TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS creatives (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       TEXT NOT NULL,
      campaign_id   INTEGER REFERENCES campaigns(id) ON DELETE SET NULL,
      kind          TEXT NOT NULL,
      headline      TEXT,
      body          TEXT,
      hashtags      TEXT,
      image_brief   TEXT,
      image_url     TEXT,
      status        TEXT NOT NULL DEFAULT 'draft',
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS posts (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id         TEXT NOT NULL,
      creative_id     INTEGER REFERENCES creatives(id) ON DELETE SET NULL,
      platform        TEXT NOT NULL,
      external_id     TEXT,
      permalink       TEXT,
      caption         TEXT,
      image_url       TEXT,
      status          TEXT NOT NULL DEFAULT 'pending_approval',
      scheduled_at    TEXT,
      published_at    TEXT,
      error_message   TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_posts_user_status
      ON posts(user_id, status, scheduled_at);

    CREATE TABLE IF NOT EXISTS insights_daily (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id         TEXT NOT NULL,
      day             TEXT NOT NULL,
      platform        TEXT NOT NULL,
      reach           INTEGER,
      impressions     INTEGER,
      engagements     INTEGER,
      clicks          INTEGER,
      spend           REAL,
      revenue         REAL,
      raw_json        TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, day, platform)
    );

    CREATE TABLE IF NOT EXISTS goals (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     TEXT NOT NULL,
      title       TEXT NOT NULL,
      metric      TEXT,
      target      REAL,
      deadline    TEXT,
      status      TEXT NOT NULL DEFAULT 'active',
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS reflections (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     TEXT NOT NULL,
      period      TEXT NOT NULL,
      summary     TEXT NOT NULL,
      next_moves  TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

// ── business_profile ──────────────────────────────────────────────────────────

export function getProfile(userId) {
  const row = getDb().prepare('SELECT * FROM business_profile WHERE user_id = ?').get(userId);
  return row || null;
}

export function ensureProfile(userId) {
  const existing = getProfile(userId);
  if (existing) return existing;
  getDb().prepare('INSERT INTO business_profile (user_id) VALUES (?)').run(userId);
  return getProfile(userId);
}

export function updateProfile(userId, fields) {
  ensureProfile(userId);
  const allowed = [
    'business_name', 'industry', 'offer', 'icp', 'brand_voice',
    'goals_summary', 'monthly_budget', 'channels', 'constraints',
    'onboarding_done', 'onboarding_step',
  ];
  const sets = [];
  const vals = [];
  for (const k of allowed) {
    if (fields[k] !== undefined) {
      sets.push(`${k} = ?`);
      vals.push(fields[k]);
    }
  }
  if (sets.length === 0) return getProfile(userId);
  sets.push(`updated_at = datetime('now')`);
  vals.push(userId);
  getDb().prepare(`UPDATE business_profile SET ${sets.join(', ')} WHERE user_id = ?`).run(...vals);
  return getProfile(userId);
}

// ── interactions ──────────────────────────────────────────────────────────────

export function logInteraction({ userId, role, agent = null, channel = 'whatsapp', content, meta = null }) {
  getDb().prepare(`
    INSERT INTO interactions (user_id, role, agent, channel, content, meta)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(userId, role, agent, channel, content, meta ? JSON.stringify(meta) : null);
}

export function recentInteractions(userId, limit = 20) {
  return getDb().prepare(`
    SELECT * FROM interactions WHERE user_id = ?
    ORDER BY created_at DESC LIMIT ?
  `).all(userId, limit);
}

// ── learned_insights ──────────────────────────────────────────────────────────

export function addInsight({ userId, topic, insight, confidence = 0.6, source = null }) {
  getDb().prepare(`
    INSERT INTO learned_insights (user_id, topic, insight, confidence, source)
    VALUES (?, ?, ?, ?, ?)
  `).run(userId, topic, insight, confidence, source);
}

export function listInsights(userId, limit = 50) {
  return getDb().prepare(`
    SELECT * FROM learned_insights WHERE user_id = ?
    ORDER BY confidence DESC, updated_at DESC LIMIT ?
  `).all(userId, limit);
}

// ── entities ──────────────────────────────────────────────────────────────────

export function upsertEntity({ userId, kind, name, details = null }) {
  getDb().prepare(`
    INSERT INTO entities (user_id, kind, name, details) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, kind, name) DO UPDATE SET details = excluded.details
  `).run(userId, kind, name, details);
}

export function listEntities(userId, kind = null) {
  if (kind) {
    return getDb().prepare('SELECT * FROM entities WHERE user_id = ? AND kind = ?').all(userId, kind);
  }
  return getDb().prepare('SELECT * FROM entities WHERE user_id = ?').all(userId);
}

// ── campaigns ─────────────────────────────────────────────────────────────────

export function createCampaign({ userId, name, objective, audience, budget, starts_on, ends_on, plan_json = null }) {
  const info = getDb().prepare(`
    INSERT INTO campaigns (user_id, name, objective, audience, budget, starts_on, ends_on, plan_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(userId, name, objective, audience, budget, starts_on, ends_on,
         plan_json ? JSON.stringify(plan_json) : null);
  return info.lastInsertRowid;
}

export function listCampaigns(userId, status = null) {
  const sql = status
    ? 'SELECT * FROM campaigns WHERE user_id = ? AND status = ? ORDER BY created_at DESC'
    : 'SELECT * FROM campaigns WHERE user_id = ? ORDER BY created_at DESC';
  return status ? getDb().prepare(sql).all(userId, status) : getDb().prepare(sql).all(userId);
}

export function setCampaignStatus(id, status) {
  getDb().prepare(`UPDATE campaigns SET status = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(status, id);
}

// ── creatives ─────────────────────────────────────────────────────────────────

export function createCreative({ userId, campaignId = null, kind, headline = null, body = null, hashtags = null, image_brief = null, image_url = null, status = 'draft' }) {
  const info = getDb().prepare(`
    INSERT INTO creatives (user_id, campaign_id, kind, headline, body, hashtags, image_brief, image_url, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(userId, campaignId, kind, headline, body, hashtags, image_brief, image_url, status);
  return info.lastInsertRowid;
}

export function getCreative(id) {
  return getDb().prepare('SELECT * FROM creatives WHERE id = ?').get(id);
}

export function listCreatives(userId, status = null) {
  return status
    ? getDb().prepare('SELECT * FROM creatives WHERE user_id = ? AND status = ? ORDER BY created_at DESC').all(userId, status)
    : getDb().prepare('SELECT * FROM creatives WHERE user_id = ? ORDER BY created_at DESC').all(userId);
}

export function setCreativeStatus(id, status) {
  getDb().prepare(`UPDATE creatives SET status = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(status, id);
}

// ── posts ─────────────────────────────────────────────────────────────────────

export function createPost({ userId, creativeId = null, platform, caption, image_url = null, scheduled_at = null, status = 'pending_approval' }) {
  const info = getDb().prepare(`
    INSERT INTO posts (user_id, creative_id, platform, caption, image_url, scheduled_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(userId, creativeId, platform, caption, image_url, scheduled_at, status);
  return info.lastInsertRowid;
}

export function getPost(id) {
  return getDb().prepare('SELECT * FROM posts WHERE id = ?').get(id);
}

export function listPosts(userId, status = null) {
  return status
    ? getDb().prepare('SELECT * FROM posts WHERE user_id = ? AND status = ? ORDER BY scheduled_at, created_at DESC').all(userId, status)
    : getDb().prepare('SELECT * FROM posts WHERE user_id = ? ORDER BY created_at DESC LIMIT 200').all(userId);
}

export function dueScheduledPosts() {
  return getDb().prepare(`
    SELECT * FROM posts
    WHERE status = 'scheduled' AND scheduled_at IS NOT NULL AND scheduled_at <= datetime('now')
  `).all();
}

export function markPostPublished(id, { external_id, permalink }) {
  getDb().prepare(`
    UPDATE posts SET status = 'published', external_id = ?, permalink = ?,
                    published_at = datetime('now'), error_message = NULL
    WHERE id = ?
  `).run(external_id, permalink, id);
}

export function markPostFailed(id, error_message) {
  getDb().prepare(`
    UPDATE posts SET status = 'failed', error_message = ? WHERE id = ?
  `).run(String(error_message || 'unknown error'), id);
}

export function setPostStatus(id, status) {
  getDb().prepare('UPDATE posts SET status = ? WHERE id = ?').run(status, id);
}

// ── insights_daily ────────────────────────────────────────────────────────────

export function upsertDailyInsight({ userId, day, platform, reach, impressions, engagements, clicks, spend, revenue, raw_json = null }) {
  getDb().prepare(`
    INSERT INTO insights_daily (user_id, day, platform, reach, impressions, engagements, clicks, spend, revenue, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, day, platform) DO UPDATE SET
      reach = excluded.reach,
      impressions = excluded.impressions,
      engagements = excluded.engagements,
      clicks = excluded.clicks,
      spend = excluded.spend,
      revenue = excluded.revenue,
      raw_json = excluded.raw_json
  `).run(userId, day, platform, reach, impressions, engagements, clicks, spend, revenue,
         raw_json ? JSON.stringify(raw_json) : null);
}

export function recentInsights(userId, days = 14) {
  return getDb().prepare(`
    SELECT * FROM insights_daily
    WHERE user_id = ? AND day >= date('now', ?)
    ORDER BY day DESC, platform
  `).all(userId, `-${days} days`);
}

// ── goals ─────────────────────────────────────────────────────────────────────

export function addGoal({ userId, title, metric = null, target = null, deadline = null }) {
  const info = getDb().prepare(`
    INSERT INTO goals (user_id, title, metric, target, deadline) VALUES (?, ?, ?, ?, ?)
  `).run(userId, title, metric, target, deadline);
  return info.lastInsertRowid;
}

export function listGoals(userId, status = 'active') {
  return getDb().prepare('SELECT * FROM goals WHERE user_id = ? AND status = ?').all(userId, status);
}

// ── reflections ───────────────────────────────────────────────────────────────

export function addReflection({ userId, period, summary, next_moves = null }) {
  getDb().prepare(`
    INSERT INTO reflections (user_id, period, summary, next_moves) VALUES (?, ?, ?, ?)
  `).run(userId, period, summary, next_moves);
}

export function recentReflections(userId, limit = 5) {
  return getDb().prepare(`
    SELECT * FROM reflections WHERE user_id = ? ORDER BY created_at DESC LIMIT ?
  `).all(userId, limit);
}

// ── dashboard helpers ─────────────────────────────────────────────────────────

const VIEWABLE_TABLES = [
  'business_profile', 'interactions', 'learned_insights', 'entities',
  'campaigns', 'creatives', 'posts', 'insights_daily', 'goals', 'reflections',
];

export function listTables() {
  return VIEWABLE_TABLES;
}

export function readTable(name, { limit = 200, offset = 0 } = {}) {
  if (!VIEWABLE_TABLES.includes(name)) throw new Error('Table not viewable');
  const rows = getDb().prepare(`SELECT * FROM ${name} ORDER BY rowid DESC LIMIT ? OFFSET ?`).all(limit, offset);
  const total = getDb().prepare(`SELECT COUNT(*) as c FROM ${name}`).get().c;
  return { rows, total, limit, offset };
}

export function deleteRow(name, id) {
  if (!VIEWABLE_TABLES.includes(name)) throw new Error('Table not viewable');
  getDb().prepare(`DELETE FROM ${name} WHERE id = ?`).run(id);
}

// ── compact context for sub-agents ────────────────────────────────────────────

export function buildContextBundle(userId) {
  const profile = getProfile(userId);
  const insights = listInsights(userId, 20);
  const goals = listGoals(userId, 'active');
  const recentCampaigns = listCampaigns(userId).slice(0, 5);
  const lastReflection = recentReflections(userId, 1)[0] || null;
  return { profile, insights, goals, recentCampaigns, lastReflection };
}

export function formatContextForPrompt(bundle) {
  const lines = [];
  if (bundle.profile) {
    lines.push('## BUSINESS PROFILE');
    for (const [k, v] of Object.entries(bundle.profile)) {
      if (v !== null && v !== '' && k !== 'created_at' && k !== 'updated_at' && k !== 'user_id') {
        lines.push(`- ${k}: ${v}`);
      }
    }
  }
  if (bundle.goals && bundle.goals.length) {
    lines.push('\n## ACTIVE GOALS');
    for (const g of bundle.goals) {
      lines.push(`- ${g.title}${g.target ? ` (target ${g.target} ${g.metric || ''})` : ''}${g.deadline ? ` by ${g.deadline}` : ''}`);
    }
  }
  if (bundle.insights && bundle.insights.length) {
    lines.push('\n## LEARNED INSIGHTS (sorted by confidence)');
    for (const i of bundle.insights) {
      lines.push(`- [${i.topic}] ${i.insight} (conf ${i.confidence})`);
    }
  }
  if (bundle.recentCampaigns && bundle.recentCampaigns.length) {
    lines.push('\n## RECENT CAMPAIGNS');
    for (const c of bundle.recentCampaigns) {
      lines.push(`- #${c.id} "${c.name}" — ${c.status} — ${c.objective || ''}`);
    }
  }
  if (bundle.lastReflection) {
    lines.push('\n## LAST REFLECTION');
    lines.push(bundle.lastReflection.summary);
  }
  return lines.join('\n');
}
