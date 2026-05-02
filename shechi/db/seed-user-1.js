import fs from 'node:fs';
import path from 'node:path';
import { db } from '../src/db/client.js';

const PROFILE_PATH = path.resolve('profiles/user-1.json');
const profile = JSON.parse(fs.readFileSync(PROFILE_PATH, 'utf8'));

const upsertUser = db.prepare(`
  INSERT INTO users (user_id, display_name, channel, locale, status)
  VALUES (@user_id, @display_name, @channel, @locale, 'active')
  ON CONFLICT(user_id) DO UPDATE SET
    display_name = excluded.display_name,
    channel      = excluded.channel,
    locale       = excluded.locale
`);

const upsertProfile = db.prepare(`
  INSERT INTO user_profiles (user_id, known_domains_json, custom_rules_json, preferred_personas, voice_default, updated_at)
  VALUES (@user_id, @known_domains_json, @custom_rules_json, @preferred_personas, @voice_default, strftime('%s','now'))
  ON CONFLICT(user_id) DO UPDATE SET
    known_domains_json = excluded.known_domains_json,
    custom_rules_json  = excluded.custom_rules_json,
    preferred_personas = excluded.preferred_personas,
    voice_default      = excluded.voice_default,
    updated_at         = excluded.updated_at
`);

const tx = db.transaction(p => {
  upsertUser.run(p);
  upsertProfile.run({
    user_id: p.user_id,
    known_domains_json: JSON.stringify(p.known_domains ?? []),
    custom_rules_json: JSON.stringify(p.custom_learning_rules ?? []),
    preferred_personas: p.preferred_personas ?? 'auto',
    voice_default: p.voice_default ? 1 : 0,
  });
});

tx(profile);

console.log(`seeded user_id=${profile.user_id} (${profile.display_name})`);
