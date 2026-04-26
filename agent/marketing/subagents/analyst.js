// Analyst sub-agent. Pulls insights from Meta, stores daily metrics,
// and explains them in plain Hebrew with concrete next steps.

import { buildPrompt, runSubagent } from './common.js';
import * as meta from '../meta.js';
import { upsertDailyInsight, recentInsights, recentAttendance, listPosts } from '../memory.js';

export async function pullDailyInsights({ userId }) {
  if (!meta.isConfigured()) return { skipped: true, reason: 'Meta API not configured' };
  const today = new Date().toISOString().slice(0, 10);
  const out = { fb: null, ig: null };

  try {
    const fb = await meta.pageInsights({});
    out.fb = fb;
    const data = (fb.data || []).reduce((acc, m) => {
      const last = m.values?.[m.values.length - 1]?.value;
      acc[m.name] = typeof last === 'object' ? Object.values(last).reduce((a, b) => a + b, 0) : last;
      return acc;
    }, {});
    upsertDailyInsight({
      userId, day: today, platform: 'facebook',
      reach: null,
      impressions: data.page_impressions || null,
      engagements: data.page_post_engagements || null,
      clicks: null, spend: null, revenue: null,
      raw_json: data,
    });
  } catch (e) { out.fb = { error: e.message }; }

  try {
    const ig = await meta.instagramInsights({});
    out.ig = ig;
    const data = (ig.data || []).reduce((acc, m) => {
      acc[m.name] = m.total_value?.value ?? null;
      return acc;
    }, {});
    upsertDailyInsight({
      userId, day: today, platform: 'instagram',
      reach: data.reach || null,
      impressions: data.impressions || null,
      engagements: null,
      clicks: null, spend: null, revenue: null,
      raw_json: data,
    });
  } catch (e) { out.ig = { error: e.message }; }

  return out;
}

export async function weeklyReport({ userId, ai, modelName }) {
  const insights = recentInsights(userId, 14);
  const attendance = recentAttendance(userId, 12);
  const recentPosts = listPosts(userId).slice(0, 20).map(p => ({
    id: p.id, platform: p.platform, status: p.status,
    published_at: p.published_at, caption: (p.caption || '').slice(0, 100),
  }));

  const prompt = buildPrompt({
    userId,
    role: `You are the Analyst. Read all the data and give the user a plain-Hebrew weekly report. You correlate THREE signals: Meta metrics (reach, engagement), recent posts that were published, and ACTUAL business outcomes (workshop attendance / revenue). The user cares about real outcomes — kids in the room — not vanity metrics. Tie marketing effort to attendance whenever possible.

Be honest. If numbers are low, say so. If you don't have enough data, say that too — don't invent.
Always end with ONE concrete thing Shaul will do this week (not the user — Shaul).`,
    task: `Meta insights (last 14 days):\n${JSON.stringify(insights, null, 2)}\n\nWorkshop attendance:\n${JSON.stringify(attendance, null, 2)}\n\nRecent posts (last 20):\n${JSON.stringify(recentPosts, null, 2)}\n\nWrite the report.`,
    schemaHint: `{
  "headline": "one-line summary in Hebrew",
  "attendance_summary": "1-2 sentences on attendance trend (or 'no data')",
  "marketing_summary":  "1-2 sentences on Meta metrics (or 'no data')",
  "correlations": [ "post X seemed to drive attendance Y", "..." ],
  "concerns": [ "short bullet" ],
  "shauls_next_move": "the ONE thing Shaul will do this week (a verb-led sentence: 'I will draft...', 'I will pull...')",
  "have_enough_data": true|false
}`,
  });
  // Grounded: Analyst may benchmark against industry numbers.
  const { json } = await runSubagent({ ai, modelName, prompt, grounded: true });
  return json;
}

// Phase 4: refineCampaign — pull post-level metrics, identify top + bottom
// performers, propose concrete refinements. The CMO presents these as a draft
// for approval; on approval they become agenda items.
export async function refineCampaign({ userId, ai, modelName, metricsBundle = null, hint = {} }) {
  const insights = recentInsights(userId, 14);
  const recent = listPosts(userId).slice(0, 20).map(p => ({
    id: p.id, platform: p.platform, status: p.status,
    published_at: p.published_at,
    caption: (p.caption || '').slice(0, 140),
    permalink: p.permalink,
  }));
  const liveMetrics = metricsBundle || {};

  const prompt = buildPrompt({
    userId,
    role: `You are the Analyst running a refinement loop. The user wants to improve a campaign that is already running. Look at the metrics + recent posts, identify what is working and what isn't, and propose 3-5 concrete refinements that Shaul can act on this week.

Refinements should be CONCRETE: change posting time, swap angle X for angle Y, add CTA, A/B caption length, target a different sub-audience. Avoid generic advice ("post more").`,
    task: `Hint from user/classifier: ${JSON.stringify(hint)}.

Daily metrics (last 14 days):
${JSON.stringify(insights, null, 2)}

Live Meta pull (page + IG insights, recent posts/media):
${JSON.stringify(liveMetrics, null, 2).slice(0, 4000)}

Internal record of recent posts:
${JSON.stringify(recent, null, 2)}

Identify the top + bottom performer (by engagement or reach) and propose refinements.`,
    schemaHint: `{
  "headline": "1-line Hebrew summary of the refinement",
  "top_performer": "post id or short description + why it worked",
  "bottom_performer": "post id or short description + why it underperformed",
  "recommendations": ["concrete refinement 1", "concrete refinement 2", "..."],
  "have_enough_data": true|false
}`,
  });
  const { json } = await runSubagent({ ai, modelName, prompt });
  return json;
}
