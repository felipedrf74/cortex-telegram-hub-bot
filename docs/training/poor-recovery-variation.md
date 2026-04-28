# Poor-Recovery Variation

Date: 2026-04-28  
Branch: `feature/training-poor-recovery-variation`  
Rollback branch: `backup/training-poor-recovery-variation-pre-20260428-0726`  
Rollback tag: `backup-training-poor-recovery-variation-pre-20260428-0726`

## Executive Summary

Poor-recovery weeks previously relied on a narrow readiness guardrail: red readiness converted hard sessions into generic recovery titles such as `Recovery Ride` or `Recovery Run`, while orange readiness mostly shortened sessions. That protected fatigue, but it made cycling, hybrid, travel, and constrained weeks feel repetitive.

This pass adds deterministic poor-recovery variation at the engine layer. The coach now classifies the recovery scenario, then rewrites affected sessions into modality-aware low-fatigue variants that preserve the recovery intent without random shuffling.

## Root Cause

The main issue was in `src/services/coach-kernel/guardrails.ts`.

- `enforceReadiness()` replaced red-readiness sessions using one sport-level fallback.
- Cycling used `recovery_ride` for every hard ride.
- Running used `recovery_run` for every hard run.
- Strength used the same `Technique Strength + Mobility` fallback.
- Travel and hybrid overload did not influence the recovery shape.
- The decision trail only said hard work was replaced, but did not explain why a specific recovery option was selected.

## Architecture Change

New module:

- `src/services/coach-kernel/poor-recovery-variation.ts`

The module is pure and deterministic. It does not call AI, does not use randomness, and does not depend on UI behavior.

It adds:

- recovery scenario classification
- modality-aware recovery variant selection
- deterministic variant rotation by week/day/session context
- low-fatigue duration caps
- explicit explanations for recovery adaptations
- travel-aware off-bike fallback when bike access is not credible

## Recovery Scenarios

| Scenario | Trigger Examples | Coaching Response |
| --- | --- | --- |
| `mild_fatigue` | Orange/red readiness without stronger signal | Preserve rhythm, reduce load. |
| `high_soreness` | High soreness or moderate/high pain flags | Lower load and complexity. |
| `low_readiness` | Red readiness or very low score | Replace hard work with restorative variants. |
| `post_intensity_fatigue` | Recent high-fatigue key work with high RPE | Reduce intensity so recovery catches up. |
| `low_adherence_fatigue` | Low trailing compliance or repeated misses | Keep the week achievable and confidence-building. |
| `travel_fatigue` | Travel/hotel/limited equipment signals | Prefer lower setup burden and short recovery options. |
| `hybrid_modality_overload` | Multiple modalities plus high-stress density | Reduce competing fatigue across modalities. |

## Variant Model

Variants preserve recovery intent:

- all adapted sessions are low fatigue
- intensity is recovery
- key-session status is removed
- titles differ by modality and recovery role
- alternatives stay recovery-safe
- strength mobility fallbacks do not keep loaded exercise prescriptions

Examples:

- Cycling: `Recovery Spin - Intensity Removed`, `Cadence Technique Spin`, `Easy Endurance Flush Ride`
- Running: `Recovery Run - Intensity Removed`, `Run-Walk Aerobic Reset`, `Form Drills + Easy Run`
- Strength: `Technique Strength + Mobility`, `Mobility + Core Reset`, `Minimum-Dose Strength`
- Travel cycling without bike trainer: `Off-Bike Mobility + Walk Reset`

## Guardrail Integration

`enforceReadiness()` now calls `adaptSessionForPoorRecovery()` for red readiness and for high-risk orange-readiness work. It still runs inside the existing guardrail pipeline, so downstream capacity reconciliation and schedule cleanup remain unchanged.

The readiness guardrail metadata now includes:

- recovery scenario counts
- example adaptation explanations

## Calendar / Agenda Impact

No new agenda ownership fields were introduced in this slice.

Important behavior:

- The session keeps the same identity unless later lifecycle/identity code changes it.
- The session content changes are visible via title, description, duration, intensity, fatigue cost, tags, and planned load.
- Existing agenda sync should update events when the session payload changes.
- The already-planned session identity + shape-hash hardening remains the stronger long-term calendar protection.

## Files Changed

- `src/services/coach-kernel/poor-recovery-variation.ts`
- `src/services/coach-kernel/guardrails.ts`
- `src/services/coach-kernel/index.ts`
- `__tests__/services/coach-kernel-poor-recovery-variation.test.ts`
- `__tests__/services/coach-kernel-guardrails.test.ts`

## Validation

Focused validation passed:

```bash
npx vitest run '__tests__/services/coach-kernel-poor-recovery-variation.test.ts'
npx vitest run '__tests__/services/coach-kernel-guardrails.test.ts' '__tests__/services/coach-kernel-planner.test.ts' '__tests__/services/coach-kernel-adaptation-engine.test.ts' '__tests__/services/coach-kernel-poor-recovery-variation.test.ts'
npx tsc --noEmit --skipLibCheck --pretty false
```

Note: full `tsc --noEmit` without `--skipLibCheck` still reports existing dependency type-library issues in packages such as Microsoft Graph, Garmin, Playwright, and Resend. The project-level code path passes with lib checking skipped.
