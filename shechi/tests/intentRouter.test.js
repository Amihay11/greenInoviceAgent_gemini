import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.SHECHI_DB_PATH = path.join(os.tmpdir(), `shechi-router-${Date.now()}-${process.pid}.db`);

const { db } = await import('../src/db/client.js');
db.exec(fs.readFileSync(path.resolve('db/schema.sql'), 'utf8'));

const { routeIntent } = await import('../src/orchestrator/intentRouter.js');

const profile = {
  user_id: 'user-router',
  display_name: 'R',
  locale: 'en',
  channel: 'whatsapp_web',
  known_domains: [],
  custom_learning_rules: [],
  preferred_personas: 'auto',
  voice_default: false,
};

db.prepare(`INSERT INTO users (user_id, display_name, channel) VALUES (?, ?, 'whatsapp_web')`).run('user-router', 'R');

test('"Teach me Fourier transforms" → TUTOR', async () => {
  const r = await routeIntent({ text: 'Teach me Fourier transforms', profile });
  assert.equal(r.domain, 'TUTOR');
  assert.match(r.persona, /^(syllabus|socratic)$/);
});

test('"Should I learn Rust or Zig next?" → COMPANION/sparring', async () => {
  const r = await routeIntent({ text: "Should I learn Rust or Zig next?", profile });
  assert.equal(r.domain, 'COMPANION');
  assert.equal(r.persona, 'sparring');
});

test('"I am stuck deciding between two job offers" → COMPANION', async () => {
  const r = await routeIntent({ text: "I'm stuck deciding between two job offers", profile });
  assert.equal(r.domain, 'COMPANION');
});

test('mermaid block → TOOL_CALL/mermaid', async () => {
  const r = await routeIntent({ text: '```mermaid\nflowchart TD\nA --> B\n```', profile });
  assert.equal(r.domain, 'TOOL_CALL');
  assert.equal(r.persona, 'mermaid');
});

test('Hebrew tutor request → TUTOR', async () => {
  const r = await routeIntent({ text: 'תסביר לי קונבולוציה', profile });
  assert.equal(r.domain, 'TUTOR');
});

test('active interview session takes over routing', async () => {
  db.prepare(`INSERT INTO interview_sessions (user_id, gap_id, topic, state, questions_json)
              VALUES (?, NULL, 'topic', 'in_progress', ?)`).run('user-router', JSON.stringify([{ q: 'q1' }]));
  const r = await routeIntent({ text: 'totally unrelated', profile });
  assert.equal(r.domain, 'INTERVIEW');
  assert.equal(r.persona, 'interviewer');
  assert.ok(r.session_id);
});
