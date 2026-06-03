# Claude Code QA Prompt - Decision Center Execution

Use this prompt in a fresh Claude Code session to challenge the current Decision Center candidate.

```text
You are Claude Code performing independent QA on Nexus Hub Decision Center work.

Repo/worktree:
/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot-decision-center-execution-20260603

Branch:
codex/decision-center-execution-20260603

Base:
origin/main 09a1c96d (package 4.14.199)

Work Order:
docs/qa/work-orders/WO-decision-center-execution-20260603.md

Mode:
Peer Validation / QA challenge. Do not edit files unless explicitly asked after reporting findings. Do not commit, push, merge, deploy, or promote. Validate only the current candidate worktree, not stale branches or already-shipped work.

Hard boundaries:
- Do not touch src/services/chat-core-v2/**.
- Verify the candidate did not edit src/services/chat-core-v2/**.
- Do not treat backend tests as iOS proof.
- Do not treat local tests as production proof.
- Do not claim L3 unless your peer validation is independent and current.

Primary risk questions:
1. Does DECISION_CENTER_COMMAND_BUS_ENABLED default off and remain independently scoped from ChatV2 flags?
2. Is only literal dismiss eligible for the Command Bus, with not_now/reject_reflow/unsupported actions staying honest legacy/preview/disabled paths?
3. Is the Command Bus envelope privacy-safe, idempotent, scoped to the current user/tenant, and version/readback verified?
4. Are bus errors mapped to existing Decision Center action errors without hiding stale/expired/readback failures?
5. Are API v2 fields additive and backward-compatible for v1 clients?
6. Are cursor pagination and detail schema behavior deterministic?
7. Are migrations 195-198 collision-free and safe beside origin/main migrations?
8. Do lifecycle/dashboard/semantic-dedup/type-suppression changes avoid changing user-visible behavior unless their flags are enabled?
9. Did any generated evidence, ChatV2 internals, production config, or unrelated files slip into the patch?

Commands to run:
- git status --short
- git diff --name-only origin/main -- src/services/chat-core-v2
- node scripts/verify-agent-lanes.mjs --work-order docs/qa/work-orders/WO-decision-center-execution-20260603.md
- npx vitest run __tests__/services/runtime-flags.test.ts __tests__/services/decision-command-adapter.test.ts __tests__/services/decision-center-command-bus-equivalence.test.ts __tests__/security/decision-prompt-injection.test.ts
- npx vitest run __tests__/api/decision-api-version.test.ts __tests__/api/decision-cursor.test.ts __tests__/api/decisions-routes.test.ts __tests__/portal/portal-decision-center-routes.test.ts __tests__/services/decision-center-semantic-dedup.test.ts __tests__/services/decision-dashboard.test.ts __tests__/services/decision-relationship-types.test.ts __tests__/services/notification-orchestrator.test.ts __tests__/services/event-backbone.test.ts __tests__/services/database-migration-prefix-collisions.test.ts
- npm run build

Optional broader checks if time permits:
- npm run verify
- npm run docs:audit
- DATABASE_PATH=/tmp/nexus-decision-center-smoke.db DECISION_CENTER_NOTIFICATION_SMOKE_ALLOW_LOCAL_DB=1 npm run smoke:decision-center-notification -- --user 1 --tenant 1 --dry-run --json

Return:
- Commands run and pass/fail.
- Findings first, ordered by severity, with file/line references.
- Improvements that reduce rollout risk.
- Open questions.
- Evidence level you believe is justified. Be strict: no iOS or production claims without those proofs.
```
