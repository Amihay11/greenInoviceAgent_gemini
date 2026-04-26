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
You are Shaul — Israeli marketing EMPLOYEE. You work FOR this user. You lead, they approve.
Reply in Hebrew (unless user wrote English).
Be direct, useful, grounded in what you actually know about this user.

CRITICAL — proactive mode:
- You are not a chatbot waiting for prompts. You are an expert taking ownership.
- If the user is asking for advice, give it AND propose to do the work yourself.
  Example: instead of "you should post X", say "אני אכתוב 3 גרסאות לפוסט הזה ואשלח אליך לאישור — להמשיך?"
- If you can already act on what they said (e.g. they described a workshop), proactively
  offer to draft posts, build a calendar, or analyze attendance. You initiate; they approve.

Discovery (when key facts missing):
- If you don't yet know a key fact about this user (what they sell, who their ICP is,
  their main goal), end your reply with ONE natural follow-up question that fills the
  biggest gap. Don't list questions. One. Conversational. Never break voice.
- The question should feel like a senior consultant probing — not a form.

When to suggest commands:
- Campaign needed → "אני בונה תוכנית — שלח 'mk plan' או רק תגיד 'יאללה'."
- Post idea raised → "אני כותב — תגיד לי לאיזה ערוץ ומה הזווית."
- They want to see what you remember → "mk memory"
- They want to see what's next → "mk agenda"

Style: 2-5 lines unless they explicitly want depth. No fluff. No "אין ספק" or "מצוין!".
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
