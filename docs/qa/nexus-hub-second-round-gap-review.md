# Nexus Hub — Second-Round Gap Review (QA-of-QA)

**Generated:** 2026-04-30 03:40 WEST
**Audit branch:** `qa/nexus-hub-second-round-gap-review`
**Reviewed HEAD:** `414383b4c6fd55f59ccf115c6d66eb1da2d9f67f` (4.14.106 deployed)
**Backup tag:** `backup-qa-gap-review-nexus-hub-20260430-0340`
**Backup branch:** `backup/qa-gap-review-nexus-hub-20260430-0340`
**Companion docs:**
- [`nexus-hub-qa-coverage-gap-matrix.md`](nexus-hub-qa-coverage-gap-matrix.md)
- [`nexus-hub-unverified-claims.md`](nexus-hub-unverified-claims.md)
- [`nexus-hub-missing-tests-and-smokes.md`](nexus-hub-missing-tests-and-smokes.md)
- [`nexus-hub-second-round-open-blockers.md`](nexus-hub-second-round-open-blockers.md)
- [`nexus-hub-second-round-risk-register.md`](nexus-hub-second-round-risk-register.md)
- [`nexus-hub-second-round-recommendations.md`](nexus-hub-second-round-recommendations.md)

---

## 1. Executive Summary

### Final verdict: **FAIL** (but with caveat below)

This is a **QA-of-QA** verdict, not a production health verdict. Production is **already deployed** at 4.14.106 and is healthy per the user's stated health check. The FAIL applies to **whether the prior QA + remediation chain was sufficient evidence to ship to a multi-tenant or higher-stakes audience**, not to whether the current single-user deploy is functionally broken.

The second round found:
- **3 net-new P0 findings** the prior QA + remediation missed entirely
- **6 P1 findings** in the gap-review category (false confidence + adversarial gaps)
- **Strong E3 (unit-test) evidence for 10 of 13 closure claims**, but **zero E4 (local smoke), E5 (staging smoke), or E6 (iOS simulator) evidence is preserved as artifacts** in the repo — the remediation doc claims these passed but no logs are saved
- **iOS contract drift on at least 2 fields** (`decision_explanation` not decoded by `WeekSession`; `content_output_provenance` ledger not consumed)

### Top 3 release-blocking gaps

1. **ADV-4 (P0):** Training cancellation does NOT cascade to Secretary agenda items. `grep -rn cancelSecretaryAgendaItem src/` finds zero production callers from `training-plan-cancellation.ts`. The agenda item lingers in `lifecycle_state='scheduled'` indefinitely with `provider_event_id` pointing at a deleted external event. **User impact:** ghost agenda items persist after plan cancel.
2. **ADV-5 (P0):** No cross-skill stale signal fires on plan cancellation. `markSkillMemoriesStaleForVersion` is never called from training cancel. Cooking, Secretary, Chat keep referencing the cancelled plan. **User impact:** stale recommendations citing a deleted plan.
3. **FC-1 (P0):** The legacy Training calendar-sync route at `src/api/routes/training-plan-calendar-sync.ts:513` still bypasses Secretary. The remediation doc itself acknowledged this as a "follow-up", but the route is in-production today via `/training/plan/sync-calendar`. **User impact:** Secretary-arbitration invariant is bypassable.

### What looks healthy (Opus-confirmed second pass)

- 19 vitest files / 178 tests all green when run focused; full backend typecheck clean.
- 10 of 13 specific Codex closure claims have **adversarial-quality** unit tests (e.g., `tool-executor-allowlist.test.ts` calls a fake tool name and asserts `TOOL_NOT_ALLOWED`; `internal-routes-runtime.test.ts` mocks `isLoopbackRequest=false` and asserts 403).
- `UNSAFE_MEMORY_PATTERNS` test coverage is **best-in-class** — table-driven across 13 distinct credential patterns.
- iOS lifecycle state coverage is exhaustive — 11 backend `SecretaryAgendaLifecycleState` cases + `unknown` fallback all rendered with icons + colors.
- iOS editorial state coverage is exhaustive — 22 `ContentTopicStatus` cases (covers all 14 backend states + extras + `unknown`).

### What is under-tested (gap with the remediation claim)

- **No E5 staging smoke evidence preserved**: doc says "17/17 staging smoke pass" but no log file exists in repo. Same for "14 pass / 2 partial" chat tenant smoke and the iOS `xcodebuild test` claim.
- **No E6 iOS simulator evidence preserved** (despite us running it ourselves and confirming PASS).
- **3 closure claims have weak adversarial coverage** (E-P0-1..E-OPUS-P0-6 cover 11 sites with 3 tests; F-OPUS-P0-1 tests user-id isolation but never tenant-id; C-OPUS-P0-2 Finance leg lacks ordering test).
- **No cross-skill cascade test exists** — no test for "training cancel → secretary agenda canceled → Cooking signal stale".

---

## 2. QA Agent Model/Tier Usage

| Round | Agents | Model/Tier | Effort | Sections covered |
|---|---|---|---|---|
| Round 1 Wave 1 | 8 parallel `Explore` evidence agents + 1 test runner | Sonnet 4.6 (default) | default | 9 critical sections — initial Sonnet baseline |
| Round 1 Wave 2 | 5 parallel `Explore` agents with `model: "opus"` | Claude Opus 4.7 | maximum | 9 critical sections — corrections + 41 new findings |
| **Round 2 (this audit)** | **5 parallel agents with `model: "opus"`** | **Claude Opus 4.7** | **maximum** | Evidence-level audit, false-confidence hunt, adversarial scenarios, missing-test execution, iOS gap audit |

**Round 2 outcomes:**
- Agent A (evidence audit): classified 13 closure claims into E0–E7 levels. 10 are E3, 3 are weaker (E2-equivalent).
- Agent B (false confidence): 14 false-confidence findings, 1 P0, 6 P1.
- Agent C (adversarial scenarios): 10 scenarios traced end-to-end. 2 P0, 5 P1, 3 P2.
- Agent D (run missing tests): 19 vitest files / 178 tests passed. 5 smoke scripts blocked (need running backend or remote staging).
- Agent E (iOS gaps): 7 gaps + 3 confirmed closures. 2 P1, 2 P2, 3 P3.

**Confidence:** HIGH for the audit work itself. **No critical section was Sonnet-only in round 2.** All round-2 agents used Opus 4.7 max effort with file:line evidence.

> **Critical distinction preserved:** Nexus Hub's runtime model routing remains live and configurable. Opus 4.7 max-effort applies only to Claude Code QA agents.

---

## 3. Coverage Gap Summary

For the full per-area E0–E7 matrix, see [`nexus-hub-qa-coverage-gap-matrix.md`](nexus-hub-qa-coverage-gap-matrix.md).

Highlights:
- **All 9 scoped areas have E3 unit-test coverage** but **none have E5 (staging) or E6 (iOS) artifacts preserved**.
- **Cross-skill orchestration (Phase 6) has the weakest coverage**: no test for cascade-on-cancel; no test for cross-tenant signal isolation; no test for Cooking/Finance scheduling-via-Secretary ordering.
- **Calendar/agenda lifecycle (Phase 9) has good coverage for the synced/failed_sync/completed transitions** but **no test for orphan reconciliation when training cancel ≠ secretary cancel**.

---

## 4. Top P0 / P1 release blockers (round 2)

See [`nexus-hub-second-round-open-blockers.md`](nexus-hub-second-round-open-blockers.md) for the full list. Headlines:

### P0 (3)
1. **ADV-4** — Training cancellation does not cascade to Secretary agenda items. `cancelSecretaryAgendaItem` has zero production callers from `training-plan-cancellation.ts`. Fix: emit `agenda_item_canceled` signal + Secretary listener that flips matching `lifecycle_state` to `'canceled'`. ~1 dev-day.
2. **ADV-5** — No cross-skill stale signal on plan cancel. `markSkillMemoriesStaleForVersion` never called from cancellation. Fix: invoke from cancellation path with the cancelled plan version. ~½ dev-day.
3. **FC-1** — Legacy `training-plan-calendar-sync.ts:513` route bypasses Secretary intent. Fix: route `syncTrainingPlanCalendar` through `submitSecretarySchedulingIntent` per session window OR feature-gate the legacy path. ~½ dev-day.

### P1 (6 net new + 3 round-1 carryovers)
- ADV-2: mid-loop provider fallback orphan `tool_use_id` (Anthropic enforces integrity → fallback rejects)
- ADV-3: confirmation gate is per-context, not per-object — one confirmation covers all destructive calls in the turn
- ADV-6: claims=[]+refs>0 returns 'partially_grounded' incorrectly; `generateScript` has no pre-check for usable references; `needsReview=true` references mixed into prompt without partition
- ADV-8: no silent push for cache invalidation — iOS app open during plan regeneration shows ghost data
- ADV-10a: secretary `findEventsByAgendaItemId` is OPTIONAL on adapters — transient network blip after `createEvent` succeeds creates duplicate provider event
- iOS-GAP-1: `WeekSession` doesn't decode `decision_explanation`
- iOS-GAP-2: Content provenance ledger not consumed
- FC-3: `tenant_id=user_id` fix is a structural footgun, not a temporary stopgap (write asymmetry: anyone can WRITE tenant_shared, only owner can READ)
- FC-7/FC-8/FC-9: smoke + iOS + Opus re-audit evidence is narrative-only, no archived logs/`.xcresult`

---

## 5. P2/P3 improvements

See [`nexus-hub-second-round-recommendations.md`](nexus-hub-second-round-recommendations.md) for the full list. Sample:

- ADV-1, ADV-7, ADV-9 (P2): no central tenant-switch hook; no auto-stale on activation; no rate limit on portal admin diagnostics
- iOS-GAP-3 through iOS-GAP-7 (P2/P3): Training detail decision-explanation surface; tenant-switch ViewModel invalidation; deep-link router gaps; smoke version-locking; cross-repo contract registry

---

## 6. Test gaps (missing or weak)

See [`nexus-hub-missing-tests-and-smokes.md`](nexus-hub-missing-tests-and-smokes.md). Highlights:

- No test for `cancelSecretaryAgendaItem` being called from any production cancellation path (call-graph test)
- No test where tenant A reads tenant B's `agent_signals` row (only user-id isolation tested)
- No mid-tool-loop fallback test (only single-turn fallback)
- No per-object confirmation test for chat tool authorization
- No double-confirmation test (one-confirmation-covers-all is the current state)
- No claims=[]+refs>0 grounding boundary test
- No `generateScript`-without-references refusal test
- No `needsReview=true` reference partition test
- No staging smoke result archive (`docs/release/smoke-evidence/`)
- No iOS `.xcresult` archive

---

## 7. Observability gaps

- Smoke evidence is narrative-only (FC-7)
- iOS test result evidence is narrative-only (FC-8)
- Opus re-audit full output not preserved (FC-9)
- Production health-check transcript not preserved (FC-10)
- Test count drift across runs (+123 tests) unexplained per-block (FC-2)
- `setActiveModel` mutates live `config` object instead of per-request snapshot (B-OPUS-P1-2 from round 1, still open)

---

## 8. Local smoke gaps

5 smoke scripts could not run from this audit sandbox:
- `scripts/chat-tenant-security-smoke.js` — needs running backend on `127.0.0.1:8200` + JWT/OAUTH env
- `scripts/content-full-nexus-local-smoke.sh` — orchestrator that spawns 20+ minute local stack
- `scripts/staging-smoke.sh` — requires SSH to `dominguez@serverdominguez`
- `scripts/training-calendar-staging-smoke.sh` — same staging dependency
- `scripts/training-cross-skill-staging-smoke.sh` — same staging dependency

iOS `xcodebuild build` + `xcodebuild test` actually ran from Agent E and PASSED (914 test functions across 142 test files, "TEST SUCCEEDED"). However, no `.xcresult` was archived; reproduction would require re-running.

---

## 9. Final verdict reasoning

**FAIL** — for the QA-of-QA standard, not for production health.

The prior QA + remediation chain successfully closed many findings with adversarial unit tests (E3 evidence). It also created **a coherent paper trail** — `qa-remediation-progress.md` honestly documents partial closures and deferred work. However:

1. **Three net-new P0 findings emerged** in the second round (ADV-4, ADV-5, FC-1) that the prior chain missed entirely. These are call-graph-traced, file:line-evidenced gaps, not speculation.
2. **Smoke evidence is narrative-only** — multiple "PASS" claims (staging, iOS, Opus re-audit) are not preserved as logs in the repo. Cannot replay without re-running.
3. **The `tenant_id=user_id` fix for H-P0-1 is structurally fragile** — works today, fails the moment multi-tenant rolls out. This is the kind of stopgap that gets forgotten.
4. **3 of 13 closures have weak adversarial coverage** (content scope sweep covers 11 sites with 3 tests; signal tenant isolation tested at user-id level only; Finance leg lacks ordering test).

**To upgrade to PASS WITH CONDITIONS:**
- Fix ADV-4 + ADV-5 + FC-1 with adversarial tests (call-graph for ADV-4, signal-emission test for ADV-5, ordering test for FC-1's legacy path)
- Archive smoke evidence (run `scripts/staging-smoke.sh`, `scripts/content-full-nexus-local-smoke.sh`, save `.xcresult`)
- Either fully fix the `tenant_id=user_id` write/read asymmetry OR feature-gate `tenant_shared` writes off until membership table lands

**To upgrade to PASS:**
- All of above + the 6 P1 round-2 findings closed
- Preserved Opus re-audit transcript from round 1
- Cross-repo contract registry pinned for 4.14.106 payload shapes

**Production stays at 4.14.106** while these are addressed. None of the round-2 findings are immediate-rollback severity for a single-user deploy.
