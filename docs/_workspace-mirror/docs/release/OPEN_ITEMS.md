# Open Items

Status: canonical
Owner: release lead (Felipe)
Last verified: 2026-05-10
Update policy: update when a current carryover opens or closes. Monthly
historical detail for the 2026-05 tech-debt sweep lives in
`docs/release/OPEN_ITEMS_ARCHIVE_2026-05.md`.

Last sweep complete: 2026-05-07.
Closeout dossier:
`engine/docs/archive/2026-05/tech-debt-validation/sweep-closeout-dossier.md`.

## 2026-05-10 iOS Pre-TestFlight Validation + Wave 1 Runbook

Release validation:
`docs/archive/2026-05/ios-pre-testflight-validation/release-mode-validation.md`

Operator runbook:
`docs/release/wave1-testflight-cut-runbook.md`

Verdict: **READY_FOR_OPERATOR_TESTFLIGHT_CUT**. iOS `origin/main` is bumped to
`1.4.2 (16)` at `5981d10`. No TestFlight build was cut by Codex.

Closed in source:
- Task A `CachedResource` single-flight regression test is cherry-picked onto
  iOS `main`.
- Release clean simulator build passed with zero warnings/errors after the
  AppIntents.framework link fix.
- Release UI visual matrix passed 21/21 with 80 screenshot attachments.
- Wave 1 TestFlight cut + invitation runbook is written for Felipe's
  operator-physical App Store Connect flow.
- Garmin tenant-isolation watcher state snapshot script is available for the
  first-48-hours observation check.

Operator-only next steps:
- Felipe cuts the TestFlight archive/upload from Xcode.
- Felipe runs the operator-physical smoke checklist from the runbook.
- Felipe monitors the Garmin watcher for `matchedCount: 0` during the first
  48 hours.

## 2026-05-10 Wave 1 Launch Readiness Sweep

Closeout:
`engine/docs/archive/2026-05/launch-readiness-sweep/closeout.md`

Provider filesystem-session audit:
`engine/docs/archive/2026-05/launch-readiness-sweep/provider-filesystem-session-audit.md`

Verdict: **CLOSED IN PRODUCTION** on backend `4.14.147`
(`95a42c80`). Hostile QA returned `READY_FOR_LOCAL_QA`; Felipe authorized the
production promote on 2026-05-10.

Closed in source:
- iOS Phase 2B.4 P3 F-2: `CachedResource` now has a direct single-flight
  regression test proving concurrent loads share one fetch.
- P0 Garmin P3 F-2: Apple Health readiness now has six partial-data sufficiency
  tests covering HRV-only, sleep-only, RHR-only, and paired metric subsets.
- P0 Garmin P3 F-3 audit: Amazon and Uber collectors were audited for
  filesystem session leakage.
- P0 observability: a daily `garmin_tenant_isolation_watcher` dry-runs the
  tainted-session cleanup script and records warning evidence in `error_log`
  plus durable operator alerts if matches reappear.

Evidence:
- iOS `CachedResourceTests` PASS: 7/7 on
  `phase2b4-ios-repository-primitive-2026-05`.
- Engine focused B+D PASS: 2 files / 14 tests.
- Pre-commit focused engine slice PASS: 26 files / 249 tests.
- Mock lint PASS at 826/827 strict baseline.
- Staging re-smoke PASS: 17 passed / 0 failed / 19 total.
- Staging watcher positive-path probe PASS:
  `engine/docs/release/smoke-evidence/staging-garmin-tenant-isolation-watcher-positive-20260509T235850Z.json`.
- Staging watcher negative-path probe PASS:
  `engine/docs/release/smoke-evidence/staging-garmin-tenant-isolation-watcher-negative-20260509T235904Z.json`.
- Production health PASS:
  `engine/docs/release/smoke-evidence/prod-health-launch-readiness-20260510T000541Z.json`.
- Authenticated production snapshot returned version `4.14.147`:
  `engine/docs/release/smoke-evidence/prod-snapshot-launch-readiness-auth-20260510T001015Z.json`.
- Production watcher cold-start PASS: `matchedCount: 0`, no new watcher
  warnings, no new operator alerts:
  `engine/docs/release/smoke-evidence/prod-garmin-tenant-isolation-watcher-cold-start-20260510T001046Z.json`.
- `origin/main` was fast-forwarded to production deploy commit `95a42c80`.

Carryover opened by the audit:
- P1/P2: Amazon and Uber invoice collectors use global filesystem browser
  sessions plus global credentials. Scheduled collection is owner-only, but
  manual Telegram `/amazon` and `/uber` commands can invoke those global
  sessions under any authenticated canonical user. This is
  `dirty-different-mechanism`, not Garmin-style token-table contamination.
  Recommended follow-up: finance collector tenant-safety round before broad
  multi-user finance rollout.

## 2026-05-10 Phase 2B.5 Chat Fastpath Dedup Deferred

Closeout:
`engine/docs/archive/2026-05/phase2b5-chat-fastpath-dedup/closeout-deferred.md`

Verdict: **DEFERRED_WITH_REASON**. Phase 2B is now **4/5 done**:
2B.1 workspace landing state, 2B.2 cache-coherence registry, 2B.3 cached route
helper, and 2B.4 iOS repository primitive are shipped/queued. 2B.5 chat
fastpath dedup is deferred to a likely Phase 3 post-Wave-1 round.

- [DEFERRED] Phase 2B.5 chat fastpath dedup — speculative cleanup,
  source-side probe found only 4 sites and prototype hit +152 LoC. Re-open
  trigger documented. See
  `docs/archive/2026-05/phase2b5-chat-fastpath-dedup/closeout-deferred.md`.

Reason:
- Source-truth diagnosis found 14 `fastpath` mentions, 4 actual runtime
  adapter/call sites, and 2 heavy implementation files.
- The smaller cache/dedup primitive prototype passed its focused suite but had
  a positive source LoC delta, so it failed the architecture-round bar.
- A wider iOS slash-command + Telegram secretary-fastpath merge might pass the
  deletion test, but it would touch user-visible chat rendering and trigger the
  visual QA protocol. That risk is not appropriate before Wave 1.

Re-open trigger:
- Reopen only if beta usage shows observable fastpath cache/coalescing bugs, a
  third real fastpath implementation site appears, or a planned feature needs a
  unified fastpath surface across iOS, Telegram, and WebSocket.

## 2026-05-09 P0 Garmin Tenant Leak + Apple Health Cascade

Closeout:
`docs/archive/2026-05/p0-garmin-tenant-leak-and-applehealth-cascade/closeout.md`

Verdict: **CLOSED IN PRODUCTION** on backend `4.14.146`
(`d05e3bac`). Hostile QA returned `READY_FOR_LOCAL_QA`; Felipe authorized the
production promote on 2026-05-09.

Closed in source/staging:
- Garmin legacy filesystem token fallback is now owner-only.
- Global Garmin credential MFA login is blocked for non-owner users without a
  per-user Garmin session.
- Apple Health readiness fallback is verified with seeded HRV/sleep/RHR data
  and returns real per-user readiness when Garmin is empty.
- Synthetic neutral readiness is preserved when both Garmin and Apple Health are
  empty.
- Staging cleanup script dry-run/delete pass found 0 contaminated Garmin rows
  and is idempotent.

Evidence:
- Typecheck PASS.
- Focused P0/Garmin/readiness route suite PASS: 9 files / 140 tests.
- New P0 regression suite PASS: 6/6.
- Cannot-skip dashboard PASS: 33/33.
- Mock lint PASS at strict baseline 827.
- Staging smoke PASS: 17 passed / 0 failed / 19 total.
- Smoke evidence:
  `engine/docs/release/smoke-evidence/staging-smoke-379f741d-20260509T171331Z.json`.
- Pre-promote staging re-smoke PASS: 17 passed / 0 failed / 19 total.
  Evidence:
  `engine/docs/release/smoke-evidence/staging-smoke-d580da66-20260509T173848Z.json`.
- No-data staging probe:
  `engine/docs/release/smoke-evidence/staging-p0-garmin-no-data-20260509T173947Z.json`.
- Apple Health staging probe:
  `engine/docs/release/smoke-evidence/staging-p0-garmin-apple-health-20260509T173947Z.json`.
- Production cleanup pre-promote dry-run found 5 tainted non-owner rows:
  `engine/docs/release/smoke-evidence/prod-cleanup-dry-run-20260509T174048Z.json`.
- Production cleanup post-deploy delete pass removed all 5 rows and follow-up
  dry-run returned `matchedCount: 0`:
  `engine/docs/release/smoke-evidence/prod-cleanup-delete-20260509T174717Z.json`,
  `engine/docs/release/smoke-evidence/prod-cleanup-postdelete-dry-run-20260509T174722Z.json`.
- Production health/snapshot/PM2 evidence:
  `engine/docs/release/smoke-evidence/prod-health-20260509T174909Z.json`,
  `engine/docs/release/smoke-evidence/prod-snapshot-20260509T174909Z.json`,
  `engine/docs/release/smoke-evidence/prod-pm2-health-20260509T174938Z.json`.
- Non-owner production readiness probe: user `28` returned Apple Health
  readiness `84` and body battery `78`, not the leaked Felipe pair:
  `engine/docs/release/smoke-evidence/prod-non-owner-readiness-probe-user28-clean-20260509T174858Z.json`.

Remaining after closure:
- P3: Separate provider filesystem-session audit for Amazon/Uber collectors.

## 2026-05-09 Phase 2B.1 Workspace State Visual QA Closure

Closeout addendum:
`docs/archive/2026-05/phase2b1-workspace-state-module/visual-qa-closure-closeout.md`

Verdict: **READY_FOR_LOCAL_QA** eligible after visual-evidence closure.
Production and main were not touched.

Closed in source:
- Workspace landing visual QA now covers every enumerated Tasks, Training,
  Cooking, Content, and Finance warmup/unavailable/content state across en-US
  and pt-BR.
- Shared workspace warmup/unavailable views now support centrally generated
  accessibility identifiers via optional `identifierPrefix`.
- Cooking, Content, and Finance unavailable states can be forced through
  `QualityAuditScenario` for deterministic XCUITest rendering.
- Retry interactions are covered for all five domains.

Evidence:
- `WorkspaceLandingStateTests` PASS: 13/13.
- `WorkspaceLandingVisualUITests` PASS: 38/38 with screenshot attachments.
- Combined selected UI gate PASS: 42/42 selected UI tests including visual,
  auth, and feedback smoke.
- Screenshot export path:
  `/tmp/phase2b1-visual-attachments-final`.
- Combined xcresult:
  `/Users/felipedominguez/Library/Developer/Xcode/DerivedData/Nexus_Hub-gsoqdyrpqmkkotdmfddhuhobycvu/Logs/Test/Test-Nexus Hub-2026.05.09_13-03-01-+0100.xcresult`.

Remaining before closing Phase 2B.1:
- P1: Claude hostile QA on the visual-closure commit stack.
- P2: TestFlight/operator visual review after hostile QA, if requested.

## 2026-05-09 Phase 2A Wave-2 Blockers — Source/Staging Complete

Closeout:
`docs/archive/2026-05/phase2a-wave2-blockers/closeout.md`

Verdict: **READY_FOR_HOSTILE_QA** on local source branches after staging smoke.
Production was not touched by this phase.

Closed in source/staging:
- Voice-evolution agent and Tuesday/Thursday/Friday content crons now scope to
  active users/tenants instead of owner-only execution.
- `video-study.ts` and `channel-learner.ts` now derive language/audience/niche
  from authenticated creator profiles instead of founder-shaped PT-BR/fitness
  defaults.
- iOS REST AI routes now use a shared global + per-user cost guardrail helper
  before AI execution.
- Settings now has an in-app feedback report channel with build/user/provider
  context and recent client-error context.
- Legacy `NEXUS_SKIP_AUTH` references were removed from `Nexus HubUITests/`.
- Cannot-skip dashboard now includes Phase 2A gates and reports 30/30 locally.

Evidence:
- Engine typecheck PASS.
- Focused engine vitest PASS: 6 files / 16 tests.
- Content-engine prompt cleanliness PASS: 11/11.
- Cannot-skip dashboard PASS: 30/30.
- Mock lint PASS at strict baseline 827.
- iOS focused XCUITest PASS: 10 executed, 1 skipped, 0 failures.
- Staging deploy PASS.
- Staging smoke PASS: 20/20.
- Smoke evidence:
  `engine/docs/release/smoke-evidence/staging-smoke-b1f3ceea-20260509T010124Z.json`.

Remaining before Wave 2 promote:
- P1: Claude hostile QA on Phase 2A branches.
- P1: Operator decision on production promote after hostile QA.
- P2: Replace the remaining TrainingValidation auth-stub skip with a hard
  main-tab assertion once the stub server can provide the required
  post-onboarding/profile state.
- P2: Add authenticated staging fixture users for free-tier/pro-tier/global-cost
  manual probes so future release gates do not rely only on local behavioral
  tests.
- P3: Add real screenshot attachment support to the in-app feedback channel
  after privacy/retention rules are defined.
- P3: Revisit Sentry/ops alert thresholds for the cohort-scoped
  `GLOBAL_DAILY_COST_LIMIT=100.00`.

Phase 2B carryovers remain unchanged and out of scope for this phase:
- iOS Repository read-cache plumbing consolidation.
- Workspace state module consolidation.
- API route helper consolidation.
- Cache invalidator registry.
- iOS chat fastpath + Telegram fastpath convergence.

Latest closed-beta gap analysis: 2026-05-07 (mid-day Europe/Lisbon).
Report: `docs/archive/2026-05/closed-beta-gap-analysis/all-skills-gap-analysis-report.md`
Verdict: READY_WITH_CONDITIONS on the source branch after the P0 cluster
closures below and the 2026-05-07 hostile-validation remediation. Operator-only
device/APNs/deploy validation remains before broad beta.

**2026-05-07 late-day hostile QA on `5bbe1b40` + `a4b4be8`** — `docs/archive/2026-05/secretary-notification-orchestrator/remaining-open-tasks-hostile-qa.md`. Verdict: **NOT_READY**. Multiple "CLOSED IN SOURCE BRANCH" claims are downgraded:

- **GAP-CONT-3 → FALSE-CLAIM**: `content-performance-aggregate.ts` reads `content_radar_feedback`, not `content_performance`. Performance-feedback adaptation loop is still a silent dead-end. **REOPEN**.
- **GAP-CONT-4 → PARTIAL**: TopicSchedulerView is a real publishing calendar ✓; ContentIntelligenceView is NOT a performance dashboard (renders `optimization.recentSignals` and `activeInsightCount` only — zero views/retention/likes/comments). **Performance half REOPEN**.
- **GAP-CONT-1 → PARTIAL / OPEN WRITER GAP**: Global env leak closed ✓ and resolver fails closed, but `youtube-channel-scope.ts` still needs an explicit OAuth/owned-channel writer before Performance/SEO can use live creator analytics. Do not mark production analytics adaptation closed until that writer exists.
- **GAP-CONT-2 → CLOSED IN SOURCE BRANCH**: Neutrality scanner now covers `src/agents/**`, `src/services/**`, and Python `content-engine/services/intelligence|creative/**/*.py`; YouTube global-channel detection now uses a bypass-resistant pattern. Closed by engine commit `16b23cc9`.
- **GAP-SEC-AUTH-1 → CLOSED IN SOURCE BRANCH**: `runContentDiscovery` now requires a named positive `userId`/`tenantId`, removes the `userId ?? 0 as any` escape, and manual report dispatch passes named values. Closed by engine commit `16b23cc9`.
- **GAP-CHAT-1 → CLOSED IN SOURCE BRANCH**: Telegram command/callback/media handlers now inherit one central bot-level `runWithChatToolAuthorization` context, and the legacy helper rejects `0/-1/NaN/Infinity/unsafe` ids via `isValidTenantUserId`. Closed by engine commit `16b23cc9`.
- **GAP-CAL-1 → PARTIAL**: conflict-detection NotificationIntent emission now has per-user try/catch containment and dedupe keys include a conflict signature. The other Telegram-only crons remain a separate migration workstream. Partial closure by engine commit `16b23cc9`.
- **GAP-FIN-1 → CLOSED FOR HOSTILE CITATIONS**: receipt OCR no longer logs merchant/amount, tax calculation no longer logs `taxDue`, invoice collector no longer logs vendor names, and logger redaction includes finance PII/amount paths. Closed by engine commit `16b23cc9`.
- **GAP-REL-3 → CLOSED IN SOURCE BRANCH**: iOS release-hardening workflow now lists simulator runtimes, verifies an iPhone 16 Pro destination for GitHub runners, runs `xcodebuild test`, and asserts a non-zero xcresult test summary. Closed by iOS commit `f43fc5b`.
- **GAP-IOS-5 → CLOSED IN SOURCE BRANCH**: `AppState.signOut` and scope reconciliation now await process-wide cache clearing, invalidate `InboxSnapshotStore`, clear `URLCache`, and reorder auth logout after cache invalidation. Closed by iOS commit `f43fc5b`.

**New P0 from this hostile pass:**
| ID | Description |
|---|---|
| HOSTILE-CHAT-1A | Callback queries + commands/media now inherit central Telegram bot chat-tool authorization middleware. CLOSED IN SOURCE BRANCH via engine commit `16b23cc9`; coverage in `__tests__/handlers/chat-tool-auth-middleware.test.ts`. |
| HOSTILE-CHAT-1B | `runTelegramDomainHandlerWithToolAuthorization` now uses `isValidTenantUserId` and records tenant-scope anomalies for invalid ids. CLOSED IN SOURCE BRANCH via engine commit `16b23cc9`; coverage in `__tests__/handlers/chat-tool-auth-context.test.ts`. |

**New P1 from this hostile pass:**
- HOSTILE-AUTH-1 — CLOSED via engine commit `16b23cc9`; coverage in `__tests__/services/content-discovery-scope.test.ts` and `__tests__/services/manual-report-triggers.test.ts`.
- HOSTILE-CONT-F1 — OPEN / OWNER DECISION REQUIRED: resolver remains fail-closed until an OAuth/owned-channel writer marks creator-owned channels.
- GAP-CAL-1-A — CLOSED via engine commit `16b23cc9`; conflict intent emit is now isolated per user.
- GAP-CAL-1-C — OPEN / FOLLOW-UP: broader Telegram-only cron migration remains intentionally unbatched.
- GAP-FIN-1-A/D — CLOSED via engine commit `16b23cc9`; coverage in finance route/tracker tests plus `__tests__/utils/logger-redaction-finance.test.ts`.
- HOSTILE-IOS-REL3 — CLOSED via iOS commit `f43fc5b`; coverage in `Nexus HubTests/ReleaseHardeningConfigTests.swift`.
- HOSTILE-IOS-5A/B — CLOSED via iOS commit `f43fc5b`; coverage in `Nexus HubTests/RepositoryScopeChangeTests.swift`.
- P1-CHAT-1C — CLOSED via engine commit `16b23cc9`; destructive and external-send confirmation are pinned.
- P1-CHAT-1D — CLOSED / NARRATIVE CORRECTED in this section; central bot middleware is the closure mechanism.

P2/P3 (~15 more) live only in the hostile QA archive report; surface to OPEN_ITEMS only when promoted by a fix prompt or new evidence.

Secretary Notification Orchestrator source branch: 2026-05-07.
Report:
`docs/archive/2026-05/secretary-notification-orchestrator/secretary-notification-orchestrator-report.md`.
Verdict: READY_WITH_CONDITIONS on local/mock validation. Production APNs
credentials, signed-device push/action validation, and deploy remain
operator-only; no push or deploy was performed.

Event backbone / read models / delta sync source branch: 2026-05-07.
Report:
`docs/release/event-backbone-readmodels-delta-sync-report.md`.
Verdict: **READY_WITH_CONDITIONS** after source remediation. Do not push or
deploy from this branch yet.

**2026-05-07 hostile QA on event backbone** —
`docs/archive/2026-05/event-backbone-readmodels-delta-sync/hostile-qa-report.md`.
Original hostile verdict was **NOT_READY** and was correct at audit time.
Source remediation now landed in engine `2e896435` and iOS `82abbea`; Claude
hostile re-QA remains the next evidence gate.

**2026-05-07 hostile QA v2 final report** —
`docs/archive/2026-05/event-backbone-readmodels-delta-sync/hostile-qa-v2-final-report.md`.
Verdict: **READY_FOR_LOCAL_QA**. After v2 source remediation (engine `e82bbdae`/`ca2e0cd9` + iOS `12a9d95`),
all 11 v2 hostile findings are behaviorally closed with real-DB / real-route /
real-cancellation tests. Independent gates: tsc clean, 56/56 focused vitest
pass, 23/23 cannot-skip dashboard, mock lint baseline 827 unchanged, workspace
mirror in sync. iOS xcodebuild simulator 11/11 PASS. Zero regressions found.
Remaining gates are operator-only: authenticated iOS product-surface walkthrough,
migration 115 staging apply, production env flag confirmation, APNs credentials.

**2026-05-07 staging deploy evidence** —
`docs/archive/2026-05/event-backbone-readmodels-delta-sync/staging-deploy-evidence-2026-05-07.md`.
Verdict: **STAGING_READY**, not production-ready. Runtime/evidence baselines are
engine `b13e2495` and iOS `dd8ffe0`, both pushed to origin; the engine feature
branch also has later docs-only staging evidence commits. Staging deploy completed
with conservative event-backbone flags, migration 115 applied on the staging DB,
worker-disabled soak queued safely, worker-enabled soak drained to
`event_outbox processed=18` and `background_jobs completed=27`, and post-worker
staging smoke passed 21/21. Dead-letter admin routes returned zero events/jobs.
Production push/promote remains operator-only pending signed TestFlight
two-account walkthrough, APNs production credentials, time-sensitive entitlement
confirmation, production event-backbone env flag decision, and production row
count review if event_backbone tables already exist there.

**Hostile P0 cluster — REMEDIATED IN SOURCE BRANCH**
| ID | Source-branch remediation | Hostile re-QA verdict |
|---|---|---|
| HOSTILE-OUTBOX-1 | Runtime emit paths now use transactional outbox via `runOutboxTransaction`; business state and event rows commit together when the DB is initialized. | **WEAK CLOSURE** — 8 wrapped sites correct, `emitDomainEventSafely` removed; but new `fallbackWhenDatabaseUnavailable` parameter re-introduces silent-drop on DB-unavailable race (HOSTILE-OUTBOX-1A); notification-orchestrator + finance PATCH hand-roll their own transactions bypassing canonical wrapper (HOSTILE-OUTBOX-1C); transactional-rollback test missing (HOSTILE-OUTBOX-1B). |
| HOSTILE-PRIV-1 | Event payloads and decision-log summaries now use recursive privacy sanitization before persistence/sync. | **VERIFIED CLOSED** — `src/utils/privacy-sanitizer.ts` (54 lines) recurses with `maxDepth: 4` + 26-key expanded regex; used by event-outbox, product-decision-log, AND delta-sync (defense-in-depth at appSafeSummary, tighter `maxStringLength: 160`); behavioral test pins nested redaction. |
| HOSTILE-BUDGET-1 | Resource budgets now use atomic SQLite `UPDATE ... RETURNING` counters keyed by tenant/user/window. | **VERIFIED CLOSED** — `UPDATE ... WHERE count + ? <= ? RETURNING count` is single-statement atomic; 100-caller concurrency test asserts final count <= 10 AND exactly 10 succeed. |
| HOSTILE-OBS-1 | Event/job workers and budget exhaustion emit structured, scoped logs with processed/failed/dead-letter counts. | **VERIFIED CLOSED** — 3 batch-summary log lines (`event_outbox_batch`, `background_job_batch`, `event_backbone_worker_tick`) with `claimed/processed/failed/deadLetter/durationMs`; spy tests assert schema; PII-safe. |

**P1 cluster outcomes:**
- HOSTILE-OUTBOX-2 (lease atomicity) — VERIFIED CLOSED
- HOSTILE-OUTBOX-3/JOB-3 (orphan reaper) — WEAK (code present, behavioral test missing)
- HOSTILE-OUTBOX-7 (dead-letter operator surface) — WEAK (102-line admin router, ZERO behavioral tests)
- HOSTILE-OUTBOX-9 (replay tenant scope) — VERIFIED CLOSED
- HOSTILE-JOB-2 (cancel processing) — WEAK / asymmetric (job side guards correct; **event side `markEventFailed`/`markEventProcessed` overwrite canceled** — HOSTILE-EVENT-CANCEL-RACE)
- HOSTILE-JOB-4 (decision-log retention) — VERIFIED CLOSED
- HOSTILE-SYNC-1 (deviceId no query trust) — VERIFIED CLOSED with strong behavioral test
- HOSTILE-SYNC-2 (retention vs offline device) — VERIFIED CLOSED with `protectFloor` + behavioral test
- HOSTILE-SYNC-4 (reset not advance cursor) — VERIFIED CLOSED with idempotent-reset test
- HOSTILE-OBS-2 (budget log + Retry-After) — VERIFIED CLOSED
- HOSTILE-TEST-1 (real 429 test) — VERIFIED CLOSED (drives 121 requests through live consume)

**iOS hardening outcomes:**
- HOSTILE-IOS-DS-1 (parallel fan-out): CLOSED structurally, but **validation test crashes** — HOSTILE-IOS-DS-NEW-1
- HOSTILE-IOS-DS-2 (cold-launch race): WEAK (fragile MainActor invariant, undocumented)
- HOSTILE-IOS-DS-3 (cancellation propagation): OPEN (no `Task.checkCancellation()`)
- HOSTILE-IOS-DS-4 (test coverage): WEAK (parallel test broken; cancellation/duplicate/cap untested)
- HOSTILE-IOS-DS-5 (duplicate changeId): WEAK (semantic flip last→first-write-wins, no test)
- HOSTILE-IOS-DS-6 (cache bound): CLOSED-with-caveat (magic 500, no constant/comment)
- HOSTILE-IOS-DS-9 (scenePhase TTL): WEAK / partial — only cold-launch gated; `onChange(of: scenePhase)` at DashboardView:214 still un-gated

**NEW findings introduced by remediation — REMEDIATED IN SOURCE BRANCH**
- **HOSTILE-OUTBOX-1A (P1)** — CLOSED via engine `e82bbdae`; `runOutboxTransaction` no longer has a DB-unavailable fallback and fails closed without initialized storage.
- **HOSTILE-OUTBOX-1B (P1)** — CLOSED via engine `e82bbdae`; rollback tests prove business rows roll back when event emit fails and event rows roll back when the callback throws.
- **HOSTILE-OUTBOX-1C (P2)** — CLOSED via engine `e82bbdae`; notification intent creation and Finance PATCH use `runOutboxTransaction`.
- **HOSTILE-EVENT-CANCEL-RACE (P1)** — CLOSED via engine `e82bbdae`; event processed/failed paths preserve `canceled`.
- **HOSTILE-MIGRATION-114-EDITED (P2)** — CLOSED via engine `e82bbdae`; migration 114 was restored and migration 115 rebuilds `event_outbox` with `canceled`.
- **HOSTILE-IOS-DS-NEW-1 (P1)** — CLOSED via iOS `12a9d95`; URLProtocol mock state is lock-protected.
- **HOSTILE-ADMIN-NO-TESTS (P1)** — CLOSED via engine `e82bbdae` plus `ca2e0cd9`; admin auth, tenant scope, replay, cancel, and attempts reset are behavior-tested.
- **HOSTILE-ORPHAN-REAPER-NO-TEST (P2)** — CLOSED via engine `e82bbdae`; stale event/job lease reclaim paths are behavior-tested.
- **HOSTILE-IOS-DS-9 (P1)** — CLOSED via iOS `12a9d95`; Dashboard scenePhase active refresh is TTL-gated.
- **HOSTILE-IOS-DS-3 (P1)** — CLOSED via iOS `12a9d95`; summary refreshes include cancellation checkpoints and regression coverage.
- **HOSTILE-IOS-DS-5 (P1/P2)** — CLOSED via iOS `12a9d95`; duplicate `changeId` first-write-wins is documented and tested.

**Hostile re-QA closeout addendum**: `docs/archive/2026-05/event-backbone-readmodels-delta-sync/hostile-qa-report.md` (post-remediation § + v2 closeout §).

**Independent gates after remediation**: tsc PASS · full `npm run verify` PASS 481 files / 7074 tests · focused event-backbone/security vitest PASS 52/52 · chat/admin follow-up vitest PASS 9/9 · Python pytest PASS 135/135 · iPhone Felipe DeltaSync tests PASS 11/11 · cannot-skip dashboard 23/23 · mock lint baseline 827.

**Process improvement observed**: this is the FIRST hostile wave where Codex's closure narrative matched the source on architectural primitives. The pre-claim probe was adopted. Remaining gaps are now narrower and behavioral (fallback-path bug, asymmetric guards, missing rollback test, broken mock thread-safety) rather than "headline architectural property is fabricated."

**Promoted P1 cluster — REMEDIATED IN SOURCE BRANCH**
- Atomic event/job claims, stuck-lock recovery, dead-letter list/replay/cancel
  operator routes, tenant-scoped replay/cancel, and processing-job cancellation.
- Cleanup preserves dead-letter forensic evidence and processed events needed by
  active sync cursors.
- Sync no longer trusts query-string `deviceId`; authenticated request device
  scope is required, reset-required paths do not advance the cursor, and iOS
  reset handling clears scope without storing an unacknowledged cursor.
- Route/budget tests now exercise real 429 paths and `Retry-After`; iOS
  repository/store tests now cover coalescing, parallel summaries, reset cursor
  safety, duplicate handling, and bounded cache history.

Remaining conditions:
- P1: independent Claude hostile re-QA against `2e896435` + `82abbea`.
- P1: authenticated iOS product-surface interaction smoke remains required
  before treating summary/delta app integration as UI-validated. Physical iPhone
  behavior tests passed, but no authenticated screen walkthrough is claimed.
- P1: release/deploy operator must explicitly confirm event-backbone worker and
  cleanup env flags before staging/prod (`EVENT_BACKBONE_WORKER_DISABLED`,
  batch limits, `EVENT_BACKBONE_CLEANUP_APPLY`).
- P2: gradually render Home, Week/Semana, Training, Content, and Notifications
  from summary read models where product value is clear.
- P2: expand budgets to provider, calendar, content radar, and live
  notification-delivery attempts.

## 2026-05-07 Closed-Beta Gap Analysis — New P0/P1 Items

These items came from the all-skills gap analysis run on 2026-05-07 by Claude Code
on Opus 4.7 with 8 specialist Opus subagents. Detailed evidence (file:line, expected vs
actual, recommended fix-prompts) is in the archive report linked above.

### P0 — closed-beta blockers

| ID | Area | Description |
|---|---|---|
| GAP-CONT-1 | content runtime | Performance + SEO agents no longer read global `YOUTUBE_CHANNEL_ID` as a fallback. PARTIAL IN SOURCE BRANCH `feature/secretary-notification-orchestrator`; `src/services/youtube-channel-scope.ts` resolves only explicitly user-owned channels and fails closed. OPEN WRITER GAP: OAuth/owned-channel writer still needs owner authorization before live creator analytics can be considered enabled. Coverage in `__tests__/services/youtube-channel-scope.test.ts` and `__tests__/security/content-agent-neutrality.test.ts`. |
| GAP-COOK-1 | cooking | `applyMealPlanSubstitution`, `addRecipe`, `updateRecipe`, and `setMealPlan` now enforce stored allergy memory before writes; unsafe substitutions are rejected before mutation. CLOSED IN SOURCE BRANCH `feature/secretary-notification-orchestrator` via `6b6e74cb`; coverage in `__tests__/services/cooking-chef.test.ts` and `__tests__/api/cooking-routes.test.ts`. |
| GAP-REL-3 | iOS CI | `ios/.github/workflows/ios-release-hardening.yml` now runs real `xcodebuild test` on the Nexus Hub scheme, verifies the GitHub-runner simulator destination, writes an xcresult bundle, and asserts a non-zero test count before release-hardening completion. CLOSED IN SOURCE BRANCH `feature/secretary-notification-orchestrator` via iOS commit `f43fc5b`; coverage in `Nexus HubTests/ReleaseHardeningConfigTests.swift`. |
| GAP-REL-4 | backend health | `/health` and `/health/detailed` now run a live `SELECT 1` DB probe and return degraded/503 on failure. CLOSED IN SOURCE BRANCH `feature/secretary-notification-orchestrator` via `6b6e74cb`; coverage in `__tests__/portal/health-endpoints.test.ts`. |
| GAP-REL-5 | release pipeline | Notification orchestrator security gate is empty: classifier glob `__tests__/security/notification-*.test.ts` expands to nothing; cannot-skip dashboard does not include orchestrator file. — CLOSED IN SOURCE BRANCH `feature/secretary-notification-orchestrator` via `__tests__/security/notification-orchestrator-security.test.ts`, changed-area classifier mapping, and cannot-skip dashboard representative. |
| GAP-IOS-2 | iOS APNs | `ReportService.swift:111` hardcodes `environment: "sandbox"` for ALL builds → TestFlight/prod tokens mis-tagged → APNs delivery fails. — CLOSED IN SOURCE BRANCH `feature/secretary-notification-orchestrator`; debug builds register `sandbox`, release/TestFlight builds register `production`. |
| GAP-IOS-1 | iOS WIP | `SettingsView.swift:83-89` switch non-exhaustive after `SettingsDestination.notificationCenter` was added. — CLOSED IN SOURCE BRANCH `feature/secretary-notification-orchestrator`; settings navigation handles `.notificationCenter`. |
| GAP-IOS-3 | iOS WIP | `nexus://notifications/<id>` deep-link dead-ends (no view consumes `.notificationCenter`). — CLOSED IN SOURCE BRANCH `feature/secretary-notification-orchestrator`; `DeepLinkRouter` and Settings navigation consume notification-center routes. |
| GAP-IOS-4 | iOS WIP | `AppDelegate.swift didReceive response` ignores `actionIdentifier` (mark_done/snooze/approve_script/reject_reflow are no-ops). — CLOSED IN SOURCE BRANCH `feature/secretary-notification-orchestrator`; custom notification actions are queued and consumed by Decision Center action handling. |

### P1 — high priority before beta-launch

| ID | Area | Description |
|---|---|---|
| GAP-SEC-AUTH-1 | auth/state | Legacy 2-arg `saveIdea(title, sourceDate)` no longer writes `user_id=0`; saved-idea writes and promote/use/delete mutations now require and scope by positive `userId`. CLOSED IN SOURCE BRANCH `feature/secretary-notification-orchestrator`; coverage in `__tests__/state/saved-ideas-scope.test.ts`. |
| GAP-CHAT-1 | chat | Telegram domain routing now runs skill handlers inside `runWithChatToolAuthorization` ALS context with the canonical user/tenant. CLOSED IN SOURCE BRANCH `feature/secretary-notification-orchestrator`; coverage in `__tests__/handlers/chat-tool-auth-context.test.ts`. |
| GAP-TRN-1 | training | Plan-linter blockers remain advisor-only after persistence; promoting to strict requires a dedicated pre-persist or rollback-safe training batch. OPEN / OWNER DECISION REQUIRED. |
| GAP-CONT-2 | content tests | Neutrality coverage now scans TypeScript content agents/services and Python content-engine intelligence/creative services, and pins that runtime code does not read global `config.youtube?.channelId` / `YOUTUBE_CHANNEL_ID`. CLOSED IN SOURCE BRANCH `feature/secretary-notification-orchestrator` via engine commit `16b23cc9`; coverage in `__tests__/security/content-agent-neutrality.test.ts`. |
| GAP-CONT-3 | content loop | Radar feedback currently feeds `content_radar_feedback` and source-side aggregate state, but the hostile re-check confirmed the performance-feedback adaptation loop is not wired to live `content_performance`. OPEN / PRODUCT WORKSTREAM REQUIRED; do not describe this as verified closed. |
| GAP-CONT-4 | iOS content | TopicSchedulerView covers the publishing calendar half. Performance dashboard remains OPEN: ContentIntelligenceView does not expose views/retention/likes/comments performance truth. PARTIAL; physical/UI beta smoke remains operator validation after the performance surface exists. |
| GAP-SEC-NOTIF-1 | notif orch | Quiet-hours-delayed and digest items persisted with `scheduled_for` but no scheduler/release loop consumes them. — CLOSED IN SOURCE BRANCH `feature/secretary-notification-orchestrator`; scheduler now runs the orchestrator release loop. |
| GAP-SEC-NOTIF-2 | notif orch | `POST /api/v1/notifications/intents` accepts arbitrary `priority`/`sourceSkill`/`type` from client body; iOS could fabricate `security/critical`. — CLOSED IN SOURCE BRANCH `feature/secretary-notification-orchestrator`; arbitrary intent creation now requires internal secret authorization and fixture route remains deterministic. |
| GAP-SEC-NOTIF-3 | notif orch | `migrations/113_*.sql` schema diverges from runtime `ensureNotificationTables()`; `ios_devices` only at runtime. — CLOSED IN SOURCE BRANCH `feature/secretary-notification-orchestrator`; migration/runtime table setup now cover orchestrator tables and existing APNs compatibility storage is preserved. |
| GAP-SEC-NOTIF-4 | notif orch | `isInQuietHours` uses server-local time, not `profile.timezone`. — CLOSED IN SOURCE BRANCH `feature/secretary-notification-orchestrator`; quiet-hours policy now evaluates in the profile timezone. |
| GAP-CAL-1 | secretary | Conflict-detection cron now emits a Secretary `conflict_detected` NotificationIntent before Telegram delivery, isolates failures per user, and dedupes by conflict signature. PARTIAL via engine commit `16b23cc9`; broader Telegram-only cron migration remains OPEN as a separate workstream. Coverage in `__tests__/services/scheduler-user-scope.test.ts`. |
| GAP-FIN-1 | finance privacy | Hostile-cited finance logs no longer include raw transaction `category`/`amount`, receipt merchant/amount, tax due, or vendor names; logger redaction now includes finance PII/amount paths. CLOSED IN SOURCE BRANCH `feature/secretary-notification-orchestrator` via engine commit `16b23cc9`; coverage in `__tests__/services/finance-tracker.test.ts`, `__tests__/api/finance-routes.test.ts`, and `__tests__/utils/logger-redaction-finance.test.ts`. |
| GAP-FIN-2 | finance | Brazilian tax support is still the only implemented jurisdiction for tax calculation. OPEN / OWNER DECISION REQUIRED for a finance jurisdiction model and non-BR behavior contract. |
| GAP-PORT-3 | portal | New `/api/notifications` and `/api/notification-preferences` lack tenant filter at route boundary (`engine/src/portal/document-routes.ts:13-50,52-64`). — CLOSED IN SOURCE BRANCH `feature/secretary-notification-orchestrator`; portal routes validate scoped user/tenant headers/query and reject cross-tenant scope. |
| GAP-REL-1 | docs/identity | Workspace `docs/release/release-identity.md` stale at 4.14.132 (prod is 4.14.134). — OPEN |
| GAP-REL-2 | docs/release | Engine `docs/release/CURRENT_RELEASE_STATE.md` frozen at 4.14.127 — 7 production releases unsynced. — OPEN |
| GAP-REL-6 | mock-lint | Trajectory off-target: ~70 months at 10/month vs `<100 by 2026-08-01`. OPEN / OWNER DECISION REQUIRED: either authorize a larger mock-factory reduction batch or downgrade the commitment date. |
| GAP-REL-7 | release gate | Two-account E5 remains operator-evidence gated; adding a hard CI/deploy gate needs an explicit release-process decision to avoid blocking emergency deploys without physical-device evidence. OPEN / OWNER DECISION REQUIRED. |
| GAP-IOS-5 | iOS cache | `ResponseCache.shared.clear()` is now awaited on signOut and scope reconciliation/account switch paths, `InboxSnapshotStore` is invalidated, `URLCache` is cleared, and logout runs after local cache invalidation. CLOSED IN SOURCE BRANCH `feature/secretary-notification-orchestrator` via iOS commit `f43fc5b`; coverage in `Nexus HubTests/ResponseCacheTests.swift` and `Nexus HubTests/RepositoryScopeChangeTests.swift`. |

P2/P3 items (~30 more) live only in the archive report; surface to OPEN_ITEMS only when promoted by a fix prompt or new evidence.

## 2026-05-07 Hostile QA on Notification Orchestrator — New Findings

Hostile QA report: `docs/archive/2026-05/secretary-notification-orchestrator/hostile-qa-report.md`
Verdict: **SOURCE REMEDIATION COMPLETE FOR HOSTILE P0/P1 CLUSTER** on `feature/secretary-notification-orchestrator`; original hostile verdict was **NOT_READY** until the P0/P1 cluster closed.
Scope: 5 specialist Opus subagents in parallel; independent vitest run 37/37 passed; manual probes.

### P0 NEW

| ID | Area | Description |
|---|---|---|
| HOSTILE-POLICY-1 | notif policy | `quietHoursPolicy: 'send_now'` bypass hardened. CLOSED IN SOURCE BRANCH via `29ceb44f`; `send_now` is trusted only for security/system urgent paths and otherwise delays through quiet-hours logic. Behavioral coverage added in `__tests__/services/notification-orchestrator.test.ts`. |
| HOSTILE-PORTAL-1 | portal | Missing portal scope no longer falls back to all tenants. CLOSED IN SOURCE BRANCH via `3d66339b`; notification portal routes require admin token plus explicit user/tenant scope and return 400 on first-paint empty scope. |
| HOSTILE-PORTAL-2 | portal | Legacy content notifications are now scoped. CLOSED IN SOURCE BRANCH via `3d66339b`; `getAllNotifications(limit, scope)` requires validated user/tenant scope and portal tests pin no cross-tenant blend. |
| HOSTILE-PRIVACY-1 | privacy | Lock-screen body redaction now defaults safe. CLOSED IN SOURCE BRANCH via `8b79faaa`; `sensitiveBody` is persisted/read for authenticated detail and standard/security bodies no longer expose raw content. |
| P0-IOS-NOTIF-1 + HOSTILE-BACKEND-1 | iOS+auth lifecycle | Orphan notification tokens closed. CLOSED IN SOURCE BRANCH via backend `b50cc162` and iOS `f7a940b`; logout/logout-all revoke `notification_device_tokens`, and iOS signOut DELETEs the registered token before local reset. |
| P0-IOS-NOTIF-2 | iOS APNs entitlement | Time-sensitive support is no longer UI-only. CLOSED IN SOURCE BRANCH via engine `29ceb44f` and iOS `f7a940b`; APNs payload includes `interruption-level`, local reminders set interruption level, and debug/release entitlements include `com.apple.developer.usernotifications.time-sensitive`. |
| P0-IOS-NOTIF-3 | iOS test confidence | Decision action UI test is no longer fixture-only. CLOSED IN SOURCE BRANCH via iOS `d55367f`; the UI test launches against a local HTTP stub and verifies the action POST reaches `/api/v1/notifications/:id/actions`. |

### P1 NEW

| ID | Area | Description |
|---|---|---|
| HOSTILE-POLICY-2 | notif policy | Equal quiet-hours bounds are rejected. CLOSED IN SOURCE BRANCH via `29ceb44f`; `updateNotificationProfile` throws when `quietHours.start === quietHours.end`. |
| HOSTILE-POLICY-3 | privacy | `public` no longer bypasses per-skill scrubs. CLOSED IN SOURCE BRANCH via `8b79faaa`; finance/training/content/security redaction branches win before any raw-public body path. |
| HOSTILE-POLICY-4 | digest | Digest release now groups due passive items. CLOSED IN SOURCE BRANCH via `29ceb44f`; `assembleDailyDigest` emits one digest attempt for grouped rows. |
| HOSTILE-POLICY-5 | spam | Push rate limiting added. CLOSED IN SOURCE BRANCH via `29ceb44f`; excess active pushes become in-app-only with a decision-log reason instead of spamming APNs. |
| HOSTILE-POLICY-6 | APNs | APNs `interruption-level` support added. CLOSED IN SOURCE BRANCH via `29ceb44f` plus iOS `f7a940b`; backend, local notifications, and entitlement tests cover the contract. |
| HOSTILE-POLICY-7 | cross-skill | Cooking and Finance now have production intent emission paths. CLOSED IN SOURCE BRANCH via `29ceb44f`; meal-prep scheduling and tax due calculation emit orchestrated intents without direct push delivery. |
| HOSTILE-PRIVACY-2 | security | Security defaults are sensitive. CLOSED IN SOURCE BRANCH via `8b79faaa`; security lock-screen copy routes through the sensitive safe-title branch. |
| HOSTILE-PORTAL-3 | portal scope | Notification portal routes require admin token. CLOSED IN SOURCE BRANCH via `3d66339b`; read-token-only access is rejected. |
| P1-IOS-NOTIF-4 | iOS lifecycle | Queued notification actions now persist until consumed. CLOSED IN SOURCE BRANCH via iOS `676b7ed`; `DeepLinkRouter` restores pending action IDs from `UserDefaults` and clears them after matching consumption. |
| P1-IOS-NOTIF-5 | iOS scope guard | Decision Center load is scope-key guarded. CLOSED IN SOURCE BRANCH via iOS `f7a940b`; stale async responses after signOut/account switch are dropped. |
| P1-IOS-NOTIF-6 | iOS contract | Notification ID contract is standardized around string `itemId` while tolerating legacy numeric payloads. CLOSED IN SOURCE BRANCH via iOS `f814541` and existing router coverage; local notification payloads include both string `notificationId` and `itemId`. |

### Test-quality findings

- `__tests__/security/notification-orchestrator-security.test.ts`: CLOSED IN SOURCE BRANCH via `0a51d881`; replaced source-grep checks with behavior-bearing SQLite/route tests.
- `__tests__/portal/portal-notifications-ui.test.ts`: CLOSED IN SOURCE BRANCH via `0a51d881`; portal notification reads now exercise admin/scope behavior and safe serialization.
- `Nexus HubTests/NotificationDecisionCenterTests.swift`: CLOSED IN SOURCE BRANCH via iOS `f814541`; source-grep cases were replaced with DTO/action contract tests.
- `Nexus HubUITests/NotificationDecisionCenterUITests.swift`: CLOSED IN SOURCE BRANCH via iOS `d55367f`; added a non-fixture local-backend action round-trip UI test.

### Override notes

- **GAP-PORT-3** hostile downgrade is now CLOSED AGAIN IN SOURCE BRANCH via `3d66339b`; both empty route scope and legacy notification-array bypasses have behavioral tests.
- **GAP-SEC-NOTIF-3** hostile privacy downgrade is now CLOSED AGAIN IN SOURCE BRANCH via `8b79faaa`; `sensitive_body` is stored, mapped, serialized only where safe, and lock-screen bodies redact by default.

Codex remediation prompt: `docs/archive/2026-05/secretary-notification-orchestrator/notification-orchestrator-codex-remediation-prompt.md`.


## 2026-05-08 Hostile QA on Chat Reasoning Engine v1

Branch: `feature/chat-reasoning-engine-v1` (engine commit `6e2f27d3`, on top of `main` `5373398c` / 4.14.138).

Backup tag: `backup/chat-reasoning-before-v1-20260507-2330`.

Verdict: **READY_WITH_CONDITIONS** after Codex remediation on `feature/chat-reasoning-engine-v1`. Exact Prozis acceptance case works end to end, and the hostile P0/P1 source blockers listed below are closed locally. Do not promote to staging/production until the branch is merged deliberately and the normal deploy gates run.

Report: `docs/archive/2026-05/chat-reasoning-engine-v1/hostile-qa-report.md`.

Verification reproduced (read-only):
- `npx tsc --noEmit`: PASS.
- Focused suite: 3 files / 64 tests PASS (`__tests__/services/chat-reasoning-engine.test.ts`, `__tests__/api/chat-routes.test.ts`, `__tests__/services/task-store/task-router.test.ts`).
- P0 chat identity isolation: 23/23 PASS.
- Native task route regression: 25/25 PASS.
- `vi-mock-completeness-lint --strict`: exit 0 (warnings about new `assertNoUnexpectedMigrationPrefixCollisions` mock key are non-fatal).
- `cannot-skip-gate-dashboard.sh --json --no-evidence`: 23/23 PASS.
- `npm run docs:audit`: 443 files / 469 issues (+2 drift from Codex's 467 due to stale workspace mirror; under 480 ceiling).

### P0 NEW — CLOSED IN SOURCE BRANCH

| ID | File / line | Description |
|---|---|---|
| F-EXEC-1 | `src/services/chat-reasoning-engine.ts` | CLOSED locally. Reusable action-plan lookup now includes `executing`; task refs are persisted immediately after parent creation; retries with a saved task ref resume missing subtasks without calling `createTask`; retries without a task ref fail closed as in-progress instead of duplicating. |
| F-PARSE-3 | `src/services/chat-reasoning-engine.ts` | CLOSED locally. Targeted destructive commands on task/event/calendar nouns now route to confirmation-required before any skill/model execution. |
| F-PARSE-4 | `src/services/chat-reasoning-engine.ts` | CLOSED locally. Task messages joined with a second action verb now fail closed as multi-step clarification instead of flattening reminders/schedules/cancels into subtasks. |

### P1 NEW — CLOSED / DEFERRED HONESTLY IN SOURCE BRANCH

| ID | File / line | Description |
|---|---|---|
| F-EXEC-2 | `src/services/chat-reasoning-engine.ts` | CLOSED locally. Plain `create_task` now executes through the deterministic task provider and verifies read-back. |
| F-ARCH-1 | `migrations/116_chat_reasoning_engine_v1.sql` | CLOSED by removing the writerless `chat_correction_events` table from v1. Repair/correction remains a documented future slice rather than dead DDL. |
| F-ARCH-2 | `src/config.ts` | CLOSED by removing unused `chatActionLabel/Plan/Repair/Clarify` config. Model-graded labelling remains deferred until a real call site ships. |
| F-PARSE-1 / F-PARSE-7 / F-PARSE-9 / F-PARSE-10 / F-PARSE-11 / F-PARSE-12 / F-PARSE-13 / F-PARSE-15 | `src/services/chat-reasoning-engine.ts` | CLOSED locally with regression coverage: discourse phrases are stripped before splitting, title/subtask caps are enforced, PT implicit-subtask and Spanish explicit-subtask cases parse, mixed quotes survive, bare checklist syntax parses, multi-recipient updates ask clarification, and bulk plural/count forms no longer collapse into one task. |

### P2/P3 — CLOSED OR LEFT AS EXPLICIT FOLLOW-UP

Closed locally: `F-CTX-1` tenant fallback removed; `F-TEST-1` cross-tenant action-plan scope covered; `F-ARCH-3` stale-plan expiry utility added and then wired to the scheduler; `F-ARCH-4` recursive identity stripping added; `F-EXEC-3` null task read-back no longer verifies; `F-EXEC-4` partial/in-progress plans resume missing subtasks; `F-PARSE-2/5/6/8/14` covered by parser hardening where applicable. Remaining follow-up: `F-ARCH-5` model confidence remains future-only because v1 is intentionally deterministic.

### Path back to READY

Secretary task/subtask vertical slice is now appropriate for hostile re-QA. iOS result-card rendering, full undo/repair, model-graded labelling, and broader cross-skill execution remain explicit follow-ups.


## 2026-05-08 Hostile QA v2 on Chat Reasoning Engine v1 — Closure verdict

Branch: `feature/chat-reasoning-engine-v1` at remediation commit `1d2e6d22`.

Verdict: **READY_FOR_LOCAL_QA** after post-v2 Codex remediation. Prior NOT_READY blockers are closed behaviorally, and the v2 F-EXEC-6 retry verifier gap is closed locally.

Report: `docs/archive/2026-05/chat-reasoning-engine-v1/hostile-qa-v2-final-report.md`.

Verification floor reproduced (read-only):
- `npx tsc --noEmit`: PASS.
- Full focused suite: 6 files / **122 tests** PASS (up from 64 in the prior round). New surface: 6 tests in `chat-reasoning-engine.test.ts` + 4 in the brand-new `chat-reasoning-engine-persistence.test.ts` (real-DB sqlite + manually-inserted `'executing'` rows + cross-tenant scope + expiry sweep).
- P0 chat identity isolation: 23/23 PASS.
- Native task route regression: 25/25 PASS.
- `vi-mock-completeness-lint --strict`: exit 0.
- `cannot-skip-gate-dashboard.sh`: 23/23 PASS.
- `npm run docs:audit`: 444 files / 469 issues during hostile v2 (under 480 ceiling; +2 workspace-mirror-stale carryover). Post-v2 remediation reruns the mirror before commit.

### Independent confirmation of CLOSED locally claims

All P0 (F-EXEC-1, F-PARSE-3, F-PARSE-4) confirmed CLOSED with real behavioural evidence:
- F-EXEC-1: `findReusablePlan` filter now includes `'executing'`; `replayOrResumeTaskWithSubtasks` reads `created_entity_refs_json`, computes missing subtasks via verifier, and re-adds only missing items. Persistence test "resumes an executing action plan without creating a duplicate provider task" asserts `provider.createTask` NOT called and `addChecklistItem` called for 2 missing items.
- F-PARSE-3: Three new patterns (`DESTRUCTIVE_VERBS`/`DESTRUCTIVE_OBJECT_TARGETS`/`DESTRUCTIVE_SWEEP_TARGETS`) and `isDestructiveIntent` helper. "Delete the Prozis task", "Cancel my 9am meeting", "Apaga a tarefa Prozis" all → `'high_risk_preview'`.
- F-PARSE-4: `MULTI_STEP_SECOND_ACTION` regex + `hasMultiStepActionIntent` helper, gated BEFORE `TASK_CREATE_PATTERNS`. Multi-step messages return `needs_clarification` with `multi_step_action_requires_preview`.

All P1 (F-EXEC-2, F-ARCH-1, F-ARCH-2, F-PARSE-1/7/9/10/11/12/13/15) confirmed CLOSED:
- F-ARCH-1 / F-ARCH-2 closed by REMOVAL (correct call — DDL/config without callers is worse than absence).
- All parser P1 closed by behavioral test fixtures.
- F-EXEC-2 closed with new `executeCreateTask` executor that creates the plain task via `provider.createTask` and verifies read-back.

All P2 from prior round (F-CTX-1, F-TEST-1, F-ARCH-3, F-ARCH-4, F-EXEC-3, F-EXEC-4) confirmed CLOSED:
- F-CTX-1 escalated from "fallback" to "throw `chat_reasoning_missing_authenticated_tenant`".
- F-TEST-1 closed with explicit "scopes action-plan idempotency by tenant and user" test using same userId + same sourceMessageId + different tenantId.
- F-ARCH-3 closed with exported `expireStaleChatActionPlans()`. Note: function exists; scheduler/cron wiring is a P3 follow-up.
- F-ARCH-4 closed with recursive `containsAuthoritativeIdentityField` and `stripAuthoritativeIdentityFields` over arrays + nested objects, applied to `entities` and `steps[*].entities`.
- F-EXEC-3 closed with explicit `task_read_back_unavailable` warning.
- F-EXEC-4 closed via `replayOrResumeTaskWithSubtasks`; F-EXEC-6 below closes the verifier-blind edge in that same path.

### New P1 from this re-QA pass — CLOSED LOCALLY

| ID | File / line | Description |
|---|---|---|
| F-EXEC-6 | `src/services/chat-reasoning-engine.ts` + `__tests__/services/chat-reasoning-engine-persistence.test.ts` | CLOSED locally. `verifyTaskWithSubtasks` now marks verifier-blind state when both task and checklist read-back are unavailable, returns no guessed missing subtasks, and `replayOrResumeTaskWithSubtasks` bails to `in_progress` without calling `addChecklistItem`. Regression test manually seeds an `executing` plan with a saved task ref, makes both provider read-backs fail, and asserts zero duplicate task/subtask writes. |

### P3 follow-ups (cosmetic, not blocking)

- **F-EXEC-5** (carryover) — CLOSED locally. Action-plan creation now uses atomic `INSERT OR IGNORE` claim semantics; a duplicate/concurrent claimant receives `chat_action_in_progress` before resolving lists or touching provider state. Regression test seeds an already-claimed plan and asserts zero provider writes.
- **F-ARCH-3 follow-up** — CLOSED locally. `expireStaleChatActionPlans` now runs through the scheduler as `chat_action_plan_expiry` on an hourly cadence, with a no-op skip test.
- **F-DOCS-1** (carryover) — CLOSED locally by rerunning `bash scripts/workspace-docs-mirror.sh` after the post-v2 remediation docs update.
- **F-PROCESS-1** (NEW) — CLOSED locally by tagging the remediation line with `backup/chat-reasoning-after-v1-remediation-20260508-0919`.

### Path to TestFlight

1. iOS structured chat-result card pass — CLOSED locally on `feature/chat-reasoning-engine-v1`. The app now decodes `metadata.subtasks`, `metadata.actions`, `metadata.actionPlanId`, `metadata.idempotentReplay`, and `routeMethod: 'chat-reasoning-engine'`, renders the task/subtask card, and exposes View/Add-more actions without faking backend mutations.
2. Existing operator-only gates: signed TestFlight + APNs + two-account walkthrough on a real device.


## 2026-05-08 Hostile QA v3 on Chat Reasoning Engine v1 — Final closure verdict

Branch: `feature/chat-reasoning-engine-v1`. Engine HEAD `d6d010e2` (commits since v2: `e7416c0b` F-EXEC-6 fix, `373a9a79` F-EXEC-5 + scheduler, `d6d010e2` docs). iOS HEAD `955eedb` (NEW iOS chat-reasoning card surface).

Verdict: **READY_FOR_LOCAL_QA**. All v2 P1 + P3 follow-ups closed with strong behavioral evidence. One new P2 iOS polish gap (F-IOS-1) and one carryover P3 docs hygiene (F-DOCS-1). Zero P0, zero P1, zero regressions.

Report: `docs/archive/2026-05/chat-reasoning-engine-v1/hostile-qa-v3-final-report.md`.

### Independent verification of v2 closures (all behaviorally re-confirmed)

- **F-EXEC-6** — verifier-blind retry duplication. CLOSED via `verifyTaskWithSubtasks` returning `verificationBlind: true` when both `getTask` and `getChecklistItems` fail; `replayOrResumeTaskWithSubtasks` short-circuits to `'in_progress'` with `reason: 'verification_blind'` BEFORE attempting any subtask retry. Persistence test asserts `provider.createTask` AND `provider.addChecklistItem` BOTH NOT called when both reads fail.
- **F-EXEC-5** — concurrent retry race. CLOSED via atomic `INSERT OR IGNORE` + new `claimActionPlan` helper. Failed claims return `acquired: false` with the existing row's status; executors return `'in_progress'` with `reason: 'action_plan_already_claimed'` instead of throwing UNIQUE 500. Persistence test asserts the entire provider call chain stays untouched.
- **F-ARCH-3 follow-up** — `expireStaleChatActionPlans` is now wired into the scheduler as `chat_action_plan_expiry` on `15 * * * *` (hourly). Logs only when expirations occur. Scheduler test asserts the cron entry exists and short-circuits cleanly.
- **F-PROCESS-1** — three new backup tags landed: `backup/chat-reasoning-after-v1-remediation-20260508-0919`, `backup/chat-reasoning-after-v1-v2-closure-20260508-0920`, `backup/chat-reasoning-after-v1-final-20260508-0830`.

### Verification floor reproduced (read-only)

- `npx tsc --noEmit`: PASS.
- Engine focused suite: 6 files / **131 tests** PASS (was 122 in v2, 64 in v1; net +9 from v2, +67 from v1).
- `chat-reasoning-engine-persistence.test.ts`: 6/6 PASS (was 4 in v2). New: F-EXEC-6 verifier-blind test + F-EXEC-5 already-claimed test.
- `scheduler-user-scope.test.ts`: 14/14 PASS, includes the new chat-action-plan-expiry test.
- P0 chat identity isolation: 23/23.
- Tasks routes regression: 25/25.
- `vi-mock-completeness-lint --strict`: exit 0.
- `cannot-skip-gate-dashboard.sh`: 23/23.
- `npm run docs:audit`: 445 files / 469 issues (under 480 ceiling; +2 `workspace-mirror-stale` carryover on `release-identity.{json,md}`).

### NEW finding from v3 round

| ID | File / line | Description |
|---|---|---|
| F-IOS-1 | `Nexus Hub/Views/Chat/StructuredCards.swift:41-59` | The iOS card switch only handles `task_created` / `task_completed`. The 5 other `chat_action_*` types the engine emits (`chat_action_in_progress`, `chat_action_clarification_required`, `chat_action_confirmation_required`, `chat_action_execution_failed`, `chat_action_deferred`) all fall through to `unknownTypeInline` which renders a generic gray "Structured response" placeholder card. The `response.text` is rendered correctly in the bubble; only the card below is unhelpful. **Recommendation**: add the 5 types to the silent `EmptyView()` list (one-line fix) OR render small status badges per type. ~10 lines + 5 small rendering tests. **Severity**: P2 polish before signed TestFlight, not a blocker for local QA. |

### Pending actions (TL;DR)

| Owner | Action | Severity | ETA |
|---|---|---|---|
| Codex (or Claude) | F-IOS-1 — add the 5 `chat_action_*` types to the iOS card switch | P2 | <30 min |
| Felipe (operator) | F-DOCS-1 — run `engine/scripts/workspace-docs-mirror.sh` to converge `+2 release-identity` drift | P3 | 1 command |
| Felipe (operator) | iOS xcodebuild simulator run for new chat-reasoning card tests (`ChatRichStateDecodingTests` + `ChatStructuredCardRenderingTests`) | operator-only | ~15 min |
| Felipe (operator) | Signed TestFlight + two-account walkthrough on physical device | operator-only | requires APNs creds |

### Lower-priority follow-ups

- **F-IOS-2** (P3) — `view_task` deep-link does not pass `taskId`/`listId`; user lands on Tasks tab list, not the specific task. Track as Tasks-tab follow-up.
- **F-IOS-3** (P3) — "undo" action button is plumbed in iOS but the engine never emits `'undo'` in the actions array (manifest declares `undoSupported: false`). Dead code path; remove from `MetadataTaskAction` until a real undo endpoint ships.

After F-IOS-1 closes, this slice is ready for the existing operator-only TestFlight + APNs + two-account gates that apply to every 2026-05 workstream.


## 2026-05-08 Hostile QA v4 — F-IOS-1 + F-DOCS-1 final closure

Both v3 carryovers verified CLOSED behaviorally on `main`. Engine `1f7862aa`, iOS `fb63527e`, both aligned with `origin/main`, both working trees clean. Production at backend `4.14.140`.

### F-IOS-1 — CLOSED

- Source contract: `Nexus Hub IOS/Nexus Hub/Nexus Hub/Views/Chat/StructuredCards.swift` declares `static let silentMetadataTypes: Set<String>` (line 9-25) containing all 5 chat_action_* types: `chat_action_in_progress`, `chat_action_clarification_required`, `chat_action_confirmation_required`, `chat_action_execution_failed`, `chat_action_deferred`.
- Switch routing: line 71 `case let type where Self.silentMetadataTypes.contains(type): EmptyView()` matches BEFORE the `default → unknownTypeInline(type)` case, so Swift's top-down evaluation guarantees these types render as silent EmptyView, not the generic placeholder.
- Behavioral test: `Nexus HubTests/ChatStructuredCardRenderingTests.swift:163` `test_chatActionMetadataTypesAreKnownSilentCards` iterates the 5 types, asserts membership AND renders each via the helper that asserts non-zero hosting-controller layout.
- Test execution: `xcodebuild test … -only-testing:Nexus HubTests/ChatStructuredCardRenderingTests` on simulator `A0B13967-B5DE-4E6F-897D-F1E409093F94` (after a clean simulator erase) → **7 tests, 0 failures, 0.127s**. Simulator shut down afterward; no booted devices remaining; no orphan xcodebuild processes.

### F-DOCS-1 — CLOSED

- `engine/scripts/workspace-docs-mirror.sh --check` returns `workspace-docs-mirror: in sync` with exit 0.
- `npm run docs:audit` now reports **446 markdown files / 467 issues** (down from 469; the `workspace-mirror-stale: 2` entries on `release-identity.{json,md}` are gone). Under 480 ceiling.

### Cleanup

- Engine HEAD `1f7862aa`, iOS HEAD `fb63527e`, both clean working trees.
- Simulator `A0B13967` shut down via `xcrun simctl shutdown`; `xcrun simctl list devices booted` empty.
- No orphan `xcodebuild test` processes.
- No deploy / push / rebase / amend / force-push performed.

### Final verdict

**READY for the next operator-only gates** (signed TestFlight + APNs + two-account walkthrough on physical device). All Codex-closable items in the chat-reasoning workstream are now behaviorally closed.

The minor follow-ups (F-IOS-2 deep-link taskId/listId, F-IOS-3 dead "undo" code path) are P3 polish, not blockers.


## 2026-05-08 APNs operational verification — CLOSED

APNs end-to-end push delivery is operationally verified on production. The "APNs validation" carryover under Operator-Only Carryovers is closed for backend wire-up; remaining is signed TestFlight + device walkthrough for cohort onboarding.

Runbook: `docs/release/apns-runbook.md`.

### Pre-existing config (no new portal work)

- Apple Developer Auth Key already exists: Key ID `4QU52CCBPM` (created 2026-04-10 19:04 by Felipe). Service: APNs, team scoped, sandbox + production. The `.p8` file is at `~/Library/Mobile Documents/com~apple~CloudDocs/Dev/Nexus Hub/certificates/AuthKey_4QU52CCBPM.p8` on Felipe's Mac and at `/home/dominguez/secrets/AuthKey_4QU52CCBPM.p8` (mode 600) on production.
- Production `~/telegram-hub-bot/.env` already has all 5 APNs keys set: `APNS_ENABLED=true`, `APNS_TEAM_ID=B6885R8NWM`, `APNS_KEY_ID=4QU52CCBPM`, `APNS_AUTH_KEY_P8` pointing at the server `.p8`, `APNS_BUNDLE_ID=me.nexushub.app`, `APNS_ENVIRONMENT=sandbox`.
- iOS app has the right entitlements: `aps-environment=development` (Debug) and `aps-environment=production` (Release), plus `time-sensitive`.

### End-to-end smoke (2026-05-08)

Sent a real push to user 25 (Felipe) via `node scripts/apns-smoke.mjs --user 25`:
- Endpoint: `api.sandbox.push.apple.com`
- Topic: `me.nexushub.app`
- Result: **HTTP 200**, Apple `apns-id=52E648D4-D3ED-D5D4-1189-6341FFF9F105`
- JWT: ES256, kid=`4QU52CCBPM`, signed cleanly (200 chars)

This proves: backend env loaded, `.p8` readable, JWT signing healthy, Apple Push endpoint reachable, topic + bundle ID accepted, auth accepted, sandbox environment matches existing tokens.

### New helpers landed in this round

- `engine/scripts/apns-smoke.mjs` — diagnostic CLI with `--check` (no network), `--list` (token inventory), `--user <id> [--dry-run] [--message ...]` (real send). Reads `.env` directly so it works inside an SSH session without the engine running. Never prints `.p8`, push tokens, or signed JWTs.
- `engine/.env.example` — APNs section added with all 6 keys documented inline.
- `docs/release/apns-runbook.md` — workspace-canonical runbook covering current state, sandbox/production switching, rotation procedure, common gotchas. Mirror in sync.

### Production endpoint flip + device-verified push delivery (2026-05-08 13:30)

After Felipe reinstalled the app on his physical iPhone via TestFlight Release build:

1. **iOS auth-only**: 3 fresh device rows landed (IDs 244, 246, 247) but all had `push_token = NULL` because the app deliberately does NOT auto-prompt for notification permission at launch (Apple HIG compliance, see `Nexus Hub/Core/NotificationManager.swift:151`).
2. **Felipe enabled notifications via Settings tab** → app called `registerForRemoteNotifications` → fresh token uploaded (row 247, token_len=64 — standard 32-byte hex, much cleaner than the old row 114's anomalous 160 chars).
3. **First smoke push on sandbox endpoint returned `BadDeviceToken`** — confirming the new token came from a Release/TestFlight build (production entitlement) and the backend was misaligned at `APNS_ENVIRONMENT=sandbox`.
4. **Flipped `APNS_ENVIRONMENT=sandbox → production`** on `~/telegram-hub-bot/.env` (backup at `.env.bak.20260508-133036`, all other env values untouched), then `pm2 restart nexus-hub --update-env`.
5. **Re-verified config**: `node scripts/apns-smoke.mjs --check` → all green, environment now `production`.
6. **Re-sent smoke push**: `node scripts/apns-smoke.mjs --user 25` → **HTTP 200** from `api.push.apple.com`, Apple `apns-id=EF8A9B5A-0CD3-628A-5526-303FAA5B8901`. Felipe confirmed visually that the notification landed on iPhone.

### Two-account walkthrough still open

- Jaqueline's user 28 token (created 2026-04-18) has token_len=64; her last push from sandbox endpoint succeeded under the prior config. Now that the backend is on production, her token may also be a production token (TestFlight install) — should be retested via `apns-smoke.mjs --user 28` once Jaqueline has confirmed her install is also fresh. If her token was sandbox, it'll now reject with `BadDeviceToken` until she reinstalls via TestFlight too.
- Tenant-isolation device proof on Felipe + Jaqueline accounts (already validated via P0 chat-identity-isolation test suite at the API layer; device-side validation remains an operator gate).

### Final APNs state

| Field | Value |
|---|---|
| `.p8` (Apple) | Auth Key `4QU52CCBPM`, sandbox + production scope |
| `.p8` (server) | `/home/dominguez/secrets/AuthKey_4QU52CCBPM.p8` (mode 600) |
| Engine env | `APNS_ENABLED=true`, `APNS_TEAM_ID=B6885R8NWM`, `APNS_KEY_ID=4QU52CCBPM`, `APNS_BUNDLE_ID=me.nexushub.app`, `APNS_AUTH_KEY_P8=/home/dominguez/secrets/AuthKey_4QU52CCBPM.p8`, `APNS_ENVIRONMENT=production` |
| pm2 nexus-hub | restart counter 430 (one clean restart at 13:30:36 to pick up production env) |
| Last verified delivery | apns-id `EF8A9B5A-0CD3-628A-5526-303FAA5B8901` to Felipe's iPhone (user 25, row 247) on 2026-05-08 13:31 — **device-side delivery confirmed by Felipe** |
| APNs gate status | **CLOSED on production**. Backend → Apple → device chain verified end-to-end. |


## 2026-05-08 Outlook token-cache performance remediation — STAGING READY

Closeout: `docs/archive/2026-05/perf-outlook-token-cache/closeout.md`.

Codex implemented the server-side Microsoft auth remediation on branch
`perf/outlook-token-cache-2026-05`:

- Per-user and owner Microsoft Graph access-token cache with 55-minute TTL.
- Per-user client-type memoization so iOS public-client refresh tokens skip the
  repeated confidential-client failure path after the first fallback.
- Cache invalidation on Outlook `storeTokens`, `disconnectProvider`, and
  `updateAccessToken`.
- Single-flight coalescing for concurrent cold misses.
- Additional Tasks working-set optimization: Microsoft To Do working-set reads
  no longer call `getAllPendingTasks()` and no longer refetch the default list's
  active page after building the active snapshot.

Validation:

- TypeScript: PASS.
- Microsoft auth focused tests: PASS, 11/11.
- Chat/task/identity regression suite: PASS, 119/119.
- Provider-routing safety suite: PASS, 19/19.
- Garmin passive-auth suite: PASS, 9/9.
- Strict mock lint: PASS at baseline 827.
- Cannot-skip gate dashboard: PASS, 23/23.
- Staging deploy: PASS; production untouched.
- Five-minute staging soak: PASS.
- Staging smoke: PASS, 17/17.

Evidence limit:

- Staging has no `user_oauth_tokens` rows for users 25 or 28, so staging could
  not prove live Outlook cache hit ratio. The cache behavior is covered
  hermetically in tests; production log verification remains required after
  merge/deploy.
- Physical iPhone device logs were not captured because this macOS `/usr/bin/log`
  does not support `--device`, and `xcrun devicectl` on this host exposes no
  device log streaming command.

Remaining follow-ups:

- **Operator**: merge/review and deploy to production when ready; then verify
  production PM2 logs show the Microsoft public-client warning at most once per
  cache key/hour and `microsoft_auth_token_cache_summary` reports >90% hit
  ratio after warm-up.
- **Codex/iOS follow-up (P2)**: move `TaskRepository` fetch/decode work off
  `@MainActor`; keep only final state assignment on main.
- **Codex/backend follow-up (P2)**: add JSON compression for large app-facing
  API responses with tests.


## 2026-05-08 v4.14.141 production promote — Outlook token cache + APNs unblock

Engine `main` advanced from `1f7862aa` (v4.14.140) to `9f551b73` (v4.14.141, auto-bumped by `deploy.sh`). Production tag `v4.14.141-prod-20260508-1358` published to origin. iOS unchanged at `fb63527e`.

Backup tags created:
- `backup/main-before-perf-outlook-merge-20260508-1444` (pre-merge baseline)
- `backup/perf-outlook-token-cache-before-20260508-1353` (Codex pre-remediation)

### Deploy procedure executed

1. Fast-forward merge `perf/outlook-token-cache-2026-05` → `main` (6 commits): `d57f9368` APNs carryover, `9a1b8d08` Microsoft auth cache + memoization, `9fd80359` regression tests, `bbc4648d` working-set duplicate-read fix, `f7ecff88` strict mock cleanup, `a1e34fe1` staging evidence.
2. `git push origin main` — pre-push hooks PASS, 3/3 required status checks.
3. `./scripts/deploy-staging.sh` — staging redeployed at `a1e34fe1`, health checks ✓.
4. `./scripts/staging-smoke.sh` — **17/17 PASS**, evidence at `engine/docs/release/smoke-evidence/staging-smoke-a1e34fe1-20260508T134929Z.json`.
5. `./scripts/promote-to-prod.sh` — re-ran staging gate (17/17 PASS again at `T135001Z`), then `deploy.sh` auto-bumped package.json to `4.14.141` and committed `9f551b73`. Production PM2 nexus-hub PID 209410 → 258309 (clean restart).
6. Production `/health` immediately healthy: db connected, services online, RSS 323 MB.
7. Production `/api/snapshot`: `version=4.14.141`.
8. New code verified live on production: `grep accessTokenCache | microsoft_auth_token_cache_summary | invalidateMicrosoftAccessTokenCacheForUser` returns 13 source hits + 14 dist hits on the running production install.

### Post-deploy observability targets (operator-only verification)

1. PM2 logs `microsoft_auth_token_cache_summary` info-level lines should appear every 5 min once cache traffic warms. Target: hit ratio >90%.
2. `Microsoft refresh token requires public-client MSAL flow` warning should fire AT MOST ONCE per (cacheKey, hour) instead of every 5 min as before.
3. Felipe's iPhone Tasks/Home navigation — reduced p95 on `/api/v1/tasks/working-set`, `/api/v1/plan/today`, `/api/v1/plan/week` (target: 21s → ~3-5s).

### Pre-existing tech-debt unchanged by this deploy

- 403 ForbiddenException stderr noise (separate integration issue, predates this deploy).
- Two workspace-mirror-stale entries on `release-identity.{json,md}` (timestamp drift artifact of the generator script).

### Remaining follow-ups (not blocked by this deploy)

- iOS @MainActor pressure in `TaskRepository` (P2 deferred per perf closeout).
- iOS URLSession per-host concurrency governor (P2 deferred).
- Express API gzip compression (P2 deferred).
- F-MSAUTH-1 (P3) — race between in-flight acquisition and `storeTokens` invalidation can cache a just-replaced access token for up to 55 min. Generation-counter fix recommended.
- Two-account walkthrough on physical devices for closed-beta cohort onboarding (operator-physical).


## 2026-05-08 cache/compression/iOS conditional-read batch — staged, production not promoted

Codex completed the `perf/cache-and-compression-2026-05` batch after the
Outlook token cache deploy showed residual UI lag. The branch is staged and
smoke-tested, but production was not promoted in this batch.

Closeout:
`docs/archive/2026-05/perf-cache-and-compression/closeout.md`

Implemented:

- SWR + stable ETag handling for `/api/v1/plan/today` and `/api/v1/plan/week`.
- SWR upgrade for connected-calendar `/api/v1/calendar/events` and
  `/api/v1/calendar/today`.
- Gzip compression middleware for large app-facing JSON responses.
- Stable data-only conditional response helper shared by dashboard, plan,
  calendar, and content routes.
- Microsoft auth generation counter for in-flight invalidation safety.
- iOS repository-level conditional reads for Tasks, Plan, Calendar, Dashboard,
  and Content.
- Extra hostile-review fix: `/api/v1/content/home` now has SWR/ETag support and
  iOS conditional reads.

Validation:

- Backend typecheck and focused regression suite: PASS.
- Full vitest commit-hook suite: PASS.
- Strict mock lint: PASS at baseline 827.
- Cannot-skip dashboard: PASS, 23/23.
- iOS focused build and conditional-read tests: PASS on one simulator UDID.
- Staging deploy: PASS.
- Five-minute staging soak: PASS.
- Staging smoke: PASS, evidence at
  `engine/docs/release/smoke-evidence/staging-smoke-6c3d509d-20260508T154251Z.json`.
- Staging timing probe: Plan, Dashboard, Dashboard Home, and Content Home
  returned conditional 304 responses in low single-digit milliseconds after
  warm-up.
- Compression probe: `/api/v1/plan/week` returned gzip and reduced wire bytes
  by roughly 84%.

Remaining follow-ups:

- **Operator**: merge/review and promote when ready; production was
  intentionally untouched.
- **Operator**: verify connected-calendar SWR on production because staging
  user 25 lacks a connected calendar.
- **Codex P2**: add an iOS request coalescer/governor if Felipe still sees
  cold-launch fan-out stalls after this batch lands in TestFlight.
- **Codex P3**: extend repository-level conditional reads to lower-frequency
  repositories when their routes expose stable ETags.


## 2026-05-08 closed-beta block fixes phase 1 — staged, production not promoted

Codex completed Phase 1 of the closed-beta blocker batch on the existing
architecture branches. Production and `main` were intentionally untouched.

Closeout:
`docs/archive/2026-05/closed-beta-block-fixes/closeout.md`

Closed in this phase:

- Apple App Store Server Notification webhook now verifies both outer and inner
  JWS payloads before subscription mutation. Forged staging probe returned
  `{ handled: false, reason: "invalid signature" }`.
- `/api/v1/training/*` is now centrally entitlement-gated, and
  `/training/coach?refresh=true` uses the per-user daily AI cap/lock pattern.
  Free-tier staging probe returned `403 TIER_REQUIRED`.
- Nine target content-engine prompt builders now use per-request creator profile
  context with neutral fallback instead of founder-shaped defaults.
- Auth/onboarding iOS surfaces now expose stable accessibility identifiers and
  have six no-`NEXUS_SKIP_AUTH` XCUITests covering email auth, Apple retry,
  Google callback, account switch, and interrupted onboarding.
- Cannot-skip dashboard has three new blocker gates and now reports 26/26.

Validation:

- Backend typecheck: PASS.
- Focused backend security/API suite: PASS, 59 tests.
- Content-engine prompt-cleanliness/creative/core suite: PASS, 86 tests.
- Strict mock lint: PASS at baseline 827.
- Cannot-skip dashboard: PASS, 26/26.
- iOS auth/onboarding UI tests: PASS, 6 tests on simulator
  `A0B13967-B5DE-4E6F-897D-F1E409093F94`.
- Staging deploy: PASS.
- Five-minute staging soak: PASS.
- Staging smoke: PASS, 19/19 in the current script, evidence at
  `engine/docs/release/smoke-evidence/staging-smoke-da95f348-20260508T230237Z.json`.

New findings to carry forward:

- **P2**: `engine/src/services/video-study.ts` still hardcodes PT-BR
  title/hook/content-idea output. Migrate to creator-profile language/context.
- **P3**: `engine/src/services/channel-learner.ts` still frames advice for
  PT-BR fitness/commentary. Migrate to creator-profile niche/language context.
- **P3**: older iOS Training/Notification UI tests still use `NEXUS_SKIP_AUTH`.
  New auth/onboarding tests avoid it, but older critical flows should migrate
  as mock-server coverage expands.

Phase 2 carryovers from the blocker audit:

- Voice-evolution agent owner-only scope leak (P1).
- Global cost guardrail enforcement on iOS REST routes (P1).
- iOS repository read-cache plumbing toward one shared primitive (P1).
- WorkspaceStateView/resolver duplication cleanup (P1).
- API route boilerplate helper cleanup (P1).
- Cache-invalidator registry cleanup (P1).
- In-app bug-report channel (P1).
- iOS chat fastpath + Telegram fastpath duplication cleanup (P2).

Phase 3 / parked items:

- iOS URLSession governance and app-level request coalescer.
- Per-skill HomeViewState fallback-builder collapse.
- Apple notification + provider-client error preservation.
- OAuth token-cache event bus deletion.
- Scheduler cron registry extraction.
- KeychainHelper main-thread sync audit.
- DashboardViewModel timer leak audit.
- Onboarding race hardening beyond the new resume-step fix.
- TaskRepository, ContentService, TrainingViewModel size reductions.
- Onboarding monolith split.
- DashboardSheetCoordinator API cleanup.
- Domain wrapper cleanup.
- Audit-trail consolidation.
- Chat tool-dispatch consolidation.
- `/api/v1/internal/performance-summary` owner-only review.
- Python FastAPI loopback auth hardening.
- Python orchestrator singleton cleanup.
- FastAPI route tests.
- ResearchOrchestrator `deep_search` decomposition.

## 2026-05-09 Phase 2B.1 Workspace Landing State consolidation

Status: **READY_FOR_LOCAL_QA** after visual closure (hostile QA v3, 2026-05-09).

Visual QA evidence: 32 visual cells + 5 retry-interaction tests + 1 identifier-inventory contract, 38/38 PASS on simulator A0B13967-…. Screenshot attachments exported to `/tmp/phase2b1-visual-attachments-final/` and confirmed via xcresult `Test-Nexus Hub-2026.05.09_13-21-07-+0100.xcresult`.

Verdict reports:
- v2 (architecture + behavior parity): `docs/archive/2026-05/phase2b1-workspace-state-module/hostile-qa-v2-report.md`
- v3 (visual closure): `docs/archive/2026-05/phase2b1-workspace-state-module/hostile-qa-v3-visual-closure-report.md`

Closeouts:
- Original: `docs/archive/2026-05/phase2b1-workspace-state-module/closeout.md`
- Visual closure: `docs/archive/2026-05/phase2b1-workspace-state-module/visual-qa-closure-closeout.md`

Summary:

- Corrected the prompt baseline from 7 obsolete files to 6 real obsolete source
  files. `TrainingWorkspaceStateView.swift` did not exist.
- Deleted four shallow `*WorkspaceStateView.swift` wrappers and two resolver
  files.
- Added one shared `WorkspaceLandingState` module with the three-state model,
  per-domain presentation config, Tasks/Training resolver logic, and shared
  warmup/unavailable renderers.
- Migrated Tasks, Training, Cooking, Content, and Finance callers onto the
  shared module.
- App-source diff is net negative: 317 insertions / 319 deletions. Total diff
  including tests is positive because the old narrow resolver tests were
  replaced with broader shared-module coverage.

Validation:

- Focused workspace-state/source-pin suite passed: 14/14 selected tests on
  simulator `A0B13967-B5DE-4E6F-897D-F1E409093F94`.
- Selected auth/feedback UI smoke passed: 4/4 selected UI tests on the same
  simulator.
- Additional Training fixture smoke and tab-stress checks passed during the
  round.

Carry forward:

- Phase 2B.2 is the cache-invalidator registry workstream.
- P2 QA cleanup: `AppShellVisualSnapshotUITests` should adopt the
  `-NexusUITestMode YES` fixture pattern before full-target UI evidence is
  treated as release-grade.

## 2026-05-09 Phase 2B.2 Cache-invalidator registry

Status: **READY_FOR_HOSTILE_QA**.

Closeout: `docs/archive/2026-05/phase2b2-cache-invalidator-registry/closeout.md`

Summary:

- Consolidated 11 shallow `*-cache-invalidator.ts` services into one
  `CacheCoherenceRegistry`.
- Preserved the legacy invalidation graph with typed named events and
  compatibility facades.
- Deleted the 11 obsolete source files and four obsolete invalidator test files.
- Added a behavior-level registry suite that asserts exact event-to-cache-key
  fan-out.
- Added the `cache-coherence-registry` cannot-skip gate; dashboard now reports
  31/31.
- Removed the old `intelligence-bus` direct plan-prefix fallback so
  mesh-priority planning invalidation is registry-wired.

Validation:

- Typecheck: PASS.
- Registry suite: PASS, 15 tests.
- Focused migration suite: PASS, 214 tests.
- Registry-mock-touched suite: PASS, 376 tests.
- Cannot-skip dashboard: PASS, 31/31.
- Strict mock-completeness lint: PASS at 822 partial mocks, under baseline 827.
- Staging deploy: PASS; production untouched.
- Staging smoke: PASS, 21 passed / 0 failed / 23 total (2 skipped, neither
  implementation-related). Evidence:
  `engine/docs/release/smoke-evidence/staging-smoke-d1149c52-20260509T131735Z.json`.

Carry forward:

- Phase 2B.3 is API route helper consolidation.
- Read-cache key builders still live at read sites; decide in Phase 2B.3
  whether they belong in route helpers or a sibling cache-key module.

## 2026-05-09 Phase 2B.3 API route helper

Status: **READY_FOR_HOSTILE_QA**.

Closeout: `docs/archive/2026-05/phase2b3-api-route-helper/closeout.md`

Summary:

- Confirmed the current fit-for-helper scope is 6 route files, not the stale
  "16+" estimate.
- Added `cached-route-handler` for request-side SWR cache lookup, cache writes,
  stale refresh single-flight, tenant-scope delegation, and route cache-key
  construction.
- Added `provider-error-classifier` with the canonical stable task-provider
  error matrix.
- Migrated plan, calendar, content home, dashboard, notifications, and task
  list reads onto the helper.
- Documented non-fits instead of forcing them through the helper:
  task working-set budget/degraded fallback, dashboard warmers, and task
  warmers/list helper cache paths.
- Added the `cached-route-handler` cannot-skip gate; dashboard now reports
  32/32.

Validation:

- Typecheck: PASS.
- Focused helper + migrated routes: PASS, 107 tests.
- Prompt validation suite: PASS, 231 tests.
- Pre-commit focused suite: PASS, 434 tests.
- Cannot-skip dashboard: PASS, 32/32.
- Strict mock-completeness lint: PASS at 824 partial mocks, under baseline 827.
- Staging deploy: PASS; production untouched.
- Staging smoke: PASS, 21 passed / 0 failed / 23 total (2 skipped, neither
  implementation-related). Evidence:
  `engine/docs/release/smoke-evidence/staging-smoke-d884cc62-20260509T135559Z.json`.

Carry forward:

- Phase 2B.4 is the iOS Repository read-cache primitive and requires the
  visual QA protocol.
- Add a safe reusable authenticated staging fixture before the next
  route-pipeline manual-probe round.

## 2026-05-09 Staging fixture harness

Status: **READY_FOR_HOSTILE_QA**.

Closeout: `docs/archive/2026-05/staging-fixture-harness/closeout.md`
Runbook: `docs/runbooks/staging-fixture-harness.md`

Summary:

- Added a staging-only synthetic-user harness for seed → probe → cleanup.
- Added production refusal at three layers: hostname, `staging_fixture` JWT
  claim, and reserved synthetic user-id range `1000000-1099999`.
- Captured authenticated staging route-pipeline evidence for 13 `/api/v1`
  routes and cache-coherence evidence for cooking/calendar invalidation paths.
- Closed the Phase 2B.2 CC-2 and Phase 2B.3 authenticated manual-probe gaps via
  addenda in each archive directory.

Validation:

- Typecheck: PASS.
- Focused safety tests: PASS, 7/7.
- Pre-commit changed-area suites: PASS, 187 files / 2828 tests.
- Staging deploy: PASS; production untouched.
- Staging smoke: PASS, 21 passed / 0 failed / 23 total.
- Harness seed/probe/cleanup: PASS; post-cleanup reserved-range user count `0`.
- Production refusal: PASS, exit code 2.

Carry forward:

- Phase 2B is 4/5 done. Phase 2B.5 chat fastpath is deferred with source-side
  diagnosis preserved for a likely Phase 3 post-Wave-1 round.

## 2026-05-09 Phase 2B.4 iOS Repository read-cache primitive

Status: **READY_FOR_HOSTILE_QA**.

Closeout: `docs/archive/2026-05/phase2b4-ios-repository-primitive/closeout.md`
Visual manifest:
`docs/archive/2026-05/phase2b4-ios-repository-primitive/visual-matrix-manifest.md`

Summary:

- Added `CachedResource<Value>` as the shared iOS repository read-cache
  primitive for TTL freshness, stale-while-revalidate, in-flight coalescing,
  ETag/304 handling, scope invalidation, reset, and preview seeding.
- Migrated 13 repositories to compose the primitive while preserving their
  public APIs and keeping mutation/optimistic-update logic local.
- Added a repository cache-state visual audit host and an 80-cell visual matrix
  across 10 critical repository-consuming surfaces, 4 cache states, and 2
  locales.

Validation:

- Build: PASS on simulator `A0B13967-B5DE-4E6F-897D-F1E409093F94`.
- Full unit target: PASS, 1,280 XCTest tests / 0 failures plus 10 Swift
  Testing checks / 0 failures.
- Focused primitive/unit tests: PASS, 21/21; post-full-unit edge-case rerun
  PASS, 9/9.
- Repository visual matrix: PASS, 21 XCTest methods / 80 screenshot-bearing
  cells / 0 failures.
- Existing focused UI smoke: PASS, 42 UI tests / 0 failures
  (`AuthenticationFlowUITests`, `FeedbackFlowUITests`,
  `WorkspaceLandingVisualUITests`).

Carry forward:

- Phase 2B is 4/5 done. Phase 2B.5 chat fastpath is deferred with source-side
  diagnosis preserved for a likely Phase 3 post-Wave-1 round.


## Standing Authorizations

- `BATCH-24-CLOSEOUT-AUTHORIZED`: honored by Batch 24 U1/U2/U5.
- `BATCH-24-CLAUDE-MD-PRODUCTION-TRUTH-UPDATE-AUTHORIZED`: honored as staged
  text only at `docs/release/staged-claude-md-update-after-2026-05-deploy.md`;
  `CLAUDE.md` was not modified.
- `BATCH-24-OPEN-ITEMS-ROTATION-AUTHORIZED`: honored manually because
  `engine/scripts/rotate-open-items.mjs` was absent in the Batch 24 checkout.

## Operator-Only Carryovers

These require Felipe/operator action and are not Codex-closable without live
credentials, devices, or deployment authority.

- Push local `main` to `origin/main` after Felipe's merge review.
- Deploy staging and run staging smoke.
- Promote production and run production health.
- Signed TestFlight and two-account walkthrough.
- APNs validation.
- Secretary Notification Orchestrator APNs live-provider setup and physical-device
  push/action validation.
- Real Gmail/Outlook/Health provider-state checks.
- Non-prod Google/Outlook OAuth credentials provisioning.
- Garmin MFA/live-session validation, which remains the closure path for P2-35.
- Content portal smoke window.
- iOS fastlane setup, if Felipe chooses to pursue it.
- Self-hosted runner provisioning, only if SSH-only promote workflows require it.

## Authorization-Gated Codex Workstreams

These are Codex-addressable but remain deferred until Felipe explicitly
authorizes the next batch.

| Queue | Status | Notes |
|---|---|---|
| Batch 25 | pending authorization | Content lifecycle unification phase 1: audit and plan. |
| Batch 26 | pending authorization | Content lifecycle schema migration phase. |
| Batch 27 | pending authorization | Content lifecycle service/API migration phase. |
| Batch 28 | pending authorization | Content lifecycle iOS/Python contract and cleanup phase. |

## Evidence Gaps

- Batch 17 iOS P2 remediation report was not reconstructable in the Batch 24
  archive pass. Revalidation exists at
  `docs/archive/2026-05/tech-debt-validation/codex-batch-17-revalidation.md`.
- Batch 1 does not have a standalone remediation artifact; evidence is
  preserved in
  `docs/archive/2026-05/tech-debt-validation/codex-tech-debt-pass.md` and
  `docs/archive/2026-05/tech-debt-validation/codex-validation-matrix.md`.
