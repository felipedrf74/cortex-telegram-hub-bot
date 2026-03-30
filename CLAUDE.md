# CLAUDE.md — Nexus Hub Development Instructions

## ⚡ FIRST: Check for Assigned Task

**Before doing anything else**, check if you have a task assigned:

```bash
cat .agent-prompt.md 2>/dev/null
```

If `.agent-prompt.md` exists, **read it and execute the task described**. It contains:
- What to build/fix/test
- Step-by-step instructions specific to your agent role
- The Notion task ID for tracking

If no task file exists, wait for instructions from Felipe.

When you complete the task:
1. Follow all steps in the prompt file (commit, push, log)
2. Then tell Felipe: "Task complete. Run `node scripts/dispatch-tasks.js --done <your-agent-dir>` to mark it in Notion and get the next task."

---

## Project

Nexus Hub (formerly Cortex) — AI-powered creator operating system built with TypeScript, Grammy (Telegram), Anthropic Claude, SQLite, and a Python/FastAPI content engine.

## Repository

- **GitHub:** felipedrf74/cortex-telegram-hub-bot
- **Owner:** Felipe Dominguez
- **License:** MIT (planned)

## Tech Stack

- **Runtime:** Node.js 20+ / TypeScript (CommonJS)
- **Bot:** Grammy (Telegram long polling)
- **AI:** Anthropic Claude (Haiku for classification, Sonnet for domains)
- **Database:** SQLite via better-sqlite3
- **Content Engine:** Python 3.11 / FastAPI (port 8100)
- **Portal:** Express.js (port 8200, same process)
- **Process Manager:** PM2
- **Tests:** Vitest with @vitest/coverage-v8

## Git Workflow

- **main** — Production. CI validates automatically. Deploy is MANUAL (see below).
- **develop** — Integration branch. Merge features here first.
- **feature/NH-xxx-name** — Feature branches. Branch from develop.
- **hotfix/description** — Critical production fixes. Branch from **main**.
- **bugfix/description** — Non-critical bug fixes. Branch from **develop**.

### Commit Convention
Format: `type(scope): description`
Types: feat, fix, refactor, test, docs, ci, chore, perf, style

### Before Pushing
- Run `npx vitest run` — all tests must pass
- Run `npx tsc --noEmit` — no type errors
- Pre-commit and pre-push hooks enforce this automatically

## CI/CD — IMPORTANT

- **CI (automatic):** Runs on every push/PR — lint, typecheck, vitest, build, Python check, migrations. This is the quality gate.
- **CD (MANUAL ONLY):** Server is IPv6-only. GitHub Actions runners cannot reach it. Felipe deploys manually from his Mac using `./scripts/deploy.sh`.
- **Release (manual):** Triggered via GitHub Actions UI.

### What this means for you as an agent:
- **Your job is to make CI pass.** Write code, write tests, push. CI validates automatically.
- **Do NOT attempt deployment.** No SSH to server, no deploy commands, no modifying CD workflow.
- **Do NOT add push triggers to cd-production.yml.** It's manual-only for a reason.
- **See `DEPLOY.md`** for full deployment context if needed.

### Deployment Flow
```
You write code → Push to feature branch → CI validates (automatic)
  → Felipe reviews → Merge to develop → CI validates (automatic)
  → Felipe merges to main → CI validates (automatic)
  → Felipe runs ./scripts/deploy.sh from his Mac → Server updated
```

## Agent Roles

Each Claude Code instance operates as a specialized agent. Know your role:

### Feature Agent (feature/NH-xxx-*)
- Branch from: **develop**
- Merge target: **develop** (Felipe merges)
- Focus: New functionality, architecture changes, new integrations
- Commit prefix: `feat(scope):` or `refactor(scope):`

### Bug Agent (bugfix/*)
- Branch from: **develop**
- Merge target: **develop** (Felipe merges)
- Focus: Fix non-critical bugs, improve error handling, edge cases
- Commit prefix: `fix(scope):`
- Process:
  1. Read the bug description or error log
  2. Write a failing test that reproduces the bug
  3. Fix the bug
  4. Verify the test passes
  5. Check no other tests broke
  6. Commit: `fix(scope): description` with "Fixes #issue" if applicable

### Hotfix Agent (hotfix/*)
- Branch from: **main** (NOT develop — this is production code)
- Merge target: **main** AND **develop** (Felipe merges both)
- Focus: Critical production bugs that need immediate deployment
- Commit prefix: `fix(scope):`
- CRITICAL: Hotfixes must be minimal. Fix ONLY the bug, nothing else.

### Test Agent (feature/NH-xxx-test-*)
- Branch from: **develop**
- Merge target: **develop** (Felipe merges)
- Focus: Expand test coverage, add integration tests, improve mocks
- Commit prefix: `test(scope):`

## Key Architecture

### Three-Tier AI Classification
1. Pattern match (regex, zero cost) → `src/router/classifier.ts`
2. Keyword match (NL, zero cost) → `src/router/classifier.ts`
3. Claude Haiku classification → `src/services/anthropic.ts`

### Domain Handlers
Each domain has isolated conversation history and system prompt:
- Secretary → `src/domains/secretary.ts`
- Triathlon → `src/domains/triathlon.ts`
- Content → `src/domains/content-creator.ts`
- Shared handler → `src/domains/domain-handler.ts`

### Important Files
- `src/config.ts` — All configuration (from .env)
- `src/services/anthropic.ts` — Claude API wrapper
- `src/services/database.ts` — SQLite init + migrations
- `src/services/scheduler.ts` — 18+ cron jobs
- `src/services/tool-executor.ts` — Tool call execution
- `src/portal/telemetry.ts` — Zero-import telemetry (provider callbacks)
- `prompts/*.md` — Hot-reloadable system prompts

### Content Agent Mesh
9 autonomous agents in `src/agents/` communicating via Intelligence Bus (`src/services/intelligence-bus.ts`).

## Testing

```bash
npx vitest run            # Run all tests
npx vitest run --coverage # Run with coverage report
npx vitest                # Watch mode
```

- Tests are in `__tests__/` mirroring `src/` structure
- Setup file: `__tests__/setup.ts` (mocks Anthropic, Grammy, Pino)
- External APIs are ALWAYS mocked — never call real APIs in tests
- Use in-memory SQLite (`:memory:`) for database tests
- **Bug fix rule:** Always write a failing test BEFORE fixing the bug

## Notion Integration

- **Development Board DB:** 332ad49d-23e7-81aa-831e-d5a3ceff20c1
- **Releases DB:** 332ad49d-23e7-8134-b413-d8d3cc3f1a4a

## Server Info (DO NOT attempt to connect)

- Server: `dominguez@serverdominguez` (IPv6-only, local resolution only)
- Path: `/home/dominguez/telegram-hub-bot`
- Backups: `/home/dominguez/backups/nexushub/` (last 10)
- Deploy: Felipe only, via `./scripts/deploy.sh` from Mac

## When You Finish Work

After completing a feature, bugfix, or significant chunk of work:

1. **Run tests:**
   ```
   npx vitest run
   ```

2. **Commit with conventional format:**
   ```
   git add .
   git commit -m "feat(core): add AIProvider interface with fallback logic"
   ```

3. **Push the branch:**
   ```
   git push origin $(git branch --show-current)
   ```

4. **Log completion:**
   ```
   echo "$(date '+%Y-%m-%d %H:%M') DONE: $(git branch --show-current) — Description" >> ~/Desktop/nexushub-agent-log.md
   ```

5. **Do NOT merge to develop or main** — Felipe reviews and merges.

## Rules

- Never modify `.env` or `data/` directory
- Never call real external APIs (Anthropic, Microsoft, Google, Garmin) in tests
- Never attempt SSH connections to the server or run deploy commands
- Never modify `cd-production.yml` to add automatic triggers
- Always run tests before committing
- Keep prompts/*.md files — they are hot-reloadable and tracked in git
- Use `os.homedir()` for paths — never hardcode `/home/dominguez` or `/Users/felipedominguez`
- Max 20 conversation messages per domain (auto-pruned by SQLite trigger)
- SQLite: single-file DB, no concurrent writes, use WAL mode
- Bug fixes MUST include a test that fails without the fix and passes with it
- Hotfixes MUST be minimal — fix only the bug, no refactoring
