# Training Catalog Test Matrix

## Automated Tests Added

| Test File | Coverage |
| --- | --- |
| `__tests__/services/coach-kernel-catalog-depth.test.ts` | New catalog archetypes load, hypertrophy plan variety, running key rotation, cycling key rotation, gym+cycling hybrid routing. |
| `__tests__/services/coach-kernel-strength-engine-target-exercise-count.test.ts` | Tight-window strength sessions preserve requested calendar duration while compacting exercise count and prescription density. |

## Regression Coverage

| Risk | Test Coverage |
| --- | --- |
| Stale or missing new knowledge templates | Asserts new template IDs and exercise IDs load through `loadCoachKnowledge`. |
| Hypertrophy users throw `Missing strength template` or get repeated days | Builds the intermediate hypertrophy persona and requires 4 unique strength session titles. |
| Strength sessions only look full-body/generic | Requires upper and lower role tags in the same week. |
| Running quality days flatten to one repeated interval/threshold template | Asserts deterministic build-week rotation: Interval, Tempo Progression, Hill Repeats. |
| Cycling quality days flatten to threshold-only | Asserts deterministic build-week rotation: Threshold, Tempo/Sweet Spot, VO2 Over-Under. |
| Hybrid gym+cycling users receive running sessions | Builds the gym+cycling persona and asserts cycling + strength are present and running is absent. |
| Express strength windows get inflated by the coherence gate | Asserts 20-minute and 25-minute windows keep truthful durations with duration-appropriate exercise counts. |
| Catalog entries lack planning metadata | Asserts all exercises have complexity/spinal loading/unilateral/purpose/warm-up metadata and all running/cycling/strength templates carry role metadata. |
| Substitution graph silently points to missing exercises | Walks every substitution reference and verifies the target exercise exists. |
| Limited-equipment strength falls back to barbell/machine-first plans | Builds the equipment-limited persona and requires limited-equipment tags while rejecting barbell/machine-only IDs. |
| Novice running gets advanced quality sessions by default | Builds a novice running profile and asserts run-walk plus controlled fartlek support appear. |
| Hybrid cycling support remains generic recovery only | Builds gym+cycling hybrid and asserts the hybrid flush ride is selected. |
| Travel week ignores travel-specific support variants | Builds the travel hotel-gym persona and asserts travel run plus limited-equipment strength variants are selected. |

## Validation Commands

```bash
npm run typecheck
npx vitest run __tests__/services/coach-kernel-catalog-depth.test.ts
npx vitest run __tests__/services/coach-kernel-catalog-depth.test.ts __tests__/services/coach-kernel-strength-engine.test.ts __tests__/services/coach-kernel-planner.test.ts __tests__/services/coach-kernel-poor-recovery-variation.test.ts
npx vitest run __tests__/services/coach-kernel-evaluation.test.ts __tests__/services/coach-kernel-catalog-depth.test.ts __tests__/services/coach-kernel-planner.test.ts __tests__/services/coach-kernel-strength-engine.test.ts __tests__/services/coach-kernel-strength-engine-target-exercise-count.test.ts __tests__/services/coach-kernel-session-coherence.test.ts __tests__/services/coach-kernel-biomechanics-and-ordering.test.ts __tests__/services/coach-kernel-exercise-metadata.test.ts __tests__/services/training-plan-lifecycle.test.ts
npm run eval:training -- --week-start 2026-04-27 --json /tmp/nexus-training-catalog-eval.json --markdown /tmp/nexus-training-catalog-eval.md --fail-under 0
npm test
```

## Benchmark Result

The regenerated benchmark in `docs/training/eval-baseline-results.md` scores:

- Overall: `97/100`
- Cases: `156`
- Persona bank: `13`
- Scenario bank: `12`
- Full regression: `371` test files / `5,892` tests passing

The previous false `strength_hypertrophy` missing-template failures were caused by stale `dist/` knowledge copying, not source catalog absence. The build script now clears the dist knowledge directory before copying.

## Priority 10 Result

The catalog-expansion focused suite passed locally:

- `__tests__/services/coach-kernel-catalog-depth.test.ts`: `9` tests passing
- Broader focused suite with catalog, strength engine, planner, and poor-recovery variation: `37` tests passing
- Coach-kernel regression sweep with catalog, evaluation, planner, strength engine, guardrails, poor recovery, biomechanics, session coherence, target exercise count, and exercise metadata: `148` tests passing
- `npm run typecheck`: passing

Raw source catalog after this pass:

- Exercises: `43`
- Running templates: `12`
- Cycling templates: `10`
- Strength templates: `3`
