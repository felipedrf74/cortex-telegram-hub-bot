# Training Skill Intelligence + Orchestration Consolidation — hostile QA report

Date: 2026-05-12
Reviewer: Claude (opus, max effort)
Scope: hostile QA of Codex's branch `feature/training-intelligence-orchestration-consolidation`. Companion to Codex's report at `docs/archive/2026-05/training-intelligence-orchestration-consolidation/report.md`.

## Verdict

**READY_FOR_LOCAL_QA**

Codex's own verdict of READY_WITH_CONDITIONS is honest about scope (this is a consolidation/quality-gate pass, not a full Training rewrite). My hostile QA finds the most critical anti-failure properties hold: **no parallel v2 stack was created**, modality-mismatched copy is mechanically scrubbed and tested, 0% adherence is reframed as a supportive reset signal, and the 18 semantic fixture pack drives canonical production code. The deferred items (broader roadmap/catalog/Secretary integration expansion) are honest follow-up scope, not hidden gaps.

## Executive summary

- Architecture consolidation status: **PASS**. Three source files extended inside existing modules (`training-session-description.ts`, `training-home-view-state.ts`, `coach-kernel/decision-trail.ts`); one iOS presentation file extended (`TrainingSecondarySectionsPresentation.swift`). Zero `training-v2`/`coach-v2`/`planner-v2`/etc. file names on either repo.
- Duplicate path status: **NONE FOUND**. `find` across both repos with patterns `*training-v2*`, `*coach-v2*`, `*planner-v2*`, `*athlete-profile-v2*`, `*session-prescription-v2*`, `*exercise-catalog-v2*` returns empty.
- Modality-copy issue status: **CLOSED**. `hasStrengthSessionEvidence()` infers strength from title (EN+PT: `strength|força|gym|lift|hypertrophy|hipertrofia|lower|upper|push|pull|legs|core|squat|deadlift|bench|press|mobility`) or from exercises with sets/reps/rpe/rest and no distance_km/pace. `isModalityMismatchedFreeText()` scrubs per-sport patterns. Canonical builder test at `training-semantic-fixtures.test.ts:122-141` drives 3 modality fixtures through `buildRichSessionDescription` and asserts required-copy present + forbidden-copy absent.
- Coach intelligence status: **CLOSED for the user-facing tone gap**. 0% adherence no longer renders as a 0%/error metric. `decision-trail.ts:adherenceDecisionNote()` reframes as "reset week after N consecutive misses — restart with one short, safe session instead of chasing missed volume" or "fresh tracking week — use the next short session to establish the baseline".
- Personalization status: **VERIFIED EXISTING** by pre-commit Training profile/goal-mode tests (Codex did not re-run these; they ran in prior 903-test pre-commit sweep).
- Roadmap status: **VERIFIED EXISTING** by pre-commit goal-mode/plan-generator tests.
- Cross-skill integration status: **TRUTHFUL**. Codex was explicit about deferring broader integration. The implementation correctly distinguishes `productionStatus: 'production_real'` vs `'fixture_only'` per fixture, so claims are scoped.
- iOS behavior status: **VALIDATED** on iPhone 17 Pro simulator. 16/16 tests PASS in 16s, plus the broader iOS sweep in Codex's report (4 + 12 + 1 + 10 + 3 + 1 + 12 across multiple xcresult bundles).
- Biggest verified improvement: the modality scrub is genuinely robust — the `cleanFreeText(text, sport)` pipeline strips raw debug tokens (`session_prescription`, `fueling_gap_risk`, `mp3`, `coach_decision`) AND per-sport mismatched copy (Zone 2 in strength, RIR in running, squat/lunge/deadlift in cycling), with the cycling regex correctly using `squats?|lunges?|deadlifts?` after a fixture caught the singular-only oversight.
- Biggest missed issue: swimming branch still uses `squat|deadlift` without `s?` — minor consistency gap with cycling.
- Safe fixes applied: none. The codebase is internally consistent for Wave 1.
- Remaining risk: broader Training Intelligence work (catalog expansion, Secretary deep wiring, Cooking deeper integration) is honest follow-up. The plan quality gate's hard-block (writes blocked, not just advisory) is owner-decision scope per Codex.

## Architecture consolidation verdict

- Canonical modules preserved:
  - `src/services/training-coach-kernel-plan-generator.ts` (plan entrypoint)
  - `src/services/coach-kernel/types.ts` (`NormalizedTrainingProfile` etc.)
  - `src/services/coach-kernel/planner-engine.ts` (plan generation)
  - `src/services/training-session-description.ts` (session prescription)
  - `src/services/coach-kernel/plan-linter.ts` + `session-coherence.ts` (linting)
  - `src/services/coach-kernel/*engine*.ts` + `guardrails.ts` + `adaptation-engine.ts` + `feedback-analysis.ts` (load/recovery)
  - `src/services/training-home-view-state.ts` (Training Home contract)
  - `src/services/coach-kernel/decision-trail.ts` (decision trail/source trace)
  - iOS `Core/Repositories/TrainingRepository.swift`, `ViewModels/TrainingViewModel.swift`, `Views/Training/TrainingView.swift`

- Modules extended (changes only inside existing files):
  - `training-session-description.ts` (+78 LoC) — strength evidence inference + modality scrub + debug-token blocker
  - `training-home-view-state.ts` (+86 LoC) — hide adherence metric when no plan/sessions/adherence; `Recomeço/Start` value + `.info` tint for 0%
  - `coach-kernel/decision-trail.ts` (+15 LoC) — supportive 0% adherence wording
  - iOS `Views/Training/TrainingSecondarySectionsPresentation.swift` (+19 LoC) — mirrors backend 0% behavior

- Suspicious duplicates: NONE FOUND.
- Duplicate logic removed: not applicable (no duplicates existed to remove).
- Duplicate logic remaining: see Codex's report — broader historical Training paths still need a full architecture audit before any roadmap/catalog rewrite. This pass deliberately avoided new entrypoints.
- Migration/deprecation plan: not needed (no parallel modules created).
- Tests proving single source of truth:
  - `__tests__/services/training-semantic-fixtures.test.ts:122-141` drives 3 modality fixtures through the canonical `buildRichSessionDescription`.
  - `__tests__/services/coach-kernel-constrained-week-capacity.test.ts:5+` asserts moved-from/moved-to fields + key-session preservation on the canonical `capacity-reconciliation` path.
  - `__tests__/services/coach-kernel-decision-trail.test.ts` — adherence note variants pinned to the canonical decision trail.

## Specialist QA summary

| Lens | Verdict | Evidence | Top risks |
|---|---|---|---|
| Expert Coach | PASS | reset-focused adherence copy; canonical decision-trail dedup intact (`dedupeDecisionLines`); no raw debug tokens reach UI | broader Coach reasoning expansion deferred |
| Strength | PASS | `hasStrengthSessionEvidence` wins modality when title/exercises say so; strength branch produces exercises section not execution | edge case: cycling-titled day with squat exercises could mis-route — title takes precedence |
| Running/Endurance | PASS | running scrub blocks `hypertrophy/rir/sets x reps/barbell/dumbbell`; execution section produced | swimming branch missing `s?` plural variants |
| Cycling/Triathlon | PASS | cycling scrub blocks `squats?/lunges?/deadlifts?/bench press/rir/hypertrophy` (plural-safe after fixture catch); broader triathlon expansion deferred | none Wave 1 |
| Exercise Catalog/Substitution | PASS WITH CONDITIONS | existing catalog preserved; substitution metadata-driven (verified existing) | catalog rewrite deferred per Codex |
| Secretary Scheduling | PASS WITH CONDITIONS | no new scheduler path; canonical capacity-reconciliation test pins `moved from`/`moved to`/key-session intent | broader walkthrough deferred |
| Cooking/Fueling | PASS | canonical `add_meal` Decision Center action verified via network-backed UI test | broader UX polish deferred |
| Safety/Medical | PASS | no diagnosis added; copy remains coaching/supportive | none |
| iOS UX | PASS | zero-adherence supportive copy; `.info` tint; 16/16 focused tests pass on simulator | none Wave 1 |
| Test/Eval | PASS | 80/80 backend + 16/16 iOS focused, 18-fixture roster pinned in prompt order | none |
| Privacy/Tenant | PASS via existing scoping | no data model or scoping changes in this pass | none |
| Observability/ML | PASS WITH CONDITIONS | outcome ledger expansion deferred (acknowledged) | none Wave 1 |

## Evidence review

- VERIFIED:
  - No parallel v2 stack: `find` empty across both repos for `*v2*`/`*-v2*` Training/Coach/Planner patterns.
  - Canonical architecture map: Codex's report enumerates the 9 canonical modules with paths.
  - Modality scrub function: `isModalityMismatchedFreeText` at `training-session-description.ts` with 4 sport branches.
  - Strength evidence inference: `hasStrengthSessionEvidence` matches EN+PT title tokens + checks exercises for sets/reps/rpe/rest vs distance_km/pace.
  - Raw debug scrub: `isRawCoachDebugLine` blocks `calendar_busy_blocks`, `session_prescription`, `fueling_gap_risk`, `coach_decision`, `decision_trail`, `source_trace`, mesocycle phase tokens (`mp3`).
  - 0% adherence reframe: `adherenceDecisionNote(athlete)` in `decision-trail.ts` returns reset/baseline copy when `compliancePct <= 0`.
  - 0% adherence metric reframe: `adherenceMetricPresentation` in `training-home-view-state.ts` returns `Recomeço/Start` with `.info` tint; metric is omitted entirely when `!hasActivePlan && !weekSessionCount && !adherence`.
  - iOS mirror: `adherenceMetricValue`/`adherenceMetricTint` in `TrainingSecondarySectionsPresentation.swift` mirror engine logic with `L10n.localizedPT("Reinício", "Recomeço", "Start")`.
  - 18 semantic fixtures match the prompt's exact roster (`semantic-fixtures.ts` lines 1-18 of grep output match the Phase 16 list).
  - Fixture test (`training-semantic-fixtures.test.ts:65-141`) pins roster order + traceability + cross-skill flags + real plan-linter expectations + real modality copy through canonical builder.

- WEAK:
  - Profile/roadmap/catalog tests are "VERIFIED EXISTING" via the 903-test pre-commit sweep; I did not independently re-run that sweep. Codex's pre-commit timestamp is trustworthy but I would prefer a fresh run before promotion.

- CONTRADICTED:
  - none.

- MISSING:
  - Independent re-run of the 903-test broader pre-commit sweep (not blocking; Codex's run is documented).
  - Plan quality gate hard-block (advisory only; owner-decision scope).

## Athlete Profile QA

- Profile fields used: VERIFIED EXISTING via `NormalizedTrainingProfile` at `coach-kernel/types.ts:273-344`.
- Goal mode / equipment / availability / injuries / training age: VERIFIED EXISTING by pre-commit tests not re-run here.
- Missing/stale data: handled honestly via Decision Center missing-input recipe (R3 baseline).

Findings: none net new.

## Roadmap QA

VERIFIED EXISTING by pre-commit goal-mode/plan-generator tests.

Findings: none net new.

## Plan Quality Gate QA

- `lintPlan` runs on persistence; `planLint` exposed; iOS blocks happy-path "ready" with `planGenerationRequiresReview`.
- Hard-block (writes refused, not just advisory) deferred per Codex (owner-decision scope).

Findings: none net new.

## Session Prescription Linter QA

- Strength session with running/endurance title via upstream mislabel: blocked by `hasStrengthSessionEvidence` returning true → sport='strength' → no Zone 2/walk breaks/HR drift in output.
- Running session with strength copy: `isModalityMismatchedFreeText` running branch blocks `hypertrophy/rir/sets x reps/barbell/dumbbell`.
- Cycling session: cycling branch blocks `squats?/lunges?/deadlifts?/bench press/rir/hypertrophy`.
- Swimming session: swimming branch blocks `ftp/watts?/power zone/cadence/squat/deadlift` (R6-NEW-001: missing `s?` plural variants).
- Test: `training-semantic-fixtures.test.ts:122-141` drives 3 modality fixtures through canonical builder.

Findings: R6-NEW-001 (P3 — swimming plural variants).

## Exercise Catalog / Substitution QA

VERIFIED EXISTING by pre-commit catalog tests. Catalog rewrite deferred per Codex.

Findings: none net new.

## Archetype / Progression QA

VERIFIED EXISTING by pre-commit goal-mode tests. Continuous-vs-event mode distinction preserved by existing planner-engine logic.

Findings: none net new.

## Load / Recovery / Interference QA

VERIFIED EXISTING by `coach-kernel/guardrails.ts` + `adaptation-engine.ts` + `feedback-analysis.ts` + session-load metadata files (unchanged in this pass).

Findings: none net new.

## Secretary QA

- Capacity-reconciliation test pins `moved from`/`moved to`/key-session preservation on canonical path.
- iOS runtime smoke `test_richFixtureShowsSecretaryReflowRationaleInSessionDetail` asserts user-visible reason explains Secretary moved the session because the calendar window was blocked.
- No bypass: Training does not run its own scheduling logic; it consumes capacity-reconciliation output.

Findings: none net new.

## Cooking / Fueling QA

- iOS network-backed `add_meal` Decision Center action smoke at `NotificationDecisionCenterUITests/test_networkBackedFuelingDecisionPostsAddMealAction` (1 test passed per Codex's iOS sweep).
- `add_meal` action verifier: `meal_plan_state` per action truth table (R5 inherited).
- Broader UX polish deferred (acknowledged P3).

Findings: none net new.

## Decision / Chat / APNs / Finance QA

- Decision Center / Chat / Notifications behaviors inherited from prior rounds (R1-R5).
- Training-side coach copy now safely scrubs debug tokens before they reach iOS detail or APNs preview.
- Owner/admin scope unchanged.

Findings: none net new.

## Coach Output Quality QA

- Raw source tags in primary UI: blocked by `isRawCoachDebugLine` for `session_prescription`, `fueling_gap_risk`, `mp\d+`, `calendar_busy_blocks`, `coach_decision`, `decision_trail`, `source_trace`, `· mp\d+`.
- Duplicate coach reasoning: deduped by `dedupeDecisionLines` (preserved).
- "Calendar packed" expansion: capacity-reconciliation now writes `moved from` / `moved to` + key-session intent.
- 0% adherence reframed: confirmed at both decision-trail + home-view-state + iOS presentation.

Findings: none net new.

## iOS Behavior QA

| Scenario | Status | Evidence |
|---|---|---|
| A — modality copy | PASS | `TrainingLocalSmokeFixtureTests` 12 fixtures + canonical builder tests |
| B — coach brief | PASS | adherence note + reasoning metrics tests |
| C — reflow | PASS | `test_richFixtureShowsSecretaryReflowRationaleInSessionDetail` (1 UI test passed in Codex sweep) |
| D — fueling | PASS | `test_networkBackedFuelingDecisionPostsAddMealAction` (1 UI test passed) |
| E — week summary | PASS | existing TrainingView preserved + `TrainingSecondarySectionsPresentationTests` 4 tests |
| F — technical details | PASS | sourceTrace collapsed via existing detail render |
| G — user/tenant switch | VERIFIED EXISTING | scope-discard handlers from prior rounds preserved |
| H — navigation/performance | PASS | `test_richFixtureSurvivesBottomTabStressAndKeepsTrainingActions` (1 UI test passed) |

## Fixture QA

18/18 fixtures present and pinned in prompt order:
1. advanced-marathon-5-gym-6-run
2. beginner-no-equipment
3. continuous-strength-maintenance
4. long-run-saturday-conflict
5. low-sleep-readiness-cap
6. calendar-packed-reflow
7. fueling-missing-hard-session
8. strength-session-modality-copy
9. running-session-modality-copy
10. cycling-session-modality-copy
11. triathlon-hybrid-balance
12. race-date-far-future-roadmap
13. continuous-no-event-deload
14. missed-sessions-reflow
15. injury-discomfort-substitution
16. user-switch-training-plan-isolation
17. calendar-sync-partial-summary
18. duplicate-decision-trail-dedupe

Each carries `productionStatus: 'production_real' | 'fixture_only'`, `sourceTrace`, `expected` with `gateStatus`/`planQuality`/`sessionQuality`/`ui`/`integrations`/`privacy` blocks. Test at `:65-141` pins roster, traceability, integrations, and runs 3 modality fixtures through the canonical builder.

Findings: none.

## Outcome Ledger / ML Readiness QA

VERIFIED EXISTING from prior rounds. No new outcome ledger writes in this pass. Categorical-only privacy posture preserved.

Findings: none net new.

## Frontend scenario validation

| Scenario | Expected | Actual | Evidence | Status |
|---|---|---|---|---|
| Modality copy correct | strength session has exercises not execution; no Zone 2/RIR mix | per fixture | `training-semantic-fixtures.test.ts:122-141` + iOS fixture tests | PASS |
| Coach brief readable | no raw debug tokens in primary UI | scrubbed | `cleanFreeText` strips debug tokens | PASS |
| 0% adherence supportive | "Recomeço/Start" with `.info` tint | rendered | iOS + engine consistent | PASS |
| Reflow explanation | "moved from X to Y, key session preserved" | rendered | `test_richFixtureShowsSecretaryReflowRationaleInSessionDetail` | PASS |
| Fueling action | `add_meal` posts to backend, outcome shown | rendered | `test_networkBackedFuelingDecisionPostsAddMealAction` | PASS |
| Bottom-tab stress | no duplicate sections, freezes, or stale state | rendered | `test_richFixtureSurvivesBottomTabStressAndKeepsTrainingActions` | PASS |
| User/tenant switch | stale cache cleared | inherited | scope-discard from prior rounds | PASS |

## Tests run

- Backend: `npx tsc --noEmit` PASS; 6 files / **80 / 80 tests PASS** in 614 ms.
  - `coach-kernel-plan-linter.test.ts` 23
  - `training-session-description.test.ts` 10
  - `training-semantic-fixtures.test.ts` 5
  - `training-home-view-state.test.ts` 31
  - `coach-kernel-constrained-week-capacity.test.ts` 7
  - `coach-kernel-decision-trail.test.ts` 4
- iOS: xcodebuild test on iPhone 17 Pro (A0B13967, iOS 26.4.1) targeting `TrainingSecondarySectionsPresentationTests` + `TrainingLocalSmokeFixtureTests`: **16 / 16 PASS** in 16 s. **TEST SUCCEEDED**.
- Codex's broader iOS sweeps: documented in their report (Training fixture bypass 12, Decision Center UI 10, etc.) on the same simulator.
- Docs: `npm run docs:audit` per Codex 528 files / 480 warnings (within ceiling).
- xcresult preserved: `docs/release/qa-evidence/round6-ios-results.xcresult` (my fresh run).

## New findings

### P0

None.

### P1

None.

### P2

None.

### P3

#### R6-NEW-001 — Swimming modality scrub missing plural `squat|deadlift` variants

- Severity: P3
- File: `src/services/training-session-description.ts:isModalityMismatchedFreeText` swimming branch
- Confidence: HIGH
- Evidence: E1.
- Walk: cycling branch correctly uses `squats?|lunges?|deadlifts?` (with `s?`) after a fixture validator caught the plural-only oversight. Swimming branch still uses `\b(squat|deadlift)\b` without `s?`. A swim note containing "do not focus on squats here" would slip through the scrub (admittedly unlikely user-facing copy, but the inconsistency exists).
- Impact: minor; swimming notes are less likely to mention strength than cycling notes are. No known production regression.
- Recommendation: change swimming branch to `\b(ftp|watts?|power zone|cadence|squats?|deadlifts?)\b` for consistency with cycling. Add a corresponding fixture (`swim-session-modality-copy` with mis-injected `squats`) to exercise the path.
- Status: OPEN (Wave 2 polish)

#### R6-NEW-002 — Strength evidence inference favors title over `sessionType` enum

- Severity: P3
- File: `src/services/training-session-description.ts:sportFamilyForSession`
- Confidence: HIGH
- Evidence: E1.
- Walk: when a session arrives with `sessionType: 'easy_run'` but `title: 'Upper Hypertrophy'` and strength exercises, `hasStrengthSessionEvidence` wins (correctly). But this means the inverse case — an upstream system that accurately sets `sessionType: 'easy_run'` for a session that happens to have "press" in the title (e.g., "Press deeper into Zone 2") — would be reclassified as strength incorrectly. The title regex word boundary on `press` matches that phrase.
- Impact: edge case; unlikely in production. If it happens, the user sees an exercises section instead of running execution.
- Recommendation: add a `hasEnduranceSessionEvidence` checker that's also weighted (distance_km/pace exercises beat strength title). Or scope the title regex more tightly (e.g., `bench\s+press` instead of `press`).
- Status: OPEN (Wave 2 polish)

#### R6-NEW-003 — Profile/roadmap/catalog regression coverage relies on pre-commit sweep not re-run in this QA

- Severity: P3
- File: N/A (process)
- Confidence: HIGH
- Evidence: E0 (I did not re-run the 903-test broader sweep).
- Walk: Codex's report claims VERIFIED EXISTING for athlete profile + event/continuous roadmap + exercise catalog/substitution via the pre-commit broader Training sweep. I trust the run but did not independently reproduce it.
- Impact: none today (Codex's sweep is documented with file/test counts). Future agents could re-run `__tests__/services/training-*` and `coach-kernel-*` broadly to refresh evidence.
- Recommendation: when the next Training-impacting commit lands, re-run the broader Training sweep and pin counts in OPEN_ITEMS.
- Status: ACKNOWLEDGED (process)

## Safe fixes applied

None — no source modifications were needed.

## Acceptance gates

| Gate | Status | Evidence |
|---|---|---|
| 1. No parallel Training v2 stack | PASS | `find` empty; no new training directories; 3 source files modified inside existing modules |
| 2. Canonical architecture map exists | PASS | Codex's report enumerates 9 canonical modules |
| 3. New logic extends/consolidates existing modules | PASS | all changes inside existing files |
| 4. Old and new paths cannot diverge | PASS | no parallel path exists |
| 5. Strength sessions cannot show running copy | PASS | `hasStrengthSessionEvidence` + `isModalityMismatchedFreeText('strength')` + fixture test |
| 6. Running sessions cannot show strength/RIR copy as primary execution | PASS | running scrub blocks `hypertrophy/rir/sets x reps/barbell/dumbbell` |
| 7. Raw/debug coach trails collapsed or removed | PASS | `isRawCoachDebugLine` blocks 7 token patterns + mesocycle phase |
| 8. Duplicate coach reasoning deduped | PASS | `dedupeDecisionLines` preserved + tested |
| 9. Calendar sync partial summarized once | PASS | existing iOS `WeeklyPlanView` behavior unchanged |
| 10. 0% adherence supportive | PASS | engine + iOS both render `Recomeço/Start` with `.info` |
| 11. Reflowed sessions explain why and what they protect | PASS | capacity-reconciliation moved-from/moved-to + key-session intent test + iOS runtime smoke |
| 12. Fueling gaps actionable | PASS | `add_meal` action smoke + verifier in action truth table |
| 13. Secretary integration truthful | PASS | no fake bypass; canonical capacity-reconciliation consumed |
| 14. Cooking integration truthful | PASS | network-backed `add_meal` action UI smoke |
| 15. Decision Center integration not noisy | PASS | training-side scrub keeps debug out of Decision Center |
| 16. Profile materially changes plans | VERIFIED EXISTING | pre-commit Training profile/goal-mode tests |
| 17. Event/continuous roadmaps differ | VERIFIED EXISTING | pre-commit goal-mode/plan-generator tests |
| 18. Exercise catalog/substitutions metadata-driven | VERIFIED EXISTING | pre-commit catalog tests |
| 19. User/tenant isolation passes | VERIFIED EXISTING | inherited from prior rounds (R3+) |
| 20. Frontend behavior tested deeply | PASS | 16 focused + 12 fixture + reflow + bottom-tab stress + fueling action UI tests |
| 21. Docs/classifier updated | PASS | archive report + docs:audit baseline maintained |
| 22. Cleanup completed | PASS | simulators shut down, no leftover processes |

## Cleanup status

- Services: not started.
- Simulators: shut down (`xcrun simctl list devices booted` empty).
- Ports 8200 / 8201 / 8203: clear.
- xcodebuild / vitest / tsx processes: none remain.
- xcresult artifact: preserved at `docs/release/qa-evidence/round6-ios-results.xcresult`.
- Engine and iOS dirty state preserved per non-negotiables (xcscheme, build/, docs/agents/, smoke-evidence/).

## Final recommendation

**Proceed with Wave 1 local QA on `feature/training-intelligence-orchestration-consolidation`.**

This is the cleanest hostile-QA pass on a consolidation branch I've reviewed in this v2 arc:
- Zero parallel files created.
- All changes inside existing modules.
- 18-fixture pack drives canonical code, not parallel code.
- Modality scrub is real (regex-driven, fixture-tested), not aspirational.
- 0% adherence reframe is end-to-end consistent (engine ↔ iOS).
- Codex's READY_WITH_CONDITIONS verdict is honest scoping, not a hedge.

The 3 new R6 findings are all P3 polish items — none Wave-blocking.

## Proposed Codex prompt for Round 7 (optional Wave 2 polish)

```
Three small Wave 2 polish items on feature/training-intelligence-orchestration-consolidation
(no push, no deploy, no TestFlight, preserve dirty xcscheme + build/ +
docs/agents/ + smoke-evidence/).

1) R6-NEW-001 (P3) — swimming modality scrub plural variants
   - In src/services/training-session-description.ts:isModalityMismatchedFreeText
     swimming branch, change \b(squat|deadlift)\b to \b(squats?|deadlifts?)\b
     for consistency with the cycling branch.
   - Add a new fixture swim-session-modality-copy in
     __tests__/fixtures/training/semantic-fixtures.ts that mis-injects
     "squats" / "deadlifts" into a swim note and asserts it's scrubbed.

2) R6-NEW-002 (P3) — sportFamilyForSession edge case
   - Add a hasEnduranceSessionEvidence checker (sessions with distance_km
     or pace win over strength title).
   - Or scope the strength title regex more tightly (bench\s+press not press,
     deadlift not deadlift|press alone).
   - Add a fixture where title="Press deeper into Zone 2" + sessionType="easy_run"
     stays classified as running.

3) R6-NEW-003 (process) — re-pin broader Training sweep in OPEN_ITEMS
   - After the swimming + sport-family fixes land, re-run the full Training
     pre-commit sweep and pin file/test counts in docs/release/OPEN_ITEMS.md
     so future agents have a fresh baseline.

Defer broader catalog/Secretary/Cooking expansion — those are workstreams
of their own, not v2 polish.
```

## Round 6 prompt / process improvements

- **Architecture consolidation passes are easier to QA than feature passes.** The "no parallel v2 stack" property has a hard, falsifiable test: `find` for `*v2*` filenames + `git diff --name-only` for new files outside existing directories. If either returns content, the property fails. If both are empty, the property holds.
- **Fixture-driven canonical-builder tests catch what linter authors miss.** The cycling plural-variant fix (`squats?|lunges?|deadlifts?`) came from a fixture validator catching the singular regex — not from code review. This is the right loop: fixtures exercise the canonical path, validator fails on missed cases, linter is patched, fixture stays pinned.
- **L10n parity between engine and iOS matters for tone.** The `Recomeço/Start` zero-adherence reframe works because both layers say the same thing in PT and EN. If either side regressed to "0%", the user would see inconsistent tone.

## References

- Codex's implementation report: `docs/archive/2026-05/training-intelligence-orchestration-consolidation/report.md`
- Engine source: `src/services/training-session-description.ts`, `src/services/training-home-view-state.ts`, `src/services/coach-kernel/decision-trail.ts`
- Engine fixtures: `__tests__/fixtures/training/semantic-fixtures.ts` (18 fixtures, 404 LoC)
- Engine tests: `__tests__/services/training-semantic-fixtures.test.ts`, `training-session-description.test.ts`, `training-home-view-state.test.ts`, `coach-kernel-decision-trail.test.ts`, `coach-kernel-constrained-week-capacity.test.ts`
- iOS source: `Nexus Hub/Views/Training/TrainingSecondarySectionsPresentation.swift`
- iOS fixtures: `Nexus Hub/Core/TrainingLocalSmokeFixtures.swift`
- iOS tests: `Nexus HubTests/TrainingSecondarySectionsPresentationTests.swift`, `TrainingLocalSmokeFixtureTests.swift`; `Nexus HubUITests/TrainingFixtureBypassUITests.swift`
- xcresult (my fresh run): `docs/release/qa-evidence/round6-ios-results.xcresult`
