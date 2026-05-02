// MCP tool stub — AnkiConnect (https://github.com/FooSoft/anki-connect).
// Generates spaced-repetition flashcards and posts them to Anki via local HTTP.

const ANKI_URL = process.env.ANKI_CONNECT_URL || 'http://localhost:8765';

export async function addCard({ deck = 'Default', front, back, tags = ['shechi'] }) {
  try {
    const res = await fetch(ANKI_URL, {
      method: 'POST',
      body: JSON.stringify({
        action: 'addNote',
        version: 6,
        params: {
          note: {
            deckName: deck,
            modelName: 'Basic',
            fields: { Front: front, Back: back },
            tags,
            options: { allowDuplicate: false },
          },
        },
      }),
    });
    return await res.json();
  } catch (err) {
    return { ok: false, stub: true, note: 'AnkiConnect unreachable', error: err.message };
  }
}
