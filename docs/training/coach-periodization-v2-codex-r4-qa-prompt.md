# Codex R4 Angry QA Prompt — Audit Every Round, Then Find New Defects

## Posture

**This is the fourth review of the same body of work.** Rounds 1–3 each turned up real defects the implementer was certain didn't exist:

- **R1**: 6 fixes after initial "complete" claim (3 P1, 3 P2)
- **R2**: 10 fixes (1 P0, 3 P1, 5 P2, 1 P3) after the previous round's "all green" claim
- **R3**: 11 fixes (3 P1, 7 P2, 1 P3) after R2's "all R2 closed" claim, with Codex flagging that 6 of 10 R2 fixes were still actually broken

You are review #4. The implementer just closed all 11 R3 findings and claims "all rounds verified." History strongly suggests at least 2–3 of those R3 fixes are still broken or introduced new adjacent bugs.

**Be adversarial. Trust no claim. Verify by code-cite or report "I could not punch a hole here."** If you only find P3 nits, you didn't look hard enough — the bar for R4 is "match or exceed R3's 11 findings."

Worktree: `/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot/.claude/worktrees/cool-keller-56fedc`

## Cumulative scope

You are auditing **the entire body of work** across four rounds:

1. The original 30-slice implementation (Phase A: 11 slices, Phase B: 11 slices, Phase C: 8 slices) of the Week-Level Adaptability + Periodization plan v2.1 (`/Users/felipedominguez/.claude/plans/can-you-work-on-polymorphic-lamport.md`).
2. R1: 6 follow-up fixes (1 PR for completion-feedback wiring, idempotency, etc.).
3. R2: 10 follow-up fixes (cross-user access, reflow apply, coach-analysis hydration, A4, completion v2, idempotency, science hash, missed-session preview, deletion redaction, nested schema).
4. R3: 11 follow-up fixes — the most recent, and the most likely to be subtly broken:
   - **R3 P1 #1**: A4 hard-pause now derived via `deriveSafetyTriggerFromSignal` + new `POST /health-intake/red-flag` endpoint
   - **R3 P1 #2**: Completed sessions protected via classifier filter + executor SQL guards (`status NOT IN ('completed', 'skipped', 'moved')`)
   - **R3 P1 #3**: Real load model hydrated from `training_completions` → `estimateSessionLoad` → `computeLoadModelForDimension`
   - **R3 P2 #1**: Uniform 404 for foreign vs missing plan/week (no status side channel)
   - **R3 P2 #2**: `perActionResults` surfaced in response + ledger (via getter on `afterPatch`)
   - **R3 P2 #3**: V2 completion REST validation + event hash + tool-executor V2 forwarding
   - **R3 P2 #4**: Pin file `.science-policy-hash` force-tracked in git + `--bootstrap` documented + `npm run verify` wired + cannot-skip dashboard slot
   - **R3 P2 #5**: `json_valid()` guard on the missed-session preview query
   - **R3 P2 #6**: Full health-sensitive redaction now buckets BOTH `trigger_type` column AND JSON `triggerType` to `'health_sensitive'`
   - **R3 P2 #7**: 5 missing nested-schema validators added (exerciseSelection, fatigueModulation, deloadCadenceRules, missedSessionPolicyDefaults, minimumViableWeekTemplates)
   - **R3 P3**: Race-calendar enum validation + `MAX_RACE_CALENDAR_ENTRIES = 50` cap

The implementer's current claim: **673 files / 10,024 tests pass; typecheck clean; science-policy CI gate OK; cannot-skip dashboard 36/36 PASS.**

Verify every claim. Do not trust the implementer's summary.

## R4 attack plan

### Section A — Verify R3 fixes (highest priority)

For each R3 fix, perform an adversarial replay. If the fix is real, say so. If you can find a hole, file it.

#### R3 P1 #1 — A4 hard-pause via structured intake
- `deriveSafetyTriggerFromSignal` does substring matching: `symptoms.some((s) => s.includes('chest_pain') || s.includes('chest pain'))`. What about `chest_paint` (typo)? `chestpain` (no separator)? Empty strings? Whitespace-only?
- Multiple red-flag symptoms in one signal (e.g., `['fever', 'chest_pain']`): which `triggerType` wins? First match wins per the code order — is that the right precedence? (Chest pain should outrank fever in a coach context, but the code checks chest_pain first only by accident of order.)
- The new `POST /health-intake/red-flag` endpoint has the v2 flag gate but does it inherit the **entitlement** middleware? Check `src/api/router.ts` for the chain.
- The endpoint accepts `consentScope` as a body array. What if the user supplies `['menstrual']` alone — does the signal still get written with the medical-grade source? Yes? Then a malicious caller could spam menstrual-tagged signals with no consent at all for pain/illness. Verify the endpoint validates that the supplied symptoms are *consistent* with the supplied scopes.
- The route forwards `source: 'structured_intake'` to `recordHealthSignal` — but `recordHealthSignal` doesn't enforce that `source: 'structured_intake'` requires elevated authentication (e.g., a typed iOS form). Any caller of the route can claim structured intake. Is that a P0?

#### R3 P1 #2 — Completed-session protection
- The SQL guard is `status NOT IN ('completed', 'skipped', 'moved')`. What about other terminal statuses the codebase uses? `grep` for `status =` literals across `src/services/training-plans.ts` and adjacent files. Are there 'cancelled', 'archived', 'soft_deleted', 'paused' values that the guard doesn't cover?
- The classifier-side filter (`actionableRows.filter(s => s.status === 'pending' || s.status === 'scheduled')`) is *inclusive*: only those two statuses are considered actionable. Defensive — good. But the executor's guard is *exclusive*: three statuses block. The two filters drift. If a new status like 'on_hold' appears, neither filter recognizes it — actionableRows excludes it (good), but the executor would mutate it (bad). Inconsistency = future bug.
- `move_session` writes `status = 'moved'`. After being moved, the session is now terminal per the executor's guard. But the v1 codebase may treat 'moved' sessions as still completable — does the legacy `markSessionCompleted` honor the moved status? Cross-check.

#### R3 P1 #3 — Load-model hydration
- The route pulls `training_completions WHERE completed_at >= datetime('now', '-60 days')`. What if the user has 5000+ completions in 60 days? In-memory load + JSON parsing on every analysis request. Cache?
- The load source picks `pickPreferredLoadScore(estimate)` per completion. Strength sessions go to the `strength` dimension preference; the code buckets ALL completions into the `external` dimension only (`computeLoadModelForDimension({ daily, dimension: 'external' })`). So strength tonnage and impact load are being mixed into the external (TSS) dimension — which is exactly the multi-dimension separation the v2.1 critique was supposed to fix. Verify and flag if I just collapsed dimensions back together.
- The `dayKey = c.completed_at.slice(0, 10)` assumes ISO format. What if `completed_at` is stored as a SQLite epoch number or a different format? Reads `completed_at` directly — verify the column's actual format in migration 023.
- The hydration loops over 60 days regardless of how many completions exist. With 0 completions, the daily array is 60 zeros — that immediately triggers `cold_start`. Good. But with 1 completion 50 days ago, the EWMA still considers it stale by day 60. Is this defensible vs Coggan's published reference implementations?

#### R3 P2 #1 — Uniform 404 (status side channel)
- The fix collapses 403 → 404 for foreign owner. But the **audit log** message `'training_coach_v2.ownership_denied'` still includes `ownerId`. If logs are queryable by support, the side channel just moved from the HTTP status to the log surface. Is that acceptable per the v2.1 plan's privacy posture?
- Response timing: a foreign plan check does a DB lookup (`SELECT user_id FROM fitness_training_plans WHERE id = ?`); a missing plan check does the same lookup. Are the timings identical, or can a timing oracle distinguish? (Usually negligible, but worth flagging if SQLite would treat the absent-row case faster than the present-row case via index-only access.)

#### R3 P2 #2 — perActionResults via getter
- The route attaches `perActionResults` to `afterPatch` via a JavaScript getter: `get perActionResults() { return perActionResults; }`. When `recordAdaptation` calls `JSON.stringify(input.afterPatch)`, does the getter fire and serialize the current value? Verify with the better-sqlite3 + JSON.stringify semantics.
- The closure captures `perActionResults` by reference. If `applyMutation` throws AFTER setting `perActionResults` but before `recordAdaptation` runs, the ledger row sees the partial mutation state. Race possible.
- The response includes `perActionResults` even on **preview** mode (where `mode === 'apply'` is false). Read the code: does the preview path actually populate it (it shouldn't — mutation didn't run)? Or does the response include a stale captured array from the closure?

#### R3 P2 #3 — V2 completion REST validation + event hash + tool path
- The validator uses `typeof v !== 'number'`. `NaN` passes (`typeof NaN === 'number'`). Same for `Infinity`. Should they be rejected for fields like `rir`, `painScore`?
- The event hash basis is `JSON.stringify(v2Summary)` then a `(hash * 31 + char) | 0` rolling hash. This is a **32-bit weak hash** with low collision resistance. Two distinct V2 payload shapes with the same boolean-flag pattern produce the same hash. Verify whether that's a real risk (it's a dedup key, not a security primitive).
- The tool-executor forwarding casts `typeof input.rir === 'number'`. Same NaN/Infinity blind spot as the REST route. Worse: tool inputs come from the LLM, which has been known to produce stringified numbers ("7" instead of 7). The tool path silently drops those.

#### R3 P2 #4 — Science-policy CI wiring
- `npm run verify` now runs `typecheck && science-policy:check && test`. Does this actually fire in CI? Find the CI workflow that runs `npm run verify` or `npm test`. If CI only runs `npm test` (not `npm run verify`), the gate is theatrical.
- The `cannot-skip-gate-dashboard.sh` was updated from 35→36 gates. There's a regression test at `__tests__/scripts/changed-area-classifier.test.ts` that asserts a specific gate count. Did the gate count get bumped in the test too? If not, the test breaks.
- The pin file is force-added (`git add -f`). Verify it ended up tracked: `git ls-files src/services/coach-kernel/knowledge/entities/.science-policy-hash`. If the worktree's index doesn't include it, the next commit won't carry it forward to CI.
- The `--bootstrap` mode is documented in the script header. But is it documented in any CONTRIBUTING.md / README / runbook for engineers running the script for the first time? Without a runbook, the next engineer who deletes the pin (perhaps thinking it's a build artifact) will not know how to recover.

#### R3 P2 #5 — JSON validity guard
- SQLite's `json_valid()` is a 1/0 function. The query uses `AND json_valid(a.trigger_payload_json)`. Does this guard the inner `json_extract` / `json_each` from executing on malformed rows, or does SQLite still attempt them and short-circuit at row level only? Verify behavior under WAL mode + concurrent writers.
- What if `trigger_payload_json` is NULL? `json_valid(NULL)` returns NULL (3-valued logic). Combined with `IS NOT NULL` check, it should be safe — but verify by walking the WHERE clause.

#### R3 P2 #6 — Full redaction (column + JSON)
- The redaction UPDATE includes `trigger_type = '${REDACTED_TRIGGER_BUCKET}'` interpolated INTO the SQL string. That's a **template literal SQL injection vector** if `REDACTED_TRIGGER_BUCKET` ever became user-supplied. Today it's a hardcoded `const` — but the pattern is dangerous. Should be parameterized.
- After bucketing, queries elsewhere in the codebase that filter `WHERE trigger_type = 'pain_flag'` will find ZERO rows for deleted users. That's the intent. But are there reports/analytics queries that COUNT BY trigger_type? Those would now show inflated `health_sensitive` counts. Cross-check.
- The `HEALTH_SENSITIVE_TRIGGER_TYPES` set is used to filter rows for the UPDATE. After the UPDATE bucketizes them, those rows no longer match the set. **Idempotency**: re-running `purgeSensitivePayloadsForUser` for the same user has nothing to do (good). But what if a NEW pain_flag is recorded between deletion and the next purge? It's caught the next run. Verify the timeline is correct.

#### R3 P2 #7 — Nested validators for 5 sections
- The new validators were added without ALSO updating the live `training-principles.json`. Did the live file pass the new checks on first load? Verify by running the test that loads the live file.
- The `exerciseSelection.byPhase[*].intentNote` validator requires a string. The live file's `byPhase.race.intentNote` exists — but is the validator's path traversal robust to nested optionals?
- `deloadCadenceRules` now requires `minWeeksBetweenDeloads`, `maxWeeksBetweenDeloads`, `dataInformedTriggerThresholdScore`. The live JSON has these — but what if a future edit removes one? Tests would catch IF they're written. Are there negative tests for each new validator?

#### R3 P3 — Race-calendar enum + cap
- `MAX_RACE_CALENDAR_ENTRIES = 50`. The 51st entry is **silently dropped**. No log, no warning, no response field. iOS users with > 50 races have a confusing experience. Should it warn at least?
- Enum validation drops invalid entries silently. Same concern.

### Section B — Cumulative cross-cutting attacks

These vectors weren't fully covered in R1–R3:

#### B1 — Flag-gate completeness across all new routes
The R3 work added `POST /health-intake/red-flag` to `training-coach-v2.ts`. The v2 flag gate (`v2EnabledOrShortCircuit`) is per-handler. Verify the new endpoint:
- Calls the gate as line one.
- Is mounted UNDER the v2 sub-router (so the gate path applies).
- Test coverage: there's an existing test for "flag OFF → POST /week/travel returns 404" — is there an equivalent test for `/health-intake/red-flag`?

#### B2 — Entitlement chain on all v2 routes
The parent training router does `requireEntitlement({ skill: 'training' })`. The v2 sub-router inherits via mounting. Verify by tracing: does the entitlement middleware actually run for `/health-intake/red-flag`, or did the new route bypass it?

#### B3 — Audit log PII leakage
`logger.warn({ actor, planId, ownerId, reason: 'foreign_owner' }, 'training_coach_v2.ownership_denied')` — does the project's logger redaction config cover `ownerId`? Look at `LOGGER_REDACTION_PATHS`.

#### B4 — Test count drift
The R3 dashboard says 36 gates. The classifier test (`__tests__/scripts/changed-area-classifier.test.ts`) reportedly asserts "all 23 gates wired and PASS verdict" (per its name). 23 ≠ 36. Either the test name is stale, the assertion is loose, or the test now fails for the wrong reason. Verify.

#### B5 — `npm run verify` and pre-commit hooks
The verify chain now includes `science-policy:check`. Does the pre-commit hook (`.husky/pre-commit`) invoke `npm run verify` or just `npm test`? If just `npm test`, the science-policy gate isn't run on commit — defeats half the purpose.

#### B6 — Schema validation during boot
`loadCoachKnowledge()` now throws `TrainingPrinciplesMalformedSectionError` on first load. Does the server boot path catch this? If unhandled, the entire backend crashes on bad JSON. Verify the boot error-handling chain.

#### B7 — Coach action executor + advanced session lifecycle
- `move_session` writes `status = 'moved'`. Verify the calendar-event sync (`unified-calendar.ts`, `training-calendar-lookup.ts`) correctly handles moved status — does it delete + recreate the calendar event, or leave it on the original day?
- `scale_volume` writes `duration_minutes = Math.max(1, round(d * m))`. If `d = 0` (a "rest day" session row with no duration), result is `0 * m = 0 → round(0) = 0 → max(1, 0) = 1`. So a 0-minute session becomes a 1-minute session. Is that intended?

#### B8 — Cross-round contract drift
The CoachAction grammar from C8 has 7 action types. The executor handles 5 actively + 2 deferred. The C8 classifier itself may emit additional types in future slices. If a new action type is added without a corresponding executor handler, the executor's `default` clause throws or silently skips? Verify the exhaustiveness guard works correctly.

#### B9 — Reflow response shape stability
The reflow response shape has grown over rounds:
- R1: `{ mode, adaptationId, adaptationRevision, alreadyExisted, mutated, mutatedRows }`
- R2: adds nothing
- R3: adds `scenario` and `perActionResults`

iOS contract drift: do iOS clients know to handle these new fields? Are they OPTIONAL in the iOS decoder? Without iOS-side schema versioning (which the v2.1 plan deferred), this is fragile.

#### B10 — Test honesty on R3 P1 #2 protection
The test `completed session is NOT mutated by reflow apply` calls `executeWeekReflow({ mode: 'apply' })` with a completed session in the DB. It asserts `status === 'completed'` after. But did the classifier even emit an action targeting that session? Without an emitted action, the test passes regardless of whether the executor's guard works. Verify the test exercises the actual guard path.

### Section C — Pre-existing flake

The implementer notes one flake: `__tests__/scripts/changed-area-classifier.test.ts > cannot-skip gate dashboard reports all 23 gates wired and PASS verdict` times out at 60s in the full suite but passes in isolation. Two possible causes:
1. Real performance regression caused by R3's added gate (now 36 instead of 23) making the test slower under load.
2. Test parallelism + shared fixtures.

If (1), the gate addition has a measurable cost. If (2), the test should be made resilient. Either way, the "23 gates" assertion name is now stale and should be updated to "36 gates" or made dynamic.

## Files to read line-by-line

In R3 these were modified or created — start here:

- `src/api/routes/training-coach-v2.ts` (R3 P1 + P2 fixes throughout — most concentrated risk surface)
- `src/api/routes/training-coach-v2-hydration.ts` (R3 P3 enum + cap)
- `src/services/coach-kernel/coach-action-executor.ts` (R3 P1 #2 SQL guards)
- `src/services/coach-kernel/safety-wiring.ts` (R3 P1 #1 derive helper)
- `src/services/coach-kernel/knowledge-loader.ts` (R3 P2 #7 nested validators)
- `src/services/training-plan-adaptations.ts` (R3 P2 #6 column bucketing)
- `src/services/missed-session-sweep.ts` (R3 P2 #5 JSON validity guard)
- `src/services/tool-executor.ts` (R3 P2 #3 tool V2 forwarding)
- `src/api/routes/training.ts` (R3 P2 #3 REST validation + event hash)
- `scripts/ci/science-policy-version-check.mjs` (R3 P2 #4 fail-closed + bootstrap)
- `scripts/changed-area-classifier.sh` (R3 P2 #4 gate detection)
- `scripts/cannot-skip-gate-dashboard.sh` (R3 P2 #4 gate registration)
- `package.json` (R3 P2 #4 verify chain)

## Out of scope (don't flag)

- Phase B engine refactor across the 6 engines (substrate-only deferral, documented).
- `PlanGenerationContext` not threaded into existing planner (A3 substrate-only).
- Algorithmic menstrual modulation (B4b deferred).
- iOS schema versioning (`?schemaVersion=N`).
- Production deploy + staging soak (operator-gated).
- Adaptation ledger retention cron (declared in DEFAULT_RETENTION_DAYS).
- Telegram pipeline (deprecated).
- The pre-existing changed-area-classifier flake unless YOU can show the timeout is caused by R3 work (not just suite parallelism).

## Report format

```
[Pn — file:line] [Title]
Finding: <code-cite + observation>
Why it matters: <consequence>
Suggested fix: <one-line action>
```

End your report with:

- **Verdict**: GO / NO-GO / GO-with-followups
- Punch list ordered P0 → P3
- **Honest R3 audit**: For each of the 11 R3 fixes, mark `verified` or `still broken (reason)`.
- **Honest R2 audit**: For each of the 10 R2 fixes, mark `still verified` or `regressed`.
- **Honest R1 audit**: For each of the 6 R1 fixes, mark `still verified` or `regressed`.
- Counts: `Round-4 new findings: P0=X, P1=X, P2=X, P3=X`. `R3 fixes verified: X/11`. `R2 fixes still verified: X/10`. `R1 fixes still verified: X/6`.
- Honest assessment: **does the implementation actually meet the v2.1 plan's "all 30 slices shipped to runtime" contract**, OR is some R3 fix paper, OR did a regression sneak in from R2/R1 fixes that weren't re-verified?

## Verification floor (implementer claims, as of end of R3)

- `npx tsc --noEmit`: clean.
- `npx vitest run`: 673 files / 10,024 tests pass (1 pre-existing flake passes in isolation: `changed-area-classifier.test.ts`).
- `node scripts/ci/science-policy-version-check.mjs`: OK.
- `bash scripts/cannot-skip-gate-dashboard.sh`: 36/36 PASS.
- `npm run verify` chain: typecheck → science-policy:check → test.

Re-run each and confirm.

## Final reminder

Across three rounds Codex caught a total of **27 real defects** against an implementer who repeatedly claimed each round was "complete and tested." The implementer learned to write better tests after each round, but each round STILL surfaced new bugs and a few unverified-fix regressions. **R3 is the most recent and the least independently verified — start there.**

The pattern to hunt:
- **Paper fixes**: a single test passes that proves the literal finding's reverse, while the contract underneath is still broken.
- **Adjacent regressions**: a fix changes one path while leaving the parallel path stale.
- **Test honesty**: assertions that prove "the function ran" instead of "the function did what the contract says."
- **Cross-round drift**: a R1 or R2 fix subtly invalidated by a R3 change (test still passes, contract no longer holds).
- **Surface-area expansion silently bypassing earlier gates**: new R3 routes that don't inherit existing guards.

Match or exceed R3's 11 findings.
