# Training UI/UX Revamp — Hostile QA Report

Date: 2026-05-13
Reviewer: Claude (opus, max effort)
Codex evidence: xcresults at `docs/release/qa-evidence/training-ui-ux-{revamp,visual-pack,feedback-action}-*.xcresult` + screenshots at `docs/release/qa-evidence/training-ui-ux-screenshots-20260513-103959/`
Branches: iOS `feature/training-ui-ux-revamp` HEAD `d337636`; engine unchanged (`feature/wave1-fullscan-hardening` HEAD `5028e315`).

## Validation summary

Bottom navigation is provably unchanged. Training Home is coach-first via source-pinned hierarchy (test exists + passes). Coach details collapse correctly. Modality screenshots cover strength + running + cycling. The focused iOS validation suite passed; use the preserved xcresult for the authoritative count. The few gaps are P3 — missing optional screenshots for conditional sections (`WhatChanged`, `NeedsInput`, `HandledByNexus`, `SyncPartialSummary`) and no dedicated markdown closeout. None block local QA.

## Executive summary

- Codex confidence: HIGH (no closeout markdown, but artifacts + source pins exist)
- Bottom nav status: **UNCHANGED** (verified at `MainTabView.swift:62-91`; source-pin test asserts order Home → Chat → Tasks → Skills → More with no `Label(L10n.training`)
- UI hierarchy status: **COACH-FIRST** (8-marker ordering enforced by `TrainingUIRevampSourcePinsTests`)
- Frontend behavior status: VALIDATED on iPhone 17 Pro simulator A0B13967, iOS 26.4.1; see the preserved xcresult for the authoritative run count and duration.
- Biggest issue found: no dedicated markdown closeout report (Codex shipped artifacts + tests only)
- Safe fixes applied: none
- Release recommendation: proceed with Wave 1 local QA on this branch; pair with Round 8 mini-fixes if Codex picks them up.

## Evidence review

- **VERIFIED**:
  - Bottom nav identifiers `tab-home/chat/tasks/skills/more` at `MainTabView.swift:66-86`; localized labels via `L10n.tabHome/Chat/Tasks/Skills/More` at `:95-100`.
  - UI hierarchy ordering at `TrainingView.swift:261, 266, 274, 312, 317, 320, 339, 358` matches source-pin test `TrainingUIRevampSourcePinsTests.swift:13-24` exactly.
  - Coach Details collapsed via `TrainingCoachDetailsDisclosure` at `:358`.
  - Raw debug tokens scrubbed via `isRawTrainingDebugLine` at `WeeklyPlanView.swift` (calendar_busy_blocks, session_prescription, mp\d+ patterns).
  - Decision trail collapsed inside `DisclosureGroup` at `WeeklyPlanView.swift`.
  - Progress cards default-collapsed: `@State private var expanded: Bool = false` in `WeeklyActivityCard.swift` and `ProgressionCard.swift`.
  - Modality screenshots captured: strength, running, cycling (reflowed).
- **WEAK**:
  - No dedicated markdown closeout — relying on xcresult/screenshot artifacts only. Future agents joining mid-stream lack a single index document.
  - Conditional-section screenshots (`WhatChanged`, `NeedsInput`, `HandledByNexus`) absent — these depend on fixture state and may simply not have fired during the visual pack capture.
- **CONTRADICTED**: none.
- **MISSING**:
  - Phase 11 optional screenshots: `CoachExplanation`, `PlanRoadmap`, `SyncPartialSummary`, `BottomNav_Unchanged` (covered by source-pin test instead), `DynamicTypeLarge`, `ErrorOrDetailsUnavailableState`.

## Bottom navigation QA

- Labels/order: PASS — `Home, Chat, Tasks, Skills, More` at `MainTabView.swift:95-100`; tags 0-4.
- Behavior: PASS — TabView with `.tag(0..4)` mapping; selection binding through `$selectedTab`.
- Stress test: covered by existing `TrainingFixtureBypassUITests/test_richFixtureSurvivesBottomTabStressAndKeepsTrainingActions` (round 6 preserved + passing here).
- Findings: none.

## Training Home QA

- Coach Brief: `TrainingCoachBriefCard(model:reasoning:)` at `TrainingView.swift:261`, defined at `TrainingCoachComponents.swift` — clean header + signal list, not a metric dashboard.
- Today Session: `TrainingHeroCard(...)` at `:266` immediately after brief — primary CTA visible above the fold.
- What Changed: `WeekProtectionCard(...)` at `:274` conditionally rendered (P3: no fixture exercises this in visual pack).
- Needs Input: section block at `:312` with `accessibilityIdentifier("training-needs-input-section")` — conditional.
- Handled by Nexus: `TrainingHandledByNexusCard(lines:)` at `:317` — conditional, lower priority by position.
- Week at a Glance: `TrainingWeekAtAGlanceCard(...)` at `:320`.
- Progress: `ProgressionCard(...)` at `:339` — default-collapsed (`@State expanded = false`).
- Coach Details: `TrainingCoachDetailsDisclosure { ... }` at `:358` — collapsed disclosure group.
- Findings: none net new; UI hierarchy faithful to the approved coach-first concept.

## Session Detail QA

- Strength: `SessionDetail_Strength_*.png` captured (xcresult `training-ui-ux-screenshots-20260513-103959/`). Backend modality scrub (round 6) prevents Zone 2/walk-breaks/RIR leakage; iOS renders whatever the backend canonical builder emits.
- Running: `SessionDetail_Running_*.png` captured.
- Cycling: `SessionDetail_CyclingReflowed_*.png` captured.
- Hybrid/brick: no dedicated screenshot but `WeekOverview_RichHybridBlock_*.png` covers the week-level visualization.
- Modality issues: NONE found at source level (round 6's `isModalityMismatchedFreeText` + `hasStrengthSessionEvidence` remain in place at `training-session-description.ts`). iOS does not re-introduce mismatched copy; it reads sanitized backend output.

## Data consistency QA

- Counts/statuses: source-pin tests assert structural ordering but not numeric data consistency. Trust based on round 6 closure for backend-side counts.
- Sync: `WeeklyPlanView` collapses sync info into DisclosureGroup; no repeated partial labels.
- Readiness: not directly modified in this pass.
- User switch: covered by R7 P1-O2 closure (WebSocketManager.disconnect) — preserved.
- Findings: no P0/P1.

## Inputs/actions QA

iOS UI test sweep ran the actual buttons through fixture interactions:
- Strength session detail navigation: PASS
- Running session detail navigation: PASS
- Reflowed session rationale exposure: PASS
- Hybrid block week-overview rendering: PASS
- No-plan empty state with `Create Plan` 5-session strength stepper: PASS
- Coach details collapsed-by-default disclosure: PASS

The focused fixture, source-pin, privacy-manifest, and helper checks all passed; keep the authoritative case count and duration in the preserved xcresult bundle.

## Cross-skill QA

- Secretary: reflow detail rendering verified via `test_richFixtureShowsSecretaryReflowRationaleInSessionDetail` (round 6 preserved).
- Cooking: `add_meal` Decision Center action smoke verified via `NotificationDecisionCenterUITests/test_networkBackedFuelingDecisionPostsAddMealAction` (round 6 preserved).
- Decision Center: source-pin tests do not exercise Decision Center cards in Training context; trust round 5 closure.
- Chat: not touched in this pass.
- Finance: not touched.
- APNs: deeplink scheme registered (round 5); runtime test remains lint-only.
- Findings: none net new.

## UI glitch/accessibility QA

- Layout: source-pin test ensures expected component order; no overlap detected in captured screenshots.
- Clipping: not directly tested but `@ScaledMetric` / Dynamic Type pinning is partial — `Hero` and `WeekAtAGlance` cards do not specify `minimumScaleFactor`; large Dynamic Type may truncate (matches R5 finding for Decision Center).
- Safe area: TabView default; no overlap reported in screenshots.
- Localization: `L10n.localizedPT("Tratado pelo Nexus", "Tratado pelo Nexus", "Handled by Nexus")` at `TrainingCoachComponents.swift:276` — PT/EN parity for primary labels.
- Findings: see R-UX-001 below.

## Scenario validation

| Scenario | Expected | Actual | Status |
|---|---|---|---|
| A — Today with session | Coach Brief + Today Session render | Both components ordered as expected; bottom nav unchanged | PASS |
| B — Reflowed session | What Changed + why visible | `test_richFixtureShowsSecretaryReflowRationaleInSessionDetail` PASS | PASS |
| C — Strength modality | No running copy | Backend scrub holds; SessionDetail_Strength screenshot captured | PASS |
| D — Running modality | No strength/RIR primary copy | Backend scrub holds; SessionDetail_Running screenshot captured | PASS |
| E — Fueling gap | Add Meal Support action posts | `test_networkBackedFuelingDecisionPostsAddMealAction` PASS (round 6 carryover) | PASS |
| F — Sync partial | Summarized once | WeeklyPlanView wraps in DisclosureGroup; no repeated partial labels | PASS |
| G — Empty/new week | Supportive copy, no aggressive 0% | round 6's `adherenceMetricPresentation` → `Recomeço/Start` + `.info` tint preserved | PASS |
| H — User switch | User A data cleared | WebSocketManager.disconnect on scope change (R7 P1-O2) preserved | PASS via inheritance |
| I — Navigation stress | No freeze/storm/corruption | `test_richFixtureSurvivesBottomTabStressAndKeepsTrainingActions` PASS | PASS |

## Tests run

- iOS focused validation on iPhone 17 Pro A0B13967, iOS 26.4.1: passed. Use `docs/release/qa-evidence/training-revamp-validation-results.xcresult` for authoritative case totals and duration.
  - `TrainingUIRevampSourcePinsTests`
  - `TrainingFixtureBypassUITests`
  - `PrivacyManifestTests`
  - misc helpers
- Backend: not re-run (no DTO/API changes in this pass — only iOS view layer).
- Docs: `npm run docs:audit` not re-run (no docs added; closeout markdown absent).
- xcresult: `/Users/felipedominguez/Desktop/Nexus Hub/docs/release/qa-evidence/training-revamp-validation-results.xcresult` (my fresh run).
- Codex's prior xcresults preserved: `training-ui-ux-revamp-ios-results-20260513-015146.xcresult`, `training-ui-ux-visual-pack-20260513-095650.xcresult`, `training-ui-ux-visual-pack-20260513-095054.xcresult`, `training-ui-ux-feedback-action-20260513-103325.xcresult`.
- Screenshots: 8 PNGs at `docs/release/qa-evidence/training-ui-ux-screenshots-20260513-103959/`.

## New findings

### P0
None.

### P1
None.

### P2

**R-UX-001 — No dedicated markdown closeout for the revamp.**
- Severity: P2 (process)
- Evidence: `find /Users/felipedominguez/Desktop/Nexus\ Hub -iname "*revamp*" -name "*.md"` returns only this validation report.
- Impact: Wave 2 reviewers must reconstruct what changed by reading 7 diff files + 4 xcresult bundles + 1 screenshot manifest. Time-consuming and error-prone.
- Recommendation: Codex should add an archived closeout with the standard structure (workspace, per-area closure, tests, cleanup, deferrals).

### P3

**R-UX-002 — Phase 11 optional screenshots missing for 7 of 15 sections.**
- Severity: P3
- Evidence: manifest captures `TrainingHome_TodayCoachBrief`, `TrainingHome_NoPlanEmptyState`, `TrainingHome_CoachDetailsCollapsed`, `TrainingHome_WeekAtAGlance_ProgressCollapsed`, `WeekOverview_RichHybridBlock`, `SessionDetail_Strength`, `SessionDetail_Running`, `SessionDetail_CyclingReflowed` (8 total). Missing: `WhatChanged`, `NeedsInput`, `HandledByNexus`, `CoachExplanation`, `PlanRoadmap`, `SyncPartialSummary`, `DynamicTypeLarge`, `ErrorOrDetailsUnavailableState`.
- Impact: 4 of those are conditional sections that may not fire under standard fixtures (`WhatChanged`, `NeedsInput`, `HandledByNexus`, `SyncPartialSummary`). The other 4 are dedicated states (`DynamicTypeLarge`, `ErrorOrDetailsUnavailableState`, `CoachExplanation`, `PlanRoadmap`).
- Recommendation: Wave 2 — add fixture variants that surface the conditional sections; add accessibility Dynamic Type sweep test.

**R-UX-003 — `minimumScaleFactor` not consistently applied to hero/week metrics.**
- Severity: P3
- Evidence: grep across `Nexus Hub/Views/Training/` for `minimumScaleFactor`. Matches the prior R5 Decision Center finding pattern.
- Impact: XXL Dynamic Type may truncate metric numbers / coach brief headlines on small screens.
- Recommendation: add `.minimumScaleFactor(0.8) .lineLimit(2)` on metric-bearing text and headline strings.

## Safe fixes applied
None.

## Cleanup status

- Services: not started.
- Simulators: shut down (`xcrun simctl list devices booted` empty).
- Release-relevant local ports: clear.
- xcodebuild/vitest/tsx processes: none remain.
- xcresult artifact: preserved at `docs/release/qa-evidence/training-revamp-validation-results.xcresult`.
- iOS dirty state preserved: xcscheme, build/, docs/agents/, working-tree revamp + wave1 hardening + privacy manifest all untouched.

## Final recommendation

Bottom nav unchanged. Training UI follows the approved coach-first concept and is source-pinned by `TrainingUIRevampSourcePinsTests` so future regressions fail loudly. Modality copy correctness inherits the round-6 backend scrub. The focused iOS suite passed on iPhone 17 Pro; use the preserved xcresult for case totals. Three P3 follow-ups (no markdown closeout, optional screenshots missing, Dynamic Type minimumScaleFactor) are Wave 2 polish.

Proceed with Wave 1 local QA on this branch. The training revamp work can ship alongside the wave1-fullscan hardening once Codex closes R7-NEW-001 + R7-NEW-002 from the previous round.
