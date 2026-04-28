// One-time setup: creates the 4 Shaul memory databases in Notion.
// Run: node agent/scripts/setup-notion-memory.js

import { Client } from '@notionhq/client';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '..', '.env') });

const NOTION_API_KEY            = process.env.NOTION_API_KEY;
const NOTION_MEMORY_PARENT_PAGE_ID = process.env.NOTION_MEMORY_PARENT_PAGE_ID
  || '350707672293809b95d0fac5a010d867';

if (!NOTION_API_KEY) {
  console.error('❌  NOTION_API_KEY is missing from .env');
  process.exit(1);
}

const notion = new Client({ auth: NOTION_API_KEY });

// ── Database schemas ──────────────────────────────────────────────────────────

const DATABASES = [
  {
    title: '🏢 פרופיל עסקי',
    description: 'הפרופיל העסקי שאול מחזיק עליך — מתעדכן אוטומטית.',
    properties: {
      Name:          { title: {} },
      Industry:      { rich_text: {} },
      Offer:         { rich_text: {} },
      ICP:           { rich_text: {} },
      'Brand Voice': { rich_text: {} },
      Goals:         { rich_text: {} },
      Budget:        { number: { format: 'shekel' } },
      Channels:      { rich_text: {} },
      Constraints:   { rich_text: {} },
    },
  },
  {
    title: '💡 תובנות שאול',
    description: 'תובנות שחולצו מהשיחות — עודכנות אוטומטית.',
    properties: {
      Name:       { title: {} },
      Topic:      { select: { options: [] } },
      Confidence: { number: { format: 'number' } },
      Source:     { rich_text: {} },
      Date:       { date: {} },
    },
  },
  {
    title: '🎯 מטרות עסקיות',
    description: 'המטרות שהגדרת לשאול — מתעדכנות אוטומטית.',
    properties: {
      Name:     { title: {} },
      Metric:   { rich_text: {} },
      Target:   { number: { format: 'number' } },
      Deadline: { date: {} },
      Status:   {
        select: {
          options: [
            { name: 'active',    color: 'green' },
            { name: 'done',      color: 'blue'  },
            { name: 'cancelled', color: 'gray'  },
          ],
        },
      },
    },
  },
  {
    title: '📋 אג׳נדה שאול',
    description: 'מה שאול מתכנן לעשות עבורך — מתעדכן אוטומטית.',
    properties: {
      Name:     { title: {} },
      Detail:   { rich_text: {} },
      Kind:     { select: { options: [] } },
      Priority: { number: { format: 'number' } },
      Status:   {
        select: {
          options: [
            { name: 'pending', color: 'yellow' },
            { name: 'done',    color: 'green'  },
            { name: 'skipped', color: 'gray'   },
          ],
        },
      },
      Due: { date: {} },
    },
  },
];

// ── Create ────────────────────────────────────────────────────────────────────

async function createDatabase({ title, description, properties }) {
  const db = await notion.databases.create({
    parent: { type: 'page_id', page_id: NOTION_MEMORY_PARENT_PAGE_ID },
    title: [{ type: 'text', text: { content: title } }],
    description: [{ type: 'text', text: { content: description } }],
    properties,
  });
  return db.id;
}

async function main() {
  console.log(`\n🔧  יוצר מסדי נתונים תחת עמוד: ${NOTION_MEMORY_PARENT_PAGE_ID}\n`);

  const results = {};

  for (const schema of DATABASES) {
    process.stdout.write(`  → ${schema.title} ... `);
    try {
      const id = await createDatabase(schema);
      results[schema.title] = id;
      console.log(`✅  ${id}`);
    } catch (err) {
      console.log(`❌  ${err.message}`);
    }
  }

  console.log('\n✅  סיום! הוסף לקובץ .env שלך:\n');
  console.log(`NOTION_MEMORY_PARENT_PAGE_ID=${NOTION_MEMORY_PARENT_PAGE_ID}`);
  console.log('\nשאול יחפש ויחבר את מסדי הנתונים אוטומטית בהרצה הבאה.');
  console.log('');
}

main().catch(err => {
  console.error('שגיאה:', err.message);
  process.exit(1);
});
