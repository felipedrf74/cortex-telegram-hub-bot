# Training Skill E2E Validation Handoff - 2026-06-25

## Goal

Implement the Training Skill improvement plan and validate Training end to end across backend generation, quality gates, learning paths, read models, feedback/progression, calendar truthfulness, degraded states, and Nexus Hub iOS Today/Plan/Progress UI. Validation must use a freshly built isolated backend container plus a dedicated iOS simulator, without reusing or disrupting another worktree's engine or simulator.

## Final Status

- Backend implementation: complete for the scoped Training improvement plan.
- Fixture-safe backend E2E lane: passed against isolated run `training-e2e-ab83-followups-final-20260625t1111z`.
- iOS simulator E2E lane: passed, 23 tests, 23 passed, 0 failed, 0 skipped, against the same isolated backend.
- Plan-generation quality gates: passed.
- Release/container verification: passed after QA follow-up fixes.
- Live sandbox Google/Outlook calendar lane: blocked before writes because sandbox credentials, explicit live-write ack, and live-calendar backend opt-in were absent.
- Production deploy, production calendar writes, commits, pushes, and live provider mutations: not performed.

## Implemented

### Backend Training

- Expanded Training profile/intake support for modality-specific inputs, constraints, recovery, injuries, schedule, equipment, goals, blocked/preferred days, and sport profile details.
- Strengthened plan quality validation across strength, endurance, hybrid, swim, bike, triathlon, injury/discomfort, travel, stale wearable, race-prep, and poor-adherence scenarios.
- Added/strengthened hard blockers for endurance hard/easy balance, interval density, swim-without-pool feasibility, catalog-compatible replacements, and unsafe fallback plans.
- Added learning-path generation through `src/services/training-learning-path.ts`, including weekly focus, phase goals, rationale, technique/assessment hooks, and tests.
- Tightened feedback/progression/read-model behavior for easy/normal/hard feedback, soreness, pain, partial completion, repeated misses, skips, and no-plan recovery.
- Hardened calendar truthfulness: fixture-safe sync reports disabled/no-provider states; provider-disconnected read models degrade truthfully; plan-created messages no longer imply calendar events when none were created.
- Reduced brittle Training intent routing by adding typed classifier fallback behavior while preserving deterministic fast paths.
- Fixed timezone-sensitive schedule/history tests by evaluating Training windows in the configured app timezone instead of host-local date math.
- Fixed env isolation in user/OAuth tests so owner token migration and test user creation do not leak host env into Training suites.

### E2E Harness

- Added isolated compose harness: `docker-compose.training-e2e.yml`.
- Added Training E2E scripts:
  - `scripts/training-e2e-up.sh`
  - `scripts/training-e2e-down.sh`
  - `scripts/training-e2e-env.sh`
  - `scripts/training-e2e-smoke.sh`
  - `scripts/training-e2e-flow.mjs`
  - `scripts/training-e2e-ios-seed.mjs`
  - `scripts/training-e2e-ios.sh`
  - `scripts/training-e2e-live-calendar.ts`
- The fixture lane uses unique compose project names, unique host ports, isolated DB/log/data paths under `.local/training-e2e/<run-id>/`, no fixed `container_name`, and refuses default local backend/content ports.
- Metadata records git SHA/status, image IDs/digests, compose project, ports, DB path, auth import path, SQLite mode, and live-calendar mode.
- Release-container scripts now handle git worktree `.git` files by mounting the actual gitdir/common-dir.
- `changed-area-classifier.sh` and `risk-gate.sh` now support explicit-file/dry-run flows without requiring an unrelated git base probe.

### iOS

- Added real isolated-backend UI coverage in `/Users/felipedominguez/Developer/Nexus Hub IOS/Nexus Hub/Nexus HubUITests/TrainingIsolatedBackendE2EUITests.swift`.
- Added a workspace-local Training E2E config pointer in `scripts/training-e2e-ios.sh` and read support in `/Users/felipedominguez/Developer/Nexus Hub IOS/Nexus Hub/Nexus HubUITests/LocalEngineUITestHelpers.swift`, so the UI test runner and app prove they are pointed at the isolated backend instead of `127.0.0.1:8200`.
- Updated `/Users/felipedominguez/Developer/Nexus Hub IOS/Nexus Hub/Nexus HubUITests/TrainingValidationUITests.swift` so the no-plan create-plan validation uses the DEBUG fixture path, waits for the Generate step to become hittable, and asserts the stepper's accessibility value reaches `5`.
- Preserved full Training fixture coverage in `/Users/felipedominguez/Developer/Nexus Hub IOS/Nexus Hub/Nexus HubUITests/TrainingFixtureBypassUITests.swift`, including first-run gate, no-plan plan creation, builder preview gating, Today, Plan, Progress, reflow rationale, sync row, calendar cleanup overlay, wearable skip scoping, and visual screenshots.

## Final Evidence

### Isolated Container Lane

- Run id: `training-e2e-ab83-followups-final-20260625t1111z`.
- Metadata: `.local/training-e2e/training-e2e-ab83-followups-final-20260625t1111z/metadata.json`.
- Backend URL: `http://127.0.0.1:18200`.
- Content engine URL: `http://127.0.0.1:18100`.
- Compose project: `nexus-training-e2e-ab83-followups-final-20260625t1111z`.
- DB path: `.local/training-e2e/training-e2e-ab83-followups-final-20260625t1111z/data/training-e2e.db`.
- Git commit in metadata: `3ac095b891c5f60dcbf6c86f0d2f060a871ac747`.
- Backend image digest: `sha256:cf892ad3b8d5eded07442614d8d3891434630131e77f1c703423f1187dea080e`.
- Content engine image digest: `sha256:72fa4730320d2a1845c35a81fb3615f0247b967e83b641e064987dd8619820d4`.
- Calendar mode: fixture-safe, `liveCalendar.enabled=false`, `writesEnabled=false`, `syncEnabled=false`.
- `/api/snapshot`: version `4.14.209`.
- Cleanup: `npm run training:e2e:down` stopped and removed the isolated containers; state directory preserved.

### Backend Commands

- `npm run typecheck` - passed.
- Focused Training Vitest suites - passed, 8 files, 207 tests.
- `npm run science-policy:check` - passed.
- `scripts/changed-area-classifier.sh --json` - passed.
- `scripts/risk-gate.sh` - passed, 864 files, 12,649 tests.
- `CONTENT_ENGINE_PYTHON="$PWD/.local/content-engine-release-venv/bin/python" npm run release:focused-verify` - passed.
- `CONTENT_ENGINE_PYTHON="$PWD/.local/content-engine-release-venv/bin/python" npm run release:verify:full` - passed.
- `npm run training:plan-validation-matrix` - passed, 50 scenarios, 49 pass, 1 warn, 0 fail.
- `npm run eval:training` - passed after sequential rerun, score 99/100, 210 cases; artifacts under `reports/training-eval/training-eval-2026-06-25T10-33-57-558Z.*`.
- `npm run release:verify:container` - passed; final image manifest list `sha256:373b11a31b10c16123aa63d4dc1744c5c8780b2e69414f6ec353c409a7db1d67`; Vitest 864 files/12,649 tests passed; Python content-engine 181 passed, 1 warning.
- `npm run training:e2e:up` - passed for run `training-e2e-ab83-followups-final-20260625t1111z`.
- `npm run training:e2e:smoke` - passed.
- `npm run training:e2e:flow` - passed.
- `npm run training:e2e:live-calendar` - fail-closed blocker, no provider writes.
- `npm run training:e2e:down` - passed.

### Fixture-Safe Backend Flow

Evidence file: `.local/training-e2e/training-e2e-ab83-followups-final-20260625t1111z/training-flow-evidence.json`.

Validated steps:

- `no_plan_home`
- `plan_preview`
- `plan_generate`
- `calendar_sync_provider_safe`
- `plan_read_model`
- `feedback_variants_and_repeated_skips`
- `read_models_after_feedback`
- `reflow_preview_provider_safe`
- `cancel_cleanup_and_no_plan_recovery`

The flow verified profile seeding, plan preview, generation, learning path, activation/read models, calendar-disabled truthfulness, feedback variants, soreness/pain/partial/repeated-miss signals, progression/read-model updates, provider-safe reflow, cancel cleanup, and no-plan recovery.

### iOS Simulator Lane

- Command: `NEXUS_TRAINING_E2E_RUN_ID=training-e2e-ab83-followups-final-20260625t1111z NEXUS_TRAINING_E2E_IOS_ROOT="/Users/felipedominguez/Developer/Nexus Hub IOS/Nexus Hub" npm run training:e2e:ios`.
- Final log: `.local/training-e2e/training-e2e-ab83-followups-final-20260625t1111z/ios/ios-full-final.log`.
- Result bundle: `.local/training-e2e/training-e2e-ab83-followups-final-20260625t1111z/ios/TrainingE2E.xcresult`.
- Summary JSON: `.local/training-e2e/training-e2e-ab83-followups-final-20260625t1111z/ios/test-summary.json`.
- Dedicated simulator: `49D8494D-40C0-4C2C-B0FE-3471A80E0ADF`, `Nexus Training E2E training-e2e-ab83-followups-final-20260625t1111z`, iPhone 17 Pro, iOS Simulator 27.0.
- Seeded plan for final run: plan id `8`, `Training E2E Active Plan training-e2e-ab83-followups-final-20260625t1111z`.
- Backend used by iOS run: `http://127.0.0.1:18200`.
- Result: 23 total, 23 passed, 0 failed, 0 skipped.
- Screenshots/attachments included:
  - `TrainingE2E_Today_training-e2e-ab83-followups-final-20260625t1111z`
  - `TrainingE2E_Plan_training-e2e-ab83-followups-final-20260625t1111z`
  - `TrainingE2E_Progress_training-e2e-ab83-followups-final-20260625t1111z`
  - fixture screenshot pack for briefing, readiness, week strip, hybrid week overview, session details, and reflowed cycling detail.

iOS validated:

- App and UI test process used the run-scoped isolated backend config, not default `127.0.0.1:8200`.
- Auth import signed into the isolated E2E user and bypassed welcome for the backend E2E test.
- No-plan first-run/profile gate rendered through fixtures.
- Plan creation sheet opened, preview/review gating worked, and strength sessions accepted `5`.
- Today rendered real Training content and coach state from the isolated backend.
- Plan rendered roadmap, backend plan name, week learning focus, and calendar sync row.
- Progress rendered after completion feedback and exposed history.
- Feedback sheet opened and submitted to the isolated backend.
- Reflow/swap rationale, preferred-time conflict, wearable skip scoping, cancel cleanup overlay, bottom-tab stress, and visual Training fixture states rendered correctly.
- Healthy-backend Today contract banner did not claim degraded/local fallback.

### Live Sandbox Calendar Lane

Blocked, not executed against Google or Outlook.

Executed command: `npm run training:e2e:live-calendar`.

Observed fail-closed result:

- Status: exit 1.
- Log: `.local/training-e2e/training-e2e-ab83-followups-final-20260625t1111z/live-calendar.log`.
- Error: `Live calendar lane requires a backend started with NEXUS_TRAINING_E2E_LIVE_CALENDAR=1.`
- No Google or Outlook writes were attempted.

Read-only env preflight also found these missing inputs:

- `NEXUS_TRAINING_E2E_LIVE_CALENDAR_ACK` with required value `sandbox-non-prod-calendar`.
- `OAUTH_ENCRYPTION_KEY`.
- Google: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `NEXUS_TRAINING_E2E_GOOGLE_REFRESH_TOKEN`, `NEXUS_TRAINING_E2E_GOOGLE_ACCOUNT_LABEL`.
- Outlook: `OUTLOOK_CLIENT_ID`, `OUTLOOK_CLIENT_SECRET`, `OUTLOOK_TENANT_ID`, `NEXUS_TRAINING_E2E_OUTLOOK_REFRESH_TOKEN`, `NEXUS_TRAINING_E2E_OUTLOOK_ACCOUNT_LABEL`.

The live harness is implemented and guarded, but full provider lifecycle remains blocked until Felipe supplies dedicated non-prod Google/Outlook sandbox credentials and explicit live-write authorization. A separate live-calendar backend run must be started with `NEXUS_TRAINING_E2E_LIVE_CALENDAR=1`; the fixture-safe backend used for accepted proof intentionally had live writes disabled.

### Degraded And Stale States

- Backend degraded/truthful states were covered through calendar-disabled sync (`TRAINING_CALENDAR_SYNC_DISABLED`), provider-safe reflow (`NO_CALENDAR`), provider-disconnected read-model tests, fallback-generation tests, and no-plan recovery.
- iOS healthy-backend truthfulness was covered by asserting Today did not claim degraded/local fallback while the isolated backend was healthy.
- iOS live backend-interruption/stale transition was not executed. Exact blocker: the current XCTest path performs a preflight reachability check and has no safe in-test control channel to pause only the isolated backend after initial render while keeping the same simulator session alive. Add a dedicated test hook or manual simulator procedure before claiming this specific acceptance point.

## Files Changed

### Backend and Harness

- `package.json`
- `docker-compose.training-e2e.yml`
- `scripts/changed-area-classifier.sh`
- `scripts/risk-gate.sh`
- `scripts/release-evidence-container.sh`
- `scripts/release-verify-container.sh`
- `scripts/training-e2e-down.sh`
- `scripts/training-e2e-env.sh`
- `scripts/training-e2e-flow.mjs`
- `scripts/training-e2e-ios-seed.mjs`
- `scripts/training-e2e-ios.sh`
- `scripts/training-e2e-live-calendar.ts`
- `scripts/training-e2e-smoke.sh`
- `scripts/training-e2e-up.sh`
- `scripts/wait-for-health.sh`
- `src/api/routes/training-plan-generation.ts`
- `src/api/routes/training-plan-persistence.ts`
- `src/api/routes/training-read-models.ts`
- `src/api/routes/training-schedule-utils.ts`
- `src/services/coach-kernel/evaluation/personas.ts`
- `src/services/coach-kernel/evaluation/scenarios.ts`
- `src/services/coach-kernel/plan-linter.ts`
- `src/services/coach-kernel/training-plan-quality-gate.ts`
- `src/services/coach-kernel/training-taxonomy.ts`
- `src/services/coach-kernel/types.ts`
- `src/services/onboarding.ts`
- `src/services/skills/training/helpers.ts`
- `src/services/skills/training/intent-detectors.ts`
- `src/services/skills/training/parser.ts`
- `src/services/training-coach-kernel-plan-generator.ts`
- `src/services/training-generation-observability.ts`
- `src/services/training-history.ts`
- `src/services/training-learning-path.ts`
- `src/services/training-plan-creation-validation.ts`
- `src/services/training-profile-model.ts`
- `src/services/training-session-description.ts`

### Backend Tests and Docs

- `__tests__/api/training-plan-calendar-sync.test.ts`
- `__tests__/api/training-plan-generation.test.ts`
- `__tests__/api/training-plan-persistence.test.ts`
- `__tests__/api/training-read-models.test.ts`
- `__tests__/api/training-routes.test.ts`
- `__tests__/api/training-schedule-utils.test.ts`
- `__tests__/scripts/training-e2e-harness.test.ts`
- `__tests__/services/coach-kernel-evaluation.test.ts`
- `__tests__/services/coach-kernel-plan-linter.test.ts`
- `__tests__/services/oauth-store.test.ts`
- `__tests__/services/onboarding-qa.test.ts`
- `__tests__/services/onboarding-sport-profiles.test.ts`
- `__tests__/services/skills/training-intent-detectors.test.ts`
- `__tests__/services/skills/training-parser-executor.test.ts`
- `__tests__/services/training-coach-kernel-plan-generator.test.ts`
- `__tests__/services/training-generation-observability.test.ts`
- `__tests__/services/training-history.test.ts`
- `__tests__/services/training-learning-path.test.ts`
- `__tests__/services/training-plan-creation-validation.test.ts`
- `__tests__/services/training-plan-quality-gate.test.ts`
- `__tests__/services/training-profile-model.test.ts`
- `__tests__/services/training-skill-hardening-source-contract.test.ts`
- `__tests__/services/user-service.test.ts`
- `docs/agents/handoffs/2026-06-25-training-skill-e2e-validation.md`
- `docs/engineering/testing-and-qa-harness-standard.md`
- `docs/training/eval-persona-bank.md`
- `docs/training/eval-scenario-bank.md`

### iOS

- `/Users/felipedominguez/Developer/Nexus Hub IOS/Nexus Hub/Nexus Hub.xcodeproj/xcshareddata/xcschemes/Nexus Hub Debug UI Smoke.xcscheme`
- `/Users/felipedominguez/Developer/Nexus Hub IOS/Nexus Hub/Nexus HubUITests/LocalEngineUITestHelpers.swift`
- `/Users/felipedominguez/Developer/Nexus Hub IOS/Nexus Hub/Nexus HubUITests/TrainingFixtureBypassUITests.swift`
- `/Users/felipedominguez/Developer/Nexus Hub IOS/Nexus Hub/Nexus HubUITests/TrainingIsolatedBackendE2EUITests.swift`
- `/Users/felipedominguez/Developer/Nexus Hub IOS/Nexus Hub/Nexus HubUITests/TrainingValidationUITests.swift`
- `/Users/felipedominguez/Developer/Nexus Hub IOS/Nexus Hub/scripts/ios-single-simulator-test.sh`

Note: the iOS working tree contains unrelated pre-existing dirty files from parallel work. Review only the scoped Training E2E files above for this task.

## Expected User-Visible Behavior

- Training produces safer, more personalized, more educational plans across strength, run, bike, swim, triathlon, hybrid, travel, injury/discomfort, fatigue, stale wearable, no wearable, calendar-conflict, and race-prep contexts.
- Plans include learning focus and rationale, not just session lists.
- Unsafe, infeasible, generic, or incoherent plans are blocked or clearly warned before persistence.
- Feedback and adherence signals update Training read models and progression/reflow decisions.
- iOS Today, Plan, and Progress render real Training content from the backend and avoid invented fallback/degraded claims.
- Calendar-disabled/provider-disconnected states are truthful; live provider writes require explicit sandbox authorization.

## Residual Risks And Required Follow-Up

- Live Google/Outlook calendar lifecycle remains unexecuted until sandbox credentials, sandbox account labels, `OAUTH_ENCRYPTION_KEY`, explicit ack, and a live-calendar backend run are available.
- iOS live backend-interruption/stale transition remains unexecuted until a safe in-test backend pause/resume hook or manual simulator procedure exists.
- No production deploy, live calendar mutation, commit, push, or TestFlight action was performed.
- Raw provider tokens/secrets were not present and were not requested or logged.

## Verifiable Reward Summary

- **Verdict**: MANUAL_REQUIRED.
- **Score**: 86.
- **Area**: release, auto-selected because the change touches package, compose, runtime, release-adjacent, and E2E harness files.
- **Hard failures**: none observed in reward output.
- **Mandatory checks**: changed-area classifier passed; docs audit passed; handoff reward summary passed; reward schema present; release-verification evidence was skipped/manual-review because staging smoke, production health, and deploy authorization were out of scope.
- **Skipped checks and reasons**: live Google/Outlook sandbox writes were blocked by missing sandbox credentials and explicit live-write authorization; production deploy, production calendar writes, commits, pushes, TestFlight, staging smoke, and production health checks were intentionally out of scope.
- **Evidence commands**: focused Training Vitest suites; `npm run typecheck`; `scripts/changed-area-classifier.sh --json`; `scripts/risk-gate.sh`; `npm run science-policy:check`; `CONTENT_ENGINE_PYTHON="$PWD/.local/content-engine-release-venv/bin/python" npm run release:focused-verify`; `CONTENT_ENGINE_PYTHON="$PWD/.local/content-engine-release-venv/bin/python" npm run release:verify:full`; `npm run training:plan-validation-matrix`; `npm run eval:training`; `npm run release:verify:container`; `npm run training:e2e:up`; `npm run training:e2e:smoke`; `npm run training:e2e:flow`; `npm run training:e2e:ios`; `npm run training:e2e:live-calendar` fail-closed preflight; `npm run training:e2e:down`; `npm run docs:audit`; `node scripts/reward-check.mjs --area auto --handoff docs/agents/handoffs/2026-06-25-training-skill-e2e-validation.md --advisory`.
- **Evidence artifacts**: `.local/training-e2e/training-e2e-ab83-followups-final-20260625t1111z/metadata.json`; `.local/training-e2e/training-e2e-ab83-followups-final-20260625t1111z/training-flow-evidence.json`; `.local/training-e2e/training-e2e-ab83-followups-final-20260625t1111z/training-ios-seed-evidence.json`; `.local/training-e2e/training-e2e-ab83-followups-final-20260625t1111z/ios/test-summary.json`; `.local/training-e2e/training-e2e-ab83-followups-final-20260625t1111z/ios/TrainingE2E.xcresult`; `.local/training-e2e/training-e2e-ab83-followups-final-20260625t1111z/live-calendar.log`; `reports/training-eval/training-eval-2026-06-25T10-33-57-558Z.json`; raw reward JSON under `.local/reward-runs/`.
- **Raw reward run**: `.local/reward-runs/2026-06-25T11-57-42-999Z-3ed444cc-c773-4119-924c-596d6d63a057.json`.
- **Export eligibility**: ineligible; manual reward runs require human review before export.
