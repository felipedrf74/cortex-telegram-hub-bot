// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Plan generation context — slice A3 of the Week-Level Adaptability
 * + Periodization plan (v2.1).
 *
 * Replayable per-plan context. The v2.1 critique correctly noted that
 * `AthleteProfile` is the athlete's stable identity (anchors, age,
 * primary discipline) and should not carry time-varying state like
 * readiness or health. A3 separates the two:
 *
 *   - `AthleteProfile` — immutable identity (unchanged from prior slices).
 *   - `ReadinessSnapshot` + `HealthSignal` — events, captured at a
 *     moment, sourced from athlete_readiness_events +
 *     athlete_health_signals (A0c).
 *   - `PlanGenerationContext` — the per-plan envelope carrying both
 *     stable identity (via `AthleteProfile` upstream) AND the
 *     replayable time-varying state.
 *
 * Replayability: engines never mutate the context. Each per-week
 * computation returns a `WeekContextDelta`; the generator commits
 * the delta via `commitWeek(ctx, delta)` after validation. This is
 * the architectural cleanup that unblocks B1 (load model), B5
 * (deload), B6 (strength progression), and Phase C.
 *
 * The existing engine code (running-engine, cycling-engine,
 * strength-engine) continues to work without changes — they don't
 * read the context yet. Slices that depend on A3 (B1+) will
 * gradually wire the context through. Until then, the context is
 * built and threaded but not yet consulted by template selection.
 */

import type {
  PlanGenerationContext,
  VersionStamp,
  WeekConditions,
  WeekContextDelta,
} from './types';

/**
 * Build an initial PlanGenerationContext for a new plan generation.
 * Subsequent per-week computations call `commitWeek(ctx, delta)` to
 * append derived state.
 *
 * Inputs are optional — a cold-start athlete with no prior load
 * data produces a context with `loadModel.loadModelStatus =
 * 'cold_start'` (slice B1 populates this; A3 just establishes the
 * shape).
 */
export interface BuildContextInput {
  sciencePolicyVersion: string;
  schemaVersion?: number;
  generatedAt?: string;
}

export function buildPlanGenerationContext(
  input: BuildContextInput,
): PlanGenerationContext {
  const versionStamp: VersionStamp = {
    sciencePolicyVersion: input.sciencePolicyVersion,
    schemaVersion: input.schemaVersion ?? 1,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
  };
  return {
    versionStamp,
    weekConditions: [],
  };
}

/**
 * Validate that a WeekContextDelta is well-formed before committing.
 * Throws when invariants are violated:
 *   - weekIndex must be a non-negative integer
 *   - weekConditions.weekIndex (if present) must equal delta.weekIndex
 */
export function validateWeekContextDelta(delta: WeekContextDelta): void {
  if (!Number.isInteger(delta.weekIndex) || delta.weekIndex < 0) {
    throw new Error(`commitWeek: weekIndex must be a non-negative integer, got ${delta.weekIndex}`);
  }
  if (delta.weekConditions && delta.weekConditions.weekIndex !== delta.weekIndex) {
    throw new Error(
      `commitWeek: weekConditions.weekIndex (${delta.weekConditions.weekIndex}) ` +
      `does not match delta.weekIndex (${delta.weekIndex})`,
    );
  }
}

/**
 * Commit a WeekContextDelta to the context, producing a NEW
 * context (immutability preserved — engines never mutate their
 * input). Returns the updated context.
 *
 * Semantics:
 *   - `loadModel` is replaced wholesale (the delta carries the
 *     latest CTL/ATL after this week).
 *   - `mesocyclePosition` is replaced wholesale.
 *   - `weeksSinceDeload` is replaced wholesale.
 *   - `weekConditions[]` is APPENDED to (one entry per week).
 *
 * The caller must validate the delta first (or pass `{ validate: true }`).
 */
export function commitWeek(
  ctx: PlanGenerationContext,
  delta: WeekContextDelta,
  opts: { validate?: boolean } = {},
): PlanGenerationContext {
  if (opts.validate !== false) validateWeekContextDelta(delta);
  const nextConditions = delta.weekConditions
    ? [...ctx.weekConditions, delta.weekConditions]
    : ctx.weekConditions;
  return {
    versionStamp: ctx.versionStamp,
    loadModel: delta.loadModel ?? ctx.loadModel,
    mesocyclePosition: delta.mesocyclePosition ?? ctx.mesocyclePosition,
    weeksSinceDeload: delta.weeksSinceDeload ?? ctx.weeksSinceDeload,
    weekConditions: nextConditions,
    rollingHrv: ctx.rollingHrv,
    rollingAdherence: ctx.rollingAdherence,
    readinessSnapshot: ctx.readinessSnapshot,
    healthSignal: ctx.healthSignal,
  };
}

/**
 * Look up week conditions by index. Returns undefined when not yet
 * committed (the engine should compute and commit them).
 */
export function getWeekConditions(
  ctx: PlanGenerationContext,
  weekIndex: number,
): WeekConditions | undefined {
  return ctx.weekConditions.find((wc) => wc.weekIndex === weekIndex);
}

/**
 * Set the readiness snapshot on the context. Returns a NEW context;
 * the original is unchanged. Used at week boundaries when a fresh
 * snapshot arrives from A0c.
 */
export function withReadinessSnapshot(
  ctx: PlanGenerationContext,
  snapshot: PlanGenerationContext['readinessSnapshot'],
): PlanGenerationContext {
  return { ...ctx, readinessSnapshot: snapshot };
}

/**
 * Set the health signal on the context. Same immutability contract.
 */
export function withHealthSignal(
  ctx: PlanGenerationContext,
  signal: PlanGenerationContext['healthSignal'],
): PlanGenerationContext {
  return { ...ctx, healthSignal: signal };
}

/**
 * Set the rolling HRV state on the context.
 */
export function withRollingHrv(
  ctx: PlanGenerationContext,
  rolling: PlanGenerationContext['rollingHrv'],
): PlanGenerationContext {
  return { ...ctx, rollingHrv: rolling };
}

/**
 * Set the rolling adherence state on the context.
 */
export function withRollingAdherence(
  ctx: PlanGenerationContext,
  rolling: PlanGenerationContext['rollingAdherence'],
): PlanGenerationContext {
  return { ...ctx, rollingAdherence: rolling };
}
