# Training Plan Request Semantics

Status: canonical
Owner: backend architecture lead
Last verified: 2026-08-02
Update policy: update BEFORE any behaviour change to the fields documented
here. This document exists because both fields below had multiple live,
undocumented meanings; changing behaviour without updating this contract
re-opens Training remediation findings F8 and F12.

## 1. `sessionsPerWeek` — one name, four pinned meanings (F8)

`sessionsPerWeek` is NOT a single number with one meaning. Four distinct,
deliberate semantics are live, and each is pinned by tests. Any future
consolidation is a behaviour change that must be documented here first and
rolled out with a canary posture.

| Surface | Meaning | Where | Pinned by |
| --- | --- | --- | --- |
| Request validation (compatibility `/plan/generate`) | Accepted integer range 3–7; values outside are rejected before planning. | `validateTrainingPlanGenerationRequest` in `src/api/routes/training-plan-routes.ts` | route validation tests in `__tests__/api/training-routes.test.ts` |
| Response reporting (`weeklyTargets.sessionsPerWeek`) | **Distinct scheduled training DAYS** counted from the finalized plan (per-week MAX), not session rows. A 5-day week with two-a-days reports 5, not 8. | `buildScheduledWeeklyTargetsFromPlan` in `src/api/routes/training-plan-generation.ts` | `__tests__/api/training-plan-generation.test.ts` (weekly-targets cases) and the `$id` matrix in `__tests__/integration/training-plan-create-cycle.test.ts` |
| Volume enforcement input | A **requested training-day budget** that is demoted whenever any explicit modality dial (`runSessionsPerWeek`, `bikeSessionsPerWeek`, `swimSessionsPerWeek`, plus explicit strength) is set — the explicit dials win and `sessionsPerWeek` becomes a fallback. | `requestedTrainingDayBudgetForSport` in `src/services/training-plan-volume-enforcement.ts` | `__tests__/services/training-plan-volume-enforcement.test.ts` |
| Revision mode (M1+) | Days ≡ sessions, strictly 1:1; a request whose availability cannot support the frequency is hard-rejected with a typed error instead of being reinterpreted. | `training-plan-revision-candidate-builder.ts` | candidate-builder suite |

Contract rules derived from the above:

1. The RESPONSE meaning (distinct scheduled days) is the athlete-facing truth
   and what iOS renders. It may legitimately differ from the REQUEST value —
   capacity reconciliation, two-a-day preference, and modality dials all
   adjust it. Honest deltas are surfaced via `volumeShortfalls` (F10) and
   decision reasons, never by silently redefining the number.
2. New code MUST NOT introduce a fifth meaning. If a new surface needs a
   frequency notion, reuse one of the four above and name it precisely
   (`requestedTrainingDays`, `distinctScheduledDays`, ...) instead of
   overloading `sessionsPerWeek`.
3. Renaming or merging any of the four meanings is a client-visible contract
   change: update this document, `ios-specs/02-API-SPECIFICATION.md`, and the
   pinning tests in the same change.

## 2. `raceDate` × `goalMode` — policy decision record (F12)

### Current (inconsistent) behaviour — source-confirmed

- The phase generator honours a future `raceDate` REGARDLESS of `goalMode`:
  `resolveRaceCalendar` / `resolveWeekPhase` produce taper/peak/race weeks
  even when `goalMode` is `continuous`.
- The validating linter rules for race semantics (`no_fake_taper_without_event`,
  `race_specific_plan_requires_race_date`, `race_date_must_be_future`,
  `plan_duration_overshoots_race_date`) and the duration clamp are keyed on
  the event-based flag (`isEventBasedPlan`), NOT on race-date presence — so a
  `continuous` plan with a race date gets taper weeks that no rule validates.
- Past race dates are already rejected route-level (`PAST_RACE_DATE`) before
  any of this applies.

The result: a plan can SHOW race-driven structure that its own quality gates
deliberately ignore. Any of the three policies below is internally
consistent; today's behaviour is not.

### Options

- **(a) `raceDate` implies event-based.** Presence of a valid future race
  date switches the plan to event-based semantics regardless of the sent
  `goalMode`; the race rules and duration clamp always validate what the
  generator produces. Simplest mental model; silently overrides an explicit
  client field.
- **(b) Typed contradiction.** `raceDate` + `goalMode: 'continuous'` returns
  a typed clarification/rejection (422 per the contract standard §4.4) asking
  the athlete which they meant. Most honest; adds a new failure mode for a
  combination iOS currently sends.
- **(c) Continuous suppresses race semantics.** `goalMode: 'continuous'`
  makes the GENERATOR ignore `raceDate` entirely (no taper/peak/race weeks),
  matching what the rules already do. Respects the explicit field; discards
  data the athlete provided.

### Decision

**DECISION PENDING — operator (Felipe).** Rules, clamp, and generator MUST
NOT be touched until one option is chosen and recorded here with a date.
The corrected red test for the eventual change: a FUTURE `raceDate` with
`goalMode: 'continuous'`, asserting duration-overshoot behaviour and
taper-rule behaviour (a past race date is already route-rejected and proves
nothing).

Recommendation from remediation analysis (non-binding): **(a)** — athletes
who give a race date expect the plan to build toward it; validating what the
generator already produces closes the gap with the least contract churn, and
the explicit `goalMode` field remains meaningful for plans WITHOUT a race
date. If (a) is chosen, the response should carry a decision reason
(`event_based_missing_race_date` already exists for the mirror case) noting
the mode override so iOS can render it honestly.

## 3. Chat-builder vs REST creation schema (F26) — convergence contract

Two creation vocabularies are live and share ONLY `durationWeeks`:

| Surface | Fields | Where |
| --- | --- | --- |
| Chat slot filling | `sport`, `goal`, `durationWeeks`, `startDate`, `weeklyVolumeKm` | `TRAINING_PLAN_REQUIRED_SLOTS` in `src/services/skills/training/helpers.ts`, mirrored in the chat registry (`requiredFields` + validators in `src/services/chat/registry/definitions/training.ts`), planner tiers, bilingual clarification copy, and response cards |
| REST `/plan/generate` | `objective` (required), `durationWeeks`, `sessionsPerWeek` (3–7), modality dials, `startPolicy`, `startDate`, `longWorkoutDay`, `goalMode`, `raceDate`, `twoADayPreference`, ... | request validation in `src/api/routes/training-plan-routes.ts` |

Known drift facts (source-confirmed):

- Chat never collects `objective` (`sport` + `goal` approximate it).
- `weeklyVolumeKm` is collected and rendered on the preview card but is not
  consumed by plan generation.
- The chat flow's `verified_pending` handoff is **intentional safety and
  stays** — only the slot vocabulary converges (remediation matrix F26).

Contract rules:

1. Convergence direction: the chat vocabulary converges toward the REST
   creation schema, not the reverse. The chat pipeline spans the registry,
   planner tiers, EN/PT-BR clarification copy, eval fixtures, and response
   cards — converging it is a chat-behaviour change and MUST ship as its own
   canary-postured slice, updating every mirror listed above in one change.
2. Until that slice lands, the drift is pinned by
   `__tests__/services/training-chat-rest-schema-drift.test.ts`: the test
   fails when either vocabulary changes, forcing the editor to read this
   contract and update the pin deliberately instead of growing the drift.
3. Collected-but-unconsumed fields (`weeklyVolumeKm` today) must either be
   consumed by generation or removed from the slot vocabulary as part of the
   convergence slice — collecting athlete data and dropping it is the defect,
   not the naming.
