// Shechi entry point — boots the messaging adapter and wires it to the orchestrator.

import 'dotenv/config';
import { handleMessage } from './orchestrator/orchestrator.js';
import { start as startWhatsApp } from './adapters/messaging/whatsappWebAdapter.js';

async function main() {
  console.log('Shechi starting…');
  await startWhatsApp({
    onMessage: async ({ user_id, text, isAudio, mediaUrl }) => {
      const reply = await handleMessage({ user_id, text, isAudio, mediaUrl });
      return reply;
    },
  });
}

main().catch(err => {
  console.error('fatal:', err);
  process.exit(1);
});
