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
  tagPostFormat, autoScorePostsFromInsights, getTopFormats,
  recentInsights, listGoals, addGoal,
  addInsight, upsertEntity, listEntities, logAttendance, recentAttendance,
  listAgenda, addAgendaItem, setAgendaStatus,
  bumpAgendaNudge, setAgendaMute, setAgendaMuteByTopic,
  buildContextBundle, formatContextForPrompt,
  logOutboundMessage, recentCalendarEvents, getMemory, setMemory,
  getAllowedModels, getActiveModel, setActiveModel,
} from './memory.js';
import { addEdge } from './knowledgeGraph.js';
import * as strategist from './subagents/strategist.js';
import * as creative from './subagents/creative.js';
import * as campaignMgr from './subagents/campaignManager.js';
import * as publisher from './subagents/publisher.js';
import * as analyst from './subagents/analyst.js';
import * as mentor from './subagents/mentor.js';
import * as director from './subagents/director.js';
import * as meta from './meta.js';
import * as canva from './canva.js';
import { lookupClient } from './contacts.js';
import { buildSystemPrompt, buildToolsBlock } from '../personality/shaul.js';

// In-memory pending approvals: chatId → { kind, payload, expiresAt }
const pendingApprovals = new Map();
// Active onboarding sessions: chatId → true
const onboardingActive = new Set();
// Proactivity budget: chatId → count of proactive nudges sent today (resets at midnight)
const proactivityBudget = new Map();
let proactivityBudgetDay = new Date().toISOString().slice(0, 10);
const MAX_PROACTIVE_PER_DAY = 3;

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

// Public hooks for index.js — let the WhatsApp router register a pending
// outbound DM (raised by the local send_whatsapp_message tool) and check whether
// one exists. The approval gate logic is unified in this module.
export function registerSendWhatsappPending(chatId, payload) {
  setPending(chatId, 'send_whatsapp', payload);
}
export function hasPendingSendWhatsapp(chatId) {
  const p = pendingApprovals.get(chatId);
  return Boolean(p && p.kind === 'send_whatsapp' && Date.now() <= p.expiresAt);
}

// ── Public entry: handle a marketing-related message ─────────────────────────

const GO_RE = /^(יאללה|קדימה|תעבוד|תתחיל|go|do it|let's go|ok do)$/i;

export async function handleMarketingMessage({ chatId, text, ai, modelName: globalModelName, runGeminiWithTools, getGreenInvoiceClient, waClient, toolsBlock = '', sessionHistory = [] }) {
  const userId = chatId;
  // Per-user model override (set via mk model / dashboard)
  const modelName = getActiveModel(userId) || globalModelName;
  ensureProfile(userId);
  logInteraction({ userId, role: 'user', channel: 'whatsapp', content: text });

  const ctx = { chatId, ai, modelName, runGeminiWithTools, getGreenInvoiceClient, waClient, toolsBlock };

  // 1) If user is in onboarding, route there.
  if (onboardingActive.has(chatId)) {
    return handleOnboardingAnswer({ chatId, text, ai, modelName });
  }

  // 2) Approval gate.
  if (pendingApprovals.has(chatId)) {
    if (APPROVE_RE.test(text.trim())) {
      const p = takePending(chatId);
      return executeApproved(p, ctx);
    }
    if (REJECT_RE.test(text.trim())) {
      takePending(chatId);
      return reply(userId, '👍 בוטל. שלח לי משהו אחר.');
    }
    // Anything else: drop the pending and treat as a new message.
    takePending(chatId);
  }

  // 3) Explicit mk-commands (kept for back-compat; not advertised any more).
  const mkMatch = text.trim().match(/^mk\s+(\S+)\s*(.*)$/i);
  if (mkMatch) {
    return handleMkCommand({ ...ctx, sub: mkMatch[1].toLowerCase(), arg: mkMatch[2] });
  }

  // 4) "Go" — execute the top agenda item without further chat.
  if (GO_RE.test(text.trim())) {
    return executeTopAgenda(ctx);
  }

  // 5) Plain-Hebrew action classifier. Maps phrases like "תכין לי קמפיין",
  //    "תראה מה יש לי היום", "תכתוב לדנה הודעה" to concrete actions. Biased
  //    toward "none" so casual chat keeps flowing through the Mentor.
  try {
    const action = await classifyMarketingAction({ text, ai, modelName });
    if (action && action.action && action.action !== 'none') {
      const dispatched = await dispatchAction({ ...ctx, action: action.action, args: action.args || {} });
      // dispatched may be null (flow handled reply itself, e.g. dmClientFlow
      // sends the preview via the local tool). undefined means unknown action
      // — fall through to the Mentor.
      if (dispatched !== undefined) return dispatched;
    }
  } catch (err) {
    console.error('[CMO] classifier error:', err.message);
  }

  // 6) Free text → Mentor replies in Shaul's voice. Mentor has access to
  //    googleSearch + send_whatsapp_message via runGeminiWithTools.
  const replyText = await mentor.mentorReply({
    userId,
    userMessage: text,
    ai,
    modelName,
    runGeminiWithTools,
    toolsBlock,
    sessionHistory,
  });
  const finalReply = reply(userId, replyText);

  // Post-processor: bump nudge counts for agenda items referenced in this reply.
  bumpMentionedAgendaItems(userId, replyText);

  // Fire-and-forget background work: extract structured data + refresh agenda.
  silentExtraction({ userId, userMessage: text, ai, modelName })
    .catch(err => console.error('[CMO] silent extraction failed:', err.message));

  return finalReply;
}

// ── Natural-Hebrew action classifier ─────────────────────────────────────────
// Single fast Gemini call. Returns { action, args } or { action: 'none' }.
// Action vocabulary mirrors handleMkCommand + new Phase-4 actions.
async function classifyMarketingAction({ text, ai, modelName }) {
  const prompt = `You classify Hebrew/English WhatsApp messages from the user to their marketing assistant "Shaul". Return ONLY a single JSON object inside a \`\`\`json fence.

VOCABULARY (use exactly these "action" values):
- none                    : casual chat, advice, questions — DEFAULT. Bias HEAVILY toward this.
- show_agenda             : user wants to see what Shaul plans to do
- show_memory             : user asks "what do you remember about me", "מה אתה זוכר"
- show_calendar           : user wants the content/post calendar (NOT Google Calendar)
- show_today_schedule     : user asks "what do I have today", "מה יש לי היום", Google-Calendar-style
- show_campaigns          : user wants the campaigns list
- plan_campaign           : "תכין לי קמפיין", "build me a campaign for X" → args.goal
- draft_post_ig           : "כתוב פוסט אינסטגרם", "post about X" → args.brief
- draft_post_fb           : "כתוב פוסט פייסבוק" → args.brief
- canva_design            : user explicitly mentions Canva or wants a designed visual → args.brief
- canva_refresh_style     : user wants to re-analyze ALL their Canva designs to update style profile → no args
- canva_update_style      : user wants to update style based on ONE specific design by name → args.design_name
- canva_design_like       : user wants a new post designed like a specific existing design → args.design_name, args.brief
- weekly_report           : "תן לי דוח שבועי" / "report"
- briefing                : "תדריך", "briefing"
- discovery               : "תשאל אותי", "discovery"
- reflect                 : user explicitly asks Shaul to reflect on himself
- publish_post            : "תפרסם פוסט 42" → args.id
- cleanup                 : "תנקה את האג'נדה"
- schedule_followup       : "קבע פגישה", "תזמן פגישה", "schedule meeting" → args.who, args.when, args.what
- add_calendar_event      : like schedule_followup but generic event → args.title, args.when, args.duration
- meta_insights           : "תראה לי איך הקמפיין רץ", "how is the campaign performing"
- dm_client               : user asks Shaul to message a CLIENT (not the user) → args.client_name, args.intent
- share_canva_design      : user asks for the Canva design link, or asks to send/share the design (by email, link, etc.) → args.email (optional)
- snooze_agenda           : user wants to snooze/defer a specific agenda item by id or title → args.id (number or null), args.title (string or null), args.days (number, default 3)
- mute_topic              : user wants to stop hearing about a whole topic for a while → args.topic (string), args.days (number, default 7)
- done_agenda             : user marks an agenda item as done manually → args.id (number or null), args.title (string or null)
- pin_fact                : user wants to pin a key fact for Shaul to always remember → args.key (string), args.value (string)
- change_model            : user wants to switch the AI model Shaul uses → args.model_id (string, e.g. "gemini-2.5-flash")
- show_models             : user asks which AI models are available or which model Shaul is using

EXAMPLES:
- "מה אתה זוכר עליי" → {"action":"show_memory"}
- "תכין לי קמפיין לקיץ" → {"action":"plan_campaign","args":{"goal":"קיץ"}}
- "מה יש לי היום ביומן" → {"action":"show_today_schedule"}
- "מה יש בלוח התוכן" → {"action":"show_calendar"}
- "תכין עיצוב ב-canva למבצע" → {"action":"canva_design","args":{"brief":"למבצע"}}
- "תשלח לי את העיצוב מקנבה" → {"action":"share_canva_design","args":{}}
- "שלח את העיצוב למייל שלי" → {"action":"share_canva_design","args":{"email":"..."}}
- "קישור לעיצוב בקנבה" → {"action":"share_canva_design","args":{}}
- "רענן סגנון Canva" → {"action":"canva_refresh_style"}
- "עדכן סגנון לפי פוסט קיץ" → {"action":"canva_update_style","args":{"design_name":"פוסט קיץ"}}
- "תכין פוסט כמו העיצוב הכהה" → {"action":"canva_design_like","args":{"design_name":"העיצוב הכהה","brief":""}}
- "שלום מה קורה" → {"action":"none"}
- "מה דעתך על הקמפיין שלי" → {"action":"none"}
- "תכתוב לדנה כהן הודעה שתאשר" → {"action":"dm_client","args":{"client_name":"דנה כהן","intent":"שתאשר"}}
- "what about scheduling a follow-up with David tuesday" → {"action":"schedule_followup","args":{"who":"David","when":"tuesday"}}
- "תעזוב את הפוסט לפייסבוק" → {"action":"snooze_agenda","args":{"title":"הפוסט לפייסבוק","days":3}}
- "snooze 7" → {"action":"snooze_agenda","args":{"id":7,"days":3}}
- "תפסיק להזכיר לי על תקציב" → {"action":"mute_topic","args":{"topic":"budget","days":7}}
- "סיימתי עם פוסט 5" → {"action":"done_agenda","args":{"id":5}}
- "שמור שהלקוח המועדף הוא ב2ב" → {"action":"pin_fact","args":{"key":"לקוח מועדף","value":"ב2ב"}}
- "עבור ל-gemini-2.5-flash" → {"action":"change_model","args":{"model_id":"gemini-2.5-flash"}}
- "איזה מודל אתה משתמש?" → {"action":"show_models"}

Schema: {"action": "<one of the above>", "args": { ... }}

Message: "${text.slice(0, 400)}"

Return ONLY the JSON.`;
  const res = await ai.models.generateContent({
    model: modelName,
    contents: [{ parts: [{ text: prompt }] }],
    config: { temperature: 0 },
  });
  const raw = res.text || '';
  const fenced = raw.match(/```json\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : raw;
  try {
    const parsed = JSON.parse(body.trim());
    if (parsed && typeof parsed.action === 'string') return parsed;
  } catch (_) {
    const m = body.match(/\{[\s\S]*\}/);
    if (m) {
      try { return JSON.parse(m[0]); } catch (_) {}
    }
  }
  return { action: 'none' };
}

// Map a classifier action to the right flow. Re-uses handleMkCommand for the
// existing actions and dispatches new flows for Phase-4 actions.
async function dispatchAction({ chatId, ai, modelName, runGeminiWithTools, getGreenInvoiceClient, waClient, toolsBlock = '', action, args }) {
  const userId = chatId;
  switch (action) {
    case 'go':                  return executeTopAgenda({ chatId, ai, modelName, runGeminiWithTools, getGreenInvoiceClient, waClient });
    case 'show_agenda':         return showAgenda({ userId, ai, modelName });
    case 'show_memory':         return showMemory({ userId });
    case 'show_calendar':       return showCalendar({ userId });
    case 'show_today_schedule': return showTodaySchedule({ chatId, ai, modelName, runGeminiWithTools, toolsBlock });
    case 'show_campaigns':      return showCampaigns({ userId });
    case 'plan_campaign':       return planFlow({ chatId, goal: args.goal || '', ai, modelName });
    case 'draft_post_ig':       return postFlow({ chatId, brief: args.brief || '', platform: 'instagram', ai, modelName });
    case 'draft_post_fb':       return postFlow({ chatId, brief: args.brief || '', platform: 'facebook', ai, modelName });
    case 'canva_design':        return canvaFlow({ chatId, brief: args.brief || '', ai, modelName });
    case 'canva_refresh_style': return canvaRefreshStyleFlow({ chatId, ai, modelName });
    case 'canva_update_style':  return canvaUpdateStyleFromDesignFlow({ chatId, designName: args.design_name || '', ai, modelName });
    case 'canva_design_like':   return canvaDesignLikeFlow({ chatId, designName: args.design_name || '', brief: args.brief || '', ai, modelName });
    case 'weekly_report':       return reportFlow({ userId, ai, modelName });
    case 'briefing':            return briefingFlow({ chatId, ai, modelName });
    case 'discovery':           return discoveryFlow({ chatId, ai, modelName });
    case 'reflect':             return reflectFlow({ userId, ai, modelName });
    case 'publish_post':        return publishCommand({ userId, arg: String(args.id || '') });
    case 'cleanup':             return cleanupCommand({ userId, ai, modelName });
    case 'schedule_followup':   return calendarFlow({ chatId, ai, modelName, runGeminiWithTools, toolsBlock, kind: 'schedule_followup', args });
    case 'add_calendar_event':  return calendarFlow({ chatId, ai, modelName, runGeminiWithTools, toolsBlock, kind: 'add_event', args });
    case 'meta_insights':       return metaInsightsFlow({ chatId, ai, modelName, args });
    case 'dm_client':           return dmClientFlow({ chatId, ai, modelName, runGeminiWithTools, getGreenInvoiceClient, toolsBlock, args });
    case 'share_canva_design':  return shareCanvaDesignFlow({ chatId, args });
    case 'snooze_agenda':       return snoozeAgendaFlow({ userId, args });
    case 'mute_topic':          return muteTopicFlow({ userId, args });
    case 'done_agenda':         return doneAgendaFlow({ userId, args });
    case 'pin_fact':            return pinFactFlow({ userId, args });
    case 'change_model':        return changeModelFlow({ userId, args });
    case 'show_models':         return showModelsFlow({ userId });
    default:                    return undefined; // unknown — caller falls back to mentor
  }
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

  // Auto-flip onboarding_done once we have enough to operate (offer + icp +
  // at least one active goal). Conversation IS the onboarding for this user.
  maybeMarkOnboardingDone(userId);

  // After extraction, refresh the agenda so Director surfaces new actions.
  try { await director.refreshAgenda({ userId, ai, modelName }); } catch (_) {}
}

// Wire knowledge-graph mentions edges: check entity names against post caption.
function _wireEntityMentions(userId, postId, captionText) {
  if (!captionText) return;
  const lower = captionText.toLowerCase();
  try {
    const entities = listEntities(userId);
    for (const e of entities) {
      if (e.name && lower.includes(e.name.toLowerCase())) {
        addEdge({ userId, fromType: 'post', fromId: postId, toType: 'entity', toId: e.id, relation: 'mentions', weight: 0.8 });
      }
    }
  } catch (_) {}
}

// Bump nudge count on any pending agenda item whose title appears in the reply.
function bumpMentionedAgendaItems(userId, replyText) {
  if (!replyText) return;
  const items = listAgenda(userId, 'pending', 20);
  const lower = replyText.toLowerCase();
  for (const item of items) {
    const words = item.title.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const matched = words.length > 0 && words.some(w => lower.includes(w));
    if (matched) bumpAgendaNudge(item.id);
  }
}

function maybeMarkOnboardingDone(userId) {
  const p = getProfile(userId);
  if (!p || p.onboarding_done) return;
  if (p.offer && p.icp && listGoals(userId, 'active').length > 0) {
    updateProfile(userId, { onboarding_done: 1 });
  }
}

// ── mk subcommands ───────────────────────────────────────────────────────────

async function handleMkCommand({ chatId, sub, arg, ai, modelName, runGeminiWithTools, getGreenInvoiceClient, waClient }) {
  const userId = chatId;
  switch (sub) {
    case 'onboard':    return startOnboarding({ chatId });
    case 'discovery':  return discoveryFlow({ chatId, ai, modelName });
    case 'plan':       return planFlow({ chatId, goal: arg, ai, modelName });
    case 'post':       return postFlow({ chatId, brief: arg, platform: 'instagram', ai, modelName });
    case 'fb':         return postFlow({ chatId, brief: arg, platform: 'facebook', ai, modelName });
    case 'ig':         return postFlow({ chatId, brief: arg, platform: 'instagram', ai, modelName });
    case 'canva':      return canvaFlow({ chatId, brief: arg, ai, modelName });
    case 'schedule':   return showSchedule({ userId });
    case 'calendar':   return showCalendar({ userId });
    case 'today':      return showTodaySchedule({ chatId, ai, modelName, runGeminiWithTools });
    case 'meet':       return calendarFlow({ chatId, ai, modelName, runGeminiWithTools, kind: 'schedule_followup', args: { raw: arg } });
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
    case 'cleanup':    return cleanupCommand({ userId, ai, modelName });
    case 'dm':         return dmClientFlow({ chatId, ai, modelName, runGeminiWithTools, getGreenInvoiceClient, args: { client_name: arg } });
    case 'model':      return changeModelFlow({ userId, args: { model_id: arg.trim() } });
    case 'models':     return showModelsFlow({ userId });
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

// "mk cleanup" — flip onboarding_done if data is sufficient, drop stale probe
// items, refresh the agenda. Useful right after a bug fix when the existing
// DB has stale rows.
async function cleanupCommand({ userId, ai, modelName }) {
  maybeMarkOnboardingDone(userId);
  await reply(userId, '🧹 מנקה אג׳נדה ישנה ומרענן...');
  try { await director.refreshAgenda({ userId, ai, modelName }); } catch (e) {
    return reply(userId, `❌ שגיאה: ${e.message}`);
  }
  return reply(userId, '✅ נקי. שלח *mk agenda* לראות את הרשימה החדשה.');
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

  // Inject winning format hint from analytics feedback loop
  const formatHint = buildFormatHint(userId, platform);
  const draft = await creative.draftPost({ userId, brief, platform, ai, modelName, formatHint });
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

// ── Phase 4 flows ────────────────────────────────────────────────────────────

// "What's on my Google Calendar today?" — read-only, no approval needed.
async function showTodaySchedule({ chatId, ai, modelName, runGeminiWithTools, toolsBlock = '' }) {
  const userId = chatId;
  if (!runGeminiWithTools) {
    return reply(userId, '⚠️ Calendar לא מוגדר. צריך CALENDAR_MCP_PATH ב-.env.');
  }
  await reply(userId, '📅 מושך מ-Google Calendar...');
  const sys = `${buildSystemPrompt({ channel: 'whatsapp', task: 'general', tools: toolsBlock })}

Task: read the user's Google Calendar for the next 24 hours and present it in Hebrew.
Use the Calendar MCP tools (e.g. list_events / get_events) to fetch events. Format:
- One header line in Hebrew
- Bulleted list: time + title + duration
- If empty, say so plainly. No filler.`;
  try {
    const { text } = await runGeminiWithTools({
      chatId,
      history: [],
      message: 'מה יש ביומן שלי ל-24 השעות הקרובות? תחזיר רשימה קצרה.',
      systemInstruction: sys,
    });
    return reply(userId, text || 'לא הצלחתי למשוך מהיומן.');
  } catch (e) {
    return reply(userId, `❌ שגיאה ביומן: ${e.message}`);
  }
}

// schedule_followup / add_calendar_event — Gemini composes a create_event call,
// returns its proposal as text, and we ask the user to approve.
async function calendarFlow({ chatId, ai, modelName, runGeminiWithTools, toolsBlock = '', kind, args }) {
  const userId = chatId;
  if (!runGeminiWithTools) {
    return reply(userId, '⚠️ Calendar לא מוגדר. צריך CALENDAR_MCP_PATH ב-.env.');
  }
  const today = new Date().toISOString().slice(0, 10);
  const argsHint = JSON.stringify(args || {});
  const sys = `${buildSystemPrompt({ channel: 'whatsapp', task: 'general', tools: toolsBlock })}

Task: propose a Google Calendar event. TODAY is ${today}.
- Use the Calendar MCP create_event tool to actually create the event.
- BEFORE calling create_event, double-check the date is on or after today.
- After creating, reply in Hebrew with: "📅 קבעתי: <title> ב-<time> ל-<duration>" and the event link if available.
- If you don't have enough info (e.g. missing time), ask ONE clarifying question instead of guessing. Don't create an event with a placeholder date.`;
  const userMessage = `Args from classifier: ${argsHint}. Kind: ${kind}. Compose and create the event.`;
  try {
    const { text } = await runGeminiWithTools({
      chatId,
      history: [],
      message: userMessage,
      systemInstruction: sys,
    });
    return reply(userId, text || 'לא הצלחתי לקבוע את האירוע.');
  } catch (e) {
    return reply(userId, `❌ שגיאה ביומן: ${e.message}`);
  }
}

// dm_client — look up the client, draft the message, ask for approval BEFORE
// sending. The local send_whatsapp_message tool is also available so the agent
// can drive this end-to-end in one Gemini turn.
async function dmClientFlow({ chatId, ai, modelName, runGeminiWithTools, getGreenInvoiceClient, toolsBlock = '', args }) {
  const userId = chatId;
  if (!runGeminiWithTools) {
    return reply(userId, '⚠️ הסביבה לא מוכנה לשליחת הודעות.');
  }
  const clientName = (args.client_name || '').trim();
  if (!clientName) {
    return reply(userId, 'תכתוב למי לשלוח. למשל: "תכתוב לדנה כהן הודעה שתאשר את הסדנה".');
  }
  await reply(userId, `🔍 מחפש את ${clientName} בלקוחות...`);
  const mcp = getGreenInvoiceClient && getGreenInvoiceClient();
  let candidates = [];
  if (mcp) {
    try { candidates = await lookupClient({ name: clientName, mcpClient: mcp }); }
    catch (e) { console.error('[CMO] lookupClient:', e.message); }
  }
  if (candidates.length === 0) {
    return reply(userId, `לא מצאתי את ${clientName} ב-GreenInvoice. תוודא את השם או שלח את המספר ישירות.`);
  }
  if (candidates.length > 1) {
    const lines = ['🔎 מצאתי כמה תוצאות, איזה הוא הנכון?'];
    candidates.slice(0, 5).forEach((c, i) => {
      lines.push(`${i + 1}. ${c.name}${c.phone ? ` — ${c.phone}` : ''}`);
    });
    lines.push('\nשלח את השם המלא או המספר.');
    return reply(userId, lines.join('\n'));
  }
  const c = candidates[0];
  if (!c.jid) {
    return reply(userId, `מצאתי את ${c.name} אבל אין לו טלפון תקין במערכת.`);
  }
  const intent = args.intent || 'הודעת המשך';
  const sys = `${buildSystemPrompt({ channel: 'whatsapp', task: 'general', tools: toolsBlock })}

Task: draft and propose sending a WhatsApp message to a CLIENT (not the user).
- Client: ${c.name} (phone ${c.phone}).
- Purpose: ${intent}.
- Voice: friendly, short (2-4 lines), natural Hebrew, signed informally.
- Then call send_whatsapp_message with phone="${c.phone}", target_label="${c.name}", and your drafted message.
- The system will show the user a preview and ask for approval — DO NOT call send_whatsapp_message twice.`;
  try {
    const { text } = await runGeminiWithTools({
      chatId,
      history: [],
      message: `שלח ל${c.name}: ${intent}`,
      systemInstruction: sys,
      includeSendWhatsapp: true,
    });
    if (text) return reply(userId, text);
    return null; // preview already sent by the local tool handler
  } catch (e) {
    return reply(userId, `❌ שגיאה: ${e.message}`);
  }
}

// canva_design — explore existing designs, derive style profile (cached), then
// draft a new design + caption matching the style, ask for two-step approval.
async function canvaFlow({ chatId, brief, ai, modelName }) {
  const userId = chatId;
  if (!brief || brief.trim().length < 3) {
    return reply(userId, 'תכתוב על מה העיצוב. למשל: "תכין עיצוב על מבצע סוף שנה".');
  }
  if (!canva.isConfigured()) {
    return reply(userId, '⚠️ Canva לא מוגדר. הרץ "node agent/scripts/canva-oauth.js" כדי לחבר.');
  }
  await reply(userId, '🎨 מסתכל על העיצובים שלך ב-Canva...');

  // 1. Style profile — cached so we don't re-derive on every call.
  //    Invalidate v1 cache automatically (v2 adds visual analysis fields).
  let styleProfile = getMemory(userId, 'canva_style_profile');
  if (styleProfile && (styleProfile._schema_version || 1) < 2) styleProfile = null;
  if (!styleProfile) {
    try {
      const designs = await canva.listDesigns({ limit: 8 });
      styleProfile = await deriveStyleProfile({ userId, designs, ai, modelName });
      if (styleProfile) setMemory(userId, 'canva_style_profile', styleProfile);
    } catch (e) {
      console.error('[Canva] style derivation failed:', e.message);
    }
  }

  // 2. Creative drafts caption + visual brief grounded in style.
  const draft = await creative.draftPost({
    userId, brief, platform: 'instagram', ai, modelName,
    styleHint: formatStyleHint(styleProfile),
  });
  if (!draft) return reply(userId, 'לא הצלחתי לכתוב טיוטה.');

  // 3. First approval — caption + visual brief preview. After approval we'll
  //    create + export the Canva design, then ask for the second approval to
  //    publish to FB/IG.
  setPending(chatId, 'canva_create', { draft, styleProfile });
  return reply(userId, `🎨 *טיוטת עיצוב Canva:*

*כותרת:* ${draft.headline || '—'}
*טקסט:* ${draft.body || '—'}
*וויזואל:* ${draft.image_brief || '—'}
${styleProfile?.summary ? `\n_סגנון: ${styleProfile.summary.slice(0, 140)}_` : ''}

_שלח *אשר* כדי שאצור את העיצוב ב-Canva, או *בטל* כדי לעצור._`);
}

async function fetchThumbnailBase64(url) {
  if (!url) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    return {
      mimeType: res.headers.get('content-type') || 'image/jpeg',
      data: Buffer.from(buf).toString('base64'),
    };
  } catch { return null; }
}

const STYLE_SCHEMA_HINT = `{
  "_schema_version": 2,
  "summary": "1-sentence Hebrew description of the user's typical visual style",
  "color_palette": "exact colors seen (e.g. 'כחול כהה, לבן, זהב') or null",
  "typography": "font style observed (bold/thin/serif/sans) or null",
  "tone": "bold / playful / minimalist / warm / professional",
  "writing_style": "short/formal/casual, emoji use, sentence length or null",
  "layout_style": "clean / image-heavy / text-dominant / busy or null",
  "text_language": "Hebrew / English / mixed or null",
  "preferred_design_types": ["instagram_post", ...]
}`;

async function deriveStyleProfileTextOnly({ sample, ai, modelName }) {
  const prompt = `You are deriving the user's visual brand style from their existing Canva designs.

Existing designs (titles + types):
${JSON.stringify(sample, null, 2)}

Return ONLY this JSON inside a \`\`\`json fence:
${STYLE_SCHEMA_HINT}`;
  const res = await ai.models.generateContent({
    model: modelName,
    contents: [{ parts: [{ text: prompt }] }],
    config: { temperature: 0.3 },
  });
  const raw = res.text || '';
  const fenced = raw.match(/```json\s*([\s\S]*?)```/i);
  return JSON.parse((fenced ? fenced[1] : raw).trim());
}

async function deriveStyleProfile({ userId, designs, ai, modelName }) {
  if (!Array.isArray(designs) || designs.length === 0) return null;
  const sample = designs.slice(0, 8).map(d => ({
    title: d.title || d.name || null,
    type: d.design_type || d.type || null,
    thumbnailUrl: d.thumbnail_url || d.thumbnail?.url || null,
  }));

  // Fetch thumbnails in parallel; failures silently return null.
  const thumbs = await Promise.all(sample.map(d => fetchThumbnailBase64(d.thumbnailUrl)));
  const anyLoaded = thumbs.some(Boolean);

  if (!anyLoaded) {
    try { return await deriveStyleProfileTextOnly({ sample, ai, modelName }); } catch (e) {
      console.error('[Canva] text-only style profile failed:', e.message);
      return null;
    }
  }

  // Build multimodal parts: text label + inline image per design.
  const parts = [];
  parts.push({ text: `Analyze the user's Canva designs visually and derive their brand style.\n\nReturn ONLY this JSON inside a \`\`\`json fence:\n${STYLE_SCHEMA_HINT}\n\nDesigns:` });
  sample.forEach((d, i) => {
    parts.push({ text: `\nDesign ${i + 1}: "${d.title || 'untitled'}" (${d.type || 'unknown type'})` });
    if (thumbs[i]) parts.push({ inlineData: thumbs[i] });
  });

  try {
    const res = await ai.models.generateContent({
      model: modelName,
      contents: [{ parts }],
      config: { temperature: 0.3 },
    });
    const raw = res.text || '';
    const fenced = raw.match(/```json\s*([\s\S]*?)```/i);
    return JSON.parse((fenced ? fenced[1] : raw).trim());
  } catch (e) {
    console.error('[Canva] multimodal style profile failed, falling back:', e.message);
    try { return await deriveStyleProfileTextOnly({ sample, ai, modelName }); } catch (_) { return null; }
  }
}

function formatStyleHint(p) {
  if (!p) return null;
  const parts = [p.summary];
  if (p.color_palette)  parts.push(`Colors: ${p.color_palette}`);
  if (p.typography)     parts.push(`Typography: ${p.typography}`);
  if (p.tone)           parts.push(`Tone: ${p.tone}`);
  if (p.writing_style)  parts.push(`Writing style: ${p.writing_style}`);
  if (p.layout_style)   parts.push(`Layout: ${p.layout_style}`);
  if (p.text_language)  parts.push(`Language in designs: ${p.text_language}`);
  return parts.filter(Boolean).join('\n');
}

function findDesignByName(name, designs) {
  const lower = name.toLowerCase().trim();
  return (
    designs.find(d => (d.title || d.name || '').toLowerCase() === lower) ||
    designs.find(d => (d.title || d.name || '').toLowerCase().includes(lower)) ||
    null
  );
}

// canva_refresh_style — clear cached style and re-derive from all designs.
async function canvaRefreshStyleFlow({ chatId, ai, modelName }) {
  if (!canva.isConfigured()) return reply(chatId, '⚠️ Canva לא מוגדר.');
  setMemory(chatId, 'canva_style_profile', null);
  await reply(chatId, '🎨 מרענן סגנון מכל העיצובים שלך...');
  try {
    const designs = await canva.listDesigns({ limit: 10 });
    const styleProfile = await deriveStyleProfile({ userId: chatId, designs, ai, modelName });
    if (styleProfile) {
      setMemory(chatId, 'canva_style_profile', styleProfile);
      return reply(chatId, `✅ סגנון עודכן.\n_${styleProfile.summary}_`);
    }
    return reply(chatId, '⚠️ לא הצלחתי לנתח את העיצובים.');
  } catch (e) {
    return reply(chatId, `❌ שגיאה: ${e.message}`);
  }
}

// canva_update_style — derive style from ONE specific design by name.
async function canvaUpdateStyleFromDesignFlow({ chatId, designName, ai, modelName }) {
  if (!canva.isConfigured()) return reply(chatId, '⚠️ Canva לא מוגדר.');
  if (!designName) return reply(chatId, 'תציין שם של עיצוב. למשל: "עדכן סגנון לפי פוסט קיץ".');
  await reply(chatId, `🎨 מחפש את העיצוב "${designName}"...`);
  try {
    const designs = await canva.listDesigns({ limit: 20, query: designName });
    const match = findDesignByName(designName, designs) || designs[0];
    if (!match) return reply(chatId, `לא מצאתי עיצוב בשם "${designName}". נסה שם אחר.`);
    await reply(chatId, `🔍 מנתח את "${match.title || match.name}"...`);
    const styleProfile = await deriveStyleProfile({ userId: chatId, designs: [match], ai, modelName });
    if (styleProfile) {
      setMemory(chatId, 'canva_style_profile', styleProfile);
      return reply(chatId, `✅ העדפות עודכנו לפי "${match.title || match.name}".\n_${styleProfile.summary}_`);
    }
    return reply(chatId, '⚠️ לא הצלחתי לנתח את העיצוב.');
  } catch (e) {
    return reply(chatId, `❌ שגיאה: ${e.message}`);
  }
}

// canva_design_like — draft a new post inspired by a specific existing design.
async function canvaDesignLikeFlow({ chatId, designName, brief, ai, modelName }) {
  if (!canva.isConfigured()) return reply(chatId, '⚠️ Canva לא מוגדר.');
  if (!designName) return reply(chatId, 'תציין שם של עיצוב. למשל: "תכין פוסט כמו פוסט קיץ".');
  await reply(chatId, `🎨 מחפש את "${designName}" ב-Canva...`);
  try {
    const designs = await canva.listDesigns({ limit: 20, query: designName });
    const match = findDesignByName(designName, designs) || designs[0];
    if (!match) {
      const names = designs.slice(0, 5).map(d => d.title || d.name).filter(Boolean).join('\n  ');
      return reply(chatId, `לא מצאתי עיצוב בשם "${designName}".\n\nעיצובים זמינים:\n  ${names || '— אין עיצובים —'}`);
    }
    await reply(chatId, `🔍 מנתח את הסגנון של "${match.title || match.name}"...`);
    const oneOffStyle = await deriveStyleProfile({ userId: chatId, designs: [match], ai, modelName });
    const draft = await creative.draftPost({
      userId: chatId,
      brief: brief || `עיצוב בסגנון של "${match.title || match.name}"`,
      platform: 'instagram',
      ai, modelName,
      styleHint: formatStyleHint(oneOffStyle) || formatStyleHint(getMemory(chatId, 'canva_style_profile')),
    });
    if (!draft) return reply(chatId, 'לא הצלחתי לכתוב טיוטה.');
    setPending(chatId, 'canva_create', { draft, styleProfile: oneOffStyle });
    const designLabel = match.title || match.name;
    return reply(chatId, `🎨 *טיוטה בסגנון של "${designLabel}":*

*כותרת:* ${draft.headline || '—'}
*טקסט:* ${draft.body || '—'}
*וויזואל:* ${draft.image_brief || '—'}
${oneOffStyle?.summary ? `\n_סגנון: ${oneOffStyle.summary.slice(0, 140)}_` : ''}

_שלח *אשר* לעיצוב ב-Canva, או *בטל*._`);
  } catch (e) {
    return reply(chatId, `❌ שגיאה: ${e.message}`);
  }
}

// share_canva_design — retrieve the last created design's Canva link from memory
// and either send it inline or email it to the requested address.
async function shareCanvaDesignFlow({ chatId, args }) {
  const userId = chatId;
  const lastDesign = getMemory(userId, 'last_canva_design');
  if (!lastDesign?.view_url) {
    return reply(userId, 'לא מצאתי עיצוב Canva שמור. צור עיצוב קודם עם "תכין עיצוב ב-Canva".');
  }
  const { title, view_url } = lastDesign;
  const email = args?.email || null;
  if (email) {
    return reply(userId, `🔗 *${title || 'עיצוב Canva'}*\nקישור לעיצוב: ${view_url}\n\nאם תרצה שאשלח את הקישור הזה למייל ${email}, שלח לי אישור.`);
  }
  return reply(userId, `🔗 *${title || 'עיצוב Canva'}*\nהנה הקישור לעיצוב שלך ב-Canva:\n${view_url}`);
}

// meta_insights — pull latest Page+IG metrics and let the Analyst propose a
// refined plan (presented as draft for approval, then queued by Director on go).
async function metaInsightsFlow({ chatId, ai, modelName, args }) {
  const userId = chatId;
  if (!meta.isConfigured()) {
    return reply(userId, '⚠️ Meta API לא מוגדר. הוסף META_PAGE_TOKEN ו-IG_BUSINESS_ID ל-.env.');
  }
  await reply(userId, '📊 מושך נתוני Meta...');
  let metricsBundle = null;
  try {
    const [page, ig, pagePosts, igMedia] = await Promise.allSettled([
      meta.pageInsights({}),
      meta.instagramInsights({}),
      meta.recentPagePosts(10),
      meta.recentInstagramMedia(10),
    ]);
    metricsBundle = {
      page:  page.status === 'fulfilled'      ? page.value      : null,
      ig:    ig.status === 'fulfilled'        ? ig.value        : null,
      pagePosts: pagePosts.status === 'fulfilled' ? pagePosts.value : null,
      igMedia: igMedia.status === 'fulfilled' ? igMedia.value : null,
    };
  } catch (e) {
    console.error('[meta_insights]', e.message);
  }
  // Auto-score published posts from today's insights (analytics feedback loop)
  try { autoScorePostsFromInsights(userId); } catch (_) {}

  const refined = await analyst.refineCampaign({ userId, ai, modelName, metricsBundle, hint: args || {} });
  if (!refined) return reply(userId, 'אין מספיק נתונים לחידוד.');
  setPending(chatId, 'apply_refined_plan', { refined });
  const lines = [
    '📊 *תקציר מטריקות + הצעות לחידוד:*',
    '',
    `*כותרת:* ${refined.headline || '—'}`,
    '',
    '*טופ:* ' + (refined.top_performer || '—'),
    '*תחתית:* ' + (refined.bottom_performer || '—'),
    '',
    '*המלצות:*',
    ...(refined.recommendations || []).slice(0, 5).map(r => `  • ${r}`),
    '',
    '_שלח *אשר* כדי שאקפיץ את ההצעות לאג׳נדה, או *בטל*._',
  ];
  return reply(userId, lines.join('\n'));
}

// ── Approval execution ───────────────────────────────────────────────────────

async function executeApproved(pending, { chatId, ai, modelName, runGeminiWithTools, getGreenInvoiceClient, waClient }) {
  const userId = chatId;
  const { kind, payload } = pending;

  // Phase 4: outbound DM. The user previewed it via the local
  // send_whatsapp_message tool; now actually send it.
  if (kind === 'send_whatsapp') {
    const { jid, message: bodyText, targetLabel } = payload;
    if (!waClient) {
      return reply(userId, '⚠️ אין חיבור WhatsApp פעיל.');
    }
    try {
      await waClient.sendMessage(jid, bodyText);
      logOutboundMessage({ userId, targetJid: jid, targetLabel, body: bodyText, status: 'sent' });
      return reply(userId, `🚀 נשלח ל${targetLabel || jid}.`);
    } catch (e) {
      logOutboundMessage({ userId, targetJid: jid, targetLabel, body: bodyText, status: 'failed', errorMessage: e.message });
      return reply(userId, `❌ שליחה נכשלה: ${e.message}`);
    }
  }

  // Phase 4: Canva — first approval. Create the design + export, then ask for
  // the second approval to publish.
  if (kind === 'canva_create') {
    const { draft, styleProfile } = payload;
    await reply(userId, '🎨 יוצר ב-Canva...');
    let exportResult;
    let designViewUrl = null;
    let designTitle = null;
    try {
      const designResp = await canva.createDesign({
        title: draft.headline || (draft.body || 'Shaul design').slice(0, 40),
        styleProfile,
      });
      // Canva API wraps the design under a "design" key: { design: { id, urls: { view_url, edit_url } } }
      const designObj = designResp?.design || designResp;
      const designId = designObj?.id;
      designViewUrl = designObj?.urls?.view_url || designObj?.view_url || null;
      designTitle = designObj?.title || draft.headline || 'עיצוב Canva';
      if (!designId) throw new Error('Canva לא החזיר ID לעיצוב');
      // Persist so the user can ask for the link later in any message.
      setMemory(userId, 'last_canva_design', {
        id: designId,
        title: designTitle,
        view_url: designViewUrl,
        created_at: new Date().toISOString(),
      });
      exportResult = await canva.exportDesign(designId);
    } catch (e) {
      return reply(userId, `❌ Canva נכשל: ${e.message}`);
    }
    const imageUrl = exportResult?.urls?.[0] || exportResult?.url || null;
    if (!imageUrl) {
      return reply(userId, '⚠️ Canva לא החזיר תמונה. נסה שוב.');
    }
    setPending(chatId, 'canva_publish', { draft, imageUrl, designViewUrl });
    const linkLine = designViewUrl ? `\n🔗 קישור לעיצוב ב-Canva: ${designViewUrl}` : '';
    return reply(userId, `✅ העיצוב מוכן! *${designTitle}*${linkLine}\n\nלפרסם לאינסטגרם? *אשר* / *בטל*.`);
  }

  if (kind === 'canva_publish') {
    const { draft, imageUrl } = payload;
    const caption = `${draft.headline ? draft.headline + '\n\n' : ''}${draft.body || ''}\n\n${draft.hashtags || ''}`.trim();
    const creativeId = createCreative({
      userId, kind: 'post', headline: draft.headline, body: draft.body,
      hashtags: draft.hashtags, image_brief: draft.image_brief, image_url: imageUrl,
      status: 'approved',
    });
    const postId = createPost({ userId, creativeId, platform: 'instagram', caption, image_url: imageUrl, status: 'approved' });
    // Knowledge graph: wire post → campaign (part_of) and post → entities (mentions)
    const canvaCreative = getCreative(creativeId);
    if (canvaCreative?.campaign_id) {
      addEdge({ userId, fromType: 'post', fromId: postId, toType: 'campaign', toId: canvaCreative.campaign_id, relation: 'part_of', weight: 1.0 });
    }
    _wireEntityMentions(userId, postId, caption);
    if (!meta.isConfigured()) {
      setPostStatus(postId, 'pending_approval');
      return reply(userId, `💾 הפוסט נשמר (#${postId}) אבל Meta API לא מוגדר.`);
    }
    try {
      const res = await publisher.publishPost(postId);
      return reply(userId, `🚀 פורסם!\n${res.permalink || ''}`);
    } catch (e) {
      return reply(userId, `❌ פרסום נכשל: ${e.message}`);
    }
  }

  // Phase 4: refined plan from Meta insights → push recommendations into agenda.
  if (kind === 'apply_refined_plan') {
    const { refined } = payload;
    let added = 0;
    for (const rec of (refined.recommendations || []).slice(0, 5)) {
      addAgendaItem({
        userId,
        title: typeof rec === 'string' ? rec.slice(0, 60) : (rec.title || 'refinement').slice(0, 60),
        detail: typeof rec === 'string' ? null : (rec.detail || null),
        kind: 'draft_post',
        priority: 3,
      });
      added++;
    }
    return reply(userId, `✅ הוספתי ${added} פריטים לאג'נדה. שלח "יאללה" כדי שאתחיל מהראשון.`);
  }

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
    // Persist format tags for analytics feedback loop
    if (draft.format_tags) tagPostFormat(postId, draft.format_tags);
    // Knowledge graph: wire post → campaign (part_of) and post → entities (mentions)
    const savedCreative = getCreative(creativeId);
    if (savedCreative?.campaign_id) {
      addEdge({ userId, fromType: 'post', fromId: postId, toType: 'campaign', toId: savedCreative.campaign_id, relation: 'part_of', weight: 1.0 });
    }
    _wireEntityMentions(userId, postId, caption);

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

_💡 הכי קל: פשוט תכתוב לי מה אתה צריך בעברית. הפקודות mk עובדות לאחור-תאימות._

🎯 *פעולה:*
  mk go               — אני מתחיל מהדבר הכי חשוב באג'נדה
  mk agenda           — לראות מה אני מתכוון לעשות
  mk briefing         — תדריך עכשווי

🛠 *עבודת שיווק:*
  mk plan <מטרה>      — בונה תוכנית קמפיין
  mk post <רעיון>     — פוסט אינסטגרם
  mk fb <רעיון>       — פוסט פייסבוק
  mk canva <רעיון>    — עיצוב Canva בסגנון שלך
  mk calendar         — לוח תוכן 14 יום
  mk schedule         — פוסטים בתור
  mk campaigns        — הקמפיינים שלך

📅 *יומן (Google Calendar):*
  mk today            — מה יש לי היום
  mk meet <תיאור>     — קבע פגישה / איוון

💬 *שליחה ללקוחות:*
  mk dm <שם לקוח>     — מאתר טלפון, ננסח, אישור לפני שליחה

📊 *מדידה:*
  mk attendance "תווית" 12  — רושם נוכחות בסדנה
  mk report           — דוח שבועי (שיווק + נוכחות + Meta insights)
  mk reflect          — אני מסיק מסקנות עלייך

🧠 *לימוד עליך:*
  mk discovery        — שאלה הבאה הכי חשובה
  mk onboard          — ראיון מלא
  mk memory           — מה אני זוכר עליך

🧹 *תחזוקה:*
  mk cleanup          — מנקה אג'נדה ישנה ומרענן`;

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

// ── Proactivity budget ────────────────────────────────────────────────────────

export function canSendProactive(chatId) {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== proactivityBudgetDay) {
    proactivityBudget.clear();
    proactivityBudgetDay = today;
  }
  return (proactivityBudget.get(chatId) || 0) < MAX_PROACTIVE_PER_DAY;
}

export function consumeProactiveBudget(chatId) {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== proactivityBudgetDay) {
    proactivityBudget.clear();
    proactivityBudgetDay = today;
  }
  proactivityBudget.set(chatId, (proactivityBudget.get(chatId) || 0) + 1);
}

// ── Snooze / mute / done / pin flows ──────────────────────────────────────────

function snoozeAgendaFlow({ userId, args }) {
  const days = Number(args?.days) || 3;
  const until = new Date(Date.now() + days * 86400_000).toISOString();

  if (args?.id) {
    setAgendaMute(Number(args.id), until);
    return reply(userId, `בסדר, נדחה ל-${days} ימים.`);
  }
  if (args?.title) {
    const items = listAgenda(userId, 'pending', 50);
    const match = items.find(a => a.title.includes(args.title));
    if (match) {
      setAgendaMute(match.id, until);
      return reply(userId, `בסדר, נדחה ל-${days} ימים.`);
    }
  }
  return reply(userId, 'לא מצאתי פריט כזה באג\'נדה. נסה "snooze <מספר>".');
}

function muteTopicFlow({ userId, args }) {
  const days = Number(args?.days) || 7;
  const topic = String(args?.topic || '');
  if (!topic) return reply(userId, 'לא ברור איזה נושא לדמם. נסה שוב.');
  setAgendaMuteByTopic(userId, topic, days);
  return reply(userId, `לא אזכיר לך על "${topic}" ב-${days} הימים הקרובים.`);
}

function doneAgendaFlow({ userId, args }) {
  if (args?.id) {
    setAgendaStatus(Number(args.id), 'done');
    return reply(userId, 'מסומן כ-Done. 👍');
  }
  if (args?.title) {
    const items = listAgenda(userId, 'pending', 50);
    const match = items.find(a => a.title.includes(args.title));
    if (match) {
      setAgendaStatus(match.id, 'done');
      return reply(userId, 'מסומן כ-Done. 👍');
    }
  }
  return reply(userId, 'לא מצאתי פריט כזה. נסה "done <מספר>".');
}

// Build a human-readable hint from top-performing format patterns.
function buildFormatHint(userId, platform) {
  try {
    const top = getTopFormats(userId, platform, 3);
    if (!top.length) return null;
    return top.map((f, i) =>
      `${i + 1}. tone=${f.tags.tone}, hook=${f.tags.hook_type}, length=${f.tags.length_bucket} (avg score ${f.avg_score.toFixed(3)}, n=${f.sample_count})`
    ).join('\n');
  } catch (_) { return null; }
}

function pinFactFlow({ userId, args }) {
  const key   = String(args?.key || '').trim();
  const value = String(args?.value || '').trim();
  if (!key || !value) return reply(userId, 'לא הבנתי מה לשמור. נסח כ: "שמור ש<מפתח> הוא <ערך>".');
  const existing = getMemory(userId, '_pinned_facts');
  const pins = existing ? JSON.parse(existing) : {};
  pins[key] = value;
  setMemory(userId, '_pinned_facts', JSON.stringify(pins));
  return reply(userId, `שמרתי: ${key} = ${value}.`);
}

function changeModelFlow({ userId, args }) {
  const modelId = String(args?.model_id || '').trim();
  if (!modelId) {
    return showModelsFlow({ userId });
  }
  try {
    setActiveModel(userId, modelId);
    const model = getAllowedModels().find(m => m.id === modelId);
    return reply(userId, `✅ עברתי ל-*${model?.label || modelId}*${model?.note ? ` — ${model.note}` : ''}. השינוי בתוקף מיד.`);
  } catch (e) {
    const list = getAllowedModels().map(m => `• \`${m.id}\` — ${m.label} (${m.note})`).join('\n');
    return reply(userId, `המודל "${modelId}" לא ברשימה. מודלים זמינים:\n${list}`);
  }
}

function showModelsFlow({ userId }) {
  const current = getActiveModel(userId);
  const models = getAllowedModels();
  const lines = models.map(m => {
    const active = m.id === current ? ' ← *פעיל*' : '';
    return `• \`${m.id}\` — ${m.label} (${m.note})${active}`;
  });
  const currentLabel = current
    ? (models.find(m => m.id === current)?.label || current)
    : `ברירת מחדל (${process.env.GEMINI_MODEL || 'gemini-2.5-pro'})`;
  return reply(userId, `🤖 *מודל נוכחי:* ${currentLabel}\n\n*מודלים זמינים:*\n${lines.join('\n')}\n\nלהחלפה: \`mk model <id>\` או "עבור ל-<id>"`);
}
