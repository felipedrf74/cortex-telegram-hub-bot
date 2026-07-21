// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Milestone 7 — routing accuracy replay + calibration over the labeled
 * golden corpus.
 *
 * Replays labeled routing_corpus_items through the routing surfaces:
 *
 *   - classifier_keyword    src/router/classifier keywordMatch (deterministic)
 *   - shadow_route_guess    chat-core-v2 classifyShadowRoute (deterministic)
 *   - orchestrator_analyze  analyzeChatSkillOrchestration (deterministic)
 *   - intent_resolver       M4 manifest resolveIntent (deterministic)
 *   - llm_classify_cache    flash-lite classify replayed ONLY from the
 *                           routing_llm_classify_cache SQLite table keyed by
 *                           utterance HMAC. This module NEVER performs a live
 *                           provider call; the gated --refresh-llm pass in
 *                           scripts/run-routing-accuracy.ts is the only
 *                           networked path.
 *
 * Outputs per-domain precision/recall per surface, a calibration table
 * (stated confidence bucket vs empirical accuracy), and a recommended
 * clarify threshold. Gate mode compares per-domain recall/precision against
 * the latest ACCEPTED snapshot — deterministic, zero LLM.
 */

import type Database from 'better-sqlite3';
import { getDb } from './database';
import { keywordMatch } from '../router/classifier';
import { classifyShadowRoute } from './chat-core-v2/shadow-route-classifier';
import { analyzeChatSkillOrchestration } from './chat-skill-orchestrator';
import { resolveIntentAgainst } from './intent-resolution/intent-resolver';
import {
  getCompiledIntentVocabulary,
  type CompiledCapabilityVocabulary,
} from './intent-resolution/vocabulary';
import { listLabeledRoutingCorpusItems, type RoutingCorpusItem } from './routing-corpus';

export const ROUTING_ACCURACY_VERSION = 'routing-accuracy@1.0.0';

export const ROUTING_ACCURACY_SURFACES = [
  'classifier_keyword',
  'shadow_route_guess',
  'orchestrator_analyze',
  'intent_resolver',
  'llm_classify_cache',
] as const;

export type RoutingAccuracySurface = (typeof ROUTING_ACCURACY_SURFACES)[number];

/** ChatCoreV2 domain space → legacy runtime domain space used by labels. */
const V2_TO_LEGACY_DOMAIN: Record<string, string> = {
  tasks: 'secretary',
  training: 'triathlon',
};

export interface RoutingSurfacePrediction {
  surface: RoutingAccuracySurface;
  /** Predicted label-space domain; 'none' when the surface abstained. */
  domain: string;
  /** Stated confidence when the surface reports one. */
  confidence?: number;
  /** False when the surface had no replayable answer (e.g. LLM cache miss). */
  covered: boolean;
}

export interface RoutingDomainMetrics {
  domain: string;
  support: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number | null;
  recall: number | null;
}

export interface RoutingCalibrationBucket {
  bucket: string;
  lowerBound: number;
  upperBound: number;
  count: number;
  correct: number;
  empiricalAccuracy: number | null;
  averageStatedConfidence: number | null;
}

export interface RoutingSurfaceReport {
  surface: RoutingAccuracySurface;
  covered: number;
  uncovered: number;
  correct: number;
  accuracy: number | null;
  perDomain: RoutingDomainMetrics[];
  calibration: RoutingCalibrationBucket[];
  /** Lowest confidence threshold whose above-threshold accuracy >= target. */
  recommendedClarifyThreshold: number | null;
}

export interface RoutingAccuracyReport {
  version: string;
  generatedAt: string;
  itemCount: number;
  clarifyAccuracyTarget: number;
  surfaces: RoutingSurfaceReport[];
}

const CALIBRATION_BUCKET_WIDTH = 0.2;
const DEFAULT_CLARIFY_ACCURACY_TARGET = 0.85;
const GATE_DROP_POINTS = 0.02;

// ─── Prediction ───────────────────────────────────────────────────

export interface PredictRoutingSurfacesOptions {
  db?: Database.Database;
  vocabulary?: readonly CompiledCapabilityVocabulary[];
}

export function predictRoutingSurfaces(
  item: Pick<RoutingCorpusItem, 'utteranceText' | 'utteranceHash'>,
  options: PredictRoutingSurfacesOptions = {},
): RoutingSurfacePrediction[] {
  const text = item.utteranceText ?? '';
  const vocabulary = options.vocabulary ?? getCompiledIntentVocabulary();
  const predictions: RoutingSurfacePrediction[] = [];

  predictions.push({
    surface: 'classifier_keyword',
    domain: keywordMatch(text) ?? 'none',
    covered: true,
  });

  const guess = classifyShadowRoute(text);
  predictions.push({
    surface: 'shadow_route_guess',
    domain: toLegacyDomain(guess.domains[0]) ?? 'none',
    confidence: guess.confidence,
    covered: true,
  });

  const orchestration = analyzeChatSkillOrchestration({ message: text });
  predictions.push({
    surface: 'orchestrator_analyze',
    domain: orchestration.primaryDomain ?? 'none',
    confidence: orchestration.confidence,
    covered: true,
  });

  const resolved = resolveIntentAgainst(vocabulary, text);
  predictions.push({
    surface: 'intent_resolver',
    domain: resolved[0]?.domain ?? 'none',
    covered: true,
  });

  predictions.push(lookupLlmCachePrediction(item.utteranceHash, options.db));

  return predictions;
}

function lookupLlmCachePrediction(
  utteranceHash: string,
  db: Database.Database | undefined,
): RoutingSurfacePrediction {
  const database = db ?? getDb();
  const row = database
    .prepare('SELECT domain, confidence FROM routing_llm_classify_cache WHERE utterance_hash = ?')
    .get(utteranceHash) as { domain: string; confidence: number } | undefined;
  if (!row) {
    return { surface: 'llm_classify_cache', domain: 'none', covered: false };
  }
  return {
    surface: 'llm_classify_cache',
    domain: toLegacyDomain(row.domain) ?? 'none',
    confidence: Number(row.confidence),
    covered: true,
  };
}

function toLegacyDomain(domain: string | undefined | null): string | null {
  if (!domain) return null;
  return V2_TO_LEGACY_DOMAIN[domain] ?? domain;
}

// ─── Report math ──────────────────────────────────────────────────

export interface LabeledPredictionRow {
  labelDomain: string;
  predictions: RoutingSurfacePrediction[];
}

export interface ComputeRoutingAccuracyOptions {
  clarifyAccuracyTarget?: number;
  generatedAt?: string;
}

export function computeRoutingAccuracyReport(
  rows: LabeledPredictionRow[],
  options: ComputeRoutingAccuracyOptions = {},
): RoutingAccuracyReport {
  const target = options.clarifyAccuracyTarget ?? DEFAULT_CLARIFY_ACCURACY_TARGET;
  const surfaces = ROUTING_ACCURACY_SURFACES.map((surface) =>
    computeSurfaceReport(surface, rows, target),
  );
  return {
    version: ROUTING_ACCURACY_VERSION,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    itemCount: rows.length,
    clarifyAccuracyTarget: target,
    surfaces,
  };
}

function computeSurfaceReport(
  surface: RoutingAccuracySurface,
  rows: LabeledPredictionRow[],
  clarifyAccuracyTarget: number,
): RoutingSurfaceReport {
  const observations: Array<{ label: string; predicted: string; confidence?: number; correct: boolean }> = [];
  let uncovered = 0;
  for (const row of rows) {
    const prediction = row.predictions.find((candidate) => candidate.surface === surface);
    if (!prediction || !prediction.covered) {
      uncovered += 1;
      continue;
    }
    observations.push({
      label: row.labelDomain,
      predicted: prediction.domain,
      confidence: prediction.confidence,
      correct: prediction.domain === row.labelDomain,
    });
  }

  const domains = [...new Set(observations.flatMap((observation) => [observation.label, observation.predicted]))].sort();
  const perDomain: RoutingDomainMetrics[] = domains.map((domain) => {
    let truePositives = 0;
    let falsePositives = 0;
    let falseNegatives = 0;
    let support = 0;
    for (const observation of observations) {
      if (observation.label === domain) support += 1;
      if (observation.predicted === domain && observation.label === domain) truePositives += 1;
      else if (observation.predicted === domain && observation.label !== domain) falsePositives += 1;
      else if (observation.predicted !== domain && observation.label === domain) falseNegatives += 1;
    }
    return {
      domain,
      support,
      truePositives,
      falsePositives,
      falseNegatives,
      precision: ratio(truePositives, truePositives + falsePositives),
      recall: ratio(truePositives, truePositives + falseNegatives),
    };
  });

  const correct = observations.filter((observation) => observation.correct).length;
  return {
    surface,
    covered: observations.length,
    uncovered,
    correct,
    accuracy: ratio(correct, observations.length),
    perDomain,
    calibration: computeCalibrationBuckets(observations),
    recommendedClarifyThreshold: recommendClarifyThreshold(observations, clarifyAccuracyTarget),
  };
}

function computeCalibrationBuckets(
  observations: Array<{ confidence?: number; correct: boolean }>,
): RoutingCalibrationBucket[] {
  const withConfidence = observations.filter(
    (observation): observation is { confidence: number; correct: boolean } =>
      typeof observation.confidence === 'number' && Number.isFinite(observation.confidence),
  );
  const buckets: RoutingCalibrationBucket[] = [];
  for (let lower = 0; lower < 1; lower = round2(lower + CALIBRATION_BUCKET_WIDTH)) {
    const upper = round2(Math.min(lower + CALIBRATION_BUCKET_WIDTH, 1));
    const inBucket = withConfidence.filter((observation) =>
      observation.confidence >= lower && (upper === 1 ? observation.confidence <= upper : observation.confidence < upper),
    );
    const bucketCorrect = inBucket.filter((observation) => observation.correct).length;
    buckets.push({
      bucket: `${lower.toFixed(1)}-${upper.toFixed(1)}`,
      lowerBound: lower,
      upperBound: upper,
      count: inBucket.length,
      correct: bucketCorrect,
      empiricalAccuracy: ratio(bucketCorrect, inBucket.length),
      averageStatedConfidence: inBucket.length === 0
        ? null
        : round4(inBucket.reduce((sum, observation) => sum + observation.confidence, 0) / inBucket.length),
    });
  }
  return buckets;
}

/**
 * Lowest threshold t (in 0.05 steps) such that predictions with stated
 * confidence >= t are empirically correct at least `target` of the time.
 * Null when the surface reports no confidences or no threshold qualifies.
 */
export function recommendClarifyThreshold(
  observations: Array<{ confidence?: number; correct: boolean }>,
  target: number,
): number | null {
  const withConfidence = observations.filter(
    (observation): observation is { confidence: number; correct: boolean } =>
      typeof observation.confidence === 'number' && Number.isFinite(observation.confidence),
  );
  if (withConfidence.length === 0) return null;
  for (let threshold = 0; threshold <= 0.951; threshold = round2(threshold + 0.05)) {
    const above = withConfidence.filter((observation) => observation.confidence >= threshold);
    if (above.length === 0) return null;
    const accuracy = above.filter((observation) => observation.correct).length / above.length;
    if (accuracy >= target) return threshold;
  }
  return null;
}

// ─── End-to-end replay ────────────────────────────────────────────

export interface RunRoutingAccuracyOptions {
  db?: Database.Database;
  vocabulary?: readonly CompiledCapabilityVocabulary[];
  clarifyAccuracyTarget?: number;
  generatedAt?: string;
}

export function runRoutingAccuracy(options: RunRoutingAccuracyOptions = {}): RoutingAccuracyReport {
  const db = options.db ?? getDb();
  const items = listLabeledRoutingCorpusItems(db);
  const rows: LabeledPredictionRow[] = items
    .filter((item) => item.labelDomain !== null)
    .map((item) => ({
      labelDomain: item.labelDomain as string,
      predictions: predictRoutingSurfaces(item, { db, vocabulary: options.vocabulary }),
    }));
  return computeRoutingAccuracyReport(rows, {
    clarifyAccuracyTarget: options.clarifyAccuracyTarget,
    generatedAt: options.generatedAt,
  });
}

// ─── Snapshot gate ────────────────────────────────────────────────

export interface RoutingAccuracyRegression {
  surface: RoutingAccuracySurface;
  domain: string;
  metric: 'precision' | 'recall';
  accepted: number;
  current: number;
  dropPoints: number;
}

export interface RoutingAccuracyGateResult {
  passed: boolean;
  comparedSurfaces: number;
  regressions: RoutingAccuracyRegression[];
  /**
   * Coverage-collapse failures. A surface or domain that carried accepted
   * signal cannot silently vanish from the current report (e.g. a wiped
   * routing_llm_classify_cache or a rotated CLASSIFY_SHADOW_HASH_SECRET makes
   * the llm surface report covered=0) — that must FAIL the gate, not pass it
   * vacuously.
   */
  reasons: string[];
}

/**
 * Deterministic gate: fail when
 *   1. any per-domain precision or recall drops more than `dropPoints`
 *      (default 2pts) versus the accepted snapshot, OR
 *   2. coverage collapses: an accepted surface with covered>0 now reports
 *      covered==0 (or is absent), OR a domain the accepted snapshot measured
 *      with support>0 is absent from the current report.
 * Only accepted domains with support==0 are legitimately skipped.
 */
export function compareRoutingAccuracySnapshots(
  current: RoutingAccuracyReport,
  accepted: RoutingAccuracyReport,
  dropPoints: number = GATE_DROP_POINTS,
): RoutingAccuracyGateResult {
  const regressions: RoutingAccuracyRegression[] = [];
  const reasons: string[] = [];
  let comparedSurfaces = 0;
  for (const acceptedSurface of accepted.surfaces) {
    const currentSurface = current.surfaces.find((surface) => surface.surface === acceptedSurface.surface);
    if (!currentSurface) {
      if (acceptedSurface.covered > 0) {
        reasons.push(
          `surface ${acceptedSurface.surface}: accepted snapshot covered ${acceptedSurface.covered} items but the surface is absent from the current report (coverage collapse)`,
        );
      }
      continue;
    }
    comparedSurfaces += 1;
    if (acceptedSurface.covered > 0 && currentSurface.covered === 0) {
      reasons.push(
        `surface ${acceptedSurface.surface}: coverage collapsed from ${acceptedSurface.covered} to 0 (cache wipe or hash-secret rotation?)`,
      );
      continue;
    }
    for (const acceptedDomain of acceptedSurface.perDomain) {
      if (acceptedDomain.support === 0) continue;
      const currentDomain = currentSurface.perDomain.find((domain) => domain.domain === acceptedDomain.domain);
      if (!currentDomain) {
        reasons.push(
          `surface ${acceptedSurface.surface}: domain ${acceptedDomain.domain} (accepted support ${acceptedDomain.support}) is absent from the current report`,
        );
        continue;
      }
      for (const metric of ['precision', 'recall'] as const) {
        const acceptedValue = acceptedDomain[metric];
        const currentValue = currentDomain[metric];
        if (acceptedValue === null || currentValue === null) continue;
        const drop = acceptedValue - currentValue;
        if (drop > dropPoints + 1e-9) {
          regressions.push({
            surface: acceptedSurface.surface,
            domain: acceptedDomain.domain,
            metric,
            accepted: acceptedValue,
            current: currentValue,
            dropPoints: round4(drop),
          });
        }
      }
    }
  }
  return {
    passed: regressions.length === 0 && reasons.length === 0,
    comparedSurfaces,
    regressions,
    reasons,
  };
}

/**
 * Ratchet guard for `run-routing-accuracy --gate --accept-snapshot`: a FAILED
 * gate must never be combined with accepting the current report as the new
 * baseline (that would lower the ratchet). Standalone --accept-snapshot
 * (no --gate) stays allowed.
 */
export function canAcceptAccuracySnapshot(
  gateMode: boolean,
  gate: Pick<RoutingAccuracyGateResult, 'passed'> | null,
): { allowed: boolean; reason?: string } {
  if (!gateMode) return { allowed: true };
  if (gate && !gate.passed) {
    return {
      allowed: false,
      reason: 'refusing --accept-snapshot: the gate FAILED — accepting this report would lower the ratchet',
    };
  }
  return { allowed: true };
}

export function storeAcceptedAccuracySnapshot(
  report: RoutingAccuracyReport,
  db: Database.Database = getDb(),
): number {
  const result = db.prepare(
    'INSERT INTO accepted_accuracy_snapshots (snapshot_json, accepted) VALUES (?, 1)',
  ).run(JSON.stringify(report));
  return Number(result.lastInsertRowid);
}

export function getLatestAcceptedAccuracySnapshot(
  db: Database.Database = getDb(),
): RoutingAccuracyReport | null {
  const row = db.prepare(`
    SELECT snapshot_json AS snapshotJson FROM accepted_accuracy_snapshots
    WHERE accepted = 1
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `).get() as { snapshotJson: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.snapshotJson) as RoutingAccuracyReport;
  } catch {
    return null;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : round4(numerator / denominator);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}
