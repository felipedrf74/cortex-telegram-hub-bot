# Training Coach Evaluation Harness Specification

## Purpose

The Training coach evaluation harness gives Nexus Hub a repeatable way to measure coach quality without snapshotting exact workouts. The harness scores generated plans against scenario-based rubrics so future branches can prove they improved coaching behavior instead of only changing strings, templates, or one known fixture.

The harness lives in code under `src/services/coach-kernel/evaluation/` and is executable through:

```bash
npm run eval:training
```

For deterministic release comparisons, run:

```bash
npm run build
node dist/tools/training-eval-harness.js \
  --week-start 2026-04-27 \
  --json docs/training/eval-baseline-results.json \
  --markdown docs/training/eval-baseline-results.md
```

## Design Principles

- Scenario-based scoring over brittle snapshots.
- Persona coverage over founder-specific overfitting.
- Weighted rubric dimensions that reflect real coaching quality.
- Machine-readable JSON plus human-readable Markdown output.
- Branch-to-branch comparability using the same persona bank, scenario bank, week start, and scoring weights.
- Fail-under support for CI or local gates, without forcing today's baseline to be perfect.

## Code Structure

| File | Role |
| --- | --- |
| `src/services/coach-kernel/evaluation/types.ts` | Shared typed contract for personas, scenarios, scores, and run output. |
| `src/services/coach-kernel/evaluation/personas.ts` | Canonical persona bank. |
| `src/services/coach-kernel/evaluation/scenarios.ts` | Scenario transforms and expectations. |
| `src/services/coach-kernel/evaluation/rubric.ts` | Scoring dimensions, weights, and rubric checks. |
| `src/services/coach-kernel/evaluation/runner.ts` | Matrix builder, plan execution, aggregation, and Markdown rendering. |
| `src/tools/training-eval-harness.ts` | CLI entry point for local runs and CI-style reports. |
| `__tests__/services/coach-kernel-evaluation.test.ts` | Harness structure and regression tests. |

## Evaluation Flow

1. Load canonical personas.
2. Load canonical scenarios.
3. Build the persona x scenario matrix.
4. Apply each scenario transform to the persona's `AthleteState`.
5. Generate a plan with `buildWeekPlan`.
6. For lifecycle scenarios, generate a next-version comparison plan.
7. Score the plan across all rubric dimensions.
8. Aggregate weighted case scores and dimension averages.
9. Emit JSON and Markdown reports.

## Scoring Output

The JSON output includes:

- `generatedAt`
- `weekStart`
- `engine.packageVersion`
- `engine.gitBranch`
- `engine.gitCommit`
- `aggregate.overallScore`
- `aggregate.dimensionAverages`
- `aggregate.lowestCases`
- per-case plan summaries
- per-case dimension scores with observations and penalties

The Markdown output is optimized for quick review:

- aggregate score
- dimension averages
- lowest scoring cases
- full case matrix

## Using Fail-Under Gates

The CLI accepts `--fail-under N`. This is intended for future CI once the team agrees on a stable threshold. Example:

```bash
npm run eval:training -- --fail-under 78
```

Use the threshold carefully. The current harness is meant to expose weaknesses honestly. A low baseline is useful if it tells us where the coach still needs work.

## Updating The Benchmark

When the Training engine gains a real new capability:

1. Add or adjust scenarios only if they represent product-relevant behavior.
2. Add or adjust persona expectations only if the persona story changes.
3. Prefer new rubric dimensions only for durable coaching concerns.
4. Regenerate `docs/training/eval-baseline-results.md` and `.json`.
5. Explain meaningful score changes in the implementation report.

## Non-Goals

- It does not replace unit tests for exact algorithms.
- It does not guarantee medical safety.
- It does not rate subjective workout enjoyment.
- It does not snapshot specific exercise names as a correctness requirement.
- It does not deploy or mutate production data.

