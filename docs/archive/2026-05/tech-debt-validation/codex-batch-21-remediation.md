# Codex Batch 21 Remediation

Status: current
Owner: Codex
Last verified: 2026-05-06
Update policy: archive-only remediation evidence; do not edit after Batch 21 closure.

## Verdict

**CLOSED / CONDITIONAL SKIPS HONORED.** Batch 21 unblocked the Batch 20 merge
state, closed R1/R2/R3/R4/R7 in source, skipped R5 because Batch 20 Q3 was
blocked by D5 rebase conflicts rather than F4 target judgment, and skipped R6
because Batch 20 reported no remaining `content-references.ts` admin-gating
write-path gaps.

## Pre-flight Unblock

Original stop reason: Batch 21 pre-flight expected post-Batch-20 `main`, but
local `main` was still at the Batch 19 tip.

Batch 20 verdicts read from the closure report:

| Workstream | Verdict | Batch 21 action |
|---|---:|---|
| Q1 content-references admin split | CLOSED | Merged |
| Q2 six-module state isolation pack | CLOSED | Merged |
| Q3 D5/F4 ratchet refresh | BLOCKED | Skipped |
| Q4 closure report | CLOSED / docs | Merged |

Authorized setup merge result:

- `feature/tech-debt-2026-05-q1-content-references-admin-split` merged.
- `feature/tech-debt-2026-05-q2-state-isolation-pack` merged.
- `feature/tech-debt-2026-05-q3-d5-f4-ratchet-refresh` not merged.
- `feature/tech-debt-2026-05-q4-batch-20-report` merged.
- New post-Batch-20 local `main`: `5d3ab548`.

Post-merge gates:

- `npx tsc --noEmit`: PASS.
- `npm run verify`: PASS, 464 files / 6958 tests.
- `npx vitest run __tests__/security/p0-chat-identity-isolation.test.ts`: PASS, 23/23.
- `bash scripts/cannot-skip-gate-dashboard.sh --json --no-evidence`: PASS, 23/23.
- `npm run docs:audit`: 483 issues / 414 audited.

## Branch Inventory

| Workstream | Branch | Tip | R8 merge |
|---|---|---:|---:|
| R1 PM2 recovery | `feature/tech-debt-2026-05-r1-pm2-recovery-self-heal` | `c23d748a` | `c5d1ffb7` |
| R2 JWT rotation | `feature/tech-debt-2026-05-r2-jwt-rotation-key-id` | `aef9fa9d` | `651612ba` |
| R3 GH Actions IPv6 | `feature/tech-debt-2026-05-r3-gh-actions-ipv6` | `a78b6922` | `c903f98f` |
| R4 Python pytest | `feature/tech-debt-2026-05-r4-python-pytest-j2-landing` | `dee6ba63` | `038ae759` |
| R5 F4 target reset | skipped | n/a | n/a |
| R6 content-references follow-up | skipped | n/a | n/a |
| R7 GenAI phase 1 | `feature/tech-debt-2026-05-r7-genai-migration-phase-1` | `6c16bad1` | `cfff41dd` |
| R8 closure | `feature/tech-debt-2026-05-r8-batch-21-closure` | branch tip after this report commit | docs/report commit |

## R1 — PM2 Recovery / Self-heal

Verdict: **CLOSED**. Added `src/services/pm2-health.ts`, surfaced PM2 process
health on `/health/detailed`, and records operator-visible `error-monitor`
events when restart counts or non-online statuses indicate supervisor trouble.
No new npm dependency was added.

Evidence:

- Focused tests: `__tests__/services/pm2-health.test.ts` and
  `__tests__/portal/health-endpoints.test.ts` PASS, 14 tests.
- Commit hook full Vitest: 465 files / 6963 tests PASS.

## R2 — JWT Rotation + `kid`

Verdict: **CLOSED**. Added `src/services/ios-jwt.ts`, migrated iOS auth issue
and verification paths through it, added `scripts/rotate-jwt-signing-key.ts`,
and documented the runbook at `docs/engineering/jwt-rotation-runbook.md`.
Legacy no-`kid` tokens continue to verify through the legacy fallback path, so
existing sessions survive the migration.

Evidence:

- Focused tests: `__tests__/services/ios-jwt-rotation.test.ts`,
  auth middleware device revocation, and auth routes PASS, 33 tests.
- Pre-commit focused auth/security suite: 11 files / 97 tests PASS.
- `npm run docs:audit`: 483 issues / 415 audited.

## R3 — GitHub Actions Reachability

Verdict: **CLOSED**. Added `.github/workflows/promote-reachability.yml`; hosted
Actions probe only Cloudflare HTTPS health endpoints, while SSH reachability is
limited to a self-hosted runner with `self-hosted` + `nexus-hub-promote` labels.
Documented the runner dependency at `docs/release/self-hosted-runner-prereqs.md`
and updated `DEPLOY.md`.

Evidence:

- Workflow YAML parse: PASS.
- `npx tsc --noEmit`: PASS.
- P0 identity: 23/23 PASS.
- `npm run docs:audit`: 483 issues / 415 audited.

## R4 — Python Pytest J2 Landing + Expansion

Verdict: **CLOSED**. Merged the authorized J2 pytest scaffold and expanded
content-engine tests to 135 passing cases.

Evidence:

- `content-engine/.venv313/bin/python -m pytest tests/ -v`: PASS, 135 tests.
- `npx tsc --noEmit`: PASS.
- P0 identity: 23/23 PASS.
- Final integrated full Vitest on R8: 467 files / 6971 tests PASS.

## R5 — F4 Target Reset

Verdict: **SKIPPED BY CONDITION**. Batch 20 Q3 was blocked by D5 rebase
conflicts in workspace mirror/release identity docs, not by the "F4 ratchet
target no longer meaningful" condition. The target-reset authorization remains
recorded for audit but was not exercised.

## R6 — Content-references Admin-gating Follow-up

Verdict: **SKIPPED BY CONDITION**. Batch 20 Q4 did not report additional
admin-gating write-path gaps. Q1/Q2 closed the content-reference boundary and
the six-module isolation pack.

## R7 — `@google/genai` Migration Phase 1

Verdict: **CLOSED**. Added `@google/genai@1.52.0`, created
`src/services/gemini-adapter.ts`, and documented phases 2-4 at
`docs/engineering/genai-migration-plan.md`. No production Gemini call sites were
switched in this phase.

Evidence:

- `npm view @google/genai version`: `1.52.0`.
- Focused tests: `__tests__/services/gemini-adapter.test.ts` plus
  `__tests__/services/gemini-provider.test.ts` PASS, 42 tests.
- Commit hook full Vitest: 465 files / 6961 tests PASS.
- R8 integrated commit hook full Vitest: 467 files / 6971 tests PASS.
- `npm run docs:audit`: 483 issues / 415 audited.

Phase 2 readiness:

- Switch `src/services/gemini-provider.ts` import boundary to the adapter.
- Keep `@google/generative-ai` installed during Phase 2 for fast rollback.
- Re-run provider fallback, model routing, Gemini provider, and full verify.

## Authorization Markers

Recorded in `docs/release/OPEN_ITEMS.md` under Standing authorizations:

- `BATCH-21-Q-MERGES-AUTHORIZED`: honored; Q1/Q2/Q4 merged, Q3 skipped.
- `BATCH-21-J2-AUTHORIZED`: honored; J2 merged and expanded to 135 tests.
- `BATCH-21-F4-TARGET-RESET-AUTHORIZED`: recorded; not exercised because R5
  condition did not apply.
- `BATCH-21-GENAI-MIGRATION-PHASE-1-AUTHORIZED`: honored; phase 1 closed.

## Final Gates

- `npx tsc --noEmit`: PASS.
- `npm run verify`: PASS, 467 files / 6971 tests.
- `content-engine/.venv313/bin/python -m pytest tests/ -v`: PASS, 135 tests.
- `npx vitest run __tests__/security/p0-chat-identity-isolation.test.ts`:
  PASS, 23/23.
- `bash scripts/cannot-skip-gate-dashboard.sh --json --no-evidence`: PASS,
  23/23.
- `npm run docs:audit`: PASS, 483 issues / 420 audited.
- `bash scripts/workspace-docs-mirror.sh --check`: PASS, in sync.
- Port hygiene: no listeners on 8100/8200/8201.

## Open Follow-ups

- GenAI migration Phase 2 (call-site import switch) requires explicit
  authorization.
- D5/F4 mock baseline refresh still needs manual D5 rebase reconciliation.
- Self-hosted runner setup remains operator/infra authorized work, informed by
  R3's prerequisites doc.
- Content lifecycle unification and iOS fastlane remain out of scope.
