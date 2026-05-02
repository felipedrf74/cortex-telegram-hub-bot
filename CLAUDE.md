# CLAUDE.md — Nexus Hub Backend

## Agent Bootloader - Read First

This file is a repo-local bootloader. Before creating or updating markdown,
read:

1. `/Users/felipedominguez/Desktop/Nexus Hub/docs/DOCS_INDEX.md`
2. `docs/DOCS_INDEX.md`
3. `docs/release/current-release-index.md`
4. `docs/qa/QA_BACKEND_REPORT.md`

Do not create a new scattered final report when a current/canonical doc already
exists. Update the current doc and link any one-off evidence from the current
index. Historical reports are evidence, not active truth, unless the current
release index links them.

**You are working directly on the single-source-of-truth backend for Nexus Hub, a multi-domain AI personal assistant.** Do not assume a multi-agent orchestration, queue system, or "role" — those files were removed in Phase 0 (April 2026). There is one codebase, one main branch, one human owner (Felipe), and one deploy path.

---

## Project

**Nexus Hub** — AI-powered personal operating system. TypeScript/Node.js backend (`@nexushub/core`), Python FastAPI content engine, Swift/SwiftUI iOS client, SQLite data, PM2 process manager, Cloudflare Tunnel for HTTPS.

**Domains**: secretary, triathlon (being split into gym/running/cycle/swim in Phase 1), content creator, finance, cooking.

**Providers**: Gemini primary (2.5-flash / 2.5-flash-lite), Anthropic fallback (Claude Sonnet 4.6 / Haiku 4.5), OpenAI as secondary fallback. See `src/config.ts > providerRouting`.

## Current Production Truth - 2026-04-27

- Production backend is live at `4.14.99` (deploy bump from `4.14.98`).
- Staging is aligned to `4.14.98`.
- Current deployed branch: `main`.
- Historical beta recovery branch: `beta/single-agent-rc`.
- Full backend verification passed before the latest production deploy:
  368 test files / 5,875 tests.
- Production deploy health passed for content engine, status portal, and bot
  online at deploy commit `d7b9502`; merge commit `384ab52` brought the
  Training engine + agenda orchestration overhaul into main; staging was
  aligned to `4.14.98` before the promote and passed the 17/17 staging smoke.
- `4.14.99` shipped the **Training engine + agenda orchestration overhaul
  (8 slices closing 3 audit-confirmed regressions + deepening Layers
  2/3/5/7/8)** as a single batch promote:

  - **Slice 4.A `f09383c`** — `SessionCoherenceValidator` closes regression #1
    (volume × time mismatch). New `src/services/coach-kernel/session-coherence.ts`
    with deterministic estimator + verdict + corrective-action types. Wired into
    `applyCoherenceGate` after every strength session build; rebuilds/shrinks/
    trims content when claimed minutes diverge from estimated by >20%. 27 pin
    tests cover parseRepsForTimeEstimate / estimateExerciseSetSeconds /
    estimateStrengthSessionMinutes / validateSessionCoherence / suggestCorrection
    + the 48-min Dead Bug regression.

  - **Slice 4.B `8fe0e58`** — Catalog-grounded support-session builder closes
    regression #2 (variety failure). New `support-session-builder.ts` with 4
    variants using real catalog `exerciseId`s + estimator-derived
    `durationMinutes`. Replaces the legacy `strengthSupportVariants()`
    text-string injection in `training-plan-volume-enforcement.ts`. Beginner-
    safe defaults consistent with slice 2.A. Movement-pattern rotation makes
    "two consecutive identical strength sessions" structurally impossible.
    15 pin tests.

  - **Slice 4.D `6b19b72`** — Plan lifecycle ownership audit table + idempotent
    agenda sync closes regression #3 root causes #2+#3. Migration 081 adds
    `fitness_training_plans.plan_version` + non-cascaded
    `training_agenda_event_ownership` table with CHECK constraint + UNIQUE
    backstop on `(plan_id, plan_version, event_id, source)`. New
    `training-plan-lifecycle.ts` (291 LOC) with 7 helpers. Persistence loop is
    now idempotent on retry; cancellation marks ownership rows as `'deleted'`
    or `'orphaned'` with reason. 20 pin tests.

  - **Slice 4.D.2 `e1cedd8`** — Pre-persist cancellation saga closes
    regression #3 root causes #1+#4 (transaction wrapping + silent error
    suppression). New `runPrePersistCancellationSaga` with 5-branch
    discriminated outcome (`success | no_active_plan | external_partial |
    forbidden | local_delete_failed`). When local hard-delete fails the
    saga aborts the persist instead of producing a double-plan corruption,
    returning new `'cancellation_failed'` status (HTTP 409). 5 saga pin tests.

  - **Slice 4.E `48352a3`** — Real metrics history reads close Layer-8 critical
    synthesis gap. New `src/services/training-history.ts` reads
    `training_completions` joined with `training_sessions` + scoped by user_id
    via plan FK. 4-week rolling window in 7-day buckets. Sport normalization
    handles all aliases. `resolveTrainingHistory` accepts an optional
    `realHistory` arg and OVERRIDES the synthesized 4-copy series when real
    data exists per sport. ACWR math now runs against real adherence + duration.
    17 pin tests.

  - **Slice 4.C `0686891`** — Multi-week variant rotation closes the cross-
    week variety gap. `strengthVariantFor` and `buildStrengthSupportVariant`
    take an optional `weekIndex` parameter; slot is shifted by the week index
    modulo the variant pool size. For 4-session weeks, gives a 4-week
    macro-rotation: any (slot, week-mod-4) pair produces a distinct variant.
    `currentBlock.weekIndex` (1-based) feeds the shift via subtract-1. 9 pin
    tests + 4 pre-existing strength-engine tests updated to flatMap across
    sessions instead of pinning slot 0.

  - **Slice 4.F `61b2cb7`** — Availability-aware day picks across running/
    cycling/swimming engines. New `availability-day-picker.ts` with 4
    helpers. Engines now pick days from preference lists where the user has
    declared availability windows for the sport. Falls back to legacy hardcoded
    defaults when no availability data exists (brand-new user). 15 pin tests.
    NOTE: the audit's "goal→split→role mapping" half deferred to a follow-up
    slice.

  - **Slice 4.G `7c35e06`** — Catalog metadata enrichment foundation. Adds 6
    new optional fields to `Exercise` (complexity, spinalLoading, unilateral,
    primaryPurpose, contraindicationFlags, warmupNeeds). 20 of 24 exercises
    seeded with explicit values in `exercises.json`. New
    `exercise-metadata.ts` with 7 helpers + smart defaults derived from
    movementPattern + equipment for un-seeded exercises. 35 pin tests.

  - **Slice 4.H `08273a4`** — Biomechanics-aware substitution + session-order
    logic. New `biomechanics-and-ordering.ts` with two pure helpers:
    `applyBiomechanicsSafetySubstitutions` (swaps an exercise to its first
    non-conflicting catalog substitution when the user's painFlags conflict
    with its contraindicationFlags), `orderExercisesForSession` (5-tier
    phase ordering: squat/hinge → push/pull/single_leg → carry → core →
    mobility). Both wired into the strength engine pipeline after equipment
    resolution. 17 pin tests.

  Verification: `npx tsc --noEmit` clean per slice; full backend regression
  368 / 5,875 green; 17/17 staging smoke green per slice; final batch
  staging smoke green; production deploy gate 17/17 + content engine + status
  portal + bot online + DB integrity_check ok. Three documents track the
  overhaul: `docs/training/training-engine-final-report.md` (14-section
  populated report), `docs/training/training-engine-gap-analysis.md` (Phase 0
  audit), `docs/training/training-engine-open-items.md` (Critical/High empty;
  Medium/Low list deferred enhancements: Layer 6 week-level adaptability,
  Layer 9 progression, goal→split mapping, Layer 10 explainability polish).

- The preceding `4.14.97` shipped **coach-engine slice 3.M — explicit endurance
  weekly-minutes provenance (Layer 1, audit follow-up)**:
  - The previous `resolveTrainingHistory` in
    `services/training-coach-kernel-plan-generator.ts` had two
    silent-fallback ternaries: running silently used
    `weeklyTargets.running × 45 min/session` when
    `run_profile.weekly_mileage_km` was missing, and cycling
    silently used `weeklyTargets.cycling × 55 min/session` when
    `run_profile.weekly_hours` bucket was missing. Both fed
    `lastWeekMinutesBySport` which feeds ACWR load math; if the
    heuristic was too high, ramp-up got suppressed (overtraining
    concern); too low, ramp-up became too aggressive. Operators
    had no way to tell which users were on real data vs heuristic.
  - Slice 3.M splits the inline ternaries into two pure exported
    functions:
    `resolveRunningWeeklyMinutesWithSource(runProfile, weeklyTarget, paceSecPerKm)`
    and
    `resolveCyclingWeeklyMinutesWithSource(runProfile, weeklyTarget)`.
    Both return a three-branch discriminated union:
    `{ value, source: 'profile_data', rawInputField, rawInputValue }`
    for real data, `{ value, source: 'inferred_from_targets',
    weeklyTarget, minutesPerSession }` for the silent-fallback
    case (now visible), or `{ value: undefined, source: 'no_volume' }`
    when neither real data nor a non-zero target exists.
  - The constants (45min/running, 55min/cycling, 60min running
    floor) are extracted as named constants so future tuning is
    one-line. The `no_volume` branch returns `value: undefined`
    so the planner reads "no history at all" instead of
    synthesizing zero — distinct from a user with a non-zero
    target where inference legitimately fires.
  - `resolveTrainingHistory` becomes a pure builder over
    pre-resolved per-sport values. Strength and swimming use
    `targets × constant` always (no real-data field on input),
    so they're not in scope for this slice.
  - The single existing call site in
    `buildAthleteStateFromTrainingProfiles` consumes both
    resolutions and emits per-sport structured pino warnings at
    warning level when inference fires. Surface names:
    `coach-kernel.buildAthleteStateFromTrainingProfiles.runningWeeklyMinutes`
    and `.cyclingWeeklyMinutes`.
  - 21 new unit tests in
    `__tests__/services/training-coach-kernel-training-history.test.ts`
    cover both resolvers — `profile_data` path (numeric + string
    mileage, 60-min floor, pace conversion, all 4 cycling
    buckets), `inferred_from_targets` path (absent / null / zero
    / non-numeric mileage; absent / unrecognized cycling hours),
    and `no_volume` path.
  Verification: `npx tsc --noEmit` clean, focused 119-test slice
  (21 new + 19 strength-goal + 26 primary-focus + 20 equipment +
  17 experience + 8 plan-generator + 8 strength-engine) green,
  full backend regression `npm run verify` 360 / 5,715 green,
  staging smoke 17/17, production deploy gate 17/17, production
  health passed for content engine + portal + bot. Two remaining
  silent-default sites can each adopt the same shape
  (`resolveThresholdPace`, the `numericOrUndefined` chains).

- The preceding `4.14.96` shipped **coach-engine slice 3.L — explicit strength-goal
  resolution provenance (Layer 1, audit follow-up)**:
  - The previous `resolveStrengthGoal` in
    `services/training-coach-kernel-plan-generator.ts` matched the
    `gym_profile.primary_goal` string against four keywords
    (`'hypertrophy'`, `'powerlifting'`, `'strength'`, `'support'`)
    and silently returned `'athletic'` when none matched. Since
    `Goals['strengthGoal']` drives strength prescription template
    selection — `'hypertrophy'` / `'max_strength'` / `'athletic'`
    / `'maintenance'` produce different rep ranges, intensity, and
    exercise selection — a silent fallback to `'athletic'` for a
    user typing `"powerbuilding"` / `"general fitness"` / `"tone"`
    was a real plan-shape difference, not just a labeling
    concern.
  - The new exported `resolveStrengthGoalWithSource()` returns the
    same two-branch discriminated union slice 3.J established:
    `{ value, source: 'gym_profile.primary_goal', matchedKeyword }`
    for recognized vocabulary, or
    `{ value, source: 'fallback', reason: 'missing' | 'unrecognized', rawInput? }`
    otherwise. `'unrecognized'` carries the raw input so the
    call-site logger emits an actionable signal when new
    vocabulary appears in production.
  - Implementation refactored from the inline if-chain into a
    sorted `STRENGTH_GOAL_KEYWORDS` lookup table walked via
    `String.includes`. Order matters — `'powerlifting'` appears
    BEFORE `'strength'` (both map to `'max_strength'`) so a user
    typing "Powerlifting strength" gets
    `matchedKeyword: 'powerlifting'` (more specific intent).
  - **Vocabulary discipline**: slice 3.L deliberately preserves
    the existing keyword set exactly. Adding `'maintenance'` or
    `'powerbuilding'` would shift inputs from `'athletic'` to a
    different bucket — a real behavior change that belongs in a
    separate vocabulary-expansion slice once the call-site
    fallback log surfaces what users actually type. Pinned by
    the new `test_unrecognized_for_literal_word_maintenance`.
  - The single existing call site in
    `buildAthleteStateFromTrainingProfiles` now consumes the rich
    form and emits a structured pino warning at warning level
    when fallback fires, with different message text for missing
    vs unrecognized so future alert routing can prioritize the
    latter.
  - 19 new unit tests in
    `__tests__/services/training-coach-kernel-strength-goal.test.ts`
    pin every recognition path (4 vocabulary keywords + match-
    precedence rules + 4 fallback subcases including the killer
    "powerbuilding" / "general fitness" / "tone" examples + non-
    string-type rejection + whitespace handling + scope-discipline
    assertion).
  Verification: `npx tsc --noEmit` clean, focused 98-test slice
  (19 new + 26 primary-focus + 20 equipment + 17 experience + 8
  plan-generator + 8 strength-engine) green, full backend
  regression `npm run verify` 359 / 5,694 green, staging smoke
  17/17, production deploy gate 17/17, production health passed
  for content engine + portal + bot. Three remaining
  silent-default sites can each adopt the same shape
  (`resolveThresholdPace`, `resolveTrainingHistory`, the
  `numericOrUndefined` chains).

- The preceding `4.14.95` shipped **coach-engine slice 3.K — explicit primary-focus
  resolution provenance (Layer 1, audit follow-up)**:
  - The previous `resolvePrimaryFocus` in
    `services/training-coach-kernel-plan-generator.ts` matched the
    objective string against six regex patterns and silently
    returned `'hybrid'` when none matched. Downstream
    `resolveWeeklyTargets`, `resolveRaceCalendar`, and
    `resolvePriorityOrder` all switch on `primaryFocus`, so a
    silent fallback to `'hybrid'` produced a globally different
    plan shape compared to a recognized objective — same input
    weekly volume, totally different output. The audit flagged
    this as one of the highest-leverage Layer 1 silent defaults.
  - The new exported `resolvePrimaryFocusWithSource()` returns
    a discriminated union distinguishing THREE runtime cases the
    previous version produced as identical `'hybrid'` outputs:
    `{ value, source: 'objective_keyword', matchedKeyword }` for
    recognized vocabulary, `{ value: 'hybrid',
    source: 'inferred_volume_split' }` for the intentional hybrid
    inference (user has both endurance and strength sessions),
    or `{ value: 'hybrid', source: 'fallback',
    reason: 'missing' | 'unrecognized', rawInput? }` otherwise.
  - Implementation refactored from regex literals into a sorted
    `OBJECTIVE_KEYWORDS` lookup table walked via `String.includes`.
    Order is significant — most specific subdiscipline first, so
    "Half Ironman" matches `'half ironman'` (not `'ironman'`),
    "Trail running" matches `'trail'` (not `'running'`),
    "Swimming endurance" matches `'swimming'` (not `'swim'`).
  - **Byproduct fix**: the legacy `/70\\.3/` regex had a
    double-backslash typo that matched a literal backslash
    followed by any char — so a user typing just "70.3" used to
    fall through to `'hybrid'`. The substring rewrite naturally
    fixes this; "70.3" now correctly maps to `'triathlon'`.
  - The single existing call site in
    `buildAthleteStateFromTrainingProfiles` now consumes the rich
    form and emits a structured pino warning at warning level
    when fallback fires (NOT for the intentional volume-split
    inference), with different message text for missing vs
    unrecognized so future alert routing can prioritize the
    latter.
  - 26 new unit tests in
    `__tests__/services/training-coach-kernel-primary-focus.test.ts`
    pin every recognition path (every keyword in every discipline
    + match-specificity ordering for "half ironman" / "trail
    running" / "swimming endurance" + the 70.3 typo regression
    + volume-split intentional-hybrid + match precedence + four
    fallback subcases + case insensitivity).
  Verification: `npx tsc --noEmit` clean, focused 79-test slice
  (26 new + 20 equipment + 17 experience + 8 plan-generator + 8
  strength-engine) green, full backend regression `npm run verify`
  358 / 5,675 green, staging smoke 17/17, production deploy gate
  17/17, production health passed for content engine + portal +
  bot. Four remaining silent-default sites can each adopt the
  same shape (`resolveStrengthGoal`, `resolveThresholdPace`,
  `resolveTrainingHistory`, the `numericOrUndefined` chains).

- The preceding `4.14.94` shipped **coach-engine slice 3.J — explicit equipment-access
  resolution provenance (Layer 1, audit follow-up)**:
  - The previous `resolveEquipmentAccess` in
    `services/training-coach-kernel-plan-generator.ts` string-matched
    against a known keyword list (`'full gym'` / `'garage'` /
    `'home gym'` / `'basic'` / `'bodyweight'` / `'band'`) and
    silently returned `hasGym/hasBarbell/hasDumbbells: false` when
    the input didn't match any keyword. A real-gym user typing
    "Crossfit box", "Hotel gym", "YMCA", or "University rec center"
    got their barbell and dumbbell access stripped silently — the
    strength engine then fell into bodyweight/band-only patterns
    even though the user had a fully-equipped facility.
  - Slice 3.J applies the slice 3.I template with a richer fallback
    discriminator: the new exported
    `resolveEquipmentAccessWithSource()` returns
    `{ value, source: 'gym_profile.equipment_access' | 'fitness_profile.available_equipment',
       matchedKeywords }` for recognized vocabulary OR
    `{ value, source: 'fallback', reason: 'missing' | 'unrecognized', rawInput? }`
    otherwise. The `'unrecognized'` branch carries the raw input
    so the call-site logger emits an actionable signal when new
    vocabulary appears in production — operators can absorb it
    into `matchEquipmentKeywords` in a follow-up slice. The
    `'missing'` branch tags the case where both profiles literally
    have no equipment data (different operator action: prompt the
    user to fill it in).
  - Implementation refactored into pure helpers:
    `pickEquipmentString` trims and rejects empty/non-strings;
    `matchEquipmentKeywords` walks the vocabulary and returns both
    the EquipmentAccess shape AND the keyword list that produced
    it. Capability derivation matches the pre-slice-3.J behavior
    exactly so sample-athlete tests stay green.
  - The single existing call site in
    `buildAthleteStateFromTrainingProfiles` now consumes the rich
    form and emits a structured pino warning at warning level when
    fallback fires, with different message text for missing vs
    unrecognized so future alert routing can prioritize the
    latter.
  - 20 new unit tests in
    `__tests__/services/training-coach-kernel-equipment-access.test.ts`
    pin every recognition path including the killer "Crossfit
    box" / "Hotel gym" / "YMCA" / "University rec center"
    examples.
  Verification: `npx tsc --noEmit` clean, focused 53-test slice
  (20 new + 17 experience-level + 8 plan-generator + 8
  strength-engine) green, full backend regression `npm run verify`
  357 / 5,649 green, staging smoke 17/17, production deploy gate
  17/17, production health passed for content engine + portal + bot.
  Five remaining silent-default sites can each adopt the same
  shape (`resolveStrengthGoal`, `resolveThresholdPace`,
  `resolvePrimaryFocus`, `resolveTrainingHistory`, the
  `numericOrUndefined` chains).

- The preceding `4.14.93` shipped **coach-engine slice 3.I — explicit experience-level
  resolution provenance (Layer 1, audit follow-up)**:
  - The previous `resolveExperienceLevel` in
    `services/training-coach-kernel-plan-generator.ts` silently
    defaulted to `'novice'` when profile data was missing OR contained
    vocabulary the resolver didn't recognize. Three runtime cases
    collapsed to the same output: explicit "novice" / "beginner",
    unrecognized words like "expert" / "semi-pro", and truly missing
    data. Downstream slice 2.A's `BEGINNER_SAFE_SUBSTITUTIONS` fires
    on `experienceLevel === 'novice'`, so a fresh user with no
    profile data got the same exercise treatment as a confirmed
    novice — and operators had no visibility into which case fired.
  - Slice 3.I introduces the new exported
    `resolveExperienceLevelWithSource()` returning a discriminated
    union: `{ value, source: 'fitness_profile.experience_level' |
    'gym_profile.training_age', matchedKeyword }` for recognized
    vocab, or `{ value: 'novice', source: 'fallback' }` otherwise.
    The companion `resolveExperienceLevel()` keeps the original
    return shape for unchanged callers.
  - The single existing call site in
    `buildAthleteStateFromTrainingProfiles()` now consumes the rich
    form and emits a structured pino warning at warning level when
    fallback fires, carrying both raw inputs (fitness_profile and
    gym_profile fields) so operators distinguish missing data from
    new vocabulary the resolver should learn.
  - Vocabulary expanded to recognize `'novice'` / `'beginner'` /
    `'<1'` explicitly, so a profile that EXPLICITLY records novice is
    now distinguishable from missing data via the `source`
    discriminator. Planner output is unchanged — both still produce
    `experienceLevel: 'novice'`.
  - 17 new unit tests in
    `__tests__/services/training-coach-kernel-experience-level.test.ts`
    pin every recognition path (fitness vs gym preference, every
    vocab token, non-string-type rejection, whitespace handling,
    fallback subcases). Foundational pattern for subsequent Layer 1
    slices — gender / cycle physiology and the broader typed
    AthleteProfile contract will both build on this
    "explicit provenance + structured fallback log" shape; each
    silent-default site (`resolveStrengthGoal`, `resolveEquipmentAccess`,
    `resolveThresholdPace`, etc.) can adopt the same shape in its
    own slice.
  Verification: `npx tsc --noEmit` clean, focused 33-test slice
  (17 new + 8 plan-generator + 8 strength-engine) green, full
  backend regression `npm run verify` 356 / 5,629 green, staging
  smoke 17/17, production deploy gate 17/17, production health
  passed for content engine + portal + bot.

- The preceding `4.14.92` shipped **coach-engine slice 3.H — duration-aware strength
  target exercise count**:
  - Renamed the previously file-scoped `minimumExerciseCount` to
    `targetExerciseCount` and exported it from
    `services/coach-kernel/engines/strength-engine.ts`. The function
    acts as both the floor (filler top-up when a variant is short)
    and the cap (`prescriptions.slice(0, targetCount)` when the
    variant overflows).
  - Added two new low-end tiers without touching the existing 30+
    minute behavior: `duration < 25 → 2`, `25 ≤ duration < 30 → 3`.
    Before slice 3.H the function floored at 4 even for a 15-min
    "express" block, producing over-prescribed sessions athletes
    rushed (poor quality) or abandoned partway through (defeating
    the plan).
  - Existing tiers preserved: 30–39 → 4, 40–54 → 5, ≥55 advanced → 6,
    ≥55 others → 5. Every "unchanged" tier is regression-pinned by
    the new test class so a future change that accidentally shifts
    a 30+ minute case fails the boundary tests rather than quietly
    altering production plans.
  Verification: 23-test focused slice (8 existing + 15 new in
  `coach-kernel-strength-engine-target-exercise-count.test.ts`)
  green, full backend regression `npm run verify` 355 / 5,612 green,
  staging smoke 17/17, production deploy gate 17/17, production
  health passed for content engine + portal + bot.

- The preceding `4.14.91` shipped **coach-engine slice 2**:
  - **2.A beginner gym differentiation**: `coach-kernel/engines/strength-engine.ts`
    now applies a beginner-safe substitution layer when
    `experienceLevel === 'novice'`. Maps front_squat → goblet_squat,
    bench_press → dumbbell_bench_press, pull_up → lat_pulldown,
    romanian_deadlift → hip_hinge_band, single_leg_rdl → split_squat. Runs
    BEFORE the equipment-aware fallback so swapped exercises still
    adapt to dumbbell-only / no-gym setups. Substituted variants tagged
    `beginner_safe`. Intermediate + advanced lifters unchanged.
  - **2.B explicit two-a-day preference**: new exported
    `resolveMaxSessionsPerDay(preference, weeklyTargets)` and
    `twoADayPreference` field on `CoachKernelTrainingPlanInput` +
    `GenerateTrainingPlanForUserInput`. `'preferred'` → 2/day;
    `'never'` → 1/day; `'optional'` / null / undefined → legacy
    volume-based inference. `POST /api/v1/training/plan/generate`
    accepts the field with strict enum validation. iOS picker UI is the
    natural follow-up — the API is ready when iOS adopts it.
  Verification: backend `npx tsc --noEmit` clean, 11 focused training-
  domain test files / 101 cases green, full backend regression 354 /
  5,597 green, iOS `xcodebuild build` green, iOS
  `scripts/beta-smoke-local.sh` green.

- The preceding `4.14.90` shipped **coach-engine slice 1**:
  - new `services/coach-kernel/readiness-snapshot-adapter.ts` extracts the
    score → `ReadinessLevel` rule into a pure, public, unit-tested function
    shared between the planner and the new adaptation engine. Sleep-as-floor,
    no-wearable conservatism, and high-injury cap-at-orange are explicit.
  - `api/routes/training-schedule-utils.ts:scheduleSessionWindow()` was
    rewritten as a three-stage scheduler (friendly ±2.5h band → walk the
    day in 30-min steps → safe 06:30 marker). Returns
    `ScheduleSessionResult { start, end, preferredTimeUnavailable }`.
    Migration `080` adds `preferred_time_unavailable` to
    `training_sessions` and the read-model surfaces it on the iOS DTO so
    the Week Plan can render a ⚠️ chip when the planner had to compromise
    the time. The historical bug where the planner would land a session
    on top of an existing meeting is fixed.
  - new `services/coach-kernel/adaptation-engine.ts` exposes a pure
    `adaptSessionForReadiness(session, ctx) → AdaptedSession`. Red → swap
    intensity work to recovery_run/ride/swim/mobility (sport-aware) at
    60% cap; orange → 80% cap; high-severity injury affecting the sport
    → mobility swap at 50%; already-gentle sessions pass through. iOS
    today hero prepends a code-emitted (no-LLM) explanation when the
    adapter changed the session.
  Verification: backend `npx tsc --noEmit` clean, focused training-domain
  tests (10 files / 116 cases) green, full backend regression 353 / 5,588
  green, iOS `xcodebuild build` green, iOS `scripts/beta-smoke-local.sh`
  green (16-suite XCTest slice + simulator compile + doc-drift gate).
  The doc-drift regex inside `beta-smoke-local.sh` was updated to accept
  both legacy and current "Backend production [and staging] are live at"
  wording. Slice-1 dossier is at
  `/Users/felipedominguez/Desktop/Nexus Hub IOS/reports/coach-engine-slice-1-2026-04-27.md`.
- The preceding `4.14.89` Training intelligence + Apple Health/Home warmup
  closeout is still live underneath. It shipped: Training generation
  now respects weekly session/gym volume, supports
  distinct same-day run/gym slots, avoids scheduling new plans into the past,
  removes generated calendar/agenda events on plan cancellation, folds
  mobility/cooldown into workout descriptions instead of standalone mobility
  sessions, strips redundant week-planning prose from session descriptions, and
  enriches gym workouts by profile experience and time budget. Integration
  status now reports `apple_health` when recent HealthKit rows exist. iOS
  HealthKit connect is idempotent, stores per-user local Apple Health truth,
  auto-syncs on launch/connect, merges local HealthKit truth into
  Connections/Home/Training, and keeps Home from showing the warmup screen on
  every tab switch after initial bootstrap. Verification passed focused backend
  Apple Health/connections tests, full backend `npm run verify`, full iOS
  scheme tests, local beta smoke, simulator Home tab-switch smoke, staging
  smoke 17/17, and production health. iOS `main` is pushed at `f6b35bb`.
  Real Apple Watch/HealthKit ingestion still needs signed TestFlight validation
  on Jaqueline's physical device.
- The preceding `4.14.88` release is the Training
  stale calendar-link repair release. It verifies linked provider events before
  treating sessions as synced, repairs missing or mismatched Google Calendar
  events, exposes stale calendar links as missing in Week Plan read models, and
  filters app-facing Secretary calendar reads so generated Training events
  linked to another Nexus user or inactive/cancelled plan do not leak into the
  current user's agenda. Felipe's production gym plan was repaired with 24 real
  Google Calendar events; live checks show Week 1 has six owned calendar links,
  and simulator smoke showed Secretary Week Agenda plus Training Week Plan both
  rendering the current `Strength Session`/`Mobility + Recovery`/`Strength
  Support Session` schedule without the stale sync banner.
- The preceding `4.14.87` Secretary audit closeout release makes task
  completion idempotent, reconciles task
  creation after transient provider failures, uses per-user task due-date
  windows instead of a Lisbon default, cascades remote task-list deletion where
  supported, invalidates provider-derived task caches after OAuth reauth, uses
  monotonic SWR cache freshness, expands recurring tasks into operational
  reads, recognizes focus-time blocks, and normalizes Cooking shopping units
  before aggregation.
- The preceding `4.14.86` Secretary hardening release made calendar reads
  honest about degraded/unavailable providers, normalized
  all-day/cancelled/declined events, fixed configured-timezone and
  cross-midnight calendar windows, escalated repeated SWR refresh misses, and
  routed Todoist through the Todoist adapter instead of Microsoft To Do.
- The preceding Training plan-cancel hard-delete + rich session description
  release deployed migration `079_training_session_description.sql`.
- Hardened staging operator-session smoke passed valid, expired, tampered,
  unauthorized role/scope, wrong-tenant, and static-token rejection paths.
- External webhook/on-call staging drill passed alert creation, delivery,
  acknowledgement, resolution, and audit verification.
- Founder accounts verified in production:
  `felipedrf74@gmail.com` and `vieira.jaqueline@gmail.com`.
- Deploy scripts exclude worktree `.git` files and local agent/worktree
  artifacts so branch worktrees can deploy safely.
- Home-to-Inbox latency and task-list count truth were verified live on
  `4.14.66` and remain live through `4.14.74`; `/api/v1/tasks/lists` returns
  real `taskCount` values, not `-1` placeholders.
- Latest Content + Training TestFlight bugfix pass on 2026-04-25 is deployed
  in backend `4.14.74` and pushed in iOS `main`:
  `/api/v1/content/script` accepts `scriptStyle` (`detailed` or `bullets`),
  derives user-scoped Voice DNA from content knowledge, forwards it into the
  Python script engine, includes style in the script cache key, and returns
  `scriptStyle` in the API response. Python degraded fallback distinguishes
  YouTube vs short-form and detailed vs bullet outputs.
  iOS also fixed topic-list cache invalidation after topic writes, athlete
  profile finish actions from Training, and Training complete/skip fallback to
  the `"today"` sentinel.
- Follow-up Content scheduling/pipeline + Training readiness pass on
  2026-04-25 is deployed in backend `4.14.74` and pushed in iOS `main`:
  `POST/PATCH /api/v1/content/topics` now accepts
  `scheduledDateTime`; date-only topics create/update Secretary tasks;
  date+time topics also create/update calendar agenda/events through unified
  calendar; Content Tasks reads scheduled topics directly and surfaces
  task/calendar sync status; Pipeline Detail ignores benign superseded-load
  cancellation; Training keeps renderable Home/Training data visible during
  refresh; Home secondary previews fan out in parallel after the primary
  dashboard render. Migration `078_content_topic_secretary_artifacts.sql` is
  deployed with `4.14.74`; fresh signed TestFlight/device validation is still
  required before closing user-facing QA.
- Second Training TestFlight bugfix pass on 2026-04-25 is deployed in backend
  `4.14.74` and pushed in iOS `main` at `7f722da`: setup prompts are gated by
  real pending training questionnaires, started sport profiles count as usable
  objective context, skipped optional questionnaire steps persist safe
  placeholders, deterministic coach adjustment IDs are humanized, recovery/easy
  run sessions marked `rest` remain openable when they contain real session
  detail, new plan generation refreshes plan/calendar caches before showing the
  week, coach briefing has an active-plan deterministic fallback, and workout
  adjustment actions refresh instead of silently no-oping. Verification:
  focused backend Training tests passed 4 files / 63 tests, staging
  signed-session smoke passed 17/17, and iOS simulator build passed. The
  latest full production deploy gate passed 345 files / 5,468 tests during the
  `4.14.74` Training coach engine promotion. Signed TestFlight/device validation
  remains required.
- Content script AI delivery hotfixes on 2026-04-25 remain live in backend
  `4.14.74`. `4.14.71` fixed the TS AI bridge/json-mode degradation
  path. `4.14.73` carries the deeper script-quality architecture: the Python
  script writer no longer imports a global creator profile or a module-level
  system prompt, no longer hardcodes a founder/operator persona, and builds the
  script system prompt per request from the authenticated user's scoped creator
  profile/Voice DNA. The prompt now uses outcome-based creative guidance
  instead of literal hook/setup/body/CTA templates; `ask_claude` sets an
  explicit script temperature; degraded fallback drafts are topic-aware,
  deterministic-jittered, and free of founder hashtags or generic
  speed-vs-judgment hooks; and `/api/v1/content/script` supports
  `forceRefresh`/`regenerate` with a regeneration seed so "generate again"
  bypasses the cache. The script generation cache key is now `script-v7`.
  Production must keep returning `degraded=false` for normal script generation
  unless a real provider outage occurs.
- Training coach engine hardening on 2026-04-25 is deployed in backend
  `4.14.74`. It removes
  founder-specific Felipe/carnivore/high-volume defaults from the Training
  prompts, makes daily coach briefing generation iterate every active canonical
  tenant instead of owner-only users, fixes ACWR to use actual training-load
  values with a 14-day sample guard, changes no-wearable readiness from
  `full_intensity` to a conservative recommendation, combines sleep quality
  with duration as a safety floor, and makes orange/red/injury coach-kernel
  states downshift deterministically. Handoff:
  `docs/beta/training-coach-engine-hardening-handoff.md`. Verification passed:
  staging smoke = 17/17, production deploy gate = 345 files / 5,468 tests,
  and production health checks passed for content engine, status portal, and
  bot online.
- Remaining public-beta gates are iOS distribution gates: signed TestFlight,
  APNs token/delivery proof, fresh auth/onboarding, true two-account switching,
  real Gmail/Outlook/Health provider-state checks, and device proof for the
  latest Secretary, Health, Content script/topic scheduling/pipeline, and
  Training action/readiness fixes.

---

## Codex + Claude Operating Protocol

- Treat this file and `docs/agents/claude/handoff.md` as the backend
  cross-agent starting point. In the iOS workspace, read `AGENTS.md`,
  `CLAUDE.md`, `specs/00-CURRENT-PRODUCT-TRUTH.md`, and
  `specs/27-CLAUDE-CODE-HANDOVER.md`.
- Codex has been working by verifying QA reports with code/runtime evidence,
  implementing scoped fixes, running focused and broad tests, deploying through
  staging smoke before production, and updating docs before handoff. Claude
  should follow the same loop.
- Backend production changes should follow: focused tests/typecheck,
  staging deploy, staging smoke, production promote, production health, docs
  update. Do not skip the staging smoke gate.
- Token-zero remains law for iOS: ordinary operational flows use REST routes,
  not fake chat commands or prompt-driven lookups.
- Avoid single-tenant runtime assumptions in prompts, caches, background jobs,
  provider fallbacks, and user-facing copy. Hardcoded founder identity belongs
  only in docs, provenance notes, or explicit owner-only fixtures.
- If credentials, APNs, TestFlight, OAuth, HealthKit, Gmail/Outlook, or provider
  access are required, document the exact env/command and mark the item as
  manual verification required.

---

## Repository Layout

```
cortex-telegram-hub-bot/          # backend repo
├── src/
│   ├── agents/                   # 5 runtime content-creation agents
│   ├── api/                      # iOS REST API (/api/v1/*)
│   ├── bot.ts                    # Grammy Telegram bot composition root
│   ├── config.ts                 # All env-driven configuration
│   ├── domains/                  # secretary, triathlon, content, finance, cooking handlers
│   ├── handlers/                 # Telegram message + command dispatchers
│   ├── portal/                   # Express admin dashboard on :8200
│   ├── services/                 # ~80 service modules (DB, APIs, caching, routing)
│   ├── skills/                   # Skill catalog + user overrides + enable/disable
│   └── index.ts                  # Process entry point
├── migrations/                   # Numbered SQL migrations
├── __tests__/                    # Vitest tests mirroring src/
├── content-engine/               # Python FastAPI subprocess
├── prompts/                      # Hot-reloadable system prompts
└── scripts/                      # deploy.sh, rollback.sh, promote-to-prod.sh, ...
```

iOS app is a separate repo at `~/Desktop/Nexus Hub IOS/Nexus Hub/`.

---

## Tech Stack

- **Backend**: Node.js 20+, TypeScript (CommonJS), Grammy, Express, better-sqlite3, pino
- **AI**: `@google/generative-ai`, `@anthropic-ai/sdk`, `openai`
- **Content Engine**: Python 3.12, FastAPI, uvicorn
- **iOS**: Swift 5.9, SwiftUI, iOS 17+, `@Observable`, URLSession async/await, no third-party deps
- **Infra**: single Linux VPS, PM2, Cloudflare Tunnel, GitHub Actions CI
- **Observability**: pino JSON logs, SQLite `audit_trail` + `error_log`, Sentry (optional, Phase 0.F), distributed tracing via `reqId`

---

## Git Workflow

- **main** — production. Everything merges here directly via the validated promote pipeline.
- **feature/** or **fix/** — short-lived branches when doing risky work. Most changes can land on main directly.
- **develop** branch is NOT used. The workflow is single-branch + staging validation.

### Commit format
```
type(scope): description
```
Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `perf`. Scopes are free-form but usually match service names (`feat(garmin): ...`).

### Before committing
```bash
npx tsc --noEmit     # must pass
npx vitest run       # must pass
```
Pre-commit hook enforces both.

---

## Deploy Pipeline (validated promote)

```bash
# 1. Ship to staging (isolated install on :8201)
./scripts/deploy-staging.sh

# 2. Let staging soak (5 min minimum)

# 3. Run smoke tests
./scripts/staging-smoke.sh

# 4. Promote to prod (runs smoke test again as gate, then deploys)
./scripts/promote-to-prod.sh
```

Direct `./scripts/deploy.sh` exists for trivial hotfixes but the default is always promote-to-prod.

**Server**: `dominguez@serverdominguez` — local-network only (IPv6 via Cloudflare Tunnel). GitHub Actions cannot reach it; deploys run from Felipe's Mac.

**See**: `DEPLOY.md` (full runbook), `STAGING.md` (staging setup), `scripts/rollback.sh` (tested dry-run + apply path).

---

## Critical Rules

### Architecture

1. **Token-zero data reads.** Any operation that's a pure lookup (list tasks, get calendar, fetch readiness) MUST go through a REST route under `/api/v1/`, not through the chat pipeline. If you find yourself adding `chatViewModel.sendMessage()` for a data read, stop.
2. **Gemini-first, Anthropic-fallback.** `providerRouting` in `src/config.ts` controls this per-task-type. Don't hardcode `config.anthropic.model` in new code — use `getActiveProvider()` or `completeOneShotWithFallback()`.
3. **Token cache awareness.** `oauth-store.getTokens()` is cached for 10 min. Call `storeTokens()` or `disconnectProvider()` to invalidate. The audit_trail row is written once per cache-refill, not per call.
4. **Garmin auth safety.** `keepAlive()` must NEVER call `attemptReLogin()` — that triggers MFA emails. Full login is gated behind `serializedAuthRecovery` with a 15-min cooldown.

### Testing

- Tests live in `__tests__/` mirroring `src/` structure.
- External APIs are ALWAYS mocked. Tests that hit real network fail CI.
- SQLite tests use `:memory:`.
- Bug fixes include a failing-test-before-fix whenever reasonable.
- `_resetDecryptCacheForTests()` in `beforeEach` if the test uses `oauth-store` — the decrypted-token LRU is module-scoped.

### Forbidden

- ❌ Modifying `.env`, `data/`, `content-engine/.venv/`
- ❌ Adding real API calls in tests
- ❌ Committing secrets (pre-commit hook enforces via `detect-secrets`)
- ❌ Hardcoding absolute paths (`os.homedir()` or `config.*` instead)
- ❌ Direct `anthropic.messages.create` — route through `trackedCreate()` for cost logging
- ❌ `--amend` or `--no-verify` on commits without explicit user approval
- ❌ Re-adding the multi-agent orchestration scaffolding that was removed in Phase 0

---

## Key Files to Know

| File | Purpose |
|---|---|
| `src/config.ts` | All env vars, provider routing, feature flags |
| `src/services/provider-registry.ts` | TaskRoutingProvider init (primary/fallback per task type) |
| `src/services/gemini-provider.ts` | Gemini SDK wrapper + `completeOneShotWithFallback` |
| `src/services/anthropic.ts` | Anthropic SDK wrapper + tool dispatch (mostly fallback path now) |
| `src/services/oauth-store.ts` | Encrypted token storage + LRU cache |
| `src/services/garmin.ts` | Garmin Connect integration (MFA-aware, rate-limit-aware) |
| `src/services/unified-calendar.ts` | Google + Outlook calendar merge |
| `src/services/tool-executor.ts` | Cross-provider tool call execution |
| `src/services/scheduler.ts` | All cron jobs (28+) |
| `src/services/intelligence-bus.ts` | Cross-agent signal pub/sub |
| `src/skills/skill-config.ts` | Skill catalog + `SubSkillDefinition` with `dependencies` |
| `src/skills/skill-manager.ts` | Enable/disable with dependency enforcement + cascade |
| `src/api/routes/*.ts` | iOS REST endpoints (token-zero) |
| `src/portal/server.ts` | Admin dashboard + OAuth callbacks + Mission Control successor |
| `src/portal/portal.html` | Portal UI (SPA-ish, vanilla JS) |
| `src/utils/request-context.ts` | AsyncLocalStorage for distributed tracing reqId |
| `src/utils/logger.ts` | Pino logger with context mixin |
| `src/services/error-tracker.ts` | Sentry integration |
| `src/services/error-monitor.ts` | Local error capture → SQLite + Telegram + Sentry |

---

## Active Phase (April 2026)

**Beta release hardening is the active production context.** The backend beta
hardening work has been deployed to production as `4.14.74` from `main`; do not treat the
older Phase 0/Phase 1 notes as the current release state.

Current backend follow-ups:

- keep tenant/founder/business-rule docs aligned with the beta tracker;
- validate the latest Content scheduling, high-quality AI script generation, Training readiness,
  Secretary recurrence, and Health fixes in a signed TestFlight device build;
- device-validate the Training coach engine hardening pass;
- run another production-safe alert drill only if the final receiver differs
  from the staging receiver;
- keep deploy scripts worktree-safe;
- avoid broad architecture rewrites until the signed TestFlight/device gates
  are complete.

Current iOS-dependent release gates:

- signed TestFlight smoke;
- fresh Apple/Google/email auth and interrupted onboarding;
- APNs token upload and safe delivery;
- true two-account switching between Felipe and Jaqueline test accounts;
- real Gmail/Outlook/Health provider-state validation.

See `DEPLOY.md`, `STAGING.md`, `docs/OBSERVABILITY-ONCALL.md`, and
`docs/beta/single-agent-status.md` for operational context.
