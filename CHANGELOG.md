# Changelog

All notable changes to Cortex Telegram Hub Bot are documented in this file.

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
