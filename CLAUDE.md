# CLAUDE.md — Nexus Hub Development Instructions

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

- **main** — Production. Auto-deploys via GitHub Actions CD.
- **develop** — Integration branch. Merge features here first.
- **feature/NH-xxx-name** — Feature branches. Branch from develop.
- **hotfix/description** — Critical fixes. Branch from main.

### Commit Convention
Format: `type(scope): description`
Types: feat, fix, refactor, test, docs, ci, chore, perf, style

### Before Pushing
- Run `npx vitest run` — all tests must pass
- Run `npx tsc --noEmit` — no type errors
- Pre-commit and pre-push hooks will enforce this automatically

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

## Notion Integration

- **Development Board DB:** 332ad49d-23e7-81aa-831e-d5a3ceff20c1
- **Releases DB:** 332ad49d-23e7-8134-b413-d8d3cc3f1a4a

## CI/CD

- **CI:** GitHub Actions (`ci.yml`) — lint, test, build, Python check, migrations
- **CD:** GitHub Actions (`cd-production.yml`) — auto-deploy on merge to main
- **Release:** GitHub Actions (`release.yml`) — manual version bump + GitHub Release

## Deploy Target

- Server: `dominguez@serverdominguez`
- Path: `/home/dominguez/telegram-hub-bot`
- Backups: `/home/dominguez/backups/nexushub/` (last 10)

## When You Finish Work

After completing a feature or significant chunk of work:

1. **Commit with conventional format:**
   ```
   git add .
   git commit -m "feat(core): add AIProvider interface with fallback logic"
   ```

2. **Push the feature branch:**
   ```
   git push origin feature/NH-xxx-name
   ```

3. **Send a completion notification** by creating a file:
   ```
   echo "DONE: feature/NH-xxx-name — Description of what was completed" >> ~/Desktop/nexushub-agent-log.md
   ```

4. **Do NOT merge to develop or main** — Felipe reviews and merges.

## Rules

- Never modify `.env` or `data/` directory
- Never call real external APIs (Anthropic, Microsoft, Google, Garmin) in tests
- Always run tests before committing
- Keep prompts/*.md files — they are hot-reloadable and tracked in git
- Use `os.homedir()` for paths — never hardcode `/home/dominguez` or `/Users/felipedominguez`
- Max 20 conversation messages per domain (auto-pruned by SQLite trigger)
- SQLite: single-file DB, no concurrent writes, use WAL mode
