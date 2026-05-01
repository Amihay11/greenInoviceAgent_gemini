# Shaul — AI Marketing Department on WhatsApp

**Shaul** (שאול) is a senior Israeli marketing professional who lives in your WhatsApp. He manages your marketing strategy, drafts posts and campaigns, tracks performance, and proactively suggests the next move — all in Hebrew, all with your approval before anything goes live.

Under the hood: Node.js + `whatsapp-web.js` + Google Gemini + MCP + SQLite + Meta Graph API + Canva + Google Calendar + Notion.

---

## Table of Contents

- [How It Works](#how-it-works)
- [Architecture Overview](#architecture-overview)
- [Memory Architecture](#memory-architecture)
- [Sub-Agents](#sub-agents)
- [Commands](#commands)
- [Proactive Engine](#proactive-engine)
- [Analytics Feedback Loop](#analytics-feedback-loop)
- [AI Model Control](#ai-model-control)
- [Notion Mirror (Bidirectional)](#notion-mirror-bidirectional)
- [Integrations](#integrations)
- [Web Dashboard](#web-dashboard)
- [Setup — Windows](#setup--windows)
- [Setup — Android (Termux)](#setup--android-termux)
- [Environment Variables](#environment-variables)
- [File Structure](#file-structure)
- [Troubleshooting](#troubleshooting)

---

## How It Works

1. You send a WhatsApp message to your own linked number.
2. The router in `agent/index.js` classifies the intent (marketing, invoice, note, voice, general).
3. For marketing: the **CMO** orchestrator routes to the right sub-agent, injects the core memory block, and returns Shaul's reply.
4. For GreenInvoice invoicing: Gemini + the GreenInvoice MCP server handle the API call.
5. For notes: stored in Notion.
6. Every reply also runs a **silent extraction** pass (Strategist mines new profile data) and a **Director refresh** (updates the agenda).

```
Your WhatsApp
      │
      ▼
  Intent Router (index.js)
      │
      ├── marketing ──▶  CMO (cmo.js)
      │                    ├── Mentor       (free chat, advice)
      │                    ├── Creative     (posts, copy)
      │                    ├── Strategist   (silent extraction)
      │                    ├── Campaign Mgr (campaign plans)
      │                    ├── Publisher    (FB/IG executor)
      │                    ├── Analyst      (metrics, reports)
      │                    └── Director     (agenda, briefings)
      │
      ├── invoice ───▶  Gemini + GreenInvoice MCP ──▶ GreenInvoice API
      ├── note ──────▶  Notion
      ├── voice ─────▶  Gemini transcription
      └── general ───▶  Gemini (grounded)
```

---

## Architecture Overview

### Orchestrator-Worker Pattern

The CMO (`cmo.js`) is the lead agent. It never calls sub-agents in parallel for the same user turn — it routes to one specialist, waits for structured JSON output, formats it as Hebrew prose, and replies. Background work (silent extraction + agenda refresh) runs fire-and-forget after the reply is sent.

### Approval Gates

Every action that posts to Facebook/Instagram, spends money, sends a WhatsApp DM to a client, or commits a major plan requires explicit user approval (`אישור` / `כן` / `yes`). Approval is enforced by a structural `pendingApprovals` Map in `cmo.js` — not by prompt instructions. Shaul physically cannot publish without your confirmation.

### Multi-MCP Architecture

`setupMCP()` in `index.js` loads multiple MCP servers in parallel, each gated by an env var:

| Env var | Server | Purpose |
|---|---|---|
| `MCP_SERVER_PATH` | GreenInvoice | Invoices, clients, payments (required) |
| `CALENDAR_MCP_PATH` | Google Calendar | Schedule, events, follow-ups |

Tools from every connected server collapse into one Gemini function-call namespace. One code path — Gemini sees `client.search`, `create_event`, and local tools (`send_whatsapp_message`, `snooze_agenda_item`, etc.) side by side.

---

## Memory Architecture

Shaul uses a four-layer memory system. All layers live in SQLite (`agent/data/shaul-memory.db`) — fast, local, queryable, always available.

### Layer 1 — Persistent Storage (SQLite)

All tables are written on every turn and survive restarts.

| Table | What it holds |
|---|---|
| `business_profile` | Brand identity: name, industry, offer, ICP, voice, budget, channels, constraints |
| `interactions` | Every user + agent message (paginated short-term memory) |
| `learned_insights` | Distilled long-term lessons with confidence scores (e.g. "user prefers reels") |
| `entities` | People, products, competitors mentioned over time |
| `campaigns` | Planned/active/completed campaigns with full plan JSON |
| `creatives` | Drafted copy, headlines, hashtags, image briefs |
| `posts` | FB/IG posts with status, `format_tags`, `performance_score` |
| `insights_daily` | Daily metric snapshots from Meta (reach, CTR, engagement, spend) |
| `goals` | Active goals with target + deadline |
| `reflections` | Weekly Mentor self-evaluations |
| `agenda_items` | Director's todo list for the user — with anti-nag columns |
| `attendance` | Workshop headcount + revenue per session |
| `discovery_state` | Tracks which discovery hypotheses are confirmed |
| `daily_briefings` | One row per day — prevents double-briefing |
| `calendar_events` | Audit trail of Calendar mutations |
| `outbound_messages` | Every proactive WhatsApp DM sent on your behalf |
| `marketing_memory` | Generic key/value store (style profiles, pinned facts, active model) |

### Layer 2 — Core Memory Block (`coreMemory.js`)

Injected into **every** Mentor reply (~1 KB). Contains only what's needed on this turn:

- Business profile essentials (name, offer, ICP, voice, channels)
- Top 3 active goals
- Pinned facts (things you told Shaul to always remember)
- Up to 3 agenda items that pass the **anti-nag filter**
- Last reflection one-liner

**Anti-nag filter** — agenda items are suppressed if:
- **Cooldown not elapsed**: cooldown = `24h × 2^nudge_count` (24h → 48h → 96h → 192h → 384h). Items bump their `nudge_count` each time Shaul mentions them in a reply.
- **Stale**: salience score = `0.5^(age_days/7) × priority/10` drops below 0.1
- **Wrong topic**: if the user's current message is about "campaign" and the item is tagged "budget", it's suppressed for this turn

### Layer 3 — Long-Term Retrieval (`longTerm.js`)

Called **only** when the user's message references the past or a specific topic (keywords like "זוכר", "בעבר", "קמפיין", etc.). Three CoALA-style sub-stores:

| Store | What it retrieves | Half-life |
|---|---|---|
| Episodic | Past conversations, attendance, calendar events | 14 days |
| Semantic | Insights, goals, entity relationships | 30 days |
| Procedural | Campaigns, post history, reflections | 21 days |

**Composite scoring**: `score = 0.5 × similarity + 0.3 × recency + 0.2 × importance`
- Similarity: token-overlap ratio (Hebrew + English)
- Recency: `0.5^(age_days / half_life)`
- Importance: confidence / priority normalized to [0,1]

Top-k results are injected as a `## RELEVANT MEMORY` block below the core block.

### Layer 4 — External Mirror (Notion)

Notion is a **human-readable mirror** of SQLite — not the primary store. See [Notion Mirror](#notion-mirror-bidirectional).

---

## Sub-Agents

| Sub-agent | File | Role |
|---|---|---|
| **CMO** | `cmo.js` | Orchestrator — routes, approval gates, silent extraction, proactivity budget |
| **Mentor** | `mentor.js` | Shaul's voice — free chat, advice, action offers. Uses Layer 2+3 memory |
| **Strategist** | `strategist.js` | Silent extraction — mines profile/goals/entities/attendance from every message |
| **Creative** | `creative.js` | Drafts posts, copy, image briefs. Injects winning format patterns |
| **Campaign Manager** | `campaignManager.js` | Plans full campaigns (objective, audience, budget, schedule, KPIs) |
| **Publisher** | `publisher.js` | Pure FB/IG executor — only runs on explicit user approval |
| **Analyst** | `analyst.js` | Pulls Meta metrics, writes Hebrew reports, correlates with attendance |
| **Director** | `director.js` | Picks next-best actions, builds agenda, runs daily briefings |

### Personality

Shaul is a **warm professional colleague**, not a lecturer. Key rules (from `personality/shaul.js`):

- Stays focused on the topic the user just raised — no redirecting
- Polite and professional; Israeli warmth is natural, not theatrical
- Says things once — no repetition, no summaries of what was just said
- One follow-up question max — only when the answer is genuinely needed right now
- When disagreeing: says it once with a reason, then accepts the boss's call
- No hollow filler: "מעולה!", "Absolutely!", "אין ספק!" are banned

---

## Commands

### Plain Hebrew (no prefix needed)

Just talk to Shaul. The intent classifier maps natural phrases to actions:

| Say | What happens |
|---|---|
| *תכין לי קמפיין לקיץ* | Campaign Manager drafts a full plan |
| *כתוב פוסט אינסטגרם על מבצע* | Creative drafts an IG post |
| *כתוב פוסט פייסבוק* | Creative drafts a FB post |
| *יאללה / קדימה / תעבוד* | Director executes top agenda item |
| *מה יש לי היום ביומן?* | Shows today's Google Calendar events |
| *מה יש בלוח התוכן?* | Shows the content calendar |
| *תראה לי את הקמפיינים* | Lists all campaigns |
| *מה אתה זוכר עליי?* | Shows compact memory |
| *תראה לי איך הקמפיין רץ* | Pulls Meta insights |
| *תכין עיצוב ב-Canva* | Designs a Canva visual in brand style |
| *תכתוב לדנה כהן הודעה שתאשר* | Drafts a WhatsApp DM to a client (approval-gated) |
| *תעזוב את הפוסט לפייסבוק* | Snoozes that agenda item for 3 days |
| *snooze 7* | Snoozes agenda item #7 |
| *תפסיק להזכיר לי על תקציב* | Mutes the "budget" topic for 7 days |
| *סיימתי עם פוסט 5* | Marks agenda item #5 as done |
| *שמור ש...* | Pins a fact Shaul should always remember |
| *עבור ל-gemini-2.5-flash* | Switches the AI model |
| *איזה מודל אתה משתמש?* | Lists available models |

### `mk` commands (explicit prefix, always work)

| Command | What it does |
|---|---|
| `mk agenda` | Show what Shaul plans to do for you |
| `mk briefing` | Generate today's briefing on demand |
| `mk go` | Execute the top agenda item |
| `mk plan <goal>` | Campaign Manager drafts a full plan |
| `mk post <idea>` | Creative drafts an Instagram post |
| `mk fb <idea>` | Creative drafts a Facebook post |
| `mk ig <idea>` | Same as `mk post` |
| `mk canva <idea>` | Design a Canva visual in brand style |
| `mk schedule` | List scheduled & pending posts |
| `mk calendar` | 14-day content calendar |
| `mk campaigns` | List all campaigns with status |
| `mk report` | Analyst's weekly Hebrew report |
| `mk reflect` | Trigger weekly self-reflection |
| `mk memory` | Show the compact context block |
| `mk discovery` | Ask the single most-important missing question |
| `mk attendance "<label>" <count>` | Log workshop headcount + optional revenue |
| `mk publish <id>` | Explicitly publish a saved post to FB/IG |
| `mk skip <id>` | Skip / defer a post |
| `mk cleanup` | Remove stale agenda items, refresh |
| `mk model <id>` | Switch the AI model (e.g. `mk model gemini-2.5-flash`) |
| `mk models` | List all available models |
| `mk briefing` | Generate today's briefing on demand |
| `mk onboard` | (Re)start the discovery interview |
| `mk help` | Show all mk commands |

### GreenInvoice commands

Any message starting with `mc`:

```
mc צור חשבונית מס קבלה על סך 5000 שח לאגודה שיתופית עשהאל
mc list all open invoices from this month
mc send invoice #1234 to the client by email
```

### Notes (Notion)

```
note רעיון חדש על תהליך העבודה
note search תהליך עבודה
note summary          → today's notes
note weekly           → this week's notes
note chat מה הרעיונות שלי לגבי פיתוח?
note remind מחר ב-9 לבדוק מייל
```

### Approval / Rejection

When Shaul proposes an action (post, DM, campaign):

| Say | Effect |
|---|---|
| `אישור` / `כן` / `yes` / `1` | Approve and execute |
| `לא` / `בטל` / `no` / `2` | Cancel |

---

## Proactive Engine

### Daily Briefing

Every morning at `SHAUL_BRIEFING_HOUR` (default 08:00 local time), Shaul sends a proactive WhatsApp message:

```
בוקר. שלוש דברים על השולחן היום:
• כתיבת פוסט IG לסדנה של יום שישי
• בדיקת ביצועי הקמפיין שרץ השבוע
• מעקב אחרי 3 לקוחות שלא הגיבו

להתחיל עם הראשון? תגיד יאללה ואני זז.
```

The briefing only surfaces agenda items that pass the anti-nag filter — items you've already seen recently or snoozed won't appear.

**Proactivity budget**: max 3 proactive messages per user per day. Prevents spam even if the scheduler fires multiple times.

### Agenda Management

The Director refreshes the agenda after every message. Each item has:

- `title` — what Shaul plans to do
- `kind` — `draft_post` / `plan_campaign` / `pull_metrics` / `probe_user` / `reflect` / etc.
- `priority` — 1 (urgent) to 10 (nice to have)
- `due_at` — optional deadline
- `topic` — topic slug for the anti-nag topic gate
- `nudge_count` — how many times Shaul has mentioned this item
- `last_mentioned_at` — last mention timestamp
- `mute_until` — snooze expiry

### Anti-Nag Controls

| Action | Command |
|---|---|
| Snooze item for 3 days | *תעזוב את זה* / `snooze <id>` |
| Snooze item for N days | *תדחה את זה ל-7 ימים* |
| Mute topic for 7 days | *תפסיק להזכיר לי על תקציב* |
| Mark item done | *סיימתי* / `done <id>` |
| Pin a permanent fact | *שמור ש<מפתח> הוא <ערך>* |

---

## Analytics Feedback Loop

Every post draft goes through a learning cycle:

1. **Draft**: Creative emits `format_tags` alongside the copy:
   ```json
   { "tone": "casual", "hook_type": "question", "length_bucket": "short" }
   ```

2. **Save**: `format_tags` are stored on the `posts` row when you approve.

3. **Score**: After you pull Meta insights (`mk report` / "תראה לי את הביצועים"), `autoScorePostsFromInsights` correlates each published post to the `insights_daily` row for that day and calculates `performance_score = engagements / reach`.

4. **Learn**: Next time you ask for a post, `getTopFormats` ranks the historically winning patterns and injects them:
   ```
   WINNING FORMAT PATTERNS (bias toward these):
   1. tone=casual, hook=question, length=short (avg score 0.087, n=4)
   2. tone=inspirational, hook=story, length=medium (avg score 0.064, n=2)
   ```

Over time, Shaul's drafts statistically converge on what actually works for your specific audience — no manual tuning required.

---

## AI Model Control

Switch the Gemini model Shaul uses, per user, without restarting.

### Via WhatsApp

```
mk models                      → list available models
mk model gemini-2.5-flash      → switch immediately
עבור ל-gemini-2.0-flash        → same, natural language
```

### Via Dashboard

The main dashboard page has a **model dropdown** — select a model and click "החל". The change takes effect on the next message.

### Available Models

| Model ID | Label | Note |
|---|---|---|
| `gemini-2.5-pro` | Gemini 2.5 Pro | Most capable, slower |
| `gemini-2.5-flash` | Gemini 2.5 Flash | Fast + smart — recommended |
| `gemini-2.0-flash` | Gemini 2.0 Flash | Fast, economical |
| `gemini-1.5-pro` | Gemini 1.5 Pro | Older stable model |
| `gemini-1.5-flash` | Gemini 1.5 Flash | Older, cheapest |

The choice is stored in `marketing_memory._active_model` per user and survives restarts. The global `GEMINI_MODEL` env var applies as default for users without an override.

---

## Notion Mirror (Bidirectional)

Notion is a **human-readable mirror** of SQLite — not the primary store. SQLite runs the agent fast; Notion gives you a clean UI to review and edit memory.

### What syncs to Notion

| Notion DB | SQLite Table | Sync direction |
|---|---|---|
| 🏢 פרופיל עסקי | `business_profile` | SQLite → Notion (on every update) |
| 💡 תובנות שאול | `learned_insights` | SQLite → Notion (on every new insight) |
| 🎯 מטרות עסקיות | `goals` | SQLite → Notion (on create + status change) |
| 📋 אג׳נדה שאול | `agenda_items` | **Bidirectional** (5-minute poll) |

### Notion → SQLite (bidirectional)

Every 5 minutes, `startNotionPollLoop` pulls changes made directly in Notion back to SQLite:

- **Agenda**: status changes (done/skipped/pending) and priority edits sync back
- **Goals**: status, target, and deadline edits sync back
- **Profile**: any field edits sync back

This means you can open Notion on your phone, mark an agenda item as done, change a goal deadline, or update your brand voice — and Shaul will see it within 5 minutes.

### Setup

```env
NOTION_API_KEY=secret_xxxxxxxxxxxxxxxxxxxx
NOTION_MEMORY_PARENT_PAGE_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

The Notion databases are created automatically on first run. No manual schema setup required.

---

## Integrations

### Meta (Facebook & Instagram)

```env
META_PAGE_TOKEN=your_page_access_token
META_PAGE_ID=your_fb_page_id
IG_BUSINESS_ID=your_ig_business_account_id
```

Without these vars, Shaul still drafts posts — they're saved to `posts` with `pending_approval` status. With them, `mk publish <id>` sends the post live.

Publishing rules:
- Instagram requires an `image_url` — post waits in `pending_image` status
- IG container is polled until `FINISHED` before publishing (Meta 2-step API)
- Scheduled posts → `awaiting_final_approval` + WhatsApp nudge → you type `mk publish <id>`

### Google Calendar

Requires an external MCP server (e.g. [nspady/google-calendar-mcp](https://github.com/nspady/google-calendar-mcp)):

```env
CALENDAR_MCP_PATH=/abs/path/to/google-calendar-mcp/dist/index.js
```

All calendar mutations are logged to `calendar_events` audit table.

### Canva

```env
CANVA_CLIENT_ID=your_canva_client_id
CANVA_CLIENT_SECRET=your_canva_client_secret
CANVA_REFRESH_TOKEN=your_refresh_token
```

To get the refresh token:
```bash
cd agent && node scripts/canva-oauth.js
```

Shaul pulls your existing designs, derives a `canva_style_profile` (cached in `marketing_memory`), and creates new designs that match your brand's visual style.

### Gmail / Email

```env
GMAIL_USER=you@gmail.com
GMAIL_CLIENT_ID=your_oauth_client_id
GMAIL_CLIENT_SECRET=your_oauth_secret
GMAIL_REFRESH_TOKEN=your_refresh_token
```

### Notion (Notes)

```env
NOTION_API_KEY=secret_xxxxxxxxxxxxxxxxxxxxxxxx
NOTION_NOTES_DB_ID=xxxxxxxxxxxxxxxxxxxxxxxx   # for the note command
NOTION_MEMORY_PARENT_PAGE_ID=xxxxxxxxxxxxxxxx  # for the memory mirror
```

---

## Web Dashboard

A lightweight browser-based control panel. No extra npm packages.

```bash
./dashboard-start.sh
```

Open **http://localhost:3001** (or your LAN IP on other devices).

### Features

| Feature | Description |
|---|---|
| Status indicator | Pulsing green dot, shows PID + uptime |
| Start / Stop / Restart | One-tap agent control |
| AI Model selector | Switch Gemini model live — dropdown + apply |
| Live log stream | New lines in real time (Server-Sent Events) |
| Download logs | Full `agent.log` download |
| Memory browser | Browse all 17 SQLite tables, paginate, delete rows |

Memory browser: **http://localhost:3001/memory**

Custom port:
```bash
DASHBOARD_PORT=8080 ./dashboard-start.sh
```

---

## Setup — Windows

### Prerequisites

- Node.js 18+
- Google Chrome
- Git

### Steps

1. Clone and install:
   ```powershell
   git clone https://github.com/Amihay11/greenInoviceAgent_gemini.git
   cd greenInoviceAgent_gemini
   cd GreenInvoice-MCP-main && npm install && npm run build && cd ..
   cd agent && npm install && cd ..
   ```

2. Create `agent/.env` from `agent/.env.example` and fill in the required vars.

3. First run — pair WhatsApp:
   ```powershell
   cd agent && node index.js
   ```
   Scan the QR code with WhatsApp → Linked Devices → Link a Device. Once you see `WhatsApp Client is ready!` press `Ctrl+C`.

4. Background: double-click `agent/run-agent-hidden.vbs`.

5. Auto-start on boot: copy `run-agent-hidden.vbs` to `shell:startup`.

---

## Setup — Android (Termux)

One-shot setup:

```bash
curl -fsSL https://raw.githubusercontent.com/Amihay11/greenInoviceAgent_gemini/main/setup-android.sh | bash
```

### Managing on Android

```bash
~/greenInoviceAgent/start-background.sh   # start
~/greenInoviceAgent/stop.sh               # stop
tail -f ~/greenInoviceAgent/agent.log     # live logs
./dashboard-start.sh                      # start dashboard
```

### Auto-start on boot

1. Install **Termux:Boot** from [F-Droid](https://f-droid.org).
2. Open it once to activate.
3. Done — agent + dashboard start automatically on reboot.

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `GEMINI_API_KEY` | ✅ | Google Gemini API key |
| `GEMINI_MODEL` | — | Default model. Default: `gemini-2.5-pro` |
| `MCP_SERVER_PATH` | ✅ | Absolute path to `GreenInvoice-MCP-main/dist/index.js` |
| `GREENINVOICE_API_ID` | ✅ | GreenInvoice API ID |
| `GREENINVOICE_API_SECRET` | ✅ | GreenInvoice API secret |
| `GREENINVOICE_SANDBOX` | — | `true` to use sandbox |
| `WHATSAPP_PHONE` | — | Your number in international format without `+` (e.g. `972541234567`). Enables pairing code instead of QR. |
| `SHAUL_ALLOWED_NUMBERS` | — | Comma-separated whitelist. Empty = accept everyone. |
| `SHAUL_BRIEFING_HOUR` | — | Local hour for the morning briefing. Default `8`. |
| `SHAUL_DB_PATH` | — | Custom SQLite path. Default: `agent/data/shaul-memory.db`. |
| `CALENDAR_MCP_PATH` | — | Path to Google Calendar MCP server entry point |
| `META_PAGE_TOKEN` | — | Facebook Page access token |
| `META_PAGE_ID` | — | Facebook Page ID |
| `IG_BUSINESS_ID` | — | Instagram Business Account ID |
| `CANVA_CLIENT_ID` | — | Canva OAuth client ID |
| `CANVA_CLIENT_SECRET` | — | Canva OAuth client secret |
| `CANVA_REFRESH_TOKEN` | — | Canva OAuth refresh token |
| `GMAIL_USER` | — | Gmail address |
| `GMAIL_CLIENT_ID` | — | Gmail OAuth client ID |
| `GMAIL_CLIENT_SECRET` | — | Gmail OAuth client secret |
| `GMAIL_REFRESH_TOKEN` | — | Gmail OAuth refresh token |
| `NOTION_API_KEY` | — | Notion integration token (for both notes and memory mirror) |
| `NOTION_NOTES_DB_ID` | — | Notion database ID for the `note` command |
| `NOTION_MEMORY_PARENT_PAGE_ID` | — | Notion page ID under which memory databases are created |
| `DASHBOARD_PORT` | — | Dashboard port. Default `3001`. |
| `CHROME_EXECUTABLE_PATH` | — | Path to Chrome/Chromium. Leave unset to use Puppeteer's bundled Chromium. |

---

## File Structure

```
greenInoviceAgent_gemini/
│
├── agent/
│   ├── index.js                  # Main router, MCP setup, tool loop, schedulers
│   ├── noteHandler.js            # note command — Notion + reminders
│   ├── package.json
│   ├── .env.example
│   │
│   ├── personality/
│   │   └── shaul.js              # IDENTITY, VOICE_RULES, system prompt builder, tools block
│   │
│   └── marketing/
│       ├── cmo.js                # CMO orchestrator — classifier, flows, approval gates
│       ├── memory.js             # SQLite schema + all read/write helpers (17 tables)
│       ├── coreMemory.js         # Layer 2: always-in-context block + anti-nag filter
│       ├── longTerm.js           # Layer 3: episodic/semantic/procedural retrieval
│       ├── notion-memory.js      # Notion sync (SQLite→Notion + poll Notion→SQLite)
│       ├── notion-id-cache.js    # Notion page ID cache (stored in marketing_memory)
│       ├── meta.js               # Facebook + Instagram Graph API
│       ├── canva.js              # Canva Connect REST API
│       ├── contacts.js           # Client phone lookup helpers
│       ├── jid.js                # WhatsApp JID normalization + allow-list
│       │
│       └── subagents/
│           ├── common.js         # Shared prompt builder + Gemini runner
│           ├── strategist.js     # Silent extraction + dynamic discovery
│           ├── creative.js       # Copy, captions, format tags, image briefs
│           ├── campaignManager.js
│           ├── publisher.js      # Pure FB/IG executor
│           ├── analyst.js        # Metrics, reports, campaign refinement
│           ├── mentor.js         # Shaul's voice — uses Layer 2+3 memory
│           └── director.js       # Agenda, next-best actions, daily briefings
│
├── GreenInvoice-MCP-main/        # TypeScript MCP server
│   └── src/
│       ├── index.ts              # MCP server entry
│       ├── client.ts             # GreenInvoice HTTP client
│       └── tools.ts              # 10 MCP tools (66 API endpoints)
│
├── dashboard.js                  # Web dashboard (HTTP, no framework)
├── dashboard-start.sh
├── start-background.sh
├── stop.sh
├── setup-android.sh
└── ecosystem.config.cjs          # PM2 config (optional)
```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `Cannot find package 'whatsapp-web.js'` | npm install incomplete | `cd agent && npm install` |
| `MCP_SERVER_PATH is not set` | Missing `.env` entry | Add `MCP_SERVER_PATH=` to `agent/.env` |
| Agent responds but says "authentication error" | Wrong GreenInvoice credentials | Re-enter `GREENINVOICE_API_ID` / `GREENINVOICE_API_SECRET` |
| Shaul keeps repeating the same agenda item | nudge_count not resetting | Say *תעזוב את זה* or `snooze <id>` |
| Notion changes not flowing back | Poll loop not started | Check that `NOTION_API_KEY` + `NOTION_MEMORY_PARENT_PAGE_ID` are both set |
| Posts published without asking | Should never happen — approval is structural | Check `pendingApprovals` Map in `cmo.js` |
| `Model X is not in the allowed list` | Typo in model ID | Run `mk models` to see valid IDs |
| Daily briefing not arriving | Budget exhausted or already briefed | Check `daily_briefings` table in dashboard memory browser |
| `chromium not found` on Android | Not installed | `pkg install x11-repo && pkg update -y && pkg install chromium` |
| Agent killed when phone sleeps | Missing wake lock | Ensure `~/.termux/boot/start-agent.sh` runs `termux-wake-lock` |
| WhatsApp session expired | Session files corrupted | `rm -rf agent/whatsapp-auth/` then restart and re-pair |
| High Notion API 429 errors | Rate limit (3 req/sec) | Increase poll interval: `startNotionPollLoop(() => ids, 10 * 60 * 1000)` for 10-min polls |
