# Codex R7 — Adversarial QA prompt (Week-Level Adaptability + Periodization v2.1)

You are an adversarial code-reviewer. The implementer claims to have closed
**every R6 finding**. Disprove that claim.

Defect history:
- R1 → 6 P1/P2.
- R2 → 10 P0/P1/P2/P3.
- R3 → 11 P1/P2/P3.
- R4 → 11 P1/P2/P3.
- R5 → 9 P1/P2/P3.
- R6 → 6 P1/P2/P3 (one **user-data-loss** P1).

Pattern: every round the implementer fixed the named defects but introduced
adjacent gaps. **Default assumption: R6's fixes have created new interaction
bugs (e.g. rate-limit ↔ idempotency ↔ ledger short-circuit) that the new test
suite doesn't cover.**

---

## Original goal

Implement the v2.1 Week-Level Adaptability + Periodization plan at
`/Users/felipedominguez/.claude/plans/can-you-work-on-polymorphic-lamport.md`
(30 slices, 3 phases) on top of the deterministic rule-based coach kernel.

Worktree:
`/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot/.claude/worktrees/cool-keller-56fedc`

`CLAUDE.md` is the bootloader. iOS contracts out of scope.

---

## R6 findings + what was implemented

### R6 P1 — Tool completion rollback safety

`src/services/tool-executor.ts`:
- The closure inside `runOutboxTransaction(...)` no longer assigns the outer
  `completion` variable. It now **returns** the row; the outer variable
  receives the value from `runOutboxTransaction(...)`'s return — reached
  only AFTER commit.
- The catch block explicitly resets `completion = undefined` as
  belt-and-braces against a future regression that re-introduces the
  closure-assignment pattern.
- Catch then runs a non-transactional `logCompletion(...)` fallback so the
  athlete's data survives even when the outbox emission failed.
- Result: `success: true` + `completion_id: N` is now guaranteed to
  reference an actual `training_completions` row.

Tests: `__tests__/services/tool-executor-log-completion-rollback.test.ts`
proves: (a) happy path commits + event row exists; (b) emit throws →
completion rolled back AND fallback re-persists with a new id; (c) second
attempt under sustained failure still persists.

### R6 P2 — Rate-limit branch keeps the would-have modifiers

`src/services/coach-kernel/scenario-classifier.ts`:
- Rate-limit check moved from an early-return to a post-pass. Modifier
  computation runs unconditionally; actions get suppressed only after
  the modifier list is built.
- `ScenarioAssessment` gains optional `rateLimited?: boolean` and
  `suppressedActions?: CoachAction[]` so the UI can render "we'd
  suggest X but waiting."
- Safety overrides still short-circuit ABOVE the rate limit (they're
  exempt by contract).

Tests:
`__tests__/services/coach-kernel-scenario-rate-limited.test.ts`,
plus updated `coach-kernel-scenario-classifier.test.ts` rate-limit cases.

### R6 P2 — Reflow apply skips ledger write when rate-limited

`src/api/routes/training-coach-v2.ts`:
- When `mode === 'apply'` AND `scenario.rateLimited` AND no existing
  idempotency-key match → short-circuit BEFORE `executeWeekReflow`.
  No session mutations, no ledger row, no revision bump.
- Response uses the same `serializeReflowResponse` shape so iOS
  decodes both rate-limited and normal applies with one Codable.
- Synthetic result carries `adaptationId: 0, adaptationRevision: null,
  mutated: false, mutatedRows: 0`. `scenario.rateLimited: true`
  tells the caller exactly what happened.
- **Idempotency takes precedence**: if the same key already wrote a
  row, the request falls through to `executeWeekReflow` so the
  conflict-replay branch fires (retries of the same intent aren't
  churn).

### R6 P2 — ACTIONABLE_SESSION_STATUSES includes reflowed/compressed/capped

`src/services/coach-kernel/session-status.ts`:
- Allowlist now: `['pending', 'scheduled', 'reflowed', 'compressed',
  'capped']` — mirrors the persistence-layer `ACTIVE_SCHEDULE_STATES`
  + 'pending' (the planner-default initial state).
- Closes the "session reflowed once cannot be reflowed again" workflow
  bug Codex flagged.

Tests: `__tests__/services/coach-kernel-session-status.test.ts` added
the persistence-layer-parity assertion.

### R6 P3 — Tool boolean validation parity

`src/services/tool-executor.ts`:
- Added `checkBoolean(name, v)` helper matching the REST `checkBoolean`
  contract. `external_training_declared` is now rejected on wrong type
  (`"yes"`, `1`, `null` → tool error).
- All four `external_training_declared === true` coercions in the tool
  case now read from the validated `v2ExternalDeclared` variable.

Tests: 4 new R6 P3 cases in
`__tests__/services/tool-executor-log-completion-rollback.test.ts`.

### R6 P3 — `OWNER_ID_HASH_SECRET` documented

- `.env.example`: added the var with the operator-facing rationale
  (per-process random salt when unset; explicit secret for
  cross-process correlation).
- `DEPLOY.md`: new "Optional Runtime Secrets (Training Coach v2)"
  section.

---

## Files changed (R6 closeout, this session)

### New
```
__tests__/services/tool-executor-log-completion-rollback.test.ts
__tests__/services/coach-kernel-scenario-rate-limited.test.ts
docs/training/coach-periodization-v2-codex-r7-qa-prompt.md   (this file)
```

### Modified
```
src/services/tool-executor.ts                                 (R6 P1 + P3)
src/services/coach-kernel/scenario-classifier.ts             (R6 P2 modifier preservation)
src/services/coach-kernel/session-status.ts                  (R6 P2 allowlist)
src/api/routes/training-coach-v2.ts                          (R6 P2 short-circuit + idempotency precedence)
__tests__/services/coach-kernel-scenario-classifier.test.ts  (updated rate-limit cases)
__tests__/services/coach-kernel-session-status.test.ts       (added persistence-layer-parity)
.env.example                                                  (R6 P3 OWNER_ID_HASH_SECRET)
DEPLOY.md                                                     (R6 P3 secrets section)
```

---

## Expected behavior — pin these contracts

### Tool completion rollback safety
- `executeToolCall('log_training_completion', { session_id, ... })`
  with a transient outbox emit failure → returns `{ success: true,
  completion_id: N }` where N resolves to a real
  `training_completions` row.
- No combination of input + outbox state can produce a
  `success: true` referencing a rolled-back row.

### Rate-limit modifier preservation
- A travel week at the daily limit → `scenario.modifiers` includes
  `'travel_adjustment'`, `scenario.actions` is `[]`,
  `scenario.suppressedActions` is non-empty,
  `scenario.rateLimited === true`, `scenario.primaryScenario` is
  `'travel_adjustment'` (not `'no_scenario'`).
- A safety pause IGNORES the rate limit — `actions[0].type === 'pause_training'`
  regardless of how many recent reflows exist.

### Reflow apply rate-limit short-circuit
- An apply that classifies as rate-limited AND has NO existing
  idempotency key → returns 200 with `mutated: false`,
  `adaptationRevision: null`, `adaptationId: 0`,
  `scenario.rateLimited: true`. The `training_plan_adaptations`
  table gains ZERO new rows.
- An apply with the same idempotency key as a prior row (replay) →
  conflict-replay path fires regardless of rate-limit state. Returns
  `alreadyExisted: true, mutated: false`. ONE total row in the
  ledger (the original).
- Preview mode is unaffected — previews always run the classifier
  and never bump the revision.

### Actionable status allowlist
- A session row with `status = 'reflowed'` → reflow apply can mutate
  it (it's a candidate for another reflow). `isActionableSessionStatus('reflowed') === true`.
- Persistence-layer INACTIVE states (`unscheduled`, `deferred`,
  `dropped`, `rest`, `cancelled`, `superseded`) → still non-actionable.
- Adding a new status to `ACTIVE_SCHEDULE_STATES` requires also
  adding it to `ACTIONABLE_SESSION_STATUSES`. The persistence-parity
  test catches this.

### Tool boolean validation parity
- `log_training_completion` tool call with
  `external_training_declared: "yes"` → returns `{ error: '...
  external_training_declared must be a boolean ...' }`.
- Same with `external_training_declared: 1` or `external_training_declared: null`.
- `external_training_declared: true` → persists as `1` in
  `training_completions.external_training_declared`.
- `external_training_declared: false` or omitted → persists as `0`.

### `OWNER_ID_HASH_SECRET`
- Unset → each Node process picks a fresh 32-byte random salt at boot.
  Tags are stable within one process; different processes produce
  different tags for the same user id.
- Set to a stable secret → tags reproducible across processes + deploys.
- Documented in `.env.example` AND `DEPLOY.md` "Optional Runtime
  Secrets" table.

---

## Tests + checks already performed

- `npx tsc --noEmit`: **clean**.
- R6 focused suite (modified + new):
  - `tool-executor-log-completion-rollback.test.ts` → 7 tests
    (3 rollback + 4 boolean validation).
  - `coach-kernel-scenario-rate-limited.test.ts` → 5 tests
    (modifier preservation + safety exemption + boundary case).
  - `coach-kernel-session-status.test.ts` → 19 tests
    (added 4 R6 P2 persistence-parity cases).
  - `coach-kernel-scenario-classifier.test.ts` → 16 tests
    (rate-limit cases updated for R6 P2 contract).
  - `training-coach-v2-routes.test.ts` → 55 tests (idempotency
    precedence verified end-to-end).
- Broader regression (196 test files / 2405 tests across
  `__tests__/api/` + `__tests__/services/coach-kernel-*` +
  `__tests__/services/training-*` + event-backbone + tool-executor):
  all green.
- `node scripts/ci/science-policy-version-check.mjs`: passes.

---

## Areas to inspect carefully (this is where past rounds caught the most leaks)

1. **R6 P1 transactional fallback**: the catch block runs
   `logCompletion(...)` non-transactionally on outbox failure. Could
   this double-write under any condition? Read
   `src/services/tool-executor.ts` and trace: if the original
   transaction partially committed (better-sqlite3 is atomic, so
   "partially committed" should be impossible — verify this is true)
   would the fallback create a second row?
2. **R6 P2 modifier ↔ short-circuit interaction**:
   - The classifier returns `actions: []` when rate-limited, but
     `suppressedActions` is still populated. Does
     `executeWeekReflow`'s `decisionReasonCodes: scenario.actions.map(...)`
     correctly skip when actions is empty? (It currently maps `[]`
     → `[]`, which means the ledger row carries no decision codes,
     which might violate a downstream consumer.)
   - The rate-limit short-circuit in the route depends on
     `scenario.rateLimited === true`. If a future modifier branch
     pushes an action AFTER the rate-limit post-pass clears it, that
     action would survive. Verify the order is enforced.
3. **R6 P2 ledger short-circuit ↔ idempotency precedence**:
   - The new code does
     `findAdaptationByIdempotencyKey(planId, idempotencyKey)` only
     when `idempotencyKey !== undefined`. If the caller omits the
     key AND we're rate-limited, the route returns the synthetic
     success WITHOUT ever calling `executeWeekReflow`. But apply
     mode REQUIRES `idempotencyKey` per the contract (R3 P2 fix).
     Should the short-circuit still fire for apply-no-key? Currently
     it does — re-confirm that's intended (apply-no-key normally
     throws `IDEMPOTENCY_REQUIRED`).
4. **R6 P2 allowlist expansion blast radius**:
   - `reflowed` / `compressed` / `capped` are now actionable. The
     `coach-action-executor` SQL gate uses
     `IN ('pending','scheduled','reflowed','compressed','capped')`.
     Are there ANY other places in the codebase that enumerated the
     old `['pending','scheduled']` set and might now be
     under-counting? Grep for both literals.
5. **R6 P3 boolean parity**:
   - The tool path now rejects `null` for `external_training_declared`
     via the boolean check. Does any existing tool caller pass
     `null` intentionally? Grep for `external_training_declared: null`.
6. **`OWNER_ID_HASH_SECRET` boot-once vs request-once**:
   - The secret is read at module-import time. If the env is
     mutated at runtime (e.g. by a config-hot-reload), the tags
     won't update. Is that documented? Is hot-reload of env vars
     a thing in this codebase?
7. **Anti-churn count consistency**:
   - `countNonSafetyAppliedAdaptations` excludes rows whose
     `decision_reason_codes_json LIKE '%medical_referral%'`. The
     classifier emits `medical_referral` as the reason code for
     safety pauses. If a future safety branch uses a different
     reason code (e.g. `seek_professional_support` — the
     user-facing copy), the safety row would silently count
     toward churn. Verify there's only one code in use today.
8. **`suppressedActions` privacy**:
   - These actions can carry session ids + reason codes. Are they
     ever logged at a privacy-sensitive level (e.g. error logs)?
     The serializer puts them inside the response body, which is
     fine. But verify no `logger.warn`/`logger.error` includes
     `scenario.suppressedActions` in the metadata.

---

## Edge cases to verify

- Tool log_training_completion with **outbox throw + sustained throw
  on second attempt**: both completions persist via fallback, both
  return success with distinct ids.
- Reflow apply with **exact boundary** count
  (`recentReflowCount24h === ratePerDay`): rate-limit fires (≥, not >).
- Reflow apply with **safety pause + rate limit both true**: safety
  wins (pause action emitted, no rate-limited flag).
- Reflow apply preview with rate limit hit: preview RUNS (previews
  bypass the short-circuit because they don't bump revision).
- Reflow apply with `idempotencyKey` matching a row from BEFORE the
  rate limit tripped: conflict-replay path fires, returns canonical
  shape.
- Session row `status = 'rest'` (an INACTIVE state): executor skips
  it with `session_not_actionable`.
- Tool call with `external_training_declared: 0` (numeric false): now
  rejected (must be boolean).
- HMAC secret env var set to empty string: falls back to random salt
  (the helper checks `length >= 16`).

---

## Known risks / assumptions

- **Synthetic adaptationId: 0** in the rate-limited apply response
  may collide with a real id of `0` if the auto-increment ever
  starts there (SQLite ROWID starts at 1, but defensive).
- **`suppressedActions` is a new field** — iOS Codable may need
  updating to surface it. Until then it's silently ignored on the
  client (Swift Codable tolerates unknown keys by default).
- **The R6 P2 short-circuit is bypassed when idempotency replay
  exists** — this is intentional but means a user who hit rate
  limit, waited, and tried again with the SAME key gets the prior
  apply's result (which may now be stale). Acceptable: the key was
  meant to dedupe, not to gate retry-eligibility.
- **OWNER_ID_HASH_SECRET unset is the production default** unless
  operator explicitly sets it. Per-process random salt means a
  cluster of N processes produces N different tags. Documented;
  not enforced.

---

## What "complete" means for this review

Your verdict should be one of:

- **GO**: All R6 closeout items hold under adversarial inspection.
  Ready for staging soak.
- **NO-GO** with new findings classified P1/P2/P3, each with a
  `file:line` reference and the contract it breaks.

Focus your energy on the **rate-limit ↔ idempotency ↔ ledger**
interaction triangle — that's the new attack surface this round.
Also re-verify the R6 P1 fallback path: if there's any code path
that lets `completion` be assigned via the closure (bypassing
the return-value contract), you've found a regression.

Be brutal. We have 7 rounds of evidence that "looks right" doesn't
always equal "is right" — and you're the gate.
