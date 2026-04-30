// Layer 2 — Core memory block.
//
// Always injected into every Mentor reply (~1 KB). Contains only what the
// model genuinely needs on every turn:
//   - Business identity facts (profile essentials)
//   - Top 3 active goals
//   - Up to 3 agenda items that pass the anti-nag filter
//   - Last reflection one-liner
//   - Pinned facts (from marketing_memory "pin:*" keys)
//
// Anti-nag filter (in memory.js listEligibleAgenda):
//   - Cooldown: 24h × 2^nudge_count (caps at 384h / 16 days)
//   - Staleness decay: salience = 0.5^(age_days/7) × priority/10; drop < 0.1
//   - Topic gate: if currentTopic is known and item.topic doesn't match, suppress
//
// Usage: import { buildCoreMemoryBlock } from './coreMemory.js'

import {
  getProfile, listGoals, recentReflections,
  listEligibleAgenda, getMemory,
} from './memory.js';

// Fast topic slug from the user's latest message — pure string heuristic,
// no Gemini call, so it never adds latency. Matches against known topic keywords.
const TOPIC_PATTERNS = [
  { slug: 'campaign',    re: /קמפיין|campaign/i },
  { slug: 'post_ig',     re: /פוסט.*אינסטגרם|instagram.*post|ig/i },
  { slug: 'post_fb',     re: /פוסט.*פייסבוק|facebook.*post|fb/i },
  { slug: 'canva',       re: /קנבה|canva/i },
  { slug: 'invoice',     re: /חשבונית|חשבון|invoice/i },
  { slug: 'calendar',    re: /יומן|פגישה|calendar|meeting/i },
  { slug: 'insights',    re: /מדדים|ביצועים|insights|metrics/i },
  { slug: 'attendance',  re: /כמה היו|משתתפים|attendance/i },
  { slug: 'email',       re: /מייל|email/i },
  { slug: 'budget',      re: /תקציב|budget/i },
];

export function detectTopic(userMessage) {
  if (!userMessage) return null;
  for (const { slug, re } of TOPIC_PATTERNS) {
    if (re.test(userMessage)) return slug;
  }
  return null;
}

export function buildCoreMemoryBlock(userId, { currentUserMessage = '' } = {}) {
  const currentTopic = detectTopic(currentUserMessage);
  const lines = [];

  // ── Business profile essentials ──────────────────────────────────────────
  const profile = getProfile(userId);
  if (profile) {
    lines.push('## BUSINESS PROFILE');
    const essentials = [
      ['business_name', 'שם'],
      ['industry',      'תחום'],
      ['offer',         'מה מוכרים'],
      ['icp',           'קהל יעד'],
      ['brand_voice',   'סגנון מותג'],
      ['channels',      'ערוצים'],
    ];
    for (const [key, label] of essentials) {
      if (profile[key]) lines.push(`- ${label}: ${profile[key]}`);
    }
  }

  // ── Active goals (top 3) ──────────────────────────────────────────────────
  const goals = listGoals(userId, 'active').slice(0, 3);
  if (goals.length) {
    lines.push('\n## ACTIVE GOALS');
    for (const g of goals) {
      const deadline = g.deadline ? ` (עד ${g.deadline})` : '';
      const target   = g.target   ? ` — יעד: ${g.target} ${g.metric || ''}` : '';
      lines.push(`- ${g.title}${target}${deadline}`);
    }
  }

  // ── Pinned facts (user/Shaul-pinned key insights) ─────────────────────────
  // Keys stored as "pin:<label>" in marketing_memory
  const pinnedRaw = getMemory(userId, '_pinned_facts');
  if (pinnedRaw) {
    try {
      const pins = JSON.parse(pinnedRaw);
      if (Object.keys(pins).length) {
        lines.push('\n## PINNED FACTS');
        for (const [k, v] of Object.entries(pins)) {
          lines.push(`- ${k}: ${v}`);
        }
      }
    } catch (_) {}
  }

  // ── Eligible agenda items (anti-nag filtered) ─────────────────────────────
  const agenda = listEligibleAgenda(userId, currentTopic, 3);
  if (agenda.length) {
    lines.push('\n## PENDING WORK (proposed by Shaul, awaiting your go-ahead)');
    for (const a of agenda) {
      const due = a.due_at ? ` — due ${a.due_at}` : '';
      lines.push(`- [id:${a.id}] ${a.title}${due}`);
    }
    lines.push('_To defer: "תעזוב את <כותרת>" / "snooze <id>" — To skip: "בטל <id>"_');
  }

  // ── Last reflection one-liner ─────────────────────────────────────────────
  const ref = recentReflections(userId, 1)[0];
  if (ref?.summary) {
    lines.push(`\n## LAST REFLECTION\n${ref.summary.slice(0, 200)}`);
  }

  return lines.join('\n');
}
