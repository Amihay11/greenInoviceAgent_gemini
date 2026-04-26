// CMO — the orchestrator. Routes user requests to the right sub-agent,
// handles approval gates, and exposes a single entry point for the WhatsApp router.
//
// Architecture (Anthropic orchestrator-worker pattern):
//   user → CMO → { Strategist | Creative | Campaign Manager | Publisher | Analyst | Mentor }
//   CMO holds the conversation. Sub-agents return STRUCTURED data.
//   CMO turns structured data into Hebrew Shaul-voice messages for WhatsApp.
//
// Approval gates: every action that posts to FB/IG, spends money, or commits a
// large plan goes through pendingApprovals. Nothing fires without the user
// typing "אישור" / "כן" / "1".

import {
  getProfile, ensureProfile, updateProfile, logInteraction,
  createCampaign, listCampaigns, setCampaignStatus,
  createCreative, getCreative, listCreatives, setCreativeStatus,
  createPost, getPost, listPosts, setPostStatus, dueScheduledPosts,
  recentInsights, listGoals, addGoal,
  addInsight, upsertEntity, logAttendance, recentAttendance,
  listAgenda, addAgendaItem, setAgendaStatus,
  buildContextBundle, formatContextForPrompt,
} from './memory.js';
import * as strategist from './subagents/strategist.js';
import * as creative from './subagents/creative.js';
import * as campaignMgr from './subagents/campaignManager.js';
import * as publisher from './subagents/publisher.js';
import * as analyst from './subagents/analyst.js';
import * as mentor from './subagents/mentor.js';
import * as director from './subagents/director.js';
import * as meta from './meta.js';

// In-memory pending approvals: chatId → { kind, payload, expiresAt }
const pendingApprovals = new Map();
// Active onboarding sessions: chatId → true
const onboardingActive = new Set();

const APPROVAL_TTL_MS = 10 * 60 * 1000; // 10 minutes

function setPending(chatId, kind, payload) {
  pendingApprovals.set(chatId, { kind, payload, expiresAt: Date.now() + APPROVAL_TTL_MS });
}

function takePending(chatId) {
  const p = pendingApprovals.get(chatId);
  if (!p) return null;
  if (Date.now() > p.expiresAt) {
    pendingApprovals.delete(chatId);
    return null;
  }
  pendingApprovals.delete(chatId);
  return p;
}

const APPROVE_RE = /^(אישור|כן|approve|yes|y|1|אשר)$/i;
const REJECT_RE  = /^(לא|בטל|no|cancel|n|2)$/i;

// ── Public entry: handle a marketing-related message ─────────────────────────

const GO_RE = /^(יאללה|קדימה|תעבוד|תתחיל|go|do it|let's go|ok do)$/i;

export async function handleMarketingMessage({ chatId, text, ai, modelName }) {
  const userId = chatId;
  ensureProfile(userId);
  logInteraction({ userId, role: 'user', channel: 'whatsapp', content: text });

  // 1) If user is in onboarding, route there.
  if (onboardingActive.has(chatId)) {
    return handleOnboardingAnswer({ chatId, text, ai, modelName });
  }

  // 2) Approval gate.
  if (pendingApprovals.has(chatId)) {
    if (APPROVE_RE.test(text.trim())) {
      const p = takePending(chatId);
      return executeApproved(p, { chatId, ai, modelName });
    }
    if (REJECT_RE.test(text.trim())) {
      takePending(chatId);
      return reply(userId, '👍 בוטל. שלח לי משהו אחר.');
    }
    // Anything else: drop the pending and treat as a new message.
    takePending(chatId);
  }

  // 3) Explicit mk-commands.
  const mkMatch = text.trim().match(/^mk\s+(\S+)\s*(.*)$/i);
  if (mkMatch) {
    return handleMkCommand({ chatId, sub: mkMatch[1].toLowerCase(), arg: mkMatch[2], ai, modelName });
  }

  // 4) "Go" — execute the top agenda item without further chat.
  if (GO_RE.test(text.trim())) {
    return executeTopAgenda({ chatId, ai, modelName });
  }

  // 5) Free text → Mentor replies in Shaul's voice. Silent extraction runs in
  //    parallel so profile/goals/attendance update without bothering the user.
  const replyText = await mentor.mentorReply({ userId, userMessage: text, ai, modelName });
  const finalReply = reply(userId, replyText);

  // Fire-and-forget background work: extract structured data + refresh agenda.
  silentExtraction({ userId, userMessage: text, ai, modelName })
    .catch(err => console.error('[CMO] silent extraction failed:', err.message));

  return finalReply;
}

// Silent extraction — every free-text turn, the Strategist mines structured
// data from the user's message and persists profile updates, insights, goals,
// entities, and attendance reports. Then the Director refreshes the agenda.
async function silentExtraction({ userId, userMessage, ai, modelName }) {
  const result = await strategist.proposeProfileUpdates({ userId, userMessage, ai, modelName });
  if (!result) return;

  if (result.updates && Object.keys(result.updates).length > 0) {
    updateProfile(userId, result.updates);
  }
  for (const ins of (result.new_insights || [])) {
    if (ins?.topic && ins?.insight) {
      addInsight({
        userId, topic: ins.topic, insight: ins.insight,
        confidence: ins.confidence ?? 0.6, source: 'conversation',
      });
    }
  }
  for (const g of (result.new_goals || [])) {
    if (g?.title) {
      addGoal({
        userId, title: g.title, metric: g.metric || null,
        target: g.target ?? null, deadline: g.deadline || null,
      });
    }
  }
  for (const e of (result.entities || [])) {
    if (e?.kind && e?.name) {
      upsertEntity({ userId, kind: e.kind, name: e.name, details: e.details || null });
    }
  }
  if (result.attendance && typeof result.attendance.headcount === 'number') {
    logAttendance({
      userId,
      session_label: result.attendance.session_label || 'session',
      session_date: result.attendance.session_date || null,
      headcount: result.attendance.headcount,
      revenue: result.attendance.revenue ?? null,
      notes: result.attendance.notes || null,
    });
  }

  // After extraction, refresh the agenda so Director surfaces new actions.
  try { await director.refreshAgenda({ userId, ai, modelName }); } catch (_) {}
}

// ── mk subcommands ───────────────────────────────────────────────────────────

async function handleMkCommand({ chatId, sub, arg, ai, modelName }) {
  const userId = chatId;
  switch (sub) {
    case 'onboard':    return startOnboarding({ chatId });
    case 'discovery':  return discoveryFlow({ chatId, ai, modelName });
    case 'plan':       return planFlow({ chatId, goal: arg, ai, modelName });
    case 'post':       return postFlow({ chatId, brief: arg, platform: 'instagram', ai, modelName });
    case 'fb':         return postFlow({ chatId, brief: arg, platform: 'facebook', ai, modelName });
    case 'ig':         return postFlow({ chatId, brief: arg, platform: 'instagram', ai, modelName });
    case 'schedule':   return showSchedule({ userId });
    case 'calendar':   return showCalendar({ userId });
    case 'report':     return reportFlow({ userId, ai, modelName });
    case 'memory':     return showMemory({ userId });
    case 'reflect':    return reflectFlow({ userId, ai, modelName });
    case 'campaigns':  return showCampaigns({ userId });
    case 'agenda':     return showAgenda({ userId, ai, modelName });
    case 'briefing':   return briefingFlow({ chatId, ai, modelName });
    case 'attendance': return attendanceCommand({ chatId, arg, ai, modelName });
    case 'go':         return executeTopAgenda({ chatId, ai, modelName });
    case 'skip':       return skipTopAgenda({ userId, arg });
    case 'publish':    return publishCommand({ userId, arg });
    case 'help':       return reply(userId, MK_HELP);
    default:           return reply(userId, `לא מכיר את ${sub}. נסה: ${MK_HELP}`);
  }
}

// Dynamic discovery — Director picks the next-best question based on what's
// missing. Replaces the hardcoded mk onboard form for users who prefer a
// conversational style.
async function discoveryFlow({ chatId, ai, modelName }) {
  const userId = chatId;
  const next = await strategist.nextDiscoveryQuestion({ userId, ai, modelName });
  if (!next || next.topic === 'done') {
    return reply(userId, '👍 יש לי כבר מספיק להתחיל לעבוד. שלח "mk go" כדי שאתחיל בפעולה הראשונה, או "mk agenda" כדי לראות מה בתור.');
  }
  return reply(userId, `${next.question}\n\n_(שלח "mk discovery" אחרי שתענה כדי שאשאל את הבא.)_`);
}

// Show the agenda — Shaul's todo list FOR the user.
async function showAgenda({ userId, ai, modelName }) {
  let items = listAgenda(userId, 'pending', 10);
  if (items.length === 0) {
    // Build one on demand if empty.
    try { await director.refreshAgenda({ userId, ai, modelName }); } catch (_) {}
    items = listAgenda(userId, 'pending', 10);
  }
  if (items.length === 0) {
    return reply(userId, '📋 אג׳נדה ריקה. תספר לי קצת על העסק ואני אבנה רשימה.');
  }
  const lines = ['📋 *מה אני מתכוון לעשות בשבילך:*', ''];
  items.forEach((a, i) => {
    lines.push(`${i + 1}. *${a.title}*${a.due_at ? ` _(עד ${a.due_at})_` : ''}`);
    if (a.detail) lines.push(`   ${a.detail}`);
  });
  lines.push('');
  lines.push('_שלח *mk go* כדי שאתחיל מהראשון. *mk skip* כדי לדלג._');
  return reply(userId, lines.join('\n'));
}

// "Go" — execute the top pending agenda item by dispatching the right sub-agent.
async function executeTopAgenda({ chatId, ai, modelName }) {
  const userId = chatId;
  const top = director.topPendingAgendaItem(userId);
  if (!top) {
    // If nothing is queued, build the agenda first.
    try { await director.refreshAgenda({ userId, ai, modelName }); } catch (_) {}
    const after = director.topPendingAgendaItem(userId);
    if (!after) return reply(userId, '📭 אין כרגע מה לעשות. תן לי קצת מידע על העסק ונתחיל.');
    return executeAgendaItem({ chatId, item: after, ai, modelName });
  }
  return executeAgendaItem({ chatId, item: top, ai, modelName });
}

async function executeAgendaItem({ chatId, item, ai, modelName }) {
  const userId = chatId;
  await reply(userId, `🚀 מתחיל: *${item.title}*`);

  try {
    switch (item.kind) {
      case 'draft_post': {
        const out = await postFlow({ chatId, brief: item.detail || item.title, platform: 'instagram', ai, modelName });
        director.markAgendaDone(item.id);
        return out;
      }
      case 'plan_campaign': {
        const out = await planFlow({ chatId, goal: item.detail || item.title, ai, modelName });
        director.markAgendaDone(item.id);
        return out;
      }
      case 'pull_metrics':
      case 'reflect': {
        const out = await reportFlow({ userId, ai, modelName });
        director.markAgendaDone(item.id);
        return out;
      }
      case 'check_attendance': {
        director.markAgendaDone(item.id);
        return reply(userId, `📊 ${item.detail || 'דווח לי כמה אנשים היו בסדנה האחרונה'}.\nשלח: *mk attendance "סדנת שבת" 12*`);
      }
      case 'probe_user': {
        director.markAgendaDone(item.id);
        return reply(userId, `❓ ${item.detail || item.title}`);
      }
      case 'draft_calendar': {
        const out = await planFlow({ chatId, goal: `לוח תוכן ל-30 ימים: ${item.detail || ''}`, ai, modelName });
        director.markAgendaDone(item.id);
        return out;
      }
      default: {
        director.markAgendaDone(item.id);
        return reply(userId, `✅ סימנתי כבוצע: ${item.title}\n_(לא ידעתי איך להפעיל את הכלי הזה אוטומטית — תגיד לי מה לעשות.)_`);
      }
    }
  } catch (err) {
    console.error('[CMO] executeAgendaItem error:', err);
    return reply(userId, `❌ נתקלתי בבעיה: ${err.message}`);
  }
}

function skipTopAgenda({ userId, arg }) {
  // If an arg is passed, treat it as a post ID to defer (re-arm later).
  const m = (arg || '').trim().match(/^(\d+)$/);
  if (m) {
    const postId = parseInt(m[1], 10);
    const post = getPost(postId);
    if (post && post.user_id === userId) {
      setPostStatus(postId, 'pending_approval');
      return reply(userId, `⏭ פוסט #${postId} נדחה. שלח *mk publish ${postId}* כשתרצה להעלות.`);
    }
  }
  const top = director.topPendingAgendaItem(userId);
  if (!top) return reply(userId, '📭 אין מה לדלג.');
  director.markAgendaSkipped(top.id);
  return reply(userId, `⏭ דילגתי על "${top.title}". *mk go* לפעולה הבאה.`);
}

// "mk publish 42" — user explicitly approves a scheduled or queued post.
async function publishCommand({ userId, arg }) {
  const m = (arg || '').trim().match(/^(\d+)$/);
  if (!m) return reply(userId, 'פורמט: *mk publish <מספר>* (ראה את המספר ב-mk schedule)');
  const postId = parseInt(m[1], 10);
  const post = getPost(postId);
  if (!post || post.user_id !== userId) return reply(userId, `פוסט #${postId} לא נמצא.`);
  if (!meta.isConfigured()) {
    return reply(userId, '⚠️ Meta API לא מוגדר. הוסף META_PAGE_TOKEN ו-IG_BUSINESS_ID ל-.env.');
  }
  setPostStatus(postId, 'approved');
  await reply(userId, `🚀 שולח את פוסט #${postId} ל-${post.platform}...`);
  try {
    const res = await publisher.publishPost(postId);
    return reply(userId, `✅ פורסם!\n${res.permalink || ''}`);
  } catch (e) {
    return reply(userId, `❌ פרסום נכשל: ${e.message}`);
  }
}

// Manually trigger today's briefing.
async function briefingFlow({ chatId, ai, modelName }) {
  const userId = chatId;
  await reply(userId, '☀️ רגע, מכין תדריך...');
  try { await director.refreshAgenda({ userId, ai, modelName }); } catch (_) {}
  const text = await director.composeDailyBriefing({ userId, ai, modelName });
  return reply(userId, text || 'אין מספיק מידע לתדריך.');
}

// Show 30-day content calendar (existing posts + scheduled).
function showCalendar({ userId }) {
  const all = listPosts(userId).filter(p => ['scheduled', 'pending_approval', 'approved', 'published'].includes(p.status));
  if (all.length === 0) return reply(userId, '📅 לוח התוכן ריק. *mk go* כדי שאתחיל לבנות.');
  const buckets = {};
  for (const p of all) {
    const day = (p.scheduled_at || p.published_at || p.created_at || '').slice(0, 10) || 'ללא תאריך';
    (buckets[day] = buckets[day] || []).push(p);
  }
  const days = Object.keys(buckets).sort();
  const lines = ['📅 *לוח התוכן*', ''];
  for (const d of days.slice(0, 14)) {
    lines.push(`*${d}*`);
    for (const p of buckets[d]) {
      const head = (p.caption || '').split('\n')[0].slice(0, 60);
      lines.push(`  • [${p.platform}/${p.status}] ${head}${head.length === 60 ? '…' : ''}`);
    }
  }
  return reply(userId, lines.join('\n'));
}

// "mk attendance "סדנת שבת" 12" — log workshop headcount.
function attendanceCommand({ chatId, arg, ai, modelName }) {
  const userId = chatId;
  if (!arg || !arg.trim()) {
    const recent = recentAttendance(userId, 6);
    if (recent.length === 0) return reply(userId, '📊 אין נתוני נוכחות.\nשלח: *mk attendance "סדנת שבת" 12*');
    const lines = ['📊 *נוכחות אחרונה:*'];
    for (const a of recent) lines.push(`  • ${a.session_date || a.created_at.slice(0, 10)} ${a.session_label}: ${a.headcount} אנשים${a.revenue ? ` (₪${a.revenue})` : ''}`);
    return reply(userId, lines.join('\n'));
  }
  // Parse: optionally quoted label, then headcount, then optional revenue/notes.
  const m = arg.match(/^"([^"]+)"\s+(\d+)(?:\s+(\d+(?:\.\d+)?))?(?:\s+(.+))?$/)
        || arg.match(/^([^\d]+?)\s+(\d+)(?:\s+(\d+(?:\.\d+)?))?(?:\s+(.+))?$/);
  if (!m) return reply(userId, 'פורמט: *mk attendance "תווית" מספר [הכנסה] [הערה]*\nדוגמה: *mk attendance "סדנת שבת" 12 600 בשמחה*');
  const [, label, count, revenue, notes] = m;
  const today = new Date().toISOString().slice(0, 10);
  logAttendance({
    userId, session_label: label.trim(), session_date: today,
    headcount: parseInt(count, 10),
    revenue: revenue ? parseFloat(revenue) : null,
    notes: notes || null,
  });
  return reply(userId, `📊 רשמתי: *${label.trim()}* — ${count} אנשים${revenue ? `, ₪${revenue}` : ''}.\n*mk report* כדי לראות איך זה מתחבר לשיווק.`);
}

// ── Onboarding ───────────────────────────────────────────────────────────────

async function startOnboarding({ chatId }) {
  const start = await strategist.startOnboarding(chatId);
  onboardingActive.add(chatId);
  const text = `${start.intro}\n\n*שאלה ${start.step}/${start.total}:*\n${start.question}`;
  logInteraction({ userId: chatId, role: 'assistant', agent: 'strategist', content: text });
  return text;
}

async function handleOnboardingAnswer({ chatId, text, ai, modelName }) {
  const result = await strategist.answerOnboarding({ userId: chatId, answer: text, ai, modelName });
  if (result.done) {
    onboardingActive.delete(chatId);
    const msg = result.message || '✅ סיימנו.';
    logInteraction({ userId: chatId, role: 'assistant', agent: 'strategist', content: msg });
    return msg;
  }
  const msg = `${result.saved ? '✅ נרשם.' : '⏭️ דילגתי.'}\n\n*שאלה ${result.step}/${result.total}:*\n${result.nextQuestion}`;
  logInteraction({ userId: chatId, role: 'assistant', agent: 'strategist', content: msg });
  return msg;
}

// ── Campaign planning ────────────────────────────────────────────────────────

async function planFlow({ chatId, goal, ai, modelName }) {
  const userId = chatId;
  if (!goal || goal.trim().length < 3) {
    return reply(userId, 'תכתוב מה המטרה. לדוגמה: "mk plan לקבל 50 לידים בחודש קרוב"');
  }
  await reply(userId, '🧠 רגע, מנהל הקמפיין עובד על תוכנית...');
  const plan = await campaignMgr.planCampaign({ userId, goal, ai, modelName });
  if (!plan) return reply(userId, 'לא הצלחתי לבנות תוכנית. נסה לנסח את המטרה אחרת.');

  const summary = formatCampaignSummary(plan);
  setPending(chatId, 'save_campaign', { plan, goal });
  const msg = `${summary}\n\n_שלח *אישור* כדי לשמור את הקמפיין, או *לא* כדי לבטל._`;
  logInteraction({ userId, role: 'assistant', agent: 'campaign_manager', content: msg, meta: plan });
  return msg;
}

function formatCampaignSummary(p) {
  const channels = (p.channel_mix || []).map(c => `  • ${c.channel} ${c.percent}% — ${c.rationale}`).join('\n');
  const content = (p.content_plan || []).slice(0, 5).map(c => `  • יום ${c.day} • ${c.platform} • ${c.type}: ${c.brief}`).join('\n');
  return `📋 *${p.name}*

🎯 *מטרה:* ${p.objective}
📊 *KPI:* ${p.kpi}
👥 *קהל:* ${p.audience}
💰 *תקציב:* ${p.budget_total} (${p.duration_days} ימים)
📅 ${p.starts_on} → ${p.ends_on}

*ערוצים:*
${channels || '—'}

*תוכן (5 פריטים ראשונים):*
${content || '—'}

⚠️ *סיכון:* ${p.risks || '—'}
🔥 *צעד ראשון:* ${p.first_action || '—'}`;
}

// ── Post drafting ────────────────────────────────────────────────────────────

async function postFlow({ chatId, brief, platform, ai, modelName }) {
  const userId = chatId;
  if (!brief || brief.trim().length < 3) {
    return reply(userId, 'תכתוב על מה הפוסט. לדוגמה: "mk post מבצע 30% על קורס SEO"');
  }
  await reply(userId, `✍️ הקריאייטיב כותב פוסט ל-${platform === 'facebook' ? 'פייסבוק' : 'אינסטגרם'}...`);
  const draft = await creative.draftPost({ userId, brief, platform, ai, modelName });
  if (!draft) return reply(userId, 'לא הצלחתי לכתוב טיוטה. נסה לנסח אחרת.');

  const summary = formatDraftSummary(draft);
  setPending(chatId, 'save_and_publish_post', { draft, platform });
  const msg = `${summary}\n\n_שלח *אישור* כדי לפרסם עכשיו (דורש Meta API), או *לא* כדי לבטל._\n_שלח *שמור* כדי רק לשמור כטיוטה._`;
  logInteraction({ userId, role: 'assistant', agent: 'creative', content: msg, meta: draft });
  return msg;
}

function formatDraftSummary(d) {
  return `🎨 *טיוטה ל-${d.platform}*

*כותרת:*
${d.headline || '—'}

*גוף:*
${d.body || '—'}

*האשטגים:*
${d.hashtags || '—'}

*תיאור תמונה:*
${d.image_brief || '—'}

💡 _${d.rationale || ''}_`;
}

// ── Approval execution ───────────────────────────────────────────────────────

async function executeApproved(pending, { chatId, ai, modelName }) {
  const userId = chatId;
  const { kind, payload } = pending;

  if (kind === 'save_campaign') {
    const { plan } = payload;
    const id = createCampaign({
      userId,
      name: plan.name,
      objective: plan.objective,
      audience: plan.audience,
      budget: plan.budget_total || 0,
      starts_on: plan.starts_on,
      ends_on: plan.ends_on,
      plan_json: plan,
    });
    // Auto-create the first creative as a draft.
    if (plan.content_plan && plan.content_plan[0]) {
      const first = plan.content_plan[0];
      createCreative({
        userId, campaignId: id, kind: first.type,
        body: first.brief, status: 'draft',
      });
    }
    return reply(userId, `✅ קמפיין #${id} נשמר.\nשלב הבא: שלח "mk post <רעיון>" כדי שהקריאייטיב יכתוב את הפוסט הראשון.`);
  }

  if (kind === 'save_and_publish_post') {
    const { draft, platform } = payload;
    const creativeId = createCreative({
      userId,
      kind: 'post',
      headline: draft.headline,
      body: draft.body,
      hashtags: draft.hashtags,
      image_brief: draft.image_brief,
      status: 'approved',
    });
    const caption = `${draft.headline ? draft.headline + '\n\n' : ''}${draft.body || ''}\n\n${draft.hashtags || ''}`.trim();
    const postId = createPost({
      userId, creativeId, platform, caption, image_url: draft.image_url || null,
      status: 'approved',
    });

    if (!meta.isConfigured()) {
      setPostStatus(postId, 'pending_approval');
      return reply(userId, `💾 הפוסט נשמר (#${postId}) אבל Meta API לא מוגדר — לא פרסמתי.\nהוסף META_PAGE_TOKEN + IG_BUSINESS_ID ל-.env, ואז שלח "mk publish ${postId}".`);
    }
    if (!draft.image_url && platform === 'instagram') {
      setPostStatus(postId, 'pending_image');
      return reply(userId, `💾 שמרתי כפוסט #${postId} אבל אינסטגרם דורש תמונה. שלח את התמונה ונפרסם.\nאו: שלח "mk publish ${postId}" אחרי שתעלה תמונה.`);
    }
    try {
      const res = await publisher.publishPost(postId);
      return reply(userId, `🚀 פורסם!\n${res.permalink || ''}`);
    } catch (e) {
      return reply(userId, `❌ פרסום נכשל: ${e.message}\nהפוסט נשמר כ-failed (#${postId}).`);
    }
  }

  return reply(userId, '🤔 שכחתי על מה דיברנו. תתחיל מחדש.');
}

// ── Other mk commands ────────────────────────────────────────────────────────

function showSchedule({ userId }) {
  const scheduled = listPosts(userId, 'scheduled');
  const pending = listPosts(userId, 'pending_approval');
  const lines = ['📅 *פוסטים מתוזמנים:*'];
  if (scheduled.length === 0) lines.push('  אין.');
  for (const p of scheduled) lines.push(`  • #${p.id} ${p.platform} • ${p.scheduled_at} • ${(p.caption || '').slice(0, 40)}...`);
  if (pending.length > 0) {
    lines.push('\n⏳ *מחכים לאישור:*');
    for (const p of pending) lines.push(`  • #${p.id} ${p.platform} • ${(p.caption || '').slice(0, 40)}...`);
  }
  return reply(userId, lines.join('\n'));
}

async function reportFlow({ userId, ai, modelName }) {
  await reply(userId, '📊 רגע, האנליסט מושך נתונים...');
  if (meta.isConfigured()) {
    try { await analyst.pullDailyInsights({ userId }); } catch (_) {}
  }
  const report = await analyst.weeklyReport({ userId, ai, modelName });
  if (!report) return reply(userId, 'אין מספיק נתונים לדוח.');
  const msg = `📊 *${report.headline}*

✅ *מה עובד:*
${(report.highlights || []).map(h => `  • ${h}`).join('\n') || '  —'}

⚠️ *דאגות:*
${(report.concerns || []).map(c => `  • ${c}`).join('\n') || '  —'}

🔥 *הפוקוס לשבוע הקרוב:*
${report.this_week_focus || '—'}${report.have_enough_data === false ? '\n\n_(שים לב: אין מספיק נתונים — הדוח חלקי)_' : ''}`;
  logInteraction({ userId, role: 'assistant', agent: 'analyst', content: msg, meta: report });
  return msg;
}

function showMemory({ userId }) {
  const ctx = formatContextForPrompt(buildContextBundle(userId));
  return reply(userId, `🧠 *זה מה שאני זוכר עליך:*\n\n${ctx || 'עדיין שום דבר. תתחיל עם "mk onboard".'}\n\n_(גישה מלאה ב-dashboard: http://localhost:3001/memory)_`);
}

async function reflectFlow({ userId, ai, modelName }) {
  await reply(userId, '🤔 רגע, מסתכל על עצמי ומה למדתי עליך...');
  const r = await mentor.reflect({ userId, ai, modelName });
  if (!r) return reply(userId, 'אין מספיק חומר לרפלקציה.');
  const insights = (r.new_insights || []).map(i => `  • [${i.topic}] ${i.insight}`).join('\n');
  return reply(userId, `🪞 *רפלקציה:*\n${r.summary}\n\n*מה אשנה:*\n${r.next_moves}\n\n*תובנות חדשות:*\n${insights || '  —'}`);
}

function showCampaigns({ userId }) {
  const all = listCampaigns(userId);
  if (all.length === 0) return reply(userId, 'אין עדיין קמפיינים. שלח "mk plan <מטרה>".');
  const lines = ['📋 *הקמפיינים שלך:*'];
  for (const c of all.slice(0, 10)) {
    lines.push(`  • #${c.id} *${c.name}* — ${c.status} — ${c.objective || ''}`);
  }
  return reply(userId, lines.join('\n'));
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function reply(userId, text) {
  if (text) logInteraction({ userId, role: 'assistant', agent: 'cmo', content: text });
  return text;
}

const MK_HELP = `📣 *שאול — מחלקת השיווק שלך*

🎯 *מה אני יכול לעשות בשבילך עכשיו:*
  mk go               — אני מתחיל מהדבר הכי חשוב באג'נדה
  mk agenda           — לראות מה אני מתכוון לעשות
  mk briefing         — תדריך עכשווי

🧠 *לימוד עליך:*
  mk discovery        — אני שואל את השאלה הבאה הכי חשובה
  mk onboard          — ראיון מלא (אם אתה מעדיף פורמט)
  mk memory           — מה אני זוכר עליך

🛠 *עבודת שיווק:*
  mk plan <מטרה>      — בונה תוכנית קמפיין
  mk post <רעיון>     — מנסח פוסט לאינסטגרם
  mk fb <רעיון>       — מנסח פוסט לפייסבוק
  mk calendar         — לוח תוכן 14 יום
  mk schedule         — פוסטים בתור
  mk campaigns        — הקמפיינים שלך

📊 *מדידה:*
  mk attendance "תווית" 12  — רושם נוכחות בסדנה
  mk report           — דוח שבועי (שיווק + נוכחות)
  mk reflect          — אני מסיק מסקנות עלייך

_כדי שאעשה משהו: כתוב לי מה אתה צריך, או פשוט "יאללה"._`;

// Export for the WhatsApp scheduler — index.js calls this once a day.
// Returns [{ userId, text }] to send. CMO doesn't have a WhatsApp client
// reference, so the caller is responsible for actually sending the message.
export async function getDailyBriefingsToSend({ ai, modelName }) {
  return director.dailyBriefingsForAll({ ai, modelName });
}

// ── Background loop: nudge user to publish due scheduled posts ──────────────
// Phase 3 rule: NOTHING auto-publishes. User wants final approval on every
// post. When a scheduled post hits its time, mark it "awaiting_final_approval"
// and queue a WhatsApp nudge. The actual publish happens when the user sends
// "mk publish <id>".

export async function processScheduledPosts() {
  const due = dueScheduledPosts();
  const nudges = [];
  for (const p of due) {
    setPostStatus(p.id, 'awaiting_final_approval');
    nudges.push({
      userId: p.user_id,
      text: `⏰ *פוסט #${p.id}* (${p.platform}) הגיע זמנו.\n\n${(p.caption || '').slice(0, 280)}\n\n_שלח *mk publish ${p.id}* כדי להעלות עכשיו, או *mk skip ${p.id}* כדי לדחות._`,
    });
  }
  return nudges;
}
