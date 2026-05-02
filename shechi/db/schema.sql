-- Shechi (שחי) — multi-tenant schema. Every row is keyed by user_id.

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

-- ─── TENANCY & PROFILES ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  user_id        TEXT PRIMARY KEY,
  display_name   TEXT NOT NULL,
  channel        TEXT NOT NULL,
  locale         TEXT DEFAULT 'en',
  created_at     INTEGER DEFAULT (strftime('%s','now')),
  status         TEXT DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS user_profiles (
  user_id               TEXT PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
  known_domains_json    TEXT NOT NULL DEFAULT '[]',
  custom_rules_json     TEXT NOT NULL DEFAULT '[]',
  preferred_personas    TEXT DEFAULT 'auto',
  voice_default         INTEGER DEFAULT 0,
  updated_at            INTEGER DEFAULT (strftime('%s','now'))
);

-- ─── MEMORY (long-term, summarised by Profiler) ─────────────────────
CREATE TABLE IF NOT EXISTS memory (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,
  content      TEXT NOT NULL,
  salience     REAL DEFAULT 0.5,
  source_msg   TEXT,
  created_at   INTEGER DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_memory_user ON memory(user_id, kind);

-- ─── INSIGHTS (Profiler output: behavioural patterns) ───────────────
CREATE TABLE IF NOT EXISTS insights (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  pattern      TEXT NOT NULL,
  evidence     TEXT,
  confidence   REAL DEFAULT 0.5,
  created_at   INTEGER DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_insights_user ON insights(user_id);

-- ─── SYLLABUS (Tutor mode output) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS syllabus (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  topic        TEXT NOT NULL,
  outline_md   TEXT NOT NULL,
  created_at   INTEGER DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_syllabus_user ON syllabus(user_id, topic);

-- ─── PROGRESS / MASTERY ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS progress (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  topic           TEXT NOT NULL,
  subtopic        TEXT,
  mastery_level   REAL DEFAULT 0.0,
  last_seen       INTEGER DEFAULT (strftime('%s','now')),
  UNIQUE(user_id, topic, subtopic)
);
CREATE INDEX IF NOT EXISTS idx_progress_user ON progress(user_id);

-- ─── PROFILE GAPS (what Shechi knows it does NOT know) ──────────────
CREATE TABLE IF NOT EXISTS profile_gaps (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  gap_kind      TEXT NOT NULL,
  gap_subject   TEXT NOT NULL,
  evidence      TEXT,
  status        TEXT DEFAULT 'open',
  detected_at   INTEGER DEFAULT (strftime('%s','now')),
  resolved_at   INTEGER,
  UNIQUE(user_id, gap_kind, gap_subject)
);
CREATE INDEX IF NOT EXISTS idx_gaps_user_status ON profile_gaps(user_id, status);

-- ─── INTERVIEW SESSIONS (multi-turn Q&A state machine) ──────────────
CREATE TABLE IF NOT EXISTS interview_sessions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  gap_id          INTEGER REFERENCES profile_gaps(id) ON DELETE SET NULL,
  topic           TEXT NOT NULL,
  state           TEXT NOT NULL,
  questions_json  TEXT NOT NULL,
  current_index   INTEGER DEFAULT 0,
  result_summary  TEXT,
  started_at      INTEGER DEFAULT (strftime('%s','now')),
  ended_at        INTEGER
);
CREATE INDEX IF NOT EXISTS idx_interview_user_state ON interview_sessions(user_id, state);

-- ─── EDGE GRAPH (concept relations for Cross-Pollination) ───────────
CREATE TABLE IF NOT EXISTS edge_graph (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  src_concept  TEXT NOT NULL,
  dst_concept  TEXT NOT NULL,
  relation     TEXT NOT NULL,
  weight       REAL DEFAULT 1.0,
  created_at   INTEGER DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_edge_user ON edge_graph(user_id, src_concept);

-- ─── MESSAGE LOG (audit + replay) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  direction    TEXT NOT NULL,
  channel      TEXT NOT NULL,
  is_audio     INTEGER DEFAULT 0,
  body         TEXT,
  intent       TEXT,
  persona      TEXT,
  created_at   INTEGER DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id, created_at);
