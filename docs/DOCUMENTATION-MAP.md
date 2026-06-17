# Documentation Map — Backend / Content Engine

Status: canonical
Owner: backend lead (Felipe)
Last verified: 2026-06-16
Update policy: update when a new docs/ subdirectory is added or canonical doc moves.

## Purpose
This file is the Markdown inventory for the Nexus Hub backend and content
engine workspace.

It distinguishes:
- canonical live docs
- supporting docs
- historical docs that should not drive new work

## Scope
Included:
- backend repo docs
- `docs/*`
- prompt assets and skill prompt files that are runtime inputs

Explicitly excluded from doc-audit status:
- vendored dependency docs in `node_modules/`
- Python virtualenv license/readme files in `content-engine/.venv*`
- hidden `.claude/skills/*` helper material unless referenced directly

## Canonical Live Docs
- `/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot/CLAUDE.md`
- `/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot/BRANCHING.md`
- `/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot/DEPLOY.md`
- `/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot/STAGING.md`
- `/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot/docs/release/current-release-index.md`
- `/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot/docs/release/CURRENT_RELEASE_STATE.md`
- `/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot/docs/engineering/ENGINEERING_STANDARDS_INDEX.md`
- `/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot/docs/IOS-INTEGRATION.md`
- `/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot/docs/MESH.md`
- `/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot/docs/SKILL_ARCHITECTURE.md`
- `/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot/docs/TOKEN-QUOTA-CONTRACT.md`
- `/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot/docs/GARMIN-REAUTH-NOTIFICATION.md`
- `/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot/docs/MODEL-REVIEW-PROCESS.md`
- `/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot/docs/OBSERVABILITY-ONCALL.md`

## Active Supporting Docs
- `/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot/DOCUMENTATION.md`
  - high-level orientation only
- `/Users/felipedominguez/Desktop/Nexus Hub IOS/specs/27-CLAUDE-CODE-HANDOVER.md`
  - cross-workspace handover for current ways of working and rollout discipline
- `/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot/CHANGELOG.md`
- `/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot/prompts/*.md`
- `/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot/src/skills/*/prompts/system.md`
- `/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot/knowledge/skills/*.md`

## Decommissioned / Historical Docs
These files remain in the repo for historical context, but they should not be
used as live implementation truth.

- `/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot/DEVELOPMENT.md`
- `/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot/TASK-circuit-breaker-metrics.md`
- `/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot/TASK-gemini-provider.md`
- `/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot/TASK-integration-tests.md`
- `/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot/TASK-openai-provider.md`
- `/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot/TASK-telegram-adapter.md`

## Maintenance Rule
When a backend Markdown file stops matching current runtime truth:
- update it if it is canonical
- mark it historical if it only reflects an old work phase
- keep runtime prompt files accurate, since those are executable product inputs
