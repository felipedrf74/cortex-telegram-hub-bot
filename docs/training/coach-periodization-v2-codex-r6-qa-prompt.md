# Codex R6 — Adversarial QA prompt (Week-Level Adaptability + Periodization v2.1)

You are an adversarial code-reviewer. The implementer claims to have closed
**every R5 finding**. Your job is to disprove that claim.

Track record so far:
- R1 → 6 P1/P2 defects.
- R2 → 10 P0/P1/P2/P3 defects.
- R3 → 11 P1/P2/P3 defects.
- R4 → 11 P1/P2/P3 defects.
- R5 → 9 P1/P2/P3 defects (this round's input).

Every prior round, the implementer believed the work was done. Every prior
round, Codex found that "mostly done" wasn't done. **Default assumption: there
are R5-fix regressions hiding behind the new green-test sweep.**

---

## Original goal

Implement the v2.1 Week-Level Adaptability + Periodization plan saved at
`/Users/felipedominguez/.claude/plans/can-you-work-on-polymorphic-lamport.md`
(30 slices, 3 phases) on top of the deterministic rule-based coach kernel.

Worktree:
`/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot/.claude/worktrees/cool-keller-56fedc`

`CLAUDE.md` in this worktree is the bootloader. iOS contracts are out of scope.

---

## R5 findings + what was implemented

### R5 P1 (3 fixes)

**#1 — Anti-churn rate limits actually enforced.**
- Added `countNonSafetyAppliedAdaptations(planId, hoursBack)` in
  `src/services/training-plan-adaptations.ts`. Excludes previews,
  rollbacks, and rows whose `decision_reason_codes_json` contains
  `medical_referral` (safety-pause exempt by contract). Uses
  `datetime('now', '-N hours')` for the window cutoff so the boundary
  matches the SQLite UTC clock used by `created_at`.
- Wired into both reflow and coach-analysis at the
  `classifyTrainingScenario` call site in
  `src/api/routes/training-coach-v2.ts`. Pre-R5 both passed only
  the policy limits (without counts), so the limiter defaulted to 0
  and never tripped.

**#2 — Fix `inferSportFromSessionType('gym','gym') → 'strength'`.**
- `src/api/routes/training-coach-v2-hydration.ts:36` adds 'gym',
  'lift', 'lifting', 'weights', 'weight_*', 'resistance', 'squat',
  'deadlift', 'press' detection up front; plan-sport fallback now
  accepts gym/strength/weights/lifting and canonicalizes to the
  kernel's `'strength'` enum.
- The local `inferSportForCompletion` helper in
  `training-coach-v2.ts` now **delegates** to the canonical helper
  (single source of truth so fixes don't drift).
- Primary-dim selection in `training-coach-v2-load-helper.ts` now
  treats `planSport in {gym|strength|weights|lifting}` as the
  strength branch.

**#3 — Reflow path computes + passes real `deloadDue`.**
- New helper `src/api/routes/training-coach-v2-load-helper.ts`
  centralizes load-model hydration + dimension pick + deload
  recommendation. Both routes (reflow + coach-analysis) now call
  `computeLoadModelAndDeload(...)` — single source of truth.
- Reflow path also adds the `resolveMesocyclePlan(...)` call it was
  missing so the helper has the scheduled cadence input.
- Coach-analysis route slimmed by ~120 lines of inlined helper code
  (now duplicated only in tests, not source).

### R5 P2 (4 fixes)

**#4 — Replace 32-bit V2 hash with SHA-256.**
- `src/api/routes/training-completion-v2-hash.ts` swaps both the
  string fingerprint AND the outer summary hash to SHA-256 via
  `node:crypto`. String fingerprint takes the first 12 hex chars
  (48 bits + length prefix); the outer hash takes the first 16 hex
  chars (64 bits).
- New regression test verifies the Codex-found collision pair
  `'3gdr5fzx'` vs `'5bp434lq'` (both produced `790060a4` under FNV)
  now produce distinct hashes.

**#5 — Tool `log_training_completion` emits the same event stream.**
- `src/services/tool-executor.ts` now wraps `logCompletion` in
  `runOutboxTransaction(...)` and emits
  `training.feedback.recorded` with the same canonical V2 hash
  idempotency key the REST path uses. Includes `origin: 'tool'` in
  the payload summary so consumers can distinguish chat-origin from
  REST-origin completions. Wraps in try/catch + non-transactional
  fallback so a transient outbox failure doesn't drop the user's
  completion data on the floor.

**#6 — coach-action-executor uses the actionable allowlist.**
- `src/services/coach-kernel/coach-action-executor.ts` swapped the
  SQL boundary from `NOT IN (terminal)` to `IN (actionable)`. Also
  replaced the in-memory `isTerminalSessionStatus(...)` predicate
  with `!isActionableSessionStatus(...)`. Adding a new non-actionable
  status (e.g. `'cancelled'`) is now safe by default — the executor
  won't mutate rows whose status isn't explicitly allowed.
- Renamed skip reason `session_completed_or_terminal` →
  `session_not_actionable` to reflect the new contract.

**#7 — Strength load model hydrates V2 sets/reps/load JSON.**
- `training-coach-v2-load-helper.ts` SELECTs the V2 strength JSON
  columns and `computeStrengthTonnageKg(setsJson, repsJson, loadJson)`
  derives real tonnage from either Shape A (`[{reps,load}]`) or
  Shape B (parallel `reps[]`/`load[]`). Falls back to the prior
  duration × RPE × 20 proxy only when V2 JSON is absent.

### R5 P3 (2 fixes)

**#8 — Reflow surfaces race-calendar drops too.**
- `training-coach-v2.ts` reflow path now calls
  `resolveRaceCalendarFromPlanWithReport(...)` and emits the same
  `race_calendar.entries_dropped_on_resolve` warn log
  coach-analysis emits. The drop counts aren't on the apply
  response body (iOS reads that from coach-analysis), but operators
  get full audit visibility from both paths.

**#9 — `ownerIdHash` upgraded to HMAC-SHA256.**
- `training-coach-v2.ts` replaced the 24-bit FNV with
  HMAC-SHA256 keyed by `OWNER_ID_HASH_SECRET` (env var) with a
  per-process random salt fallback. Output is now `u#XXXXXXXX`
  (32-bit truncation of HMAC, prefix preserved). Cannot be
  brute-forced by an operator who knows the algorithm — they'd
  also need the secret.
- Tests verify the new tag does NOT equal the old FNV result for
  small sequential IDs (`1, 2, 3, 42, 1000`).

---

## Files changed (R5 closeout, this session)

### New
```
src/api/routes/training-coach-v2-load-helper.ts
__tests__/api/training-coach-v2-load-helper.test.ts
__tests__/api/training-coach-v2-gym-sport-inference.test.ts
__tests__/services/training-plan-adaptations-rate-limit-count.test.ts
docs/training/coach-periodization-v2-codex-r6-qa-prompt.md   (this file)
```

### Modified
```
src/api/routes/training-coach-v2.ts                  (R5 #1, #2, #3, #5, #8, #9)
src/api/routes/training-coach-v2-hydration.ts        (R5 #2)
src/api/routes/training-completion-v2-hash.ts        (R5 #4 — SHA-256)
src/services/tool-executor.ts                        (R5 #5)
src/services/coach-kernel/coach-action-executor.ts   (R5 #6 — actionable allowlist)
src/services/training-plan-adaptations.ts            (R5 #1 — count helper)
__tests__/api/training-completion-v2-hash.test.ts    (added Codex-collision regression)
__tests__/api/training-coach-v2-owner-id-hash.test.ts (R5 #9 — HMAC + FNV-mismatch assert)
__tests__/services/coach-kernel-session-status.test.ts (updated for actionable allowlist)
```

---

## Expected behavior — pin these contracts

### Anti-churn rate limits
- A plan that already has 2 applied non-safety reflows in the last 7 days
  (or 1 in the last 24h) → next `/coach-analysis` returns
  `scenario.actions: []` with `primaryScenario: 'no_scenario'` and
  `safetyOverrides: []`. Same plan with classifier-relevant
  conditions still gets the modifier list but no actions.
- A plan with the same conditions but only **safety-pause** ledger
  rows in the window → rate limit does NOT trip; safety overrides
  fire unconditionally.
- A preview reflow does NOT count toward the limit.
- A rollback row does NOT count toward the limit.

### Gym session sport
- `inferSportFromSessionType('gym', 'gym')` → `'strength'` (NOT `'running'`).
- Same for `('lift','lifting')`, `('squat','weights')`, etc.
- An athlete with `plan.sport = 'gym'` gets `primaryDim = 'strength'`
  in the load model — verify by hydrating completions with non-zero
  strength tonnage and asserting `loadModelByDimension.strength`
  has the load.

### Reflow deload parity
- A plan whose load model says deload is due → coach-analysis's
  `scenario.modifiers` includes 'deload_due' AND reflow apply
  also emits the same modifier (it didn't before R5 #3).
- The shared helper computes the SAME `primaryDim` /
  `loadModelStatus` / ACWR in both paths.

### V2 hash
- `computeV2IdempotencyHashHex({ painLocation: '3gdr5fzx' })`
  ≠ `computeV2IdempotencyHashHex({ painLocation: '5bp434lq' })`.
- Hash output exactly 16 hex chars (64 bits).
- 1000+ distinct triple-field payloads produce 1000+ distinct hashes.
- The string fingerprint NEVER contains raw user content.

### Tool path event emission
- A `log_training_completion` tool call with V2 fields →
  `training_outbox` table gains a `training.feedback.recorded` row
  with `payload.summary.origin === 'tool'` and an idempotency key
  matching `training.feedback.recorded:USER:SESSION:completed:HAS_NOTES:RPE:v2-HASH`.
- Same key from REST + tool within the dedup window collapses to
  one row.
- A transient outbox failure does NOT lose the completion data —
  the catch-fallback persists via direct `logCompletion`.

### Executor allowlist
- A session row with `status = 'cancelled'` (a hypothetical future
  non-actionable status) → reflow apply does NOT mutate it,
  returns `skipped: true, skipReason: 'session_not_actionable'`.
- A session with `status = 'pending'` or `'scheduled'` is fair
  game.

### Strength tonnage
- A V2 completion with `completed_sets_json` =
  `'[{"reps":5,"load":100},{"reps":3,"load":110}]'` and
  `sport: 'strength'` → load model's strength dimension reflects
  ≥830 kg tonnage, NOT the duration × RPE × 20 proxy.

### Reflow race-calendar drops
- A reflow on a plan with invalid race entries → operator log
  shows `race_calendar.entries_dropped_on_resolve` with the same
  drop-reason breakdown coach-analysis emits.

### HMAC ownerIdHash
- `hashOwnerIdForLog(42)` deterministic within a process boot.
- Output exactly 10 chars (`u#` + 8 hex).
- An attacker who reproduces the prior FNV-1a algorithm gets a
  DIFFERENT result than the current HMAC output for any input.

---

## Tests + checks already performed

- `npx tsc --noEmit`: **clean**.
- Targeted R5 surface (10 test files specifically tied to R5
  P1/P2/P3 fixes): all green.
- Broader regression (192 test files / 2294 tests across
  `__tests__/api/` + `__tests__/services/coach-kernel-*` +
  `__tests__/services/training-*`): all green.
- **Full vitest suite**: 683/684 test files / 10176/10177 tests
  passing. The single failure was the `cannot-skip-gate dashboard`
  integration test — a known-flaky timing-sensitive test that
  passed cleanly when re-run in isolation (22.7s).
- `node scripts/ci/science-policy-version-check.mjs`: passes.
- The new tests added this round:
  - `training-completion-v2-hash.test.ts` — 19 tests total
    (added the Codex-collision regression).
  - `training-coach-v2-owner-id-hash.test.ts` — 7 tests
    (updated for HMAC format + adversarial-FNV assert).
  - `training-coach-v2-load-helper.test.ts` — 11 tests
    (computeStrengthTonnageKg, shape A + B + edge cases).
  - `training-coach-v2-gym-sport-inference.test.ts` — 8 tests
    (regression for the `('gym','gym') → 'strength'` case).
  - `training-plan-adaptations-rate-limit-count.test.ts` — 8 tests
    (preview/rollback/safety exclusion + window cutoff).

---

## Areas to inspect carefully

Map each R5 fix to the failure mode most likely to recur and
verify it explicitly.

1. **R5 P1 #1 — anti-churn off-by-one + safety exemption.**
   - Verify the SQL `LIKE '%medical_referral%'` is the only safety
     marker. If a future safety-pause carries a different
     `decisionReasonCode` (e.g. `'system_pause'`), it would COUNT
     toward the rate limit and silently rate-limit safety. Read
     `src/services/coach-kernel/scenario-classifier.ts` to
     confirm what decision-reason it emits for the safety branch.
   - Confirm the rate limiter actually trips when the count
     reaches the limit (not just exceeds it).
2. **R5 P1 #2 — gym fix completeness.**
   - Grep the codebase for any OTHER place that converts session
     type or plan sport to a Sport enum. Are there stragglers
     that still misroute `'gym'`?
   - Confirm the kernel engines (`gym-engine.ts` etc.) treat
     `sport = 'strength'` the same way they treat the legacy
     `'gym'` value — if not, the canonicalization is leaky.
3. **R5 P1 #3 — deload parity at the boundary.**
   - Read `src/services/coach-kernel/week-conditions.ts` to
     confirm `aggregateWeekConditions` actually surfaces
     `deloadDue` on the assembled `WeekConditions` shape, and
     that the classifier's `weekConditions.deloadDue` consumer
     reads from the same field.
   - Are there other surfaces (briefing, plan generator) that
     should also use the shared helper but still inline their
     own load-model code?
4. **R5 P2 #4 — SHA-256 truncation safety.**
   - 64-bit truncation gives ~5B birthday bound. Verify no
     adversarial input can force a collision (test the helper
     against ~10M random inputs — that's overkill but should
     not surface any).
   - Is the helper called from any test that pinned a specific
     legacy FNV hex value? Search `__tests__/` for
     `computeV2IdempotencyHashHex(` and check for any `toBe(`
     assertions on a fixed string.
5. **R5 P2 #5 — tool emission idempotency parity.**
   - Verify the tool-path idempotency key has the SAME shape as
     the REST key for the same canonical V2 fields. A
     dedup-within-window collapses only if the keys are bytewise
     identical.
   - Verify the catch-fallback path (transient outbox failure)
     doesn't double-write the completion if the transaction
     partially succeeded.
   - Verify chat tool calls without a valid `tenantId` still
     emit the event with a deterministic fallback tenant id.
6. **R5 P2 #6 — actionable allowlist false negatives.**
   - Confirm no legitimate status outside `pending|scheduled`
     was previously expected to be actionable. Read the
     `training_sessions` table migration to enumerate all
     possible statuses + check each is intentionally
     allowlisted or denied.
   - Confirm the `executor.skip()` reason-code change
     (`session_completed_or_terminal` → `session_not_actionable`)
     doesn't break a downstream consumer that pattern-matches
     the reason.
7. **R5 P2 #7 — strength tonnage shape detection.**
   - The helper prefers Shape A (`[{reps,load}]`) over Shape B
     (`reps[]`/`load[]`). If a client sends BOTH AND they
     disagree, Shape A wins silently. Is that the right policy
     or should the resolver throw / warn?
   - Confirm a malformed Shape A still falls through to Shape B
     rather than returning undefined too eagerly.
8. **R5 P3 #8 — reflow drop-report parity.**
   - Reflow logs the drops but doesn't surface them on the
     response. Is there any consumer that needs the
     `raceCalendarDrops` field on apply too? (Today it only
     lives on `/coach-analysis`.) If iOS retries an apply after
     editing the race calendar, should the apply response tell
     them the new entries were accepted?
9. **R5 P3 #9 — HMAC secret bootstrap.**
   - Per-process random salt means two separate Node processes
     produce different tags for the same user id. Operator
     correlation across the cluster requires the explicit
     `OWNER_ID_HASH_SECRET` env var. Is that documented? Should
     it default to derived-from-existing-secret instead of
     pure random?
   - Confirm the secret is only read once at module import (not
     re-read on every call) so a runtime env mutation can't
     desync the tags within a process boot.

---

## Edge cases to verify

- Plan with exactly the rate-limit boundary (`recentReflowCount24h
  === ratePerDay`) → SHOULD trip (≥, not >).
- Plan with zero completions but `sport = 'gym'` → primary dim is
  `'strength'`, status is `'cold_start'`, deload signal disabled.
- A V2 completion payload that's IDENTICAL to a prior one (same
  numbers, same strings) → both REST and tool emissions dedup to
  one outbox row.
- An idempotency replay through the reflow conflict path → returns
  the same canonical response shape WITH `mode === 'apply'`,
  `mutated === false`, `alreadyExisted === true`.
- A session row with a NULL status (corrupted data) →
  `isActionableSessionStatus(null)` returns `false`, executor
  skips it with `session_not_actionable`.
- A strength session whose `completed_sets_json` is `'null'` (JSON
  literal null, not the string "null") → tonnage helper returns
  undefined safely without crashing.
- HMAC tag for `userId: 0` or negative → returns `'invalid'`.
- HMAC tag length never exceeds 10 chars regardless of input size.

---

## Known risks / assumptions

- **Per-process HMAC salt** is a deliberate ergonomic choice —
  cross-process correlation requires explicit env. Document this
  for operators.
- **64-bit hash truncation** is comfortable for outbox dedup
  but NOT cryptographic. Don't use for security-sensitive
  identifiers.
- **Anti-churn safety exemption** relies on `medical_referral`
  appearing in the decision-reason JSON. If the safety branch
  ever emits a different reason code, the limiter will treat
  it as user churn.
- **Plan sport canonicalization**: `'gym' → 'strength'` is
  applied in the load helper. If anything outside this codepath
  still reads `plan.sport === 'gym'` directly without
  canonicalization, those readers see a different value.
- **The full vitest suite had one flaky failure** in the
  `cannot-skip-gate dashboard` test that passes cleanly in
  isolation. Worth confirming this is pre-existing flake and
  not a regression introduced by R5.

---

## What "complete" means for this review

Your verdict should be one of:

- **GO**: All R5 closeout items hold up under adversarial
  inspection. Ready for staging soak.
- **NO-GO** with the list of new findings classified P1/P2/P3.
  Be precise — the implementer has shipped 5 rounds of fixes
  and you're the gate between "looks right" and "is right."

Focus on the **mutation paths** (`apply` reflows, tool emissions,
executor SQL) — that's where past rounds caught the most leaks.
Don't stop at "I see the helper exists." Check that every code
path that should call it does call it, with the right inputs,
and that the side effects match the analysis-path side effects.
