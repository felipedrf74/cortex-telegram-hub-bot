# Agent Handoff - Training Plan UX Validation

## Session Summary

**Date**: 2026-06-23  
**Branch**: `main`  
**Worktree**: `/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot` plus `/Users/felipedominguez/Developer/Nexus Hub IOS/Nexus Hub`  
**Agent**: Codex  
**Maximum claim**: `L2` local backend/iOS simulator validation only. No L3 peer-review, L4 staging, L5 production, TestFlight, or live-provider claim.  
**Authorization boundary**: no deploy, no commit, no push, no TestFlight, no production/staging/live Hotmail/calendar writes.

## What Changed

- Backend Training validation harness now emits:
  - 17 bounded axes.
  - 50 validation scenarios.
  - 50 per-plan quality matrix rows.
  - Output/training/calendar/evidence/progression/variation scoring columns.
  - Hotmail QA account default: `nexushubbot@hotmail.com`.
  - Separate local simulator/debug-auth sandbox account: `nexushubbot@gmail.com`.
- Agenda validation now:
  - Matches by `sessionIdentityKey` first, then falls back to `sessionId` only for keyless agenda items.
  - Treats `planned`, `scheduled`, and `synced` as equivalent.
  - Excludes skipped/canceled/deferred planned sessions.
  - Compares plan id, version, date, timezone, title/type, start time, duration, and status.
- Training quality scoring now includes:
  - `deload_logic`.
  - standalone `safety_downgrades`.
  - expanded `equipment_fit`.
  - `objective_fidelity`.
  - `weight_loss` QA warning detection without runtime goal-inference changes.
- iOS Training plan builder now:
  - Shows pre-preview review summary.
  - Preserves `optional` two-a-day selection in picker/prefill.
  - Uses a direct calendar-label helper for preview story.
  - Keeps preview/create gated through the existing fingerprint logic.
  - Scopes first-run wearable skip by authenticated scope.
- Backend plan creation now persists `twoADayPreference` into `preferences_json`.
- iOS Training repository now treats `/training/plan/weeks` active plan metadata as an active-plan fallback only when `lifecycleState == "active"`, so null/inactive all-weeks responses keep the first-run gate active.
- DEBUG local smoke fixtures now clear only the current fixture account's scoped wearable skip state to keep UI tests isolated.
- The unrelated Nexus Points release-gate blocker was closed by pinning a deterministic test clock in the fixture; runtime code was not changed.

## Files Changed

Backend:

- `package.json`
- `src/api/routes/training-plan-generation.ts`
- `src/services/training-plan-creation-validation.ts`
- `src/tools/training-plan-creation-validation-matrix.ts`
- `__tests__/integration/training-plan-create-cycle.test.ts`
- `__tests__/services/training-plan-creation-validation.test.ts`
- `__tests__/services/nexus-points.test.ts`
- `docs/qa/TRAINING_PLAN_UX_VALIDATION_CLAUDE_QA_PROMPT.md`
- `docs/_workspace-mirror/docs/agents/handoffs/2026-06-23-training-plan-ux-validation.md`

iOS:

- `/Users/felipedominguez/Developer/Nexus Hub IOS/Nexus Hub/Nexus Hub/Core/Repositories/TrainingRepository.swift`
- `/Users/felipedominguez/Developer/Nexus Hub IOS/Nexus Hub/Nexus Hub/Core/TrainingLocalSmokeFixtures.swift`
- `/Users/felipedominguez/Developer/Nexus Hub IOS/Nexus Hub/Nexus Hub/Views/Training/TrainingView.swift`
- `/Users/felipedominguez/Developer/Nexus Hub IOS/Nexus Hub/Nexus Hub/Views/Training/TrainingPlanBuilderSummaryResolver.swift`
- `/Users/felipedominguez/Developer/Nexus Hub IOS/Nexus Hub/Nexus Hub/Views/Training/Today/TrainingFirstRunGateView.swift`
- `/Users/felipedominguez/Developer/Nexus Hub IOS/Nexus Hub/Nexus Hub/Views/Training/Today/TrainingFirstRunWearableSkipStore.swift`
- `/Users/felipedominguez/Developer/Nexus Hub IOS/Nexus Hub/Nexus HubTests/TrainingPlanBuilderSummaryResolverTests.swift`
- `/Users/felipedominguez/Developer/Nexus Hub IOS/Nexus Hub/Nexus HubTests/TrainingRepositoryAllWeeksTests.swift`
- `/Users/felipedominguez/Developer/Nexus Hub IOS/Nexus Hub/Nexus HubUITests/TrainingFixtureBypassUITests.swift`

Preserved:

- `/Users/felipedominguez/Developer/Nexus Hub IOS/Nexus Hub/test-summary.json` remains pre-existing untracked state and was not edited.

Cleaned:

- Removed stale duplicate conflict-copy docs with ` 2.md` suffix.
- Restored generated timestamp drift in `docs/release/eval-evidence/registry-shadow-parity-latest.json`.
- Removed generated iOS `DerivedData/`.

## Verification Performed

Backend:

- `scripts/changed-area-classifier.sh --json`
  - PASS; selected full Vitest and cannot-skip Training create coverage.
- `npx vitest run __tests__/services/training-plan-creation-validation.test.ts __tests__/integration/training-plan-create-cycle.test.ts`
  - PASS: 2 files, 19 tests.
- `npm run training:plan-validation-matrix -- --qa-account=nexushubbot@hotmail.com`
  - PASS parsed summary: 50 scenarios, 50 quality rows, duplicate ids `[]`, missing axis coverage `[]`, verdict counts `{ pass: 49, warn: 1, fail: 0 }`.
  - Top-level output includes `authorizationRequired: true`, `productionWritesForbiddenByDefault: true`, and `localSimulatorAccountEmail: "nexushubbot@gmail.com"`.
- `npx vitest run __tests__/services/nexus-points.test.ts --reporter=verbose`
  - PASS: 1 file, 11 tests.
- `npm run release:focused-verify`
  - PASS: 859 Vitest files / 12,572 tests passed; 181 Python tests passed; typecheck, science-policy, build, and migration safety passed.
- `npm run release:verify:full`
  - PASS: same passing counts as focused verify.
- `scripts/risk-gate.sh`
  - PASS: 859 Vitest files / 12,572 tests passed.
  - Gating option (a) was taken: the unrelated Nexus Points fixture-time drift was fixed.
- `npm run docs:audit`
  - PASS command exit 0 with existing warning baseline.

iOS:

- XcodeBuildMCP `build_sim`, scheme `Nexus Hub`, Debug.
  - PASS.
  - Build log: `/Users/felipedominguez/Library/Developer/XcodeBuildMCP/workspaces/cortex-telegram-hub-bot-f9372b678f4b/logs/build_sim_2026-06-23T20-48-32-033Z_pid8790_156e616d.log`.
- XcodeBuildMCP `test_sim`, selected:
  - `Nexus HubTests/TrainingRepositoryAllWeeksTests`
  - `Nexus HubTests/TrainingPlanBuilderSummaryResolverTests`
  - `Nexus HubTests/TrainingFirstRunWearableSkipStoreTests`
  - `Nexus HubTests/TrainingFirstRunGateResolverTests`
  - PASS: 24 selected tests, 0 failed.
  - Result bundle: `/Users/felipedominguez/Library/Developer/XcodeBuildMCP/workspaces/cortex-telegram-hub-bot-f9372b678f4b/result-bundles/test_sim_2026-06-23T20-49-13-174Z_pid8790_270b9f0d.xcresult`.
- XcodeBuildMCP `test_sim`, scheme `Nexus Hub Debug UI Smoke`, selected `Nexus HubUITests/TrainingFixtureBypassUITests`.
  - Final rerun PASS: 18 tests, 0 failed, 0 skipped.
  - Result bundle: `/Users/felipedominguez/Library/Developer/XcodeBuildMCP/workspaces/cortex-telegram-hub-bot-f9372b678f4b/result-bundles/test_sim_2026-06-23T21-08-09-718Z_pid8790_afba18d8.xcresult`.

Local engine create/write E2E:

- Previously authorized local-only execution used:
  - Docker local engine at `http://127.0.0.1:8200`.
  - Local-only simulator/debug-auth account `nexushubbot@gmail.com`.
  - No production/staging/live Hotmail/provider/calendar writes.
- Scenario:
  - Event-based local E2E running plan.
  - Race date `2026-09-20`.
  - 1-week duration.
  - 6 generated sessions: 4 run + 2 gym/strength.
  - Long-workout day Saturday.
  - `twoADayPreference: optional`.
  - Calendar source auto/null, no connected provider.
- Preview/create:
  - Created plan id `6`, events created `0`, `calendarSync.status = not_synced`, `sessionsAttempted = 6`, `unscheduled = 6`.
  - Quality matrix row: verdict `pass`, score `95`.
- Cleanup:
  - `POST /api/v1/training/plan/cancel` removed plan `6`.
  - DB cleanup found 0 active plans and 0 residual plan/session/agenda/ownership rows for plan `6`.

## Plan Quality Matrix

The static/offline matrix now requires each row to include:

- scenario id
- objective
- goal mode
- duration bucket
- sessions/week
- sport split
- strength split
- two-a-day preference
- long-workout day
- calendar source
- readiness state
- equipment state
- profile state
- preview status
- create status
- agenda status
- quality verdict
- total score
- blockers
- warnings
- evidence ids

Scoring columns cover:

- Output quality: valid contract, complete weeks/sessions, no raw/debug/private text, deterministic shape.
- Training quality: periodization, recovery spacing, intensity distribution, strength balance, equipment fit, readiness adaptation, safety downgrades.
- Calendar quality: one agenda item per synced planned session, no duplicates, identity/date/timezone/title/type/duration/status/version match.
- Evidence structure: WHO physical activity minimums, ACSM FITT-VP, ACSM resistance training guidance, IOC REDs safety flags, endurance intensity-distribution review, HIIT/MICT caution.
- Progression: weekly load changes, deload/taper/recovery rationale, long-workout progression, no incoherent jumps.
- Variation: same inputs deterministic, changed goals/readiness/equipment/calendar produce meaningful plan differences.

## Verifiable Reward Summary

**Verdict**: PASS  
**Score**: 100  
**Effective area**: backend  
**Hard failures**: none  
**Raw evidence**: `.local/reward-runs/2026-06-23T21-20-50-306Z-f75d4716-adbf-497c-94c6-41ab59033a88.json`

Evidence:

- `changed-area-classifier` passed.
- `docs-audit` passed.
- `handoff-reward-summary` passed.
- `backend-verification-evidence` passed.
- `reward-schema-present` passed.
- `verify-deliverable` passed for `L2`.

Skipped checks:

- None.

Interpretation:

- The local advisory reward loop accepts the backend evidence and handoff hygiene.
- Export eligibility remains ineligible pending manual human review.

## Limits

- This handoff claims `L2` local evidence only.
- It does not claim independent peer validation, staging validation, production validation, TestFlight validation, or live Hotmail/calendar-provider behavior.
- Live Hotmail/provider/calendar E2E remains blocked without explicit owner authorization.
- Calendar/agenda creation with a real provider remains live/staging-authorized-only.
- The quality matrix is bounded axis coverage, not the full Cartesian product.

## Local-Engine iOS Simulator QA Plan

The representative local-engine write path above has been executed locally. Use
this plan for the remaining broader simulator sweep and any staging/provider
extension. It must still avoid production and live provider writes unless
separately authorized.

1. Preflight:
   - Confirm backend and iOS git state.
   - Preserve unrelated iOS `test-summary.json`.
   - Run `scripts/changed-area-classifier.sh --json`.
   - Confirm no production/staging base URL or provider-write credentials are active.
2. Start local engine:
   - `./scripts/local-up.sh`.
   - Verify `http://127.0.0.1:8200/api/v1/` health.
   - Keep Docker/container logs available.
3. Auth:
   - Use `nexushubbot@gmail.com` for local simulator/debug-auth unless Felipe explicitly authorizes Hotmail in local/staging.
   - Mint/import DEBUG-only simulator auth with the existing local auth helper.
4. Matrix seed:
   - Run static matrix CLI and persist bounded scenario ids.
   - For each bounded scenario, capture output quality, training quality, calendar/agenda creation, evidence structure, progression, readiness/adaptation/safety, and variation/determinism.
5. iOS simulator execution:
   - Launch the app with local base URL `http://127.0.0.1:8200`.
   - For representative matrix rows, drive Skills Hub -> Training -> Today -> first-run/create-plan sheet.
   - Verify summary-before-preview, preview response, option-change invalidation, create readiness after matching preview, and create.
   - Capture screenshots/snapshots for summary, invalidation, create-ready preview, Plan screen, Today screen, Agenda/calendar sync row, and session detail.
6. Plan-to-agenda assertions:
   - Compare backend plan weeks, iOS Plan, iOS Today, and local Agenda/calendar rows.
   - Require one agenda row per synced planned session, no duplicates, matching identity/date/timezone/title/type/duration/status/version.
   - Exercise refresh, sync retry, skip, complete, adjust, keep-original, regenerate, and cancel flows where local backend supports them.
7. Visual/accessibility pass:
   - Repeat critical Training screens in light mode, dark mode, and large Dynamic Type.
   - Verify text does not overlap and buttons remain hittable.
8. Cleanup:
   - Delete only local test-created plans/events.
   - Stop app and local containers.
   - Keep raw logs/artifacts under ignored local evidence paths.

## Claude Code QA Prompt

Updated code-level-only prompt:

- `docs/qa/TRAINING_PLAN_UX_VALIDATION_CLAUDE_QA_PROMPT.md`

Claude should not use simulator/browser/live accounts. Claude should review code
and test evidence only.
