# Changelog

All notable changes to Cortex Telegram Hub Bot are documented in this file.

---

## [1.5.0] — 2026-03-07

### Invoice/Receipt Photo Filing to iCloud

Automatic invoice detection and filing from Telegram photos to iCloud Drive via SSH/SCP.

#### New Feature: Invoice Filing Engine (`src/services/invoice-filer.ts`)
- **Haiku vision analysis** — Single API call detects invoices AND extracts metadata (vendor, date, amount, invoice number) at ~$0.001/call
- **iCloud filing via SSH/SCP** — Files transferred from Linux server to Mac's iCloud Drive folder, synced automatically by macOS
- **Year/month folder structure** — Auto-creates `2026/Mar-2026/` directories with Portuguese month names (Jan, Fev, Mar, Abr, Mai, Jun, Jul, Ago, Set, Out, Nov, Dez)
- **Smart filenames** — `YYYY-MM-DD_Vendor_Amount_InvoiceNumber_SUFFIX.jpg` format with filesystem-safe sanitization
- **Confidence threshold** — Only files images with ≥70% invoice confidence (configurable via `INVOICE_MIN_CONFIDENCE`)
- **Correction flow** — Inline "Não é nota fiscal" button re-routes misclassified images to task extraction
- **Graceful degradation** — Feature auto-disables when SSH is unconfigured; SSH failures fall through to existing task extraction

#### Photo Handler Refactored (`src/bot.ts`)
- Extracted `handlePhotoTaskExtraction()` for reuse from both direct photo flow and correction callback
- Three-branch routing: caption domain routing → invoice detection → task extraction fallback
- New `nf:` callback namespace for invoice correction with 5-min TTL callbackStore

#### Configuration (`src/config.ts`)
- New `invoices` config section: `INVOICE_FILING_ENABLED`, `INVOICE_SSH_HOST`, `INVOICE_SSH_USER`, `INVOICE_SSH_KEY`, `INVOICE_REMOTE_PATH`, `INVOICE_MIN_CONFIDENCE`
- `isInvoiceFilingConfigured()` guard checks enabled + SSH host + remote path

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
