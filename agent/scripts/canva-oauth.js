#!/usr/bin/env node
// One-shot Canva PKCE OAuth helper. Run once:
//
//   node agent/scripts/canva-oauth.js
//
// Walks the user through the PKCE dance and prints a refresh token to paste
// into agent/.env as CANVA_REFRESH_TOKEN.
//
// Prereq: set CANVA_CLIENT_ID and CANVA_CLIENT_SECRET in agent/.env (you get
// these from the Canva Developer Portal: https://www.canva.com/developers/).
// Configure the redirect URI in the Canva app settings to match REDIRECT_URI
// below (default: http://localhost:5234/canva-callback).

import crypto from 'crypto';
import http from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dotenv from 'dotenv';
import readline from 'readline';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
dotenv.config({ path: join(__dirname, '..', '.env') });

const CLIENT_ID     = process.env.CANVA_CLIENT_ID;
const CLIENT_SECRET = process.env.CANVA_CLIENT_SECRET;
const REDIRECT_URI  = process.env.CANVA_REDIRECT_URI || 'http://localhost:5234/canva-callback';
const SCOPES        = process.env.CANVA_SCOPES || 'design:meta:read design:content:read design:content:write asset:read asset:write brandtemplate:meta:read';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Set CANVA_CLIENT_ID and CANVA_CLIENT_SECRET in agent/.env first.');
  process.exit(1);
}

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const verifier   = base64url(crypto.randomBytes(32));
const challenge  = base64url(crypto.createHash('sha256').update(verifier).digest());
const state      = base64url(crypto.randomBytes(16));

const authUrl = new URL('https://www.canva.com/api/oauth/authorize');
authUrl.searchParams.set('client_id', CLIENT_ID);
authUrl.searchParams.set('response_type', 'code');
authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
authUrl.searchParams.set('scope', SCOPES);
authUrl.searchParams.set('code_challenge', challenge);
authUrl.searchParams.set('code_challenge_method', 'S256');
authUrl.searchParams.set('state', state);

console.log('\nOpen this URL in your browser:\n');
console.log(authUrl.toString());
console.log('\nIf the redirect goes to localhost, this script will catch it automatically.');
console.log('Otherwise, copy the "code" query param from the redirect URL when prompted.\n');

const port = parseInt(new URL(REDIRECT_URI).port || '5234', 10);

const server = http.createServer(async (req, res) => {
  if (!req.url.startsWith('/canva-callback')) {
    res.writeHead(404).end();
    return;
  }
  const u = new URL(req.url, REDIRECT_URI);
  const code = u.searchParams.get('code');
  const got  = u.searchParams.get('state');
  if (got !== state) {
    res.writeHead(400).end('state mismatch');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<h2>OK — go back to your terminal.</h2>');
  await exchange(code);
  server.close();
});

server.listen(port, () => console.log(`Listening on ${REDIRECT_URI} for the callback…`));

async function exchange(code) {
  try {
    const auth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
    const body = new URLSearchParams({
      grant_type:   'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    });
    const r = await fetch('https://api.canva.com/rest/v1/oauth/token', {
      method:  'POST',
      headers: {
        'Content-Type':  'application/x-www-form-urlencoded',
        Authorization: `Basic ${auth}`,
      },
      body,
    });
    const data = await r.json();
    if (!r.ok) {
      console.error('Token exchange failed:', data);
      process.exit(2);
    }
    console.log('\n✅ Got tokens.');
    console.log('\nAdd this line to agent/.env:\n');
    console.log(`CANVA_REFRESH_TOKEN=${data.refresh_token}\n`);
    console.log('(access_token expires in seconds:', data.expires_in, ')');
    process.exit(0);
  } catch (e) {
    console.error('Exchange error:', e.message);
    process.exit(3);
  }
}

// Manual paste fallback if the listener never fires.
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question('\nOr paste the "code" query param manually (or press Enter to wait for callback): ', async (code) => {
  rl.close();
  if (code && code.trim()) {
    await exchange(code.trim());
    server.close();
  }
});
