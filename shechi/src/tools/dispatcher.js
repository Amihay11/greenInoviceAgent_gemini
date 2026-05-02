// Routes a TOOL_CALL intent to the right MCP tool wrapper.

import { renderIfPresent } from './mermaidRenderer.js';
import { runPython } from './pythonSandbox.js';
import { readPaper } from './pdfArxivReader.js';
import { search, getQuote } from './searchFinance.js';
import { addCard } from './ankiConnect.js';
import { gemini } from '../adapters/llm/geminiAdapter.js';

export async function runTool({ systemPrompt, profile, intent, text, mediaUrl }) {
  switch (intent.persona) {
    case 'mermaid': {
      const out = await renderIfPresent(text);
      return out
        ? `Rendered diagram → ${out.pngPath}`
        : 'I see a mermaid block but mmdc is not installed. Run `npm i -D @mermaid-js/mermaid-cli`.';
    }
    case 'python': {
      const code = (text.match(/```(?:python)?\s*([\s\S]*?)```/)?.[1] ?? text).trim();
      const r = await runPython({ code });
      return JSON.stringify(r, null, 2);
    }
    case 'pdf': {
      const url = text.match(/https?:\/\/\S+/)?.[0] ?? '';
      const r = await readPaper({ url });
      return JSON.stringify(r, null, 2);
    }
    case 'anki': {
      const reply = await gemini.generate({
        system: 'Generate Anki flashcards as strict JSON [{"front":"...","back":"..."}] (max 5).',
        user: text,
        json: true,
      });
      let cards = [];
      try { cards = JSON.parse(reply); } catch { cards = []; }
      const results = await Promise.all(cards.map(c => addCard({ deck: 'Shechi', front: c.front, back: c.back })));
      return `Created ${results.length} cards.`;
    }
    case 'search':
    default: {
      const r = await search({ query: text });
      return JSON.stringify(r, null, 2);
    }
  }
}
