// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Multi-source load model — slice B1 of the Week-Level Adaptability +
 * Periodization plan (v2.1).
 *
 * Aggregates per-session `SessionLoadEstimate`s (from B0) into a
 * rolling load model with CTL/ATL/TSB and ACWR signals. Built per
 * **load dimension** — external TSS, internal sRPE, strength
 * tonnage, and impact load each have their own CTL/ATL track,
 * because the v2.1 critique correctly noted that folding them into
 * a single number misleads downstream decisions.
 *
 * Math:
 *   - CTL (chronic training load) = EWMA with 42-day time constant.
 *   - ATL (acute training load) = EWMA with 7-day time constant.
 *   - TSB (training stress balance) = CTL - ATL.
 *   - ACWR (acute:chronic workload ratio) = ATL / CTL (uncoupled).
 *
 *   EWMA recurrence:
 *     ewma_today = ewma_yesterday + alpha * (today_load - ewma_yesterday)
 *     where alpha = 1 - exp(-1 / time_constant_days)
 *
 *   Coggan's classic CTL/ATL uses ALL DAYS, not just training days.
 *   We follow that convention: a rest day contributes 0 load.
 *
 * Cold-start semantics (per v2.1 critique):
 *   - <14 days of usable completions: 'cold_start'. ACWR is
 *     unreliable; B5 disables ACWR-based deload signals in this state.
 *   - 14-41 days: 'warming'. ACWR usable but low-confidence.
 *   - 42+ days: 'stable'. Full load model trusted.
 *
 * ACWR uncoupled framing: the chronic window is the FULL 42 days
 * INCLUDING the most recent 7. We expose `acwrCoupled` (the naive
 * ratio) AND `acwrUncoupled` (chronic = day -42 to -8, acute = last 7).
 * The uncoupled form avoids the methodological coupling that
 * Impellizzeri 2020 critiqued.
 */

import type { LoadConfidence } from './load-input';

export type LoadModelStatus = 'cold_start' | 'warming' | 'stable';

export type LoadDimension = 'external' | 'internal' | 'strength' | 'impact';

/** EWMA time-constant defaults. Caller can override per-dimension. */
export const DEFAULT_CTL_DAYS = 42;
export const DEFAULT_ATL_DAYS = 7;

/** Day-count boundaries between cold-start / warming / stable. */
export const COLD_START_MAX_DAYS = 14;
export const WARMING_MAX_DAYS = 42;

export interface DailyLoad {
  /** ISO date YYYY-MM-DD. */
  date: string;
  /** Load value for this dimension on this day. 0 for rest days. */
  value: number;
  /** Confidence in the source value. Used for rollup. */
  confidence: LoadConfidence;
}

export interface LoadModelDimensionResult {
  dimension: LoadDimension;
  ctl: number;
  atl: number;
  tsb: number;
  /** Coupled ACWR (acute window inside chronic window). */
  acwrCoupled: number;
  /** Uncoupled ACWR (chronic = days -42..-8, acute = days -7..0). */
  acwrUncoupled: number;
  /** Status based on completion count + spread. */
  loadModelStatus: LoadModelStatus;
  /** Number of non-zero days observed. */
  completionCount: number;
  /** Rolled-up confidence: worst per-day → result confidence. */
  confidence: LoadConfidence;
}

export interface ComputeLoadModelInput {
  /**
   * Daily loads for this dimension, oldest first. Caller may include
   * rest days as `{value: 0, confidence: 'high'}` — they affect the
   * EWMA decay correctly.
   */
  daily: readonly DailyLoad[];
  /** Override CTL time constant (default 42 days). */
  ctlDays?: number;
  /** Override ATL time constant (default 7 days). */
  atlDays?: number;
  /** The dimension this series represents. */
  dimension: LoadDimension;
}

/**
 * Compute CTL/ATL/TSB/ACWR for one load dimension. Returns a
 * fully-populated `LoadModelDimensionResult`.
 *
 * Algorithm:
 *   1. Walk the daily array in order, applying EWMA recurrence for
 *      both CTL and ATL.
 *   2. Final CTL/ATL are the values after the last day.
 *   3. ACWR_coupled = ATL / CTL.
 *   4. ACWR_uncoupled = mean(last 7) / mean(days -42..-8).
 *   5. Status = cold_start (<14 non-zero days) | warming (14-41) | stable (42+).
 *   6. Confidence = worst per-day confidence in the last `ctlDays`.
 */
export function computeLoadModelForDimension(
  input: ComputeLoadModelInput,
): LoadModelDimensionResult {
  const ctlDays = input.ctlDays ?? DEFAULT_CTL_DAYS;
  const atlDays = input.atlDays ?? DEFAULT_ATL_DAYS;
  const ctlAlpha = 1 - Math.exp(-1 / ctlDays);
  const atlAlpha = 1 - Math.exp(-1 / atlDays);

  let ctl = 0;
  let atl = 0;
  let completionCount = 0;
  const confidences: LoadConfidence[] = [];

  for (const day of input.daily) {
    const v = day.value;
    ctl = ctl + ctlAlpha * (v - ctl);
    atl = atl + atlAlpha * (v - atl);
    if (v > 0) completionCount++;
    confidences.push(day.confidence);
  }

  const tsb = ctl - atl;
  const acwrCoupled = ctl > 0 ? atl / ctl : 0;

  // Uncoupled: chronic window = last 42 days excluding the most recent
  // 7. Acute window = last 7 days. Mean values, not EWMA, for the
  // uncoupled calculation (matches the published critique recommendation).
  const acwrUncoupled = computeUncoupledAcwr(input.daily, ctlDays, atlDays);

  const loadModelStatus: LoadModelStatus =
    completionCount < COLD_START_MAX_DAYS
      ? 'cold_start'
      : completionCount < WARMING_MAX_DAYS
        ? 'warming'
        : 'stable';

  const confidence = rollupConfidence(confidences);

  return {
    dimension: input.dimension,
    ctl: Math.round(ctl * 10) / 10,
    atl: Math.round(atl * 10) / 10,
    tsb: Math.round(tsb * 10) / 10,
    acwrCoupled: Math.round(acwrCoupled * 100) / 100,
    acwrUncoupled: Math.round(acwrUncoupled * 100) / 100,
    loadModelStatus,
    completionCount,
    confidence,
  };
}

function computeUncoupledAcwr(
  daily: readonly DailyLoad[],
  chronicDays: number,
  acuteDays: number,
): number {
  if (daily.length === 0) return 0;
  // Acute window: last acuteDays entries.
  const acuteStart = Math.max(0, daily.length - acuteDays);
  const acuteSlice = daily.slice(acuteStart);
  const acuteMean = acuteSlice.length > 0
    ? acuteSlice.reduce((s, d) => s + d.value, 0) / acuteSlice.length
    : 0;
  // Chronic window: days -chronicDays..-acuteDays-1 (EXCLUDING acute).
  const chronicEnd = acuteStart; // exclusive
  const chronicStart = Math.max(0, chronicEnd - (chronicDays - acuteDays));
  const chronicSlice = daily.slice(chronicStart, chronicEnd);
  const chronicMean = chronicSlice.length > 0
    ? chronicSlice.reduce((s, d) => s + d.value, 0) / chronicSlice.length
    : 0;
  if (chronicMean === 0) return 0;
  return acuteMean / chronicMean;
}

function rollupConfidence(confidences: readonly LoadConfidence[]): LoadConfidence {
  if (confidences.length === 0) return 'low';
  if (confidences.some((c) => c === 'low')) return 'low';
  if (confidences.every((c) => c === 'high')) return 'high';
  return 'medium';
}

/**
 * Compute a multi-dimension load model from per-dimension daily
 * series. Returns a Map keyed by LoadDimension. Useful when the
 * caller has separated load data per dimension (slice B0 produces
 * SessionLoadEstimate which has the four dimensions).
 */
export function computeMultiDimensionLoadModel(
  inputs: ReadonlyMap<LoadDimension, readonly DailyLoad[]>,
  opts: { ctlDays?: number; atlDays?: number } = {},
): Map<LoadDimension, LoadModelDimensionResult> {
  const out = new Map<LoadDimension, LoadModelDimensionResult>();
  for (const [dimension, daily] of inputs) {
    out.set(dimension, computeLoadModelForDimension({
      daily,
      dimension,
      ctlDays: opts.ctlDays,
      atlDays: opts.atlDays,
    }));
  }
  return out;
}

/**
 * Classify an ACWR value against the standard Gabbett bands. Returns
 * the band name. Use with the principles' `acwrThresholds` to read
 * the canonical boundaries.
 */
export type AcwrBand = 'underTraining' | 'lowRisk' | 'moderateRisk' | 'highRisk';

export function classifyAcwr(
  acwr: number,
  thresholds: {
    underTraining: { min: number; max: number };
    lowRisk: { min: number; max: number };
    moderateRisk: { min: number; max: number };
    highRisk: { min: number; max: number };
  },
): AcwrBand {
  if (acwr < thresholds.lowRisk.min) return 'underTraining';
  if (acwr <= thresholds.lowRisk.max) return 'lowRisk';
  if (acwr <= thresholds.moderateRisk.max) return 'moderateRisk';
  return 'highRisk';
}
