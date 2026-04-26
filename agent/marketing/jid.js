// WhatsApp JID normalization. Shared by the inbound allow-list (index.js) and
// the outbound DM tool (send_whatsapp_message).
//
// Accepts: 0527203222, 972527203222, +972-52-720-3222, 972-52-720-3222
// Returns: 972527203222@c.us

export function normalizeJid(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (s.endsWith('@c.us')) return s;
  const digits = s.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return null;
  const intl = digits.startsWith('972') ? digits
    : digits.startsWith('0') ? '972' + digits.slice(1)
    : digits.length === 9 ? '972' + digits
    : '972' + digits;
  return `${intl}@c.us`;
}

export function parseAllowList(envValue) {
  return (envValue || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(normalizeJid)
    .filter(Boolean);
}
