# Changelog

All notable changes to Nexus Hub (formerly Cortex Telegram Hub Bot) are documented in this file.

---

## [4.6.1] — 2026-04-03

### Bug Fixes, DST Recovery & Calendar UX

#### Fix: Content domain max_tokens overflow
- `handleContent()` received Telegram user ID as `maxTokensOverride` parameter, sending `max_tokens: 7807541475` to the Anthropic API (Haiku limit: 64K)
- Fix: aligned `handleContent` signature with other domain handlers

#### Fix: JSON parsing failures in channel knowledge synthesis
- `synthesizeKnowledge()` and `extractPatterns()` used a naive regex to strip markdown fences — failed when LLM added text around the JSON block
- Fix: robust JSON extraction with fence matching + `{`...`}` boundary fallback

#### New: DST Watchdog — automatic recovery for missed cron jobs
- `node-cron` silently skips fixed-time jobs during DST transitions (Europe/Lisbon spring forward)
- Watchdog runs at `:02/:17/:32/:47` (offset from normal crons) with 2-min minimum overdue threshold
- Seeds `lastRunAt` from `job_history` table on startup so restarts don't re-fire jobs
- 3-hour max window prevents stale recovery

#### Fix: Calendar image events created on past dates
- When user sends a calendar screenshot showing last week's dates, events were created in the past
- Fix: vision prompt instructs Claude to shift past dates forward; post-extraction safety net auto-shifts by whole weeks preserving weekday alignment

#### New: Calendar text follow-up context
- Text messages like "create the events in outlook" after a calendar preview now trigger creation directly
- 10-minute context window per user with regex-based intent detection (PT/EN)

#### Fix: EADDRINUSE on deploy
- Graceful shutdown now `await`s `portalServer.close()` before `process.exit()` so port 8200 is released

#### Infra
- Google Calendar token re-authenticated via OAuth Playground
- `HEALTH_TOKEN` configured for `/health/detailed` endpoint

---

## [4.4.0] — 2026-03-26

### Content Accuracy Framework — Anti-Hallucination System

#### Fact-Verification Layer
- All scripts now pass through mandatory fact-grounding rules embedded in system prompts
- Script writer enforces `[VERIFIED: source]`, `[TAKE]`, and `[NEEDS VERIFICATION]` inline tags
- Research context now includes full source URLs so Claude can reference them in scripts
- Every script ends with `📋 FONTES VERIFICADAS` section listing verified sources + alerts

#### Source Registry (`source_registry.py`)
- Tier 1: Official primary sources (TSE, STF, Planalto, PubMed, Cochrane, Reuters, AP)
- Tier 2: Reputable journalism (Folha, Estadão, G1, BBC Brasil, Bloomberg)
- Fact-checkers: Agência Lupa, Aos Fatos, AFP Checamos, Reuters Fact Check
- Tier REJECT list: anonymous channels, partisan blogs, content farms
- High-risk category classifier: political_status, legal_outcome, election_data, economic_statistics, health_claims, person_status, recent_events

#### Automatic Verification Queries
- `get_verification_queries()` detects political, economic, and health keywords in topics
- Adds targeted verification queries to deep_search (e.g. `site:tse.jus.br`, `site:portal.stf.jus.br`)
- Political topics get 2 extra verification queries, economic get 2, health get 2

#### Content Prompt Updates
- `prompts/content.md` updated with non-negotiable accuracy section
- `script_writer.py` system prompt includes full accuracy rules + FONTES format
- All factual claims must come from RESEARCH FINDINGS, never from LLM memory
- Opinions tagged `[TAKE]` so Felipe knows what's commentary vs. verified fact

Triggered by: Bolsonaro 2026 election hallucination incident where LLM stated he would run despite being legally barred until 2030.

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
## [Unreleased]

### Bug Fixes

- Resolve merge — remove duplicate financeEncryption, fix tests ([`4763421`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/4763421501b3e4cb66d3844e15ce30619838dbaa))
- **agents**: Fix allTasks scope — fetch once for Steps 1.5 + 1.6 ([`9eebd36`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/9eebd36eed7e2cc6a3522d719f5fc7d9d6985165))
- **agents**: Add orphan recovery — re-queue QA Validating tasks with no queue file ([`82f537a`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/82f537ab0a416887a13f3f82f62937c3a8ee7029))
- **agents**: Quote pwd in CLAUDE.md, fix placeholder bug, resolve type errors ([`a33f445`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/a33f44505c2348b5c9f78d6af74ec5fe2bae25aa))

### Documentation

- Update changelog for v4.5.0 ([`eba2e31`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/eba2e31dd5dd0732286b8704fddb4166d957b7a5))

### Features

- **infra**: Add health check endpoint + uptime monitoring ([`53109b3`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/53109b3e0cbc3b4f66e7b35a7e626111f957aeca))
- **portal**: Add adapter status panel (Telegram active, WhatsApp planned) ([`0c58483`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/0c584833cdcf2e97d0a3ee909696dd3ff9407068))
- **finance**: Add per-user data isolation + AES-256-GCM encryption for financial data ([`d2c559d`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/d2c559d3ff4c09dafa6c7789a3fd39864feeda63))
- **sdk**: Design @nexushub/skill-sdk package with builder API ([`438470f`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/438470f23b36228a01e60081d1588e8ccbd854ba))
- **skills**: Implement /skill enable|disable + sub-module toggles ([`5513f49`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/5513f49c95ee8a78cdca07a736c47326af89790e))

## [4.5.0] — 2026-04-02

### Bug Fixes

- **agents**: Queue cleanup runs every cycle, active task removed from queue count ([`49c3d9e`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/49c3d9e085134e40e469f96e454925717db75717))
- **agents**: Validate QA queue against Notion before dispatch — remove Done/stale tasks ([`eced132`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/eced13283debece14a21ee8c7dc1f022a6521f31))
- **mc**: Fix JS syntax error in agent tab — mismatched quote in queue display ([`abc2055`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/abc2055c965bf388b3d3d0a8f5f20218cd132e0e))
- **mc**: Show QA2 queue count in UI, fix stale task check for both QA agents ([`9cefb6a`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/9cefb6aad7303b134fe8781fa5a18e213eae5d8c))
- **agents**: Auto-assign loop now checks QA queues and dispatches idle QA agents ([`a674514`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/a67451492bf20863e65d5c6617e7bbf085d682bc))
- **skills**: Add credential encryption manager and security audit tests ([`ec4f71e`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/ec4f71ee78e2553be5ce647f74cd5588f740e3c9))
- **mc**: StartAll/stopAll include 6 agents, resolve bot.ts merge conflict ([`5d2fc35`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/5d2fc357818718848985610ca5fcf5fbe20f6242))
- **bot**: Derive /skill valid domains dynamically from DEFAULT_SKILLS ([`61921ef`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/61921ef814a07e5bc42de332adeaaafc51d565b5))
- **test**: Update finance tax tool count assertion (3→4 after annual_summary added) ([`b2d1d77`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/b2d1d776a228f610d8bb2f5b91a23e4f70094e2c))
- **db**: Renumber fitness training migration 021→023 to avoid collision ([`dda4b15`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/dda4b15311186e96b1ffc6b3a41d337fdb78e983))
- **test**: Update migration numbering test to allow shared prefixes ([`5ebeaa4`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/5ebeaa4e21991328d212b25492d51aa94a1c5095))
- **notifications**: Remove idle spam, stop broken --check-only calls ([`7d25ba1`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/7d25ba1b19dbf4b109fd670fa69ac6bd1672ad23))

### Chores

- Bump version to 4.4.6 [deploy] ([`31ffc55`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/31ffc5532c4c5530d8db502bafe7d1121365bc8e))

### Documentation

- Update changelog [skip ci] ([`4d7f6f3`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/4d7f6f36a23ede1c901d1bb4310d0a6263528f51))
- Generate CHANGELOG.md with git-cliff (v1.0.0 → v4.4.5) ([`f0a085e`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/f0a085e63deec8a29ed2952eafd17d4b35e85ec7))

### Features

- **skills**: Implement /skills and /skill commands — list installed skills ([`c1df5fd`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/c1df5fdfb75f0df2269111c1e55c1ffc9ba4d552))
- **finance**: Add annual tax summary, receipt auto-logging, and amount parsing ([`356a88d`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/356a88da9fdc178ddca39a2eb450d1115a330f97))
- **metering**: Add per-user per-day AI usage metering system ([`859b77c`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/859b77cdd65f94f38a06df236f52d7e963f65ec3))
- **bot**: Add /skills and /skill commands for skill inspection ([`48496ee`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/48496eefedd3f2202cbb19f76d0e115206efa6d1))
- **portal**: Add /health endpoint for uptime monitoring ([`9f94001`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/9f940019d4581d2e24f78c185d595672c9c026a1))
- **ux**: Telegram HTML message template design system ([`4450a60`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/4450a607ef8f44d60f171ba1a5becc8e6acb51b8))
- **cooking**: Add Cooking Chef skill — recipes, meal planning, shopping lists ([`76edda5`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/76edda5d90bdc9583dc83112b1997510716b1873))
- **onboarding**: Reusable multi-step questionnaire system with profiles ([`9c64ec8`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/9c64ec8d971320d09a40fbea5ac4cb517f31dc0b))
- **calendar**: Deduplicate events across Google + Outlook calendars ([`d1a5cd6`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/d1a5cd67cce6247db4cf2fb1606e2747f9ecf111))
- **agents**: Cross-agent learning v2 — shared context + content formulas ([`984cb04`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/984cb04a9e274a1e7adcdbfa7444d7705a16561c))
- **finance**: Add Finance Tracker skill with DARF/Carnê-Leão tax calculation ([`c0dae41`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/c0dae41eb3aacf298e6413f6b7d5a4c370526aa3))
- **triathlon**: Add fitness training plans with calendar blockers + weekly auto-adjust ([`efa6e9a`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/efa6e9af4687826f4fc8db40633b9957f3073bc4))
- **webhooks**: Add event-driven integration layer infrastructure ([`41a5d7b`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/41a5d7b1f8c8d5a8acf8dfa1731986370cf93578))
- **portal**: Add skill module status section to Status Portal ([`dbf3e35`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/dbf3e35db739d7da10a4c52704d478d9df984fbd))
- **monitoring**: Add self-hosted error monitoring with Telegram alerting ([`27631ac`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/27631acc49656d7e7e1b6343e0046d00634a40ed))
- **router**: Dynamic skill registration via extensible DomainName type ([`caf6525`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/caf6525924488a00262abbceda8d68e9656b92fa))
- **router**: Dynamic skill-based routing via SkillRegistry ([`4cb8827`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/4cb8827885a820e8266cd3f1d74053833897c073))
- **metering**: Add usage metering system to track AI messages per tenant per day ([`bd60df8`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/bd60df8e5bfabc20e6a90b5c133d73328f6cb127))
- **portal**: Add skill management panel with enable/disable toggles ([`8f62fdd`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/8f62fddf551a50c4a8282e9af03541ed313fdca3))
- **config**: Add ConfigProvider abstraction for per-tenant config ([`48ac864`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/48ac8646ba227fe39a40b428c9f83360847f8cd6))
- **agents**: Add Frontend + QA2 agents with QA routing by origin ([`7399abe`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/7399abe8892863faab5676c2f16f652c6929a0e5))
- **deploy**: Auto-generate CHANGELOG.md on merge develop → main via git-cliff ([`2bdd94e`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/2bdd94edb31f53303605ba75d9fcbd5b7b356329))

### Refactor

- **skills**: Migrate content creator domain to skill package with granular sub-skills ([`0ac665a`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/0ac665a0450feb71ed3b531f8a70437bd7dbd53d))
- **router**: Verify dynamic skill registration + add finance/cooking route tests ([`b01509f`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/b01509fdd9e3dfe0f168a75d143c2179d076dab2))
- **skills**: Migrate secretary domain to skill package with granular sub-skills ([`1ea1d27`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/1ea1d2779fe4b2df6e8f153b195944ee290df5d6))

### Tests

- **qa**: Validate /skills command refactor — fix stale assertions, update QA tests ([`564a275`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/564a2751b2fb4e792fe971f79baa6ea60adafeac))
- **qa**: Validate content skill v2 refactor — 31 new tests, fix 5 stale assertions ([`b073071`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/b0730716a968f7b023c0f1baef39a60694229682))
- **metering**: Add 26 QA validation tests for usage metering system ([`71051f9`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/71051f9c762db583155eea9418dd438fce9b9b67))
- **skills**: Add 24 QA validation tests for /skills command ([`2e5a1d5`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/2e5a1d5a1474e95344ebd1c089c3cd3e50d878e2))
- **portal**: Add 15 QA validation tests for health check endpoint ([`a0f12c9`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/a0f12c9da66464631d7c3b24ab868b0ea11ba7dd))
- **cooking**: Add 50 QA validation tests for Cooking Chef feature ([`06e9552`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/06e95524bcfe55a2796b044d45674b2e9215f52c))
- **onboarding**: Add 43 QA validation tests for smart onboarding questionnaires ([`1750b82`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/1750b822427dc073542a4ca2a3105b9c05ab2889))
- **calendar**: Add 18 QA validation tests for calendar event deduplication ([`2e75793`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/2e757935410913b5baf185fc7cfd895bf52adf91))
- **agents**: Add 26 QA validation tests for cross-agent learning v2 ([`5c3ad28`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/5c3ad28f8747a39a8d23a5e093ef0a252c42098a))
- **finance**: Add 37 QA validation tests for finance tracker + per-user data isolation ([`1c1d21c`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/1c1d21c824c62e3460ea9b90b2c773ed4cf48ebe))
- **webhooks**: Add 42 QA validation tests for webhook registry event-driven layer ([`d201bde`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/d201bdee6b05f01461c0189f3c7054bad2f234c5))
- **migrations**: Add 21 QA validation tests for skill database migrations ([`abef3b1`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/abef3b1d74756b6ec1527b662739be08830ad88f))
- **skills**: Add 21 QA validation tests for secretary skill package refactor ([`9ce9dbd`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/9ce9dbdf55a3f979bbcd1005374e96118e50801e))
- **portal**: Add 27 QA validation tests for skill management panel ([`62a7a5a`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/62a7a5a2e7c9b62deafd32099b4aed0f44511ba7))
- **regression**: Add 233 skill extraction regression tests — Sprint 2 merge gate ([`9af5387`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/9af5387b1545e7c21e45fbb561061244aceae025))
- **config-provider**: Add 25 QA validation tests for per-tenant config system ([`ffe002c`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/ffe002c9cf080639d6cd875e383480c27ed46ab3))

## [4.4.5] — 2026-04-01

### Bug Fixes

- **brand**: Rename Cortex IDEAS → Nexus Hub IDEAS in google-drive.ts ([`feda4b2`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/feda4b27d4200e5111fed880ebf23b406c45b7c2))
- **brand**: Rename package.json nexus-hub → @nexushub/core ([`329d639`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/329d639298ba6118a2b69eb6635c69f5743a727b))
- **agents**: Verify code commits before chaining to QA, auto-push unpushed work ([`aac954d`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/aac954d5a33d1b0f7da089073eec97678532bc8f))
- **agents**: Auto-launch on every cycle, fix path escaping, clearer status labels ([`0d59c55`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/0d59c55298dc5e6012ff4378b9686f22d22e0b95))
- **agents**: Auto-assign validates stale tasks against Notion, recovers orphaned In Progress tasks ([`da0768a`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/da0768a6198e4cb27062cfebd392e44719c06337))
- **ci**: Changelog workflow creates PR instead of pushing to protected main ([`0822557`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/08225571a145d8e0fedb32a5f92d536072cf4508))
- **git**: Correct merge-develop flow, add agent/backend branch, run tests before push ([`293a8bf`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/293a8bfe1b7632d35cf19a78cb8a9c43476cdee6))
- **voice-evolution**: Use correct column name full_text in transcript query ([`de28f2e`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/de28f2e96e935971acbf4d86230c2d238d82e759))
- **mission-control**: Stop-all kills by PID, add dispatch task UI panel ([`619619c`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/619619c5af97df4f188aa0794a2b138cf3f97a63))
- Remove stale QA validation tests from agent branches, 831 tests pass ([`db80812`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/db80812176849dc04240d077d09b717e84df0c51))

### CI/CD

- **portal**: Add integration health panel with OAuth token status ([`ebe90fe`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/ebe90fef642f85e72dce984b01a866e39d74b563))
- **backup**: Add automated daily database backup with 30-day rotation ([`faf63b5`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/faf63b5589261054e4a46a3bf3084cfe181b10fb))
- **brand**: Update domain references from nexushub.ai to nexushub.me ([`593f6d3`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/593f6d3392a12ffe672bd63e19591b054efedb92))
- Add dispatch-task.js for manual agent bootstrapping ([`ac99b64`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/ac99b648901afd4f99f9117db0a35a562b55170a))
- Add git-cliff auto-changelog on push to main ([`ff98ecf`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/ff98ecfa1ed2418229c1f879498de07b0496c35a))

### Chores

- **legal**: Add MIT copyright headers to all 80 src/ files ([`33c8276`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/33c8276fd099791ef2ccd3167bdcb2234c0eb080))
- Bump version to 4.4.4 [deploy] ([`5e22696`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/5e22696d549f2624ea250b5bd3ed541d4caafe0f))
- Bump version to 4.4.3 [deploy] ([`3d558df`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/3d558dfc600c366b9c5124ed5256f13796103583))

### Documentation

- **agents**: Portal update is now mandatory for all user-facing features ([`0aa11e6`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/0aa11e66b65e6ff91f91264364cb13e19a46fe24))

### Features

- **skills**: Granular sub-skill architecture — domains become skills with toggleable sub-skills ([`52a9c5b`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/52a9c5b3b77a250bc8b3a10d7752176cb1c826eb))
- **portal**: Add domain handler status section (pre-skill modules) ([`b0559b5`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/b0559b52f7747dfa90c50397a78819ff2214f623))
- **agents**: Server-side auto-assign loop (45s) + auto-launch offline agents + UI auto-refresh (30s) ([`1064c41`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/1064c416d5a06af9a206b34c969faf0a963436f6))
- **agents**: Auto-orchestration, Telegram notifications, simplified Mission Control ([`5c2a325`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/5c2a32588908e324dcb40cd1a8e26fbe91c65a87))

### Tests

- **skills**: Add 47 QA validation tests for granular sub-skill architecture ([`6df8472`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/6df84720f140a7115def55edac0e7a6feba086c9))
- **portal**: Add 39 QA validation tests for domain handler status panel ([`564c608`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/564c6081d85ade01691375348a86c6c2e39a479a))
- **portal**: Add 43 QA validation tests for integration health panel ([`c234aec`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/c234aec7da267686e1479c8a26ebff9977eac6dc))
- **brand**: Add 6 QA validation tests for MIT copyright headers ([`a5deef2`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/a5deef211dd7009050ac81e93890839296d3d7ba))
- **brand**: Add 11 QA validation tests for @nexushub/core rename ([`ede9604`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/ede96045d8c6a5010f5e3286e8985095d6f1c904))
- **integration**: Add 44 message flow integration tests ([`10c1357`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/10c13575c67fc9728d58109fe9a07c6e1b5425e2))
- **agents**: Add 19 QA validation tests for Voice Evolution transcript column bug ([`6512f6a`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/6512f6a626be2bb4a49df93b4d7971030868295f))
- **skills**: Add 40 QA validation tests for SkillRegistry + SkillLoader ([`7fc7ac7`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/7fc7ac720a0a0a118eceb34d3b95fd73110cc091))

## [4.0.0] — 2026-03-31

### Bug Fixes

- **skills**: Align types and registry with QA branch conventions ([`f5da4fa`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/f5da4fa3e173f9fdffbd33f39db6e665b8b773e6))
- **ops**: QA fail handler writes .agent-task.json alongside fix prompt ([`195576c`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/195576c790be6827c7e174aef652706292ba033c))
- **ops**: Dispatch reads .env.agents, terminal button uses tty detection ([`ab8d89a`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/ab8d89a71514e98925ed441ac6fa9cce541ff5b8))
- **ops**: Ensure NOTION_TOKEN available to all agents via symlinks + env export + multi-path fallback ([`c58f921`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/c58f92132f8b6a8eae5730bdb318cb3347eb0afc))
- **db**: Rename duplicate 019 migration to 020 ([`3607acc`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/3607accc006d26256cfe6836c63ab0e6cdb9d54c))
- Remove ghost account felipedrfwow, hardcode author ([`2b97351`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/2b97351f0d48e605635c69638f98d0cd91eeb2b0))
- DST watchdog hardening, calendar date shifting & follow-up context (v4.4.2) (#5) ([`2acb8e9`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/2acb8e981ee5719cdc23dbd4f94608b49deeb047))
- **deploy**: Rebuild native modules for PM2's Node version ([`f5568b3`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/f5568b36821f09861745c6c4a5535514bd0d0526))
- **deploy**: Increase health check wait to 10s with retry ([`118f15b`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/118f15b61bb488e606fd98928f7401d94b00db49))
- Add Notion release logging to deploy.sh, fix secrets check in workflows ([`f9240b1`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/f9240b1c7e5959a05a6d4ed8565548a58f5fd2f2))
- **ci**: Lower coverage thresholds to match current main state ([`82fe363`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/82fe3634e299fabd84759cdd811210d64953f2f0))
- Address PR #4 review — raise coverage thresholds, env vars for server creds, add task dispatcher ([`d417dac`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/d417dace6d91b85b800b9cd53455d0cbc0e3d4b7))
- Max_tokens overflow, JSON parsing & DST watchdog (v4.4.1) ([`6261307`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/6261307ae373bbd18f51fd2b8034a2be424a0373))
- Portal Mission Control not rendering + add book form to portal ([`37494fa`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/37494fa16d26e1d34174053d6a8ea1a7ebb7a718))
- Security hardening + memory cleanup + DB indexes + invoice atomicity ([`96b0341`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/96b0341121e73e6342dfc86df76302a5b2d122b0))
- Context-aware message routing replaces heuristic-based continuity ([`8bcc6a2`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/8bcc6a27a55746806b477cd1207175a446313002))
- Resolve PM2 crash-loop (6742 restarts) + improve restart policies ([`526ea15`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/526ea15ec0d5fd221f9e822da908a0b362fa1461))
- Coach apply now updates/deletes existing events instead of creating duplicates ([`d72e7ef`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/d72e7ef31e41a21aa689fcd784cc942e114024dc))
- Coach report formatting + triathlon apply-via-chat + deploy script ([`128f50e`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/128f50e688c75f66c0ac0421a05ce7daff1f4779))

### CI/CD

- **skills**: Create SkillRegistry service ([`70d8ea5`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/70d8ea5ddbb1dc36c2735f7de7ba7bf9cbbc6356))
- **db**: Add skill registry database migrations ([`fbbab87`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/fbbab87c156f84fd2637bb287978a30f35e13132))
- Add mandatory acceptance criteria for agent review handoff ([`2b39a2e`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/2b39a2e44c5195535d81f85f596441dfe0f568f1))
- **db**: Add skill registry database migrations ([`77c14ae`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/77c14aecbc18e30d1acada4ae24495dfee484208))
- Make CD manual-only, add DEPLOY.md, update CLAUDE.md with deploy rules ([`577883e`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/577883ecfaf0ba7bc8e2540c4aa9b5ae7fc758f1))
- Make CD manual-only (server is IPv6, GitHub runners can't reach it) ([`24e5c40`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/24e5c409fb9c5a9daa8ce5b991978db4e591cd5b))
- Add bug agent role, hotfix workflow, updated CLAUDE.md ([`4de0551`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/4de0551d10a5ec68c393c885681380bd220919fc))
- Add server sync script for pulling production changes ([`0ff1b55`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/0ff1b553d65a7b4fc5df28d9e245fe535b1aa554))
- Add multi-agent worktree setup, CLAUDE.md, and agent status scripts ([`03b8d4c`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/03b8d4cce937395e7ff145943b6ea28985baf9b2))
- Lower coverage thresholds for initial test phase ([`255dc22`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/255dc221479f829616fe5ff9fd252f9b56140242))
- Add CI/CD pipeline, test framework, rollback system, branching strategy ([`914e88b`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/914e88b7a01780968862358e8fcfe1fe8652d3ca))

### Chores

- Bump version to 4.4.2 [deploy] ([`29cd41f`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/29cd41ffa000e82682c87dfa367ad51fb4e7523b))

### Documentation

- Update changelog with v4.1.1 portal enhancements ([`3da0f59`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/3da0f59440421ab21b0668f37beb289e04454909))
- Update changelog with v4.0.0 bug fixes ([`ae2bbd9`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/ae2bbd95973649ee79ed90e48850237edefb437c))
- Update changelog with context-aware routing details ([`8055c92`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/8055c924c4d8a021d5d435586c128189a90507f4))
- Update documentation to v3.7.0 + content workflow guide + creator profile ([`208438f`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/208438fba64364c23de02d3e3348e096a1783c83))
- Add v3.5.0 changelog entry for Garmin MFA + multi-feature updates ([`3b1abe4`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/3b1abe464dd41bf1ae41445b130373e2f81fd6a3))

### Features

- **adapters**: Implement WhatsAppAdapter with Cloud API ([`7b9c89e`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/7b9c89e54e8acd3a0fcf1c9d1fde4a94f77191af))
- **adapters**: Implement TelegramAdapter with Grammy ([`11e5762`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/11e5762cae57e03eaa1228c6717b3d12f59f2f03))
- **providers**: Add per-task-type provider fallback with circuit breaker ([`1b1f815`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/1b1f815ecbcd852129d60089a3b56b3bdbb85606))
- **skills**: Create SkillLoader service with manifest validation and dependency resolution ([`b134e5b`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/b134e5b9c0315f9804c7c903ac011a4f85799e0c))
- **skills**: Define NexusSkill interface and manifest types ([`cc467f0`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/cc467f0d4b2ba2e390f8d57e1b88e06a59fb77cc))
- **storage**: Create StorageProvider interface with SQLiteStorage implementation ([`6fb34b5`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/6fb34b5d99ac4697c9c85226bba678d47ae9e84e))
- **skills**: Create SkillLoader service for dynamic skill packages ([`8ce4cd6`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/8ce4cd611f3ff5e6532620400ff4ec6b7fd8ca44))
- **bot**: Add /version command + auto-bump version on deploy ([`cd6e7f6`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/cd6e7f6cb26b03ae951056d0bbd29047cd4bd2e3))
- **core**: Add OpenAI and Gemini AI providers (#7) ([`805c055`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/805c05533fcb04e664f8ef7fddce70ff546eb25c))
- **ops**: Autonomous agent mode - self-chaining pipeline with QA queue ([`57172d6`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/57172d6b69b1da3a8513e22a83dbe0b7403c5739))
- **ops**: Add Mission Control portal, agent-complete self-chain, updated dispatch ([`3f9489a`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/3f9489a8af316bea7fbfe556a0bd670511533ca7))
- **core**: Add OpenAI and Gemini AI providers (#7) (#8) ([`8182818`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/818281882b4ced7d11e8ddf8bfa48c7c4af72679))
- **core**: Add AIProvider interface, AnthropicProvider, and full router tests ([`dedd8a1`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/dedd8a1fc1442306031fd6d77b90fd29073163f3))
- Content Accuracy Framework — anti-hallucination system (v4.4.0) ([`96b7963`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/96b79634ad75fe832f5d5381b160e93295dd9abe))
- The Operator unified brand + bug fixes + new commands (v4.3.0) ([`52ca4a2`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/52ca4a25717f14ec4e0a6c1e77cf71fbdd452b60))
- Autoresearch system — automated prompt optimization (v4.2.0) ([`ff46c16`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/ff46c16c89a945aacf57747ba46dc61299bb08f0))
- Agent mesh graph + domain-organized quick actions in portal ([`6d181f3`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/6d181f36f9fa91585af0e32bd139aab5347aa1e6))
- Content Creation Consolidation Sprints 1-4 (v4.1.0) ([`8d44a13`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/8d44a13fe11d70469ccf2f465642d2e4b8ea4514))
- Content Agent Mesh — 9 autonomous AI agents + intelligence bus + mission control (v4.0.0) ([`513ee0e`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/513ee0e67113a6ed264759cd6466cd19e7d61146))
- Creator profile intelligence + Google Drive integration + deep search overhaul (v3.9.0) ([`d813e8f`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/d813e8ff6d35d78cac2920cfab8698be101161d0))
- Conversation continuity + secretary intelligence + content DOCX output (v3.8.0) ([`5548c7b`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/5548c7b514b1ded18f634b578d7aff6a4f5fa547))
- Content Creator Learning System + Garmin auth hardening + Telegram formatting (v3.7.0) ([`672fdeb`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/672fdeb552aec96be08d23a5dca4df3feafa8dae))
- Persist Garmin SSO cookies to avoid daily MFA emails ([`c79a962`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/c79a962cdaa3ade943392b1030adbe2a8620dde6))
- Garmin MFA interactive login + rate-limit protection + multi-feature updates ([`6e55302`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/6e55302bc9daf79b100c6904bd189b2439697333))
- Status Portal v3.3 + v3.4 — dashboard, email tracking, job history ([`259199d`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/259199d8ec4e8c961b7e6dd2da78560cd6a292a5))
- Cortex Status Portal — self-hosted monitoring dashboard ([`a05dedc`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/a05dedc79df54d34df58622e01cc716946ea7868))
- Garmin session keep-alive with 3-layer auth recovery ([`77509cc`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/77509cc07f80a4c35e32d642295206fbe6332afa))
- Bi-weekly fossa séptica email automation ([`5027ac1`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/5027ac1c25c4771dc0f17a595a87fe8a4650b2ae))

### Refactor

- **brand**: Rename Cortex → Nexus Hub across codebase ([`d61cc67`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/d61cc675fba0df6102ce5af32ff3ce46c6694542))
- **dispatch**: Match Agent tags to role-based worktrees ([`7573a01`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/7573a013239fb9a24370c346a47e40890952b6d6))

### Tests

- **brand**: Add 13 QA validation tests for Cortex → Nexus Hub rename ([`491e67b`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/491e67b777c90dac0948f3021f387e209d9f49ac))
- **services**: Add 36 QA validation tests for StorageProvider ([`d8206c0`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/d8206c00026ad1768d4bba6c315b2d22ac40acec))
- **skills**: Add 54 QA validation tests for skill database migrations ([`010adce`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/010adce9c46c199785e37fbe7a911e5ff69dd4f1))
- **adapters**: Add 78 QA validation tests for WhatsAppAdapter + fix loader tests ([`1d15224`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/1d152248ddd89c0d73bbaae9c74621ee0daf57df))
- **adapters**: Add 47 QA validation tests for TelegramAdapter and MessageAdapter ([`642c607`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/642c607f92781be18e724ef45196af627e39e770))
- **ai-provider**: Add 38 QA validation tests for FallbackProvider and model routing ([`7e93b6f`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/7e93b6f03f23ce2b0faa37f471ca0c18e1970c3c))
- **skills**: Add 54 QA validation tests for SkillLoader service ([`dfc3675`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/dfc3675002c0ab5bc0d08683c1c1a6ba3336d3d1))
- **skills**: Add 46 QA validation tests for NexusSkill and SkillManifest types ([`482cb36`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/482cb36584755d3ae4e3f59c6e5c91ec726c8c88))
- **skills**: Add SkillRegistry and SkillLoader tests ([`8c27b9c`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/8c27b9c6a35c26f48d17ac4d1ce8f1d21189cf0e))
- **domains**: Add 35 tests for domain handlers, secretary, and thin wrappers (#6) ([`dce0155`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/dce01557752d356d9bf964ca485e5a6ecad1b910))
- **skills**: Add SkillRegistry and SkillLoader tests ([`642dadd`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/642dadddf7c51b8f0bc9eaebf5ea8d611b306947))
- **domains**: Add 35 tests for domain handlers, secretary, and thin wrappers (#6) ([`ba6cc51`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/ba6cc516cbd1ff10b61eccd641b8a5a45026f575))
- **tool-executor**: Add 70 tests covering all 20+ tool dispatch cases ([`8461740`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/8461740cc835f479afeb3cd365ec7b7196f2c8c0))

## [3.0.0] — 2026-03-11

### Bug Fixes

- Invoice filing guards, dead code removal, path fix, migration comment ([`6592904`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/65929041a0dd8466b7bd41857f4cc1924563473c))
- 7 code review fixes — rate limiter, pruning, parse_mode, router, auth, config, require ([`268e1c2`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/268e1c238184102333b42c4109880fdb31672e08))
- **scheduler**: 5 bug fixes from code review — parse_mode, splitMessage, escapeHtml, nullish coalescing ([`20b3e3d`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/20b3e3d00029bc23c223593014ed1b79a53198a2))
- **bot**: Resolve 15 bugs from codebase scan + add Cofidis vendor ([`18ed648`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/18ed64800844623f5e19920746e7c2d8bc6ce109))
- Resolve calendar category names from Outlook master categories ([`f3ce7a5`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/f3ce7a58e496399a4bb166a075a0888bcea9b0d2))
- Default to Red Category when no SMS/EC in calendar caption ([`3c6be8d`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/3c6be8d3a979bba891777a8b8af6a29bff86eec3))
- Handle truncated calendar JSON from max_tokens cutoff ([`eaa9c00`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/eaa9c00fe5d06a86e66438b11eae6d04403f7d35))

### Features

- Content Creation Engine (Phases 1-5) — 16 new commands + model upgrades ([`1f11cdd`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/1f11cdd6d8e100f803a70a62c5e1ce0bc839e404))
- **garmin-coach**: Interactive calendar recommendations + payload truncation fix ([`0083e06`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/0083e0654f2c8016d57e37f7da0f19971e246856))
- **garmin**: Add Garmin Daily Coach briefing with /coach command ([`d274868`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/d27486814cf821f84afe556adb66199f3d8dd661))
- Calendar event prefix, conflict detection, and confirmation flow ([`d935ee5`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/d935ee5ef6bce2ff935379edc2cb5bc1f8388019))

## [2.0.0] — 2026-03-08

### Bug Fixes

- Resolve 3 bugs in invoice collection for personal Outlook accounts ([`0b89361`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/0b893614dc3ae5a96c4df7794223c206f4391f41))
- Add SSH port config and fix SCP quoting for reverse tunnel ([`bc579e7`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/bc579e729dabb638c8520f253a8eb146b85e6984))
- Replace 15-min task alerts with end-of-day summary (#3) ([`d1ed2c6`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/d1ed2c670f18c2e99834ea72a3f80ce0770511cf))

### Chores

- Remove Qlik Sense and AWS domains (#2) ([`beab009`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/beab0092b6bba608510de9dae414dd410e02d5fc))

### Documentation

- Update changelog with v1.6.0 through v1.8.0 entries ([`f2f4f8f`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/f2f4f8f4706824995269b8d82bc29f6a52c2632a))
- Update changelog with v1.3.0 and v1.4.0 entries ([`e68d760`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/e68d76020ffe0b1f57028981fd126f86bc92a244))

### Features

- Unified image classifier (invoice/calendar/task) + security hardening ([`d8e6d9f`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/d8e6d9fab84c6f106bdb084951af8898d9be81e1))
- Add Amazon.es invoice collection via Playwright browser automation ([`e2dfb8d`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/e2dfb8dbc007b3df8e35bb4c72581f335b05e914))
- Add automated monthly invoice collection + image compression ([`d7d204d`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/d7d204dc0046136d8621d51ab73e2a006dcd0905))
- Add invoice/receipt photo filing to iCloud via SSH/SCP ([`c5169f2`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/c5169f2d063d98c4c7f6f0d22bdd253941c3dc4f))
- Add 12 feature improvements across bot capabilities ([`2bcd45c`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/2bcd45c71ea66da9aba37adbcbb6ca45a9246b65))
- Add daily content discovery with Claude web search (#1) ([`8565f8a`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/8565f8ae036a90842393c262aaf2be1446904564))

### Performance

- Optimize API costs and performance across 20 improvements ([`3189ff8`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/3189ff8979b17883644b709ddb5e817683bed35d))

### Refactor

- Replace SSH/SCP invoice filing with local filesystem writes ([`ca0664e`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/ca0664eba1188dd7be72f70a408c654532190fcc))

### Reverts

- Restore SSH/SCP invoice filing after iCloud FUSE failure ([`6ca7ec0`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/6ca7ec098cb38cef5548df2d192f8105564d8372))

## [1.0.0] — 2026-03-06

### Features

- Initial release v1.0.0 — Cortex Telegram Hub Bot ([`83b1363`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/83b1363f26bfec6f28c8a08aa173cded57179c92))


