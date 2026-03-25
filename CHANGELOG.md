# Changelog

All notable changes to Cortex Telegram Hub Bot are documented in this file.

---

## [4.3.0] — 2026-03-25

### "The Operator" Unified Brand + Bug Fixes + New Commands

#### Brand Evolution
- Replaced niche-based content system with unified "The Operator" identity
- New creator profile: AI/Tech (35%), Commentary/Reactions (30%), Training/Lifestyle (20%), Gaming (5%), Wild Cards (10%)
- Asmongold-style recording + Gen Z meme editing as signature style
- All scripts now include `[SFX:name]`, `[EDIT:technique]`, `[SHOW ON SCREEN:]` markers
- SFX library: Vine Boom, FAHHH, Metal Pipe, Bruh, Sad Violin, Emotional Damage, Among Us, etc.
- Updated: creator_profile.py, script_writer.py, hook_generator.py, caption_writer.py, repurpose_engine.py, thumbnail_gen.py, scorer.py
- Updated prompts: content.md, topic-generation.md
- Updated: content-workflow.ts pillar system

#### Bug Fixes
- **CRITICAL**: Added streaming mode for Anthropic API calls >4096 tokens / Sonnet model (prevents 10+ min timeout crashes)
- **HIGH**: Garmin 403/404 on wellness/workout endpoints now return empty data instead of triggering MFA recovery loops
- **HIGH**: Content-engine `/gaps` endpoint — added error handling for non-JSON Claude responses + increased timeout to 300s
- **MEDIUM**: Dedup API rate limiting — added exponential backoff (1s/2s/4s, 3 retries) + 5-min in-memory cache
- **LOW**: Fixed hardcoded `/home/dominguez` paths in 3 files → uses `os.homedir()` consistently

#### New Commands
- `/reel [topic]` — Generate Reel/Short script with SFX markers and timing
- `/buildscript [project]` — Build log script (Hook → Problem → Build → Result)
- `/calendar [period]` — AI content calendar balanced across pillars (week/month)
- `/brandcheck` — Analyze last 30 days of content for pillar balance + suggestions

---

## [4.2.0] — 2026-03-25

### Autoresearch — Automated Prompt Optimization (Karpathy Pattern)

Self-improving prompt system that runs an automated loop: execute prompt → score output → mutate prompt → keep or revert → repeat.

#### Phase 1: Prompt Extraction
- Extracted all 6 system prompts from inline TypeScript to standalone `prompts/*.md` files
- New `src/utils/prompt-loader.ts` with mtime-based caching, template variable injection, and write-back support
- Prompts: secretary, content, triathlon, classifier, topic-generation, channel-learner
- Updated all call sites in `anthropic.ts`, `content-workflow.ts`, `channel-learner.ts`, `garmin-coach.ts`

#### Phase 2: Experiment Tracking
- New migration `018_autoresearch.sql` with `autoresearch_experiments` table and `autoresearch_summary` view
- Tracks every round: baseline score, new score, mutation description, prompt diff, decision (kept/reverted), git commit hash

#### Phase 3: Eval Criteria Registry
- Binary evaluation criteria for all 6 targets (23 criteria total, 22 test inputs)
- Weighted scoring: critical criteria (1.5x weight) for tool usage, worldview alignment, JSON validity
- Test inputs with realistic state context (calendar, tasks, Garmin metrics)

#### Phase 4: Core Eval Runner
- `runAutoresearch()` — full mutation loop with Haiku scoring + Sonnet mutations
- `runEvalOnly()` — single eval without mutation for benchmarking
- Automatic git commit on improvement, git revert on regression
- Early termination at 99%+ score
- Weekly target rotation by ISO week number

#### Phase 5: Telegram Commands + Scheduler
- `/autoresearch <target> [rounds] [--dry]` — run optimization with live progress updates
- `/evalscore <target>` — benchmark current prompt score
- Weekly cron: Sunday 01:00 Europe/Lisbon, rotating through all 6 targets (3 rounds each)

---

## [4.1.1] — 2026-03-24

### Portal Enhancements

#### Agent Communication Mesh Graph
- Interactive SVG node graph showing all 9 agents with signal flow connections
- Animated green pulse dots traveling along active signal connections
- Color-coded nodes: green (success), yellow (idle), red (error)
- Signal count badges on each agent node
- Glow animation on agents with active signals
- Central "Intelligence Bus" label connecting all agents
- Auto-updates every 30 seconds with Mission Control poll

#### Domain-Organized Quick Actions
- Quick Actions reorganized into 4 color-coded domain groups:
  - 📋 Secretary & Scheduling (purple): Morning Briefing, Clear History
  - 🏋️ Triathlon & Health (green): Refresh Garmin, Coach Report
  - 🎬 Content Creation (yellow): Discovery, Re-synthesize, Reaction Radar, SEO Agent, Performance Agent, Voice Evolution, Pipeline Agent
  - 🔧 System & Integrations (red): Test SSH, Test Graph, Restart Polling
- All 7 content agent runners now directly accessible from Quick Actions

---

## [4.1.0] — 2026-03-24

### Content Creation Consolidation — Sprints 1-4

#### Sprint 1: Command Cleanup
- `/script` is now the single entry point for script generation (always includes research + intelligence bus signals)
- `/genscript` → alias forwarding to `/script` (deprecated)
- `/discover` is the unified trend scanner with flags: `--news` (replaces `/hotnews`), `--platform` (replaces `/trending`), no flags = full discovery
- `/hotnews` and `/trending` → aliases forwarding to `/discover`
- `/help` redesigned with Content Quick Guide decision tree + reorganized into 6 logical groups

#### Sprint 2: Unified Idea Storage + Creative Staleness Fix
- Migration 016: `saved_ideas` extended with source, score, workflow_eligible, angle_tag, niche, hook_idea, why_now
- Content Discovery now saves ideas to SQLite (unified storage) instead of only markdown files
- Semantic dedup (`content-dedup.ts`): Claude Haiku checks topic+angle similarity across last 14 days before inserting any idea
- 10 angle tags tracked: opinion, reaction, how-to, story, myth-bust, comparison, data, framework, listicle, trending-take
- Angle diversity injection: 30-day distribution computed and injected into topic generation prompts (OVERUSED/UNDERUSED labels)
- Per-batch constraint: ≥3 different angles, max 2 per angle, ≥1 underused
- Discovery cross-pollination: workflow-eligible discovery ideas injected into Tue/Thu/Fri topic generation
- Book knowledge signals injected into topic generation prompts

#### Sprint 3: Feedback Loops + Reaction Criteria
- `/published` command enhanced: accepts URL-only, stores published_url/published_at (migration 017), writes `content_published` bus signal, shows idea-to-publish time
- `/reaction` now checks Reaction Radar signals first — shows pre-scored matches before running fresh scan
- Reaction Radar agent upgraded to 5-dimension scoring rubric (0-10 each):
  - Audience trigger, Controversy potential, Timeliness, Visual reactability, Pillar alignment
  - Minimum 25/50 to qualify; signal type unified to `reaction_opportunity`
- New signal types: `reaction_opportunity`, `content_published`

#### Sprint 4: YouTube Data Integration + SEO Dashboard
- New `youtube-analytics.ts` service: getVideoStats(), getRecentVideoStats(), checkKeywordRanking(), extractVideoId()
- `/feedback [URL]` (URL-only) now auto-fetches views/likes/comments from YouTube API
- `/seo` (no args) shows keyword ranking dashboard with trends
- `/seo track [keyword]` adds keyword to tracking + immediately checks current rank
- `YOUTUBE_CHANNEL_ID` configured for SEO Agent + Performance Agent

#### QA Bug Fixes
- Fixed `toggleSprint()` not on `window` — Sprint mode button in portal was broken (ReferenceError)
- Fixed portal Mission Control not rendering — `apiFetch()` returns raw Response, added `.then(r => r.json())`
- Added book upload form to portal (POST /api/books endpoint)

---

## [4.0.0] — 2026-03-24

### Content Agent Mesh — 9 Autonomous AI Agents + Intelligence Bus + Mission Control

#### Intelligence Bus
- New shared message system (`agent_signals` table) for inter-agent communication
- Signal types: `channel_dna`, `book_knowledge`, `keyword_rank_change`, `reaction_opportunity`, `retention_pattern`, `hook_effectiveness`, `voice_pattern`, `voice_phrase_trend`, `pipeline_bottleneck`, `seo_opportunity`, `pillar_performance`
- Auto-expiration (TTL), priority levels, consume/dismiss lifecycle
- `agent_runs` table tracks execution history with timing

#### Agents
- **Channel Learner** (upgraded) — Now writes `channel_dna` signals to the bus
- **Book Extractor** — 8-query web research + Sonnet synthesis into structured BookDNA; 6 Austrian economics books auto-seeded
- **SEO Agent** — Daily keyword rank tracking, opportunity detection, `seo_keywords` table
- **Reaction Radar** — Monitors reference channels + YouTube trending for reaction-worthy content
- **Performance Agent** — Analyzes content performance, retention patterns, hook effectiveness, pillar rankings
- **Voice Evolution Agent** — Tracks Felipe's evolving voice patterns and signature phrases
- **Pipeline Agent** — Manages content from idea → published, detects bottlenecks

#### Book Knowledge System
- `/addbook Title | Author` — Research and extract a book via web + Claude Sonnet
- `/booknote Title | Note` — Add personal insights (high-priority bus signals)
- `/books` — List library with extraction status, pillars, framework count
- `/bookidea [topic]` — Local keyword search across all book frameworks and ideas
- `book_library` table with core thesis, key frameworks, quotable ideas, pillar mapping

#### Script Writer Enhancement
- Reads ALL active intelligence bus signals and weaves them into Claude prompt
- Integrates: hook insights, voice patterns, SEO keywords, book frameworks, retention data, pillar rankings
- Intelligence block injected as structured context sections

#### Content Pipeline
- `/pipeline` — View content pipeline status (idea → scripted → filming → editing → published)
- `/filmed`, `/editing`, `/published` — Move items through stages
- `content_pipeline` table with stage tracking

#### Mission Control Portal
- New "Content Agent Mesh" section in the web portal
- Metric cards: active signals, pipeline items, books loaded, bottleneck status
- Agent cards grid with status badges, last run, signals produced, "Run Now" buttons
- Sprint Mode toggle (increases agent frequency)
- Intelligence Bus signal log with source, type, summary, age, dismiss button
- Book Library table with pillars, frameworks, reference count
- 6 new API endpoints: `/api/agents`, `/api/signals`, `/api/pipeline`, `/api/books`, `/api/signals/:id/dismiss`, `/api/override/sprint`
- 5 new quick actions: run-performance-agent, run-voice-evolution, run-reaction-radar, run-seo-agent, run-pipeline-agent
- Add Book form in portal (title + author + Extract button)

#### Bug Fixes
- Fixed Mission Control not rendering — `apiFetch()` returns raw Response, not JSON; added `.then(r => r.json())` to all calls
- Fixed migration 014 crash — referenced non-existent `content_references` table (correct: `content_ref_channels`)
- Fixed `/genscript` timeout — Python Claude client had 60s timeout, increased to 180s; bot-side bumped to 180s
- Fixed bot crash loop (11h downtime) caused by bad migration on startup

#### Database
- Migration 015: `agent_signals`, `agent_runs`, `book_library`, `seo_keywords`, `content_pipeline` tables

#### Documentation
- Updated to v4.0.0 with 18 sections (was 14)
- New sections: Content Agent Mesh, Book Knowledge System, Intelligence Bus, Google Drive Integration
- Updated: Bot Commands, Database Schema, Architecture Patterns, Mission Control Portal

---

## [3.9.0] — 2026-03-24

### Creator Profile Intelligence + Google Drive Integration + Deep Search Overhaul

All creative AI modules now inject Felipe's full creator profile (voice, worldview, audience) into every prompt. Deep search and hot news completely rebuilt for substantive, source-backed output. Google Drive integration for automatic DOCX uploads.

#### Creator Profile System (`content-engine/services/creator_profile.py`)
- **Single source of truth** — New `creator_profile.py` module with Felipe's full identity: conservative, Christian, libertarian, Austrian economics, anti-state, nuclear family, Brazilian men 18-35 audience.
- **Injected into ALL creative modules** — hook_generator, title_tester, caption_writer, thumbnail_gen, repurpose_engine, script_writer all now receive Felipe's voice, worldview, and audience context.
- **Before**: Generic outputs with no personality. **After**: Every output reflects Felipe's brand — direct, controversial, data-driven.

#### Creative Module Overhaul (all files in `content-engine/services/creative/`)
- **hook_generator** — Removed hardcoded template lists. Added contrarian/challenge trigger types. Hooks now reflect Felipe's anti-state, pro-freedom voice.
- **title_tester** — Added CONTRARIAN strategy. Scoring now includes brand alignment with conservative/libertarian voice.
- **caption_writer** — Full profile injection. Hashtag pools split by pillar (fitness, politics, faith, general). CTA drives debate, not generic "comenta aí".
- **thumbnail_gen** — Visual identity per content pillar (fitness: high contrast athletic; politics: red/black dramatic; faith: warm serious).
- **repurpose_engine** — All atomized content in Felipe's voice. Tweets provocative, reels open with controversy, polls spark debate.
- **script_writer** — Full creator profile in system prompt for worldview-aligned scripts.

#### Deep Search Overhaul (`content-engine/services/orchestrator.py`)
- **Multi-query research** — Generates 5 targeted search queries per topic (PT-BR + English) instead of 1 generic search.
- **AI-synthesized briefs** — Claude analyzes all sources and produces structured briefs with: key findings, data points, source URLs, Felipe's angle, and content opportunities.
- **Source attribution** — Every brief includes clickable source links and publication dates.
- **Hot news worldview filter** — `/hotnews` queries now target Felipe's pillars (politics, economics, fitness, faith) and filter through his conservative/libertarian lens.

#### Google Drive Integration (`src/services/google-drive.ts`)
- **Automatic DOCX upload** — All content outputs (scripts, research, news, analysis) automatically uploaded to Google Drive in organized folders.
- **Drive link in Telegram** — Each DOCX message now includes a clickable "Open in Google Drive" link.
- **Folder structure** — RESEARCH, IDEAS, SCRIPTS, VISUALS, REPORTS subfolders mirror local `~/Desktop/IDEAS/`.
- **OAuth2 with refresh** — Uses existing Google OAuth credentials with `drive.file` scope.

#### Content Engine Output Structure (`src/services/content-engine.ts`)
- **5-folder organization** — RESEARCH (deepsearch, sources, trending, hotnews), IDEAS (topics, hooks, titles), SCRIPTS (genscript, repurpose), VISUALS (thumbnails, captions), REPORTS (competitor, gaps, seo, feedback).
- **DocxResult type** — `saveContentAsDocx()` now returns `{ filePath, driveUrl }` instead of just a path.

#### Bug Fixes
- **Bot crash-loop fix** — Migration `014_missing_indexes.sql` referenced non-existent `content_references` table. Fixed to `content_ref_channels`. Bot was down ~11 hours due to this.
- **Script generation timeout** — Python httpx timeout increased from 60s to 180s. Bot-side fetch timeout increased to 180s to match.
- **Google token script** — Added Drive scope to OAuth token generation script.

---

## [3.8.0] — 2026-03-21

### Conversation Continuity + Secretary Intelligence + Content Engine Timeout Fix

Fixes a critical routing bug where follow-up replies to the coach briefing got hijacked to the wrong domain. Adds structured output templates and Garmin training awareness to the secretary domain.

#### Context-Aware Message Routing (`src/router/index.ts`, `src/services/anthropic.ts`, `src/bot.ts`)
- **AI-powered conversation continuity** — When an active conversation exists, the classifier receives the bot's last message as context and lets Claude decide whether the new message is a follow-up or a topic switch. Replaces fragile heuristics (time windows, message length, question detection).
- **Keyword bypass during active conversations** — When context is present, skips keyword matching entirely to prevent false hijacking (e.g. "calendar" in a training reply routing to secretary).
- **Photo handler fix** — Photos no longer fall back to `lastActiveDomain`. Invoice/screenshot photos route by caption keywords or the default secretary pipeline, preventing invoice photos from being sent to the wrong domain.
- **Coach briefing context preservation** — Both scheduled and manual coach briefings save to triathlon conversation history, so follow-up replies have full context.
- **`setLastActiveDomain()` export** — Scheduler can set conversation continuity for cron-triggered messages (coach briefing, content workflow).

#### Secretary Structured Output Templates (`src/services/anthropic.ts`)
- **Daily overview format** — When asked "what's my day", responds with structured: Alerts → Schedule → Training → Pending tasks.
- **Weekly overview format** — When asked "plan my week", responds with: Alerts → Per-day summaries → Balance check (Tech/Content/Training hours) → Suggestions.
- **Availability check format** — Quick ✅/❌ response with nearest open slots.
- **PT-BR friendly** — Templates use Portuguese labels (ALERTAS, AGENDA, TREINO, PENDENTE, BALANÇO, SUGESTÕES).

#### Secretary Garmin Awareness (`src/domains/secretary.ts`)
- **Training data injection** — Secretary context now includes last 3 days of Garmin activities (type, duration, distance, avg HR, calories) and current body battery level.
- **Missing training detection** — Flags days with no training logged in the context.
- **Body battery tracking** — Injects current body battery, charged/drained values for energy-aware scheduling.
- **Zero API overhead** — Fetched in parallel with existing To Do/Calendar/Mail calls.

#### Content Engine Timeout Fix (`content-engine/services/claude_client.py`, `src/services/content-engine.ts`)
- **Python API timeout** — Increased from 60s to 180s. `/genscript` runs deep_search + Sonnet script generation which can take 90s+.
- **Bot-side fetch timeout** — Increased from 120s to 180s to match the Python side.

---

## [3.7.0] — 2026-03-18

### Content Creator Learning System + Garmin Auth Hardening + Telegram Formatting

Major feature: AI-powered YouTube channel analysis, pattern extraction, and knowledge injection into the content domain. Plus Garmin auth fixes and unified Telegram HTML formatting across all domains.

#### Content Creator Learning System (`src/services/channel-learner.ts`, `src/state/content-references.ts`)
- **YouTube channel analysis pipeline** — Fetches top 10 performing videos per channel via YouTube Data API, sorted by view count
- **Claude Sonnet pattern extraction** — Analyzes video metadata + transcripts across 9 categories: hook_style, title_pattern, content_structure, editing_style, storytelling, cta_pattern, audience_engagement, visual_style, brand_voice
- **Cross-channel knowledge synthesis** — Merges patterns from all tracked channels using Claude Haiku with concatenation fallback for JSON parse errors
- **Dynamic prompt injection** — `buildKnowledgePromptBlock()` injects learned patterns into the content domain system prompt at runtime
- **4 default channels seeded** — Daniel Barada, Newel of Knowledge, Jett Franzen, Dan Koe
- **Weekly auto-refresh** — Scheduled channel re-analysis every Sunday at 03:00

#### YouTube Transcript Extraction (`src/services/youtube-transcript.ts`)
- **yt-dlp as primary fetcher** — YouTube blocks caption delivery from server IPs; yt-dlp handles YouTube's protections successfully
- **HTTP fallback** — Original caption URL approach retained as fallback
- **WebVTT parser** — `parseVttCaptions()` with timestamp parsing and segment deduplication

#### Video Study & Transcription (`src/services/video-study.ts`)
- **`/transcribe <url>`** — Fetches transcript via yt-dlp, saves as .docx to `~/Desktop/IDEAS`, sends file via Telegram
- **`/studyvideo <url>`** — Deep video analysis (hook breakdown, structure, content ideas, reel cuts), saved as .docx
- **DOCX generation** — Uses `docx` npm package for Word file creation with proper headings and formatting

#### Bot Commands (`src/bot.ts`, `src/router/index.ts`)
- **`/learnfrom <channel>`** — Add a YouTube channel for pattern learning
- **`/references`** — View tracked channels and their analysis status
- **`/relearn`** — Re-analyze all tracked channels with fresh data
- **`/transcribe <url>`** — Download video transcript as Word file
- **`/studyvideo <url>`** — Deep video analysis as Word file

#### Portal Integration (`src/portal/server.ts`, `src/portal/portal.html`)
- Content References card with add/remove channel UI
- Video Transcripts stats card
- Re-synthesize knowledge quick action button
- POST /api/channels and DELETE /api/channels/:id endpoints

#### Database Migrations
- **011_content_references.sql** — `content_ref_channels`, `content_patterns`, `content_knowledge` tables
- **012_video_transcripts.sql** — `video_transcripts`, `video_studies` tables

#### Garmin Auth Hardening (`src/services/garmin.ts`, `src/services/scheduler.ts`)
- **Serialized auth recovery** — `serializedAuthRecovery()` prevents parallel MFA storms; all concurrent 403s funnel through ONE recovery attempt instead of 10+ independent re-logins
- **Pre-authentication for coach** — `ensureAuthenticated()` validates session before batch API calls, avoiding race conditions
- **Keepalive offset** — Moved from `:00/:30` to `:05/:35` to prevent collision with coach job at `:00`
- **PM2 auto-start on reboot** — Registered `pm2-dominguez` systemd service with `pm2 startup` + `pm2 save`

#### Telegram HTML Formatting (`src/services/anthropic.ts`)
- **All 3 domain prompts** (secretary, triathlon, content) now enforce Telegram HTML formatting
- Explicit rules: only `<b>`, `<i>`, `<code>` tags — no markdown `**`, `##`, `---`, `| tables |`, or ``` code blocks
- Consistent visual language: emoji bullets (•, ▸), ━━━ section dividers, clean scannable layout

---

## [3.5.0] — 2026-03-16

### Garmin MFA Interactive Login + Multi-Feature Updates

Complete interactive MFA flow for Garmin Connect, plus portal improvements, routing fixes, and invoice queue system.

#### Garmin MFA Interactive Login (`src/services/garmin.ts`)
- **Full MFA-aware SSO flow** — Custom `loginWithMfa()` bypasses the `garmin-connect` library's broken `login()` entirely, using a fresh axios instance with manual cookie handling to avoid stale Bearer tokens
- **Telegram notification + code submission** — When Garmin requires MFA, the bot sends a Telegram message; user replies with `/garminmfa <code>` to complete authentication
- **Dynamic MFA form parsing** — Extracts CSRF token, hidden inputs, code field name, and submit URL from the actual MFA HTML page (handles Garmin's `mfa-code` field, `verifyMFA/loginEnterMfaCode` endpoint)
- **OAuth1 → OAuth2 token exchange** — After ticket extraction, completes the full OAuth flow and persists tokens to disk
- **Persistent rate-limit backoff** — Cloudflare Error 1015 / HTTP 429 detection triggers 2-hour backoff, persisted to `rate_limit_until.txt` (survives pm2 restarts)
- **Rate-limit detection on library errors** — `checkErrorForRateLimit()` parses error messages from `garmin-connect` library exceptions for rate-limit indicators
- **All login paths protected** — `getClient()`, `attemptReLogin()`, and `keepAlive()` check rate limits and MFA pending state before any SSO contact

#### Garmin MFA Bot Integration (`src/bot.ts`)
- **`setMfaNotifier()` registration** — Sends HTML-formatted Telegram messages when MFA is needed
- **`/garminmfa <code>` command** — Submits verification code to the pending MFA challenge with success/failure feedback

#### Portal Domain Tagging (`src/portal/telemetry.ts`, `src/portal/server.ts`, `src/portal/portal.html`)
- Domain tag tracking for messages processed through the portal
- Enhanced telemetry for domain-level visibility

#### Keyword Routing Fixes (`src/router/classifier.ts`, `src/domains/domain-handler.ts`)
- Improved keyword pattern matching for Portuguese terms
- Better domain routing for ambiguous messages

#### Invoice Queue System (`src/services/invoice-queue.ts`, `migrations/010_invoice_queue.sql`)
- **New invoice queue** — SQLite-backed queue for async invoice processing with retry logic
- **`enqueueInvoice()`** / **`getPendingCount()`** — Queue management functions
- **Scheduled processor** — Runs every 15 minutes to process pending invoices

#### SSH Connection Testing (`src/services/invoice-filer.ts`)
- **`testSshConnection()`** — Exported function for portal health checks and diagnostics

#### New Files
- `src/services/invoice-queue.ts`, `migrations/010_invoice_queue.sql`

#### Modified Files
- `src/services/garmin.ts`, `src/bot.ts`, `src/services/scheduler.ts`
- `src/portal/portal.html`, `src/portal/server.ts`, `src/portal/telemetry.ts`
- `src/router/classifier.ts`, `src/domains/domain-handler.ts`
- `src/services/invoice-filer.ts`

---

## [3.4.0] — 2026-03-15

### Portal Dashboard Enhancements — Timeline, Email Log, Job History

Five new visual features for the Cortex Status Portal, plus email delivery tracking and persistent job history.

#### 1. Daily Timeline View
- Horizontal 24h timeline at the top of the dashboard showing today's activity
- Color-coded blocks: blue (calendar), purple (cron jobs), orange (emails), green/red (completed/failed)
- Red "NOW" marker for current time, auto-refreshes every 10s

#### 2. Email Delivery Log
- New `email_log` SQLite table tracks every `sendEmail()` call (recipient, subject, status, source, error)
- Portal card: "Email Automations" with today's sent/failed counts + full delivery history table
- Fossa email and any future automated emails are automatically tracked

#### 3. Next Scheduled Runs Panel
- Computes next fire time for all 14 cron jobs using `cron-parser` with timezone support
- Shows countdown ("in 2h 15m"), sorted by next-to-fire
- Answers the question "what's happening next?"

#### 4. Job History Sparklines
- New `job_history` SQLite table persists every job execution (result, duration, timestamp)
- Mini bar charts (last 10 runs) inline in the Scheduled Jobs table
- Green bars = success, red bars = failure — instant visual health check

#### 5. System Health Summary Bar
- Compact sticky bar under the header with at-a-glance status
- Shows: jobs OK/total, emails sent today, API cost, invoices this month, uptime

#### New Files
- `migrations/008_email_log.sql`, `migrations/009_job_history.sql`

#### Modified Files
- `src/portal/portal.html` — all 5 new dashboard features
- `src/portal/server.ts` — snapshot builder: email log, job history, next runs, health summary
- `src/portal/telemetry.ts` — job history persistence to SQLite via DB provider
- `src/services/outlook-mail.ts` — email delivery tracking on sendEmail()
- `src/services/scheduler.ts` — fossa email source tag
- `src/index.ts` — wire up DB provider for telemetry
- `package.json` — added `cron-parser` dependency

---

## [3.3.0] — 2026-03-14

### Cortex Status Portal — Self-Hosted Web Dashboard

Real-time monitoring dashboard for all bot subsystems, accessible at `http://server:8200`. Single-page app with 10-second auto-refresh, Bearer token auth, and 8 quick actions.

#### Dashboard Sections
- **Bot Status** — Polling state, last message timestamp, process uptime
- **API Usage** — Today/7d/30d cost and call counts by category
- **Integrations** — Live status for Telegram, Microsoft Graph, Garmin, SSH, Anthropic
- **Scheduled Jobs** — All 14 cron jobs with last run time, duration, result, errors
- **Invoices** — Monthly filing counts and 10 most recent filings
- **Quick Actions** — 8 buttons (Garmin refresh, trigger reports, clear history, restart polling, test SSH/Graph)
- **Activity Log** — Ring buffer of 200 most recent events

#### Architecture
- Express on port 8200 inside the same pm2 process
- Single snapshot endpoint (`GET /api/snapshot`) with 3s cache
- Bearer token auth via `PORTAL_TOKEN` env var
- Transparent Anthropic API hook records all Claude calls to SQLite `api_usage` table
- In-memory telemetry singleton with job tracking wrappers

#### New Files
- `src/portal/server.ts`, `src/portal/telemetry.ts`, `src/portal/anthropic-hook.ts`, `src/portal/portal.html`
- `migrations/007_api_usage.sql`

#### Modified Files
- `src/index.ts`, `src/config.ts`, `src/bot.ts`, `src/services/scheduler.ts`
- `src/services/anthropic.ts`, `src/services/invoice-filer.ts`, `src/services/garmin-coach.ts`, `src/services/content-discovery.ts`
- `scripts/deploy.sh`, `.env.example`, `package.json`

---

## [3.2.0] — 2026-03-14

### Garmin Session Keep-Alive & Resilience

Prevents Garmin API sessions from dying silently by proactively refreshing OAuth2 tokens and adding multi-layer recovery to all API calls.

#### Proactive Token Refresh (`src/services/garmin.ts`)
- **`keepAlive()` export** — Proactively refreshes OAuth2 using the OAuth1 token, validates with a lightweight API call, falls back to full re-login if refresh fails
- **`refreshOAuth2()`** — Directly calls `garmin-connect`'s `refreshOauth2Token()` on the underlying `HttpClient`, bypassing the library's 401-only interceptor
- **`attemptReLogin()`** — Credentials-based re-login as last resort when token refresh is exhausted

#### 3-Step Error Recovery (`src/services/garmin.ts`)
- **`safeGet()` rewritten** — On 401/403 errors, now attempts three recovery steps in order:
  1. OAuth2 token refresh (fixes 403 errors the library's interceptor misses — it only handles 401)
  2. Token reload from disk (handles concurrent refresh by other calls)
  3. Full re-login with credentials (last resort)
- **Root cause**: `garmin-connect` library's axios interceptor only triggers `refreshOauth2Token()` on HTTP 401, but Garmin frequently returns 403 Forbidden for expired tokens — leaving the refresh mechanism dead

#### Scheduled Keep-Alive (`src/services/scheduler.ts`)
- **Every 30 minutes cron** — Calls `garminKeepAlive()` to refresh tokens before they expire, with error logging if all attempts fail
- Logged in scheduler startup summary

#### Bot Startup Retry Logic (`src/index.ts`)
- **409 Conflict handling** — Retries `bot.start()` up to 5 times with 40s delay when Telegram returns 409 (previous polling instance still active after pm2 restart)
- Prevents crash loops during deployments

#### Coach Report HTML Fix (`src/services/garmin-coach.ts`)
- **Stray `<` escaping** — Regex escapes `<` characters that aren't valid Telegram HTML tags (e.g., `<5h58m`, `<100 bpm`) to `&lt;`, preventing parse failures

#### Manual Report Trigger (`src/trigger-reports.ts`)
- **New script** — `npx tsx src/trigger-reports.ts [content] [coach] [evening]` to manually fire any report on demand
- Useful for recovering missed scheduled reports

#### Modified Files
- `src/services/garmin.ts`, `src/services/scheduler.ts`, `src/services/garmin-coach.ts`, `src/index.ts`

#### New Files
- `src/trigger-reports.ts`

---

## [3.0.0] — 2026-03-11

### Content Creation Engine (Phases 1–5)

Full-stack AI-powered content creation pipeline — Python FastAPI microservice on port 8100, wired into the TS bot via 16 new Telegram commands.

#### Python Content Engine (`content-engine/`)
- **FastAPI microservice** — 16 endpoints under `/api/v1/`, running as a separate pm2 process
- **Phase 1 — Research Core**: `/deepsearch` (SerpAPI + scraping), `/sources` (cached research), `/hotnews` (NewsAPI aggregation)
- **Phase 2 — Trend Analysis**: `/trending` (YouTube Data API), `/reaction` (reaction-worthy video finder)
- **Phase 3 — Creative Modules**: `/hooks` (hook generator), `/script` (full video scripts), `/titles` (CTR-optimized titles), `/thumbnail` (concept ideas), `/caption` (social captions + hashtags)
- **Phase 4 — Intelligence**: `/competitor` (channel analysis), `/gaps` (content gap finder), `/seo` (keyword clustering), `/repurpose` (cross-platform suggestions)
- **Phase 5 — Feedback Loop**: `/feedback` (metric storage), `/report` (performance reports)
- **Claude client** (`services/claude_client.py`) — httpx-based, no SDK dependency; Haiku 4.5 for structured JSON, Sonnet 4.6 for long-form scripts
- **Config singleton** (`config.py`) — reads from parent `.env` via `python-dotenv` with `override=True`

#### TypeScript Bot Integration (`src/services/content-engine.ts`)
- **12 response interfaces** — typed for all Phase 2–5 responses
- **13 API client functions** — with phase-appropriate timeouts (30s default, 120s for scripts)
- **13 Telegram HTML formatters** — null-safe, with `escapeHtml()` and `splitMessage()` for large responses
- **AbortController timeout pattern** — custom per-endpoint timeouts
- **HTML parse error fallback** — `isHtmlParseError()` → strip tags and retry as plaintext

#### Command Handlers (`src/bot.ts`)
- **13 new `bot.command()` handlers**: `/trending`, `/reaction`, `/hooks`, `/genscript`, `/titles`, `/genthumbnail`, `/gencaption`, `/competitor`, `/gaps`, `/seo`, `/repurpose`, `/feedback`, `/report`
- **`gen*` prefix convention** — `/genscript`, `/genthumbnail`, `/gencaption` avoid collision with existing domain-routed commands
- **Typing indicator keep-alive** — `setInterval` every 4s for long Claude calls
- **Updated `/help`** — new "CONTENT ENGINE" section with all 16 commands

#### Router Updates
- **`classifier.ts`** — 2 new regex patterns for content domain routing
- **`router/index.ts`** — 13 commands added to `SYSTEM_COMMANDS` array to bypass domain classifier

#### Model Upgrades
- **Sonnet 4 → Sonnet 4.6** (`claude-sonnet-4-6`) — both Python engine and TS bot conversational AI
- **Haiku 3.5 → Haiku 4.5** (`claude-haiku-4-5-20251001`) — Python engine structured generation (3x cheaper than Sonnet)

#### Infrastructure
- **`python-dotenv`** with `override=True` — loads parent `.env` before any config import
- **pm2 ecosystem** — content-engine runs as separate pm2 process alongside telegram-hub-bot
- **Migration 006** — `content_engine` table for feedback storage
- **`.gitignore`** — added `content-engine/data/`

---

## [2.0.0] — 2026-03-10

### Garmin Coach v2: Interactive Calendar Recommendations

Complete overhaul of the `/coach` Garmin Daily Coach feature — now with data-driven training recommendations that can edit Outlook/Google Calendar events via inline buttons.

#### Interactive Recommendations (`src/bot.ts`)
- **Inline action buttons** — After the briefing, actionable recommendations (MODIFY/SWAP/REST) appear as Telegram buttons the athlete can tap to apply directly to tomorrow's calendar
- **Apply individually or all at once** — Each recommendation has its own button, plus "Aplicar todas" for batch apply
- **`coach:` callback handler** — Processes `coach:apply:`, `coach:all:`, and `coach:dismiss` actions
- **`applyCoachRecommendation()`** — Routes MODIFY/SWAP → `updateCalendarEvent()` with new title/times; REST → marks event as "❌ CANCELLED"

#### Structured LLM Output (`src/services/garmin-coach.ts`)
- **`CoachRecommendation` interface** — Typed recommendations with `eventId`, `source` (outlook/google), `action` (KEEP/MODIFY/SWAP/REST), `newTitle`, `newStart/End`, `summary`
- **`<!-- COACH_RECS_START -->` JSON block** — Claude outputs machine-parseable JSON after the human-readable briefing; Telegram's HTML renderer ignores HTML comments
- **`extractRecommendations()` parser** — Extracts and validates the JSON block with graceful fallback
- **Calendar event IDs in payload** — Tomorrow's calendar events now include `id` and `source` fields so Claude can reference specific events

#### Payload Truncation Fix (`src/services/garmin-coach.ts`)
- **Root cause**: `activityDetails` was 24KB of raw exercise set data, pushing calendar events past the 12K char truncation point — Claude never saw tomorrow's training plan
- **`summarizeActivityDetails()`** — New function in `garmin.ts` compresses raw activity data (exercise sets, splits, running dynamics) from ~24KB → ~1KB of coaching-relevant metrics
- **Payload reordering** — Critical data (recovery metrics → tomorrow's calendar → activities) now comes first to survive any truncation
- **Truncation limit raised** — 12K → 40K chars (Claude handles 200K context; 12K was leaving 95% unused)
- **Result**: Payload shrank from 44K → 20K with zero truncation; all data visible to Claude

#### Data Summarization (`src/services/garmin.ts`)
- **`summarizeSleep()`** — Extracts key sleep metrics from ~200KB raw blob (~500 bytes)
- **`summarizeStress()`** — Overall stress level, duration by category (~200 bytes)
- **`summarizeHeartRate()`** — RHR, max/min HR, 7-day avg (~150 bytes)
- **`summarizeHrv()`** — Weekly avg, last night, baseline, status (~200 bytes)
- **`extractBodyBatterySummary()`** — Current/highest/lowest/charged/drained from events data
- **`summarizeActivityDetails()`** — Per-activity: training effect + exercise summary (set counts, exercise names, key metrics)
- **`extractErrorStatus()`** — Parses garmin-connect's string-formatted errors (`"ERROR: (403), Forbidden"`) via regex for proper 401/403 detection and token refresh

#### Garmin MFA Bootstrap (`scripts/garmin-mfa-bootstrap.js`)
- New script for one-time Garmin login with MFA — generates OAuth1/OAuth2 token files that the bot loads on subsequent runs

#### Diagnostic Logging
- **Data collection summary** — Logs calendar counts, training event names, activity names after fetch
- **Payload stats** — Logs raw payload length, truncation status, calendar event count in payload

#### Modified Files
- `src/bot.ts`, `src/services/garmin-coach.ts`, `src/services/garmin.ts`, `.env.example`

#### New Files
- `scripts/garmin-mfa-bootstrap.js`

---

## [1.9.0] — 2026-03-08

### Unified Image Classifier: Invoice / Calendar / Task

Single Haiku vision call replaces two sequential calls, adding calendar-image support and saving one API call on invoice photos.

#### New Feature: Calendar Event Creation from Photos (`src/bot.ts`)
- **Calendar image detection** — Photos of schedules, shift rosters, agendas, and timetables are now recognized and create Outlook Calendar events instead of To Do tasks
- **SMS / EC categories** — Caption containing "SMS" → Blue Category, "EC" → Green Category on created events
- **Correction button** — "❌ Não é calendário" inline button reclassifies as task (mirrors existing invoice correction flow)
- **Multi-event support** — A single schedule image can produce multiple calendar events

#### Unified Classifier (`src/services/anthropic.ts`)
- **Single API call** — New `classifyAndExtractImage()` replaces both `analyzeInvoiceImage()` + `extractImageContent()` in the photo handler
- **Discriminated union** — `ImageClassificationResult` type with `type: 'invoice' | 'calendar' | 'task'` for clean TypeScript narrowing
- **Exported types** — `ImageInvoiceResult`, `ImageCalendarResult`, `ImageTaskResult`, `ExtractedCalendarEvent`
- **Combined prompt** — Invoice indicators (nota fiscal, recibo, fatura), calendar indicators (date+time grids, shift schedules), task indicators (checklists, bullet points)

#### Outlook Calendar Categories (`src/services/outlook-calendar.ts`)
- `categories?: string[]` added to `createEvent()` — passed through Graph API POST body
- Propagated through `unified-calendar.ts` → `tool-executor.ts` → tool schema

#### Refactored Photo Handler (`src/bot.ts`)
- Extracted `handleInvoiceFiling()` from inline code
- New `handleCalendarExtraction()` with event loop, category support, correction callback
- Renamed `handlePhotoTaskExtraction()` → `handleTaskExtraction()` with typed `ImageTaskResult`
- New `parseCaptionCategory()` helper
- New `cal:undo` callback handler (mirrors `nf:undo` pattern)

#### Modified Files
- `src/bot.ts`, `src/services/anthropic.ts`, `src/services/outlook-calendar.ts`
- `src/services/unified-calendar.ts`, `src/services/tool-executor.ts`

---

## [1.8.1] — 2026-03-08

### Security Hardening & Reliability Fixes

21 fixes from code review — security, cost optimization, error handling, and reliability improvements.

#### Security
- **Shell injection prevention** — `execFileSync` with argument arrays replaces `execSync` string interpolation in `invoice-filer.ts`
- **SSH host key policy** — `StrictHostKeyChecking=accept-new` (TOFU) replaces unconditional `=no`
- **Session file permissions** — Amazon session cookies written with `chmod 0o600`
- **Cryptographic callback IDs** — `crypto.randomUUID()` replaces sequential counters for callback references
- **Bot token redaction** — Debug log uses webhook URL path instead of exposing token

#### Cost Optimization
- **Graph API `$select`** — `getTasks()` now fetches only needed fields (~60% payload reduction)
- **Consolidated unread query** — New `getUnreadEmails()` replaces separate count + list calls

#### Error Handling
- **13 silent catches fixed** — `scheduler.ts` (5), `amazon-collector.ts` (3), `microsoft-todo.ts` (2), `bot.ts` (3) — all now log with `logger.warn`/`logger.error`
- **Month validation** — Invoice filer validates month index 0-11 before PT_MONTHS lookup

#### Reliability
- **Amazon overall timeout** — 5-minute hard cap prevents runaway Playwright sessions
- **Playwright resource blocking** — Aborts images/fonts/CSS/media during scraping (faster page loads)
- **Shared memory cleanup throttle** — Rate-limited to once per 5 minutes instead of every read
- **Browser close logging** — `browser.close()` failures logged instead of silently swallowed
- **Reply waiter dedup** — `registerReplyWaiter` resolves existing waiter before replacing

#### Database
- **`migrations/005_indexes.sql`** — Indexes on `invoice_filings(vendor, source_ref)` and `invoice_filings(document_date)`

#### Modified Files
- `src/bot.ts`, `src/services/amazon-collector.ts`, `src/services/anthropic.ts`
- `src/services/invoice-filer.ts`, `src/services/microsoft-todo.ts`
- `src/services/outlook-mail.ts`, `src/services/scheduler.ts`
- `src/services/tool-executor.ts`, `src/state/shared-memory.ts`

#### New Files
- `migrations/005_indexes.sql`

---

## [1.8.0] — 2026-03-08

### Amazon.es Invoice Collection via Playwright

Browser-automated invoice download from Amazon.es with interactive 2FA support through Telegram.

#### New Feature: Amazon Collector (`src/services/amazon-collector.ts`)
- **Playwright browser automation** — Logs into Amazon.es, navigates order history, downloads real tax invoices (not order summaries)
- **Interactive 2FA** — OTP codes and CAPTCHAs handled via Telegram: bot sends screenshot, user replies with code
- **Session persistence** — Saves browser cookies to `data/amazon-session.json` to avoid repeated logins
- **Configurable** — `AMAZON_EMAIL`, `AMAZON_PASSWORD`, `AMAZON_COLLECTION_ENABLED`, `AMAZON_HEADLESS`

#### `/amazon` Command (`src/bot.ts`)
- `/amazon` — Collect invoices for current month (default)
- `/amazon 2026-02` — Collect invoices for specific month
- `/amazon --force` — Clear previous filing records and re-download (fixes bad runs)
- 2FA reply interception — Text messages during Amazon collection are captured as OTP/CAPTCHA responses

#### Scheduled Collection (`src/services/scheduler.ts`)
- **Monthly cron at 09:15 (1st of month)** — Runs 15 min after email vendor collection; no interactive 2FA in cron mode

#### `--force` Re-collection (`src/state/invoice-filings.ts`)
- `deleteAmazonFilings(year, month)` — Removes all Amazon filing records for a given month, allowing full re-download

#### New Files
- `src/services/amazon-collector.ts` (1197 lines)

#### Modified Files
- `src/bot.ts`, `src/config.ts`, `src/services/scheduler.ts`, `src/state/invoice-filings.ts`
- `package.json` (added `playwright` dependency)

---

## [1.7.0] — 2026-03-08

### Automated Monthly Invoice Collection + Image Compression

Email-based invoice collection from configured vendors, with audit logging and photo compression.

#### New Feature: Invoice Collector (`src/services/invoice-collector.ts`)
- **Monthly cron job (1st at 09:00)** — Searches Hotmail for PDF invoices from configured vendors (Santander, ViaVerde, Aegon, NOS)
- **Dynamic vendor learning** — `/addfatura` (add), `/rmfatura` (remove), `/faturas` (list); two-tier system with hardcoded builtins + user-added DB vendors
- **Filing audit log** — `invoice_filings` SQLite table tracks all filed invoices (vendor, amount, date, source, compression stats)
- **`/invoices [YYYY-MM]`** — Manual trigger for on-demand collection

#### Image Compression (`src/services/invoice-filer.ts`)
- **Sharp JPEG compression** — mozjpeg quality 80; only applies if compressed size < original
- Configurable via `INVOICE_COMPRESSION_ENABLED` and `INVOICE_JPEG_QUALITY`

#### Outlook Mail Extensions (`src/services/outlook-mail.ts`)
- `getAttachments()`, `downloadAttachment()`, `searchEmailsByFilter()` (OData `$filter`)

#### New Files
- `src/services/invoice-collector.ts`, `src/state/invoice-filings.ts`, `src/state/invoice-vendors.ts`
- `migrations/004_invoice_filings.sql`

#### Modified Files
- `src/bot.ts`, `src/config.ts`, `src/services/invoice-filer.ts`, `src/services/outlook-mail.ts`, `src/services/scheduler.ts`

---

## [1.6.1] — 2026-03-08

### Fix Invoice Collection for Personal Outlook Accounts

Three bug fixes for Hotmail/personal account compatibility.

- **Client-side sender matching** — Replace OData `contains()` filter (unsupported on personal accounts) with post-fetch domain matching
- **PDF extension matching** — Detect PDFs sent as `application/octet-stream` by checking `.pdf` file extension
- **Vendor pattern fixes** — Fix Aegon hyphen (`aegon-santander.pt`), add ViaVerde `extracto` subject pattern
- **Anti-false-positive** — Domain matching prevents cross-vendor misattribution
- **`$orderby` fallback** — Personal account compatibility for email sorting

#### Modified Files
- `src/services/invoice-collector.ts`, `src/services/outlook-mail.ts`

---

## [1.6.0] — 2026-03-08

### Revert to SSH/SCP Invoice Filing

Apple's SRP-6a auth protocol changes broke all pyicloud-based tools, making iCloud FUSE mounts on Linux impossible.

- **Restored SSH/SCP filing** — Reverted from local filesystem writes back to SSH/SCP via reverse tunnel
- **Restored SSH config** — `sshHost`, `sshPort`, `sshUser`, `sshKeyPath`, `remotePath`
- **Re-enabled autossh** — Reverse tunnel on Mac via launchd plist

#### Modified Files
- `src/config.ts`, `src/services/invoice-filer.ts`

---

## [1.5.1] — 2026-03-08

### Invoice Filing: SSH/SCP → Local Filesystem

Replaced SSH/SCP transfer to Mac with direct local filesystem writes to iCloud Drive FUSE mount on Linux.

#### Simplified Architecture
- **Local writes instead of SSH/SCP** — `fs.mkdirSync` + `fs.writeFileSync` replace `execSync` SSH/SCP commands
- **Removed 4 dependencies**: `child_process`, `os`, SSH key management, reverse tunnel infrastructure
- **Config reduced from 7 to 3 settings**: `INVOICE_FILING_ENABLED`, `INVOICE_LOCAL_PATH`, `INVOICE_MIN_CONFIDENCE`
- **Removed autossh reverse tunnel**: No longer need Mac ← Server SSH bridge

#### What's Unchanged
- Haiku vision invoice detection + metadata extraction
- Year/month folder structure with Portuguese month names
- Smart filenames + collision prevention
- Confidence threshold + correction flow ("Não é nota fiscal")
- Graceful degradation when unconfigured

---

## [1.5.0] — 2026-03-07

### Invoice/Receipt Photo Filing to iCloud

Automatic invoice detection and filing from Telegram photos to iCloud Drive.

#### New Feature: Invoice Filing Engine (`src/services/invoice-filer.ts`)
- **Haiku vision analysis** — Single API call detects invoices AND extracts metadata (vendor, date, amount, invoice number) at ~$0.001/call
- **iCloud filing** — Files written directly to iCloud Drive folder, synced automatically
- **Year/month folder structure** — Auto-creates `2026/Mar-2026/` directories with Portuguese month names (Jan, Fev, Mar, Abr, Mai, Jun, Jul, Ago, Set, Out, Nov, Dez)
- **Smart filenames** — `YYYY-MM-DD_Vendor_Amount_InvoiceNumber_SUFFIX.jpg` format with filesystem-safe sanitization
- **Confidence threshold** — Only files images with ≥70% invoice confidence (configurable via `INVOICE_MIN_CONFIDENCE`)
- **Correction flow** — Inline "Não é nota fiscal" button re-routes misclassified images to task extraction
- **Graceful degradation** — Feature auto-disables when path is unconfigured; errors fall through to existing task extraction

#### Photo Handler Refactored (`src/bot.ts`)
- Extracted `handlePhotoTaskExtraction()` for reuse from both direct photo flow and correction callback
- Three-branch routing: caption domain routing → invoice detection → task extraction fallback
- New `nf:` callback namespace for invoice correction with 5-min TTL callbackStore

#### Configuration (`src/config.ts`)
- New `invoices` config section: `INVOICE_FILING_ENABLED`, `INVOICE_LOCAL_PATH`, `INVOICE_MIN_CONFIDENCE`
- `isInvoiceFilingConfigured()` guard checks enabled + local path

#### New Files
- `src/services/invoice-filer.ts`

#### Modified Files
- `src/bot.ts`, `src/config.ts`

---

## [1.4.0] — 2026-03-07

### 12 Feature Improvements

#### New Features
- **Cross-domain shared memory** — SQLite key-value store with optional TTL; facts set by one domain (e.g. race dates, rest days) are visible in all domains' state context. Tools: `shared_memory_set`, `shared_memory_remove`
- **Content discovery feedback loop** — After `/discover`, inline 💾 buttons let you save individual ideas; `/ideas saved` shows all saved ideas
- **`/ideas [date]` command** — View content ideas by date from `data/content-ideas/`; lists available dates if requested date not found
- **Photo routing to active domain** — Photos with captions are routed via keyword matching → last active domain fallback → secretary default (previously all photos went to task creation)
- **Proactive conflict detection** — Cron at 19:30 checks tomorrow's calendar for overlapping events and sends a Telegram alert
- **Unsupported media handlers** — Voice, video, document, and sticker messages get a friendly "not supported" reply instead of being silently ignored

#### Improvements
- **6 missing MS Todo tools exposed** — `ms_todo_move_task`, `ms_todo_get_checklist`, `ms_todo_add_checklist_item`, `ms_todo_get_lists`, `ms_todo_create_list`, `ms_todo_delete_list` (executors existed but Claude couldn't use them)
- **PT-BR keyword patterns** — Classifier now matches Portuguese keywords for all domains (e.g. treino, corrida, tarefa, lembrete)
- **Typing indicators** — Added to `/status`, `/day`, `/week` commands; periodic 4s typing for `/discover` (~2 min operation)
- **Inline edit flow fixed** — `td:ef` callback now stores pending edit state (2-min TTL); next text message is captured as the edit value instead of routing to domains
- **Tool reasoning in history** — Conversation history now stores `[Tools: tool1, tool2]` prefix so future turns have context about what actions were taken

#### New Files
- `migrations/002_shared_memory.sql`, `migrations/003_saved_ideas.sql`
- `src/state/shared-memory.ts`, `src/state/saved-ideas.ts`

#### Modified Files
- `src/bot.ts`, `src/domains/secretary.ts`, `src/domains/domain-handler.ts`
- `src/services/anthropic.ts`, `src/services/scheduler.ts`, `src/services/tool-executor.ts`
- `src/router/classifier.ts`

---

## [1.3.0] — 2026-03-07

### Performance & Cost Optimization

20 fixes targeting API cost reduction and runtime performance.

- Server-side OData filtering for MS Todo (reduced payload ~70%)
- Per-domain conversation history limits (secretary: 10, others: 6)
- Per-domain model selection (Sonnet for secretary, Haiku for triathlon/content)
- Per-domain max_tokens (secretary: 2048, others: 1024)
- Prompt caching on system prompts and tool arrays
- State context cache (30s TTL) to avoid redundant API calls on rapid messages
- Memoized tool array (computed once at startup, guarantees cache hits)
- Tool result truncation at 2000 chars
- Slim mutation results (~80% token reduction)
- Shared domain handler for triathlon/content (eliminated code duplication)

---

## [1.2.1] — 2026-03-06

### Replace 15-min Task Alerts with End-of-Day Summary

- Removed the every-15-minute "task due soon" proactive alerts (too noisy)
- Added end-of-day task summary at 21:00 — shows tasks due today + overdue with days late
- Task due date info now only sent twice a day: morning briefing (06:00) and end-of-day summary (21:00)

---

## [1.2.0] — 2026-03-06

### Remove Qlik Sense & AWS Domains

Streamlined the bot to focus on the three active domains: Secretary, Triathlon, and Content.

- Removed `qliksense` and `aws` from `DomainName` type
- Deleted `src/domains/qliksense.ts` and `src/domains/aws-expert.ts` handler files
- Removed Qlik Sense and AWS sections from `/help` text
- Removed from DOMAIN_HANDLERS map, classifier patterns, keyword routes, and classifier prompt
- Updated secretary system prompt (removed Tech/Qlik/AWS/DevOps mentions)
- Updated `/clear` command to only list active domains

---

## [1.1.0] — 2026-03-06

### Daily Content Discovery

Automated trending topic discovery using Claude web search, delivering daily content ideas for YouTube/Instagram.

#### New Feature: Content Discovery Engine (`src/services/content-discovery.ts`)
- Uses Claude Sonnet with web search tool (5 searches per run) to find trending topics across content niches
- Content niches: Fitness/gym, running/cycling, politics/news, viral reaction content, self-development
- Target audience: Young Brazilian men (18-25), all output in PT-BR (Brazilian Portuguese)
- Audience archetype: Lucas, 20yo from São Paulo — loves learning, hates laziness, wants personal growth
- Generates 8-10 structured content ideas with hooks, key points, title options, and virality estimates
- Includes Quick-Fire Shorts section and Cross-Niche Mashup ideas
- Handles Claude `pause_turn` for long search sessions
- Saves full detailed output to `data/content-ideas/YYYY-MM-DD.md`
- Returns parsed idea titles + file path for notification

#### New Scheduled Job
- **Daily at 16:43**: Runs content discovery (~2min), sends Telegram notification with idea headers and file location by 16:45

#### New Slash Command
- `/discover` — Manual trigger for content discovery (same output as scheduled job)
- Added to SYSTEM_COMMANDS in router to prevent classifier routing

#### Updated Content Domain Prompt
- Enriched with Lucas audience profile, PT-BR focus, content pillars (fitness, running, cycling, politics, self-development)
- Aligned with content-creation skill and discovery engine

#### Files Changed
- `src/services/content-discovery.ts` — NEW: core discovery module
- `src/services/scheduler.ts` — Added 16:43 daily cron job
- `src/bot.ts` — Added `/discover` command handler + updated HELP_TEXT
- `src/router/index.ts` — Added `/discover` to SYSTEM_COMMANDS
- `src/services/anthropic.ts` — Updated content domain system prompt
- `scripts/test-discovery.ts` — Test script for content discovery

---

## [1.0.0] — 2026-03-06

### Initial Release

Full-featured Telegram personal command center with multi-domain AI routing.

### Core Architecture
- Multi-domain AI routing: Secretary, Qlik Sense, Triathlon, AWS Expert, Content Creator
- Three-tier message classification: slash commands → keyword matching → Haiku classifier
- Conversation history per domain (last 10 messages)
- SQLite database for persistent state (reminders, notes, todos)
- PM2-managed process with auto-restart on boot (Linux server)

### Secretary Domain — AI Assistant
- Natural language task management via Claude Sonnet
- Tool-use loop (up to 4 iterations) for complex multi-step requests
- Dynamic tool filtering — skips unconfigured service tools to save tokens
- Slim mutation results — ~80% token reduction on create/complete/update/delete operations
- Empty response fallback guard
- Input validation on all mutation tools (task_id required)
- Tool result truncation at 2000 chars to prevent context overflow

### Microsoft To Do Integration
- Full CRUD: create, update, complete, uncomplete, delete tasks
- List management: get lists, create list, delete list
- Search tasks across all lists
- Get tasks due in date range
- Move tasks between lists
- Checklist items: get, add steps to tasks
- Batch operations: get all pending tasks, completed tasks in range
- Self-created task tracking (in-memory Set) to avoid notification loops

### Slash Commands (20+)
- `/help` — Full command reference
- `/day` — Today's agenda summary
- `/todos` — Pending to-do list
- `/done [task]` — Mark task as complete
- `/newtask` — Create task via natural language
- `/overdue` — All overdue tasks across lists
- `/duetoday` — Tasks due today
- `/dueweek` — Tasks due this week
- `/alltasks` — All pending tasks grouped by list
- `/completed [list]` — Recently completed tasks (last 7 days)
- `/movetask <task> | <list>` — Move task to another list
- `/edittask <task> | <new title>` — Rename a task
- `/notetask <task> | <note>` — Add description to task
- `/addstep <task> | <step>` — Add checklist item
- `/steps <task>` — Show checklist steps
- `/remind` — Set reminder
- `/reminders` — List active reminders
- `/note` — Save a note
- `/notes` — Search notes
- Plus domain-specific commands (Qlik, calendar, email)

### Calendar Integration (Unified)
- Google Calendar + Outlook Calendar support
- Create, update, delete events
- Day/week view queries
- Auto-detection of calendar source from event ID format

### Outlook Email Integration
- Search emails, read full messages
- Send new emails, reply to threads
- Unread count and recent emails

### Photo/Vision Support
- Send a photo of subtasks → automatic task creation with checklist items
- Uses Haiku for cheap OCR extraction (3x cheaper than Sonnet)
- Caption-aware: mention a list name in caption to target specific list
- Direct API calls — no extra tool overhead

### Scheduled Notifications
- **Every minute**: Check and fire due reminders
- **Every 15 min**: Proactive alerts for tasks due within 1 hour
- **Every 5 min**: Shared list monitoring — notify on new tasks from others (seed-based deduplication)
- **Daily at 06:00**: Morning briefing with full schedule, tasks, overdue, reminders, emails
- **Friday 17:00**: Weekly review with completion stats and overdue summary
- **Daily midnight**: Clear self-created task cache + shared list seed reset

### Morning Briefing
- Full schedule timeline with event times
- Training/workout detection
- Task count + yesterday's completed
- High priority tasks listed explicitly
- Due today tasks
- All overdue tasks with "Xd late" indicator
- Reminder details with times
- Unread email count
- Quick action shortcuts

### Cost Optimizations
- Haiku classifier for routing (~$0.001/classification vs $0.009 with Sonnet)
- Haiku for photo OCR extraction
- Dynamic tool filtering — skip unconfigured service tools (~450 tokens saved/call)
- Slim mutation results (~80% token reduction per tool call)
- Prompt caching on system prompts and tools
- Conversation history capped at 10 messages
- Tool result truncation at 2000 chars
- secretaryMaxTokens: 2048 (balanced for parallel tool calls)

### Robustness
- task_id validation on all mutation tools before API calls
- Empty response fallback guard (prevents Grammy "message text is empty" error)
- Telegram message splitting for messages >4096 chars
- Graceful error handling on all external API calls
- Rate limit awareness (30k input tokens/minute)
