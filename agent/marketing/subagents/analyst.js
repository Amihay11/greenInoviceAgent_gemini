// Analyst sub-agent. Pulls insights from Meta, stores daily metrics,
// and explains them in plain Hebrew with concrete next steps.

import { buildPrompt, runSubagent } from './common.js';
import * as meta from '../meta.js';
import { upsertDailyInsight, recentInsights } from '../memory.js';

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
  const prompt = buildPrompt({
    userId,
    role: `You are the Analyst. Read the metrics and give the user a plain-Hebrew weekly report.
Be honest. If numbers are low, say so. If you don't have enough data, say that too — don't invent.
Always end with the single most important thing to do this week.`,
    task: `Recent insights (last 14 days):\n${JSON.stringify(insights, null, 2)}\n\nWrite the weekly report.`,
    schemaHint: `{
  "headline": "one-line summary in Hebrew",
  "highlights": [ "short bullet 1", "short bullet 2", ... ],
  "concerns": [ "short bullet" ],
  "this_week_focus": "the ONE thing to focus on next 7 days",
  "have_enough_data": true|false
}`,
  });
  const { json } = await runSubagent({ ai, modelName, prompt });
  return json;
}
