# Nexus Hub — Technical & Functional Documentation
<!-- TODO: Rename server directory /home/dominguez/telegram-hub-bot → /home/dominguez/nexus-hub -->

> **Version:** 4.0.0 | **Platform:** Node.js + TypeScript + Python | **AI:** Claude Sonnet/Haiku (Anthropic) | **Database:** SQLite

A multi-domain AI-powered Telegram personal assistant that unifies task management, calendar coordination, fitness coaching, invoice automation, and a full **Content Agent Mesh** (9 autonomous AI agents + intelligence bus + book knowledge system) into a single bot interface with a real-time Mission Control portal.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Getting Started](#2-getting-started)
3. [Configuration Reference](#3-configuration-reference)
4. [Bot Commands](#4-bot-commands)
5. [Content Creation Workflow — Step by Step](#5-content-creation-workflow--step-by-step)
6. [Content Agent Mesh](#6-content-agent-mesh)
7. [Book Knowledge System](#7-book-knowledge-system)
8. [Intelligence Bus](#8-intelligence-bus)
9. [Message Routing & AI Classification](#9-message-routing--ai-classification)
10. [Scheduled Jobs](#10-scheduled-jobs)
11. [Integrations](#11-integrations)
12. [Mission Control Portal](#12-mission-control-portal)
13. [Google Drive Integration](#13-google-drive-integration)
14. [Database Schema](#14-database-schema)
15. [Deployment](#15-deployment)
16. [Workflows & Examples](#16-workflows--examples)
17. [Architecture Patterns](#17-architecture-patterns)
18. [Troubleshooting](#18-troubleshooting)

---

## 1. Architecture Overview

```
                          +─────────────────────+
                          |   Telegram Users     |
                          +──────────┬──────────+
                                     │
                          +──────────▼──────────+
                          |    Grammy Bot        |
                          |  (Long Polling)      |
                          +──────────┬──────────+
                                     │
              ┌──────────────────────┼──────────────────────┐
              │                      │                      │
     +────────▼────────+   +────────▼────────+   +─────────▼─────────+
     | AI Router        |   | Command Handler |   | Image Processor   |
     | (3-tier classify)|   | (50+ commands)  |   | (Claude Vision)   |
     +────────┬────────+   +────────┬────────+   +─────────┬─────────+
              │                      │                      │
     +────────▼──────────────────────▼──────────────────────▼────────+
     |                     Domain Handlers                           |
     |  Secretary  |  Triathlon  |  Content Creator                  |
     +──────────────────────┬───────────────────────────────────────+
                            │
     +──────────────────────▼───────────────────────────────────────+
     |                   Service Layer                               |
     |  MS To Do | Calendar | Outlook | Garmin | Invoice | Content   |
     |  Channel Learner | Video Study | Content Workflow             |
     +──────────────────────┬───────────────────────────────────────+
                            │
              ┌─────────────┼─────────────────┐
              │             │                 │
     +────────▼──────+ +───▼───+    +────────▼────────+
     | SQLite DB      | | APIs  |    | Content Engine  |
     | (better-sqlite3)| | (MS,  |    | (Python/FastAPI)|
     | 13 migrations  | | Google|    | Port 8100       |
     +────────────────+ | Garmin|    +─────────────────+
                        +───────+
              +─────────────────────────+
              |  Nexus Hub Status Portal|
              |  (Express :8200)        |
              |  Same Node.js process   |
              +─────────────────────────+
```

**Key components:**
- **Grammy Bot** — Telegram bot framework with long polling
- **AI Router** — Three-tier message classification (pattern → keyword → Claude Haiku)
- **Domain Handlers** — Claude Sonnet-powered assistants per domain (secretary, triathlon, content)
- **Service Layer** — External API integrations (Microsoft, Google, Garmin, SSH, YouTube)
- **Content Learning** — YouTube channel analysis + pattern extraction + knowledge injection
- **Content Workflow** — Automated topic generation, script creation, and taste learning
- **Content Engine** — Python FastAPI microservice for content research (port 8100)
- **Status Portal** — Express.js dashboard for real-time monitoring (port 8200)
- **SQLite** — Single-file database with 13 auto-applied migrations

---

## 2. Getting Started

### Prerequisites

- Node.js 18+ with npm
- A Telegram bot token (from [@BotFather](https://t.me/BotFather))
- An Anthropic API key (for Claude)
- SQLite3 (bundled via `better-sqlite3`)
- yt-dlp (for YouTube transcript extraction): `pip3 install --user yt-dlp`

### Installation

```bash
git clone git@github.com:felipedrf74/nexus-hub.git
cd nexus-hub
npm install
cp .env.example .env
# Edit .env with your credentials
```

### Build & Run

```bash
# Development (watch mode)
npm run dev

# Production
npm run build
npm start
```

### First Run

On first start, the bot will:
1. Initialize the SQLite database at `./data/bot.db`
2. Run all pending migrations (001–013)
3. Start long polling on Telegram
4. Start the status portal on port 8200
5. Register all 17+ scheduled jobs
6. Seed default reference channels for content learning

Send `/start` in Telegram to verify the bot is responding.

### Auto-Start on Reboot (PM2)

```bash
sudo env PATH=$PATH:/path/to/node pm2 startup systemd -u dominguez --hp /home/dominguez
pm2 save
```

Both `nexus-hub` and `content-engine` will auto-restart on server reboot.

---

## 3. Configuration Reference

All configuration is via environment variables in `.env`. Copy `.env.example` as a starting point.

### Required

| Variable | Description |
|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Token from BotFather |
| `TELEGRAM_ALLOWED_USER_IDS` | Comma-separated Telegram user IDs (whitelist) |
| `ANTHROPIC_API_KEY` | Claude API key (`sk-ant-...`) |

### Microsoft / Outlook (Optional)

Enable calendar, email, and task management.

| Variable | Description |
|----------|-------------|
| `OUTLOOK_CLIENT_ID` | Azure AD app client ID |
| `OUTLOOK_CLIENT_SECRET` | Azure AD app secret |
| `OUTLOOK_TENANT_ID` | `consumers` for personal accounts (Hotmail/Outlook) |
| `OUTLOOK_REFRESH_TOKEN` | OAuth2 refresh token (use `scripts/get-outlook-token-v2.ts`) |

**Azure App Permissions Required:**
- `Calendars.ReadWrite` (Delegated)
- `Mail.ReadWrite` (Delegated)
- `Mail.Send` (Delegated)
- `Tasks.ReadWrite` (Delegated)

### Microsoft To Do

| Variable | Default | Description |
|----------|---------|-------------|
| `TODO_DEFAULT_LIST` | `Tasks` | Default task list name |
| `TODO_DIGEST_ENABLED` | `true` | Enable morning digest |
| `TODO_DIGEST_TIME` | `08:00` | Morning digest time (HH:MM) |

### Google (Optional)

Enable Google Calendar and Gmail.

| Variable | Description |
|----------|-------------|
| `GOOGLE_CLIENT_ID` | Google OAuth2 client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth2 client secret |
| `GOOGLE_REFRESH_TOKEN` | OAuth2 refresh token (use `scripts/get-google-token.ts`) |

### Invoice Filing

| Variable | Default | Description |
|----------|---------|-------------|
| `INVOICE_FILING_ENABLED` | `true` | Enable invoice filing via SSH |
| `INVOICE_SSH_HOST` | `localhost` | SSH host (localhost for autossh tunnel) |
| `INVOICE_SSH_PORT` | `2222` | SSH port |
| `INVOICE_SSH_USER` | — | SSH username on the Mac |
| `INVOICE_SSH_KEY` | — | Path to SSH private key |
| `INVOICE_REMOTE_PATH` | — | Remote directory for filed invoices |
| `INVOICE_MIN_CONFIDENCE` | `0.70` | Min AI confidence for auto-filing |
| `INVOICE_COMPRESSION_ENABLED` | `true` | Compress images before sending |
| `INVOICE_JPEG_QUALITY` | `80` | JPEG quality (0–100) |
| `INVOICE_MONTHLY_COLLECTION` | `true` | Enable 1st-of-month email collection |

### Amazon.es Invoice Collection

| Variable | Default | Description |
|----------|---------|-------------|
| `AMAZON_COLLECTION_ENABLED` | `false` | Enable Amazon scraping |
| `AMAZON_EMAIL` | — | Amazon.es login |
| `AMAZON_PASSWORD` | — | Amazon.es password |
| `AMAZON_SESSION_PATH` | `./data/amazon-session.json` | Session cache |
| `AMAZON_HEADLESS` | `true` | Run browser headless |

### Uber Invoice Collection

| Variable | Default | Description |
|----------|---------|-------------|
| `UBER_COLLECTION_ENABLED` | `false` | Enable Uber scraping |
| `UBER_EMAIL` | — | Uber login |
| `UBER_PASSWORD` | — | Uber password |
| `UBER_SESSION_PATH` | `./data/uber-session.json` | Session cache |
| `UBER_HEADLESS` | `true` | Run browser headless |
| `UBER_RIDES_ENABLED` | `true` | Collect ride invoices |
| `UBER_EATS_ENABLED` | `true` | Collect Eats invoices |

### Garmin Connect

| Variable | Default | Description |
|----------|---------|-------------|
| `GARMIN_EMAIL` | — | Garmin account email |
| `GARMIN_PASSWORD` | — | Garmin account password |
| `GARMIN_TOKEN_PATH` | `./data/garmin-tokens` | Token cache directory |
| `GARMIN_COACH_ENABLED` | `false` | Enable daily coach analysis |
| `GARMIN_COACH_TIME` | `21:00` | When to send coach report |

### Content Engine

| Variable | Default | Description |
|----------|---------|-------------|
| `CONTENT_ENGINE_ENABLED` | `false` | Enable Python content engine |
| `CONTENT_ENGINE_PORT` | `8100` | Python service port |

### YouTube Data API

| Variable | Description |
|----------|-------------|
| `YOUTUBE_API_KEY` | YouTube Data API v3 key (for channel analysis) |

### Status Portal

| Variable | Default | Description |
|----------|---------|-------------|
| `PORTAL_ENABLED` | `true` | Enable web dashboard |
| `PORTAL_PORT` | `8200` | Portal HTTP port |
| `PORTAL_BIND` | `0.0.0.0` | Bind address |
| `PORTAL_TOKEN` | — | Bearer token for API auth (empty = no auth) |

### General

| Variable | Default | Description |
|----------|---------|-------------|
| `TIMEZONE` | `Europe/Lisbon` | Timezone for all cron jobs |
| `DATABASE_PATH` | `./data/bot.db` | SQLite database path |
| `LOG_LEVEL` | `info` | Pino log level (trace/debug/info/warn/error/fatal) |

---

## 4. Bot Commands

### Task Management (Microsoft To Do)

| Command | Description |
|---------|-------------|
| `/lists` | Show all task lists |
| `/tasks [list]` | Tasks in a specific list (default: "Tasks") |
| `/alltasks` | All pending tasks across all lists |
| `/newtask [task]` | Create a task in the default list |
| `/newtask [list] \| [task]` | Create a task in a specific list |
| `/done [task]` | Mark task as complete |
| `/undone [task]` | Reopen a completed task |
| `/edittask [task] \| [new title]` | Rename a task |
| `/notetask [task] \| [note]` | Add description/note to a task |
| `/movetask [task] \| [list]` | Move task to another list |
| `/addstep [task] \| [step]` | Add a checklist sub-step |
| `/steps [task]` | Show all checklist steps |
| `/newlist [name]` | Create a new task list |
| `/deletelist [name]` | Delete a task list |
| `/deletetask [task]` | Delete a task permanently |
| `/due [task] \| [date]` | Set/update due date (natural language: "tomorrow 5pm") |
| `/remind [task] \| [time]` | Set a reminder time |
| `/priority [task] \| [level]` | Set importance (low / normal / high) |
| `/search [query]` | Full-text search across all tasks |
| `/todosummary` | Executive summary of all pending tasks |
| `/overdue` | All overdue tasks |
| `/duetoday` | Tasks due today |
| `/dueweek` | Tasks due this week |
| `/completed [list]` | Recently completed tasks (last 7 days) |
| `/todo [task]` | Quick task creation (routes to secretary) |
| `/todos` | Quick view of the default task list |

### Calendar & Schedule

| Command | Description |
|---------|-------------|
| `/day` | Today's schedule (calendar events + tasks + reminders) |
| `/week` | Week overview |

You can also **send a photo** of a schedule/timetable and the AI will extract events and create calendar entries with conflict detection.

### Triathlon / Fitness

| Command | Description |
|---------|-------------|
| `/checkin` | Log how you're feeling (training readiness, soreness) |
| `/gym` | Current gym program/routine |
| `/run` | Running plan |
| `/meal` | Carnivore meal plan recommendations |
| `/train [topic]` | Natural language training queries |
| `/coach` | Daily coach analysis (Garmin data + calendar recommendations) |

### Content Creation — Workflow Commands

| Command | Description |
|---------|-------------|
| `/contenttopic [tuesday\|thursday]` | Generate topic candidates with inline approve/skip/reject buttons |
| `/script [topic]` | Generate a full video script and save as .docx |
| `/repurpose` | Repurpose a script into Reels + Stories (reply to .docx or send with caption) |
| `/contentretro` | Weekly content retrospective |

### Content Creation — Research & Engine

**Research:**

| Command | Description |
|---------|-------------|
| `/discover` | Run content discovery pipeline (trends, YouTube, news) |
| `/ideas [date\|saved]` | View ideas by date or saved ideas |
| `/deepsearch [topic]` | Full research pipeline with sources |
| `/sources [topic]` | Curated source list for a topic |
| `/hotnews` | What's trending right now |

**Visual & Social:**

| Command | Description |
|---------|-------------|
| `/trending [niche]` | Cross-platform trends (default: general) |
| `/reaction [topic]` | Find reaction-worthy content angles |
| `/video [topic]` | Video idea generation |
| `/reel [topic]` | Short-form reel/Shorts concepts |

**Creative Intelligence:**

| Command | Description |
|---------|-------------|
| `/hooks [topic]` | Generate scroll-stopping opening hooks |
| `/genscript [topic]` | Full video script with research (saves to file) |
| `/titles [topic]` | A/B test title variants with CTR predictions |
| `/genthumbnail [title]` | Thumbnail design concepts |
| `/gencaption [topic]` | Instagram caption + optimized hashtags |

**Strategic Intelligence:**

| Command | Description |
|---------|-------------|
| `/competitor [channel]` | Reverse-engineer a competitor channel (saves to file) |
| `/gaps [niche]` | Find content gaps in a niche (default: "fitness") |
| `/seo [topic]` | Keyword analysis & SEO recommendations |

**Learning & Performance:**

| Command | Description |
|---------|-------------|
| `/feedback [url] [views] [retention%] [likes] [comments] [subs]` | Log video performance |
| `/report [week\|month]` | Content performance analytics (saves to file) |

### Content Creator Learning System

| Command | Description |
|---------|-------------|
| `/learnfrom [channel URL or @handle]` | Add a YouTube channel for pattern learning |
| `/references` | View tracked channels and their analysis status |
| `/relearn` | Re-analyze all tracked channels with fresh data |

### Video Analysis

| Command | Description |
|---------|-------------|
| `/transcribe [URL]` | Download video transcript as Word file (.docx) |
| `/studyvideo [URL]` | Deep video analysis as Word file (hooks, structure, reel cuts) |

### Invoice Filing

| Command | Description |
|---------|-------------|
| `/invoices [YYYY-MM]` | Manual monthly invoice collection (default: previous month) |
| `/addfatura [name] \| [sender@domain]` | Register a new invoice vendor |
| `/rmfatura [name]` | Remove/disable a custom vendor |
| `/faturas` | List all configured vendors (built-in + custom) |
| `/amazon [YYYY-MM] [--force]` | Collect Amazon.es invoices |
| `/uber [YYYY-MM] [--force]` | Collect Uber + Uber Eats invoices |

### Book Knowledge

| Command | Description |
|---------|-------------|
| `/addbook Title \| Author` | Research and extract a book into the knowledge library |
| `/booknote Title \| Note` | Add a personal insight to a book |
| `/books` | List all books in the library with extraction status |
| `/bookidea [topic]` | Search book library for relevant frameworks and ideas |

### System

| Command | Description |
|---------|-------------|
| `/start` | Welcome message |
| `/help` | Show the command menu |
| `/status` | Current system state overview |
| `/clear [domain\|all]` | Clear conversation history (secretary / triathlon / content / all) |
| `/garminmfa [code]` | Submit Garmin MFA verification code |

---

## 5. Content Creation Workflow — Step by Step

This section describes the full content creation pipeline and how to extract maximum value from the system.

### How the System Works

The content AI has **3 learning layers** that compound over time:

1. **Channel Patterns** — *How* to make content (hooks, structure, storytelling, CTAs). Extracted from reference YouTube channels via Claude Sonnet analysis of video metadata + transcripts.
2. **Trend Scanning** — *What* to talk about right now. Web search for trending topics aligned with your content pillars.
3. **Taste Profile** — *What YOU want* to talk about. Learned from your approve/skip/reject feedback on topic candidates. Sharpens over time.

All three layers are injected into every content AI interaction automatically.

### Step 1: Set Up Reference Channels

Add YouTube channels whose style and patterns you want the AI to learn from:

```
/learnfrom @DanKoeTalks
/learnfrom @danielbarada
/learnfrom @Jett.franzen
/learnfrom @NewelOfKnowledge
```

The system will:
- Fetch the top 10 highest-performing videos per channel (sorted by views)
- Download transcripts for the top 5 videos via yt-dlp
- Send all video metadata + transcript content to Claude Sonnet
- Extract patterns across 9 categories: hook_style, title_pattern, content_structure, editing_style, storytelling, cta_pattern, audience_engagement, visual_style, brand_voice
- Synthesize cross-channel knowledge (merging insights from all channels)

Check status anytime: `/references`

Patterns auto-refresh every **Sunday at 03:00**. You can force a refresh with `/relearn`.

### Step 2: Receive Topic Candidates (Automated)

The bot automatically sends topic candidates on a schedule:

| Day | Time | Format | Type |
|-----|------|--------|------|
| **Tuesday** | 09:00 | 5 Reels/Shorts | Trending topics |
| **Thursday** | 09:00 | 3 YouTube videos | Trending topics |
| **Friday** | 18:30 | 2 YouTube + 4 Reels | Evergreen topics |

Each topic arrives with inline buttons:

- ✅ **Approve** — topic is saved, script will be generated
- ⏭️ **Skip** — not now, maybe later (neutral feedback)
- 👎 **Not my vibe** — the AI learns you don't like this type

You can also trigger manually: `/contenttopic tuesday` or `/contenttopic thursday`

**Important:** The more you approve/reject, the better the taste profile gets. After ~20-30 feedback actions, the AI has a solid understanding of your preferences.

### Step 3: Generate Scripts

For any approved topic (or any idea you have):

```
/script Shrink the habit until it's unrefusable — YouTube format, 10 min
/script Por que o estado é seu inimigo — Reels format, 60s
/script Reaction: nova lei do governo sobre crypto
```

The bot generates a full script in PT-BR with:
- Hook (first 3 seconds)
- Body structure with timestamps
- CTA (call to action)
- Title options
- Thumbnail concept

Output is saved as a **.docx Word file** to `~/Desktop/IDEAS/SCRIPTS/` and sent via Telegram as a downloadable document.

### Step 4: Repurpose into Multiple Formats

After you have a YouTube script, repurpose it:

1. Send the .docx file to the bot
2. Add `/repurpose` as the caption

The bot generates:
- **3 Reels/Shorts scripts** (30-60s each, different angles)
- **1 Stories sequence** (5-7 stories with poll/question sticker suggestions)

Output saved as .docx and sent via Telegram.

### Step 5: Study Competitor Videos

When you spot a viral video in your niche:

```
/studyvideo https://youtube.com/watch?v=VIDEO_ID
```

Returns a deep analysis saved as .docx:
- Hook breakdown (what makes the first 3s work)
- Structure analysis (how the content flows)
- Key moments (retention peaks)
- Content ideas inspired by this video
- Reel cut suggestions (timestamps for short-form clips)

### Step 6: Grab Transcripts for Inspiration

```
/transcribe https://youtube.com/watch?v=VIDEO_ID
```

Downloads the full transcript with timestamps as a .docx file. Useful for:
- Studying how top creators structure their arguments
- Pulling quotes for your own content
- Research for reaction videos

### Step 7: Chat Naturally About Content

You don't need commands for everything. Just message the bot naturally:

```
"Give me 5 video ideas about why the free market is the only path to prosperity"
"Write me a hook for a video about quitting your 9-5"
"How should I structure a reaction video about the new government regulations?"
```

The content domain has your full worldview, audience profile, and all learned patterns injected automatically. Every response reflects your perspective.

### Step 8: Weekly Retrospective

On Fridays, review what worked:

```
/contentretro
```

Or log performance manually:

```
/feedback https://youtube.com/watch?v=VIDEO_ID 15000 45% 800 120 50
```

(views, retention%, likes, comments, new subscribers)

### Content Pillars

The system generates topics across these pillars:

- **Fitness/gym & strength training**
- **Running, cycling & endurance**
- **Politics & news** (conservative/libertarian lens)
- **Faith, family & traditional values**
- **Self-development & personal growth**
- **Economics & free market** (Austrian School)
- **Trending topic commentary & viral reactions**

### File Outputs

All generated content is saved as Word documents:

| Command | Save Path |
|---------|-----------|
| `/script` | `~/Desktop/IDEAS/SCRIPTS/` |
| `/repurpose` | `~/Desktop/IDEAS/SCRIPTS/` |
| `/transcribe` | `~/Desktop/IDEAS/` |
| `/studyvideo` | `~/Desktop/IDEAS/` |

### File Output Structure

All content creation outputs are saved as professional DOCX files organized in 5 folders:

```
~/Desktop/IDEAS/
├── RESEARCH/     ← /deepsearch, /sources, /trending, /hotnews, /transcribe
├── IDEAS/        ← /contenttopic, /hooks, /titles, /reaction, /studyvideo
├── SCRIPTS/      ← /genscript, /script, /repurpose, reel/youtube from workflow
├── VISUALS/      ← /genthumbnail, /gencaption
└── REPORTS/      ← /competitor, /gaps, /seo, /feedback, /report
```

Files are also uploaded to **Google Drive** automatically. Each Telegram message includes a "📂 Open in Google Drive" link.

---

## 6. Content Agent Mesh

The Content Agent Mesh is a system of **9 autonomous AI agents** that collaborate through a shared **intelligence bus** to continuously improve content quality.

### Agent Overview

| Agent | Purpose | Schedule | Signals Produced |
|-------|---------|----------|-----------------|
| **Channel Learner** | Extracts patterns from reference YouTube channels | Sunday 03:00 | `channel_dna` |
| **Book Extractor** | Researches books and extracts frameworks | On-demand via `/addbook` | `book_knowledge` |
| **SEO Agent** | Tracks keyword rankings and search visibility | Daily 08:00 | `keyword_rank_change`, `seo_opportunity` |
| **Reaction Radar** | Monitors for reaction-worthy content | Daily 10:00 | `reaction_opportunity` |
| **Performance Agent** | Analyzes content performance and trends | Daily 22:00 | `retention_pattern`, `hook_effectiveness`, `pillar_performance` |
| **Voice Evolution** | Tracks Felipe's evolving voice and phrases | Weekly Sunday 04:00 | `voice_pattern`, `voice_phrase_trend` |
| **Pipeline Agent** | Manages content from idea → publish | Daily 20:00 | `pipeline_bottleneck` |
| **Content Workflow** | Generates topic candidates for approval | Tue/Thu/Fri 09:00 | Topic candidates with approval buttons |
| **Script Writer** | Generates scripts enriched with bus signals | On-demand via `/genscript` | — (consumer) |

### How Agents Collaborate

1. **Channel Learner** extracts hook patterns → writes `channel_dna` signal
2. **Performance Agent** finds which hooks work best → writes `hook_effectiveness` signal
3. **Voice Evolution** detects Felipe's trending phrases → writes `voice_phrase_trend` signal
4. **SEO Agent** finds keyword opportunities → writes `seo_opportunity` signal
5. **Script Writer** reads ALL active signals and weaves them into the script prompt

### Creator Profile

All creative modules share a centralized `creator_profile.py` containing:

- **Audience:** Brazilian men, 18-35
- **Pillars:** Fitness/triathlon, politics (conservative/libertarian), Austrian economics, faith/family, self-development, geopolitics
- **Voice:** Direct, data-driven, no-BS, controversial when needed
- **Worldview:** Anti-state, free market, Christian, nuclear family, NAP, individual sovereignty
- **Language:** Portuguese PT-BR, conversational

---

## 7. Book Knowledge System

The book library stores structured intellectual knowledge extracted via web research + Claude Sonnet synthesis.

### Commands

| Command | Description | Example |
|---------|-------------|---------|
| `/addbook Title \| Author` | Research and extract a book | `/addbook The Law \| Frédéric Bastiat` |
| `/booknote Title \| Note` | Add a personal insight to a book | `/booknote The Law \| Legal plunder = INSS` |
| `/books` | List all books in the library | `/books` |
| `/bookidea [topic]` | Search library for relevant frameworks | `/bookidea inflação` |

### Extraction Pipeline

1. **8 parallel web searches** (summary, concepts, quotes, frameworks, criticism, philosophy)
2. **Claude Sonnet synthesis** into structured `BookDNA`
3. **Stored in SQLite** with: core thesis, key frameworks, quotable ideas, pillar mapping
4. **Intelligence bus signal** written for each book (consumed by Script Writer)

### Seed Library

On first startup, 6 Austrian economics classics are auto-extracted:

- *The Law* — Frédéric Bastiat
- *Economics in One Lesson* — Henry Hazlitt
- *Human Action* — Ludwig von Mises
- *The Road to Serfdom* — Friedrich Hayek
- *Democracy: The God That Failed* — Hans-Hermann Hoppe
- *Anatomy of the State* — Murray Rothbard

### BookDNA Structure

Each extracted book contains:

- **Core Thesis** — 2-3 sentence summary
- **Key Frameworks** — 3-6 named frameworks with description, content use-case, and pillar mapping
- **Quotable Ideas** — 4-8 provocative ideas with context and "use when" guidance
- **Pillar Mapping** — Which content pillars this book relates to
- **Counter-Arguments** — What critics say (useful for reaction content)
- **Related Thinkers** — Cross-referencing with other authors
- **Personal Notes** — Felipe's own insights (added via `/booknote`)

---

## 8. Intelligence Bus

The intelligence bus is a shared message system that allows agents to communicate asynchronously.

### Signal Structure

```
{
  source_agent: "performance-agent",
  signal_type: "hook_effectiveness",
  priority: "normal" | "urgent",
  payload: { ... },       // Agent-specific data
  ttl_hours: 168,         // Auto-expires after 7 days
  status: "active" | "consumed" | "expired" | "dismissed"
}
```

### Signal Types

| Signal Type | Source | Consumed By |
|-------------|--------|-------------|
| `channel_dna` | Channel Learner | Script Writer, Content Workflow |
| `book_knowledge` | Book Extractor | Script Writer |
| `keyword_rank_change` | SEO Agent | Content Workflow, Script Writer |
| `seo_opportunity` | SEO Agent | Content Workflow |
| `reaction_opportunity` | Reaction Radar | Content Workflow |
| `retention_pattern` | Performance Agent | Script Writer |
| `hook_effectiveness` | Performance Agent | Hook Generator |
| `pillar_performance` | Performance Agent | Content Workflow |
| `voice_pattern` | Voice Evolution | Script Writer |
| `voice_phrase_trend` | Voice Evolution | Script Writer |
| `pipeline_bottleneck` | Pipeline Agent | Mission Control |
| `content_sprint_mode` | Mission Control | All Agents (increases frequency) |

### API Endpoints

- `GET /api/signals` — List active signals (filterable by type)
- `POST /api/signals/:id/dismiss` — Dismiss a signal
- `GET /api/agents` — All agent states and stats

---

## 9. Message Routing & AI Classification

The bot uses a three-tier classification system for non-command messages:

### Tier 1: Pattern Match (instant, no API cost)
Regex patterns detect explicit intent. Examples:
- "create a task called..." → Secretary
- "what's my gym routine" → Triathlon
- "youtube video idea about..." → Content

### Tier 2: Keyword Match (instant, no API cost)
Natural language keywords in Portuguese and English:
- **Triathlon:** "workout", "gym session", "treino", "agachamento", "corrida"
- **Content:** "youtube", "reels", "video", "roteiro", "miniatura"
- **Secretary:** "tasks", "reminders", "calendario", "tarefas", "e-mail"

### Tier 3: Claude Classification (accurate, uses Haiku)
If tiers 1-2 don't match, Claude Haiku classifies the message into a domain (secretary/triathlon/content) in a single fast API call.

### Domain Handlers
Each domain has its own Claude Sonnet conversation with:
- Isolated conversation history (last 20 messages)
- Domain-specific system prompt with dynamic knowledge injection (content domain)
- Access to relevant tools (MS To Do, Calendar, etc.)
- Up to 4 tool-call iterations per message

### Image Processing
Photos sent to the bot are analyzed with Claude Vision:
1. **Invoice** — Auto-classified vendor, amount, date → compressed → filed via SSH
2. **Calendar/Schedule** — Events extracted → created in Outlook/Google Calendar
3. **Task/Checklist** — Items extracted → created in MS To Do

---

## 10. Scheduled Jobs

All jobs run in the configured timezone (default: `Europe/Lisbon`). Failures trigger Telegram alerts.

| Job | Schedule | Description |
|-----|----------|-------------|
| **Reminders** | Every minute | Check and send due reminders |
| **Shared List Watch** | Every 5 min | Notify when others add tasks to shared MS To Do lists |
| **Garmin Keep-Alive** | :05 and :35 | Refresh Garmin Connect OAuth2 tokens |
| **Invoice Queue** | Every 15 min | Process queued invoice filings |
| **End of Day Summary** | 21:00 daily | Tasks due today + overdue count |
| **Morning Briefing** | Configurable (08:00) | Calendar, pending tasks, unread emails, reminders |
| **Weekly Review** | Friday 17:00 | Completed this week, still pending, overdue |
| **Conflict Detection** | 19:30 daily | Check tomorrow's calendar for overlapping events |
| **Content Discovery** | 16:43 daily | Automated content idea generation |
| **Tuesday Reels** | Tuesday 09:00 | Send 5 trending Reel topic candidates |
| **Thursday YouTube** | Thursday 09:00 | Send 3 trending YouTube topic candidates |
| **Friday Weekly Pack** | Friday 18:30 | Send evergreen topic pack (2 YT + 4 Reels) |
| **Channel Relearn** | Sunday 03:00 | Re-analyze all reference channels (patterns + transcripts) |
| **Coach Analysis** | Configurable (21:00) | Garmin data + calendar → AI recommendations |
| **Invoice Collection** | 1st @ 09:00 | Monthly email-based invoice collection |
| **Amazon Collection** | 1st @ 09:15 | Amazon.es invoice scraping (Playwright) |
| **Uber Collection** | 1st @ 09:30 | Uber/Eats invoice scraping (Playwright) |
| **Fossa Email** | Bi-weekly Mon 07:30 | Automated septic tank service request email |

---

## 11. Integrations

### Microsoft Graph (Outlook + To Do)

Provides calendar, email, and task management via OAuth2.

**Capabilities:**
- Read/write calendar events (with color category mapping)
- Read/send emails (with delivery tracking)
- Full CRUD on To Do lists, tasks, and checklist steps
- Shared list monitoring for collaborative task boards

**Setup:** Run `scripts/get-outlook-token-v2.ts` to complete the OAuth2 flow. The script will output a refresh token to add to `.env`.

### Google (Calendar + Gmail)

**Capabilities:**
- Read/write Google Calendar events
- Read Gmail (for invoice emails)

**Setup:** Run `scripts/get-google-token.ts` for the OAuth2 flow.

### Unified Calendar

Both Microsoft and Google calendars are queried through a unified abstraction layer that merges events, detects conflicts, and routes creates/updates to the correct provider.

### Garmin Connect

**Capabilities:**
- Fetch training metrics: sleep score, stress, HRV, body battery, training load, training readiness
- OAuth2 token refresh every 30 minutes (offset from coach job to prevent race conditions)
- Serialized auth recovery (prevents MFA storms from parallel 403 errors)
- AI coach analysis combining Garmin data with calendar events

**Setup:** Set `GARMIN_EMAIL` and `GARMIN_PASSWORD` in `.env`. For 2FA, the bot will send a Telegram message asking for the code — reply with `/garminmfa <code>`.

### YouTube (Channel Learning + Transcripts)

**Capabilities:**
- Fetch channel videos sorted by performance (YouTube Data API v3)
- Download transcripts via yt-dlp (bypasses YouTube's server-IP blocking)
- Pattern extraction across 9 content categories via Claude Sonnet
- Cross-channel knowledge synthesis via Claude Haiku

**Setup:** Set `YOUTUBE_API_KEY` in `.env`. Install yt-dlp: `pip3 install --user yt-dlp`.

### Invoice Filing (SSH/SCP)

Files invoices from the bot to a remote Mac via SSH reverse tunnel.

**Setup:**
1. Mac runs: `autossh -R 2222:localhost:22 user@server`
2. Configure `INVOICE_SSH_*` variables in `.env`
3. The bot compresses images (configurable quality) and SCPs them to the remote path

**Built-in Vendor Patterns:** MEO, Vodafone, EDP, NOS, Worten, IKEA, Leroy Merlin, and more. Custom vendors can be added via `/addfatura`.

### Amazon.es & Uber Collection

Browser automation via Playwright for monthly invoice scraping. Supports 2FA via interactive Telegram prompts (the bot sends you a message asking for the code).

### Content Engine (Python)

A separate FastAPI microservice providing content research capabilities. Runs on port 8100.

**Setup:**
```bash
cd content-engine
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python main.py
```

Set `CONTENT_ENGINE_ENABLED=true` and `CONTENT_ENGINE_PORT=8100` in `.env`.

### Anthropic (Claude AI)

| Model | Role | Use Case |
|-------|------|----------|
| Claude Haiku | Classifier | Fast domain detection for message routing |
| Claude Haiku | Synthesizer | Cross-channel knowledge synthesis |
| Claude Sonnet | Domain Handler | Conversation-quality responses with tool use |
| Claude Sonnet | Pattern Extractor | YouTube channel pattern analysis (with transcripts) |
| Claude Sonnet | Script Generator | Full video scripts, topic generation |
| Claude Sonnet | Vision | Image analysis (invoices, schedules, tasks) |
| Claude Sonnet | Coach | Garmin data analysis and recommendations |

API usage is tracked in the `api_usage` SQLite table with per-call cost calculations.

---

## 12. Mission Control Portal

**URL:** `http://localhost:8200` (configurable via `PORTAL_PORT`)

The portal is a single-page real-time dashboard that auto-refreshes every 10 seconds.

### Authentication

Set `PORTAL_TOKEN` in `.env`. The browser will prompt for the token on first visit (stored in `localStorage`). Leave empty for development (no auth).

### Dashboard Sections

#### Health Summary Bar
Sticky bar showing at-a-glance metrics: jobs OK/total, emails sent today, API cost today, invoices this month, uptime.

#### Today's Timeline
24-hour horizontal timeline with:
- Color-coded blocks: blue (calendar), purple (cron jobs), orange (emails), green/red (success/failure)
- Red "NOW" marker for current time

#### Job Calendar — DAG View
Airflow-inspired grid showing 7-day history + upcoming scheduled runs:
- **Rows:** Each registered job
- **Columns:** Past 7 days + future days with scheduled runs
- **Cells:** Green dots (success), red dots (failure), dashed gray dots (upcoming/scheduled)
- Hover for execution time and duration details

#### Content References
- Tracked YouTube channels with analysis status
- Add/remove channels via the portal
- Re-synthesize knowledge button

#### Video Transcripts
Stats on fetched transcripts and deep studies.

#### Bot Status
Polling state, last message received, uptime.

#### API Usage
Cost breakdown by model/category for today, last 7 days, and last 30 days.

#### Next Scheduled Runs
Next 10 upcoming cron job fires with countdown timer ("in 2h 15m").

#### Quick Actions
Manual triggers with 30-second cooldown:
- Refresh Garmin session
- Send morning briefing
- Send coach report
- Re-synthesize knowledge
- Clear conversation history
- Test SSH connection
- Test MS Graph token
- Restart bot polling
- Run Performance Agent
- Run Voice Evolution
- Run Reaction Radar
- Run SEO Agent
- Run Pipeline Agent

#### Content Agent Mesh Panel
- **Metric Cards:** Active signals, pipeline items, books loaded, bottleneck status
- **Agent Cards Grid:** 6 agents with status badges, last run, signals produced, "Run" buttons
- **Sprint Mode Toggle:** Enables maximum-frequency content output
- **Intelligence Bus Table:** Signal log with source, type, summary, age, dismiss button
- **Book Library Table:** All books with pillars, frameworks, reference count, status

### API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Serve the dashboard HTML |
| `GET` | `/api/snapshot` | Full JSON payload (cached 3s) |
| `POST` | `/api/action/:name` | Trigger a quick action |
| `POST` | `/api/channels` | Add a reference channel |
| `DELETE` | `/api/channels/:id` | Remove a reference channel |
| `GET` | `/api/agents` | All agent states and stats |
| `GET` | `/api/signals` | Active intelligence bus signals |
| `POST` | `/api/signals/:id/dismiss` | Dismiss a signal |
| `GET` | `/api/pipeline` | Pipeline stage counts + bottleneck |
| `GET` | `/api/books` | Full book library |
| `POST` | `/api/override/sprint` | Toggle Content Sprint Mode |

All `/api/*` routes require `Authorization: Bearer <PORTAL_TOKEN>` header.

---

## 13. Google Drive Integration

Content outputs (DOCX files) are automatically uploaded to Google Drive for easy access from any device.

### Setup

1. Enable **Google Drive API** in Google Cloud Console
2. Add `drive.file` scope to your OAuth token (via Google OAuth Playground)
3. Set `GOOGLE_DRIVE_FOLDER_ID` in `.env` (the ID of the target Drive folder)

### How It Works

- When `saveContentAsDocx()` creates a file, it calls `uploadToDrive()` with the subfolder name
- The file is uploaded to Drive under a subfolder matching the local structure (RESEARCH, SCRIPTS, etc.)
- The Drive URL is returned and included in the Telegram message as "📂 Open in Google Drive"
- Local file + Drive copy are both kept (Drive is the accessibility layer, not the primary store)

---

## 14. Database Schema

SQLite database at `./data/bot.db` with auto-applied migrations.

### Tables

| Table | Migration | Purpose |
|-------|-----------|---------|
| `todos` | 001 | Task tracking (legacy) |
| `notes` | 001 | Quick notes per domain |
| `reminders` | 001 | Scheduled reminders (recurring support) |
| `conversations` | 001 | Per-domain chat history (auto-pruned to 20 messages) |
| `shared_memory` | 002 | Cross-domain key-value context store |
| `saved_ideas` | 003 | Saved content ideas from discovery |
| `invoice_filings` | 004 | Invoice filing log (dedup by vendor + invoice number) |
| `invoice_vendors` | 004 | User-configured invoice vendors |
| `content_research_briefs` | 006 | Content research outputs |
| `content_search_results` | 006 | Individual search results linked to briefs |
| `content_search_cache` | 006 | Search result caching |
| `content_trending_topics` | 006 | Tracked trending topics |
| `api_usage` | 007 | Anthropic API call tracking (tokens, cost, duration) |
| `email_log` | 008 | Automated email delivery log |
| `job_history` | 009 | Scheduled job execution history |
| `invoice_queue` | 010 | Invoice processing queue |
| `content_ref_channels` | 011 | Tracked YouTube reference channels |
| `content_patterns` | 011 | Extracted content patterns per channel (9 categories) |
| `content_knowledge` | 011 | Synthesized cross-channel knowledge |
| `video_transcripts` | 012 | Fetched video transcripts |
| `video_studies` | 012 | Deep video study results |
| `content_topic_feedback` | 013 | Topic candidates with approve/skip/reject feedback |
| `agent_signals` | 015 | Intelligence bus signals between agents |
| `agent_runs` | 015 | Agent execution history with timing |
| `book_library` | 015 | Book knowledge library (BookDNA) |
| `seo_keywords` | 015 | SEO keyword tracking and rankings |
| `content_pipeline` | 015 | Content pipeline stages (idea → published) |

Migrations run automatically on startup. See `migrations/*.sql` for the full schemas.

---

## 15. Deployment

### PM2 Production Setup

The project uses PM2 for process management. Configuration is in `ecosystem.config.js`.

### Deploy Script

```bash
./scripts/deploy.sh
```

The deploy script:
1. **Type-checks** TypeScript locally (`tsc --noEmit`)
2. **Builds** the project (`npm run build`)
3. **Stops** services on the server via PM2
4. **Syncs** files via rsync (excludes `.env`, `data/`, `logs/`, `node_modules/`)
5. **Installs** dependencies on server (`npm ci --production`)
6. **Starts** both services (nexus-hub + content-engine)
7. **Health checks** Content Engine (port 8100) and Status Portal (port 8200)

### Protected Paths (Never Overwritten by Deploy)

- `.env` — Environment configuration
- `data/` — SQLite database + session caches
- `logs/` — Application logs
- `node_modules/` — Dependencies
- `content-engine/.venv/` — Python virtual environment
- `content-engine/data/` — Content engine data

### Build Commands

| Command | Description |
|---------|-------------|
| `npm run build` | Compile TypeScript + copy portal.html to dist/ |
| `npm start` | Run compiled bot from dist/ |
| `npm run dev` | Watch mode (auto-recompile on changes) |
| `npm run clean` | Remove dist/ directory |

### Bootstrap Scripts

| Script | Purpose |
|--------|---------|
| `scripts/get-outlook-token-v2.ts` | Microsoft OAuth2 flow → refresh token |
| `scripts/get-google-token.ts` | Google OAuth2 flow → refresh token |
| `scripts/garmin-mfa-bootstrap.js` | Garmin 2FA initial setup |
| `scripts/seed-uber-session.ts` | Pre-authenticate Uber session |
| `scripts/debug-env.js` | Print loaded environment variables (debug) |
| `scripts/test-discovery.ts` | Test content discovery pipeline |

---

## 16. Workflows & Examples

### Task Creation via Photo

1. User sends a photo of a handwritten to-do list
2. Claude Vision classifies it as "task" content
3. AI extracts the main title + sub-items
4. Creates a task in MS To Do with checklist steps
5. Bot sends confirmation with the created task details

### Invoice Auto-Filing

1. User sends a receipt/invoice photo (optional caption with vendor name)
2. Claude Vision identifies: vendor, amount, date, invoice number
3. Image is compressed (configurable JPEG quality)
4. Filed via SSH/SCP to the remote Mac directory
5. Recorded in `invoice_filings` table (dedup by vendor + invoice number)
6. Bot confirms: folder path, file size, compression savings
7. Offers an undo button if misclassified

### Morning Briefing (08:00 Daily)

Automatically sent at the configured time:
1. Fetches today's calendar events (both Google + Outlook)
2. Lists pending MS To Do tasks (priority, due today, overdue)
3. Shows today's reminders
4. Counts unread Outlook emails
5. Sends formatted message to all allowed user IDs

### Coach Analysis (21:00 or `/coach`)

1. Validates Garmin session (pre-auth before data fetch)
2. Fetches Garmin data (sleep, stress, HRV, training load, body battery, training readiness)
3. Fetches tomorrow's calendar events
4. Claude Sonnet analyzes training readiness vs scheduled activities
5. Returns structured recommendations: MODIFY / SWAP / REST for each event
6. Inline buttons to apply individual recommendations or all at once
7. Applying updates calendar event titles with action prefix

### Content Creation (Full Cycle)

1. **Tuesday 09:00** — Bot sends 5 Reel topic candidates with approve/skip/reject buttons
2. **User taps ✅** on 2 topics → stored in feedback table
3. **User runs** `/script [approved topic]` → full Reel script saved as .docx
4. **User sends .docx** with `/repurpose` caption → 3 Reels + Stories generated
5. **Thursday 09:00** — Bot sends 3 YouTube topic candidates
6. **User approves** 1 → runs `/script` → full YouTube script with timestamps
7. **Friday 18:30** — Bot sends weekly evergreen pack
8. **Sunday 03:00** — Channel patterns auto-refreshed

### Content Discovery (16:43 Daily)

1. Runs multi-source search (web, YouTube, news)
2. Scores by relevance, recency, and virality
3. Saves to `~/content-ideas/YYYY-MM-DD.md`
4. Sends Telegram notification with idea summaries
5. Inline buttons to save individual ideas for later (`/ideas saved`)

### Monthly Invoice Collection (1st of Month)

Three collection jobs run sequentially:
1. **09:00** — Email-based collection: scans inbox for vendor patterns, downloads + files
2. **09:15** — Amazon.es: browser automation, downloads order invoices, files via SSH
3. **09:30** — Uber: browser automation, downloads ride + food receipts, files via SSH

---

## 17. Architecture Patterns

### Message Processing Queue
Sequential per-user processing prevents race conditions when multiple messages arrive simultaneously. Commands are enqueued and processed in order.

### Three-Tier AI Classification
- **Tier 1:** Pattern match (regex, zero cost, instant)
- **Tier 2:** Keyword match (NL keywords, zero cost, instant)
- **Tier 3:** Claude Haiku classification (accurate, ~$0.001 per call)

This saves ~70% of AI costs compared to classifying every message with an LLM.

### Domain Isolation
Each domain (secretary, triathlon, content) has:
- Its own conversation history (SQLite, auto-pruned to 20 messages)
- Its own system prompt (content domain gets dynamic knowledge injection)
- Its own tool set
- Up to 4 tool-call iterations for complex multi-step tasks

### Content Learning Pipeline
```
YouTube API → Top 10 videos per channel (by views)
    ↓
yt-dlp → Transcripts for top 5 videos
    ↓
Claude Sonnet → Extract 9 pattern categories
    ↓
Claude Haiku → Synthesize cross-channel knowledge
    ↓
Runtime injection → buildKnowledgePromptBlock() → content domain system prompt
```

### Taste Learning Loop
```
Topic candidates → Telegram inline buttons (approve/skip/reject)
    ↓
content_topic_feedback table → 60-day rolling window
    ↓
buildTasteProfileBlock() → injected into topic generation prompts
    ↓
Better topics over time → more aligned with creator preferences
```

### Content Agent Mesh Architecture
```
Channel Learner → channel_dna signal → Intelligence Bus
Book Extractor → book_knowledge signal → Intelligence Bus
SEO Agent → keyword_rank_change signal → Intelligence Bus
Reaction Radar → reaction_opportunity → Intelligence Bus
Performance Agent → retention_pattern, hook_effectiveness → Intelligence Bus
Voice Evolution → voice_pattern, voice_phrase_trend → Intelligence Bus
    ↓
Intelligence Bus → All active signals → Script Writer prompt injection
    ↓
Script Writer reads signals + weaves into Claude prompt
    ↓
Script with hooks, frameworks, keywords, phrases integrated
```

### Serialized Auth Recovery (Garmin)
When multiple API calls get 403 simultaneously, ONE recovery attempt runs while others wait. Prevents MFA storm (10+ concurrent re-login attempts triggering 10 email codes).

### Circular Import Avoidance
The telemetry module (`src/portal/telemetry.ts`) has zero project imports — it receives dependencies via provider callbacks:
- `setDbProvider(fn)` — Lazy database reference
- `setBotRef(bot)` — Bot instance for restart action
- `setJobFailureNotifier(fn)` — Telegram alert callback

### State Caching
- Secretary domain: 30-second cache for task/calendar/email state
- Conversation history: 20 messages per domain (SQLite trigger)
- Pending edits: 2-minute TTL for inline keyboard workflows
- Snapshot cache: 3-second TTL for portal API

### Error Recovery
- **Telegram 409 Conflict:** Exponential retry (up to 5 attempts, 40s apart)
- **Job Failures:** Automatic Telegram alert + logged to `job_history`
- **HTML Parse Errors:** Automatic fallback to plaintext
- **Tool Errors:** Truncated to 2000 chars, returned to Claude for retry
- **JSON Truncation (Claude):** max_tokens set to 8192 for extraction tasks
- **Garmin Auth Race:** Serialized recovery prevents MFA storms

---

## 18. Troubleshooting

### Bot Not Responding

1. Check `/status` in Telegram for system state
2. Check the portal at `http://server:8200` for polling status
3. Check logs: `pm2 logs nexus-hub`
4. Common cause: Telegram 409 conflict (another instance polling). Wait 40s or restart.

### Microsoft Auth Expired

If Outlook/Calendar/To Do commands fail:
1. Run `scripts/get-outlook-token-v2.ts` to get a new refresh token
2. Update `OUTLOOK_REFRESH_TOKEN` in `.env`
3. Restart the bot

### Garmin Session Lost

1. The bot auto-recovers via OAuth2 refresh (every 30 min)
2. If MFA is required, the bot sends a Telegram message — reply with `/garminmfa <code>`
3. Use the portal Quick Action "Refresh Garmin" to force a refresh
4. For persistent issues: check `pm2 logs nexus-hub` for rate-limit backoff

### Transcripts Not Working

1. Verify yt-dlp is installed: `~/.local/bin/yt-dlp --version`
2. Update yt-dlp: `pip3 install --user --upgrade yt-dlp`
3. YouTube frequently changes their anti-bot measures; yt-dlp updates fix this

### Channel Learning Returns 0 Patterns

1. Check if `max_tokens` is sufficient (should be 8192 for extraction)
2. Check logs for JSON truncation errors: `pm2 logs nexus-hub | grep "Failed to parse"`
3. The channel will still be marked active but with 0 patterns — `/relearn` to retry

### Invoice Filing Fails

1. Test SSH connection: Portal Quick Action "Test SSH" or check `ssh -p 2222 user@localhost echo ok`
2. Verify the autossh tunnel is running on the Mac
3. Check `INVOICE_REMOTE_PATH` exists on the remote machine

### Database Issues

The SQLite database is at `./data/bot.db`. Migrations are idempotent and run on every startup. To reset:
```bash
rm data/bot.db
npm start  # Will recreate with all migrations
```

### Portal Not Loading

1. Verify `PORTAL_ENABLED=true` in `.env`
2. Check if port 8200 is in use: `lsof -i :8200`
3. If behind a firewall, ensure the port is open
4. Check browser console for auth errors (wrong `PORTAL_TOKEN`)

### Content Engine Not Working

1. Verify `CONTENT_ENGINE_ENABLED=true`
2. Check Python service: `curl http://localhost:8100/health`
3. Check `pm2 logs content-engine`
4. Ensure `.venv` is activated and dependencies installed

---

## Tech Stack Summary

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js 18+ / TypeScript |
| Bot Framework | Grammy |
| AI | Anthropic Claude (Haiku + Sonnet) |
| Database | SQLite via better-sqlite3 |
| Portal | Express.js (same process) |
| Content Engine | Python / FastAPI |
| Task Management | Microsoft To Do (Graph API) |
| Calendar | Outlook + Google Calendar |
| Email | Microsoft Graph (send + receive) |
| Fitness | Garmin Connect |
| YouTube | YouTube Data API v3 + yt-dlp |
| Word Documents | docx (npm package) |
| Browser Automation | Playwright |
| Image Processing | Sharp |
| Process Manager | PM2 (auto-start on reboot) |
| Logging | Pino |
