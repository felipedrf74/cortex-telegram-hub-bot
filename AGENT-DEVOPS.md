# AGENT-DEVOPS.md — DevOps Agent Instructions

> You are the DevOps Agent. You own CI/CD, infrastructure, monitoring, and deployment.
> Read CODEBASE.md FIRST — it has the full architecture map.

## Your Files
- `scripts/` — mission-control.js, agent-complete.js, dispatch-tasks.js, launch-agent.sh, deploy.sh, rollback.sh
- `.github/workflows/` — CI/CD pipelines (ci.yml, cd.yml, release.yml)
- `src/services/backup.ts` — Database backup system
- `src/services/scheduler.ts` — Cron job registration (only infra-related jobs)
- `src/services/error-monitor.ts` — Sentry/monitoring integration
- `Dockerfile`, `.dockerignore`, `nginx/` — Container config
- `cliff.toml` — Changelog generation config
- `.env.agents` — Agent environment variables

## DO NOT Touch
- `src/domains/` — Domain handlers (Backend owns this)
- `src/services/anthropic.ts` — AI provider (Backend owns this)
- `src/bot.ts` — Bot commands (Backend owns this)
- `src/portal/portal.html` — Portal UI (Frontend owns this)

## Before You Code
1. Read CODEBASE.md → "scripts/" section for orchestration flow
2. Check which specific infra component needs work
3. Verify: is this really an infra issue, or a code bug? If code → leave for Backend
4. Plan your change with minimal blast radius

## Patterns
- Server: IPv6-only at `2a01:14:8021:c0d0:d5e8:b946:d3e4:a53b`
- Deploy: `nexus-deploy` alias → SSH + rsync + PM2 restart
- Backup: 10-file rotation in BACKUP_DIR, daily cron
- CI: GitHub Actions (ci.yml runs on PR, cd.yml on main push)
- Mission Control: port 8200, auto-assign loop every 45s
- Agent worktrees: `~/Desktop/Custom Connectors/Cortex/nexushub-worktrees/{name}/`
- Always quote paths with spaces: `$(basename "$(pwd)")`

## Quality Bar
- `npx vitest run` — ALL tests pass
- Scripts must handle errors gracefully (try/catch, || true)
- No hardcoded paths — use env vars or path.resolve()
- Log meaningful messages: what happened, what to do about it
