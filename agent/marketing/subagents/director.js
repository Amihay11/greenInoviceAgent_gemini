// Director — the head of Shaul's marketing department.
// Runs the proactive engine: looks at all of memory, decides what's most
// important to do for this user RIGHT NOW, and either acts or surfaces it as
// an agenda item the user can approve.
//
// Phase 3 design:
//   - After every user turn, refreshAgenda() updates pending agenda items
//   - Each morning (08:00 local), runDailyBriefing() composes a Hebrew briefing
//     and pushes it to the user proactively
//   - When the user says "יאללה" / "go" / "do it", Director takes the top
//     agenda item and dispatches the right sub-agent to execute

import { buildPrompt, runSubagent } from './common.js';
import {
  getProfile, listAgenda, addAgendaItem, setAgendaStatus, clearStaleAgenda,
  listGoals, listCampaigns, listPosts, recentInsights, recentAttendance,
  recentInteractions, alreadyBriefedToday, logBriefing, listAllUserIds,
  buildContextBundle, formatContextForPrompt,
} from '../memory.js';

// ── Decide what's next ───────────────────────────────────────────────────────

export async function nextBestActions({ userId, ai, modelName, max = 5 }) {
  const profile = getProfile(userId);
  const goals = listGoals(userId, 'active');
  const campaigns = listCampaigns(userId);
  const posts = listPosts(userId);
  const insights = recentInsights(userId, 14);
  const attendance = recentAttendance(userId, 6);

  const today = new Date().toISOString().slice(0, 10);
  const knownFields = profile
    ? Object.entries(profile)
        .filter(([k, v]) => v !== null && v !== '' && !['user_id', 'created_at', 'updated_at', 'onboarding_done', 'onboarding_step'].includes(k))
        .map(([k]) => k)
    : [];

  const prompt = buildPrompt({
    userId,
    role: `You are the Director — Shaul's head of marketing strategy. You take ownership of the user's marketing. You don't wait. You look at what is known and decide the highest-leverage actions Shaul should TAKE next. The user is your boss; you save them time by drafting work for them to approve, not by asking them to do anything.

TODAY'S DATE: ${today}. ALL due_at values MUST be on or after ${today}. Never produce a date in the past.

Rank actions by leverage × urgency. Only emit actions that are CONCRETE and EXECUTABLE this week.

Action kinds Shaul can do:
  - draft_post:    write a post and send for approval (specify platform + brief)
  - plan_campaign: build a full campaign plan
  - pull_metrics:  check FB/IG insights and report
  - check_attendance: ask the user to log workshop headcount for a recent session
  - probe_user:    ask the user one specific question — ONLY if a critical gap blocks work AND the answer is NOT already in the business_profile or goals. Do NOT probe for fields we already know.
  - revise_campaign: a campaign is off-track; suggest changes
  - reflect:       run weekly self-reflection (only if it's been 7+ days)
  - draft_calendar: build a 14- or 30-day content calendar

PROFILE FIELDS ALREADY KNOWN (do NOT probe for these): ${knownFields.join(', ') || '(none)'}
ACTIVE GOALS ALREADY SET: ${goals.length} goal(s) — ${goals.length > 0 ? 'do NOT propose another probe for "what is the goal"' : 'goal probing IS allowed'}.

Prefer drafting and planning over probing. The user said they want Shaul to WORK, not interrogate.`,
    task: `Look at everything in memory. What are the next ${max} highest-leverage moves Shaul should DO this week? Drafting > probing. Today is ${today}.`,
    schemaHint: `{
  "actions": [
    {
      "kind": "draft_post|plan_campaign|pull_metrics|check_attendance|probe_user|revise_campaign|reflect|draft_calendar",
      "title": "short Hebrew title (≤60 chars) — what Shaul will DO",
      "detail": "1-2 sentence specifics on what to draft / which campaign / which question",
      "priority": 1-10,
      "due_at": "YYYY-MM-DD on or after ${today}"|null,
      "execute_immediately": true|false
    }
  ]
}
- priority 1 = drop everything, 10 = nice to have
- execute_immediately = true ONLY for safe actions (draft_post, plan_campaign, pull_metrics, draft_calendar). Anything that needs user input gets execute_immediately = false and goes to the agenda.
- Never propose to publish anything. Drafting and approval are separate.
- Reject your own action if it duplicates a profile field we already know.`,
    extra: `EXTRA SIGNAL:\ntoday: ${today}\nrecent posts (${posts.length}): ${posts.slice(0, 3).map(p => `#${p.id}/${p.platform}/${p.status}`).join(', ')}\nactive campaigns: ${campaigns.filter(c => c.status === 'active').length}\nattendance entries: ${attendance.length}\nactive goals: ${goals.length}\ninsights pulled (14d): ${insights.length}`,
  });

  // Grounded: Director can spot timing opportunities (holidays, school year etc).
  const { json } = await runSubagent({ ai, modelName, prompt, grounded: true });
  return json?.actions || [];
}

// Refresh the agenda: ask Director for next-best actions, dedupe against
// already-pending items, persist new ones.
export async function refreshAgenda({ userId, ai, modelName }) {
  // Garbage-collect stale pending items first.
  clearStaleAgenda(userId, 14);

  // Auto-complete probe_user items whose answer is now in business_profile or goals.
  cleanupStaleProbes(userId);

  const actions = await nextBestActions({ userId, ai, modelName, max: 5 });
  if (!actions.length) return [];

  const existing = listAgenda(userId, 'pending', 50);
  const existingTitles = new Set(existing.map(a => a.title.trim().toLowerCase()));

  const added = [];
  for (const a of actions) {
    if (!a?.title) continue;
    const key = a.title.trim().toLowerCase();
    if (existingTitles.has(key)) continue;
    const id = addAgendaItem({
      userId,
      title: a.title,
      detail: a.detail || null,
      kind: a.kind || 'task',
      priority: Math.max(1, Math.min(10, a.priority || 5)),
      due_at: a.due_at || null,
    });
    added.push({ id, ...a });
  }
  return added;
}

// ── Daily briefing — proactive morning push ─────────────────────────────────

export async function composeDailyBriefing({ userId, ai, modelName }) {
  const ctx = formatContextForPrompt(buildContextBundle(userId));
  const agenda = listAgenda(userId, 'pending', 5);
  const recent = recentInteractions(userId, 6);

  const prompt = `${ctx}

## TODAY'S AGENDA (top 5)
${agenda.map(a => `- [${a.kind}] ${a.title}${a.due_at ? ` (due ${a.due_at})` : ''}`).join('\n') || '— empty —'}

## LAST 6 MESSAGES
${recent.slice().reverse().map(r => `${r.role.toUpperCase()}: ${r.content}`).join('\n') || '— none —'}

## YOUR JOB
You are Shaul, marketing employee. Send the user a SHORT proactive morning briefing in Hebrew.
Format:
  - One-line opener with energy ("בוקר. שלוש דברים על השולחן היום:")
  - 3 bullets: most important things on the agenda, each ending with a verb showing YOU will do it
  - One closing line offering immediate action: "להתחיל עם הראשון? תגיד יאללה ואני זז."
Total length: ≤8 lines. Hebrew. No emoji decoration — function only.

Write it now (the actual message text, no JSON):`;

  const res = await ai.models.generateContent({
    model: modelName,
    contents: [{ parts: [{ text: prompt }] }],
    config: { temperature: 0.5 },
  });
  return (res.text || '').trim();
}

// Called by the daily-briefing scheduler. Returns null if already briefed today
// or if the user hasn't been seen recently (no point briefing strangers).
export async function maybeRunDailyBriefing({ userId, ai, modelName }) {
  if (alreadyBriefedToday(userId)) return null;
  const profile = getProfile(userId);
  if (!profile) return null;

  // Refresh the agenda first so the briefing has something to talk about.
  try { await refreshAgenda({ userId, ai, modelName }); } catch (_) {}

  const text = await composeDailyBriefing({ userId, ai, modelName });
  if (!text) return null;

  logBriefing({ userId, summary: text });
  return text;
}

// Iterate every known user and produce briefings. Caller (cmo.js) sends them
// over WhatsApp.
export async function dailyBriefingsForAll({ ai, modelName }) {
  const ids = listAllUserIds();
  const results = [];
  for (const id of ids) {
    try {
      const text = await maybeRunDailyBriefing({ userId: id, ai, modelName });
      if (text) results.push({ userId: id, text });
    } catch (e) {
      console.error(`[Director] briefing failed for ${id}:`, e.message);
    }
  }
  return results;
}

// ── Pick top item to execute when user says "go" ─────────────────────────────

export function topPendingAgendaItem(userId) {
  const items = listAgenda(userId, 'pending', 1);
  return items[0] || null;
}

export function markAgendaDone(id) {
  setAgendaStatus(id, 'done');
}

export function markAgendaSkipped(id) {
  setAgendaStatus(id, 'skipped');
}

// Cleanup probe_user items whose answer is already in business_profile / goals.
// Looks for keyword matches in the title — pragmatic, not perfect.
function cleanupStaleProbes(userId) {
  const profile = getProfile(userId);
  const goals = listGoals(userId, 'active');
  const items = listAgenda(userId, 'pending', 50).filter(a => a.kind === 'probe_user');
  if (!items.length) return;

  const has = {
    offer:      Boolean(profile?.offer),
    icp:        Boolean(profile?.icp),
    goals:      goals.length > 0,
    budget:     profile?.monthly_budget !== null && profile?.monthly_budget !== undefined,
    voice:      Boolean(profile?.brand_voice),
    channels:   Boolean(profile?.channels),
    constraint: Boolean(profile?.constraints),
  };

  for (const a of items) {
    const t = (a.title + ' ' + (a.detail || '')).toLowerCase();
    let stale = false;
    if (has.offer && /(העסק|מה.*עושה|מה.*מוכר|אונבורדינג)/.test(t)) stale = true;
    if (has.icp && /(קהל.*יעד|לקוח.*אידיאלי|icp|target)/.test(t)) stale = true;
    if (has.goals && /(מטרה|יעד.*רבעון|goal|הגדר.*יעד)/.test(t)) stale = true;
    if (has.budget && /(תקציב|budget)/.test(t)) stale = true;
    if (has.voice && /(טון|סגנון|brand.*voice|voice)/.test(t)) stale = true;
    if (has.channels && /(ערוצי|channel)/.test(t)) stale = true;
    if (has.constraint && /(אסור|constraint|להימנע)/.test(t)) stale = true;
    if (stale) setAgendaStatus(a.id, 'auto_done');
  }
}
