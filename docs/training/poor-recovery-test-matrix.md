# Poor-Recovery Test Matrix

Date: 2026-04-28

## Automated Coverage

| Test | File | Coverage | Status |
| --- | --- | --- | --- |
| Cycling poor-recovery variation | `__tests__/services/coach-kernel-poor-recovery-variation.test.ts` | Verifies cycling sessions do not collapse into one title, stay recovery intensity, low fatigue, and include technique variation. | Passing |
| Hybrid poor-recovery modality awareness | `__tests__/services/coach-kernel-poor-recovery-variation.test.ts` | Verifies running and strength remain represented and use multiple low-fatigue recovery shapes. | Passing |
| Strength safe fallback variety | `__tests__/services/coach-kernel-poor-recovery-variation.test.ts` | Verifies strength uses more than one fallback shape, caps duration, and strips loaded exercises from mobility fallbacks. | Passing |
| Travel low-burden recovery | `__tests__/services/coach-kernel-poor-recovery-variation.test.ts` | Verifies hotel/travel + no bike trainer can become off-bike mobility/walk instead of pretending to ride normally. | Passing |
| Repeated poor-recovery week rotation | `__tests__/services/coach-kernel-poor-recovery-variation.test.ts` | Verifies consecutive poor-recovery cycling weeks rotate deterministic variants rather than repeating identical outputs. | Passing |
| Warning / decision trail dedupe | `__tests__/services/coach-kernel-poor-recovery-variation.test.ts` | Verifies notes are deduped and only one readiness guardrail is emitted. | Passing |
| Existing readiness sport specificity | `__tests__/services/coach-kernel-guardrails.test.ts` | Verifies cycling and swimming do not accidentally become running recovery sessions. | Passing |
| Existing planner fatigue path | `__tests__/services/coach-kernel-planner.test.ts` | Verifies `adjustForFatigue()` still downshifts red/orange phases and remains no-op for green/yellow. | Passing |
| Existing read-model adaptation path | `__tests__/services/coach-kernel-adaptation-engine.test.ts` | Verifies the API read-model adaptation helper remains compatible. | Passing |

## Commands Run

```bash
npx vitest run '__tests__/services/coach-kernel-poor-recovery-variation.test.ts'
```

Result:

- 1 file passed
- 6 tests passed

```bash
npx vitest run '__tests__/services/coach-kernel-guardrails.test.ts' '__tests__/services/coach-kernel-planner.test.ts' '__tests__/services/coach-kernel-adaptation-engine.test.ts' '__tests__/services/coach-kernel-poor-recovery-variation.test.ts'
```

Result:

- 4 files passed
- 41 tests passed

```bash
npx tsc --noEmit --skipLibCheck --pretty false
```

Result:

- Passed

## Scenario Coverage Against Request

| Requested Scenario | Covered? | Evidence |
| --- | --- | --- |
| Poor recovery gym week | Yes | Strength fallback variety test. |
| Poor recovery running week | Partially | Hybrid + marathon dedupe tests cover running adaptation; a running-only explicit test is still recommended. |
| Poor recovery cycling week | Yes | Cycling variation and repeated-week rotation tests. |
| Poor recovery hybrid week | Yes | Hybrid modality-aware test. |
| Poor recovery travel week | Yes | Travel/no-bike low-burden recovery test. |
| Repeated poor-recovery weeks are not identical | Yes | Week 8 vs week 9 cycling test. |
| Low recovery reduces intensity/volume | Yes | Tests assert recovery intensity, low fatigue, and duration caps. |
| Recovery variants remain low-fatigue | Yes | Cycling, hybrid, strength, and travel tests. |
| Decision trail explains adaptation | Yes | Readiness metadata and guardrail message are asserted. |
| No duplicate warnings | Yes | Dedupe test asserts one readiness guardrail and unique notes. |

## Recommended Additional Tests

| Priority | Test | Why |
| --- | --- | --- |
| Medium | Running-only red-readiness week | Hybrid/marathon coverage exists, but a dedicated running-only persona would make the running path clearer. |
| Medium | Orange-readiness cycling week | Current tests focus on red poor recovery; orange should remain conservative without over-softening. |
| Medium | Poor recovery + constrained-week capacity together | This should run after the capacity reconciler branch is finalized, because both layers interact. |
| Low | Swimming recovery variety | Not requested for this slice, but triathlon users would benefit from a second swim recovery shape later. |
