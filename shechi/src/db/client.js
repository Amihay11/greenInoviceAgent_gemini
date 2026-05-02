import Database from 'better-sqlite3';
import path from 'node:path';
import 'dotenv/config';

const DB_PATH = process.env.SHECHI_DB_PATH || path.resolve('shechi.db');

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export function close() {
  db.close();
}
