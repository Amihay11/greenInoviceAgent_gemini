// Mentor sub-agent. This is Shaul speaking directly to the user as their mentor.
// It reads ALL of memory and gives synthesizing, advice-giving responses.
// Also runs the periodic self-reflection that updates learned_insights.

import { buildPrompt, runSubagent } from './common.js';
import {
  recentInteractions, addInsight, addReflection,
  listCampaigns, recentInsights, formatContextForPrompt, buildContextBundle,
} from '../memory.js';

export async function mentorReply({ userId, userMessage, ai, modelName, runGeminiWithTools = null }) {
  const recent = recentInteractions(userId, 10);
  const ctx = formatContextForPrompt(buildContextBundle(userId));

  const systemInstruction = `You are Shaul — Israeli marketing EMPLOYEE. You work FOR this user. You lead, they approve.
Reply in Hebrew (unless the user wrote English). Direct, useful, grounded in what you know about this user.

LONG-TERM MEMORY (what you know about this user):
${ctx || '(empty — start probing carefully)'}

PROACTIVE MODE:
- You are not a chatbot waiting for prompts. You are an expert taking ownership.
- If the user asks for advice, give it AND propose to do the work yourself.
  Example: "אני אכתוב 3 גרסאות לפוסט ואשלח אליך לאישור — להמשיך?"
- If you can already act on what they said, proactively offer to draft posts, schedule events,
  pull metrics, or DM a client. You initiate; they approve.

TOOL USE (when grounded mode is on):
- Google Search: use it for current dates/holidays/competitor moves/trending topics. Cite the source briefly when relevant.
- Calendar tools (if the Calendar MCP is connected): use to read/create events. Read is fine without asking. Mutations should propose first, then the user approves.
- send_whatsapp_message: ONLY use to message a CLIENT (not the user, not yourself). Look up the phone via the GreenInvoice client tool first. The system will show the user a preview and ask for approval — you call the tool ONCE; do not retry.
- Never DM the user themselves — they are the one talking to you.

DISCOVERY: if a key fact is missing (offer / ICP / goal), end with ONE natural follow-up question. Conversational, not a form.

STYLE: 2-5 lines unless asked for depth. No fluff. No "אין ספק" or "מצוין!".`;

  const userText = `## RECENT CONVERSATION (most recent first)
${recent.slice().reverse().map(i => `${i.role.toUpperCase()}: ${i.content}`).join('\n')}

## NEW MESSAGE FROM USER
${userMessage}

Reply now (no JSON, just the message). If you need real-time info or to take action via a tool, use the tools.`;

  // Grounded path: use the shared tool runner from index.js. Mentor gets the
  // full multi-MCP toolset + Google Search + the local send_whatsapp_message
  // declaration. This is what makes Shaul able to research + DM clients in one
  // turn of natural conversation.
  if (runGeminiWithTools) {
    try {
      const { text } = await runGeminiWithTools({
        chatId: userId,
        history: [],
        message: userText,
        systemInstruction,
        includeSendWhatsapp: true,
      });
      return (text || '').trim();
    } catch (err) {
      console.error('[mentor] grounded path failed, falling back:', err.message);
    }
  }

  // Fallback: plain generateContent without tools.
  const res = await ai.models.generateContent({
    model: modelName,
    contents: [{ parts: [{ text: `${systemInstruction}\n\n${userText}` }] }],
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
