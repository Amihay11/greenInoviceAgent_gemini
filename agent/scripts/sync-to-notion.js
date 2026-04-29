// One-shot backfill: reads all existing SQLite memory and pushes it to Notion.
// Run after setting NOTION_API_KEY and NOTION_MEMORY_PARENT_PAGE_ID in agent/.env:
//
//   node agent/scripts/sync-to-notion.js
//
// Safe to re-run — profile is upserted, insights/goals/agenda create new pages
// only for rows that have no cached Notion page ID yet.

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
dotenv.config({ path: join(__dirname, '..', '.env') });

if (!process.env.NOTION_API_KEY) {
  console.error('❌  NOTION_API_KEY is missing from agent/.env');
  process.exit(1);
}
if (!process.env.NOTION_MEMORY_PARENT_PAGE_ID) {
  console.error('❌  NOTION_MEMORY_PARENT_PAGE_ID is missing from agent/.env');
  process.exit(1);
}

// Import memory layer (initialises SQLite + schema)
import {
  listAllUserIds,
  getProfile,
  listInsights,
  listGoals,
  listAgenda,
} from '../marketing/memory.js';

import {
  syncProfileToNotion,
  syncInsightToNotion,
  syncGoalToNotion,
  syncAgendaToNotion,
  isEnabled,
} from '../marketing/notion-memory.js';

import * as cache from '../marketing/notion-id-cache.js';

if (!isEnabled()) {
  console.error('❌  Notion sync is disabled — check NOTION_API_KEY and NOTION_MEMORY_PARENT_PAGE_ID');
  process.exit(1);
}

async function syncUser(userId) {
  console.log(`\n👤  User: ${userId}`);

  // ── Business profile ──────────────────────────────────────────────────────
  const profile = getProfile(userId);
  if (profile && (profile.business_name || profile.industry || profile.offer)) {
    process.stdout.write('  → פרופיל עסקי ... ');
    await syncProfileToNotion(userId, profile);
    console.log('✅');
  } else {
    console.log('  → פרופיל עסקי: ריק, דילוג');
  }

  // ── Insights ──────────────────────────────────────────────────────────────
  const insights = listInsights(userId, 500);
  console.log(`  → תובנות: ${insights.length} רשומות`);
  let synced = 0;
  for (const row of insights) {
    const already = cache.get(userId, `notion_insight_${row.id}`);
    if (already) continue;
    await syncInsightToNotion(userId, {
      id:         row.id,
      topic:      row.topic,
      insight:    row.insight,
      confidence: row.confidence,
      source:     row.source,
      created_at: row.created_at,
    });
    synced++;
  }
  if (synced) console.log(`     ✅  ${synced} תובנות חדשות נשלחו ל-Notion`);

  // ── Goals ─────────────────────────────────────────────────────────────────
  const goals = [
    ...listGoals(userId, 'active'),
    ...listGoals(userId, 'done'),
    ...listGoals(userId, 'cancelled'),
  ];
  console.log(`  → מטרות: ${goals.length} רשומות`);
  let gSynced = 0;
  for (const row of goals) {
    const already = cache.get(userId, `notion_goal_${row.id}`);
    if (already) continue;
    await syncGoalToNotion(userId, {
      id:       row.id,
      title:    row.title,
      metric:   row.metric,
      target:   row.target,
      deadline: row.deadline,
      status:   row.status,
    });
    gSynced++;
  }
  if (gSynced) console.log(`     ✅  ${gSynced} מטרות חדשות נשלחו ל-Notion`);

  // ── Agenda items ──────────────────────────────────────────────────────────
  const agenda = [
    ...listAgenda(userId, 'pending', 500),
    ...listAgenda(userId, 'done',    500),
    ...listAgenda(userId, 'skipped', 500),
  ];
  console.log(`  → אג׳נדה: ${agenda.length} רשומות`);
  let aSynced = 0;
  for (const row of agenda) {
    const already = cache.get(userId, `notion_agenda_${row.id}`);
    if (already) continue;
    await syncAgendaToNotion(userId, {
      id:       row.id,
      title:    row.title,
      detail:   row.detail,
      kind:     row.kind,
      priority: row.priority,
      due_at:   row.due_at,
      status:   row.status,
    });
    aSynced++;
  }
  if (aSynced) console.log(`     ✅  ${aSynced} פריטי אג׳נדה חדשים נשלחו ל-Notion`);
}

async function main() {
  const userIds = listAllUserIds();

  if (userIds.length === 0) {
    console.log('⚠️  אין משתמשים בבסיס הנתונים. לא קיים מה לסנכרן.');
    console.log('   הנתונים ייכתבו ל-Notion בזמן אמת ברגע שהסוכן יתחיל לקבל הודעות.');
    return;
  }

  console.log(`\n🔄  מסנכרן ${userIds.length} משתמש/ים ל-Notion...\n`);
  for (const userId of userIds) {
    try {
      await syncUser(userId);
    } catch (err) {
      console.error(`  ❌  שגיאה עבור ${userId}:`, err.message);
    }
  }
  console.log('\n✅  סיום סנכרון!\n');
}

main().catch(err => {
  console.error('שגיאה:', err.message);
  process.exit(1);
});
