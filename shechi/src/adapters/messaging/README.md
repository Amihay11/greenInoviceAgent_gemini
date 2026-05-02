# Messaging adapters

Every adapter must export `start({ onMessage })` where `onMessage` is invoked
with a normalized payload:

```js
{
  user_id:   string,
  text:      string,
  isAudio:   boolean,
  mediaUrl?: string|null,
  reply:     async (text:string) => void,
}
```

The orchestrator never imports anything channel-specific. Adding a new channel
(WhatsApp Cloud API, Telegram, web widget) means adding a new file here and
swapping the import in `src/index.js` behind an env flag.

Current adapters:

| File | Channel | Phase |
|---|---|---|
| `whatsappWebAdapter.js` | `whatsapp-web.js` (browser automation) | 1 (MVP) |
| _todo_ `whatsappCloudAdapter.js` | Official WhatsApp Cloud API | 2 (SaaS) |
| _todo_ `telegramAdapter.js` | Telegram Bot API | 2 |
