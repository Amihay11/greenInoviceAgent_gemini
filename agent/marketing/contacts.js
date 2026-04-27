// Contact lookup. Wraps the GreenInvoice MCP `client` tool's `search` action.
// Used by the `send_whatsapp_message` flow to find a phone for a client name.
//
// The MCP returns a JSON string in content[0].text. We parse it tolerantly —
// shape varies a bit between schema versions, so we try several known shapes.

import { normalizeJid } from './jid.js';

export async function lookupClient({ name, mcpClient }) {
  if (!name || !mcpClient) return [];
  let res;
  try {
    res = await mcpClient.callTool({
      name: 'client',
      arguments: { action: 'search', data: { name } },
    });
  } catch (err) {
    console.error('[contacts] client.search failed:', err.message);
    return [];
  }
  if (!res?.content || res.content.length === 0) return [];
  let parsed;
  try {
    parsed = JSON.parse(res.content[0].text);
  } catch (_) {
    return [];
  }
  // GreenInvoice returns { items: [...] } typically; sometimes a bare array.
  const items = Array.isArray(parsed) ? parsed
    : Array.isArray(parsed?.items) ? parsed.items
    : Array.isArray(parsed?.clients) ? parsed.clients
    : [];

  return items.map(c => ({
    id: c.id || c.clientId || null,
    name: c.name || c.fullName || c.companyName || null,
    phone: c.phone || c.mobile || c.phone1 || null,
    email: c.email || c.emailAddress || null,
    jid: normalizeJid(c.phone || c.mobile || c.phone1),
  })).filter(c => c.name);
}
