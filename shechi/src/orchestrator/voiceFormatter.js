// Strips Markdown / code blocks / LaTeX so the text can be safely TTS'd.
// Used only when payload.isAudio === true.

export function formatForVoice(text, { isAudio = false } = {}) {
  if (!isAudio || typeof text !== 'string') return text;

  let out = text;
  // Remove fenced code blocks (incl. ```mermaid)
  out = out.replace(/```[\s\S]*?```/g, '');
  // Remove inline code
  out = out.replace(/`([^`]+)`/g, '$1');
  // Strip headings
  out = out.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  // Bold / italic markers
  out = out.replace(/(\*\*|__)(.*?)\1/g, '$2').replace(/(\*|_)(.*?)\1/g, '$2');
  // Display LaTeX $$...$$
  out = out.replace(/\$\$[\s\S]*?\$\$/g, '');
  // Inline LaTeX $...$
  out = out.replace(/\$[^$\n]+\$/g, '');
  // Markdown links: [text](url) -> text
  out = out.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  // Tables: drop separator lines and pipes
  out = out.replace(/^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/gm, '');
  out = out.replace(/\|/g, ' ');
  // Collapse blank lines
  out = out.replace(/\n{3,}/g, '\n\n').trim();

  return out;
}
