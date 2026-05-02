// Renders ```mermaid blocks in a reply to PNG using @mermaid-js/mermaid-cli.
// Returns { pngPath } or null if no mermaid block is present / mmdc is missing.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const MERMAID_RE = /```mermaid\s*([\s\S]*?)```/i;

export async function renderIfPresent(text) {
  const m = text.match(MERMAID_RE);
  if (!m) return null;

  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'shechi-mermaid-'));
  const inFile  = path.join(tmpdir, 'diagram.mmd');
  const outFile = path.join(tmpdir, 'diagram.png');
  fs.writeFileSync(inFile, m[1]);

  return new Promise(resolve => {
    const p = spawn('npx', ['mmdc', '-i', inFile, '-o', outFile, '-b', 'transparent'], {
      stdio: 'ignore',
    });
    p.on('exit', code => resolve(code === 0 ? { pngPath: outFile } : null));
    p.on('error', () => resolve(null));
  });
}
