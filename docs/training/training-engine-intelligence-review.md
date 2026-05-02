# Training engine intelligence review

## Strength

The prior backend tip expanded equipment and experience vocabulary, but explicit high-volume strength intent still degraded in downstream layers. This pass fixes the route cap, volume enforcement, marathon strength engine maintenance logic, and deterministic fallback so an advanced user can request five strength sessions and receive distinct sessions where feasible.

Evidence:
- `src/api/routes/training-plan-generation.ts` now clamps strength to 6 instead of 4.
- `src/services/training-plan-volume-enforcement.ts` now keeps running and explicit strength volume additive for running plans.
- `src/services/coach-kernel/engines/strength-engine.ts` now allows a high-frequency marathon strength block outside peak/taper/race-close windows.

## Running and marathon

The marathon weekly target floor from the previous work remains in place. This pass adds a missing-data guard: marathon plans without a race date now produce a critical `race_date` follow-up so progression and taper confidence is not overstated.

## Cycling and hybrid

No new cycling code was changed. Existing cycling/hybrid coverage remains mostly archetype- and test-driven, with open follow-up for deeper cycling-specific periodization and poor-recovery variation.

## Gray areas

- The engine now supports high strength volume, but feasibility still depends on Secretary capacity and downstream scheduling.
- Provider calendar lifecycle needs staging/provider evidence before production promotion.
- Full physical-device Training UX validation is still needed.
