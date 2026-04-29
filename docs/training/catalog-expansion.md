# Training Catalog Expansion

## Summary

This pass expands the Coach kernel catalog without turning it into a pile of random templates. The work adds structured metadata, new gym exercises, richer running/cycling archetypes, and selector logic that actually uses the new variants for limited equipment, novice running, hybrid support, travel weeks, and constrained recovery-style support sessions.

## What Changed

| Area | Change | Why It Matters |
| --- | --- | --- |
| Gym catalog | Added bodyweight, machine, cable, dumbbell, anti-rotation, and limited-equipment movements. | Strength plans can now choose stable machine/free-weight/bodyweight equivalents instead of repeatedly falling back to the same small exercise set. |
| Running catalog | Added run-walk, controlled fartlek, hybrid flush, and travel treadmill variants. | Novice, hybrid, and travel users get sessions that match their context instead of generic easy/threshold repeats. |
| Cycling catalog | Added short endurance, hybrid flush, hotel spin, and low-cadence strength-endurance variants. | Cycling plans now have more low-fatigue, constrained-week, and cycling-specific support options. |
| Template metadata | Added session role, experience fit, equipment profile, variant tags, recovery tags, time range, progression target, and substitution family fields. | Selection logic and future evaluation can reason about why a template exists. |
| Selection logic | Strength uses limited-equipment variants when the athlete lacks gym access or has travel/hotel constraints. Running/cycling support sessions choose novice, hybrid, travel, and low-recovery variants when appropriate. | The catalog is not dead data; it changes generated plans in real scenarios. |

## Files Changed

| File | Purpose |
| --- | --- |
| `src/services/coach-kernel/types.ts` | Adds optional template metadata fields while preserving backward compatibility. |
| `src/services/coach-kernel/knowledge/entities/exercises.json` | Expands exercise catalog and fills missing metadata on existing movements. |
| `src/services/coach-kernel/knowledge/templates/run-workouts.yaml` | Expands running archetypes and adds template metadata. |
| `src/services/coach-kernel/knowledge/templates/bike-workouts.yaml` | Expands cycling archetypes and adds template metadata. |
| `src/services/coach-kernel/knowledge/templates/strength-blocks.yaml` | Adds strength template metadata and limited-equipment-friendly defaults. |
| `src/services/coach-kernel/engines/strength-engine.ts` | Adds gym machine equipment tags and limited-equipment variant selection. |
| `src/services/coach-kernel/engines/running-engine.ts` | Uses novice, hybrid, travel, and low-recovery support run variants. |
| `src/services/coach-kernel/engines/cycling-engine.ts` | Uses travel, hybrid, low-recovery, and constrained support ride variants. |
| `__tests__/services/coach-kernel-catalog-depth.test.ts` | Adds schema, selection, substitution, and modality-specific regression coverage. |

## Validation

Focused validation passed:

```bash
npm test -- --run __tests__/services/coach-kernel-catalog-depth.test.ts
npm test -- --run __tests__/services/coach-kernel-catalog-depth.test.ts __tests__/services/coach-kernel-strength-engine.test.ts __tests__/services/coach-kernel-planner.test.ts __tests__/services/coach-kernel-poor-recovery-variation.test.ts
```

The raw catalog now contains:

- `43` exercise entries
- `12` running templates
- `10` cycling templates
- `3` strength templates

All exercises have complexity, spinal-loading, unilateral, primary-purpose, warm-up needs, and valid substitution references.
