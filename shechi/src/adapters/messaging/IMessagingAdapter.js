// Interface contract every messaging adapter must satisfy.
// Documented as JSDoc; concrete adapters are plain ESM modules whose exported
// `start` returns an async iterator of normalized inbound payloads.
//
// Normalized inbound payload:
//   {
//     user_id:   string,    // stable per-user id (e.g. WhatsApp wid, Telegram chat id)
//     text:      string,
//     isAudio:   boolean,
//     mediaUrl?: string|null,
//     reply:     async (text:string) => void,   // sends a reply on the same channel
//   }
//
// To add a new channel for Phase 2:
//   1. Implement `start({ onMessage })` so onMessage(payload) is invoked per inbound message.
//   2. Update src/index.js to import the new adapter behind an env flag.

export const ADAPTER_CONTRACT = Object.freeze({
  required: ['start'],
  payloadShape: ['user_id', 'text', 'isAudio', 'reply'],
});
