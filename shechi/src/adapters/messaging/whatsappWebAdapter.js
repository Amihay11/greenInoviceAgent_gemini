// Phase 1 adapter using whatsapp-web.js. In Phase 2 swap this file for the
// official Cloud API or Telegram adapter — orchestrator stays untouched.

import pkg from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
import { db } from '../../db/client.js';

const { Client, LocalAuth } = pkg;

const upsertUser = db.prepare(`
  INSERT INTO users (user_id, display_name, channel, locale, status)
  VALUES (?, ?, 'whatsapp_web', 'en', 'active')
  ON CONFLICT(user_id) DO NOTHING
`);

export async function start({ onMessage }) {
  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: '.wwebjs_auth' }),
    puppeteer: { args: ['--no-sandbox', '--disable-setuid-sandbox'] },
  });

  client.on('qr', qr => {
    console.log('Scan this QR with WhatsApp → Linked devices:');
    qrcode.generate(qr, { small: true });
  });

  client.on('ready', () => console.log('whatsapp-web adapter: ready'));
  client.on('auth_failure', m => console.error('auth_failure', m));
  client.on('disconnected', m => console.warn('disconnected', m));

  client.on('message', async msg => {
    try {
      if (msg.fromMe) return;
      const user_id = msg.from;
      const isAudio = msg.type === 'ptt' || msg.type === 'audio';
      const text = msg.body ?? '';
      upsertUser.run(user_id, msg._data?.notifyName ?? user_id);

      const payload = {
        user_id,
        text,
        isAudio,
        mediaUrl: null,
        reply: async (out) => msg.reply(out),
      };
      const reply = await onMessage(payload);
      if (reply) await msg.reply(reply);
    } catch (err) {
      console.error('message handler error:', err);
    }
  });

  await client.initialize();
  return client;
}
