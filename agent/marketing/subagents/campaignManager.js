// Campaign Manager sub-agent. Plans campaigns end-to-end:
// objective → audience → channel mix → budget split → schedule → KPIs.

import { buildPrompt, runSubagent } from './common.js';

export async function planCampaign({ userId, goal, ai, modelName }) {
  const prompt = buildPrompt({
    userId,
    role: `You are the Campaign Manager. Plan a marketing campaign that hits the user's stated goal, given their budget, ICP, and brand voice from memory.
Be specific and actionable. No fluff. The plan must be something the Creative and Publisher can execute without asking further questions.`,
    task: `User goal: "${goal}"\nDesign a complete campaign plan.`,
    schemaHint: `{
  "name": "short campaign name",
  "objective": "one of: awareness, engagement, leads, sales, retention",
  "kpi": "the single most important number to track and its target",
  "audience": "description of who this targets — interests, demographics, behaviors",
  "channel_mix": [ { "channel": "instagram|facebook|email|other", "percent": 0-100, "rationale": "why" } ],
  "budget_total": number,
  "duration_days": number,
  "starts_on": "YYYY-MM-DD",
  "ends_on": "YYYY-MM-DD",
  "content_plan": [
    { "day": 1, "platform": "instagram", "type": "post|reel|story|ad", "brief": "what to publish" },
    ...
  ],
  "risks": "1-2 sentences on what could go wrong",
  "first_action": "the very first thing to do today"
}
Use the user's monthly_budget from memory to set budget_total proportionally; if budget is 0, plan organic only.`,
  });
  const { json } = await runSubagent({ ai, modelName, prompt });
  return json;
}

export async function reviewCampaign({ userId, campaign, recentInsights, ai, modelName }) {
  const prompt = buildPrompt({
    userId,
    role: 'You are the Campaign Manager. Review a running campaign against its KPIs and recent metrics. Recommend specific adjustments.',
    task: `Campaign:\n${JSON.stringify(campaign, null, 2)}\n\nRecent metrics:\n${JSON.stringify(recentInsights, null, 2)}\n\nIs this campaign working? What should change?`,
    schemaHint: `{
  "verdict": "on_track|needs_adjustment|kill",
  "diagnosis": "one short paragraph",
  "actions": [ "concrete action 1", "concrete action 2", ... ],
  "new_creatives_needed": true|false
}`,
  });
  const { json } = await runSubagent({ ai, modelName, prompt });
  return json;
}
