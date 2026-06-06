# Nexus Hub — Missing Tests and Smokes (Round 2)

**Generated:** 2026-04-30
**Audit:** second-round QA gap review at HEAD `414383b`

What round 2 actually ran (E3+ evidence) vs. what it could not run.

## What ran successfully (round 2)

| # | Target | Files | Tests | Pass | Fail | Skip | Duration |
|---|---|---|---|---|---|---|---|
| 1 | `__tests__/scope/content-tenant-isolation.test.ts` | 1 | 3 | 3 | 0 | 0 | 1.09s |
| 2 | `__tests__/services/tool-executor-allowlist.test.ts` + `chat-tool-auth-fail-closed.test.ts` | 2 | 3 | 3 | 0 | 0 | 1.17s |
| 3 | `__tests__/api/internal-routes-runtime.test.ts` + `internal-routes.test.ts` | 2 | 25 | 25 | 0 | 0 | 0.80s |
| 4 | `__tests__/services/secretary-scheduling-arbitrator.test.ts` + `secretary-agenda-provider-sync.test.ts` | 2 | 22 | 22 | 0 | 0 | 0.26s |
| 5 | `__tests__/api/training-plan-persistence.test.ts` + `cooking-routes.test.ts` + `__tests__/services/finance-secretary-integration.test.ts` | 3 | 23 | 23 | 0 | 0 | 4.84s |
| 6 | `__tests__/services/signals-observability.test.ts` + `signal-ranking.test.ts` | 2 | 48 | 48 | 0 | 0 | 12.50s |
| 7 | `__tests__/services/skill-memory.test.ts` + `skill-version-registry.test.ts` + `__tests__/state/shared-memory.test.ts` | 3 | 41 | 41 | 0 | 0 | 10.00s |
| 8 | `__tests__/services/connections-tenant-isolation.test.ts` + `invoices-tenant-isolation.test.ts` + `content-tenant-scope.test.ts` + `tenant-scope-observability.test.ts` | 4 | 13 | 13 | 0 | 0 | 2.98s |
| 9 | `npx tsc --noEmit` | n/a | n/a | n/a | n/a | n/a | exit 0 |
| 10 | iOS `xcodebuild build` (separate repo, by Agent E) | iOS app | n/a | success | n/a | n/a | n/a |
| 11 | iOS `xcodebuild test` (separate repo, by Agent E) | 142 | 914 funcs | TEST SUCCEEDED | 0 | n/a | n/a |

**Totals (steps 1–8):** 19 vitest files / 178 tests, all green.
**Backend typecheck:** clean.
**iOS build + test:** PASS (separately in iOS repo).

## What was BLOCKED

| Smoke / test | Why it didn't run | What's needed to unblock |
|---|---|---|
| `scripts/chat-tenant-security-smoke.js` | Needs running backend on `127.0.0.1:8200` + JWT/OAUTH env + built `dist/` | `npm run build` + boot backend in background + invoke script |
| `scripts/content-full-nexus-local-smoke.sh` | Orchestrator that boots `full-nexus-local-engine.sh start` (Node + Python content engine), runs full smoke + cross-skill fixtures + chat-tenant-smoke; exceeds 5-min cap | 30-minute operator window |
| `scripts/staging-smoke.sh` | Requires SSH to `dominguez@serverdominguez`, hits staging on `:8201/:8101` | Active staging deploy + remote credentials |
| `scripts/training-calendar-staging-smoke.sh` | Same staging dependency | Same |
| `scripts/training-cross-skill-staging-smoke.sh` | Same staging dependency | Same |
| `scripts/authenticated-api-smoke.sh` | Needs portal admin token + running backend | Same as chat-tenant-security-smoke |
| iOS `.xcresult` archive | Agent E ran the tests but did not archive the bundle | `xcodebuild test ... -resultBundlePath /tmp/nexus-hub-{date}.xcresult` |

## Missing tests (no test exists; should be added)

### P0 — call-graph and cascade tests

| Test | Why needed |
|---|---|
| `training cancel → secretary agenda canceled` | ADV-4: confirms `cancelSecretaryAgendaItem` is invoked from training cancellation path |
| `training cancel → cooking signal stale` | ADV-5: confirms `markSkillMemoriesStaleForVersion` (or equivalent) is invoked on cross-skill memory referencing the cancelled plan |
| `training-plan-calendar-sync legacy route → secretary intent submission` | FC-1: confirms the legacy backfill route also routes through Secretary, OR explicitly fails the test if route is gated off |
| `cancelSecretaryAgendaItem has at least one production caller` | call-graph assertion: `find src/ | xargs grep -l cancelSecretaryAgendaItem | grep -v __tests__` should return at least 1 file |

### P1 — adversarial coverage gaps

| Test | Why needed |
|---|---|
| `tenant A signal not visible to tenant B` (ranked + flat reads) | F-OPUS-P0-1 closure was tested at user-id level only |
| `mid-tool-loop fallback orphan tool_use_id` | ADV-2: provider-A succeeds turn 1+2, fails turn 3, provider-B receives tool_use_ids it never issued |
| `per-object confirmation enforcement` | ADV-3: model issues two `delete_calendar_event` calls in one turn after a single confirmation; second call must be blocked |
| `claims=[] + refs>0 grounding boundary` | ADV-6: assert correct grounding status |
| `generateScript refusal when zero usable references` | ADV-6: pre-check before invoking Python content engine for source-required formats |
| `needsReview reference partition in prompt` | ADV-6: assert review_required refs are in a separate "DO NOT CITE" section |
| `iOS WeekSession decodes decision_explanation` | iOS-GAP-1 |
| `iOS Content view consumes content_output_provenance` | iOS-GAP-2 |
| `secretary adapter without findEventsByAgendaItemId — duplicate prevention` | ADV-10a |
| `chat stream resume cross-uuid dedup` | ADV-10c |
| `tenant_id=user_id write/read asymmetry` (write tenant_shared as non-owner, read fails) | UC-9 |
| `memory quota: 201st write rejected` | UC-10 |
| `Anthropic-streaming + Anthropic non-streaming prompt-injection variants` | FC-13 |
| `real isLoopbackRequest with X-Forwarded-For` | FC-6 |

### P2 — depth gaps

| Test | Why needed |
|---|---|
| `it.each` table for skill version transition matrix (4+ illegal transitions) | FC-4 |
| Concurrent cancel real race (multi-process driver) | FC-5 |
| `setActiveModel` race / live config snapshot | UC-13 |
| Sentry warning fires on Anthropic-disabled-but-configured | UC-11 |
| `completeOneShotWithSearch` PII scrub per-pattern | UC-12 |
| Circuit breaker open → half-open → closed | FC-12 |
| Portal admin chat-diagnostics rate limit | ADV-9 |
| `expires_at` enforced on memory read | A-OPUS-P2-1 |

## Missing smoke evidence (artifacts to preserve)

| Artifact | Where it should live |
|---|---|
| `staging-smoke-{date}.log` | `docs/release/smoke-evidence/` |
| `chat-tenant-security-smoke-{date}.json` | `docs/release/smoke-evidence/` |
| `content-full-nexus-local-smoke-{date}.log` | `docs/release/smoke-evidence/` |
| `training-calendar-staging-smoke-{date}.log` | `docs/release/smoke-evidence/` |
| iOS `.xcresult` (or `xcresulttool get` JSON) | `docs/release/smoke-evidence/ios-{date}.xcresult/` |
| Production health-check transcript | `docs/release/smoke-evidence/prod-health-{date}.txt` |
| Opus re-audit full transcript | `docs/qa/opus-reaudit-{date}.md` |

## Summary

- **178 round-2 vitest tests + clean typecheck + iOS build/test** = strong E3 evidence for the local code surface.
- **5 smoke scripts blocked** by environment (need running backend or remote staging).
- **23 missing tests identified** (4 P0, 14 P1, 5 P2).
- **7 missing smoke artifacts** that should be preserved for post-incident replay.
