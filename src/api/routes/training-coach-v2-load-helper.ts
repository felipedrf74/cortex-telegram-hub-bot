// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * R5 P1 fix — shared load-model + deload computation.
 *
 * Codex caught (R5 P1 #3) that the reflow route built
 * `weekConditions` with `deloadDue: undefined`, while coach-analysis
 * computed `deload.triggered` from the real load model and passed it
 * in. The result: the classifier's deload modifier could fire in the
 * analysis read path but NEVER in the apply (mutating) path. Two
 * surfaces, one contract — analysis told the user "we should deload"
 * but the apply silently dropped the modifier.
 *
 * The fix extracts the load-model hydration + dimension pick +
 * deload recommendation into a single helper so the two routes are
 * guaranteed to compute identical inputs. Adding a new dimension or
 * tweaking the primary-pick heuristic is now a single-file change.
 *
 * Pure (modulo the DB read). Side-effect-free. The caller chooses
 * what to do with the result (surface it on the response, pass
 * `deload.triggered` into `weekConditions`, etc.).
 */

import type Database from 'better-sqlite3';
import {
  estimateSessionLoad,
  type LoadValue,
} from '../../services/coach-kernel/load-input';
import {
  computeLoadModelForDimension,
  type DailyLoad,
  type LoadDimension,
  type LoadModelDimensionResult,
} from '../../services/coach-kernel/load-model';
import { recommendDeload, type DeloadRecommendation } from '../../services/coach-kernel/deload-recommendation';
import type { Principles } from '../../services/coach-kernel/training-principles';
import { inferSportFromSessionType } from './training-coach-v2-hydration';

export interface ComputeLoadModelInput {
  db: Database.Database;
  userId: number;
  /**
   * Tenant scope. Completions are read only from plans owned by this
   * tenant — `user_id` alone is not unique across tenants.
   */
  tenantId: number;
  /** plan.sport string from `fitness_training_plans.sport`. */
  planSport: string;
  /** week index (0-based) the deload decision will be made for. */
  weeksSinceDeload: number;
  /** Mesocycle-length in weeks. Drives the scheduled deload cadence. */
  scheduledDeloadCadenceWeeks: number;
  /** Loaded principles JSON (A1b). */
  principles: Principles;
}

export interface ComputeLoadModelOutput {
  loadModelByDimension: Record<LoadDimension, LoadModelDimensionResult>;
  primaryDim: LoadDimension;
  loadModel: LoadModelDimensionResult;
  deload: DeloadRecommendation;
}

export interface HydrateLoadModelInput {
  db: Database.Database;
  userId: number;
  /**
   * Tenant scope. Completions are read only from plans owned by this
   * tenant — `user_id` alone is not unique across tenants.
   */
  tenantId: number;
  /** plan.sport string from `fitness_training_plans.sport`. */
  planSport: string;
}

export interface HydrateLoadModelOutput {
  loadModelByDimension: Record<LoadDimension, LoadModelDimensionResult>;
  primaryDim: LoadDimension;
}

/**
 * Training redesign Phase 0 (item 6) — the hydration half of
 * `computeLoadModelAndDeload`: read the last 60 days of completions,
 * build the per-dimension load model, and pick the primary dimension.
 * Extracted so GET /training/load-snapshot can serve the load model
 * without a deload decision (which needs week/mesocycle context the
 * read-only snapshot doesn't have). `computeLoadModelAndDeload`
 * delegates here, so all three surfaces stay byte-identical.
 */
export function hydrateLoadModelByDimension(
  input: HydrateLoadModelInput,
): HydrateLoadModelOutput {
  const { db, userId, tenantId, planSport } = input;

  // R5 P2 fix (#108) — pull strength tonnage columns alongside the
  // generic load columns so the strength dimension can use the real
  // V2 set/reps/load JSON instead of a duration*RPE proxy.
  const completionsRows = db.prepare(`
    SELECT
      tc.completed_at, tc.duration_minutes, tc.completed_duration_sec,
      tc.completed_distance_meters, tc.rpe_overall AS session_rpe, tc.rir,
      tc.actual_exercises_json, tc.notes,
      tc.completed_sets_json, tc.completed_reps_json, tc.completed_load_json,
      s.sport AS plan_sport, ts.session_type
    FROM training_completions tc
    JOIN training_sessions ts ON ts.id = tc.session_id
    JOIN fitness_training_plans s ON s.id = tc.plan_id
    WHERE s.user_id = ? AND s.tenant_id = ? AND tc.completed_at >= datetime('now', '-60 days')
    ORDER BY tc.completed_at ASC
  `).all(userId, tenantId) as Array<{
    completed_at: string;
    duration_minutes: number | null;
    completed_duration_sec: number | null;
    completed_distance_meters: number | null;
    session_rpe: number | null;
    rir: number | null;
    actual_exercises_json: string | null;
    notes: string | null;
    completed_sets_json: string | null;
    completed_reps_json: string | null;
    completed_load_json: string | null;
    plan_sport: string;
    session_type: string;
  }>;

  const dayBucketsPerDim = new Map<LoadDimension, Map<string, { value: number; confidence: 'high' | 'medium' | 'low' }>>();
  const seedDim = (d: LoadDimension): Map<string, { value: number; confidence: 'high' | 'medium' | 'low' }> => {
    let m = dayBucketsPerDim.get(d);
    if (!m) { m = new Map(); dayBucketsPerDim.set(d, m); }
    return m;
  };

  for (const c of completionsRows) {
    const sport = inferSportFromSessionType(c.session_type, c.plan_sport);
    // R5 P2 #108 — real tonnage from V2 JSON when available.
    const strengthTonnageKg =
      sport === 'strength'
        ? (computeStrengthTonnageKg(c.completed_sets_json, c.completed_reps_json, c.completed_load_json) ??
           // Proxy fallback when V2 JSON is absent — minutes × RPE × 20kg.
           ((typeof c.session_rpe === 'number' && typeof c.duration_minutes === 'number')
             ? c.duration_minutes * c.session_rpe * 20
             : undefined))
        : undefined;
    const estimate = estimateSessionLoad({
      sport,
      completion: {
        sessionRpe: c.session_rpe ?? undefined,
        rir: c.rir ?? undefined,
        durationSec: c.completed_duration_sec ?? (c.duration_minutes ? c.duration_minutes * 60 : undefined),
        distanceMeters: c.completed_distance_meters ?? undefined,
        strengthTonnageKg,
      },
    });
    const dayKey = c.completed_at.slice(0, 10);
    const merge = (dim: LoadDimension, value: LoadValue | undefined): void => {
      if (!value) return;
      const m = seedDim(dim);
      const existing = m.get(dayKey) ?? { value: 0, confidence: 'high' as const };
      const newConfidence: 'high' | 'medium' | 'low' =
        existing.confidence === 'low' || value.confidence === 'low' ? 'low' :
        existing.confidence === 'medium' || value.confidence === 'medium' ? 'medium' : 'high';
      m.set(dayKey, { value: existing.value + value.score, confidence: newConfidence });
    };
    merge('external', estimate.completedExternalLoad);
    merge('internal', estimate.completedInternalLoad);
    merge('strength', estimate.strengthLoad);
    merge('impact', estimate.impactLoad);
  }

  const dayMs = 24 * 3600 * 1000;
  const endMs = Date.now();
  const startMs = endMs - 59 * dayMs;
  const buildDaily = (m: Map<string, { value: number; confidence: 'high' | 'medium' | 'low' }> | undefined): DailyLoad[] => {
    const daily: DailyLoad[] = [];
    for (let t = startMs; t <= endMs; t += dayMs) {
      const k = new Date(t).toISOString().slice(0, 10);
      const b = m?.get(k);
      daily.push({ date: k, value: b?.value ?? 0, confidence: b?.confidence ?? 'high' });
    }
    return daily;
  };
  const dimensions: LoadDimension[] = ['external', 'internal', 'strength', 'impact'];
  const loadModelByDimension: Record<LoadDimension, LoadModelDimensionResult> = {
    external: undefined as unknown as LoadModelDimensionResult,
    internal: undefined as unknown as LoadModelDimensionResult,
    strength: undefined as unknown as LoadModelDimensionResult,
    impact: undefined as unknown as LoadModelDimensionResult,
  };
  for (const dim of dimensions) {
    loadModelByDimension[dim] = computeLoadModelForDimension({
      daily: buildDaily(dayBucketsPerDim.get(dim)),
      dimension: dim,
    });
  }

  const planSportLc = (planSport ?? '').toLowerCase();
  // R5 P1 #2 — plan sport 'gym' canonicalizes to 'strength' for
  // primary-dim selection too. Without this the gym plan would
  // pick 'external' as primary and the deload signal would track
  // running/cycling instead of strength tonnage.
  const isStrengthPlan =
    planSportLc === 'strength' || planSportLc === 'gym' ||
    planSportLc === 'weights' || planSportLc === 'lifting';
  const primaryDim: LoadDimension =
    isStrengthPlan ? 'strength' :
    loadModelByDimension.external.loadModelStatus === 'cold_start' &&
    loadModelByDimension.internal.loadModelStatus !== 'cold_start'
      ? 'internal'
      : 'external';

  return { loadModelByDimension, primaryDim };
}

/**
 * Hydrate the multi-dimensional load model for the user from the
 * last 60 days of completions AND run the deload recommender. Single
 * source of truth used by both coach-analysis (read path) and
 * /week/:weekId/reflow (mutating path).
 */
export function computeLoadModelAndDeload(
  input: ComputeLoadModelInput,
): ComputeLoadModelOutput {
  const { db, userId, tenantId, planSport, weeksSinceDeload, scheduledDeloadCadenceWeeks, principles } = input;

  const { loadModelByDimension, primaryDim } = hydrateLoadModelByDimension({
    db,
    userId,
    tenantId,
    planSport,
  });
  const loadModel = loadModelByDimension[primaryDim];

  const deload = recommendDeload(
    {
      loadModelStatus: loadModel.loadModelStatus,
      acwr: loadModel.acwrUncoupled,
      weeksSinceDeload,
      scheduledDeloadCadenceWeeks,
    },
    principles,
  );

  return { loadModelByDimension, primaryDim, loadModel, deload };
}

/**
 * R5 P2 #108 — parse V2 completion JSON columns and compute real
 * strength tonnage (kg). Returns undefined when the JSON is absent
 * OR malformed so the caller can fall back to the duration*RPE proxy.
 *
 * Accepted shapes (any of):
 *   - completedLoadJson: number[] (per-set load in kg), reps from completedRepsJson: number[]
 *   - completedSetsJson: [{ reps: N, load: K }, ...]
 *
 * Sum of reps × load across every set = total tonnage in kg.
 * Exported for unit tests.
 */
export function computeStrengthTonnageKg(
  setsJson: string | null,
  repsJson: string | null,
  loadJson: string | null,
): number | undefined {
  // Shape A: `completedSetsJson` carries the canonical per-set object array.
  if (typeof setsJson === 'string' && setsJson.length > 0) {
    try {
      const parsed = JSON.parse(setsJson);
      if (Array.isArray(parsed)) {
        let total = 0;
        let saw = false;
        for (const s of parsed) {
          if (!s || typeof s !== 'object') continue;
          const reps = (s as { reps?: unknown }).reps;
          const load = (s as { load?: unknown }).load;
          if (typeof reps === 'number' && Number.isFinite(reps) && reps > 0 &&
              typeof load === 'number' && Number.isFinite(load) && load >= 0) {
            total += reps * load;
            saw = true;
          }
        }
        if (saw) return total;
      }
    } catch { /* fall through to shape B */ }
  }
  // Shape B: parallel reps[] + load[] arrays.
  if (typeof repsJson === 'string' && typeof loadJson === 'string' &&
      repsJson.length > 0 && loadJson.length > 0) {
    try {
      const reps = JSON.parse(repsJson);
      const load = JSON.parse(loadJson);
      if (Array.isArray(reps) && Array.isArray(load) && reps.length === load.length) {
        let total = 0;
        let saw = false;
        for (let i = 0; i < reps.length; i++) {
          const r = reps[i];
          const l = load[i];
          if (typeof r === 'number' && Number.isFinite(r) && r > 0 &&
              typeof l === 'number' && Number.isFinite(l) && l >= 0) {
            total += r * l;
            saw = true;
          }
        }
        if (saw) return total;
      }
    } catch { /* fall through */ }
  }
  return undefined;
}
