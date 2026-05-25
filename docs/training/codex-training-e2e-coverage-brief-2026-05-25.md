# Corrected Codex Brief — Training Reliability E2E Coverage

Date: 2026-05-25
Status: Corrected after QA review; this file supersedes the earlier Claude draft.
Canonical backend worktree: `/Users/felipedominguez/Desktop/Nexus Hub/worktrees/confirmation-main-promote-20260523`
Do not touch: `/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot`
Branch: `codex/training-no-heavy-lower-before-long-run-20260525`
PR: #140

## Original Goal

Fix Felipe's iOS New Plan blocker for this input:

- 5 run sessions per week
- 5 strength sessions per week
- Saturday long run
- two-a-day preference `preferred`
- explicit Outlook calendar source

The backend must not generate or persist a strength session that the Training linter/persistence classifier infers as heavy lower-body on the day before the resolved long run. The fix must be proven through the real route path, not only planner unit tests.

## Corrections To The Claude Draft

- The fix is not bounded to `training-plan-coordination.ts`. The post-coordination volume-enforcement path can reinsert strength work on Friday, so volume enforcement is in scope.
- `/plan/generate` success returns HTTP 201, not 200.
- Route coverage must use the real `/plan/preview` path before shipping the production fix.
- "Upper-body" by title is not enough. Assertions use the same lower-heavy classifier as persistence/lint.
- Preview smoke must not call `/plan/cancel`; preview creates no plan.
- Staging smoke is honest: it catches this blocker, not calendar write/body/cancel bugs.
- Calendar-source E2E must seed connected provider state, because explicit Outlook validation checks OAuth/provider availability.
- Mock boundaries must include `unified-calendar`, `google-calendar`, and `outlook-calendar`.
- Normal protected-branch merge is the default. Admin merge requires explicit Felipe approval.
- Test floors use the current `origin/main` baseline and delta, not a stale hard-coded number.
- The iOS Codex prompt uses absolute paths and the canonical backend worktree above.

## Implemented Scope In PR #140

- Shared Training session classifier extracted in `src/services/training-session-classification.ts`.
- Persistence now uses the shared lower-heavy and long-run inference.
- Generation passes the resolved long-run day into volume enforcement.
- Volume enforcement now protects the day before the resolved long run after filling requested strength volume.
- Explicit `calendarSource: "auto"` is accepted as provider-preference mode.
- Real in-memory SQLite integration harness added with real training routes, planner, persistence, and mocked calendar network boundaries.
- Route-level reproducer coverage added for preview and generate.
- Generate/cancel/generate cycle coverage added with live Secretary agenda cleanup assertions.
- iOS payload contract assertions added for fields returned by `training-plan-generation.ts`.
- Staging smoke now has a default-on, preview-only Training plan E2E gate with `NEXUS_SMOKE_TRAINING_E2E=0` as the emergency kill switch.
- Changed-area classifier and cannot-skip dashboard now route Training changes to the real-DB create-cycle E2E.
- iOS Codex E2E prompt created at `docs/training/training-skill-ios-codex-e2e-prompt-2026-05-25.md`.

## Acceptance Criteria

- `/plan/preview` for the reproducer returns HTTP 200, `status: "preview"`, and no `no_heavy_lower_before_long_run` blocker.
- `/plan/generate` for the reproducer returns HTTP 201 with a `planId`.
- Persisted sessions have no lower-heavy session on Friday when Saturday is the resolved long run.
- At least three persisted training days have two sessions for the 5+5 preferred two-a-day reproducer.
- Calendar create calls carry workout content before metadata markers.
- After cancel, active plans are zero and live `secretary_agenda_items` in `scheduled`, `synced`, or `proposed` states are zero.
- Explicit Outlook and explicit Auto calendar-source scenarios are covered without live provider HTTP.
- Staging smoke preview does not create or cancel a plan.
- iOS handoff prompt is self-contained and uses absolute paths.

## Required Verification

Focused:

```bash
npx vitest run __tests__/services/training-coach-kernel-plan-generator.test.ts __tests__/services/coach-kernel-plan-linter.test.ts __tests__/services/training-plan-volume-enforcement.test.ts __tests__/services/training-calendar-source.test.ts __tests__/integration/training-plan-create-cycle.test.ts __tests__/scripts/changed-area-classifier.test.ts
```

Full:

```bash
npx tsc --noEmit --pretty false
npm run verify
```

Operational checks:

```bash
bash -n scripts/staging-smoke.sh
scripts/cannot-skip-gate-dashboard.sh --json --no-evidence
```

Production deploy remains blocked until Felipe explicitly says "ship it".
