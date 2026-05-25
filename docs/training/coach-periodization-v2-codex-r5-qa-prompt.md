# Codex R5 — Adversarial QA prompt (Week-Level Adaptability + Periodization v2.1)

You are an adversarial code-reviewer. The implementer claims to have closed
**every R4 finding** and the implementation of the v2.1 Week-Level Adaptability
+ Periodization plan is now 100% complete. Your job is to disprove that claim.

History (so you know the pattern): every round, the implementer claimed "all
prior fixes are done." Every round, Codex found that ~half of the claimed
fixes were paper-thin (wrong field bound, validator only on REST not on tool,
ledger row written but query never updated, etc.). R1→R2→R3→R4 cumulatively
caught 27+ defects. **Default assumption: there are R4-fix regressions that
look correct on a single test but break under a slightly different input.**

---

## Original goal

Implement the v2.1 plan saved at
`/Users/felipedominguez/.claude/plans/can-you-work-on-polymorphic-lamport.md`
covering 30 slices across 3 phases (Foundation / Periodization / Week-Level
Adaptability). The work activates dormant capability in the deterministic
rule-based coach kernel — week-level adaptability (Layer 6) and progression +
periodization (Layer 9) — without breaking the existing professional
coach-level safety guardrails, two-counter versioning, immutable
`AthleteProfile`, full audit trail, science-policy versioning, multi-source
load model with cold-start status, and consent-gated health data.

The training engine lives in this worktree:
`/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot/.claude/worktrees/cool-keller-56fedc`

CLAUDE.md in this worktree is the bootloader. iOS contracts are out of scope.

---

## What was implemented across all rounds

### Plan slices (Phase A → B → C, 30 total)

- **A0–A5**: adaptation revision column, transactional ledger, completion
  feedback v2 + readiness/health event tables, activated
  `training-principles.json`, A1b periodization policy extension with
  `sciencePolicyVersion`, `ZoneSet` calculator, interval-level intensity
  profiles, `PlanGenerationContext` + cross-week state, safety guardrails
  wired, health privacy + consent, `CoachPlanPolicy` substrate.
- **B0–B8**: separated load dimensions (external/internal/strength/impact,
  never collapsed), EWMA load model + `LoadModelStatus`
  (cold_start/warming/stable), `WeekIntent` discriminated type, `RaceEvent`
  contract + race calendar, mesocycle resolver, configurable intensity
  distribution, symptom-aware preference capture (B4b — capture only, no
  algorithmic modulation), data-informed deload with multi-signal gating,
  strength progression gating (RIR/pain/technical success), day-level taper,
  race-aware taper + post-race recovery enforcement.
- **C1–C8**: missed-session sweep (timezone + grace + external-training
  exclusion), travel window endpoint with stress, per-week equipment
  override, gap detector with typed `ReturnProtocol`, adherence-trend
  signal, week reflow endpoint with preview/apply + idempotency, week
  conditions aggregator + lifecycle wiring, unified scenario classifier
  with `CoachAction[]` discriminated grammar.

### Codex QA rounds closed (cumulative)

- **R1** (P1/P2): 6 findings closed (CompletionFeedbackV2 wiring, reflow
  mutation contract, COACH_PERIODIZATION_V2 mount, missed-session IDs,
  health delete cascade, A1b schema validation in loader).
- **R2** (P0/P1/P2/P3): 10 findings closed (cross-user plan access, reflow
  apply not mutating, hardcoded cosmetic fields, A4 hard-pause wiring,
  CompletionFeedbackV2 reachable from REST/tool, idempotency conflict → 500,
  fail-open science hash, missed-session preview payload field, deletion
  redaction column-level leak, nested schema validation).
- **R3** (P1/P2/P3): 11 findings closed (A4 hard-pause source/trigger
  wiring, protect completed sessions from reflow, real load model in
  coach-analysis, status side-channel in ownership, perActionResults
  surfaced, V2 REST validation + event dedup + tool path, science-policy
  pin + bootstrap + CI wiring, JSON validity guard, full health-sensitive
  redaction, nested schema for remaining 5 sections, race-calendar enum
  validation + count cap).
- **R4** (P1/P2/P3, this session's closeout): 11 findings closed — full
  details in the **R4-CLOSEOUT** section below.

---

## R4-CLOSEOUT (the surface most likely to harbor regressions)

### R4 P1 — closed in earlier sub-session

- **#1 Hard-pause: typed triggers produce block findings.**
  `src/services/coach-kernel/safety-guardrails.ts` now has
  `HARD_PAUSE_TYPED_TRIGGERS` + `buildTypedRedFlagFinding(trigger)` that
  unconditionally emits a `severity: 'block'` finding for chest_pain,
  fainting, severe_dizziness, acute_injury, fever_or_systemic_illness,
  worsening_localized_pain, unexplained_performance_collapse,
  red_s_high_risk. `safety-wiring.ts:mapHealthSignalToSafetyInput` now
  takes an optional `triggerType` and binds it to `input.typedRedFlagTrigger`
  when source is `structured_intake`.
- **#2 Multi-dimensional load model in coach-analysis.**
  `src/api/routes/training-coach-v2.ts` hydrates `dayBucketsPerDim` keyed
  by `LoadDimension` (external/internal/strength/impact), merging per
  dimension via `pickPreferredLoadScore` per dim instead of collapsing
  into a single `'external'` series. Primary dim chosen by plan sport +
  `LoadModelStatus`. Surfaces `loadModelByDimension` +
  `loadModelPrimaryDimension` on the response.
- **#3 Reflow apply uses real aggregated week conditions.**
  Reflow handler now calls `aggregateWeekConditions(...)` with real
  missed-session IDs, travel windows, gap signals, adherence — not the
  stub `{ weekIndex, missedSessionIds: undefined }`.

### R4 P2 — closed in this session

- **#4 V2 number validation + canonical-value event hash.**
  - `src/api/routes/training.ts`: `/complete` rejects `NaN`/`Infinity` +
    per-field ranges (`rir`/`painScore`/`technicalSuccessScore`: 0-10;
    `completedDurationSec`: 0-86400; `completedDistanceMeters`: 0-500000;
    string fields ≤256 / ≤8KB).
  - `src/services/tool-executor.ts`: the `log_training_completion` tool
    case now applies the same `Number.isFinite` + range checks AND
    returns an `error` on bad input (does NOT silently drop bad fields).
  - `src/api/routes/training-completion-v2-hash.ts` (new): extracted
    `computeV2IdempotencyHashHex(fields)` + `buildV2CanonicalSummary` —
    hash basis is the *values* (with length-bounded FNV-1a fingerprint
    for strings, never raw content), so `{painScore:1, rir:2}` and
    `{painScore:9, rir:0}` no longer collide on the outbox dedup key.
    The presence-only `v2Summary` is still emitted on the event payload
    (privacy: log-line never contains the raw value).
  - Tests: `__tests__/api/training-completion-v2-hash.test.ts` (14),
    plus 7 R4 P2 marker tests on `__tests__/api/training-routes.test.ts`.

- **#5 Science-policy gate enforced in CI + pre-commit.**
  - `.github/workflows/ci.yml`: new `science_policy` job runs on every
    push/PR (millisecond-cheap, always fails closed on drift without
    bump).
  - `.husky/pre-commit`: invokes the script when
    `src/services/coach-kernel/knowledge/entities/training-principles.json`
    or `.science-policy-hash` is in the staged diff.
  - Tests: `__tests__/services/science-policy-gate-wiring.test.ts` (8) —
    exercises drift detection by mutating the JSON in a tempdir-like
    flow (backup/restore), confirms exit codes for `verify`,
    `--update` without bump, `--bootstrap`, `--update` with bump.

- **#6 Schema validators reject non-object/array sections.**
  - `src/services/coach-kernel/knowledge-loader.ts`:
    `findMalformedPrinciplesSections` now uses a `requireObject(name, v)`
    helper that explicitly pushes a malformed-section issue when a
    required top-level key arrives as a string/number/array. Prior
    pattern `if (isObj(principles.X)) { ... }` silently skipped the
    inner check on wrong-typed inputs. Adds `describeValue(v)` for
    debuggable error messages (`"string(length=4)"` /
    `"array(length=3)"`).
  - Tests: 13 new rejection tests in
    `__tests__/services/coach-kernel-knowledge-loader-schema.test.ts`
    covering every required top-level section.

- **#7 Strict YYYY-MM-DD validation on `/health-intake/red-flag` + `/week/travel`.**
  - `src/api/routes/training-coach-v2.ts`: new exported
    `isStrictIsoDate(s)` — strict `^\d{4}-\d{2}-\d{2}$` regex + UTC
    `Date` round-trip (rejects `2026-13-01`, `2026-02-30`, `tomorrow`,
    `2026-05-23T00:00:00Z`, injection-shaped strings, whitespace-padded
    dates, years outside 1900-2200).
  - `/week/travel` additionally enforces `endDate >= startDate`
    (lexicographic compare valid on strict YYYY-MM-DD).
  - Tests: `__tests__/api/training-coach-v2-strict-date.test.ts` (20)
    + 8 R4 P2 route tests added to
    `__tests__/api/training-coach-v2-routes.test.ts`.

- **#8 Shared ACTIONABLE_SESSION_STATUSES allowlist.**
  - `src/services/coach-kernel/session-status.ts` (new): single source
    of truth — `TERMINAL_SESSION_STATUSES = ['completed','skipped','moved']`
    + `ACTIONABLE_SESSION_STATUSES = ['pending','scheduled']` + type-narrow
    predicates + SQL-literal helpers (`terminalStatusesSqlList()`,
    `actionableStatusesSqlList()`).
  - Wired into 4 SQL `NOT IN (...)` clauses in
    `src/services/coach-kernel/coach-action-executor.ts`, the in-memory
    triple-OR there, `src/services/missed-session-sweep.ts` (`IN (...)`),
    and `src/api/routes/training-coach-v2.ts` (in-memory filter).
  - Tests: `__tests__/services/coach-kernel-session-status.test.ts`
    (16) — includes regression-by-source-grep that the hand-rolled
    tuples are gone.

- **#9 Centralize reflow response serializer.**
  - `src/api/routes/training-coach-v2-reflow-serializer.ts` (new):
    `serializeReflowResponse(...)` and `buildReplayReflowResult(...)`.
    Both the happy path AND the idempotency-conflict replay branch now
    emit the SAME shape (`mode`, `adaptationId`, `adaptationRevision`,
    `alreadyExisted`, `mutated`, `mutatedRows`, `actions`,
    `perActionResults`, `scenario`, `sciencePolicyVersion`). Replay
    emits empty actions/perActionResults + null scenario (the
    canonical record is in the ledger) but iOS can decode both with
    one Codable.
  - Tests: `__tests__/api/training-coach-v2-reflow-serializer.test.ts` (10).

### R4 P3 — closed in this session

- **#10 Redact `ownerId` in ownership-denied logs.**
  - `src/api/routes/training-coach-v2.ts`: new exported
    `hashOwnerIdForLog(userId)` — FNV-1a 32-bit mix → 24-bit mask →
    `u#` + 6-char hex. Both `resolveOwnedPlan` and `resolveOwnedWeek`
    now log `ownerIdHash` instead of `ownerId`. Audit correlation
    preserved (deterministic per input); operator log cannot
    reconstruct the victim integer.
  - Tests: `__tests__/api/training-coach-v2-owner-id-hash.test.ts` (6).

- **#11 Surface race-calendar drops + cap reasons.**
  - `src/api/routes/training-coach-v2-hydration.ts`: added
    `resolveRaceCalendarFromPlanWithReport(...)` returning
    `{ races, droppedCount, dropReasons (typed RaceCalendarDropReason),
       capApplied, capTruncatedCount }`. Original
    `resolveRaceCalendarFromPlan` is now a thin wrapper for
    backward-compat. `/coach-analysis` exposes the report as
    `raceCalendarDrops` and logs drops at
    `race_calendar.entries_dropped_on_resolve`.
  - Tests: `__tests__/api/training-coach-v2-race-calendar-drops.test.ts`
    (12).

- **#12 Parameterize `REDACTED_TRIGGER_BUCKET` in deletion SQL.**
  - `src/services/training-plan-adaptations.ts`: the `purgeSensitivePayloadsForUser`
    `UPDATE` previously interpolated `${REDACTED_TRIGGER_BUCKET}` into
    the SQL via template literal. Now bound as two `?` parameters,
    eliminating the injection-shaped habit even though the constant
    is compile-time.
  - Tests: 2 R4 P3 tests added to
    `__tests__/services/training-plan-adaptations.test.ts` — one
    source-grep regression, one functional regression.

---

## Files changed (R4 closeout, this session)

### New
```
src/api/routes/training-completion-v2-hash.ts
src/api/routes/training-coach-v2-reflow-serializer.ts
src/services/coach-kernel/session-status.ts
__tests__/api/training-completion-v2-hash.test.ts
__tests__/api/training-coach-v2-strict-date.test.ts
__tests__/api/training-coach-v2-reflow-serializer.test.ts
__tests__/api/training-coach-v2-race-calendar-drops.test.ts
__tests__/api/training-coach-v2-owner-id-hash.test.ts
__tests__/services/coach-kernel-session-status.test.ts
__tests__/services/science-policy-gate-wiring.test.ts
docs/training/coach-periodization-v2-codex-r5-qa-prompt.md   (this file)
```

### Modified
```
.github/workflows/ci.yml
.husky/pre-commit
src/api/routes/training.ts
src/api/routes/training-coach-v2.ts
src/api/routes/training-coach-v2-hydration.ts
src/services/tool-executor.ts
src/services/coach-kernel/knowledge-loader.ts
src/services/coach-kernel/coach-action-executor.ts
src/services/missed-session-sweep.ts
src/services/training-plan-adaptations.ts
__tests__/api/training-routes.test.ts
__tests__/api/training-coach-v2-routes.test.ts
__tests__/services/coach-kernel-knowledge-loader-schema.test.ts
__tests__/services/training-plan-adaptations.test.ts
```

Everything else listed in `git status --short` (broader 155-file diff) is
either prior R1/R2/R3 closeout work or the original 30-slice implementation.
The R4 closeout above is what's most likely to harbor fresh defects.

---

## Expected behavior

### Hard-pause path
- A `POST /api/v1/training/health-intake/red-flag` with
  `illnessSymptoms: ['fainting'|'chest_pain'|'severe_dizziness']` or
  `injuryStatus: 'acute'` → persists a `structured_intake` row →
  next `/coach-analysis` returns `scenario.actions` containing
  `{ type: 'pause_training', severity: 'medical_referral', ... }`.
- The SAME symptoms arriving via a non-`structured_intake` source
  (e.g. `wearable`) → warning-only, **no** pause_training action.
- Hard-pause never depends on pain score being set.

### Load model
- For a cycling plan with ≥14 days of completions, primary dimension =
  `external`; for running, `external` if pace/power present, else
  `internal` (sRPE-derived); for strength, `strength`. With <14d of
  completions, `LoadModelStatus = 'cold_start'` and primary
  recommendation reads from declared training history caps.
- All four dimensions are surfaced on the `/coach-analysis` response
  as `loadModelByDimension` AND remain populated separately even when
  external dim is empty.

### Reflow
- Apply mode without `idempotencyKey` → 400 `IDEMPOTENCY_REQUIRED`.
- Apply mode with same `idempotencyKey` within 24h → 200 with
  `alreadyExisted: true, mutated: false`, SAME shape as fresh apply
  (including `actions: []`, `perActionResults: []`, `scenario: null`).
- Preview mode → no `adaptation_revision` bump, no session mutation,
  no idempotency key required.
- Apply never mutates rows with status in `{completed, skipped, moved}`.
- `perActionResults` is always an array (never undefined) on the response.

### V2 completion validation
- `POST /api/v1/training/complete` with `{ rir: NaN }` → 400 BAD_INPUT.
- Same with `{ painScore: Infinity }`, `{ rir: 25 }`, oversized JSON →
  400 BAD_INPUT.
- Valid V2 payload with no active plan → 200 soft success (NOT 400).
- Two distinct V2 value payloads → distinct idempotency keys
  (`...v2-<hash>`), so the second is NOT deduped by the outbox.
- `log_training_completion` tool with `{ rir: NaN }` → returns
  `{ error: ... }`, does NOT silently drop the field.

### Date validation
- `/health-intake/red-flag` with `date: 'tomorrow'`, `'2026-13-01'`,
  `'2026-02-30'`, `'2026-05-23T00:00:00Z'`, `"1970-01-01' OR 1=1"` →
  400 BAD_INPUT.
- `/week/travel` with bad date → 400. With `endDate < startDate` → 400.
  With `endDate == startDate` → 201.

### Schema validation
- `training-principles.json` loaded with `taperCoefficients: "TODO"`
  (any required key as wrong type) → throws
  `TrainingPrinciplesMalformedSectionError` at load time with
  `<key>: must be an object (got string(length=4))` in the message.

### Race-calendar drops
- `/coach-analysis` for a plan whose `preferences_json.raceCalendar`
  has 60 entries → response includes
  `raceCalendarDrops: { droppedCount: 0, capApplied: true,
   capTruncatedCount: 10, dropReasons: {...zeros} }`.
- With invalid enums mixed in →
  `dropReasons.unknown_discipline` / `.unknown_priority` /
  `.missing_required_field` / `.invalid_entry_shape` reflect counts
  that sum to `droppedCount`.

### Privacy
- `purgeSensitivePayloadsForUser(userId)` →
  `trigger_type = 'health_sensitive'` AND
  `trigger_payload_json.triggerType = 'health_sensitive'` for every
  affected row. Original category (`'pain_flag'`, `'menstrual_symptom'`,
  etc.) is completely gone — `SELECT WHERE trigger_type = 'pain_flag'`
  returns 0 rows.
- Ownership-denied log lines contain `ownerIdHash: 'u#XXXXXX'`, never
  raw user id integers.

### Session-status allowlist
- Adding a new terminal status only requires editing
  `src/services/coach-kernel/session-status.ts`. The 5 prior call
  sites read from `TERMINAL_SQL_LIST` / `ACTIONABLE_SQL_LIST` /
  `isTerminalSessionStatus` / `isActionableSessionStatus` — no
  hand-rolled tuples remain in production code.

### Science-policy gate
- Editing `training-principles.json` without bumping
  `sciencePolicyVersion` AND rerunning
  `scripts/ci/science-policy-version-check.mjs --update`:
  - Pre-commit hook fails before commit lands.
  - CI workflow fails on push/PR.
  - Live gate exits 1 with the explanation.

---

## Tests + checks already performed

- `npx tsc --noEmit`: **clean** at every R4 closeout step.
- `npx vitest run` across all R4-affected files + coach-kernel +
  adaptations + ancillary services: **2611 tests passing across 214
  test files** (final pass).
- Targeted R4 surface (14 test files specifically tied to R4 P1/P2/P3
  fixes): **285 tests passing**.
- `science-policy-version-check.mjs` against live pin: exits 0
  ("OK — sciencePolicyVersion 1.0.0 content matches pin").
- Drift detection wiring (`science-policy-gate-wiring.test.ts`)
  proves the gate actually fails closed when JSON content drifts
  without a version bump.
- Source-grep regression tests guarantee the prior hand-rolled
  tuples (`'completed','skipped','moved'` literal) and the
  template-literal `${REDACTED_TRIGGER_BUCKET}` are gone from
  production code.

---

## Areas to inspect carefully

These are the places where prior rounds caught look-correct-but-wrong fixes,
so focus your adversarial pass here:

1. **R4 P2 #4 tool path parity.** Confirm the `log_training_completion`
   tool case in `src/services/tool-executor.ts` actually rejects on
   `Number.isFinite` failure AND on range failure. Test path: chat
   pipeline → tool input → return shape. Does the bad-payload error
   propagate up correctly, or does some upstream catch swallow it?
   Read `src/services/tool-executor.ts` around the `case 'log_training_completion'`
   block and trace what happens on `{ error: '...' }` return.

2. **R4 P2 #4 hash distinctness under partial overlap.**
   `computeV2IdempotencyHashHex` should distinguish
   `{painScore: 1}` from `{rir: 1}` (different *fields*) AND
   `{painScore: 1}` from `{painScore: 2}` (different *values*) AND
   `{painLocation: 'a'}` from `{painLocation: 'b'}` (different string
   content, same length). Are there cases I missed where two distinct
   payloads collide?

3. **R4 P2 #6 schema-loader wrong-type guard.** I added `requireObject`
   for the *top-level* keys. What about wrong-typed *nested* keys (e.g.
   `taperCoefficients: { byPriority: 'TODO' }`)? Do those still fall
   through silently, or does the inner code path catch them?

4. **R4 P2 #7 date validation reach.** `/health-intake/red-flag` and
   `/week/travel` are now strict. What about any other v2 endpoint
   that accepts a date string? Did I miss one? Grep
   `src/api/routes/training-coach-v2.ts` for `body.date` /
   `body.startDate` / `body.endDate` / `body\.\w*[Dd]ate`.

5. **R4 P2 #8 session-status SQL injection.** The SQL-literal helpers
   interpolate `'identifier', 'identifier'` into the query string. Is
   there ANY code path that could write to
   `TERMINAL_SESSION_STATUSES` / `ACTIONABLE_SESSION_STATUSES` at
   runtime? (They're `as const` tuples, but verify the type guard is
   real and not casted-away somewhere.)

6. **R4 P2 #9 serializer shape parity.** Verify both branches really
   emit the same key set. Confirm by reading the route handler — is
   there any place that bypasses `serializeReflowResponse` and emits
   a raw object? Look for stray `sendSuccess(res, { ... }) ` calls in
   the reflow handler scope.

7. **R4 P3 #10 owner-id hash collision.** 24-bit hash space — what's
   the probability of two real user ids in the population colliding,
   and does that defeat the audit-correlation property? Is `u#000000`
   reachable for a valid user id? (If yes, an attacker could spoof
   collisions to make their access look like another user's.)

8. **R4 P3 #11 race-calendar report propagation.** `/coach-analysis`
   surfaces drops, but does the reflow handler? Coach-analysis already
   uses `resolveRaceCalendarFromPlan` (line 522 — the legacy wrapper).
   Are there places where the report would be valuable but the
   wrapper is still used silently?

9. **R4 P3 #12 SQL parameterization.** Did I miss any other
   sensitive-name interpolation elsewhere in
   `src/services/training-plan-adaptations.ts`? Grep for `${` inside
   `db.prepare(\`...\`)` blocks.

10. **A4 hard-pause UI dependency.** The plan called out that until
    iOS ships structured red-flag intake, hard-pause only fires via
    the typed-API shape. Confirm there's no inferred-text code path
    that promotes an unstructured string into the typed-trigger set.
    Read `safety-wiring.ts:deriveSafetyTriggerFromSignal`.

11. **Anti-churn rate limits.** `CoachPlanPolicy.adaptationRateLimits`
    is consumed by the scenario classifier. Confirm safety overrides
    are actually exempt from the rate limit (the plan demanded this).
    Read `src/services/coach-kernel/scenario-classifier.ts` around
    the `adaptationRateLimit*` parameters.

12. **Cold-start invariant.** `<14d` of completions disables
    ACWR-based deload. Verify in `src/services/coach-kernel/deload-recommendation.ts`
    that the cold-start gate actually blocks the ACWR contribution
    (not just attenuates it). Edge case: exactly 14 days.

13. **R4 P2 #5 CI workflow gate strictness.** Does the `science_policy`
    job pass when the file was correctly bumped + re-pinned in the
    same commit? The pre-commit hook runs the script in verify mode
    only if files are staged — does that produce the right result
    when both the JSON and the `.science-policy-hash` are staged
    together (the intended workflow)?

14. **Ledger transactionality.** Adaptation ledger row + revision bump
    + session mutations must commit/rollback as one transaction. With
    the reflow apply path now calling
    `executeCoachActions` → `executeWeekReflow`, is the executor
    inside the outer transaction? A failure in one of N actions
    must NOT leave the revision bumped without all mutations
    committed.

15. **`AthleteProfile` immutability.** A3 promised
    `ReadinessSnapshot` + `HealthSignal` events flow through
    `PlanGenerationContext`, never mutating the profile. Confirm
    no engine writes back to a profile field at runtime. Grep
    `src/services/coach-kernel/` for any assignment to
    `profile.readiness*` or `profile.healthSignal*`.

---

## Edge cases to verify

- Athlete with zero completions → cold-start path, no ACWR consulted,
  deload only on scheduled cadence.
- Same `idempotencyKey` submitted twice concurrently (race) → exactly
  one ledger row, second request gets replay response.
- Race-calendar with `MAX_RACE_CALENDAR_ENTRIES = 50` entries exactly →
  `capApplied: false, capTruncatedCount: 0` (off-by-one regression
  surface).
- Date string `1900-01-01` and `2200-12-31` → accepted (boundary).
  `1899-12-31` → rejected. `2201-01-01` → rejected.
- `purgeSensitivePayloadsForUser(userId)` where user has zero sensitive
  rows → returns 0, doesn't throw.
- Reflow apply with classifier returning zero actions → revision still
  bumps, ledger row written, `mutated: false, mutatedRows: 0`.
- `/coach-analysis` for a plan with `preferences_json = null` → no
  raceCalendarDrops error, drops report all zeros.
- `ownerIdHash` for `userId = 1` is consistent across processes (FNV
  is deterministic; verify no `Math.random` or `Date.now` snuck in).
- Hard-pause typed trigger arriving alongside a benign payload (e.g.
  `injuryStatus: 'acute'` with `painScore: 0`) → still pauses (the
  pause must not be gated on pain score).
- Multisport race week (`raceFormat: 'multisport', disciplines:
  ['running','cycling','swimming']`) → taper + post-race-recovery
  respects per-discipline windows.

---

## Known risks + assumptions

- **iOS contract**: `raceCalendarDrops`, `intensitySummary`,
  `intensityProfile`, `coachActions`, `CoachPlanPolicy`, `ReturnProtocol`
  are NEW response fields. iOS read paths must tolerate them. The plan
  promised schema-versioning compatibility (`?schemaVersion=N`); verify
  the backend never sends a new field to a client that requested an
  older version.
- **Anti-churn limits + behavior change**: B4/B5/B6/B7 ship "warning
  only" behind `COACH_PERIODIZATION_V2_ENABLED`. Confirm the flag
  default is OFF in production-equivalent config. Confirm the
  warning-only path actually surfaces decisions without mutating
  sessions.
- **Health data privacy retention**: A4p promised 12-month active +
  12-month archive then purge for sensitive data. Verify there's a
  scheduled job or documented operator runbook for the purge — not
  just the deletion endpoint.
- **CI test floor**: Plan promised the floor stays ≥ current. Confirm
  full vitest count hasn't regressed (≥ 7335 tests; the focused R4
  surface count is 2611).
- **Science-policy version bump cadence**: The hash gate fails closed
  on JSON change without bump. If multiple PRs touch the JSON in
  parallel they'll race on the pin. Document the expected merge
  protocol (rebase + re-pin) or accept that one PR will need to
  re-run the gate after merge.
- **24-bit owner-id hash**: Deliberately small. If the operator
  population grows past ~4000 unique owners under audit review, hash
  collisions become non-trivial (birthday). Hash is for log
  correlation, not authentication, so this is by design — but verify
  no consumer treats the hash as authoritative identity.

---

## What "complete" means for this review

Your verdict should be one of:

- **GO**: All R4 closeout items hold up under adversarial inspection;
  the implementation matches the plan's expected behavior at every
  invariant. Ready for staging soak.
- **NO-GO** (with the list of new findings classified P1/P2/P3):
  Specific defects you found, each with `file:line`, the contract
  it breaks, and a suggested fix shape. Be precise — the implementer
  has shipped 4 rounds of fixes and the gap between "looks right"
  and "is right" is exactly what you're hired to close.

Be brutal. The implementer expects to see new findings — what you
find will become R5.
