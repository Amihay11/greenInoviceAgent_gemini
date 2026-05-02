import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.SHECHI_DB_PATH = path.join(os.tmpdir(), `shechi-test-${Date.now()}-${process.pid}.db`);

const { db } = await import('../src/db/client.js');
db.exec(fs.readFileSync(path.resolve('db/schema.sql'), 'utf8'));

const { loadProfile, injectProfile } = await import('../src/orchestrator/profileInjector.js');

const BASE_PROMPT = '# Shechi base\nGeneric polymath tutor.';
const PROFILE = {
  user_id: 'user-test',
  display_name: 'TestUser',
  locale: 'en',
  channel: 'whatsapp_web',
  known_domains: [{ name: 'Electrical/Algorithm Engineering', tags: ['LTE', 'DSP'] }],
  custom_learning_rules: [
    { id: 'english-b2-to-c1', trigger: "input_language == 'en'", action: 'Begin reply with phrasing correction.', negative: 'Hebrew input' },
  ],
  preferred_personas: 'auto',
  voice_default: false,
};

test('injectProfile inserts known_domains and custom rules', () => {
  const out = injectProfile(BASE_PROMPT, PROFILE, { isAudio: false });
  assert.match(out, /LTE/);
  assert.match(out, /english-b2-to-c1/);
  assert.match(out, /OUTPUT MODE: TEXT/);
});

test('base prompt itself contains no user specifics (separation of concerns)', () => {
  assert.doesNotMatch(BASE_PROMPT, /LTE/);
  assert.doesNotMatch(BASE_PROMPT, /english-b2-to-c1/);
});

test('audio mode strips Markdown/LaTeX guidance from voice block', () => {
  const out = injectProfile(BASE_PROMPT, PROFILE, { isAudio: true });
  assert.match(out, /OUTPUT MODE: AUDIO/);
  assert.match(out, /NO Markdown/);
});

test('loadProfile falls back to JSON file when DB row is missing', () => {
  const tmp = path.resolve('profiles/__test_fallback.json');
  fs.writeFileSync(tmp, JSON.stringify({ ...PROFILE, user_id: '__test_fallback' }));
  try {
    const p = loadProfile('__test_fallback');
    assert.equal(p.user_id, '__test_fallback');
    assert.equal(p.known_domains[0].name, 'Electrical/Algorithm Engineering');
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('loadProfile reads from DB when row exists', () => {
  db.prepare(`INSERT INTO users (user_id, display_name, channel, locale) VALUES (?, ?, 'whatsapp_web', 'en')`)
    .run('user-db', 'DBUser');
  db.prepare(`INSERT INTO user_profiles (user_id, known_domains_json, custom_rules_json) VALUES (?, ?, ?)`)
    .run('user-db', JSON.stringify([{ name: 'Music', tags: ['piano'] }]), '[]');

  const p = loadProfile('user-db');
  assert.equal(p.display_name, 'DBUser');
  assert.equal(p.known_domains[0].name, 'Music');
});
