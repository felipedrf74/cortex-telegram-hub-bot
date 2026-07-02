# Agent Handoff — Training UX round: Phases 0-4 (release reconciliation, iOS navigation/hub, coach-trust surfacing, backend reads, gates)

## Session summary

**Started**: fresh session (plan approved by Felipe; plan file
`~/.claude/plans/you-are-claude-fable-cheeky-noodle.md`)
**Ended**: 2026-07-02 (afternoon)
**Repos**: engine `codex/Trainingfixes @ f0c3fc3e` (clean before session, docs-only
changes now); iOS `main @ 38b3bb5` (+ this session's uncommitted Phase-1 changes)
**Agent**: Claude Code (Fable 5)

## What shipped (all UNCOMMITTED — awaiting Felipe's explicit commit go)

### Phase 0 — release/docs reconciliation
- Verified production is on **4.14.211** by read-only SSH:
  `ssh dominguez@serverdominguez "node -p \"require('/home/dominguez/telegram-hub-bot/package.json').version\""`
  → `4.14.211`; PM2 pidfiles `nexus-hub-8.pid` + `content-engine-0.pid` present;
  public `/health` healthy (probes 12:01Z uptime 42m, 12:18Z 59m). GitHub release
  `v4.14.211` published 2026-07-02T11:21:07Z.
- `./scripts/release-identity.sh --persist` → release-identity now f0c3fc3e /
  4.14.211 / clean / 211 migrations (was 2026-06-26 stale, dead Codex worktree path).
- `docs/release/CURRENT_RELEASE_STATE.md` (workspace): new
  `### 2026-07-02 Training Remediation Production Promote` section + Backend
  paragraph updated to 4.14.211/f0c3fc3e; noted the missing persisted smoke-evidence
  JSON and the dry-run author identity as caveats.
- `engine/docs/release/CURRENT_RELEASE_STATE.md`: Active Production Release →
  f0c3fc3e / 4.14.211 + short dated section referencing the workspace doc.
- iOS specs refreshed: `ios-specs/00-CURRENT-PRODUCT-TRUTH.md` (runtime truth →
  4.14.211/f0c3fc3e, iOS 38b3bb5, zone IA noted) and
  `ios-specs/27-CLAUDE-CODE-HANDOVER.md` (release truth section rewritten).
- `docs/release/OPEN_ITEMS.md`: TR-REDESIGN-GATES moved to Recently Closed with
  per-blocker fix evidence; TRN-SKILL-E2E-VALIDATION updated (container lane
  authorized 2026-07-02); new rows TRN-REDFLAG-PRODUCER (product decision,
  dormant), TRN-DEADLETTER-VISIBILITY (conditional, this round),
  REL-EVIDENCE-PERSISTENCE, REL-DRYRUN-AUTHOR.
- iOS `docs/qa/work-orders/WO-training-redesign-q3-20260612.md`: closure addendum
  mapping every rerun-6 blocker to its fix commit; residual manual scope folded
  into this round's matrix.
- Workspace docs mirror refreshed (`./scripts/workspace-docs-mirror.sh`).

### Phase 1 — iOS navigation + read-only hub improvements
- **P1.1 Home tile readiness**: `DashboardSkillSnapshotPresentation.trainingSubline`
  appends "· Prontidão N / Readiness N" ONLY in `.ready` with a measured score;
  new `DashboardViewModel.measuredReadinessScore` (dashboard score is already
  backend-gated for estimated readiness; repo fallback gated by
  `hasMeasuredWearableData`); threaded through
  `DashboardSkillSnapshotDescriptorBuilder.training` + `DashboardView`.
- **P1.2 Deep-link zone routing**: new `Views/Training/TrainingRouteResolver.swift`
  (pure resolver: `plan.setup` → builder; `today|home` → Today; `session.<id>` →
  Plan + `PlanZoneDayAnchorRequest`; any other `plan.*` — incl. scheduler
  `nexus://training/plan/<planId>` deeplinks — → Plan zone; unknown → honest
  banner). `DeepLinkRouter` training session/plan URLs now route through
  `routeToSkillDestination` (dot-joined destination) while keeping `pendingDetail`
  for compat. `TrainingView.consumePendingTrainingRouteIfNeeded` switches on the
  resolver.
- **P1.3 Provider state in plan settings**: new
  `Views/Training/TrainingCalendarProviderStatusResolver.swift` (calendar-source ↔
  integration matching; single mapping locus — TrainingView's private mapper now
  delegates); `TrainingPlanSettingsSheet` gained an honest link-state row
  (connected = quiet confirmation; revoked/degraded/pending reuse
  `ProviderIntegrationAttentionResolver` copy; unusable states say "Calendário
  desligado") with a dismiss-then-route button to `nexus://connections/<provider>`;
  threaded via `PlanZoneView`. New id `plan-settings-calendar-provider-status-row`;
  pinned ids untouched.
- **P1.4 Reason codes**: verification outcome — iOS
  `ScreenContractStatusBanner` ALREADY localizes the full backend
  `/training/home` meta vocabulary (6 codes; `ReadinessReasonCode` has exactly one
  value). Added a tripwire test pinning all six against generic-detail fallthrough.
- **P1.5 A11y**: swap-banner "See/Keep original" buttons now 44pt min hit targets;
  coach-sheet signal chips stack vertically at `dynamicTypeSize >= .accessibility3`.

## Verification evidence
- Focused iOS gate (Release-config test bundle, iPhone 17 Pro simulator):
  `xcodebuild test … -only-testing:` over DashboardSkillSnapshotPresentationTests,
  DashboardSkillSnapshotModelBuilderTests, TrainingDeepLinkDestinationTests (new),
  DeepLinkRouterTests (extended), PlanZoneDayAnchorMatcherTests,
  TrainingCalendarProviderStatusResolverTests (new),
  ScreenContractStatusPresentationTests (extended), PlanZoneRoadmapTests →
  **117 tests, 0 failures, TEST SUCCEEDED** (log: `/tmp/phase1-focused-tests.log`).
  Simulator shut down afterward.
- `npm run docs:audit` (engine): exit 0 before and after doc edits. Corrected
  measurement (Codex finding 2): the true metric is the `issues flagged`
  total from `--json`, not printed lines — session baseline **1554**, after
  this round's doc edits **1551** (net −3; the release-identity refresh and
  release-state updates cleared stale references). The earlier "80-warning
  baseline" wording was a truncated-console miscount and is retracted.
- Backend code: untouched (docs/mirror only). iOS pre-existing dirty files
  `ContentStudioView.swift` / `NavigationPerformanceSourcePinsTests.swift`
  untouched.

## Phase 2 — coach-trust surfacing (iOS, uncommitted)
- **P2.1** `ReadinessResponse` decodes `sleepDurationHours` + `reasoning`
  (both init paths); coach reasoning sheet gains a locale-formatted
  "Sleep duration" tile ("7,2 h") and prefers the scorer's prose over the
  generic narrative when the coach summary is empty
  (`TrainingTodayViewStateResolver.whyTodayNarrative` /
  `sleepDurationValue` statics).
- **P2.2** `CoachBriefingResponse` decodes `cachedAt` (+`cachedAtDate`);
  `TrainingViewModel.coachLastUpdatedAt` prefers backend truth over the local
  fetch clock; `TrainingCoachNoteCard` shows the "Updated X ago" caption.
- **P2.3** Swap banner detail line: `TrainingSwapDetailResolver` renders
  "Intensity capped at N% of plan" (VERIFIED backend semantics: the pct is the
  FRACTION of planned intensity kept — 0.6 = 60%; percent-shaped payloads
  normalized; ≥100%/nonsense render nothing) plus a humanized "Was: <original
  type>" line; full `SessionAdaptation` threaded TrainingView → zone →
  banner; smoke fixture corrected 18 → 0.6.
- **P2.4** `PlanSessionChipBuilder` maps the FULL `calendarSyncState`
  vocabulary: `stale|repair_needed` → calendar-link chip; NEW
  `provider_disconnected` and `failed` chips; healthy/legacy-quiet states
  render nothing; unknown values drift-log (never guessed).
- **P2.5** `TrainingAllWeeksPlanInfo` decodes `weeklyTargets`
  {requested, scheduled}; `PlanRequestedTargetsResolver` renders ONE honest
  roadmap-header line (totals sentence / single-modality sentence /
  redistribution sentence; silent when equal or legacy-nil).
- **P2.6** Feedback sheet gains an "Energy" slider (advanced section) that
  mirrors the backend derivation (10 − fatigue) until touched; explicit value
  wins server-side; skipped feedback never sends it.
- **P2.7** `TrainingKeepOriginalFlowTests`: repository pin (keep-original
  applies returned session + invalidates loadAll AND /home snapshots + exactly
  one endpoint call) and banner-visibility pins on prescription equivalence.

## Phase 3 — backend reads (engine, uncommitted)
- **B1** `getAllPlanWeeks` now returns `plan.weeklyTargets = {requested,
  scheduled}` (safe-parse from preferences_json; write-side verified: flat
  keys = realized-after-finalization at `training-plan-generation.ts:894`,
  `requestedTargets` = the ask; legacy/malformed → nulls, never throws).
- **B2** `calendarCleanup: {deadLetteredCount}|null` on `getAllPlanWeeks`
  (both paths, incl. no-plan — ghost events outlive canceled plans) and
  `getWeekPlan`. Linkage predicate VERIFIED first-class:
  `secretary_agenda_items.source_skill = 'training'`; query additionally
  scoped by owner/tenant + `provider_sync_state='delete_failed'` +
  `provider_sync_failure_count >= 5`; guarded by table/column existence
  (pre-migration DBs → null); never routed through home `meta.reasonCodes`
  (would falsely flip `isFallback`).
- **B3** red-flag producer: no code (product decision recorded in OPEN_ITEMS).

## Phase 4 — verification evidence
- Backend focused vitest: **5 files / 170 tests PASS**
  (training-read-models incl. 10 new B1/B2 cases, training-routes,
  training-plan-persistence, training-home-payload,
  secretary-agenda-provider-sync). `npm run typecheck` clean.
- `npm run release:focused-verify`: **EXIT 0** — risk gate complete, strict
  release-doc drift check **0 findings across 326 SHAs** (validates the
  Phase-0 doc edits too).
- iOS Phase-2 focused gate: 13 suites, **139 tests** — 2 first-run failures
  (keep-original test assumed loadAll fetches /home; swap-banner resolver
  leaked raw `run_threshold` through `localizedSessionType`'s EN passthrough)
  → both fixed (explicit `loadHome` in test; token humanization before
  localization) → re-run **TEST SUCCEEDED**. Combined with the Phase-1 gate
  (117 tests PASS), all touched suites are green.
- **Isolated Training E2E lane (authorized, EXECUTED — first formal run on
  main):** final run `training-e2e-20260702143816-f0c3fc3e` — container pair
  healthy (backend 4.14.211 @ f0c3fc3e, isolated ports 18200/18100), seed +
  smoke passed, iOS suites on the dedicated simulator:
  **23 tests / 22 passed / 1 failed**. The one failure
  (`TrainingFixtureBypassUITests.test_accountFixtureSwitchDoesNotShowPreviousTrainingPlan`)
  is a simulator accessibility-IPC timeout (`kAXErrorIPCTimeout`), identical
  in both lane runs — infrastructure, not product; stabilization task filed.
  Crucially `TrainingIsolatedBackendE2EUITests` (the full Today → complete →
  feedback persists → Plan → Progress loop) **PASSED**, including the
  learning-focus panel and sync row. Evidence: xcresult + seed-evidence JSON
  under `engine/.local/training-e2e/training-e2e-20260702143816-f0c3fc3e/`.

## Real bug found AND fixed by the E2E lane
- **Learning-path persistence regression (backend):** `buildPreferencesJson`
  (training-plan-generation.ts) stopped writing `trainingLearningPath` into
  `preferences_json` (dropped in the 4.14.210 mainline rebase), while
  `getAllPlanWeeks` reads the per-week learning focus FROM preferences_json —
  so freshly generated plans could never render their learning path in the
  Plan zone (only pre-rebase plans could). The read-side unit tests seeded
  preferences directly, so nothing caught it until the lane's first formal
  run. Fixed: one line in `buildPreferencesJson`
  (`trainingLearningPath: extractTrainingLearningPath(planData)`) + a
  real-SQLite integration pin in
  `__tests__/integration/training-plan-create-cycle.test.ts` (generated
  plan's persisted preferences carry a non-empty `weeklyPath`), and
  re-verified END-TO-END by the passing lane
  (`training-week-learning-focus-1` renders on the seeded plan).

## Training E2E harness fixes (engine scripts, this session)
- `scripts/training-e2e-ios-seed.mjs` + `scripts/training-e2e-flow.mjs`:
  `fileURLToPath` instead of `URL.pathname` — the canonical checkout path
  contains a space ("Custom Connectors") which stayed percent-encoded and
  broke `latest.env` resolution.
- `scripts/training-e2e-ios.sh`: `COPYFILE_DISABLE=1` export; xattr scrub of
  reused build products; and DerivedData relocated to
  `/private/tmp/nexus-training-e2e/<runId>/` — macOS provenance/Finder xattrs
  land nondeterministically on freshly built products under user-tree paths
  and fail CodeSign with "resource fork ... detritus not allowed" (observed
  in 3 of 4 lane runs before the relocation; deterministic pass after).
- Same `URL.pathname` bug exists in `scripts/content-portal-browser-smoke.mjs`
  (Content scope) — spawn-task filed, not fixed here.

## What's still pending
- Full `scripts/ios-single-simulator-test.sh` RC run (after the E2E lane
  frees the simulator host).
- Manual simulator matrix (light/dark, Dynamic Type XXXL, pt-PT/pt-BR/en,
  wearable states, provider-revoked routing) + fresh-Marathon onboarding
  operator pass — operator/manual gates.
- Commits: docs-only engine commit, Training-scoped engine src/test commit,
  and Training/Dashboard-scoped iOS commit await Felipe's explicit go. Local
  backend `main` still needs fast-forward to origin/main.

## Files changed (uncommitted)
- Engine: `docs/release/CURRENT_RELEASE_STATE.md` (repo-local),
  `docs/_workspace-mirror/**` (mirror refresh incl. workspace release docs).
- Workspace (not a git repo): `docs/release/CURRENT_RELEASE_STATE.md`,
  `docs/release/OPEN_ITEMS.md`, `docs/release/release-identity.{md,json}`,
  `docs/agents/handoffs/2026-07-02-training-ux-round.md` (this file).
- iOS specs: `ios-specs/00-CURRENT-PRODUCT-TRUTH.md`, `ios-specs/27-CLAUDE-CODE-HANDOVER.md`.
- iOS app: `Core/DeepLinkRouter.swift`, `ViewModels/DashboardViewModel.swift`,
  `Views/Dashboard/DashboardSkillSnapshot{Models,Presentation}.swift`,
  `Views/Dashboard/DashboardView.swift`, `Views/Training/{TrainingView,PlanZoneView,TrainingPlanSettingsSheet}.swift`,
  `Views/Training/Today/{TrainingSwapBanner,TrainingCoachReasoningSheet}.swift`,
  new `Views/Training/{TrainingRouteResolver,TrainingCalendarProviderStatusResolver}.swift`,
  `docs/qa/work-orders/WO-training-redesign-q3-20260612.md`.
- iOS tests: extended `DashboardSkillSnapshot{ModelBuilder,Presentation}Tests`,
  `DeepLinkRouterTests`, `ScreenContractStatusPresentationTests`; new
  `TrainingDeepLinkDestinationTests`, `TrainingCalendarProviderStatusResolverTests`.

## Commit record (2026-07-02, after Codex re-audit GO)

Felipe authorized commit-readiness after the Codex re-audit verdict
(GO, zero findings, R1-R5 PASS — recorded in
`ios/docs/qa/work-orders/WO-training-ux-round-20260702.md`). Local commits
only — **nothing pushed, nothing deployed**.

- Engine `codex/Trainingfixes`:
  - `ae75d178` `fix(training): expose requested targets and dead-letter
    state, restore learning-path persistence` — 7 files (read models,
    generation persistence, 2 test files, 3 E2E harness scripts).
    Pre-commit risk gate passed (12 files / 232 tests).
  - docs commit follows this handoff update (engine repo-local release
    state + workspace-docs mirror snapshot).
- iOS `main`:
  - `71def47` `feat(training): coach-trust surfacing, zone deep links,
    provider visibility` — 39 files / +1,557 −54 (app, scheme, tests).
  - `c79e42a` `docs(qa): Training UX round work order + Q3 closure
    addendum`.
- Excluded on purpose, still uncommitted: `ContentStudioView.swift`,
  `NavigationPerformanceSourcePinsTests.swift` (other session's work),
  `test-summary.json` (run artifact).

Verification trusted from Codex (not re-run for the commit step): round-1
verdict A1-A4/B1-B13/C1-C2/D1-D4 with the two MAJORs subsequently fixed,
and the re-audit R1-R5 PASS (Release UI Validation repro, Debug parity,
production-safety adversarial checks, 155-test blast radius, docs-audit
honesty at 1550 ≤ 1554).

Explicit non-rerun lanes at commit time: the isolated Training E2E
container lane was NOT re-run after the finding-1 fixes (its earlier run
predates them; the fixes are Debug-semantics-preserving and covered by
Debug parity + blast-radius suites) and the live-calendar lane remains
unauthorized/never run.

Status: ready for Felipe's push/deploy decision. Push to origin, staging
deploy, and any promote remain explicitly NOT authorized in this session.
Local backend `main` fast-forward to origin/main also still pending.

## Open questions / decisions deferred to user
- Push authorization for engine `codex/Trainingfixes` (ae75d178 + docs
  commit) and iOS `main` (71def47, c79e42a).
- Whether to fast-forward local backend `main` to origin/main.
- Whether to re-run the isolated E2E lane post-commit for belt-and-braces
  (authorized, ~25 min) before any push.

## Verifiable Reward Summary

- **Verdict**: PASS (advisory)
- **Score**: see reward-run JSON (advisory run; release-area classifier)
- **Area**: release (docs reconciliation) + ios (Phase-1 changes)
- **Changed-area classifier**: engine changes are docs/mirror-only; iOS changes are
  Training/Dashboard-scoped Swift + tests
- **Hard failures**: none
- **Mandatory checks**: classifier PASS, docs:audit PASS (exit 0; `issues
  flagged` total at/below the 1554 session baseline — see corrected
  measurement note above), reward schema present PASS
- **Skipped checks and reasons**: staging-smoke evidence — no deploy in this
  session (docs-only backend changes; production 4.14.211 was promoted in the
  prior session and was verified read-only here); L1-L5 claim level not declared
- **Evidence commands**: read-only SSH prod version check (`4.14.211`),
  `curl /health` (healthy ×2), `./scripts/release-identity.sh --persist`,
  `npm run docs:audit` (before + after, exit 0), `./scripts/workspace-docs-mirror.sh`,
  focused `xcodebuild test` over 8 suites → **117 tests / 0 failures /
  TEST SUCCEEDED**, `xcrun simctl shutdown`
- **Evidence artifacts**: `/tmp/phase1-focused-tests.log`,
  `docs/release/release-identity.md` (regenerated),
  reward-run JSON under `engine/.local/reward-runs/`
- **Export eligibility**: manual human review required (v1 policy)
- **Prompt/process improvement**: promote pipeline should persist staging-smoke
  evidence JSON again (REL-EVIDENCE-PERSISTENCE) so release-area reward checks can
  stop skipping on missing smoke evidence
