// Mentor sub-agent. This is Shaul speaking directly to the user as their mentor.
// It reads ALL of memory and gives synthesizing, advice-giving responses.
// Also runs the periodic self-reflection that updates learned_insights.

import { buildPrompt, runSubagent } from './common.js';
import {
  recentInteractions, addInsight, addReflection,
  listCampaigns, recentInsights, formatContextForPrompt, buildContextBundle,
} from '../memory.js';

export async function mentorReply({ userId, userMessage, ai, modelName }) {
  const recent = recentInteractions(userId, 10);
  const ctx = formatContextForPrompt(buildContextBundle(userId));

  // Mentor uses the persona but is allowed to write free-form Hebrew (not JSON).
  const prompt = `${ctx ? `${ctx}\n\n` : ''}## RECENT CONVERSATION (most recent first)
${recent.slice().reverse().map(i => `${i.role.toUpperCase()}: ${i.content}`).join('\n')}

## NEW MESSAGE FROM USER
${userMessage}

## YOUR JOB
You are Shaul — Israeli marketing mentor. Reply in Hebrew (unless user wrote English).
Be direct, useful, grounded in what you actually know about this user.
- If the user is asking for advice, give it. One concrete next step is better than five abstract tips.
- If you don't have enough info, ask ONE specific question (not three).
- If their question implies a campaign, suggest "אני יכול לבנות לך קמפיין — שלח mk plan <מטרה>".
- If their question implies a post, suggest "אני יכול לכתוב את זה — שלח mk post <רעיון>".
- Keep it short. 2-5 lines unless they explicitly want depth.
Reply now (no JSON, just the message):`;

  const res = await ai.models.generateContent({
    model: modelName,
    contents: [{ parts: [{ text: prompt }] }],
    config: { temperature: 0.6 },
  });
  return (res.text || '').trim();
}

// Self-reflection: read recent interactions + campaign results, distill what we
// have learned into long-term insights, save a reflection summary.
// This is the "self-awareness / self-adaptation" loop.
export async function reflect({ userId, ai, modelName }) {
  const interactions = recentInteractions(userId, 60);
  const campaigns = listCampaigns(userId);
  const insights = recentInsights(userId, 30);

  const prompt = buildPrompt({
    userId,
    role: `You are Shaul in self-reflection mode. You are evaluating YOUR OWN performance as the user's mentor.
Read everything that happened recently and answer:
  1. What new patterns can you see about THIS user (preferences, what they respond to, what they avoid)?
  2. What worked? What didn't?
  3. What should you do differently next week to be a better mentor for them?
Be honest. If a campaign flopped, say it.`,
    task: `Recent interactions:\n${JSON.stringify(interactions.slice(0, 30), null, 2)}\n\nCampaigns:\n${JSON.stringify(campaigns, null, 2)}\n\nRecent metrics:\n${JSON.stringify(insights, null, 2)}`,
    schemaHint: `{
  "summary": "2-4 sentence reflection in Hebrew",
  "next_moves": "what YOU (Shaul) will adjust next week — 1-3 sentences",
  "new_insights": [
    { "topic": "user_preference|tactic|channel|tone|other", "insight": "short statement", "confidence": 0.0-1.0 }
  ]
}`,
  });
  const { json } = await runSubagent({ ai, modelName, prompt });
  if (!json) return null;

  addReflection({ userId, period: 'weekly', summary: json.summary, next_moves: json.next_moves });
  for (const i of (json.new_insights || [])) {
    if (i?.topic && i?.insight) {
      addInsight({ userId, topic: i.topic, insight: i.insight, confidence: i.confidence ?? 0.6, source: 'reflection' });
    }
  }
  return json;
}
