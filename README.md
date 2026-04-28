# GreenInvoice + Shaul WhatsApp Agent

An AI-powered WhatsApp agent built around **Shaul** — your Israeli business and marketing mentor. Phase 1 connects Shaul to the [GreenInvoice](https://www.greeninvoice.co.il) Israeli invoicing API via Google Gemini and the Model Context Protocol (MCP). **Phase 2 turned Shaul into a full marketing department** with sub-agents (Strategist, Creative, Campaign Manager, Publisher, Analyst, Mentor), Facebook & Instagram publishing, and SQLite long-term memory. **Phase 3 makes Shaul *proactive*** — a marketing employee who leads the agenda, runs dynamic discovery, sends daily briefings, drafts work for your approval, and tracks real outcomes (workshop attendance) alongside Meta metrics. **Phase 4 makes Shaul private, conversational, and connected** — an inbound allow-list, plain-Hebrew commands (no `mk` prefix needed), Google Calendar via MCP, Canva style-matched designs, internet grounding, and proactive WhatsApp DMs to clients (always with your approval). Final publishing and outbound DMs are always your decision.

---

## Table of Contents

- [How It Works](#how-it-works)
- [Commands](#commands)
- [Phase 2: Shaul as Marketing Department](#phase-2-shaul-as-marketing-department)
- [Phase 3: Shaul as Your Marketing Employee](#phase-3-shaul-as-your-marketing-employee)
- [Phase 4: Private, Connected Shaul](#phase-4-private-connected-shaul)
- [Departments & Agents Reference](#departments--agents-reference)
- [Architecture](#architecture)
- [File Structure](#file-structure)
- [Setup — Windows](#setup--windows)
- [Setup — Android (Termux)](#setup--android-termux)
- [Environment Variables](#environment-variables)
- [Notion Memory Setup](#notion-memory-setup)
- [Adding New Commands](#adding-new-commands)
- [Adding New MCP Tools](#adding-new-mcp-tools)
- [Managing the Agent](#managing-the-agent)
- [Troubleshooting](#troubleshooting)

---

## How It Works

1. You send a WhatsApp message to your own linked number starting with a command prefix.
2. The agent (Node.js + `whatsapp-web.js`) receives the message.
3. For `mc` commands it passes the message to **Google Gemini** along with the available GreenInvoice MCP tools.
4. Gemini decides which tool to call, the MCP server executes the GreenInvoice API call, and the result is fed back to Gemini.
5. Gemini produces a final reply which is sent back to you on WhatsApp.
6. For `wc`/`gc` commands the agent handles the request directly (no MCP tools needed).

```
Your WhatsApp
      │
      ▼
  Message Router  ──── mc ───▶  Gemini + GreenInvoice MCP  ──▶  GreenInvoice API
      │
      ├── wc + phone  ──▶  wa.me link
      ├── wc + voice  ──▶  Gemini transcription
      ├── gc + text   ──▶  Gemini general response
      └── gc + image  ──▶  Gemini vision / OCR
```

---

## Commands

| Prefix | Input | What happens |
|--------|-------|-------------|
| `mc` | Any text | GreenInvoice invoicing task via Gemini + MCP |
| `wc 0541234567` | Israeli phone number | Returns `https://wa.me/972541234567` |
| `wc` | Voice note (ptt/audio) | Transcribes voice to text via Gemini |
| `gc what is X` | Any question | General Gemini answer (no invoicing tools) |
| `gc` + image | Image with caption | Gemini analyzes / extracts text from image |
| `note [text]` | Any idea/thought | Saves to Notion with auto-title and auto-tags |
| `note search X` | Search query | Searches your notes via Gemini |
| `note summary` | — | Summarizes today's notes |
| `note weekly` | — | Summarizes this week's notes |
| `note chat [question]` | Question | Gemini answers based on all your notes |
| `note remind [when] [what]` | Natural language | Schedules a WhatsApp reminder |
| `help` / `עזרה` | — | Shows all commands |

### `mc` — Morning Command (GreenInvoice)

The agent replies in Hebrew or English depending on how you write.

Example messages:
```
mc צור חשבונית מס קבלה על סך 5000 שח לאגודה שיתופית עשהאל
mc list all open invoices from this month
mc send invoice #1234 to the client by email
```

Supported GreenInvoice document types:

| Code | Type |
|------|------|
| 300 | חשבון עסקה / דרישת תשלום |
| 305 | חשבונית מס |
| 320 | קבלה |
| 330 | חשבונית מס קבלה |

### `wc` — WhatsApp Command

```
wc 0541234567        →  https://wa.me/972541234567
wc +972-54-123-4567  →  https://wa.me/972541234567
```

Send a voice note (no text prefix needed) → transcription returned.

### `gc` — General Command

```
gc translate this to English: שלום עולם
gc what is the VAT rate in Israel?
```

Send an image with caption `gc` or `gc extract text` → OCR / image analysis.

### `note` — Personal Knowledge Management (Notion)

Requires `NOTION_API_KEY` and `NOTION_NOTES_DB_ID` in `.env` — see [Notion Setup](#notion-setup).

```
note רעיון חדש על שיפור תהליך העבודה שלנו
note רעיון חשוב #פיתוח #רעיונות
note search תהליך עבודה
note summary
note weekly
note chat מה הרעיונות שלי לגבי פיתוח?
note remind מחר ב-9 לבדוק מייל
```

- Use `#hashtags` anywhere in the note text — Gemini also auto-generates tags and merges both.
- Reminders use natural-language time expressions in Hebrew or English.
- All notes are stored in Notion and visible/editable there too.

### `help` / `עזרה`

Returns the full command reference in Hebrew.

---

## Phase 2: Shaul as Marketing Department

Shaul is no longer just a chatbot — he's a **CMO orchestrator** who delegates to a team of specialist sub-agents. Each sub-agent has its own role, system prompt, and tools. Long-term memory lives in a SQLite database you can browse from the dashboard. The architecture follows the Anthropic orchestrator-worker pattern (lead agent + structured-result subagents) with CrewAI-style tiered memory (short-term, long-term, entity, external).

### The team

| Sub-agent | Role | Tools |
|-----------|------|-------|
| **Strategist** | Runs the discovery interview; distills user messages into profile updates | SQL memory |
| **Creative** | Writes ad copy, captions, image briefs, multiple angle variations | Gemini |
| **Campaign Manager** | Plans full campaigns: objective, audience, budget, schedule, KPIs | SQL memory |
| **Publisher** | Pure executor — posts approved drafts to Facebook Page & Instagram Business | Meta Graph API v21 |
| **Analyst** | Pulls daily metrics, writes weekly reports in plain Hebrew | Meta Insights API + SQL |
| **Mentor (Shaul)** | The voice the user hears; synthesises everything; runs weekly self-reflection | All of memory |

### Self-awareness & self-adaptation loop

1. **Onboarding** (first run, `mk onboard`) — Strategist asks 9 progressive questions about your business, ICP, offer, budget, channels, brand voice, constraints. Saved to `business_profile`.
2. **Continuous learning** — every WhatsApp interaction is logged to `interactions`. Sub-agents read `business_profile` + `learned_insights` before every response, so output evolves as Shaul learns you.
3. **Weekly reflection** (`mk reflect`) — Mentor reads the last ~60 interactions + campaign results, writes a `reflections` row, and appends new `learned_insights` (e.g. *"user prefers reels over static posts (conf 0.8)"*). Future replies get grounded in these insights.
4. **Approval gates** — every action that posts to FB/IG, spends money, or saves a major plan requires explicit `אישור` / `approve`. Shaul never publishes on his own.

### `mk` commands

| Command | What it does |
|---|---|
| `mk onboard` | Start (or restart) the discovery interview |
| `mk plan <goal>` | Campaign Manager drafts a complete campaign plan; awaits approval |
| `mk post <idea>` | Creative drafts an Instagram post; awaits approval to publish |
| `mk fb <idea>` | Same, but for Facebook |
| `mk schedule` | List scheduled & pending posts |
| `mk campaigns` | List all your campaigns with status |
| `mk report` | Analyst's plain-Hebrew weekly report |
| `mk reflect` | Trigger Mentor self-reflection — distills new insights |
| `mk memory` | Show the compact context Shaul holds about you |
| `mk help` | Show all `mk` commands |

Plain text without `mk` is also auto-routed: the intent classifier has a new `marketing` category that routes through the CMO.

### Long-term memory (SQLite, viewable in dashboard)

Tables created automatically in `agent/data/shaul-memory.db` on first interaction:

| Table | Holds |
|-------|-------|
| `business_profile` | One row per user — name, industry, offer, ICP, brand voice, budget, channels, constraints |
| `interactions` | Every user/agent message (short-term memory, paginated) |
| `learned_insights` | Distilled long-term lessons with confidence scores |
| `entities` | People, products, competitors mentioned over time |
| `campaigns` | Planned/active/completed campaigns with full plan JSON |
| `creatives` | Drafted copy/captions/image briefs |
| `posts` | Approved/scheduled/published/failed posts on FB/IG |
| `insights_daily` | Daily metric snapshots from Meta |
| `goals` | Tracked goals with target + deadline |
| `reflections` | Weekly self-reflections from the Mentor |

Browse, paginate, and delete rows in your browser at **http://localhost:3001/memory** (linked from the main dashboard).

### Meta API setup (for publishing)

To enable the Publisher sub-agent, fill in `META_PAGE_ID`, `META_PAGE_TOKEN`, and `IG_BUSINESS_ID` in `agent/.env`. Without them, Shaul still drafts campaigns and creatives — they're just saved to memory instead of being posted. Steps to get the tokens are documented in `agent/.env.example`.

Publishing rules enforced:
- Instagram requires an `image_url` — Shaul will hold the post in `pending_image` status until you provide one
- IG container is polled until `FINISHED` before publishing (per Meta's 2-step content publishing API)
- Scheduled posts auto-publish on a 60-second loop once their `scheduled_at` is reached

## Phase 3: Shaul as Your Marketing Employee

Phase 2 gave Shaul a department. **Phase 3 puts him in charge of it.** He behaves like a senior marketing employee who works *for* you, not the other way around. He leads the conversation, sets the agenda, drafts everything for your approval, and only acts when you say "go". Final publishing to Facebook or Instagram is **always** your explicit choice — Shaul never auto-posts, even on a schedule.

The design follows current state-of-the-art proactive-agent patterns ([Anthropic's orchestrator-worker model](https://www.anthropic.com/engineering/multi-agent-research-system) + [2026 agentic-marketing campaign-planner blueprints](https://www.digitalapplied.com/blog/agentic-marketing-2026-ai-runs-campaign-humans-set-strategy)) where the AI runs the strategy and humans set direction.

### What changed from Phase 2

| Phase 2 | Phase 3 |
|---|---|
| Shaul replies when spoken to | Shaul **leads**: daily briefing, agenda, "go" command |
| `mk onboard` was a 9-question form | `mk discovery` asks the **next-best question** dynamically |
| Free-text chat → Mentor reply | Free-text chat → Mentor reply **+ silent extraction** of profile/goals/attendance |
| Scheduled posts auto-published when time hit | Scheduled posts ping you for **final approval** before going live |
| Reports = Meta metrics only | Reports correlate Meta metrics ↔ posts ↔ **workshop attendance** |
| Notes about the business went to Notion | Business strategy is now classified as `marketing` and routes to SQL memory |
| 6 sub-agents (Strategist, Creative, Campaign Mgr, Publisher, Analyst, Mentor) | + **Director** — picks next-best actions, runs daily briefings |

### The proactive loop

1. **Every WhatsApp message** runs in parallel:
   - **Mentor** replies to the user in Shaul's voice
   - **Strategist (silent)** mines the message for `business_profile` updates, goals, entities, and attendance reports
   - **Director** refreshes the agenda based on what's now known
2. **Every morning at 08:00** (configurable via `SHAUL_BRIEFING_HOUR`) Shaul sends a proactive WhatsApp briefing: 3 bullets on what's on the agenda + an invitation to say "יאללה".
3. **When you say "יאללה" / "go"**, Shaul executes the top agenda item immediately — drafts a post, plans a campaign, pulls metrics, etc.
4. **When a scheduled post hits its time**, Shaul nudges you: *"Post #42 is ready, send `mk publish 42` to ship it."* — never auto-publishes.

### New `mk` commands (Phase 3)

| Command | What Shaul does |
|---|---|
| `mk go` | Execute the top agenda item right now |
| `mk agenda` | Show what Shaul plans to do for you |
| `mk briefing` | Generate today's briefing on demand |
| `mk discovery` | Ask the single most-important question Shaul still doesn't know |
| `mk calendar` | 14-day content calendar (drafts + scheduled + published) |
| `mk attendance "סדנת שבת" 12` | Log workshop headcount (and optional revenue) |
| `mk publish 42` | **You** explicitly approve a post — Publisher ships it to FB/IG |
| `mk skip` / `mk skip 42` | Skip the top agenda item (or defer a post) |

Existing `mk plan / mk post / mk fb / mk ig / mk schedule / mk campaigns / mk report / mk reflect / mk memory / mk help / mk onboard` still work.

### New SQL tables

| Table | Purpose |
|---|---|
| `agenda_items` | Director's todo list FOR you — title, detail, kind, priority, status |
| `attendance` | Workshop headcount + revenue per session — the real KPI |
| `discovery_state` | Tracks which discovery hypotheses are confirmed, for dynamic interview |
| `daily_briefings` | One row per day per user — prevents double-briefing |

All viewable in the dashboard memory browser at **http://localhost:3001/memory**.

### How "working FOR you" actually feels

A natural conversation now looks like this (no `mk onboard` needed):

```
You:    הי. זוהי קבוצת חשיבה על איך לשווק את העסק.
Shaul:  נעים מאוד. מה העסק שלך מוכר?
You:    סדנאות אומנות, חוגים, ומשחקי בריחה.
Shaul:  נשמע כיף. מי הקהל העיקרי — הורים שמביאים ילדים, או קבוצות מבוגרים?
        (silently saved: industry=workshops/escape rooms, offer=art workshops & escape rooms)

You:    הורים עם ילדים בני 6-12 בעיקר.
Shaul:  סבבה. אני בונה לך עכשיו תוכנית קמפיין ל-30 יום ומכין 3 פוסטים ראשונים.
        תגיד "יאללה" וזז.
        (Director added: plan_campaign, draft_post×3 to agenda)

You:    יאללה.
Shaul:  🚀 מתחיל: בניית תוכנית קמפיין ל-30 יום
        [Campaign Manager runs]
        ...
```

After 4-5 turns of natural chat, `business_profile`, `goals`, `entities`, and `agenda_items` are all populated — without you ever filling a form.

### Approval-only publishing — explicit guarantees

- No FB/IG post is ever published without you typing the approve word (or `mk publish <id>`).
- Scheduled posts that hit their time → `awaiting_final_approval` status + WhatsApp nudge → you say `mk publish 42` → Publisher ships it.
- The `Publisher` sub-agent is a pure executor — it has no autonomy. It only runs when explicitly invoked.

### Optional environment var

```
SHAUL_BRIEFING_HOUR=8     # Local hour for the daily proactive briefing. Default 8.
```

---

## Phase 4: Private, Connected Shaul

Phase 4 closes three remaining gaps: **privacy** (Shaul should respond only to the owners), **friction** (`mk` commands replaced with plain Hebrew), and **capability** (internet, Calendar, Canva, proactive DMs to clients).

### Inbound allow-list

Set `SHAUL_ALLOWED_NUMBERS` in `agent/.env` to a comma-separated list of phone numbers (any format — `0527203222`, `972527203222`, `+972-52-720-3222` all normalize to the same JID). Messages from anyone outside the list are silently dropped. Empty = accept everyone (default — preserves prior behaviour).

```
SHAUL_ALLOWED_NUMBERS=0527203222,0546736909
```

### Plain-Hebrew commands (no `mk` prefix needed)

Just talk to Shaul in Hebrew. Examples:

| Old | New |
|---|---|
| `mk plan קמפיין לקיץ` | *תכין לי קמפיין לקיץ* |
| `mk post מבצע סוף שנה` | *כתוב פוסט אינסטגרם על מבצע סוף שנה* |
| `mk memory` | *מה אתה זוכר עליי?* |
| `mk go` | *יאללה* |
| (new) | *מה יש לי היום ביומן?* |
| (new) | *תכין לי עיצוב ב-Canva* |
| (new) | *תכתוב לדנה כהן הודעה שתאשר את הסדנה* |
| (new) | *תראה לי איך הקמפיין רץ* |

The classifier is biased toward `none` so casual chat keeps flowing through Mentor mode (where Shaul replies as himself, with internet + DM tools available in-context). `mk` commands still work for back-compat — `mk help` lists them all.

### Internet grounding (Google Search)

Mentor, Director, and Analyst now ground in `googleSearch: {}`. Shaul can answer "מתי סוף שנת הלימודים השנה?", spot timing opportunities, and benchmark against industry numbers. Strategist + Creative deliberately skip grounding to keep voice consistent.

### Google Calendar via MCP

Phase 4 uses an external Google Calendar MCP server (e.g. [nspady/google-calendar-mcp](https://github.com/nspady/google-calendar-mcp)) — no calendar code lives in this repo. Spin up any community Calendar MCP that exposes tools like `list_events` / `create_event`, point `CALENDAR_MCP_PATH` at it, and Shaul will gain those tools automatically.

```
CALENDAR_MCP_PATH=/abs/path/to/google-calendar-mcp/dist/index.js
GOOGLE_CALENDAR_CREDENTIALS=/abs/path/to/credentials.json   # whatever your MCP needs
```

Read-only listings (`list_events`) execute freely. Mutations (`create_event` etc.) are logged to the new `calendar_events` audit table — visible in the dashboard memory browser.

### Canva (explore → derive style → design in style)

Canva Connect REST (no public Canva MCP exists). Setup:

1. Create an integration at https://www.canva.com/developers/ — get `client_id` + `client_secret`.
2. Configure the redirect URI to `http://localhost:5234/canva-callback`.
3. `cd agent && node scripts/canva-oauth.js` — walks the PKCE dance, prints the refresh token to paste into `.env`.

Once configured, ask Shaul: *"תכין לי עיצוב על מבצע סוף שנה"*. He pulls your existing designs, derives a `canva_style_profile` (cached in `marketing_memory`), drafts a caption + visual brief in that style, and asks for two approvals — one for the design, one for the FB/IG publish.

### Proactive WhatsApp DMs to clients

The Mentor sub-agent now has access to a local `send_whatsapp_message` function tool. Tell Shaul: *"תכתוב לדנה כהן הודעה שתאשר את הסדנה"*. He looks up the phone via the GreenInvoice MCP, drafts a message, and proposes sending it. **Nothing is sent until you reply `אשר`** — the approval gate is enforced in code (a structural `pendingApprovals` Map), not by prompt instructions, so you cannot accidentally bypass it. All sent messages are logged to `outbound_messages`.

### Multi-MCP architecture

`agent/index.js:setupMCP()` now loads multiple MCP servers in parallel, each gated by an env var:

- `MCP_SERVER_PATH` — GreenInvoice (mandatory)
- `CALENDAR_MCP_PATH` — Google Calendar (optional)
- `CANVA_MCP_PATH` — Canva (optional, fallback to direct REST)
- `META_MCP_PATH` — Meta (optional, fallback to direct REST in `meta.js`)

Tools from every connected server collapse into the same Gemini function-call namespace (`toolToClientMap`). One uniform code path — Gemini sees `client.search`, `create_event`, and your local `send_whatsapp_message` side by side.

### New SQL tables

| Table | Purpose |
|---|---|
| `calendar_events` | Audit trail of Calendar mutations (start, end, args, response) |
| `outbound_messages` | Every proactive WhatsApp DM Shaul sent on your behalf |
| `marketing_memory` | Generic key/value cache (e.g. `canva_style_profile`) |

All three are visible in the dashboard memory browser at `http://localhost:3001/memory`.

---

## Departments & Agents Reference

A complete bird's-eye view of every department, sub-agent, tool, and integration in the system.

### Departments

| Department | File | Role |
|---|---|---|
| **CMO** | `marketing/cmo.js` | Orchestrator — receives every message, classifies intent, routes to the right sub-agent, enforces approval gates |
| **Mentor** | `subagents/mentor.js` | Free-text conversation, business advice, grounded in long-term memory; has access to Google Search + send_whatsapp_message |
| **Strategist** | `subagents/strategist.js` | Onboarding interview; silently mines every message for profile updates, goals, insights, entities, attendance |
| **Creative** | `subagents/creative.js` | Writes Instagram/Facebook/Story captions, image briefs, hashtags, multiple angle variations |
| **Campaign Manager** | `subagents/campaignManager.js` | End-to-end campaign planning (objective → audience → budget → content calendar → KPIs → risks) + campaign review |
| **Publisher** | `subagents/publisher.js` | Pure executor — posts approved content to Meta API; has no autonomy; only runs on explicit approval |
| **Analyst** | `subagents/analyst.js` | Pulls Meta metrics, writes weekly reports, correlates reach/engagement with workshop attendance |
| **Director** | `subagents/director.js` | Picks the 5 next-best actions for the user each week; composes the daily morning briefing; maintains the agenda |
| **Notes** | `noteHandler.js` | Saves ideas to Notion, semantic search, daily/weekly summaries, voice note processing, reminders |
| **Invoice** | `index.js` → GreenInvoice MCP | Creates invoices, receipts, tax documents; searches clients — all via GreenInvoice API |
| **Personality** | `personality/shaul.js` | Centralised voice, system prompts, UI copy, greeting templates |
| **Memory (SQLite)** | `marketing/memory.js` | Fast read/write layer for all long-term state (14 tables) |
| **Memory (Notion)** | `marketing/notion-memory.js` | Write-through mirror of the 4 human-readable tables to Notion databases |

---

### Sub-Agents in Detail

#### Strategist
- `startOnboarding()` — 9-step discovery interview
- `answerOnboarding()` — Processes and saves each answer
- `proposeProfileUpdates()` — Silent: mines every message for profile/goals/insights/entities/attendance
- `nextDiscoveryQuestion()` — Picks the highest-value gap question dynamically

#### Creative
- `draftPost(brief, platform)` — Caption + image brief + hashtags for IG/FB/Story
- `draftVariations(brief)` — 3+ distinct creative angles for the same brief

#### Campaign Manager
- `planCampaign(goal)` — Full campaign: objective, audience, channel mix, budget, content calendar, risks
- `reviewCampaign(id, metricsBundle)` — Audits running campaign vs. KPIs, recommends adjustments

#### Publisher
- `publishPost(post)` — Executes Meta publish (FB page feed or IG 2-step container)
- `schedulePost(post, scheduled_at)` — Marks post as scheduled (no publish yet)

#### Analyst
- `pullDailyInsights(userId)` — Fetches FB Page + IG metrics, stores in `insights_daily`
- `weeklyReport(userId)` — Synthesises Meta metrics + posts + attendance into plain-Hebrew report
- `refineCampaign(userId, metricsBundle)` — Proposes concrete adjustments based on live data

#### Director
- `nextBestActions(userId)` — Decides 5 highest-leverage actions for the week
- `refreshAgenda(userId)` — Deduplicates and persists new agenda items
- `composeDailyBriefing(userId)` — One WhatsApp message: 3 top items + call-to-action
- `maybeRunDailyBriefing(userId)` — Checks if already briefed today, then sends

#### Mentor
- `mentorReply(userId, message)` — Free-text response grounded in memory + conversation history; can call Google Search and send_whatsapp_message
- `reflect(userId)` — Reads last 60 interactions + campaigns + insights, distils new learned_insights

---

### All User-Facing Commands

#### Agenda & Control
| Command | What it does |
|---|---|
| `mk go` / `יאללה` | Execute the top agenda item right now |
| `mk agenda` / *מה יש באג'נדה* | Show pending agenda items |
| `mk skip [id]` | Defer the top item or a specific post |
| `mk cleanup` | Remove stale agenda items older than 14 days |

#### Content & Marketing
| Command | What it does |
|---|---|
| `mk post <brief>` / `mk ig` / `mk fb` | Draft an Instagram or Facebook post |
| `mk plan <goal>` / *תכין קמפיין* | Campaign planner (objective → full plan → approval) |
| `mk canva <brief>` / *תכין עיצוב* | Canva design: derive style → draft → create → publish |
| `mk schedule` / `mk calendar` | View scheduled and pending posts |

#### Analytics & Reports
| Command | What it does |
|---|---|
| `mk report` / *תראה דוח* | Weekly plain-Hebrew report (Meta + attendance) |
| `mk campaigns` | List all campaigns with status |
| `mk attendance "<label>" <count> [revenue]` | Log workshop headcount and optional revenue |

#### Memory & Learning
| Command | What it does |
|---|---|
| `mk memory` / *מה אתה זוכר עליי* | Show Shaul's full memory context |
| `mk reflect` | Trigger self-reflection — distils new insights |
| `mk discovery` / *שאל אותי שאלה* | Ask the single most important unknown question |
| `mk onboard` | Restart the 9-step discovery interview |

#### Calendar
| Command | What it does |
|---|---|
| `mk today` / *מה יש לי היום* | Google Calendar 24-hour view |
| `mk meet <details>` / *קבע פגישה* | Create a Google Calendar event |

#### Communication
| Command | What it does |
|---|---|
| `mk dm <client name>` / *כתוב ל...* | Draft + send WhatsApp DM to client (approval required) |
| `mk briefing` | Generate today's briefing on demand |
| `mk publish <id>` | Approve and publish a specific post to FB/IG |

#### Notes (Notion)
| Command | What it does |
|---|---|
| `note <text>` | Save an idea to Notion with auto-title and auto-tags |
| `note search <query>` | Semantic search across all saved notes |
| `note summary` | Summarise today's notes |
| `note weekly` | Summarise this week's notes |
| `note chat <question>` | Ask a question about your saved notes |
| `note remind <time> <what>` | Set a natural-language reminder |

#### Invoicing (GreenInvoice)
Triggered automatically by any invoicing intent, or with the legacy `mc` prefix:
```
mc צור חשבונית מס קבלה על סך 5000 שח לאגודה שיתופית עשהאל
mc list all open invoices from this month
```

---

### Message Flow

```
WhatsApp message received
        │
        ├─ Voice note? ──────────────────────► Voice menu (transcribe / analyze / save)
        │
        ├─ Pending intent confirmation? ──────► handleIntentConfirm() → execute
        │
        ├─ "help" / "עזרה"? ─────────────────► HELP_TEXT
        │
        ├─ Image attachment? ─────────────────► Gemini vision / OCR
        │
        ├─ Bare phone number? ───────────────► wa.me link
        │
        └─ Any other text
                │
                ▼
        classifyIntent()
                │
                ├─ invoice / note_* ──────────► Confirmation menu → execute on approval
                │
                └─ general / marketing ───────► CMO (no menu friction)
                                                       │
                                          classifyMarketingAction()
                                                       │
                                          ┌────────────┴────────────┐
                                          │                         │
                                    specific action             none / chat
                                          │                         │
                                   dispatch → subagent         Mentor reply
                                          │                         │
                                   approval gate             silentExtraction()
                                          │                  refreshAgenda()
                                   executeApproved()
```

**Approval gate pattern** — enforced in code, not by prompt:
```
action drafted → setPending(chatId, kind, payload)
user replies "אישור" / "כן" / "אשר"
    → takePending(chatId) → executeApproved()
```
Every action that publishes to FB/IG, sends a WhatsApp DM to a client, or saves a major plan requires this explicit gate. TTL: 10 minutes.

---

### External Integrations

| Service | Purpose | Required env vars |
|---|---|---|
| **Google Gemini** (`gemini-2.5-pro`) | All AI reasoning — every sub-agent | `GEMINI_API_KEY`, `GEMINI_MODEL` |
| **GreenInvoice MCP** | Invoices, receipts, tax docs, client search | `MCP_SERVER_PATH`, `GREENINVOICE_API_ID`, `GREENINVOICE_API_SECRET` |
| **Google Calendar MCP** | Read/create calendar events | `CALENDAR_MCP_PATH`, `GOOGLE_*` credentials |
| **Meta Graph API v21** | Publish to Facebook Page + Instagram Business; pull insights | `META_PAGE_ID`, `META_PAGE_TOKEN`, `IG_BUSINESS_ID` |
| **Canva Connect REST** | Create and export designs | `CANVA_CLIENT_ID`, `CANVA_CLIENT_SECRET`, `CANVA_REFRESH_TOKEN` |
| **Notion API** | Save notes (`note` command) + Notion memory mirror | `NOTION_API_KEY`, `NOTION_NOTES_DB_ID`, `NOTION_MEMORY_PARENT_PAGE_ID` |
| **Gmail IMAP/SMTP** | Parallel email channel (same pipeline as WhatsApp) | `EMAIL_USER`, `EMAIL_PASSWORD` |
| **WhatsApp Web** | Primary user channel | `ENABLE_WHATSAPP`, `WHATSAPP_PHONE` |
| **SQLite** | All long-term memory (14 tables, fast reads) | `SHAUL_DB_PATH` (optional, defaults to `agent/data/shaul-memory.db`) |

---

### Memory Tables

#### Synced to Notion (human-readable, editable)
| Table | Notion database | What it holds |
|---|---|---|
| `business_profile` | 🏢 פרופיל עסקי | Business name, industry, offer, ICP, brand voice, budget, channels |
| `learned_insights` | 💡 תובנות שאול | Distilled lessons with confidence scores (e.g. "user prefers Reels") |
| `goals` | 🎯 מטרות עסקיות | Active goals with metric, target, and deadline |
| `agenda_items` | 📋 אג׳נדה שאול | Shaul's todo list for the user — status synced on completion/skip |

#### SQLite only (operational / high-volume)
| Table | What it holds |
|---|---|
| `interactions` | Every user + agent message (short-term context window) |
| `campaigns` | Planned/active/completed campaigns with full plan JSON |
| `creatives` | Ad copy, captions, image briefs |
| `posts` | FB/IG posts with status lifecycle (draft → approved → published) |
| `insights_daily` | Daily Meta metrics (reach, impressions, engagements, spend) |
| `attendance` | Workshop headcount + revenue per session |
| `reflections` | Mentor's weekly self-evaluations |
| `calendar_events` | Audit trail of Calendar mutations |
| `outbound_messages` | Every proactive WhatsApp DM sent on your behalf |
| `marketing_memory` | Generic key/value cache (e.g. `canva_style_profile`, Notion DB IDs) |
| `discovery_state` | Which discovery hypotheses Shaul has confirmed |
| `daily_briefings` | One row per day — prevents double-briefing |

All tables are readable in the dashboard at **http://localhost:3001/memory**.

---

## Architecture

```
greenInoviceAgent_gemini/
├── agent/                        # Node.js WhatsApp agent
│   ├── index.js                  # Main router + daily briefing scheduler
│   ├── noteHandler.js            # Notion integration
│   ├── personality/shaul.js      # Persona, prompts, copy
│   └── marketing/                # Phase 2/3 — marketing department
│       ├── cmo.js                # Orchestrator (CMO) — silent extraction, agenda execution
│       ├── memory.js             # SQLite long-term memory (14 tables)
│       ├── meta.js               # Facebook + Instagram Graph API
│       └── subagents/
│           ├── common.js         # Shared prompt builder
│           ├── strategist.js     # Onboarding + silent extraction + dynamic discovery
│           ├── creative.js       # Copy & image briefs
│           ├── campaignManager.js
│           ├── publisher.js      # Pure FB/IG publishing executor (manual-trigger only)
│           ├── analyst.js        # Insights + weekly reports (correlates with attendance)
│           ├── mentor.js         # Proactive voice + self-reflection
│           └── director.js       # Phase 3 — picks next-best actions, runs daily briefings
└── GreenInvoice-MCP-main/        # TypeScript MCP server
    └── src/
        ├── index.ts              # MCP server entry
        ├── client.ts             # GreenInvoice API HTTP client
        └── tools.ts              # 10 MCP tools (66 API endpoints)
```

### Message Router (`agent/index.js`)

The `client.on('message')` handler is a clean router:

```javascript
// ptt/audio  →  handleVoiceTranscription(msg)
// mc         →  handleMorningCommand(msg)      ← uses MCP + Gemini
// wc         →  handleWcCommand(msg)
// gc         →  handleGcCommand(msg)
```

Each handler is a standalone `async function` — easy to add more.

### MCP Tools

The MCP server exposes 10 resource-based tools, each with an `action` parameter:

| Tool | Key actions |
|------|-------------|
| `document` | search, get, create, update, send, add_payment, download_links |
| `client` | search, get, create, update, delete, update_balance |
| `supplier` | search, get, create, update, delete |
| `item` | search, get, create, update, delete |
| `expense` | search, get, create, update, close |
| `payment` | create_link, charge_token, get_link_status |
| `business` | get, settings, upload_file |
| `account` | get, settings |
| `webhook` | create, get, delete |
| `reference_data` | countries, cities, currencies, occupations |

---

## File Structure

```
greenInoviceAgent_gemini/
│
├── agent/
│   ├── index.js            Main agent — router + all handlers
│   ├── noteHandler.js      note command — Notion integration + reminders
│   ├── package.json        Node.js dependencies
│   └── .env.example        Template for all environment variables
│
├── GreenInvoice-MCP-main/
│   ├── src/
│   │   ├── index.ts        MCP server entry point
│   │   ├── client.ts       GreenInvoice API client (auth, rate-limit, retry)
│   │   └── tools.ts        All 10 MCP tool registrations
│   ├── dist/               Compiled JS (created by npm run build)
│   └── package.json
│
├── setup-android.sh        One-shot Android/Termux setup script
├── start.sh                Foreground launcher (created by setup script)
├── start-background.sh     Background launcher (nohup + PID file)
├── stop.sh                 Stop the background agent
└── README.md               This file
```

---

## Setup — Windows

### Prerequisites
- Node.js 18+
- Google Chrome
- Git

### Steps

1. Clone the repo:
   ```powershell
   git clone https://github.com/Amihay11/greenInoviceAgent_gemini.git
   cd greenInoviceAgent_gemini
   ```

2. Build the MCP server:
   ```powershell
   cd GreenInvoice-MCP-main
   npm install
   npm run build
   cd ..
   ```

3. Install agent dependencies:
   ```powershell
   cd agent
   npm install
   ```

4. Create `agent/.env` from `agent/.env.example` and fill in all values — see [Environment Variables](#environment-variables).

5. Start for the first time (to pair WhatsApp):
   ```powershell
   node index.js
   ```
   Scan the QR code with WhatsApp → Linked Devices → Link a Device. Once you see `WhatsApp Client is ready!` press `Ctrl+C`.

6. **Run in background**: double-click `agent/run-agent-hidden.vbs`. A tray icon appears — right-click to view logs or stop.

7. **Auto-start on Windows boot**: copy `run-agent-hidden.vbs` to your `shell:startup` folder.

---

## Setup — Android (Termux)

Run the one-shot setup script — it installs everything and asks for credentials interactively:

```bash
curl -fsSL https://raw.githubusercontent.com/Amihay11/greenInoviceAgent_gemini/claude/whatsapp-agent-commands-hljQR/setup-android.sh | bash
```

### Auto-start on boot

1. Install **Termux:Boot** from [F-Droid](https://f-droid.org) (not the Play Store).
2. Open the Termux:Boot app once to activate it.
3. Done — the agent starts automatically on every reboot.

### Managing the agent on Android

```bash
~/greenInoviceAgent/start-background.sh   # start hidden
~/greenInoviceAgent/stop.sh               # stop
tail -f ~/greenInoviceAgent/agent.log     # live logs
```

---

## Environment Variables

Copy `agent/.env.example` to `agent/.env` and fill in:

| Variable | Required | Description |
|----------|----------|-------------|
| `GEMINI_API_KEY` | ✅ | Google Gemini API key |
| `GREENINVOICE_API_ID` | ✅ | GreenInvoice API ID |
| `GREENINVOICE_API_SECRET` | ✅ | GreenInvoice API secret |
| `MCP_SERVER_PATH` | ✅ | Absolute path to `GreenInvoice-MCP-main/dist/index.js` |
| `ENABLE_WHATSAPP` | ✅ | Set to `true` to enable WhatsApp listener |
| `WHATSAPP_PHONE` | — | Your number in international format without `+` (e.g. `972541234567`). When set, shows a pairing code instead of QR on first login. |
| `NODE_EXECUTABLE` | — | Path to `node` binary. Defaults to `node` on PATH (correct for Android/Linux). Windows may need the full path. |
| `CHROME_EXECUTABLE_PATH` | — | Path to Chrome/Chromium. Leave unset to use Puppeteer's bundled Chromium. |
| `GREENINVOICE_SANDBOX` | — | Set to `true` to use the GreenInvoice sandbox environment. |
| `NOTION_API_KEY` | — | Notion integration API key. Required for the `note` command. |
| `NOTION_NOTES_DB_ID` | — | Notion database ID for storing notes. Required for the `note` command. |
| `EMAIL_USER` | — | Gmail address for the optional email agent. |
| `EMAIL_PASSWORD` | — | Gmail app password for the email agent. |

---

## Notion Setup

The `note` command stores your ideas in a Notion database. One-time setup:

1. Go to [https://www.notion.so/my-integrations](https://www.notion.so/my-integrations) → **New integration** → give it a name → **Submit**.
2. Copy the **Internal Integration Token** (starts with `secret_`) → this is your `NOTION_API_KEY`.
3. In Notion, create a new **full-page database** (not inline). Name it e.g. "Ideas & Notes".
4. Add these properties to the database (exact names required):

   | Property name | Type |
   |--------------|------|
   | `Title` | Title (default — rename if needed) |
   | `Content` | Text |
   | `Tags` | Multi-select |
   | `Type` | Select |
   | `Created` | Date |

5. Open the database, click **...** (top-right) → **Add connections** → select your integration.
6. Copy the **database ID** from the URL:  
   `https://www.notion.so/workspace/`**`xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`**`?v=...`  
   This is your `NOTION_NOTES_DB_ID`.
7. Add both values to `agent/.env`:
   ```
   NOTION_API_KEY=secret_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   NOTION_NOTES_DB_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   ```

---

## Notion Memory Setup

Shaul can mirror 4 key memory tables to Notion so you can view and edit them directly: your business profile, learned insights, goals, and agenda.

**Prerequisites:** `NOTION_API_KEY` already set (same key used for the `note` command).

### Steps

1. **Create a new blank page** in Notion (not a table — a regular page). Name it e.g. `🧠 זיכרון שאול`.

2. **Connect the integration** to that page: open the page → `...` → **Connections** → select your integration.

3. **Add to `agent/.env`:**
   ```env
   NOTION_MEMORY_PARENT_PAGE_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   ```
   The page ID is the 32-character hex string at the end of the page URL.

4. **Create the databases** (one-time, run from the `agent/` directory):
   ```bash
   node scripts/setup-notion-memory.js
   ```
   This creates 4 databases under your page: 🏢 פרופיל עסקי, 💡 תובנות שאול, 🎯 מטרות עסקיות, 📋 אג׳נדה שאול.

5. **Restart the agent.** From now on, every profile update, new insight, new goal, and new agenda item is automatically synced to Notion. Agenda status (done / skipped) is synced in real time.

> **Note:** Notion is a write-through mirror — SQLite is still the source of truth for fast reads. A Notion API failure never blocks the agent.

---

## Adding New Commands

All command handlers live in `agent/index.js`. To add a new prefix (e.g. `sc` for scheduling):

**1. Write the handler** — add it after the existing handlers (~line 255):

```javascript
async function handleScCommand(msg) {
  const commandBody = msg.body.trim().replace(/^sc\s*/i, '').trim();
  await client.sendMessage(msg.from, '⏳ Processing...');

  try {
    const result = await ai.models.generateContent({
      model: modelName,
      contents: [{ parts: [{ text: commandBody }] }],
      config: { systemInstruction: 'You are a scheduling assistant. Reply in the same language as the user.' }
    });
    await client.sendMessage(msg.from, result.text);
  } catch (err) {
    console.error('SC error:', err);
    await client.sendMessage(msg.from, 'Error processing request.');
  }
}
```

**2. Add it to the router** — in the `client.on('message')` block:

```javascript
} else if (msgText.startsWith('sc')) {
  await handleScCommand(msg);
}
```

No other files need to change.

### Handler patterns reference

| Pattern | Use when |
|---------|----------|
| `ai.models.generateContent({ contents: [{ parts }] })` | Stateless one-shot Gemini call |
| `ai.chats.create({ history })` + `chat.sendMessage()` | Multi-turn conversation with memory |
| Add `{ inlineData: { mimeType, data } }` to `parts` | Message has media (image/audio) to process |
| Add `tools: [{ functionDeclarations: mcpTools }]` to config | Command needs GreenInvoice API access |

---

## Web Dashboard

A lightweight browser-based GUI to control the agent — no extra npm packages required.

### Start the dashboard

```bash
~/greenInoviceAgent/dashboard-start.sh
```

Then open **http://localhost:3001** in your phone's browser.

To access from another device on the same Wi-Fi network, use your phone's LAN IP:
```
http://192.168.x.x:3001
```

### Features

| Feature | Description |
|---------|-------------|
| Status indicator | Pulsing green dot when running, shows PID + uptime |
| Start / Stop / Restart | One-tap agent control |
| Live log stream | New log lines appear in real time (Server-Sent Events) |
| Download logs | Download the full `agent.log` file |
| Auto-scroll | Pauses when you scroll up, resumes when you scroll back down |

### Custom port

```bash
DASHBOARD_PORT=8080 ~/greenInoviceAgent/dashboard-start.sh
```

### Auto-start on boot

The setup script already adds the dashboard to `~/.termux/boot/start-agent.sh` so it starts automatically alongside the agent on every reboot.

To stop the dashboard manually:
```bash
kill $(cat ~/greenInoviceAgent/dashboard.pid)
```

---

## Adding New MCP Tools

MCP tools live in `GreenInvoice-MCP-main/src/tools.ts`.

**To add a new action to an existing tool** (e.g. a new document action):

```typescript
case "my_new_action":
  return json(await client.post("/documents/my-endpoint", data));
```

Add the new value to the `z.enum([...])` for that tool's `action` parameter.

**To register a brand-new tool:**

```typescript
server.tool(
  "my_tool",
  "Description of what this tool does",
  {
    action: z.enum(["list", "get", "create"]).describe("Action to perform"),
    data: z.string().optional().describe("JSON string of parameters"),
  },
  async ({ action, data: raw }) => {
    const data = parseData(raw);
    switch (action) {
      case "list":  return json(await client.get("/my-endpoint"));
      case "get":   return json(await client.get(`/my-endpoint/${data.id}`));
      case "create": return json(await client.post("/my-endpoint", data));
    }
  }
);
```

After any change, rebuild and restart:

```bash
cd GreenInvoice-MCP-main && npm run build
# then restart the agent
```

Gemini discovers all tools dynamically on startup via `mcpClient.listTools()` — no changes to `agent/index.js` needed.

---

## Managing the Agent

### Windows

Double-click `agent/run-agent-hidden.vbs` to start silently in the system tray.  
Right-click the tray icon → **View Logs** / **Stop Agent**.

To auto-start: copy `run-agent-hidden.vbs` to `shell:startup`.

### Android

```bash
~/greenInoviceAgent/start-background.sh          # start in background
~/greenInoviceAgent/stop.sh                      # stop
tail -f ~/greenInoviceAgent/agent.log            # live logs
~/greenInoviceAgent/stop.sh && ~/greenInoviceAgent/start-background.sh  # restart
```

### Re-pairing WhatsApp

The session is saved in `agent/whatsapp-auth/`. To re-pair:

```bash
rm -rf ~/greenInoviceAgent/agent/whatsapp-auth
~/greenInoviceAgent/start.sh
```

If `WHATSAPP_PHONE` is set you'll get a pairing code; otherwise scan the QR code.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `Cannot find package 'whatsapp-web.js'` | npm install incomplete | `cd agent && npm install` |
| `MCP_SERVER_PATH is not set` | Missing `.env` entry | Add `MCP_SERVER_PATH=` to `agent/.env` |
| Agent responds but says "authentication error" | Wrong GreenInvoice credentials | Re-enter `GREENINVOICE_API_ID` / `GREENINVOICE_API_SECRET` in `.env` |
| `window.onCodeReceivedEvent is not a function` | Outdated whatsapp-web.js npm version | `rm -rf agent/node_modules && cd agent && npm install` |
| Pairing code error, falls back to QR | WhatsApp API timing | Delete `agent/whatsapp-auth/`, restart, wait ~5s for the code |
| `chromium not found` on Android | Chromium not installed | `pkg install x11-repo && pkg update -y && pkg install chromium` |
| Hash mismatch on Termux package | Corrupted third-party mirror | Switch to official mirror: `echo "deb https://packages-cf.termux.dev/apt/termux-main stable main" > $PREFIX/etc/apt/sources.list && apt-get update` |
| Agent killed when phone sleeps | Missing wake lock | Ensure `~/.termux/boot/start-agent.sh` runs `termux-wake-lock` |
| `MCP server not starting` on Android | Wrong `MCP_SERVER_PATH` | Verify: `ls $(grep MCP_SERVER_PATH ~/greenInoviceAgent/agent/.env \| cut -d= -f2)` |
