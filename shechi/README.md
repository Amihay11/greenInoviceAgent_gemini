# Shechi (שחי)

A Cognitive Co-Pilot & Polymath Tutor multi-agent system.

- **Phase 1 (MVP):** Personal tool over `whatsapp-web.js`.
- **Phase 2:** Commercial multi-tenant SaaS for university students.

The architecture is multi-tenant from day one: every DB row is keyed by `user_id`, the messaging channel is hidden behind a swappable adapter, and user-specific knowledge (known domains, custom learning rules) is injected dynamically into prompts at runtime — never hardcoded into agent logic.

## Core capabilities

| Domain | Personas |
|---|---|
| **Cognitive Companion** | Mirror · Sparring Partner · Profiler |
| **Polymath Tutor** | Syllabus Generator · Socratic Engine · Cross-Pollinator |
| **Interview** | Gap Detector · Consent Prompter · Interviewer · Profile Writer |
| **Tools (MCP)** | Mermaid · Python sandbox · PDF/arXiv · Search/Finance · AnkiConnect |

### Self-aware profile filling

When Shechi notices it is missing data about you (an unknown domain, fuzzy mastery, unclear goal, repeated correction), it opens a `profile_gaps` row and proactively offers a short structured **interview**. The Q&A runs across multiple WhatsApp turns and the result is written back into your profile.

## Quick start

```bash
cp .env.example .env       # fill GEMINI_API_KEY
npm install
npm run migrate            # creates shechi.db
npm run seed               # seeds user-1 (you) from profiles/user-1.json
npm start                  # boots the WhatsApp adapter; scan QR
```

## Tech stack

Node.js (ESM) · `better-sqlite3` · `whatsapp-web.js` · `@google/genai` · `dotenv` · `qrcode-terminal`.

## Layout

```
shechi/
├── db/        SQLite schema, migrator, seed
├── src/
│   ├── orchestrator/   profileInjector · intentRouter · gapDetector · voiceFormatter
│   ├── personas/       companion/  tutor/  interview/
│   ├── adapters/       messaging/ (whatsapp-web · IMessagingAdapter)  llm/ (gemini)
│   ├── tools/          MCP tool wrappers
│   └── prompts/        Generic system + persona prompts (NO user specifics)
├── profiles/           File-based profile fallback (user-1.json)
└── tests/
```

## Tests

```bash
npm test
```
