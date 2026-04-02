# CODEBASE.md — Nexus Hub Architecture Reference

> **Read this BEFORE touching any code.** This is your map of the entire system.
> You should NOT need to explore the project — everything is documented here.

## Tech Stack
- **Runtime:** Node.js + TypeScript (strict mode)
- **Bot Framework:** Grammy (Telegram Bot API)
- **AI:** Anthropic Claude (primary), OpenAI GPT (fallback), Google Gemini (fallback)
- **Database:** SQLite via better-sqlite3 (WAL mode)
- **Portal:** Express.js on port 8200 (status dashboard + Mission Control)
- **Tests:** Vitest (all external APIs mocked)
- **Package:** @nexushub/core v4.5.0

## Message Flow (CRITICAL — understand this before any change)
```
User sends Telegram message
  → src/bot.ts (Grammy middleware)
    → Auth check: TELEGRAM_ALLOWED_USER_IDS
    → Slash command? → Direct handler (no AI involved)
    → Regular message → src/router/classifier.ts
      → AI classifies into domain: secretary|triathlon|content|finance|cooking
      → src/domains/{domain}.ts → thin wrapper
        → src/domains/domain-handler.ts → handleDomain()
          → Builds system prompt + conversation history
          → Calls src/services/anthropic.ts → callDomain()
            → AI responds with text OR tool_use blocks
            → If tool_use → src/services/tool-executor.ts executes tool
            → Loop until AI returns final text response
          → Response sent to user via Telegram (HTML formatted)
```

## Directory Map

### src/
```
bot.ts              — Grammy bot setup, ALL command handlers, middleware (4400 lines, THE central file)
index.ts            — Entry point: starts bot, portal, scheduler
config.ts           — All env vars parsed into typed config object

router/
  classifier.ts     — AI-based message classification (secretary/finance/cooking/etc.)
  index.ts          — routeMessage(), isSystemCommand(), keywordMatch()

domains/            — Domain handlers (thin wrappers calling domain-handler.ts)
  domain-handler.ts — handleDomain() — THE function that calls AI with tools (157 lines)
  secretary.ts      — handleSecretary() → handleDomain('secretary', ...)
  finance.ts        — handleFinance() → handleDomain('finance', ...)
  cooking.ts        — handleCooking() → handleDomain('cooking', ...)
  triathlon.ts      — handleTriathlon() → handleDomain('triathlon', ...)
  content-creator.ts— handleContent() → handleDomain('content', ...)
  types.ts          — DomainName type, DomainResponse interface

services/           — Business logic (DO NOT put UI/bot code here)
  anthropic.ts      — callDomain(), TOOLS array (55 tools), system prompts per domain (676 lines)
  tool-executor.ts  — executeToolCall() — maps tool names to actual functions (491 lines)
  database.ts       — SQLite setup, migrations, getDb()
  scheduler.ts      — Cron job registration, morning briefing, reminders, backups (872 lines)
  finance-tracker.ts— Expense tracking, DARF/Carnê-Leão tax calculation
  cooking-chef.ts   — Recipe search (Spoonacular API), meal planning
  training-plans.ts — Workout plans, readiness scoring, calendar blockers
  garmin.ts         — Garmin Connect API (login, activities, body stats) (1267 lines)
  garmin-coach.ts   — AI coaching recommendations based on Garmin data
  onboarding.ts     — Interactive questionnaires (fitness/diet/homeschool)
  unified-calendar.ts— Merges Google Calendar + Outlook into single view
  microsoft-todo.ts — Microsoft To Do API (get/create/update tasks)
  outlook-calendar.ts— Outlook Calendar API
  outlook-mail.ts   — Outlook Mail API (unread count)
  google-calendar.ts— Google Calendar API
  invoice-filer.ts  — SSH invoice filing, NLP rules
  invoice-collector.ts— Monthly invoice collection
  provider-fallback.ts— AI provider circuit breaker + fallback chain
  provider-registry.ts— Multi-provider registry (Claude/GPT/Gemini)
  webhook-registry.ts— Event-driven webhook infrastructure
  usage-metering.ts — Per-user per-day AI usage tracking
  backup.ts         — SQLite backup with rotation
  error-monitor.ts  — Sentry integration (if configured)
  storage-provider.ts— Storage abstraction interface

skills/             — Skill/plugin system
  skill-config.ts   — DEFAULT_SKILLS definitions, SubSkillDefinition interface (544 lines)
  skill-manager.ts  — enable/disable skills, getSkillStatus()
  registry.ts       — SkillRegistry (SQLite-backed state persistence)
  loader.ts         — SkillLoader (dynamic skill loading)
  credentials.ts    — AES-256-GCM encrypted credential storage
  types.ts          — NexusSkill, SkillManifest interfaces

portal/             — Web dashboard (Express.js, port 8200)
  server.ts         — Express routes: /health, /api/snapshot, /api/board, webhook endpoints (1743 lines)
  portal.html       — Status Portal UI (2630 lines, single HTML file with embedded JS/CSS)
  telemetry.ts      — Job tracking, event recording, API cost metering
  anthropic-hook.ts — AI usage logging hook

state/              — SQLite-backed state management
  conversation.ts   — Conversation history per user
  reminders.ts      — Scheduled reminders
  todos.ts          — Local to-do state
  notes.ts          — Book notes
  shared-memory.ts  — Cross-agent shared memory layer

utils/
  date-parser.ts    — Date parsing, timezone handling (Europe/Lisbon)
  telegram-formatter.ts — HTML formatting for Telegram messages
  telegram-templates.ts — Message template system
  encryption.ts     — AES-256-GCM encrypt/decrypt
  logger.ts         — Structured logging (pino)
  prompt-loader.ts  — External prompt file loader with hot-reload
  callback-store.ts — Inline keyboard callback data storage

commands/           — Slash command handlers
  skills.ts         — /skills, /skill <name>, /skill enable|disable
  books.ts          — /book add, /book note, /books
  pipeline.ts       — /pipeline (content production tracker)
  autoresearch.ts   — /autoresearch, /eval
```

### scripts/ (Agent orchestration — NOT TypeScript, plain Node.js)
```
mission-control.js  — MC server (port 8200), auto-assign loop (45s), QA queue management
agent-complete.js   — Agent completion: QA routing, Notion status updates, Telegram notifications
dispatch-tasks.js   — Task dispatcher: Notion → agent worktree (.agent-prompt.md + .agent-task.json)
launch-agent.sh     — Continuous agent loop: runs Claude Code → auto-chains → picks next task
setup-worktrees.sh  — Creates 6 git worktrees for parallel agents
deploy.sh           — Production deployment via SSH
rollback.sh         — Production rollback (10-backup rotation)
```

## Patterns You MUST Follow

### Adding a new tool
1. Define tool in `src/services/anthropic.ts` → TOOLS array (name, description, input_schema)
2. Add execution in `src/services/tool-executor.ts` → executeToolCall() switch
3. The tool is automatically available to the AI in the domain where it's listed

### Adding a new command
1. Add handler in `src/bot.ts` → `bot.command('name', handler)`
2. Create handler in `src/commands/your-command.ts`
3. Register in bot.ts imports

### Adding a new domain
1. Create `src/domains/your-domain.ts` (thin wrapper calling handleDomain)
2. Add domain name to `DomainName` type in `src/domains/types.ts`
3. Add system prompt in `src/services/anthropic.ts` → `buildSystemPrompt()`
4. Add classification hint in `src/router/classifier.ts`
5. Add domain handler in `src/bot.ts` switch statement
6. Add skill config in `src/skills/skill-config.ts` → DEFAULT_SKILLS

### Adding a cron job
1. Register in `src/services/scheduler.ts` → registerJob() + cron.schedule()
2. Wrap in wrapJob() for telemetry
3. Use sub-skill gating: `if (!isSubSkillEnabled(domain, subSkill)) return`

### Database migrations
- All in `src/services/database.ts` → migrations array
- Format: `{ id: '001_create_conversations', sql: 'CREATE TABLE IF NOT EXISTS ...' }`
- Auto-runs on startup. Migration IDs must be unique (use prefix like 001, 002, etc.)
- NEVER modify existing migrations — only add new ones

### Telegram HTML
- ONLY supported tags: `<b>`, `<i>`, `<u>`, `<code>`, `<pre>`, `<a>`, `<blockquote>`
- NO tables, NO CSS, NO colors, NO images inline
- Message limit: 4096 chars — use splitMessage() for long content
- Always escapeHtml() user data before inserting into templates

## Known Gotchas
- **macOS path with spaces:** repo lives in "Custom Connectors" → always quote `$(pwd)` in bash
- **financeEncryption in config.ts:** has duplicate history — check for duplicates after merge
- **portal.html is 2630 lines:** single file, embedded JS/CSS — be surgical with edits
- **bot.ts is 4400 lines:** THE monolith — most features are wired here. Search before adding
- **TOOLS array in anthropic.ts:** 55 tools defined — check for duplicates before adding
- **Garmin auth:** MFA required, token stored at GARMIN_TOKEN_PATH, expires frequently

## Testing Rules
- All tests in `__tests__/` mirroring `src/` structure
- Mock ALL external APIs (Anthropic, Google, Microsoft, Garmin, Spoonacular)
- Use in-memory SQLite: `':memory:'`
- See `__tests__/setup.ts` for mock patterns
- Run: `npx vitest run` (2388+ tests, must all pass)
- Type check: `npx tsc --noEmit`

## Agent Orchestration
```
Notion Board ("To Do") → auto-assign loop (45s) → dispatch-tasks.js
  → writes .agent-task.json + .agent-prompt.md to worktree
  → launch-agent.sh starts Claude Code in iTerm
  → Claude reads CLAUDE.md + CODEBASE.md + agent-specific instructions
  → Claude works on task → commits → pushes → calls agent-complete.js
  → agent-complete.js → moves to QA Validating → writes QA queue file
  → QA agent picks up → validates → PASS → Done / FAIL → back to origin
```

## QA Routing
| Origin Agent | QA Agent | Why |
|---|---|---|
| Backend, Frontend, Architect | QA | Code-heavy changes |
| DevOps, Flex (Security/Refactor) | QA2 | Infrastructure/config changes |
