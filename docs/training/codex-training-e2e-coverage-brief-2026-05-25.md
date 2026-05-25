# Codex Brief — Training Skill E2E Coverage + Heavy-Lower-Body-Before-Long-Run Fix

**Date**: 2026-05-25
**Owner of this brief**: Claude (handed off to Codex for execution)
**Status**: Approved by Felipe via ExitPlanMode. Codex executes end-to-end; Claude does QA of each Codex PR; Felipe is the final authorizer on prod promotes.

## How to use this file

You (Codex) are receiving this brief because Felipe authorized you to execute it. Read it top-to-bottom once, then implement slice-by-slice in the order in the build table near the bottom. Do not start with Slice 2+ until Slice 1 is approved by Claude and shipped — Slice 2's scenarios depend on Slice 1's fix.

When you finish a slice, open a PR with the verification gates already green (typecheck, focused vitest, full `npm run verify`). Tag Claude in the PR description with "@claude please review against the brief's QA criteria for Slice <N>". Claude reviews; Felipe authorizes deploy.

---

## Production state at hand-off

- **Active version**: `4.14.195` at commit `0682b34b` (Outlook default-enabled training calendar — PR #138).
- **`main` HEAD**: `6ef66e11` (release-state docs commit covering 4.14.194 + 4.14.195).
- **Canonical worktree** (all Codex work happens here): `/Users/felipedominguez/Desktop/Nexus Hub/worktrees/confirmation-main-promote-20260523`.
- **Do NOT touch**: `/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot` (codex/chat_improvement_goal worktree, has uncommitted chat changes).
- **Test floor**: `npm run verify` ≥ 10,555 tests. Don't ship a slice that loses tests.

---

## Context

Felipe reported a new blocker on the iOS New Plan screen: a yellow "Before creating" warning fires with his exact configuration (`Sessions=6, Run=5, Strength=5, Long=Saturday, Two-a-day=Prefer`):

> "Heavy lower-body strength scheduled the day before a long run in 1 week. Move heavy lower-body two days before, or to upper-body that day."

This is the **fourth consecutive Training-skill bug** to escape into production after a PR ship-and-deploy cycle this week (v2.1, cancel-orphan, two-a-day-Auto, calendar body, Outlook gate, now the long-run-adjacency blocker). Each fix has revealed the next bug at the same abstraction layer because the existing test suite mocks everything below the route handler — the integration boundaries where bugs actually live (route validator → planner → DB → calendar adapter → iOS-faithful payload shape) are unexercised end-to-end.

Felipe's stated frustration: *"your deliveries are falling back in quality."* He's asked for two deliverables in one brief: (a) fix the blocker now, and (b) ship comprehensive end-to-end coverage so the next Training change is the **last** of these reactive cycles.

**Intended outcome**: After this work lands, Felipe can create the 5+5+Sat+Prefer+Outlook plan from iOS without hitting any pre-flight blocker; every subsequent Training-skill PR has a deterministic E2E test asserting the visible iOS outcome end-to-end; and a Codex-driven iOS XCUITest pass exists so the iOS plan-creation flow is covered at the simulator level too.

**Confirmed scope**:
- One brief covers the fix AND the E2E suite (single design, multiple sliced PRs).
- E2E shape: **real DB + network-boundary mocks** (real route handlers, real planner, real persistence, real secretary-agenda; mock only the Google/Outlook HTTP calls).
- iOS Codex scope: **full Training tab + New Plan** flow (broad coverage, not just the bug-reproducer screen).
- Codex executes; Claude does QA on PRs + post-deploy health.

---

## Working agreements (Codex ↔ Claude ↔ Felipe)

- **Codex implements** each slice as its own feature branch off `origin/main` in the canonical clean worktree at `/Users/felipedominguez/Desktop/Nexus Hub/worktrees/confirmation-main-promote-20260523`. Do NOT touch the dirty `codex/chat_improvement_goal` worktree.
- **Codex opens one PR per slice** with the verification gates already green (`npx tsc --noEmit`, focused vitest, full `npm run verify`).
- **Claude reviews each PR** against the per-slice QA criteria in this brief. Posts review comments on the PR. Approves only when ALL criteria pass.
- **Felipe is the final authorizer** on every `promote-to-prod.sh` run. Codex does NOT run promote-to-prod without Felipe's explicit message ("ship it" / "send to prod" / equivalent).
- **Slices 1 + 4 are deploy-bearing**; Slices 2/3/5 are tests/docs only. Claude verifies post-deploy `/health` and `/public-status` for the deploy-bearing slices.

---

## Slice 1 — Heavy-lower-body-before-long-run fix (the immediate blocker)

**Feature branch**: `codex/training-no-heavy-lower-before-long-run-20260525`. Single PR. Ships through full deploy chain after Felipe's "ship it".

**Root cause** (from Phase 1 exploration):
- Linter rule `no_heavy_lower_before_long_run` at `src/services/coach-kernel/plan-linter.ts:340-413` is severity `'blocker'`. When triggered, `/plan/generate` returns `status: 'plan_quality_blocked'` (HTTP 200, no `planId`).
- The planner's day-spacing pass `softenLowerBodyLoadNearImpactDays` (`src/services/training-plan-coordination.ts:510`) WOULD prevent this scheduling, but it is gated on `protectLowerBodySpacing = athlete.lowerBodySensitive` (line 175 → 800-801), which is true ONLY for users with injury text.
- For healthy users, `resolveStrengthDays` (`src/services/coach-kernel/engines/strength-engine.ts:1170-1181`) deterministically picks `[Mon, Wed, Fri, Sat, Tue, Thu, Sun]` and the variant rotation places a heavy-lower block on Friday → linter rejects → user can't create a plan.

**The disagreement**: the planner thinks the rule is opt-in (only for injured users), the linter treats it as a universal hard blocker. The linter wins, so the planner must satisfy it unconditionally.

**Critical files**:
- `src/services/training-plan-coordination.ts:510` (`softenLowerBodyLoadNearImpactDays`) — **change**: extract the long-run-adjacency check from the `protectLowerBodySpacing` gate so it runs for every user when `coordination.resolvedLongWorkoutDay` is set. Two equivalent approaches: (a) swap Friday's lower block with another strength day not adjacent to long run; (b) convert Friday's lower block to upper-body using the existing upper-body builder pattern. Pick (a) when ≥3 strength days exist (Friday → Wednesday swap is the common case), fall back to (b) when no swap target is available.
- `src/services/coach-kernel/engines/strength-engine.ts:1170-1181` (`resolveStrengthDays`) — optionally reorder the fallback `[Mon, Wed, Fri, Sat, Tue, Thu, Sun]` to prefer days NOT adjacent to `coordination.resolvedLongWorkoutDay`. Smaller surface, but the coordination pass is the right place because it has the long-run context.

**Reuses existing utilities**:
- `softenLowerBodyLoadNearImpactDays` (same file) — same template, just drop the injury gate for the long-run-adjacent branch.
- `coordination.resolvedLongWorkoutDay` — already computed.
- The variant rotation + upper-body builder used by `softenLowerBodyLoadNearImpactDays` for the injury-sensitive case — same code path, just made unconditional.

**Tests Codex must write**:
- `__tests__/services/training-coach-kernel-plan-generator.test.ts` — add the user's exact 5+5+Sat+Prefer input as a regression test. Assert `planLint.blockers` does NOT contain `no_heavy_lower_before_long_run`. Assert Friday's session is NOT a heavy-lower variant (either upper-body or moved to another day).
- `__tests__/services/coach-kernel-plan-linter.test.ts` — already has 3 direct tests on the rule. Add a 4th asserting that when `softenLowerBodyLoadNearImpactDays` ran, the linter passes.

**Claude QA criteria** (gates approval):
- Diff is bounded — only `training-plan-coordination.ts` + the 2 test files. Any larger surface = rejection.
- Marathon-prep + non-Sat-long users unchanged (run an existing planner test asserting marathon plan shape vs main, expect zero delta).
- New regression test sends the exact bug-reproducer input (5+5+Sat+Prefer) and the assertion is grounded in actual planner output (no shape-only assertion that would pass on empty `blockers`).
- Test count rises by exactly N (where N = the explicit new test count Codex states in the PR description); no silent test loss.
- PR description includes the exact `curl` payload Felipe can run against staging to confirm the fix.

---

## Slice 2 — Backend real-DB end-to-end test suite (harness + scenarios 1-3)

**Feature branch**: `codex/training-e2e-harness-and-bug-reproducer-20260525`. Single PR. Tests-only, no deploy.

**The shape**: a new test file pattern that boots SQLite (in-memory, already what existing tests use), runs all migrations, registers REAL route handlers via `registerTrainingPlanRoutes()` against an in-process Express app, and asserts the visible end-to-end outcome. Mock ONLY the Google/Outlook HTTP layer (`google-calendar.createEvent`, `outlook-calendar.createEvent`, `getEvents`) so we don't hit live calendar APIs.

**Why this catches what unit tests don't**: every bug shipped this week was at an integration seam — route validator dropping `'auto'`, hybrid resolver silently rewriting volume, body falling back to metadata, cancel cascade missing prior-version rows, Outlook gate blocking the route. A real-DB test exercises route → planner → persistence → adapter → response shape in one pass.

**Critical files (new test suite)**:
- `__tests__/integration/training-e2e-harness.ts` (new) — shared boot for the E2E suite: spin up `Database(':memory:')`, run migrations from `migrations/`, register all training routes, install network-boundary mocks (`vi.mock('../../src/services/google-calendar')` + `outlook-calendar`), expose `dispatch(method, path, userId, body)` helper. Reuses existing `setDbProvider` pattern from `__tests__/services/training-plan-cancellation-cascade.test.ts:62`.
- `__tests__/integration/training-plan-create-cycle.test.ts` (new) — Scenarios 1-3 only in this slice:
  - **Scenario 1 — user's exact 5+5+Sat+Prefer**: POST `/plan/preview` → assert response shape iOS reads (`planLint.warnings`, `planLint.blockers`, `phaseRoadmap`, `weeklyTargets`, `totalSessions`, `fallbackTemplateUsed`); POST `/plan/generate` → assert HTTP 200 + `planId` + persisted weeks/sessions; assert ≥3 days have 2 sessions (two-a-day verification); assert Friday's session is NOT heavy-lower (Slice 1 verification); assert calendar adapter was called with workout-content body (Track C Stage 1 of PR #137 verification).
  - **Scenario 2 — generate → cancel → generate cycle**: covers the `plan_version` orphan bug (PR #137 Track A). Generate a plan, cancel it, generate a new plan, assert zero orphan `secretary_agenda_items` and zero zombie calendar events.
  - **Scenario 3 — Outlook source explicit**: POST `/plan/generate` with `calendarSource: 'outlook'` → assert no 503 (verifies PR #138). Send `calendarSource: 'auto'` (the iOS-default) → assert resolves to a sensible provider.

**Reuses existing utilities**:
- `Database(':memory:')` + `applyMigrations()` from `__tests__/services/training-plan-cancellation-cascade.test.ts:29-47`.
- `setDbProvider` from `src/services/intelligence-bus.ts`.
- `registerTrainingPlanRoutes` from `src/api/routes/training-plan-routes.ts`.
- Existing fixture builders in `src/services/training-fallback-plan.ts` for athlete profile shape.
- `vi.hoisted` mock pattern from `__tests__/api/training-plan-cancellation.test.ts:3-22`.

**Claude QA criteria**:
- Harness file (`training-e2e-harness.ts`) is genuinely reusable — Codex did NOT inline route-handler boot per test; one shared helper, one teardown.
- Each scenario's assertions hit the actual response payload shape iOS reads (assertion names match the field names in `src/api/routes/training-plan-generation.ts`).
- The bug-reproducer scenario (Scenario 1) FAILS without Slice 1's fix and PASSES with it — Codex MUST explicitly note this in the PR description as the cross-slice contract.
- The generate-cancel-cycle scenario asserts ZERO `secretary_agenda_items` rows in `lifecycle_state IN ('scheduled','synced','proposed')` after cancel — pins the bug PR #137 closed.
- Each test runs in < 10s individually; the full integration suite runs in < 90s total.
- No production HTTP calls — every `google-calendar` and `outlook-calendar` import is mocked at the boundary.
- Test files are typed (no `any` casts on response payloads — use the real route handler return types).

---

## Slice 3 — E2E coverage continued (scenarios 4-5 + coach-analysis + secretary-agenda + iOS payload contract)

**Feature branch**: `codex/training-e2e-additional-coverage-20260525`. Single PR. Tests-only, no deploy.

**Critical files**:
- `__tests__/integration/training-plan-create-cycle.test.ts` (extend with Scenarios 4-5):
  - **Scenario 4 — `twoADayPreference` matrix**: send each of `'never' | 'optional' | 'preferred' | 'auto'` → assert `resolveMaxSessionsPerDay` resolves correctly and the resulting plan respects it.
  - **Scenario 5 — coach-rules blockers**: send a plan that WILL violate `no_heavy_lower_before_long_run` (e.g., user with `lowerBodySensitive=true` and a pathological setting that defeats Slice 1's avoidance) → assert `plan_quality_blocked` returns 200 with `blockers[*].code === 'no_heavy_lower_before_long_run'`. Pins the contract.
- `__tests__/integration/training-coach-analysis-e2e.test.ts` (new) — covers v2 `/coach-analysis` composition. Real plan, real ledger rows, real readiness/health events; assert the composed payload has all sub-sections (load model, taper, missed-session sweep, adherence, race-calendar, scenario classifier).
- `__tests__/integration/training-secretary-agenda-cron.test.ts` (new) — simulate the `secretary_agenda_sync` cron tick after a plan-create, assert the Outlook/Google `createEvent` mock was called with the expected body + agenda markers, assert the agenda row's `provider_event_id` got linked back.
- `__tests__/integration/training-ios-payload-contract.test.ts` (new) — for every iOS-faithful response field (`planLint.warnings`, `planLint.blockers`, `phaseRoadmap`, `weeklyTargets`, `totalSessions`, `fallbackTemplateUsed`, `calendarFetchDegraded`, `calendarFetchError`, `briefing.warnings`, `briefing.degraded`), assert presence + shape on a real plan-create response. If iOS drifts or backend drifts, this test catches it.

**Expected test count delta** (Slices 2+3 combined): ~15 new integration tests across 4 files.

**Claude QA criteria**: same as Slice 2 plus —
- Scenario 5's "pathological config" must be a real config that defeats Slice 1's avoidance, not a synthetic one that bypasses the planner. Otherwise the test pins the WRONG contract.
- `training-coach-analysis-e2e.test.ts` exercises the actual `/coach-analysis` route handler, not a unit of the composer in isolation.

---

## Slice 4 — Staging-smoke training E2E expansion

**Feature branch**: `codex/training-staging-smoke-e2e-20260525`. Single PR. Ships through deploy chain so the new smoke section is in place before the next deploy.

**Why**: `scripts/staging-smoke.sh` today only auth-probes `/api/v1/training/today` (401 expected) — it doesn't create a plan or exercise the planner. The 4 bugs we shipped this week would have ALL escaped staging-smoke. Adding an E2E plan-create assertion as part of the existing smoke would have caught the Outlook 503 and the two-a-day-Auto issue at the staging gate, not in user reports.

**Critical files**:
- `scripts/staging-smoke.sh` (extend) — add a new section "Training plan-create E2E" between the existing 5/6 (PM2 state) and 6/6 (DB integrity) sections:
  - Mint a short-lived owner JWT (already done elsewhere in the smoke for `/api/v1/dashboard` probes).
  - POST `/api/v1/training/plan/preview` with the bug-reproducer config (5+5+Sat+Prefer+Outlook).
  - Assert HTTP 200 + `planLint.blockers` is empty (after Slice 1).
  - POST `/api/v1/training/plan/cancel` to clean up any test state.
  - Do NOT POST `/plan/generate` on staging (writes a real plan + calls real calendar APIs against the test tenant). Preview-only keeps the smoke deterministic.
- `scripts/cannot-skip-gate-dashboard.sh` (extend) — add a `training-plan-create-e2e` gate so the diff classifier flips it on when training-related files change.

**Reuses existing utilities**:
- `staging-smoke.sh:75-90` portal-session-mint pattern.
- `evidence_record` helper at `staging-smoke.sh:63-69` for JSON evidence output.

**Smoke evidence** lands at the existing `docs/release/smoke-evidence/` directory.

**Claude QA criteria**:
- New smoke section is gated behind a feature switch (`NEXUS_SMOKE_TRAINING_E2E=1`) so it can be turned off if it flakes — does NOT silently break the existing 17-check smoke.
- Uses preview-only (no `/plan/generate` calls on staging); explicit cleanup of any state created.
- Evidence JSON shape matches the existing `evidence_record` pattern (Codex doesn't invent new format).
- Slice 4's PR includes a screenshot/grep evidence that the new section ran successfully on staging.

---

## Slice 5 — iOS Codex prompt for full Training tab + New Plan

**Feature branch**: `codex/training-ios-codex-e2e-prompt-20260525`. Single PR. Docs-only, no deploy.

**Single new file**: `docs/training/training-skill-ios-codex-e2e-prompt-2026-05-25.md` (pasteable into a fresh Codex session in the iOS repo).

The file MUST contain (each as its own section):

1. **Front-matter**: Date, iOS repo path (`~/Desktop/Nexus Hub IOS/Nexus Hub/`), iOS scheme (`Nexus Hub`), iOS sim destination (`platform=iOS Simulator,name=iPhone 17 Pro`), backend version under test (latest from `docs/release/CURRENT_RELEASE_STATE.md`), backup tag instructions, prerequisite scripts (`scripts/sim-local.sh` boots backend + sim; `scripts/ios-single-simulator-test.sh` runs XCTest).
2. **Setup commands** Codex runs verbatim:
   - Boot backend: `cd /Users/felipedominguez/Desktop/Custom\ Connectors/Cortex/cortex-telegram-hub-bot && ./scripts/local-up.sh && curl http://127.0.0.1:8200/api/v1/`.
   - Boot iOS sim with local backend args: `IOS_SIM_NAME="iPhone 17 Pro" ./scripts/sim-local.sh`.
   - Verify connectivity by running `LocalEngineUITestHelpers.skipUnlessLocalEngineIsHealthy()` once.
3. **XCUITest files Codex creates**:
   - `Nexus HubUITests/TrainingNewPlanCreationUITests.swift`:
     - `test_newPlanForm_loadsWithDefaults`
     - `test_newPlanForm_bugReproducer_5run_5strength_Saturday_Prefer_Outlook`
     - `test_newPlanForm_twoADayPicker_allValues` — iterates `never/optional/preferred/auto`
     - `test_newPlanForm_calendarSource_outlook`
     - `test_newPlanForm_preflightWarning_renders`
   - `Nexus HubUITests/TrainingTabFlowUITests.swift`:
     - `test_trainingTab_today_rendersSession` (with `-NEXUSQATrainingFixture rich-v1` seed)
     - `test_trainingTab_week_rendersAllDays`
     - `test_trainingTab_sessionDetail_rendersFullPrescription`
     - `test_trainingTab_cancel_clearsAllSessions`
     - `test_trainingTab_reflow_movesSession`
4. **Accessibility identifiers Codex adds to `TrainingView.swift`**:
   - `training-two-a-day-picker`
   - `training-preflight-warning-card`
   - `training-preflight-warning-text`
   - `training-preview-button`
   - `training-generate-button`
5. **Assertion patterns**:
   - Use `LocalEngineUITestHelpers.skipUnlessLocalEngineIsHealthy()` to gate against backend availability.
   - Use `LocalEngineUITestHelpers.makeAppPointingAtLocalEngine()` for tests that hit real backend.
   - Use `-NEXUSQATrainingFixture rich-v1` for tests that only need seeded state.
   - Each test must `XCTAssertTrue(element.waitForExistence(timeout: 5))` before asserting.
   - Tap `training-cancel-button` in `tearDown` to clean up any plan created during the test.
6. **Run commands**:
   - `cd ~/Desktop/Nexus Hub IOS/Nexus Hub && IOS_SCHEME="Nexus Hub" IOS_SIM_NAME="iPhone 17 Pro" ./scripts/ios-single-simulator-test.sh -only-testing:"Nexus HubUITests/TrainingNewPlanCreationUITests"` then re-run for the Tab Flow suite.
7. **Two-A-Day enum mismatch instructions** — explicitly direct Codex to test all four values (`never/optional/preferred/auto`) and report which iOS-side mapping should ship. iOS currently maps "Auto" chip to `'optional'`; backend now accepts `'auto'` too.
8. **Report template** — mirror `~/Desktop/Nexus Hub IOS/Nexus Hub/docs/ios/training-expert-coach-ios-codex-validation.md`: Verdict (READY / READY_WITH_CONDITIONS / NOT_READY), Evidence Table (claim | status | E1-E5 | notes), Contract Readiness section, Pass/Fail count per test, simulator + xcodebuild version, evidence screenshots under `~/Desktop/Nexus Hub IOS/Nexus Hub/docs/qa/2026-05-25-training-e2e/`, bugs found with reproduction steps.

The prompt file's structure must be self-contained enough that a future Codex session doesn't need to read THIS file to execute it — every absolute path, script name, scheme, and identifier appears in the prompt itself.

**Claude QA criteria for Slice 5**:
- The prompt is self-contained: pasted into a fresh Codex session in the iOS repo, it runs without backend-repo context.
- All paths referenced are absolute (`/Users/felipedominguez/...`), not relative.
- The 5 new accessibility identifiers Codex must add to `TrainingView.swift` are listed explicitly.
- The Two-A-Day enum mismatch (iOS `optional/preferred/never` vs backend `+ auto`) is called out as a forcing-function test.
- Report format mirrors `training-expert-coach-ios-codex-validation.md`.

---

## Build order

| Order | Slice | What lands | Deploy? |
|---|---|---|---|
| 1 | Slice 1 (Heavy-lower-body fix + regression test) | Felipe unblocked on plan creation | **Yes** — own PR, own deploy chain |
| 2 | Slice 2 (E2E harness + scenarios 1-3) | First real E2E pass green | No — tests only |
| 3 | Slice 3 (E2E scenarios 4-5 + coach-analysis + secretary-agenda + iOS payload contract) | Full E2E coverage of identified gaps | No — tests only |
| 4 | Slice 4 (Staging smoke training E2E + cannot-skip gate) | Future deploys gated on training E2E | **Yes** — own PR, own deploy |
| 5 | Slice 5 (iOS Codex prompt doc) | iOS Codex pass deliverable ready | No — docs only |

Slices 1 and 4 deploy. Slices 2/3/5 do not. Single PR per slice. Target: 2 calendar days of focused engineering.

---

## Codex execution checklist (per slice)

For EVERY slice:

1. `git fetch origin main` + `git switch -c codex/<slice-branch-name>` in `/Users/felipedominguez/Desktop/Nexus Hub/worktrees/confirmation-main-promote-20260523`.
2. Implement the slice. Keep diff bounded to the files listed in the slice's "Critical files" subsection.
3. `npx tsc --noEmit` clean.
4. `npx vitest run <focused-test-files>` green.
5. `npm run verify` green (full suite ≥ 10,555 + slice's new test count).
6. Commit with a body that includes: (a) slice's scope, (b) files changed and why, (c) test count delta, (d) cross-slice contract (if any), (e) manual probe Felipe can run on staging.
7. Push to origin and `gh pr create --base main --head codex/<slice-branch> --title "<slice-title>" --body "<commit-body-expanded>"`.
8. Wait for all GitHub CI checks to be green. Do NOT merge yet.
9. Tag Claude in PR description with "@claude please review against the brief's QA criteria for Slice <N>".
10. Wait for Claude's review approval AND Felipe's "ship it" message.
11. For deploy-bearing slices (1 + 4 only): merge via `gh pr merge <N> --admin --merge --delete-branch=false`, then run the full deploy chain from the canonical clean worktree:
    - `./scripts/deploy-staging.sh`
    - 5-min soak
    - `./scripts/staging-smoke.sh`
    - commit smoke evidence to main as `docs/release/smoke-evidence/staging-smoke-<sha>-<ts>.json`
    - `yes YES | ./scripts/promote-to-prod.sh`
12. For non-deploy slices (2, 3, 5): merge via `gh pr merge <N> --admin --merge --delete-branch=false`. No deploy.
13. Update `docs/release/CURRENT_RELEASE_STATE.md` + `docs/release/current-release-index.md` + new handoff under `docs/agents/handoffs/2026-05-25-<slice-slug>.md` after each deploy-bearing slice. Push as a separate small commit on main.

---

## Verification

### Per-slice CI gates
- `npx tsc --noEmit` clean (every slice).
- New focused tests pass.
- `npm run verify` stays ≥ 10,555 + slice's new test count.

### Slice 1 (the fix)
- Manual probe on staging: POST `/api/v1/training/plan/preview` with `{sessionsPerWeek:6, runSessionsPerWeek:5, strengthSessionsPerWeek:5, longWorkoutDay:'saturday', twoADayPreference:'preferred', calendarSource:'outlook'}` → assert `planLint.blockers` is empty.
- Then POST `/plan/generate` → assert 200 + `planId` returned (NOT `plan_quality_blocked`).
- Then iOS test: go through the New Plan sheet on staging build, complete the form, hit Generate, verify the plan lands in Training tab.

### Slices 2+3 (the E2E suite)
- Each new integration file runs under `npx vitest run __tests__/integration/`.
- Asserts on the actual route handler return values (not mocked).
- The 5 scenarios cover the 4 bugs that escaped this week + the new fix.

### Slice 4 (staging smoke)
- Run `./scripts/staging-smoke.sh` from the canonical worktree → assert the new training E2E section runs and produces evidence JSON.
- Assert the smoke output explicitly states "Training plan-create E2E: PASSED" in a way the operator can grep for.

### Cross-track end-to-end gate
After all 4 deploy-bearing slices land + deploy:
1. From iOS sim (backend on prod): open New Plan, configure 5+5+Sat+Prefer+Outlook → hit Generate → assert plan creates (no yellow blocker).
2. Cancel plan from iOS → re-open Outlook calendar via web → assert all session events removed.
3. Verify training events in Outlook show workout content (exercises, intensity, duration) not metadata.
4. Run Slice 5's Codex prompt against iOS sim → expect verdict READY.

---

## Risks

| Risk | Mitigation |
|------|-----------|
| Slice 1 fix alters strength-day picking for other users | Regression tests pin: marathon-prep with non-Sat-long unaffected; 3+3+Sat unaffected; injured-user injury-sensitive path unaffected (still uses old `softenLowerBodyLoadNearImpactDays`). |
| Slices 2+3 E2E tests are slow + flaky in CI | Use in-memory SQLite (no disk I/O), mock at network boundary only, no real timers. Budget: each test ≤ 5s. If a test exceeds 10s, split it. Add `--reporter=verbose`. |
| Slice 5 Codex prompt drifts from iOS code reality | Reference accessibility identifiers by name (not line). Codex re-discovers their current location in `TrainingView.swift` at runtime. The 5 new identifiers Codex must add are listed explicitly. |
| Slice 4 staging-smoke writes a real plan on staging that pollutes state | Preview-only (no generate). Plus optional `POST /plan/cancel` cleanup at the end. Cumulative effect = zero. |
| iOS `Two-A-Day = "Auto"` chip currently maps to `'optional'` not `'auto'` | Slice 5 Codex prompt explicitly tests this. If iOS sends `'optional'` for Auto, that's an iOS-side mapping to update; backend already accepts both. |
| New `__tests__/integration/` directory is a new code area without precedent | Follow the existing `__tests__/services/` patterns (vi.hoisted, setDbProvider, applyMigrations) so reviewers don't need to learn new conventions. |

---

## Out of scope (deferred to later plans)

- **Track C Stage 2 for calendar body**: moving `NEXUS_SECRETARY_*` markers to provider-private fields (Google `extendedProperties.private`, Outlook `singleValueExtendedProperties`). Already queued from PR #137. Requires net-new extended-properties plumbing.
- **Cloudflare Tunnel supervised service**: noted in prior session briefings, not Training-skill scope.
- **iOS New Plan visual snapshot baselines**: deferred — full Training tab + plan flow is the iOS scope, but visual-regression baselines are out (functional accessibility-identifier checks cover field presence).
- **iOS `Two-A-Day` UI label change**: if Codex finds the iOS-side mapping needs an update, that's a separate iOS PR — this plan stays backend-only on iOS-impacting changes.

---

## Claude QA checklist (what Claude verifies per PR)

For EVERY Codex PR, before approving:

**Code review (10 minutes per PR):**
- [ ] Diff is scope-bounded — only files listed in the slice's "Critical files" subsection. Reject if unrelated files appear.
- [ ] Per-slice "Claude QA criteria" bullets all pass.
- [ ] No `any` casts on iOS-faithful response payloads. Use real route handler return types.
- [ ] No `--no-verify`, `--amend`, or `--force` git operations in Codex's PR commits.
- [ ] No production HTTP calls in tests. Boundary mocks at `google-calendar`, `outlook-calendar`, `unified-calendar` (for tests that should be hermetic).
- [ ] Cross-slice contract honored — e.g., Slice 2's bug-reproducer scenario must FAIL without Slice 1's fix and PASS with it.
- [ ] PR description includes the exact `curl` payload Felipe can run on staging.

**CI evidence (1 minute per PR):**
- [ ] All GitHub CI checks green: Tests (focused), Build, Lint & Type Check, Science-policy version, CodeQL, Dependency audit, Migration check, Python content-engine audit.
- [ ] Branch is mergeable.
- [ ] No surprise dependencies added.

**Post-deploy verification (deploy-bearing slices only):**
- [ ] `curl https://api.nexushub.me/health` returns `healthy` with fresh uptime (< 5 min).
- [ ] `curl https://api.nexushub.me/public-status` returns `ok`.
- [ ] PM2 reports `nexus-hub` and `content-engine` online (verify via the deploy script's tail).
- [ ] Production version visible in `/api/snapshot` matches the auto-bump commit Codex pushed.
- [ ] If Slice 1 was just deployed: run the manual probe and confirm `planLint.blockers` is empty.
- [ ] If Slice 4 was just deployed: run `./scripts/staging-smoke.sh` from the canonical worktree and confirm the new "Training plan-create E2E" section runs and PASSES.

**Post-merge documentation:**
- [ ] Codex updated `docs/release/CURRENT_RELEASE_STATE.md` + `docs/release/current-release-index.md` after each deploy.
- [ ] New handoff doc exists under `docs/agents/handoffs/` per the template.

**Escalation triggers (Claude flags to Felipe):**
- Any CI failure that's not a known-flake.
- Any divergence between PR description and actual diff scope.
- Any test mocking shape that hides a real integration.
- Any post-deploy `/health` returning non-200 within 60s of restart.

---

## Acceptance criteria (the bar for this brief being "done")

This brief is complete when ALL of these hold:

1. **Felipe can create the bug-reproducer plan from iOS** (5+5+Sat+Prefer+Outlook) on production without hitting the yellow "Before creating" blocker. Verified by Felipe screenshot or Codex's iOS XCUITest run.
2. **Backend integration suite exists** at `__tests__/integration/` covering the 5 scenarios named in Slices 2-3. `npm run verify` test count rises by ~15.
3. **Staging-smoke runs a training plan-create E2E** on every smoke invocation, gated behind `NEXUS_SMOKE_TRAINING_E2E=1` so it can be disabled if it flakes.
4. **iOS Codex prompt file exists** at `docs/training/training-skill-ios-codex-e2e-prompt-2026-05-25.md` and is self-contained.
5. **Production is healthy** after each deploy-bearing slice. `/health` returns `healthy` within 60s of restart. `/public-status` returns `ok`.
6. **`docs/release/CURRENT_RELEASE_STATE.md` + `current-release-index.md`** reflect the new production state after each deploy-bearing slice.
7. **A handoff doc exists** for each deploy-bearing slice under `docs/agents/handoffs/`.
8. **Claude approved every PR** before merge (review comments visible on the PR).
9. **Felipe authorized every prod promote** with explicit "ship it" or equivalent.
10. **Zero new production regressions reported by Felipe** within 48h of the final deploy.

---

## Reference: prior work this brief builds on

- **PR #135 / #136 → 4.14.193** — Coach Periodization v2.1 (30 slices A0-C8, R1-R8 QA rounds) plus deploy dirty-tree stop fix.
- **PR #137 → 4.14.194** — Training bug-fix triplet:
  - Cancel cascade broadened to all `plan_version`s + Secretary-owned event enumeration.
  - `twoADayPreference: 'auto'` accepted by validator; hybrid `resolveWeeklyTargets` respects explicit per-sport asks; volume enforcer sums explicit per-sport totals.
  - Calendar body hydrates from `description_json` first, then falls back; visual divider added before markers.
- **PR #138 → 4.14.195** — `isTrainingOutlookCalendarWritesEnabled` flipped from opt-in to default-on; `TRAINING_CALENDAR_OUTLOOK_DISABLED=1` retained as kill switch.
- **Docs commit `6ef66e11`** — Updated `CURRENT_RELEASE_STATE.md` + `current-release-index.md` + `docs/agents/handoffs/2026-05-25-training-bugfixes.md` covering both deploys above.
