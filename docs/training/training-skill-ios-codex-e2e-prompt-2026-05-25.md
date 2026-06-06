# Training Skill iOS Codex E2E Prompt

Date: 2026-05-25
Backend version under test: 4.14.195 plus PR #140, branch `codex/training-no-heavy-lower-before-long-run-20260525`
Backend worktree: `/Users/felipedominguez/Desktop/Nexus Hub/worktrees/confirmation-main-promote-20260523`
iOS repo: `/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub`
iOS scheme: `Nexus Hub`
iOS simulator: `platform=iOS Simulator,name=iPhone 17 Pro`
Do not touch: `/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot`

## Goal

Build an iOS XCUITest pass for the Training tab and New Plan flow. The must-pass reproducer is Felipe's Training plan input: 5 run sessions, 5 strength sessions, Saturday long run, two-a-day Prefer, Outlook calendar source. The app must preview or generate the plan without rendering the `no_heavy_lower_before_long_run` preflight blocker.

## Setup

Run these commands exactly from the iOS repo and backend worktree:

```bash
cd "/Users/felipedominguez/Desktop/Nexus Hub/worktrees/confirmation-main-promote-20260523"
./scripts/local-up.sh
curl -f http://127.0.0.1:8200/api/v1/
```

```bash
cd "/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub"
IOS_SIM_NAME="iPhone 17 Pro" ./scripts/sim-local.sh
```

Before creating tests, run a tiny local-health check that calls `LocalEngineUITestHelpers.skipUnlessLocalEngineIsHealthy()` once. If the helper reports local backend unavailable, stop and report the backend failure instead of writing flaky UI tests.

Create a backup tag before edits:

```bash
cd "/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub"
git tag "backup/training-ios-e2e-20260525-$(date +%H%M%S)"
```

## Discover Files First

Do not assume every identifier belongs in `TrainingView.swift`. Search the iOS repo for the New Plan UI, Training tab surfaces, repository/service calls, and existing test helpers:

```bash
cd "/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub"
rg -n "New Plan|plan preview|two-a-day|calendarSource|TrainingView|generatePlan|cancel" "Nexus Hub" "Nexus HubUITests" "Nexus HubTests"
```

Known likely files include:

- `/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub/Nexus Hub/Views/Training/TrainingView.swift`
- `/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub/Nexus Hub/ViewModels/TrainingViewModel.swift`
- `/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub/Nexus Hub/Core/Services/TrainingService.swift`
- `/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub/Nexus Hub/Core/Repositories/TrainingRepository.swift`

## XCUITest Files To Create

Create `/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub/Nexus HubUITests/TrainingNewPlanCreationUITests.swift` with:

- `test_newPlanForm_loadsWithDefaults`
- `test_newPlanForm_bugReproducer_5run_5strength_Saturday_Prefer_Outlook`
- `test_newPlanForm_twoADayPicker_allValues`
- `test_newPlanForm_calendarSource_outlook`
- `test_newPlanForm_preflightWarning_renders`

Create `/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub/Nexus HubUITests/TrainingTabFlowUITests.swift` with:

- `test_trainingTab_today_rendersSession`
- `test_trainingTab_week_rendersAllDays`
- `test_trainingTab_sessionDetail_rendersFullPrescription`
- `test_trainingTab_cancel_clearsAllSessions`
- `test_trainingTab_reflow_movesSession`

Use `-NEXUSQATrainingFixture rich-v1` for tests that only need seeded state. Use `LocalEngineUITestHelpers.makeAppPointingAtLocalEngine()` for tests that must hit the real local backend.

## Accessibility Identifiers

Add or verify these identifiers on the actual controls after file discovery:

- `training-two-a-day-picker`
- `training-preflight-warning-card`
- `training-preflight-warning-text`
- `training-preview-button`
- `training-generate-button`
- `training-cancel-button`

Existing nearby identifiers may use older names such as `plan-sheet-two-a-day-picker` or `training-generate-plan-button`. Keep backward-compatible identifiers where existing tests depend on them, but expose the required names above for this E2E suite.

## Assertion Patterns

Every UI lookup must wait before asserting:

```swift
XCTAssertTrue(element.waitForExistence(timeout: 5))
```

Use `LocalEngineUITestHelpers.skipUnlessLocalEngineIsHealthy()` before real-backend tests. In `tearDown`, tap `training-cancel-button` when it exists so a created plan does not leak into the next test. For the bug reproducer, assert that `training-preflight-warning-text` does not contain `Heavy lower-body strength scheduled the day before a long run`.

## Two-A-Day Contract

Test all four backend values: `never`, `optional`, `preferred`, and `auto`. Report the iOS mapping explicitly. The backend accepts `auto`; older iOS code may map the Auto chip to `optional`, so the test must make that mismatch visible instead of silently passing.

## Run Commands

```bash
cd "/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub"
IOS_SCHEME="Nexus Hub" IOS_SIM_NAME="iPhone 17 Pro" ./scripts/ios-single-simulator-test.sh -only-testing:"Nexus HubUITests/TrainingNewPlanCreationUITests"
```

```bash
cd "/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub"
IOS_SCHEME="Nexus Hub" IOS_SIM_NAME="iPhone 17 Pro" ./scripts/ios-single-simulator-test.sh -only-testing:"Nexus HubUITests/TrainingTabFlowUITests"
```

## Report Template

Write the validation report to `/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub/docs/qa/2026-05-25-training-e2e/validation.md` and mirror the shape of `/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub/docs/ios/training-expert-coach-ios-codex-validation.md`.

Required sections:

- Verdict: `READY`, `READY_WITH_CONDITIONS`, or `NOT_READY`
- Evidence table: claim, status, E1-E5 evidence, notes
- Contract readiness: backend payload fields, iOS decoder fields, UI identifiers
- Test results: pass/fail count per test class
- Environment: simulator, iOS runtime, Xcode version, backend commit, iOS commit
- Screenshots: store under `/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub/docs/qa/2026-05-25-training-e2e/`
- Bugs found: reproduction steps, expected behavior, actual behavior, logs/screenshots

Do not mark the iOS flow ready if the reproducer still shows the heavy-lower-before-long-run warning, if the generated plan leaves active test state after teardown, or if the tests only mock the backend path that is supposed to be covered end-to-end.
