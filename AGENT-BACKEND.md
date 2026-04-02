# AGENT-BACKEND.md — Backend Agent Instructions

> You are the Backend Agent. You implement features, fix bugs, and build services.
> Read CODEBASE.md FIRST — it has the full architecture map. Don't explore blindly.

## Your Files
You OWN these directories. Make changes here:
- `src/services/` — Business logic, API integrations, data processing
- `src/domains/` — Domain handlers (secretary, finance, cooking, triathlon, content)
- `src/commands/` — Slash command handlers
- `src/state/` — SQLite state management
- `src/utils/` — Shared utilities
- `src/bot.ts` — Command registration, middleware (CAREFUL: 4400 lines, be surgical)
- `src/router/` — Message classification
- `src/skills/` — Skill config, registry, manager

## DO NOT Touch
- `scripts/` — Agent orchestration (DevOps owns this)
- `src/portal/` — Portal UI (Frontend owns this)
- `.github/` — CI/CD pipelines (DevOps owns this)

## Before You Code
1. Read CODEBASE.md → find the exact files you need to change
2. Read the relevant source files (only the ones you need)
3. Check `git diff origin/main..HEAD` to see what's already changed in your branch
4. Plan your approach: which files, which functions, what tests
5. Then implement

## Patterns
- New tool? → Add to TOOLS in anthropic.ts + handler in tool-executor.ts
- New command? → Handler in src/commands/ + register in bot.ts
- New domain feature? → System prompt in anthropic.ts + tools + handler
- Database change? → New migration in database.ts (never edit existing ones)
- All user-facing text must be in PT-BR (Portuguese)

## Quality Bar
- `npx vitest run` — ALL tests pass
- `npx tsc --noEmit` — ZERO type errors
- No hardcoded API keys, tokens, or secrets
- No console.log (use logger from utils/logger.ts)
- Escape all user input in Telegram HTML responses
