# Training Plan Request Semantics

Status: canonical
Owner: backend architecture lead
Last verified: 2026-08-05
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
| Volume enforcement input | A **requested training-day budget** that is demoted when a positive endurance dial (`runSessionsPerWeek`, `bikeSessionsPerWeek`, or `swimSessionsPerWeek`) is explicit; explicit strength contributes to the summed target when an endurance dial is explicit. Otherwise `sessionsPerWeek` remains the fallback day budget. | `requestedTrainingDayBudgetForSport` in `src/services/training-plan-volume-enforcement.ts` | `__tests__/services/training-plan-volume-enforcement.test.ts` |
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
4. Within the existing volume-enforcement meaning,
   `twoADayPreference: 'never'` forbids treating explicit endurance and
   strength asks as stackable on the same day. For a fully explicit request,
   the placement-day budget is therefore the smaller of the requested
   training-day cap and the summed modality asks. For partially explicit
   multisport requests, zero modality dials remain `auto`, so the unassigned
   portion of the requested training-day budget stays reserved for those
   modalities. Other two-a-day preferences retain the normal explicit-dial
   demotion. If the effective ask still exceeds the legal day budget, the plan
   reports a structured `two_a_day_cap` shortfall instead of silently dropping
   a modality.
5. `TrainingPlanCoordination.weeklySessionTarget` reuses the requested
   training-day meaning: it caps DISTINCT active days, not physical workout
   rows. A five-day plan may therefore retain run+strength doubles on those
   five days when the request permits them. The downstream volume/two-a-day
   pass remains the authority for explicit modality totals and for a `never`
   preference; coordination must not reinterpret five days as five rows.

## 2. `raceDate` × `goalMode` — policy decision record (F12)

### Prior inconsistent behaviour — source-confirmed

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

**Decision (a), recorded by Felipe on 2026-08-03: `raceDate` wins.** Any
syntactically valid race date activates event-based semantics. Public routes
still reject malformed and past dates before generation; the linter also
fail-closes invalid temporal combinations for internal callers. Therefore:

1. The duration clamp and all race/taper lint rules use the same event-based
   interpretation as the phase generator.
2. The effective `goalMode` passed to generation, persisted with the plan,
   and returned to clients is `event_based` whenever a race date is present.
3. If the requested mode was not already `event_based`, the response includes
   the additive decision reason `race_date_implies_event_based`, with the
   requested and effective modes in `before`/`after`. Clients may render this
   disclosure but do not need to understand the code to decode the response.
4. `goalMode` retains its normal meaning when no race date is present.

The corrected regression uses a FUTURE `raceDate` with
`goalMode: 'continuous'`: it proves duration overshoot is clamped/validated
and that a taper is accepted only as event-backed. A past-date request is not
accepted as evidence because route validation already rejects it.

## 3. Chat-builder vs REST creation schema (F26) — converged canary contract

The chat handoff collects the smallest complete REST-compatible creation core:

| Surface | Fields | Where |
| --- | --- | --- |
| Chat slot filling | `objective`, `durationWeeks`, `sessionsPerWeek`, `startPolicy` | `TRAINING_PLAN_REQUIRED_SLOTS` in `src/services/skills/training/helpers.ts`, mirrored in the chat registry, planner tiers, bilingual clarification copy, response cards, eval fixtures, and staging smoke |
| REST `/plan/generate` | The same four core fields, plus optional modality dials, preferred times, `longWorkoutDay`, `goalMode`, `raceDate`, `twoADayPreference`, calendar source, and notes | request validation in `src/api/routes/training-plan-routes.ts` |

Canary decision (2026-08-02):

1. Chat aliases `sport` + `goal` converge into REST `objective`.
2. Exact chat `startDate` is replaced by REST `startPolicy`. Deterministic chat
   extraction maps only representable choices: today, or Monday/next full
   week. Other exact dates remain unanswered and are clarified in the builder.
3. `sessionsPerWeek` uses the request-validation meaning from §1 (integer
   3–7). The response may later report a different finalized number of
   distinct training days, with honest deltas surfaced by generation.
4. `weeklyVolumeKm` is removed from collection and cards. Generation never
   consumed it, so retaining it would continue to collect and silently drop
   athlete data.
5. The chat flow's `verified_pending` handoff is intentional safety and
   **stays**. This slice changes vocabulary only; it does not execute plan
   creation from chat or make the handoff a verified dependency producer.

The convergence pin in
`__tests__/services/training-chat-rest-schema-drift.test.ts` requires every
chat field to belong to the REST creation contract and keeps the registry
mirror exact. Any future vocabulary change must update this section and every
listed mirror in the same canary-postured slice.

## 4. Generation response and HTTP status contract (F27)

`POST /plan/preview` and `POST /plan/generate` expose the additive response
schema `training_plan_generation_response.v1`. Every generation payload carries
`schemaVersion` plus the stable `status` discriminator. Success and intentional
clarification payloads carry those fields in `data`; typed errors carry them in
`error.details`, following the envelope in the backend API contract standard.
Existing payload fields remain additive and are not renamed or removed.

| Generation result | Preview route | Generate route | Contract meaning |
| --- | ---: | ---: | --- |
| `needs_profile` without a validation error | 200 | 200 | An intentional profile/questionnaire handoff, not rejected input |
| `needs_profile` with `validationError` | 422 | 422 | A known semantic request rejection; the stable validation code is the error code |
| `needs_clarification` | 200 | 200 | An intentional answer → profile write → re-preview handoff |
| `preview` | 200 | 409 | Valid preview on `/preview`; an invalid state conflict on `/generate` |
| `created` | 409 | 201 | An invalid state conflict on `/preview`; a created plan on `/generate` |
| `plan_quality_blocked` | 422 | 422 | A known semantic rejection before persistence |
| `cancellation_failed` | 409 | 409 | A known replacement-state conflict |

This table is exhaustive for the public generation-result union. It deliberately
does **not** convert every non-created result into an error: previews and
clarification handoffs remain HTTP 200. Conversely, known semantic rejections
and conflicts must never fall through to a generic 500. A status-policy change
requires updating this section and the exhaustive contract test in the same
change.

## 5. Compatibility generation-attempt reconciliation

`POST /api/v1/training/plan/generation-attempt/status` is the authenticated,
token-zero read-back boundary for a `/plan/generate` request whose HTTP outcome
was not observed by the client. Its body accepts the existing generation
`idempotencyKey` as one exact, non-empty string of at most 160 characters. The
route remains readable when generation is disabled so an existing attempt
does not become unrecoverable because a kill switch or revision rollout mode
changed after submission.

The create route applies the same strict rule to every explicit body or header
key. Blank, non-string, or overlong values return HTTP 400; they are never
truncated and never silently replaced by an automatic key.

The response schema is `training_plan_generation_attempt_status.v1`:

| `state` | Required `recovery` | `canStartNew` | Proof |
| --- | --- | ---: | --- |
| `created` | `use_created_plan` | `false` | The stored successful response identifies a plan that still belongs to the authenticated user + tenant, is active, and has at least one persisted week and session. Its returned `planId` is therefore authoritative for that authenticated scope. |
| `created_inactive` | `refresh_active_plan` | `false` | The stored successful response identifies a complete scoped plan graph whose lifecycle is now `canceled` or `superseded`. The client refreshes active-plan state; it does not recreate with this key. |
| `in_progress` | `retry_same_attempt` | `false` | The scoped attempt has a live lease. |
| `expired` | `repreview_same_attempt` | `false` | A current fenced attempt lease elapsed. Preview again, then submit the newly signed candidate with the same key. The status read itself never reclaims or mutates the row. |
| `expired` | `retry_same_attempt` | `false` | A legacy unfenced attempt lease elapsed. Compatibility clients retry the exact same request and key; request-hash rebinding is forbidden. |
| `known_no_creation` | `start_new_allowed` | `true` | A current fenced row reached `failed`, proving its atomic plan+receipt transaction did not commit, or a legacy row carries an explicit pre-persistence code. |
| `unknown` | `check_status_again` | `false` | Corrupt replay data, missing lease evidence, incomplete/inconsistent plan proof, or another state that cannot safely authorize mutation. |
| `not_found` | `check_status_again` | `false` | No row exists in the authenticated user + tenant scope. Absence is not proof that another attempt did not create a plan. |

Only `known_no_creation` authorizes **Start New**. The public DTO never exposes
request hashes, lease owners, fencing tokens, stored failure codes, or internal
timestamps. Adding a failure code to the service allowlist is therefore a
client-visible safety decision and requires a red pre-persistence proof.
Durable-store or replay-proof read failures return safe HTTP 503 rather than
being collapsed into `unknown` or `not_found`. A `succeeded` receipt is never
deleted, reclaimed, or recreated: missing, inactive, incomplete, wrong-scope,
or corrupt replay proof requires HTTP 409
`TRAINING_PLAN_GENERATION_RECONCILIATION_REQUIRED` while preserving that
receipt; it is never mislabeled as key reuse or work still in progress.

## 6. Signed preview acceptance

`POST /plan/preview` returns an additive `previewToken` when it produces a
preview. The HMAC-signed token is short-lived and binds four facts without
putting profile values or workout prose in the token: authenticated user,
tenant, the complete normalized request/profile context fingerprint, and the
final candidate fingerprint.

`POST /plan/generate` keeps the token optional for compatibility clients. When
a token is supplied, create must:

1. validate signature, scope, and expiry, then compare its context fingerprint
   with the newly computed request context **before** claiming idempotency;
2. rerun the deterministic generator and compare the final candidate with the
   signed candidate **before** plan, Secretary, or calendar persistence; and
3. return HTTP 409 `TRAINING_PLAN_PREVIEW_STALE` with
   `{ requiresPreview: true, reason }` on either mismatch.

After those scope and context checks succeed, a newly signed preview may
rebind the request hash on the **same** idempotency key only when the existing
row is a current fenced `in_progress` attempt with a demonstrably expired
lease. The rebind is a compare-and-swap over the old request hash, lease owner,
and fencing token; it rotates ownership/fencing and increments the attempt
count. This exception requires an explicit client key; an automatic key is
never rebound. Live, failed, succeeded, unfenced, wrong-scope, or tampered-token rows
are never rebound. In particular, corrupt successful receipts remain terminal
reconciliation evidence rather than becoming fresh generation authority.

The context fingerprint uses the same normalized public fields and trusted
user timezone on preview and create, plus the generator-policy version, the
full five-profile Training context fingerprint, and the narrower clarification
answer fingerprint. A context/signature/scope/expiry rejection creates no
idempotency row. Candidate drift marks the already-owned attempt with the
explicit `TRAINING_PLAN_PREVIEW_STALE` pre-persistence code, so §5 can safely
return `known_no_creation` for that exact key.
