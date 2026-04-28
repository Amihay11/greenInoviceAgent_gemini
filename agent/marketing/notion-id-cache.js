// Standalone SQLite accessor for caching Notion database/page IDs.
// Kept separate from memory.js to avoid circular imports.

import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let _db;
function db() {
  if (_db) return _db;
  const path = process.env.SHAUL_DB_PATH || join(__dirname, '..', 'data', 'shaul-memory.db');
  _db = new Database(path);
  return _db;
}

export function get(userId, key) {
  try {
    const row = db().prepare('SELECT value FROM marketing_memory WHERE user_id = ? AND key = ?').get(userId, key);
    return row?.value || null;
  } catch {
    return null;
  }
}

export function set(userId, key, value) {
  try {
    db().prepare(`
      INSERT INTO marketing_memory (user_id, key, value, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
    `).run(userId, key, value);
  } catch (err) {
    console.error('[notion-id-cache] write failed:', err.message);
  }
}
