# Decision Center Command Bus Integration

Work Order: `WO-decision-center-execution-20260603`
Branch: `codex/decision-center-execution-20260603`
Base: `origin/main` at `09a1c96d`
Status: implemented locally, flag-gated off by default, not deployed.

## Scope

This document records the Decision Center-side Command Bus integration added in the current candidate. The work calls the committed Chat Core v2 Command Bus API but does not edit `src/services/chat-core-v2/**`.

Implemented slice:

- `src/services/decision-command-adapter.ts` builds a Decision Center command envelope with `origin: decision_center`.
- `src/services/runtime-flags.ts` adds `DECISION_CENTER_COMMAND_BUS_ENABLED`, scoped by user or tenant and default-off.
- `src/services/decision-center.ts` lazily invokes the adapter only when the flag is enabled and the action is eligible.
- Only the literal `dismiss` action is bus-eligible in this candidate.
- `not_now`, `reject_reflow`, retry, reconnect, and choose flows remain legacy, preview-only, or disabled as appropriate. They are not represented as executed bus commands.

## Guardrails

- Default-off flag: unset, `false`, `off`, `0`, and unrelated values leave the legacy Decision Center executor path active.
- No ChatV2 internals edited: `git diff --name-only origin/main -- src/services/chat-core-v2` must stay empty.
- No fake execution: unsupported or unwired actions do not claim Command Bus success.
- No raw private body/explanation text is added to the command payload, docs, or tests.
- The legacy outcome ledger is skipped only when the Command Bus already recorded the outcome.
- Rollback is config-only for this slice: unset `DECISION_CENTER_COMMAND_BUS_ENABLED`.

## Adapter Contract

The adapter maps a `dismiss` action over an `unread` or `read` Decision Center item to:

- `commandType`: `decision_center.dismiss`
- `capabilityId`: `decision_center.dismiss`
- `origin`: `decision_center`
- `delegatedScopes`: `decision_center:read`, `decision_center:write`
- `idempotencyKey`: the incoming Decision Center action idempotency key
- `expiresAt`: the earlier of command creation + 10 minutes and the decision `expiresAt`
- `basedOn.entityVersions`: the Decision Center dismiss version from the current item

The adapter translates Command Bus failures back to existing Decision Center action error codes:

| Command Bus condition | Decision Center code |
| --- | --- |
| expired command or expired gate | `DECISION_EXPIRED` |
| stale entity/version mismatch | `DECISION_SUPERSEDED` |
| readback or verification failure | `DECISION_READBACK_MISMATCH` |
| missing scope, wrong actor/tenant, invariant failure, unsupported capability | `DECISION_ACTION_NOT_ALLOWED` |
| all other execution failures | `DECISION_ACTION_FAILED` |

## Acceptance Evidence

Local evidence collected for the current worktree:

- `node scripts/verify-agent-lanes.mjs --work-order docs/qa/work-orders/WO-decision-center-execution-20260603.md` passed.
- `git diff --name-only origin/main -- src/services/chat-core-v2` returned no files.
- Focused Decision Center suite passed: 13 files, 251 tests.
- `npm run verify` passed: 812 test files, 11,846 tests.
- `DATABASE_PATH=/tmp/nexus-decision-center-smoke.db DECISION_CENTER_NOTIFICATION_SMOKE_ALLOW_LOCAL_DB=1 npm run smoke:decision-center-notification -- --user 1 --tenant 1 --dry-run --json` passed.

Evidence limits:

- Docker sandbox `scripts/local-up.sh` could not run in this shell because `.env.local` is absent and Docker is unavailable.
- No iOS simulator proof has been collected by this Work Order.
- No staging or production proof has been collected by this Work Order.
