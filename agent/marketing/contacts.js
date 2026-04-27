// Contact lookup. Wraps the GreenInvoice MCP `client` tool's `search` action.
// Used by the `send_whatsapp_message` flow to find a phone for a client name.
//
// The MCP returns a JSON string in content[0].text. We parse it tolerantly —
// shape varies a bit between schema versions, so we try several known shapes.

import { normalizeJid } from './jid.js';

export async function lookupClient({ name, mcpClient, waClient }) {
  if (!name) return [];
  const results = [];
  const seenJids = new Set();

  // 1. Search GreenInvoice MCP
  if (mcpClient) {
    try {
      const res = await mcpClient.callTool({
        name: 'client',
        arguments: { action: 'search', data: { name } },
      });
      if (res?.content && res.content.length > 0) {
        let parsed;
        try { parsed = JSON.parse(res.content[0].text); } catch (_) {}
        const items = Array.isArray(parsed) ? parsed
          : Array.isArray(parsed?.items) ? parsed.items
          : Array.isArray(parsed?.clients) ? parsed.clients
          : [];

        items.forEach(c => {
          const phone = c.phone || c.mobile || c.phone1;
          const jid = normalizeJid(phone);
          if (c.name) {
            results.push({
              id: c.id || c.clientId || null,
              name: c.name || c.fullName || c.companyName,
              phone,
              email: c.email || c.emailAddress || null,
              jid,
              source: 'greeninvoice',
            });
            if (jid) seenJids.add(jid);
          }
        });
      }
    } catch (err) {
      console.error('[contacts] GreenInvoice search failed:', err.message);
    }
  }

  // 2. Search WhatsApp Contacts
  if (waClient) {
    try {
      const contacts = await waClient.getContacts();
      const query = name.toLowerCase();
      const matched = contacts.filter(c => {
        const cName = (c.name || c.pushname || '').toLowerCase();
        return cName.includes(query) && c.isUser;
      });

      matched.forEach(c => {
        const jid = c.id._serialized;
        if (!seenJids.has(jid)) {
          results.push({
            id: jid,
            name: c.name || c.pushname,
            phone: c.number,
            email: null,
            jid,
            source: 'whatsapp',
          });
          seenJids.add(jid);
        }
      });
    } catch (err) {
      console.error('[contacts] WhatsApp search failed:', err.message);
    }
  }

  return results;
}
