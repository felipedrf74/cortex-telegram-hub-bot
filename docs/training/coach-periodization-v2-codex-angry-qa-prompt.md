# Codex Angry QA Prompt — Coach Periodization v2.1 Full-Scope Review

## Posture

**Be adversarial. Be skeptical. Be slow.**

You are NOT here to validate the implementation. You are here to break it. Assume the implementer was over-confident, took shortcuts, or papered over deferred work with cosmetic wiring. Your job is to surface every place the runtime contract drifts from the plan, every place the sports-science framing is sloppy, every concurrency race, every privacy hole, every typed contract that lies, every test that pretends to cover something it doesn't.

If something looks "fine" — read it twice, then probe edge cases. The previous Codex review caught 6 real bugs across 4 P1s and 2 P2s after the implementer had already shipped self-described "verified" work. The exact same posture is needed here.

## What is being reviewed

A 30-slice implementation of the Week-Level Adaptability + Periodization plan (v2.1), plus a follow-up round of 6 Codex-driven fixes (3 P1, 3 P2). The full plan is at:
`/Users/felipedominguez/.claude/plans/can-you-work-on-polymorphic-lamport.md`

Worktree:
`/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot/.claude/worktrees/cool-keller-56fedc`

The implementer claims:
- 30/30 slices shipped (Phase A 11, Phase B 11, Phase C 8).
- 6/6 Codex findings closed.
- 674 test files / 9,994 tests passing.
- `npx tsc --noEmit` clean.
- `node scripts/ci/science-policy-version-check.mjs` OK.

**Verify every claim. Do not trust the implementer's summary.** The summary describes intent, not outcome.

## What was reportedly delivered

### Phase A — 11 slices

| Slice | File(s) | Claim |
|---|---|---|
| A0 | `migrations/155_plan_adaptation_revision.sql`, `src/services/training-plan-lifecycle.ts` (extended) | `adaptation_revision INTEGER NOT NULL DEFAULT 0` on `fitness_training_plans` + `incrementAdaptationRevision()`/`getAdaptationRevision()`; two-counter independence from `plan_version`. |
| A0b | `migrations/156_training_plan_adaptations.sql`, `src/services/training-plan-adaptations.ts` | Adaptation ledger with `UNIQUE(plan_id, adaptation_revision)` partial index, `UNIQUE(plan_id, idempotency_key)` partial index, append-only `rollbackAdaptation()` with latest-only optimistic lock + `rollback_of_adaptation_id` self-ref, role-based redaction via `ViewerRole`. |
| A0c | `migrations/157_completion_feedback_v2.sql`, `migrations/158_athlete_readiness_and_health_events.sql`, `src/services/readiness-events.ts`, `src/services/health-signals.ts`, `src/services/training-plans.ts` (extended) | `training_completions` extended with 10 new columns; new `athlete_readiness_events` + `athlete_health_signals` tables with per-signal consent_scope; `recordReadinessEvent`/`recordHealthSignal` enforce consent gating; `logCompletion` writes the V2 columns. |
| A1a | `src/services/coach-kernel/training-principles.ts` (new), engines | Typed accessor over `training-principles.json`; `applyVolumeGrowthCapForSport()` wired into running-engine (primary + support paths) and cycling-engine (primary). |
| A1b | `src/services/coach-kernel/knowledge/entities/training-principles.json` (extended), `scripts/ci/science-policy-version-check.mjs`, schema validation in `knowledge-loader.ts` | Periodization-policy JSON sections added; `sciencePolicyVersion` + content-hash CI gate + runtime required-keys schema validation. |
| A2 | `src/services/coach-kernel/zone-calculator.ts` | Coggan %FTP, Daniels VDOT, %CSS, %LTHR/%HRmax → per-sport `ZoneSet`. |
| A2b | `src/services/coach-kernel/intensity-profile.ts`, types extended | `IntensitySegment`, `SessionIntensityProfile`, `IntensitySummary`; default segment heuristics; TSS via Coggan formula. |
| A3 | `src/services/coach-kernel/plan-generation-context.ts`, types extended | `PlanGenerationContext`, `commitWeek(delta)` immutable, `HealthSignal`/`VersionStamp`/`WeekConditions`. **Existing generator `training-coach-kernel-plan-generator.ts:177-209` overwrite NOT yet refactored** — substrate-only. |
| A4 | `src/services/coach-kernel/safety-wiring.ts`, `safety-guardrails.ts` extended | HealthSignal → SafetyEvaluationInput mapping with consent re-check; typed structured intake → hard pause; inferred → warning. `seek_professional_support` user-facing copy; internal code `medical_referral`. |
| A4p | `src/services/health-consent.ts` | `deleteAllHealthDataForUser()` cascade — **claimed transactional** with redact-ledger-first ordering. |
| A5 | `migrations/159_coach_plan_policy.sql`, `src/services/coach-plan-policy.ts` | `coach_plan_policy_json` column; `getCoachPlanPolicy`/`setCoachPlanPolicy` with enum validation; uses `data_informed` not `data_driven`. |

### Phase B — 11 slices

| Slice | File(s) | Claim |
|---|---|---|
| B0 | `src/services/coach-kernel/load-input.ts` | `SessionLoadEstimate` with four parallel dimensions; sRPE × duration universal fallback; never collapses. |
| B1 | `src/services/coach-kernel/load-model.ts` | EWMA CTL/ATL/TSB; uncoupled ACWR; `LoadModelStatus` cold-start/warming/stable. |
| B2 | `src/services/coach-kernel/week-intent.ts`, types extended | WeekIntent discriminated type + `resolveWeekIntent` + `blockPhaseFromWeekIntent` legacy bridge. **6 engines still read `BlockPhase` — engine refactor intentionally deferred.** |
| B2a | `src/services/race-calendar.ts`, types extended | `RaceEvent` extended with multisport `disciplines[]` + `raceFormat`; window/recovery helpers. |
| B3 | `src/services/coach-kernel/mesocycle.ts` | `resolveMesocyclePlan` composes B2 into a race-aware WeekIntent[]. |
| B4 | `src/services/coach-kernel/intensity-distribution.ts` | `pickIntensityDistribution` (race=95/0/5, deload=90/10/0, post_race=100/0/0); `measureWeeklyDistribution`; `assessDistributionDelta`. |
| B4b | `migrations/160_athlete_session_preferences.sql`, `src/services/symptom-aware-preference.ts` | Symptom-aware capture only; no phase prediction. |
| B5 | `src/services/coach-kernel/deload-recommendation.ts` | Cold-start gates ACWR; HRV pairing rule; composite risk score; primary signal selection. |
| B6 | `src/services/coach-kernel/strength-progression.ts` | 9-gate `decideStrengthProgression`; four progression vectors. |
| B7 | `src/services/coach-kernel/taper.ts` | `decideTaper` with quadratic volume curve, priority-scaled window + strength cutoff; `shouldDropMissedTaperSession`. |
| B8 | (composition only) | Race-aware taper + post-race recovery via B2a + B2 + B3 + B7. **No standalone module.** |

### Phase C — 8 slices

| Slice | File(s) | Claim |
|---|---|---|
| C1 | `src/services/missed-session-sweep.ts` | Timezone + grace + external-training-declared exclusion. |
| C2 | `migrations/161_travel_windows_and_equipment_overrides.sql`, `src/services/travel-windows.ts` | `recordTravelWindow` + `computeTravelStressScore`. |
| C3 | (migration 161 column) + `src/services/week-equipment-override.ts` | Per-week equipment JSON override. |
| C4 | `src/services/gap-detector.ts` | `ReturnProtocol` classification from concurrent A0c signals + declared override. |
| C5 | `src/services/adherence-trend.ts` | Rolling 2-week adherence + `trendLow` boolean. |
| C6 | `src/services/training-week-reflow.ts` | `executeWeekReflow` with `mode: 'preview' \| 'apply'`. **Codex P1 fixes**: required `idempotencyKey` for apply, `applyMutation` callback, transactional ledger+mutation, `mutated:true` only when callback reported ≥1 row. |
| C7 | `src/services/coach-kernel/week-conditions.ts` | `aggregateWeekConditions` composes C1/C2/C4/C5/A4 + lifecycle state. **Codex P2 fix**: surfaces `missedSessionIds[]` for C8. |
| C8 | `src/services/coach-kernel/scenario-classifier.ts` | `classifyTrainingScenario` with typed `CoachAction[]` grammar. **Codex P2 fix**: iterates only specific missed-session IDs, not every session in the week. |

### Codex-driven follow-up fixes (6)

| # | Severity | Original Codex finding | Reported fix |
|---|---|---|---|
| 1 | P1 | v2 modules not wired to runtime; no production callers | Added `COACH_PERIODIZATION_V2_ENABLED` flag in `src/config.ts:coaching.periodizationV2Enabled`; mounted 5 routes via `src/api/routes/training-coach-v2.ts` (POST `/week/travel`, POST `/week/:weekId/reflow`, GET/PATCH `/plans/:planId/coach-policy`, GET `/plans/:planId/coach-analysis`); analysis endpoint is the production caller for mesocycle/deload/taper/intensity-profile/scenario-classifier. |
| 2 | P1 | `logCompletion` doesn't write V2 columns | Extended `LogCompletionInput` + INSERT in `src/services/training-plans.ts`. |
| 3 | P1 | C6 reflow reports `mutated:true` without mutating sessions; idempotency optional | Refactored `executeWeekReflow` to require `idempotencyKey` for apply (throws `ReflowMissingIdempotencyKeyError`), accept `applyMutation` callback, run mutation inside the ledger transaction, only set `mutated:true` when callback reported ≥1 row. |
| 4 | P2 | C8 missed-session policy acts on ALL sessions when only count is known | Added `WeekConditions.missedSessionIds[]`; classifier iterates only those IDs. |
| 5 | P2 | Health delete cascade non-transactional; can orphan sensitive ledger payloads | Wrapped `deleteAllHealthDataForUser()` in `db.transaction()`; redacts ledger FIRST. |
| 6 | P2 | A1b hash gate doesn't catch missing required keys | Added `findMissingPrinciplesKeys()` + `TrainingPrinciplesSchemaError` to `knowledge-loader.ts`; load throws on missing key. |

## Where to attack hardest

For each area below, find at least one concrete defect (file:line) or explicitly state you couldn't. Don't accept silence as a pass.

### 1. The flag gate is a paper tiger?

`v2EnabledOrShortCircuit` is called from every handler in `src/api/routes/training-coach-v2.ts`. The previous implementation used router middleware that broke legacy routes; the fix moved the check into each handler.

- Verify EVERY v2 handler calls `v2EnabledOrShortCircuit` as its first line. Look for a handler that was added but missed the gate.
- Try mounting the router in a way the implementer didn't anticipate: what if a future route registers BEFORE `mountCoachV2Routes`? Does the gate still hold?
- Is there a TOCTOU concern with `config.coaching.periodizationV2Enabled` being read each request? What if the flag flips mid-flight (it shouldn't, but the read is unsynchronized).

### 2. C6 reflow transactional integrity

The fix claims `applyMutation` runs inside the same transaction as the revision bump + ledger insert. Verify by code path:
- `executeWeekReflow` does `db.transaction(() => { applyMutation; recordAdaptation; })`. But `recordAdaptation` internally calls `db.transaction(...)` again. better-sqlite3 supports nested transactions as savepoints — confirm this is correct, not buggy. Read better-sqlite3 docs and reason about whether a throw inside the inner txn actually rolls back the outer one (specifically when the outer is the synchronous `applyTxn`).
- The test `applyMutation throw rolls back BOTH ledger row + revision bump` claims to prove this. Does it actually? Re-read it line-by-line.
- What happens if `applyMutation` does `db.transaction(() => {...})()` itself? Triple-nested. Is that safe?
- `idempotencyKey` pre-check happens OUTSIDE the transaction. A race window exists between pre-check and the transactional insert. The DB-level UNIQUE backstops, but the error type thrown is `AdaptationIdempotencyConflictError`. How does the route handler in `training-coach-v2.ts` treat that error? Look for the catch — is the user shown the same response as the idempotency-hit success?

### 3. Phase A `PlanGenerationContext` is decorative

A3 ships substrate but the implementer ADMITS the planner `training-coach-kernel-plan-generator.ts:177-209` overwrite is NOT refactored. So `PlanGenerationContext.weekConditions[]` is never populated by the existing planner.

- Find: does ANY production code other than the test files actually `commitWeek()` into a `PlanGenerationContext`? If no, then A3 isn't substrate, it's vapor.
- The new `/coach-analysis` route calls `aggregateWeekConditions()` but does NOT thread context through. So even the new endpoint produces a one-shot analysis, not a replayable context. Is this a P1 deferral or a P2 architectural drift?

### 4. The engine refactor "deferred to follow-up" is suspect

B2 ships `WeekIntent` + `resolveWeekIntent` + `blockPhaseFromWeekIntent`. The plan says ~18 engine read-sites need to convert. The implementer says they didn't, and that engines still read `BlockPhase`. Verify:
- `grep` for `BlockPhase` in engines. Count the read sites.
- For each, verify the engine's runtime path produces the SAME behavior with or without WeekIntent. If not, there's a silent contract drift.
- Does the `/coach-analysis` endpoint emit WeekIntent values that contradict what the planner would have used? If yes, the analysis is misleading.

### 5. Strength progression gates leak

`src/services/coach-kernel/strength-progression.ts:decideStrengthProgression` checks gates and falls through to the progression vector. Verify:
- The order of substring matches for `target.includes('volume_then_load')` was reportedly fixed in the implementer's iteration. Check it didn't get reverted.
- What happens when `progressionTarget` is `null`? `undefined`? Empty string? An object?
- The novelty gate uses `priorExposureCount < 2`. What units? Sessions of this exact exercise? Pattern? Family? Does any production caller actually populate this field correctly?

### 6. B1 EWMA arithmetic + cold-start gate

`load-model.ts:computeLoadModelForDimension`:
- The EWMA alpha is `1 - exp(-1/timeConstantDays)`. For CTL=42: alpha ≈ 0.0235. For ATL=7: alpha ≈ 0.1331. Verify these against Coggan's published implementation.
- The uncoupled ACWR slice: `acuteStart = max(0, daily.length - acuteDays)` then `chronicEnd = acuteStart; chronicStart = max(0, chronicEnd - (chronicDays - acuteDays))`. Does this exclude exactly the acute window from the chronic mean, or does an off-by-one creep in?
- The test `coupled ACWR ≈ 1.0 when load is constant` uses 300 days. Is that enough for ATL/CTL to truly converge, or did the implementer fudge the assertion bounds to make the test pass?
- Cold-start at `<14 days` boundary: `completionCount < COLD_START_MAX_DAYS`. Off-by-one? Verify the test pins both sides of the boundary.

### 7. B0 multi-dimensional load

`load-input.ts:estimateSessionLoad`:
- For cycling without power, falls through to sRPE. For running without anchors, falls through to sRPE. For swim — does the code path even reach `completedExternalLoad`? Verify swim with distance + duration + CSS produces a valid TSS.
- The impact-load formula: `distance_km × 1.3 × mass_factor × 10`. Where does the `1.3` come from? Is this defensible vs published step-count proxies, or did the implementer make it up?
- `pickPreferredLoadScore` has preference `external > internal > planned > strength > impact`. What about a strength session with `completedInternalLoad` (sRPE) AND `strengthLoad` (tonnage)? Per preference order, internal wins — but a coach probably wants tonnage. Is this a contract bug?

### 8. C8 scenario classifier — composition order vs precedence

The classifier walks ladder positions 1-9. Verify by tracing every modifier:
- Safety pause early-returns with the safety action only. What if the same week has BOTH safety pause AND a missed session? The missed session is silently dropped. Is that the intended precedence, or a bug?
- Rate-limit check returns `no_scenario` for non-safety. What if the user has been hit with two non-safety reflows + ALSO has a safety condition? Verify safety still wins.
- Race week drops "non-key strength" sessions. What if EVERY strength session in the week is marked `keySession: true`? Then nothing is dropped, even on race week. Is that intended?
- Travel-week downgrade ceiling is `tempo`. What about endurance/aerobic sessions during travel? They get NO action. Is that intended?
- The `nextAvailableDate(s.dayOfWeek)` for `move_session` returns `now + 2 days` — a placeholder. This is hardcoded. Is that good enough or a P2?

### 9. C1 missed-session detection

`missed-session-sweep.ts:detectMissedSessions`:
- The SQL `LIKE '%"sessionId":' || s.id || '%'` for the preview-check is a SUBSTRING match against `trigger_payload_json`. What if `sessionId` is `12` and there's another row with `sessionId: 123`? Both match. SQL injection? Not really, but the matching is wrong.
- Severity classification: `/^threshold_|^interval_|^vo2_|^long_/.test(sessionType) || /key|threshold|interval|vo2|long/i.test(title)`. The title regex matches `"long mobility walk"`. Is that intended?
- `deadlinePassed` uses `Date.parse(scheduledDate + 'T23:59:59Z')`. Then subtracts `timezoneOffsetHours * 3600 * 1000`. For an athlete in `+8h` (Beijing), the deadline is computed at `23:59:59 UTC - 8h = 15:59:59 UTC` = `23:59:59 Beijing`. That's correct. But what about DST transitions? The fixed offset model ignores DST entirely.

### 10. Privacy / A4p

`health-consent.ts:deleteAllHealthDataForUser`:
- Test claims transactional rollback works. Read the test again: it drops `athlete_health_signals` BEFORE calling the delete. Does that actually exercise the transaction path, or does the helper module's `getDb()` cache the table reference and skip the table?
- The redaction marker JSON: `{ "redacted": true, "reason": "user_deletion", "triggerType": "..." }`. Is the original `triggerType` itself sensitive? Pain type is "pain_flag" — fine. But what about `red_s_screening_flag`? Knowing the user HAD a RED-S screening flag is itself a sensitive disclosure to support.
- Per-scope retention defaults are declared in `DEFAULT_RETENTION_DAYS`. Is there a cron job that actually enforces retention? Or is this dead config? (Per the implementer's docs: it's dead config — deferred. Surface this as a P2 if the retention defaults exist without enforcement.)

### 11. A0c consent re-check

`recordHealthSignal` strips fields without the right consent. But what if a developer adds a new sensitive field (e.g., genetic_marker) and forgets to add it to `FIELD_CONSENT_MAP`? The field gets persisted with NO consent check. Verify the structure forces an explicit map entry on every new field.

### 12. CI hash check is fragile?

`scripts/ci/science-policy-version-check.mjs`:
- The `canonicalize` function recursively sorts keys. Does it handle arrays correctly? Arrays are NOT sorted (order matters semantically). But what about an object inside an array? Verify nested object sort happens.
- What if `training-principles.json` has a comment-style key with leading whitespace? JSON doesn't have comments, but the implementer might have left one. Verify the JSON parses cleanly.
- The "first-run bootstrap" branch silently writes the hash without requiring a version bump. Could a malicious actor delete the `.science-policy-hash` file and re-run to "launder" a JSON change? Verify this is a known + accepted threat model, or surface as a finding.

### 13. Migration ordering + safety

Run `ls migrations/` and verify the new files (155-161) are in correct numeric order with no gaps. Check each:
- 155 — `ALTER TABLE` ADD COLUMN. SQLite's ALTER does not support adding a NOT NULL column without a default. The migration uses `DEFAULT 0`. Safe.
- 156 — Creates table + 4 indexes. Are the indexes actually optimal for the queries in `training-plan-adaptations.ts`? Check `getAdaptationsForPlan` query — does it use the `idx_training_plan_adaptations_plan_created` index?
- 157 — Adds 10 columns to `training_completions`. SQLite has a 2000-column limit per table; running migrations on already-large tables can be slow. What's the existing column count after 023?
- 158 — Creates 2 tables + 4 partial indexes. Verify the WHERE clauses on partial indexes are correct syntax for SQLite's version.
- 159 — `coach_plan_policy_json TEXT` column. Nullable. Safe.
- 160 — Creates `athlete_session_preferences`. No retention policy index.
- 161 — Creates `travel_windows` AND adds `equipment_override_json` to `training_weeks` in ONE migration. If the ADD COLUMN fails, the CREATE TABLE has already committed. Migration not atomic — is this OK per the project's migration runner?

### 14. Type system holes

`coach-kernel/types.ts` is heavily extended. Find:
- Optional fields that are never populated. E.g., `Session.intensityProfile?` and `intensitySummary?` — does ANY production code path actually set these?
- Discriminated unions where a `default` case in a switch returns the wrong type.
- Casts using `as Record<string, number>` or `as unknown as ...`. The `deload-recommendation.ts` uses one. Verify it doesn't paper over a bug.
- The `WeekIntent.kind` enum vs the `WeekIntentKindEnum` type alias. Duplication? Drift risk?

### 15. Test coverage that lies

For each test file added in this work, ask: does it test the contract, or just the happy path?
- `__tests__/services/coach-kernel-scenario-classifier.test.ts` — claims to test all 9 ladder positions. Verify each modifier has a dedicated test case AND a composition test.
- `__tests__/api/training-coach-v2-routes.test.ts` — uses a mocked config flag. Verify it tests the case where config is partially populated (missing `coaching` key).
- `__tests__/services/training-week-reflow.test.ts` — the "applyMutation throw rolls back BOTH ledger row + revision bump" test. Re-read: is the rollback actually verified, or just inferred from absence?
- `__tests__/services/health-consent.test.ts` — the "Codex P2 fix — transactional rollback" test drops the table to trigger a throw. Does it ALSO verify the readiness events are preserved? Read line-by-line.
- `__tests__/services/coach-kernel-load-model.test.ts` — the implementer relaxed assertions when initial tests failed. Verify the relaxed bounds are still scientifically defensible.

### 16. iOS contract drift

The plan said: schema versioning per expanded read-model. The implementer didn't ship `?schemaVersion=N` routing. So:
- The new `/coach-analysis` endpoint returns rich nested objects. What happens when an iOS client with an old contract calls it? Verify the response has versioning fields.
- `CoachPlanPolicy` PATCH accepts arbitrary partial JSON. Does it validate against the schema or just type-check? What if a future v2.5 adds a required field to the policy — is there migration logic?

### 17. Sports-science correctness

Reality-check the constants and formulas against published sources:
- Coggan TSS = `duration_hours × IF² × 100`. Verify in `intensity-profile.ts:computeEstimatedLoad`.
- Daniels VDOT T-pace zone bounds in `zone-calculator.ts`. Cross-check against Daniels' Running Formula 4e tables.
- Bosquet 2007 taper meta: 41-60% volume drop. The implementer uses 55%/45%/35% for A/B/C in `taperCoefficients`. B and C are BELOW the meta-analysis range. Is this defensible for shorter races or is it pulling numbers out of thin air?
- Mesocycle 3:1 / 4:1 / 2:1 ratios per Bompa/Issurin. The implementer uses 4-week intermediate, 3-week advanced, 5-week novice. The novice "5-week" deviates from common practice (most novice programming uses 3:1). Justify or flag.
- HRV pairing rule per Plews & Buchheit: HRV alone insufficient. Verify the `pairingPartners` list in `deload-recommendation.ts` matches the published recommendations.

### 18. Concurrency / race conditions

The system has multiple paths that mutate shared state. For each, find races:
- Two concurrent `executeWeekReflow({mode: 'apply'})` calls with the SAME idempotency key. The pre-check + transactional insert race. The DB UNIQUE backstops — but the second call's reaction (`AdaptationIdempotencyConflictError`) — does the route handler translate it cleanly to the client?
- Two concurrent `recordAdaptation` calls without idempotency keys. The first bumps revision N→N+1, the second bumps N+1→N+2. Both ledger rows have different revisions. Safe.
- A `deleteAllHealthDataForUser` racing with `recordHealthSignal`. The transaction wraps the delete. What if a `recordHealthSignal` is in-flight when the delete starts? SQLite locking semantics — verify no lost writes.
- The `loadCoachKnowledge()` cache is module-scoped + lazy. What if two requests both miss the cache and call `loadCoachKnowledge` concurrently? Will the schema-validation throw fire twice? Is the failure recoverable?

### 19. Error path noise

- `executeWeekReflow` throws `ReflowMissingIdempotencyKeyError` for missing key. Route handler maps to 400. Good. But does the error response include the original message verbatim? Could it leak internal details?
- `recordAdaptation` throws `AdaptationPlanNotFoundError`. Route handler maps to 404. Verify the error message doesn't include the user's plan_id in a way that enables enumeration attacks.
- `setCoachPlanPolicy` throws on invalid enum. Verify the error message lists the invalid value but NOT the full allowed list (which would help fuzzers).

### 20. Logging / observability gaps

- New service modules log via `logger.info`. What gets indexed in production? Does any of the new logging include PII (user health signals)?
- Are the staging analytics from the plan (`plan_churn_rate`, `adaptation_acceptance_rate`, `safety_escalation_rate`, `coach_explanation_helpfulness`) actually computed anywhere? Or is this in the analytics-needed-but-deferred bucket?

## Specific files to read line-by-line

These files have the highest risk surface. Read each in full:

- `src/services/training-week-reflow.ts` — Codex P1 fix; transactional contract.
- `src/services/training-plan-adaptations.ts` — A0b ledger primitives.
- `src/services/coach-kernel/scenario-classifier.ts` — C8 + Codex P2 missed-session fix.
- `src/services/health-consent.ts` — A4p + Codex P2 transactional fix.
- `src/services/coach-kernel/knowledge-loader.ts` — A1b schema validation (Codex P2).
- `src/api/routes/training-coach-v2.ts` — every route handler; flag gate per handler.
- `src/services/coach-kernel/training-principles.ts` — typed accessors over the JSON.
- `src/services/coach-kernel/load-model.ts` — EWMA arithmetic.
- `src/services/coach-kernel/deload-recommendation.ts` — composite signal logic.
- `src/services/coach-kernel/taper.ts` — quadratic curve math.

## What's intentionally deferred (do NOT flag these as findings)

The implementer explicitly deferred these and documented the deferral:
1. Phase B engine refactor — ~18 read-sites across 6 engines still read legacy `BlockPhase`. The `WeekIntent` substrate is in place; runtime adoption follows in a separate slice once `COACH_PERIODIZATION_V2_ENABLED` flag is staged.
2. `PlanGenerationContext` plumbing into the existing planner. A3 is substrate-only.
3. iOS `?schemaVersion=N` query-param routing. Backend accepts the new fields; iOS adoption is consuming-side work.
4. Adaptation ledger retention cron. Defaults documented in `DEFAULT_RETENTION_DAYS`; cron implementation is an operator slice.
5. Staging soak (≥2 weeks with flag on) before production promote.
6. Algorithmic menstrual-cycle modulation. B4b ships capture + preference only.

For each of these, you may FLAG IT IF the implementer's claim about deferral is false (i.e., the work IS done but partially / silently in a way the implementer didn't disclose). But don't flag the deferral itself.

## What to ignore (out of scope)

- iOS code changes (separate repo).
- The 8 prior commits not yet pushed (PR1-Layer10 work from earlier turns).
- Production deploy + staging soak validation (operator-gated).
- Telegram pipeline (deprecated per project memory).

## Report format

For each finding, write:

```
[Pn — file:line] [Title]
Finding: <what is wrong, with code-cite>
Why it matters: <consequence>
Suggested fix: <one-line action item>
```

Severity:
- **P0** — production-breaking. Data loss, security hole, exposed PII, panic loop.
- **P1** — staging-blocking. Wrong contract, missing wiring, transactional integrity broken, sports-science wrong in a way that misleads athletes.
- **P2** — promote-blocking. Test coverage gap, edge case unhandled, observability hole, scope drift from plan.
- **P3** — nice-to-have. Doc drift, naming inconsistency, defensive guard that could be tighter.

End your report with:
- **Verdict**: GO / NO-GO / GO-with-followups
- A punch list ordered P0 → P1 → P2 → P3
- A count: `Total findings: P0=X, P1=X, P2=X, P3=X`
- Honest assessment: **does the implementation actually meet the plan v2.1's "all 30 slices shipped" runtime contract**, OR is some portion still substrate-only despite the wiring claim?

## Final reminder

The previous Codex reviewer caught 4 P1s and 2 P2s on what the implementer claimed was complete-and-tested work. Match or exceed that bar. If you only find P3 nits, you didn't look hard enough — go back and re-read with adversarial intent.

Anti-patterns to specifically hunt:
- Wires that exist but are never called from production paths.
- Tests that prove a positive case but skip the negative.
- "Validation" that's actually just a type cast.
- Transactional claims that aren't actually transactional.
- Sports-science constants pulled from intuition rather than cited literature.
- iOS contracts that drift from server contracts because the implementer assumed iOS would catch up.
- Defensive guards that fail open when they should fail closed.
- Privacy primitives that silently leak via a side channel (e.g., row existence even when payload is redacted).

Go.
