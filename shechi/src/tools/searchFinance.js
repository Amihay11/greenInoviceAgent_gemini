// MCP tool stub — search + finance API.
// Implement with your search provider and finance API of choice.

export async function search({ query }) {
  return { ok: false, stub: true, note: 'search not implemented', query };
}

export async function getQuote({ symbol }) {
  return { ok: false, stub: true, note: 'getQuote not implemented', symbol };
}
