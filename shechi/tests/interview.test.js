import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.SHECHI_DB_PATH = path.join(os.tmpdir(), `shechi-interview-${Date.now()}-${process.pid}.db`);
// No GEMINI_API_KEY → geminiAdapter uses offline fallback ('{}' for json), so
// profileWriter falls back to {memory:[],summary:'interview completed'}.
delete process.env.GEMINI_API_KEY;

const { db } = await import('../src/db/client.js');
db.exec(fs.readFileSync(path.resolve('db/schema.sql'), 'utf8'));

const { detectGaps } = await import('../src/orchestrator/gapDetector.js');
const { buildOfferIfAny } = await import('../src/personas/interview/consentPrompter.js');
const { runInterview } = await import('../src/personas/interview/interviewer.js');

const profile = {
  user_id: 'user-int',
  display_name: 'I',
  locale: 'en',
  channel: 'whatsapp_web',
  known_domains: [],
  custom_learning_rules: [],
  preferred_personas: 'auto',
  voice_default: false,
};

db.prepare(`INSERT INTO users (user_id, display_name, channel) VALUES (?, ?, 'whatsapp_web')`).run('user-int', 'I');
db.prepare(`INSERT INTO user_profiles (user_id) VALUES (?)`).run('user-int');

test('gapDetector opens a goal_unclear gap on goal language', async () => {
  const opened = await detectGaps({
    profile,
    text: "I want to switch careers to systems programming",
    intent: { domain: 'COMPANION', persona: 'mirror' },
  });
  const goal = opened.find(g => g.gap_kind === 'goal_unclear');
  assert.ok(goal, 'expected a goal_unclear gap to open');
  const row = db.prepare(`SELECT * FROM profile_gaps WHERE user_id = ? AND gap_kind = 'goal_unclear'`).get('user-int');
  assert.equal(row.status, 'open');
});

test('consentPrompter offers an interview and creates a pending_consent session', () => {
  const offer = buildOfferIfAny({ profile });
  assert.match(offer ?? '', /question interview/i);
  const sess = db.prepare(`SELECT * FROM interview_sessions WHERE user_id = ? AND state = 'pending_consent'`).get('user-int');
  assert.ok(sess);
});

test('declining the offer abandons the session and dismisses the gap', async () => {
  const sess = db.prepare(`SELECT id FROM interview_sessions WHERE user_id = ? AND state = 'pending_consent'`).get('user-int');
  const reply = await runInterview({ profile, sessionId: sess.id, text: 'no' });
  assert.match(reply, /won't bring it up|no worries/i);
  const after = db.prepare(`SELECT state FROM interview_sessions WHERE id = ?`).get(sess.id);
  assert.equal(after.state, 'abandoned');
});

test('full happy path: yes → answer Q1..Qn → profile updated, gap resolved', async () => {
  // Re-open a fresh gap and interview
  await detectGaps({
    profile,
    text: 'I want to learn welding',
    intent: { domain: 'COMPANION', persona: 'mirror' },
  });
  const offer = buildOfferIfAny({ profile });
  assert.ok(offer, 'expected a follow-up offer');
  const sess = db.prepare(`SELECT * FROM interview_sessions WHERE user_id = ? AND state = 'pending_consent' ORDER BY id DESC LIMIT 1`).get('user-int');
  const total = JSON.parse(sess.questions_json).length;

  // Consent
  let reply = await runInterview({ profile, sessionId: sess.id, text: 'yes' });
  assert.match(reply, /Question 1\//);

  // Answer all questions
  for (let i = 0; i < total; i++) {
    reply = await runInterview({ profile, sessionId: sess.id, text: `answer ${i + 1}` });
  }
  assert.match(reply, /updated your profile/i);

  const finalSess = db.prepare(`SELECT * FROM interview_sessions WHERE id = ?`).get(sess.id);
  assert.equal(finalSess.state, 'completed');
  if (finalSess.gap_id) {
    const gap = db.prepare(`SELECT status FROM profile_gaps WHERE id = ?`).get(finalSess.gap_id);
    assert.equal(gap.status, 'resolved');
  }
});

test('multi-tenancy: a second user does NOT see user-int gaps or sessions', () => {
  db.prepare(`INSERT INTO users (user_id, display_name, channel) VALUES (?, ?, 'whatsapp_web')`).run('user-2', 'Two');
  const otherSessions = db.prepare(`SELECT COUNT(*) AS n FROM interview_sessions WHERE user_id = ?`).get('user-2');
  assert.equal(otherSessions.n, 0);
  const otherGaps = db.prepare(`SELECT COUNT(*) AS n FROM profile_gaps WHERE user_id = ?`).get('user-2');
  assert.equal(otherGaps.n, 0);
});
