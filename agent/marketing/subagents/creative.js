// Creative sub-agent. Generates ad copy, captions, hooks, and image briefs
// tuned to the user's brand voice + ICP from long-term memory.

import { buildPrompt, runSubagent } from './common.js';

export async function draftPost({ userId, brief, platform = 'instagram', ai, modelName, styleHint = null }) {
  const prompt = buildPrompt({
    userId,
    role: `You are the Creative — the copywriter of the marketing department.
You write ad copy, captions, hooks, and image briefs that match the user's brand voice and resonate with their ICP.
You do NOT post anything. You only draft.
Always tailor to the platform conventions:
  - instagram: hook in first line, short paragraphs, 5-10 relevant hashtags, native to the feed
  - facebook: slightly longer is OK, 1-3 hashtags max, conversational
  - story: 1-2 lines, emoji-light, urgency/curiosity`,
    task: `Brief from the user: "${brief}"\nPlatform: ${platform}\nDraft ONE post.`,
    schemaHint: `{
  "platform": "${platform}",
  "headline": "short hook / first line",
  "body": "the post body, ready to publish, in Hebrew unless brief is English",
  "hashtags": "#tag1 #tag2 ...",
  "image_brief": "1-2 sentence visual description for an image to pair with this post",
  "rationale": "one sentence on why this will work for THIS user's ICP"
}`,
    extra: styleHint ? `BRAND VISUAL STYLE (derived from existing Canva designs — match this):\n${styleHint}` : '',
  });
  const { json } = await runSubagent({ ai, modelName, prompt });
  return json;
}

export async function draftVariations({ userId, brief, platform = 'instagram', count = 3, ai, modelName }) {
  const prompt = buildPrompt({
    userId,
    role: 'You are the Creative. Generate multiple distinct angles for the same brief — different hooks, tones, and creative approaches.',
    task: `Brief: "${brief}"\nPlatform: ${platform}\nProduce ${count} DISTINCT variations (different angles, not paraphrases).`,
    schemaHint: `{
  "variations": [
    { "angle": "short label", "headline": "...", "body": "...", "hashtags": "...", "image_brief": "..." },
    ...
  ]
}`,
  });
  const { json } = await runSubagent({ ai, modelName, prompt });
  return json?.variations || [];
}
