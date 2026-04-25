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
  getProfile, ensureProfile, logInteraction,
  createCampaign, listCampaigns, setCampaignStatus,
  createCreative, getCreative, listCreatives, setCreativeStatus,
  createPost, getPost, listPosts, setPostStatus, dueScheduledPosts,
  recentInsights, listGoals, addGoal,
  buildContextBundle, formatContextForPrompt,
} from './memory.js';
import * as strategist from './subagents/strategist.js';
import * as creative from './subagents/creative.js';
import * as campaignMgr from './subagents/campaignManager.js';
import * as publisher from './subagents/publisher.js';
import * as analyst from './subagents/analyst.js';
import * as mentor from './subagents/mentor.js';
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

  // 4) Free text → check if onboarding needed, else mentor reply.
  const profile = getProfile(userId);
  if (!profile?.onboarding_done) {
    return reply(userId, '⏳ אני שאול. לפני שנתחיל לעבוד יחד, אני רוצה להכיר אותך. שלח "mk onboard" כדי להתחיל ראיון קצר (כ-9 שאלות).');
  }
  const replyText = await mentor.mentorReply({ userId, userMessage: text, ai, modelName });
  return reply(userId, replyText);
}

// ── mk subcommands ───────────────────────────────────────────────────────────

async function handleMkCommand({ chatId, sub, arg, ai, modelName }) {
  const userId = chatId;
  switch (sub) {
    case 'onboard':   return startOnboarding({ chatId });
    case 'plan':      return planFlow({ chatId, goal: arg, ai, modelName });
    case 'post':      return postFlow({ chatId, brief: arg, platform: 'instagram', ai, modelName });
    case 'fb':        return postFlow({ chatId, brief: arg, platform: 'facebook', ai, modelName });
    case 'ig':        return postFlow({ chatId, brief: arg, platform: 'instagram', ai, modelName });
    case 'schedule':  return showSchedule({ userId });
    case 'report':    return reportFlow({ userId, ai, modelName });
    case 'memory':    return showMemory({ userId });
    case 'reflect':   return reflectFlow({ userId, ai, modelName });
    case 'campaigns': return showCampaigns({ userId });
    case 'help':      return reply(userId, MK_HELP);
    default:          return reply(userId, `לא מכיר את ${sub}. נסה: ${MK_HELP}`);
  }
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

const MK_HELP = `📣 *פקודות שיווק:*
  mk onboard          — להתחיל ראיון היכרות (פעם ראשונה)
  mk plan <מטרה>      — לבנות תוכנית קמפיין
  mk post <רעיון>     — לכתוב פוסט לאינסטגרם
  mk fb <רעיון>       — לכתוב פוסט לפייסבוק
  mk schedule         — להציג פוסטים מתוזמנים
  mk campaigns        — להציג את הקמפיינים שלך
  mk report           — דוח שבועי מהאנליסט
  mk reflect          — לגרום לי להסיק מסקנות עליך
  mk memory           — מה אני זוכר עליך
  mk help             — להציג את זה`;

// ── Background loop: publish due scheduled posts ────────────────────────────

export async function processScheduledPosts() {
  if (!meta.isConfigured()) return;
  const due = dueScheduledPosts();
  for (const p of due) {
    try {
      await publisher.publishPost(p.id);
    } catch (e) {
      console.error(`[CMO] Scheduled post #${p.id} failed:`, e.message);
    }
  }
}
