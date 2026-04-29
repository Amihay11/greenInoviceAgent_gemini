#!/usr/bin/env node
// One-shot Gmail OAuth2 helper. Run once:
//
//   node agent/scripts/gmail-oauth.js
//
// Walks you through the Google OAuth2 PKCE dance and prints the tokens to
// paste into agent/.env as GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN.
//
// Prerequisites:
//   1. Go to https://console.cloud.google.com → New project → Enable "Gmail API"
//   2. Credentials → Create OAuth client ID → Desktop app
//   3. Download the JSON or copy client_id + client_secret
//   4. Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in agent/.env
//   5. Run this script: node agent/scripts/gmail-oauth.js

import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dotenv from 'dotenv';
import { google } from 'googleapis';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
dotenv.config({ path: join(__dirname, '..', '.env') });

const CLIENT_ID     = process.env.GMAIL_CLIENT_ID;
const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;
const REDIRECT_URI  = 'http://localhost:5236/gmail-callback';

const SCOPES = [
  'https://mail.google.com/', // full access — needed for SMTP send + IMAP read
];

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('❌  Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in agent/.env first.');
  process.exit(1);
}

const oAuth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const authUrl = oAuth2Client.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',         // forces a refresh_token even if previously granted
  scope: SCOPES,
});

console.log('\nOpen this URL in your browser:\n');
console.log(authUrl);
console.log('\nWaiting for Google to redirect to localhost:5236 ...\n');

const server = createServer(async (req, res) => {
  if (!req.url.startsWith('/gmail-callback')) {
    res.writeHead(404).end();
    return;
  }

  const url    = new URL(req.url, 'http://localhost:5236');
  const code   = url.searchParams.get('code');
  const errMsg = url.searchParams.get('error');

  if (errMsg) {
    res.writeHead(400, { 'Content-Type': 'text/html' });
    res.end(`<h2>Error: ${errMsg}</h2>`);
    server.close();
    process.exit(1);
  }

  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<h2>✅ Done — go back to your terminal.</h2>');

  try {
    const { tokens } = await oAuth2Client.getToken(code);
    console.log('✅  Got tokens!\n');
    console.log('Add these lines to agent/.env:\n');
    console.log(`GMAIL_CLIENT_ID=${CLIENT_ID}`);
    console.log(`GMAIL_CLIENT_SECRET=${CLIENT_SECRET}`);
    console.log(`GMAIL_REFRESH_TOKEN=${tokens.refresh_token}`);
    console.log(`GMAIL_USER=ortaladler5@gmail.com`);
    console.log('\n(access_token expires in seconds:', tokens.expiry_date, ')');
  } catch (err) {
    console.error('❌  Token exchange failed:', err.message);
  }

  server.close();
  process.exit(0);
});

server.listen(5236, () => {
  console.log('Listening on http://localhost:5236/gmail-callback ...');
});
