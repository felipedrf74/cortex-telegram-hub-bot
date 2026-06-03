// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Readiness Snapshot Adapter — bridge between the runtime `ReadinessResult`
 * (`services/readiness-scorer.ts`) and the coach-kernel `ReadinessSnapshot`
 * type (`coach-kernel/types.ts`).
 *
 * Why this exists:
 *   The planner (`training-coach-kernel-plan-generator.ts:233`) already
 *   converts a partial readiness payload to a `ReadinessSnapshot` for plan
 *   generation. The adaptation engine (Slice 1.C) needs the SAME mapping in
 *   a different code path (per-session adaptation, not per-plan generation).
 *   Extracting the score→level rule here keeps the two call sites in sync
 *   without forcing the adaptation engine to depend on plan-generator.
 *
 *   This module is pure (no I/O, no DB, no AI). It is unit-testable in
 *   isolation and the rules are explicit:
 *     - high-severity injuries cap the level at orange
 *     - score >= 80 → green
 *     - score >= 60 → yellow
 *     - score >= 40 → orange
 *     - score <  40 → red
 *     - non-finite scores fall back to neutral (yellow + 70)
 *
 *   Sleep-as-floor, no-wearable conservatism, and ACWR sample-size guards
 *   live INSIDE `calculateReadiness` (services/readiness-scorer.ts). This
 *   adapter does not re-derive them.
 */

import type {
  PainFlag,
  ReadinessLevel,
  ReadinessSnapshot,
} from './types';

export interface ReadinessSnapshotInput {
  /** Composite 0-100 from `calculateReadiness`. May be `undefined` when no
   *  wearable is connected — callers should treat that as the neutral case. */
  score?: number;
  confidence?: ReadinessSnapshot['confidence'];
  dataSource?: ReadinessSnapshot['dataSource'];
  isStale?: boolean;
  reasonCode?: string;
  sleepHours?: number;
  hrvStatus?: 'low' | 'normal' | 'high';
  energyReserve?: number;
  reasoning?: string;
  /** Pain flags derived from the user's declared injury constraints. The
   *  adapter does not inspect wearables for pain — that's the user's
   *  manual input. */
  painFlags?: PainFlag[];
  /** True when at least one constraint of `type: 'injury'` carries
   *  `severity: 'high'`. Caps the level at `orange` regardless of score. */
  hasHighSeverityInjury?: boolean;
  /** Optional override for the snapshot's `capturedAt`. Tests pin this so
   *  the snapshot is byte-deterministic. */
  capturedAt?: string;
  /** Optional extra notes — typically the planner's hand-crafted notes
   *  (objective, sessions/week, etc.). Merged below the readiness reason. */
  extraNotes?: Array<string | null | undefined>;
}

const NEUTRAL_SCORE = 70;
const NEUTRAL_LEVEL: ReadinessLevel = 'yellow';

function clampScore(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return NEUTRAL_SCORE;
  return Math.max(0, Math.min(100, Math.round(value)));
}

/**
 * Map a composite readiness score (0-100) onto the planner's discrete level.
 * High-severity injuries cap the level at `orange` regardless of score —
 * the planner treats them as a ceiling.
 */
export function scoreToReadinessLevel(
  score: number,
  hasHighSeverityInjury: boolean,
): ReadinessLevel {
  if (!Number.isFinite(score)) return NEUTRAL_LEVEL;
  if (hasHighSeverityInjury && score >= 40) return 'orange';
  if (score >= 80) return 'green';
  if (score >= 60) return 'yellow';
  if (score >= 40) return 'orange';
  return 'red';
}

/**
 * Build a `ReadinessSnapshot` from the runtime readiness result + the
 * user's declared injury constraints.
 *
 * Returns a neutral yellow snapshot when `score` is missing — that mirrors
 * the no-wearable-connected branch in `calculateReadiness` so the planner
 * sees the same "conservative default" verdict.
 */
export function readinessResultToSnapshot(
  input: ReadinessSnapshotInput,
): ReadinessSnapshot {
  const hasHighInjury = input.hasHighSeverityInjury === true;
  const score = clampScore(input.score);
  const level = scoreToReadinessLevel(score, hasHighInjury);

  const reasoningNote = typeof input.reasoning === 'string' && input.reasoning.trim().length > 0
    ? `Readiness: ${input.reasoning.trim()}`
    : null;
  const notes: string[] = [
    hasHighInjury ? 'Injury-aware progression enabled.' : null,
    reasoningNote,
    ...(input.extraNotes ?? []),
  ]
    .filter((note): note is string => typeof note === 'string')
    .map((note) => note.trim())
    .filter((note) => note.length > 0);

  return {
    capturedAt: input.capturedAt ?? new Date().toISOString(),
    level,
    score,
    confidence: input.confidence ?? (input.score == null ? 'no_data' : 'fresh_wearable'),
    dataSource: input.dataSource ?? (input.score == null ? 'fallback' : 'wearable'),
    isStale: input.isStale === true,
    reasonCode: input.reasonCode,
    sleepHours: input.sleepHours,
    hrvStatus: input.hrvStatus,
    energyReserve: input.energyReserve,
    painFlags: input.painFlags ?? [],
    notes: notes.length > 0 ? notes : undefined,
  };
}
