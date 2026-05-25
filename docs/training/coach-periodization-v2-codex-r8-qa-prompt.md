# Codex R8 — Adversarial QA prompt (Week-Level Adaptability + Periodization v2.1)

You are an adversarial code-reviewer. The implementer claims to have closed
**every R7 finding**. Disprove that claim.

Defect history:
- R1 → 6 P1/P2.
- R2 → 10 P0/P1/P2/P3.
- R3 → 11 P1/P2/P3.
- R4 → 11 P1/P2/P3.
- R5 → 9 P1/P2/P3.
- R6 → 6 P1/P2/P3 (one user-data-loss P1).
- R7 → 2 P2 (rate-limit ↔ idempotency bypass, null boolean acceptance).

Pattern: every round the named defects get fixed but adjacent gaps appear.
**Default assumption: R7's fixes have introduced a new precedence bug or a
type-coercion gap.** The "two correctness gates compete" pattern Codex has
called out twice now (R6 ledger vs. classifier, R7 rate-limit vs. idempotency)
is the most likely place to find new regressions.

---

## Original goal

Implement the v2.1 Week-Level Adaptability + Periodization plan at
`/Users/felipedominguez/.claude/plans/can-you-work-on-polymorphic-lamport.md`
(30 slices, 3 phases) on top of the deterministic rule-based coach kernel.

Worktree:
`/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot/.claude/worktrees/cool-keller-56fedc`

`CLAUDE.md` is the bootloader. iOS contracts out of scope.

---

## R7 findings + what was implemented

### R7 P2 — Rate-limited apply still 400s on missing idempotency key

File: `src/api/routes/training-coach-v2.ts`

Before: the R6 P2 rate-limit short-circuit fired BEFORE
`executeWeekReflow`. If a caller sent `mode: "apply"` without
`idempotencyKey` AND the plan was rate-limited, the route returned
**200 synthetic success** instead of the documented **400
IDEMPOTENCY_REQUIRED**. The downstream service-level guard was
unreachable.

Fix:
1. Hoisted idempotency-key normalization + validation directly after
   `mode` parsing, **before** any classifier work or short-circuit.
2. The key is now trimmed first; empty / whitespace-only keys are
   treated as missing (the service guard only rejected
   `length === 0`, so `"   "` would otherwise slip through and
   collide nondeterministically in the ledger's `idempotency_key`
   column).
3. The service-level guard at
   `src/services/training-week-reflow.ts:169-172` is kept as
   defense-in-depth.

Tests added to `__tests__/api/training-coach-v2-routes.test.ts`:
- `R7 P2 — apply on a rate-limited plan still 400s when
  idempotencyKey is missing` — prefills the limiter, sends apply
  without key, asserts 400 + zero new ledger rows.
- `R7 P2 — apply with empty idempotencyKey treated as missing → 400`.
- `R7 P2 — apply with whitespace-only idempotencyKey treated as
  missing → 400`.
- `R7 P2 — preview still works without idempotencyKey (precedence
  preserved)`.
- `R7 P2 — leading/trailing whitespace stripped, valid key still
  accepted` (apply then replay with the trimmed form).

### R7 P2/P3 — Tool + REST reject explicit `external_training_declared: null`

Files:
- `src/api/routes/training.ts` (REST `/complete` validator)
- `src/services/tool-executor.ts` (`log_training_completion` tool)

Before: both `checkBoolean` helpers treated `null` as if the field
had been omitted (`if (v === undefined || v === null) return`).
That meant `external_training_declared: null` silently coerced to
`false` in the persisted row. My own R7 QA prompt promised null
would be rejected — the code didn't deliver.

Fix: only `undefined` (field absent from payload) is treated as
omitted now. Explicit `null` falls through to the type check and
produces a validation error (`400 BAD_INPUT` from REST, `error` shape
from tool).

Tests added:
- REST: `R7 P2/P3 — /complete rejects explicit
  externalTrainingDeclared: null (400)` +
  `R7 P2/P3 — /complete rejects externalTrainingDeclared: "yes"
  (string, 400)` +
  `R7 P2/P3 — /complete still accepts externalTrainingDeclared:
  true / false / absent`.
- Tool: `R7 P2/P3 — rejects explicit external_training_declared:
  null` + `R7 P2/P3 — accepts explicit external_training_declared:
  false` (regression guard so the fix doesn't break the legit
  false case).

---

## Files changed (R7 closeout, this session)

### Modified
```
src/api/routes/training-coach-v2.ts                  (R7 P2: idempotency hoist + key trimming)
src/api/routes/training.ts                           (R7 P2/P3: REST checkBoolean rejects null)
src/services/tool-executor.ts                        (R7 P2/P3: tool checkBoolean rejects null)
__tests__/api/training-coach-v2-routes.test.ts       (5 new R7 P2 tests)
__tests__/api/training-routes.test.ts                (3 new R7 P2/P3 tests)
__tests__/services/tool-executor-log-completion-rollback.test.ts  (2 new R7 P2/P3 tests)
```

### New
```
docs/training/coach-periodization-v2-codex-r8-qa-prompt.md   (this file)
```

---

## Expected behavior — pin these contracts

### Idempotency precedence
- `POST /api/v1/training/week/:weekId/reflow`
  with `mode: "apply"` and:
  - no `idempotencyKey` → **400 `IDEMPOTENCY_REQUIRED`**
  - `idempotencyKey: ""` → **400 `IDEMPOTENCY_REQUIRED`**
  - `idempotencyKey: "   "` → **400 `IDEMPOTENCY_REQUIRED`**
  - `idempotencyKey: "  k  "` → 200, persisted as `"k"`; a second
    call with `idempotencyKey: "k"` → replay.
- Above checks all fire BEFORE any classifier work, plan/policy
  fetch, or rate-limit short-circuit. Zero ledger rows are written
  in any 400 case.
- Preview mode without a key still returns 200.

### Boolean null rejection (both REST + tool)
- `POST /api/v1/training/complete` with
  `externalTrainingDeclared: null` → **400 BAD_INPUT**
  (`"externalTrainingDeclared must be a boolean"` in the message).
- `log_training_completion` tool with
  `external_training_declared: null` → error matching
  `"external_training_declared must be a boolean"`.
- Field omitted entirely (no key present in payload) → both paths
  treat as undefined / skip the field.
- Explicit `true` / `false` still accepted at both paths.

---

## Tests + checks already performed

- `npx tsc --noEmit`: **clean**.
- R7-affected focused suite (8 test files / 200 tests across
  v2 routes, REST routes, classifier, session-status,
  tool-executor, training-plan-adaptations, training-week-reflow):
  all green.
- All 5 new R7 P2 idempotency tests pass.
- All 3 new R7 P2/P3 REST null-rejection tests pass.
- All 2 new R7 P2/P3 tool null-rejection tests pass.

---

## Areas to inspect carefully

The R6 → R7 pattern was: a P2 short-circuit silently bypassed a
documented invariant. Look for the same shape elsewhere this round.

1. **R7 P2 trimming consistency.** I now trim the inbound key but
   the service-level guard at `training-week-reflow.ts:170` checks
   `idempotencyKey.length === 0`. Confirm the inbound value the
   service receives is already-trimmed (we pass `idempotencyKey`
   which is the trimmed form). Are there any other call sites of
   `executeWeekReflow` (not via this route) that might still pass
   whitespace-only keys?
2. **R7 P2 idempotency replay path & trimming.** A user submits
   the key `"  k  "` (gets stored as `"k"`). On retry they send
   `"k"` and get a replay. But what if they retry with `"  k  "`?
   The route trims first, so both lookups search for `"k"`. Verify
   the **stored** column value is the trimmed form (no whitespace
   sneaks into the ledger).
3. **R7 P2/P3 null in nested fields.** I only fixed
   `external_training_declared`. Are there other V2 boolean fields
   that should reject null? Grep `src/api/routes/training.ts` and
   `src/services/tool-executor.ts` for any other `=== true`
   coercion of a payload field; each is a potential gap.
4. **Boolean validator + JSON.parse contract.** JSON `null` and
   JS `undefined` look identical after `JSON.parse(req.body)` for
   *absent* keys (the key just isn't on the object). The
   distinction only matters when the client sends `{"x": null}`
   explicitly. Verify the test suite covers that exact shape — the
   tests above pass `{ externalTrainingDeclared: null }` which is
   the right wire shape.
5. **R7 idempotency precedence vs. ownership/feature-flag gates.**
   The new idempotency check fires AFTER `resolveOwnedWeek` and
   `v2EnabledOrShortCircuit` but BEFORE the rate-limit and
   classifier. Confirm the order matches the security model — a
   foreign-week apply should 404 (ownership), not 400
   (idempotency-missing).
6. **`v2Summary` event payload still reflects null vs. omitted
   correctly.** The hash basis uses the canonical-value
   fingerprint. Since the validator now rejects null, the hash
   never sees null in practice — but verify the helper still
   degrades gracefully if a caller bypasses the route surface and
   calls `computeV2IdempotencyHashHex({ externalTrainingDeclared:
   null })` directly.

---

## Edge cases to verify

- Apply with `idempotencyKey: 0` (number, not string) → currently
  the route parses `typeof body.idempotencyKey === 'string'` only;
  a numeric `0` falls through to undefined → 400. Is that intended?
- Apply with `idempotencyKey: "  "` (only whitespace) → 400 (trimmed
  to empty).
- Apply with `idempotencyKey: "\n\t"` (other whitespace) → 400
  (`.trim()` covers all whitespace).
- Tool `log_training_completion` with `external_training_declared:
  []` → rejected as wrong type (not boolean).
- REST `/complete` with `externalTrainingDeclared: 0` (number) → 400
  (matches Codex's R6 P3 expectation).
- Hot-path latency: hoisting the idempotency check adds two extra
  string operations per request. Confirm no measurable hit.

---

## Known risks / assumptions

- The trim normalization is **not** applied retroactively to keys
  that landed in the ledger pre-R7 (no data migration). If a client
  had previously sent `"  k  "` and is now sending `"k"`, those
  look like different keys to the replay logic. Acceptable: no
  known producer was sending whitespace-padded keys.
- iOS Codable layer never explicitly sends `null` for absent fields
  — that's a Swift JSON encoder choice. So the null-rejection is
  a defense against synthetic/test clients + curl, not normal
  iOS traffic. Tests cover the explicit-null wire shape directly.
- The trimmed-key behavior is now slightly different from the
  service guard, which still accepts an untrimmed `"k "` if a
  non-route caller invokes `executeWeekReflow` directly. No
  current caller does that, but defense-in-depth could be added.

---

## What "complete" means for this review

Your verdict should be one of:

- **GO**: All R7 closeout items hold under adversarial inspection.
  Ready for staging soak.
- **NO-GO** with new findings classified P1/P2/P3, each with a
  `file:line` reference and the contract it breaks.

Focus your adversarial energy on the **idempotency-key trim ↔
ledger storage** interaction (does the stored key match the
lookup key?) and the **boolean-null contract** in any other place
the codebase might still accept null as boolean-false.

Past rounds say: stop at "I see the helper exists" and you'll
miss the next regression. Walk every code path; check what the
stored column actually contains, not what the function returns.
