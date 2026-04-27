import Database from 'better-sqlite3';
import { Client as NotionClient } from '@notionhq/client';
import dotenv from 'dotenv';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '.env') });

const notion = new NotionClient({ auth: process.env.NOTION_API_KEY });
const databaseId = process.env.NOTION_NOTES_DB_ID;
const dbPath = join(__dirname, 'data', 'shaul-memory.db');

async function migrate() {
  console.log('Starting migration from SQLite to Notion...');
  const db = new Database(dbPath);
  
  // Get interactions
  const rows = db.prepare('SELECT * FROM interactions ORDER BY created_at ASC').all();
  console.log(`Found ${rows.length} interactions.`);

  for (const row of rows) {
    try {
      console.log(`Migrating interaction ${row.id}...`);
      
      const title = `${row.role}: ${row.agent || 'user'}`.slice(0, 100);
      const content = row.content || '(empty)';
      const timestamp = new Date(row.created_at).toISOString();

      await notion.pages.create({
        parent: { database_id: databaseId },
        properties: {
          'Name': {
            title: [
              {
                text: {
                  content: title,
                },
              },
            ],
          },
          'Content': {
            rich_text: [
              {
                text: {
                  content: content.slice(0, 2000), // Notion limit
                },
              },
            ],
          },
          'Type': {
            select: {
              name: 'interaction',
            },
          },
          'Created': {
            date: {
              start: timestamp,
            },
          },
          'Tags': {
            multi_select: [
              { name: row.role },
              { name: row.agent || 'user' }
            ],
          },
        },
      });
      console.log(`✅ Migrated interaction ${row.id}`);
    } catch (err) {
      console.error(`❌ Failed to migrate interaction ${row.id}:`, err.message);
    }
  }

  // Also migrate learned_insights
  const insights = db.prepare('SELECT * FROM learned_insights').all();
  console.log(`Found ${insights.length} learned insights.`);

  for (const row of insights) {
    try {
      console.log(`Migrating insight ${row.id}...`);
      
      await notion.pages.create({
        parent: { database_id: databaseId },
        properties: {
          'Name': {
            title: [
              {
                text: {
                  content: `Insight: ${row.topic}`,
                },
              },
            ],
          },
          'Content': {
            rich_text: [
              {
                text: {
                  content: row.insight.slice(0, 2000),
                },
              },
            ],
          },
          'Type': {
            select: {
              name: 'insight',
            },
          },
          'Created': {
            date: {
              start: new Date(row.created_at).toISOString(),
            },
          },
          'Tags': {
            multi_select: [
              { name: 'insight' },
              { name: row.topic }
            ],
          },
        },
      });
      console.log(`✅ Migrated insight ${row.id}`);
    } catch (err) {
      console.error(`❌ Failed to migrate insight ${row.id}:`, err.message);
    }
  }

  console.log('Migration complete!');
  db.close();
}

migrate().catch(console.error);
