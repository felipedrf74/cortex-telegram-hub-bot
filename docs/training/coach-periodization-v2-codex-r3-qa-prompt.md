# Codex R3 QA Prompt — Verify R2 Fixes + Hunt Round-Three Defects

## Posture

**Stay adversarial.** The implementer just closed 10 findings from your previous review (1 P0, 3 P1, 5 P2, 1 P3). Two things to do, in this order:

1. **Verify each R2 fix is real, not paper.** For each fix below, follow the same kind of attack you used to find the original bug. If you can punch a hole in the fix, file it. If the fix is genuine, say so.
2. **Then find new defects.** Round-3 surface area is bigger: a CoachAction executor (new), a hydration helper module (new), a JSON-aware preview-match query (new), nested schema validation (new), and a flag-gated route surface that now actually mutates DB rows.

Same severity scale (P0 / P1 / P2 / P3), same report format. End with verdict + punch list.

Worktree: `/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot/.claude/worktrees/cool-keller-56fedc`

## What R2 claims to have fixed

For each claim, verify the fix exists AND verify the test that pins it isn't dishonest.

| # | Severity | Claim | Files to verify | What to attack |
|---|---|---|---|---|
| R2-P0 | P0 | Cross-user plan access on v2 reflow/policy routes | `src/api/routes/training-coach-v2.ts` — `resolveOwnedPlan` / `resolveOwnedWeek` helpers added; every route except `/week/travel` (user-scoped already) calls them | (a) Can a request still bypass ownership via the body? (b) Does the helper's PLAN_NOT_FOUND-vs-403 split create a side-channel? (c) Does the body-planId-mismatch path correctly reject before any mutation? |
| R2-P1 | P1 | Reflow apply actually mutates sessions | `src/services/coach-kernel/coach-action-executor.ts` (new); `src/api/routes/training-coach-v2.ts` wires `applyMutation` via the executor inside the C6 transaction | (a) Can a malformed CoachAction (foreign sessionId, nonsense `toDate`) silently mutate? (b) Is the executor truly inside the same transaction as the ledger insert, or does nested `db.transaction()` break it? (c) Do `swap_exercise` / `insert_recovery_day` no-ops surface back to the caller, or vanish silently? (d) `move_session` derives `day_of_week` from `toDate.getUTCDay()` — TZ correctness when `toDate` falls on a UTC-vs-local boundary? |
| R2-P1 | P1 | Coach-analysis hydrates real inputs | `src/api/routes/training-coach-v2-hydration.ts` (new) with `dbRowToSession`, `resolveAthleteLevelFromPlan`, `resolveRaceCalendarFromPlan` | (a) Is `inferIntensityZone` defensible for ambiguous session_types ("recovery_run" is recovery, but "long_run" maps to aerobic — is that right)? (b) Does `resolveRaceCalendarFromPlan` validate enough to keep garbage out of B3's resolver? (c) The `athleteLevel.inferred` flag in the response — does iOS consume it? Is it surfaced ONLY in the analysis route, or also in reflow? |
| R2-P1 | P1 | A4 hard safety pause end-to-end | Same file: analysis + reflow routes call `getLatestHealthSignal` + `wireHealthSignalToSafety` and pass `safetyOutput` to `classifyTrainingScenario` | (a) The route hardcodes `source: 'wearable'` — but the v2.1 plan says ONLY `source: 'structured_intake'` produces hard pauses. So can ANY runtime path actually emit `pause_training`, or did the fix wire the import without enabling the contract? (b) `consent_scope.split(',')` — what if the stored value has whitespace, or is an empty string? |
| R2-P2 | P2 | CompletionFeedbackV2 reachable from REST | `src/api/routes/training.ts` `/complete` accepts `rir`, `painScore`, `painLocation`, `technicalSuccessScore`, `missedReason`, `externalTrainingDeclared`, completed sets/reps/load/duration/distance | (a) Does the route validate field types before forwarding? A string `"7"` for `rir` would silently fall through. (b) Are the new fields included in the `idempotencyKey` for the domain event emitted at line 561? If not, retries with different V2 fields would collide. (c) What about the chat-tool path (the legacy completion tool) — does it also forward V2 fields, or is iOS the only path? |
| R2-P2 | P2 | Idempotency conflict → 200 not 500 | `training-coach-v2.ts` reflow handler catches `AdaptationIdempotencyConflictError` and re-fetches; returns same shape as the winning request | (a) Does the re-fetched envelope carry `scenario.actions`? Probably not (the second request didn't recompute). Is that OK or misleading to the client? (b) The fallback `409 IDEMPOTENCY_CONFLICT` when re-fetch returns null — when does that fire? Is it reachable in practice? |
| R2-P2 | P2 | Science hash check fail-closed on missing pin | `scripts/ci/science-policy-version-check.mjs` requires `--bootstrap` to create the pin; otherwise fails | (a) Is `--bootstrap` documented anywhere outside the script header? (b) Does CI invocation include the bootstrap flag, or will the first CI run after deploying this change fail? Read `.github/workflows/*.yml` or scripts/cannot-skip-gate*.sh. |
| R2-P2 | P2 | Missed-session preview query uses json_each, not LIKE | `src/services/missed-session-sweep.ts` uses `json_extract` + `json_each` against `sessionsToPreserve` | (a) What if the preview row's `trigger_payload_json` is malformed JSON? Does `json_extract` swallow the error or surface it? (b) The `OR json_extract(...$.sessionId) = s.id` fallback — does that match strings vs integers correctly across SQLite type coercion? (c) Performance: `json_each` inside a subquery in a SELECT can be slow on large ledgers. Is there an index that helps? |
| R2-P2 | P2 | Deletion redaction buckets triggerType as `health_sensitive` | `src/services/training-plan-adaptations.ts:purgeSensitivePayloadsForUser` | (a) The original `trigger_type` COLUMN (not the JSON) still holds e.g. `pain_flag`. Support views querying `WHERE trigger_type = 'pain_flag'` still leak the category. Is the column itself sensitive? (b) What about `decision_reason_codes_json` — does it contain category-revealing strings? |
| R2-P3 | P3 | Knowledge-loader nested schema validation | `findMalformedPrinciplesSections` checks acwr / weekIntentDefaults / taperCoefficients / blockTemplates / returnFromGapRamps / riskScoreWeights / intensityDistributionModels / mesocycleLengths | (a) Are there OTHER sections (e.g., `missedSessionPolicyDefaults`, `minimumViableWeekTemplates`) the validator silently skips? (b) Does the live JSON actually pass — confirm by running the schema test in isolation. |

## Specific attack vectors for round 3

Independently of verifying R2, find new defects in:

### 1. The CoachAction executor

`src/services/coach-kernel/coach-action-executor.ts` is brand-new. Review every action handler:

- **`drop_session`**: UPDATE sets `status = 'skipped'`. What if the session was already `completed`? Should this be a no-op, or does it silently re-open the session?
- **`move_session`**: `toDate` → `UTCDay()` → day-of-week name. Cross-timezone drift: a user in `-08:00` planning a Saturday session via API gets it set to Friday if the date arrives as `2026-06-13T00:00:00-08:00` (= `2026-06-13T08:00 UTC` = still Saturday in UTC, but borderline cases break).
- **`scale_volume`**: `Math.max(1, Math.round(d * m))`. What if `m = 0`? Skip path → invalid_multiplier. What if `m = 0.000001`? Rounds to 1, mutates. Is "1 minute session" a defensible output?
- **`downgrade_intensity`**: writes `intensity_text = 'cap@<zone>'`. The existing schema has `intensity_text` as a free-form string ("RPE 7", "Zone 2"). Does any downstream consumer parse the `cap@` prefix? If not, the override is informational only.
- **`pause_training`**: sets `plan.status = 'paused'`. Does the rest of the codebase respect `paused` status? Grep for `status = 'active'` filters — if some skipper assumes only 'active' / 'completed', paused plans become invisible.

### 2. The hydration helpers

`src/api/routes/training-coach-v2-hydration.ts`:

- **`inferSportFromSessionType`**: lots of substring matching. `"mobility_run"` would match `run` AND `mobility` — verify the order produces the right sport.
- **`inferKeySession`**: `titleLc.includes('key')` — matches "monkey work", "biggie key crunches". Is title-based inference defensible?
- **`resolveRaceCalendarFromPlan`**: returns at most one race? It loops, but does it limit array size? A malicious `preferences_json` with 10000 race entries would slow B3.

### 3. The end-to-end reflow path

`training-coach-v2.ts` reflow handler does many DB reads + invokes the classifier + then `executeWeekReflow` which itself opens a transaction:

- Are the reads (sessionsRows, planMeta, weekRow, planFull, healthSignal) consistent? They span 5 separate prepared statements with no shared transaction. A concurrent edit could produce a stale snapshot.
- The reflow body now has `scenario` attached to the response even on preview. Does that leak more data than the iOS contract expects?

### 4. Cross-user side channels

Even with `resolveOwnedPlan` / `resolveOwnedWeek` in place, find indirect leaks:

- The `/coach-analysis` response includes `raceCalendar`. The race calendar comes from the plan's `preferences_json`. Is there ANY case where the response includes data from a foreign plan because the analysis aggregator reads beyond the owned plan? (e.g., the gap detector pulls health signals scoped by `userId` — verify it never crosses users when the request actor is impersonating).
- Idempotency keys: are they scoped by `plan_id`? If two users supply the same key for different plans, the system must NOT collapse them. Verify via the UNIQUE index column list.

### 5. Test honesty

Re-read each new test in this round:
- `coach-periodization-v2-codex-angry-qa-prompt.md` was the previous round's QA prompt; verify the implementer didn't paper-test by checking only the happy path of each R2 fix.
- The "mutated=false" assertion for accumulation week in the reflow tests — does that prove the executor ran? Or just that no action was emitted? Read the test carefully.
- The `Codex R2 P2 — substring collision avoided` test — does it actually exercise the json_each path, or does it rely on the legacy `sessionId` fallback?

### 6. Schema validation completeness (round 3 hunt)

`findMalformedPrinciplesSections` was added in R2. Find sections it forgot:

- `missedSessionPolicyDefaults` — has expected keys `easy_aerobic` / `strength_accessory` / `key_interval_tempo` / `long_run_ride` / `taper_session`. Validator doesn't check these. If a developer removes `taper_session`, B3's deload logic breaks silently.
- `minimumViableWeekTemplates` — has `endurance_athlete` / `strength_athlete` / `hybrid_athlete`. Validator doesn't check.
- `exerciseSelection.byPhase` — the original A1a JSON has phase-specific structures. Validator doesn't check.
- `fatigueModulation.{veryHighFatigueRules, highFatigueRules, interferenceRules}` — validator doesn't check.

Either flag the omissions as P2 (validation should cover all required sections) OR confirm that A1a-era consumers fail open on missing fields, making the validation gap a P3.

### 7. CompletionFeedbackV2 round-trip via REST

The `/complete` route was extended. Trace a full request:
- iOS sends `{ sessionId: 5, rir: 2, painScore: 6, painLocation: "knee" }`.
- Route reads body, passes to `logCompletion`.
- INSERT writes columns. 
- Verify the route TEST proves the round-trip. If not, the wire could be silently broken on field-name drift.

### 8. The flag gate

`v2EnabledOrShortCircuit` is called per-handler. Codex R1 said "verify every handler calls it." Re-verify now that 5+ handlers exist (4 routes + the analysis route + 1 new flag check in `/complete`? — wait, was `/complete` extended? It was, but it's NOT gated by the v2 flag. Verify the V2 fields work even with the flag off — is that intentional or a leak?).

Specifically: does the legacy `/complete` route accept V2 fields when `COACH_PERIODIZATION_V2_ENABLED=off`? If yes, V2 fields are being persisted without the flag being on, which violates the gating contract. If no, what's the gate?

## Files to read line-by-line

These are new or substantially changed in R2:

- `src/api/routes/training-coach-v2.ts` — ownership helpers + analysis + reflow rewrites
- `src/api/routes/training-coach-v2-hydration.ts` — brand new
- `src/services/coach-kernel/coach-action-executor.ts` — brand new
- `src/services/coach-kernel/knowledge-loader.ts` — nested validator added
- `src/services/missed-session-sweep.ts` — preview-match query rewritten
- `src/services/training-plan-adaptations.ts` — redaction bucketing
- `src/services/training-plans.ts` — V2 LogCompletionInput + INSERT + REST `/complete` route extension
- `scripts/ci/science-policy-version-check.mjs` — bootstrap mode

## What to ignore (still out of scope)

Same as round 2:
- iOS code (separate repo).
- Engine refactor across 6 engines (substrate-only deferral).
- Staging soak (operator-gated).
- Retention cron implementation.
- Algorithmic menstrual modulation.

## Report format

```
[Pn — file:line] [Title]
Finding: <code-cite + observation>
Why it matters: <consequence>
Suggested fix: <one-line action>
```

End with:
- **Verdict**: GO / NO-GO / GO-with-followups
- Punch list ordered P0 → P3
- **Honest R2 audit**: for each of the 10 R2 claims above, mark "verified" or "still broken (reason)".
- Counts: `Round-3 findings: P0=X, P1=X, P2=X, P3=X`. `R2 fixes verified: X/10. R2 fixes still broken: X/10.`

## Verification floor as of end of R2

- `npx tsc --noEmit` clean.
- 10,017 tests across 674 files (excluding 2 pre-existing flakes that pass in isolation: `chat-routes.test.ts > durably tracks action-planner confirmations` and `changed-area-classifier.test.ts > cannot-skip dashboard wiring`).
- `node scripts/ci/science-policy-version-check.mjs` OK.
- `npm run docs:audit` baseline (549 warnings — drifted +4 from R1 baseline; flag if this is climbing without reason).

## Final reminder

You found 10 real defects in R2 against an implementer who was confident. They claim 10/10 closed. Verify each, then look for new ones in the surface area added by the fixes themselves. **A fix is only real when it survives an honest adversarial replay.**
