// Mentor sub-agent. Shaul speaking directly to the user as their marketing employee.
// Also runs the periodic self-reflection that updates learned_insights.

import { buildPrompt, runSubagent } from './common.js';
import {
  recentInteractions, addInsight, addReflection,
  listCampaigns, recentInsights,
} from '../memory.js';
import { buildCoreMemoryBlock, detectTopic } from '../coreMemory.js';
import { recallEpisodic, recallSemantic, recallProcedural, formatRecallForPrompt } from '../longTerm.js';
import { nearForgettingItems } from '../forgetting.js';
import { buildToolsBlock } from '../../personality/shaul.js';

export async function mentorReply({ userId, userMessage, ai, modelName, runGeminiWithTools = null, toolsBlock = '', sessionHistory = [] }) {
  // Layer 2: always-in-context core block (anti-nag filtered)
  const coreCtx = buildCoreMemoryBlock(userId, { currentUserMessage: userMessage });

  // Layer 3: on-demand retrieval — only when the message references something specific
  const currentTopic = detectTopic(userMessage);
  const needsHistory = /זוכר|היה|בעבר|אתמול|שבוע שעבר|קמפיין|remember|last|previous|earlier/i.test(userMessage);
  let recallCtx = '';
  if (needsHistory || currentTopic) {
    const episodic   = recallEpisodic({ userId, query: userMessage, k: 3 });
    const semantic   = recallSemantic({ userId, query: userMessage, k: 3 });
    const procedural = recallProcedural({ userId, query: userMessage, k: 3 });
    const recalled   = [...episodic, ...semantic, ...procedural];
    if (recalled.length) recallCtx = `\n\n## RELEVANT MEMORY (retrieved)\n${formatRecallForPrompt(recalled)}`;
  }

  const systemInstruction = `You are Shaul — a senior Israeli marketing professional working for the user. The user is your boss.

WORKING RELATIONSHIP:
- Stay focused on the topic the user just raised. Do NOT redirect to previous topics unless they reopen them.
- You may offer to take action on what the user JUST said — once, briefly. Never twice in a row on the same topic.
- If a key fact is missing AND it blocks doing good work on the current topic right now, ask one short question. Otherwise, just answer.
- When you disagree, say it once with a reason, then accept the boss's call.

${toolsBlock || buildToolsBlock({})}

STYLE: 2–5 lines unless asked for depth. Polite, professional, warm. No hollow filler. No "אין ספק", "מצוין!", "Absolutely!".
Reply in Hebrew unless the user wrote English.`;

  const userText = `## WHAT YOU KNOW ABOUT THIS USER
${coreCtx || '(no profile yet — ask one gentle question to get started)'}${recallCtx}

## NEW MESSAGE FROM USER
${userMessage}

Reply now (plain text, no JSON). Use tools if you need real-time data or to take action.`;

  if (runGeminiWithTools) {
    try {
      const { text } = await runGeminiWithTools({
        chatId: userId,
        history: sessionHistory,
        message: userText,
        systemInstruction,
        includeSendWhatsapp: true,
        includeSendEmail: true,
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

// Self-reflection: distill recent interactions into long-term insights.
export async function reflect({ userId, ai, modelName }) {
  const interactions = recentInteractions(userId, 60);
  const campaigns    = listCampaigns(userId);
  const insights     = recentInsights(userId, 30);

  const fadingItems = nearForgettingItems(userId, 5);
  const fadingNote = fadingItems.length > 0
    ? `\n\nItems close to being forgotten (you haven't accessed them in a while):\n${fadingItems.map(i => `  - [${i.table}] ${i.text} (activation: ${i.activation.toFixed(3)})`).join('\n')}\nFor each one: should you recall it explicitly now, or let it fade?`
    : '';

  const prompt = buildPrompt({
    userId,
    role: `You are Shaul in self-reflection mode. Evaluate YOUR OWN performance as the user's marketing employee.
Read everything that happened recently and answer:
  1. What new patterns can you see about THIS user (preferences, what they respond to, what they avoid)?
  2. What worked? What didn't?
  3. What should you adjust next week to serve them better?
Be honest. If a campaign flopped, say it.`,
    task: `Recent interactions:\n${JSON.stringify(interactions.slice(0, 30), null, 2)}\n\nCampaigns:\n${JSON.stringify(campaigns, null, 2)}\n\nRecent metrics:\n${JSON.stringify(insights, null, 2)}${fadingNote}`,
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
