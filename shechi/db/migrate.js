import fs from 'node:fs';
import path from 'node:path';
import { db } from '../src/db/client.js';

const SCHEMA_PATH = path.resolve('db/schema.sql');
const sql = fs.readFileSync(SCHEMA_PATH, 'utf8');

db.exec(sql);

const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all()
  .map(r => r.name);

console.log(`migrated. tables: ${tables.join(', ')}`);
