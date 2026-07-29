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
import { createHash } from 'node:crypto';
import { getDb } from './database';
import { keywordMatch } from '../router/classifier';
import { classifyShadowRoute } from './chat-core-v2/shadow-route-classifier';
import { analyzeChatSkillOrchestration } from './chat-skill-orchestrator';
import { resolveIntentAgainst } from './intent-resolution/intent-resolver';
import {
  getCompiledIntentVocabulary,
  type CompiledCapabilityVocabulary,
} from './intent-resolution/vocabulary';
import {
  getRoutingLabelCandidates,
  listLabeledRoutingCorpusItems,
  type RoutingCorpusItem,
} from './routing-corpus';

export const ROUTING_ACCURACY_VERSION = 'routing-accuracy@1.1.0';

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
  /**
   * v1.1 makes the evidence boundary machine-readable. Phase 4 scores domain
   * routing only; action-skill labels are coverage for the later Phase 7
   * classifier-manifest gate, not a claim of skill-routing correctness.
   * Optional only so already-accepted v1.0 snapshots remain readable.
   */
  evaluationScope?: {
    domainRoutingScored: true;
    actionSkillRoutingScored: false;
    actionSkillGate: 'phase7_classifier_manifest_prompt';
  };
  surfaces: RoutingSurfaceReport[];
  /** Present on owner-accepted candidates; binds every labeled row and skill. */
  corpusIdentityDigest?: string;
}

const CALIBRATION_BUCKET_WIDTH = 0.2;
const DEFAULT_CLARIFY_ACCURACY_TARGET = 0.85;
const GATE_DROP_POINTS = 0.02;
const SNAPSHOT_MINIMUM_LABELED_ITEMS = 300;
const SNAPSHOT_MINIMUM_DOMAIN_ITEMS = 20;
const SNAPSHOT_MINIMUM_ACTION_SKILL_ITEMS = 20;
const SNAPSHOT_MINIMUM_SPECIAL_LABEL_ITEMS = 8;

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
    evaluationScope: {
      domainRoutingScored: true,
      actionSkillRoutingScored: false,
      actionSkillGate: 'phase7_classifier_manifest_prompt',
    },
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

export interface RoutingCorpusSnapshotReadiness {
  allowed: boolean;
  totalLabeled: number;
  byDomain: Record<string, number>;
  bySkill: Record<string, number>;
  reasons: string[];
}

/**
 * The accepted snapshot is the calibration authority, so it must prove the
 * approved corpus shape independently of the report math: >=300 labels,
 * balanced coverage of all eight domains and eleven executable skills, and
 * explicit clarify/none controls.
 */
export function assessRoutingCorpusSnapshotReadiness(
  db: Database.Database = getDb(),
): RoutingCorpusSnapshotReadiness {
  const labeledItems = listLabeledRoutingCorpusItems(db);
  const byDomain: Record<string, number> = {};
  const bySkill: Record<string, number> = {};
  for (const item of labeledItems) {
    if (item.labelDomain) {
      byDomain[item.labelDomain] = (byDomain[item.labelDomain] ?? 0) + 1;
    }
    if (item.labelSkill) {
      bySkill[item.labelSkill] = (bySkill[item.labelSkill] ?? 0) + 1;
    }
  }
  const candidates = getRoutingLabelCandidates();
  const reasons: string[] = [];
  if (labeledItems.length < SNAPSHOT_MINIMUM_LABELED_ITEMS) {
    reasons.push(
      `requires at least ${SNAPSHOT_MINIMUM_LABELED_ITEMS} labeled items; found ${labeledItems.length}`,
    );
  }
  for (const domain of candidates.domains) {
    const count = byDomain[domain] ?? 0;
    if (count < SNAPSHOT_MINIMUM_DOMAIN_ITEMS) {
      reasons.push(
        `domain ${domain} requires at least ${SNAPSHOT_MINIMUM_DOMAIN_ITEMS} labels; found ${count}`,
      );
    }
  }
  for (const skill of candidates.skills) {
    const count = bySkill[skill] ?? 0;
    if (count < SNAPSHOT_MINIMUM_ACTION_SKILL_ITEMS) {
      reasons.push(
        `skill ${skill} requires at least ${SNAPSHOT_MINIMUM_ACTION_SKILL_ITEMS} labels; found ${count}`,
      );
    }
  }
  for (const special of candidates.specialLabels) {
    const count = byDomain[special] ?? 0;
    if (count < SNAPSHOT_MINIMUM_SPECIAL_LABEL_ITEMS) {
      reasons.push(
        `special label ${special} requires at least ${SNAPSHOT_MINIMUM_SPECIAL_LABEL_ITEMS} labels; found ${count}`,
      );
    }
  }
  return {
    allowed: reasons.length === 0,
    totalLabeled: labeledItems.length,
    byDomain,
    bySkill,
    reasons,
  };
}

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
    if (currentSurface.covered < acceptedSurface.covered) {
      reasons.push(currentSurface.covered === 0
        ? `surface ${acceptedSurface.surface}: coverage collapsed from ${acceptedSurface.covered} to 0 (cache wipe or hash-secret rotation?)`
        : `surface ${acceptedSurface.surface}: coverage decreased from ${acceptedSurface.covered} to ${currentSurface.covered}`);
      continue;
    }
    const acceptedCoverageRatio = ratio(acceptedSurface.covered, accepted.itemCount) ?? 0;
    const currentCoverageRatio = ratio(currentSurface.covered, current.itemCount) ?? 0;
    if (currentCoverageRatio + 1e-9 < acceptedCoverageRatio) {
      reasons.push(
        `surface ${acceptedSurface.surface}: coverage ratio decreased from ${acceptedCoverageRatio} to ${currentCoverageRatio}`,
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
      if (currentDomain.support < acceptedDomain.support) {
        reasons.push(
          `surface ${acceptedSurface.surface}: domain ${acceptedDomain.domain} support decreased from ${acceptedDomain.support} to ${currentDomain.support}`,
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
 * Ratchet guard for `run-routing-accuracy --gate --accept-snapshot`: the gate
 * is mandatory and a FAILED gate must never be combined with accepting the
 * current report as the new baseline.
 */
export function canAcceptAccuracySnapshot(
  gateMode: boolean,
  gate: Pick<RoutingAccuracyGateResult, 'passed'> | null,
  corpusReadiness?: Pick<RoutingCorpusSnapshotReadiness, 'allowed' | 'reasons'>,
): { allowed: boolean; reason?: string } {
  if (!gateMode) {
    return {
      allowed: false,
      reason: 'refusing --accept-snapshot: --gate is required so the accepted ratchet cannot be bypassed',
    };
  }
  if (gateMode && gate && !gate.passed) {
    return {
      allowed: false,
      reason: 'refusing --accept-snapshot: the gate FAILED — accepting this report would lower the ratchet',
    };
  }
  if (corpusReadiness && !corpusReadiness.allowed) {
    return {
      allowed: false,
      reason: `refusing --accept-snapshot: corpus coverage is incomplete — ${corpusReadiness.reasons.join('; ')}`,
    };
  }
  return { allowed: true };
}

function storeAcceptedAccuracySnapshot(
  report: RoutingAccuracyReport,
  db: Database.Database,
): number {
  const result = db.prepare(
    'INSERT INTO accepted_accuracy_snapshots (snapshot_json, accepted) VALUES (?, 1)',
  ).run(JSON.stringify(report));
  return Number(result.lastInsertRowid);
}

export interface RoutingAccuracySnapshotCandidate {
  report: RoutingAccuracyReport;
  corpusIdentityDigest: string;
}

export interface AcceptRoutingAccuracySnapshotOptions {
  gateMode: boolean;
  ownerAuthorized: boolean;
  vocabulary?: readonly CompiledCapabilityVocabulary[];
}

export interface AcceptedRoutingAccuracySnapshot {
  snapshotId: number;
  corpusIdentityDigest: string;
  corpusReadiness: RoutingCorpusSnapshotReadiness;
  gate: RoutingAccuracyGateResult | null;
}

function routingCorpusIdentityDigest(db: Database.Database): string {
  const identity = listLabeledRoutingCorpusItems(db).map((item) => ({
    id: item.id,
    tenantId: item.tenantId,
    userId: item.userId,
    utteranceHash: item.utteranceHash,
    utteranceTextSha256: createHash('sha256').update(item.utteranceText ?? '').digest('hex'),
    source: item.source,
    labelDomain: item.labelDomain,
    labelSkill: item.labelSkill,
    labelStatus: item.labelStatus,
    labeledAt: item.labeledAt,
  }));
  return `sha256:${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`;
}

export function buildRoutingAccuracySnapshotCandidate(
  options: RunRoutingAccuracyOptions = {},
): RoutingAccuracySnapshotCandidate {
  const db = options.db ?? getDb();
  const corpusIdentityDigest = routingCorpusIdentityDigest(db);
  return {
    report: {
      ...runRoutingAccuracy(options),
      corpusIdentityDigest,
    },
    corpusIdentityDigest,
  };
}

/**
 * Sole accepted-snapshot write path. BEGIN IMMEDIATE serializes this decision
 * with corpus labeling, then the corpus identity, replay report, readiness,
 * and ratchet are recomputed before the snapshot INSERT.
 */
export function acceptRoutingAccuracySnapshotAtomically(
  candidate: RoutingAccuracySnapshotCandidate,
  options: AcceptRoutingAccuracySnapshotOptions,
  db: Database.Database = getDb(),
): AcceptedRoutingAccuracySnapshot {
  if (!options.ownerAuthorized) {
    throw new Error('Routing accuracy snapshot acceptance requires explicit owner authorization');
  }
  const modeDecision = canAcceptAccuracySnapshot(options.gateMode, null);
  if (!modeDecision.allowed) throw new Error(modeDecision.reason);

  const accept = db.transaction(() => {
    const currentIdentityDigest = routingCorpusIdentityDigest(db);
    if (currentIdentityDigest !== candidate.corpusIdentityDigest) {
      throw new Error(
        `Routing corpus identity changed before snapshot acceptance; expected ${candidate.corpusIdentityDigest}, found ${currentIdentityDigest}`,
      );
    }
    const currentCandidate = buildRoutingAccuracySnapshotCandidate({
      db,
      vocabulary: options.vocabulary,
      clarifyAccuracyTarget: candidate.report.clarifyAccuracyTarget,
      generatedAt: candidate.report.generatedAt,
    });
    const currentReport = currentCandidate.report;
    if (JSON.stringify(currentReport) !== JSON.stringify(candidate.report)) {
      throw new Error('Routing accuracy report changed before snapshot acceptance; rerun the gate');
    }

    const corpusReadiness = assessRoutingCorpusSnapshotReadiness(db);
    const previous = getLatestAcceptedAccuracySnapshot(db);
    const gate = previous ? compareRoutingAccuracySnapshots(currentReport, previous) : null;
    const decision = canAcceptAccuracySnapshot(options.gateMode, gate, corpusReadiness);
    if (!decision.allowed) throw new Error(decision.reason);

    return {
      snapshotId: storeAcceptedAccuracySnapshot(currentReport, db),
      corpusIdentityDigest: currentIdentityDigest,
      corpusReadiness,
      gate,
    };
  });
  return accept.immediate();
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.snapshotJson);
  } catch (error) {
    throw new Error(
      'Accepted routing accuracy snapshot contains invalid JSON; refusing to treat a corrupt ratchet as absent',
      { cause: error },
    );
  }
  if (!isRoutingAccuracyReport(parsed)) {
    throw new Error(
      'Accepted routing accuracy snapshot has an invalid report schema; refusing to treat a corrupt ratchet as absent',
    );
  }
  return parsed;
}

// ─── Helpers ──────────────────────────────────────────────────────

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNullableFiniteNumber(value: unknown): value is number | null {
  return value === null || isFiniteNumber(value);
}

function isRoutingAccuracyReport(value: unknown): value is RoutingAccuracyReport {
  if (!value || typeof value !== 'object') return false;
  const report = value as Partial<RoutingAccuracyReport>;
  if (
    typeof report.version !== 'string'
    || typeof report.generatedAt !== 'string'
    || !isNonNegativeInteger(report.itemCount)
    || report.itemCount < SNAPSHOT_MINIMUM_LABELED_ITEMS
    || !isFiniteNumber(report.clarifyAccuracyTarget)
    || report.clarifyAccuracyTarget < 0
    || report.clarifyAccuracyTarget > 1
    || !Array.isArray(report.surfaces)
    || report.surfaces.length !== ROUTING_ACCURACY_SURFACES.length
  ) {
    return false;
  }
  const surfaceIds = new Set(report.surfaces.map((surface) => surface?.surface));
  if (
    surfaceIds.size !== ROUTING_ACCURACY_SURFACES.length
    || ROUTING_ACCURACY_SURFACES.some((surface) => !surfaceIds.has(surface))
  ) {
    return false;
  }
  return report.surfaces.every((surface) => (
    surface
    && typeof surface === 'object'
    && ROUTING_ACCURACY_SURFACES.includes(surface.surface)
    && isNonNegativeInteger(surface.covered)
    && isNonNegativeInteger(surface.uncovered)
    && surface.covered + surface.uncovered === report.itemCount
    && isNonNegativeInteger(surface.correct)
    && surface.correct <= surface.covered
    && isNullableFiniteNumber(surface.accuracy)
    && surface.accuracy === ratio(surface.correct, surface.covered)
    && Array.isArray(surface.perDomain)
    && new Set(surface.perDomain.map((domain) => domain.domain)).size === surface.perDomain.length
    && surface.perDomain.every((domain) => (
      domain
      && typeof domain === 'object'
      && typeof domain.domain === 'string'
      && domain.domain.length > 0
      && isNonNegativeInteger(domain.support)
      && isNonNegativeInteger(domain.truePositives)
      && isNonNegativeInteger(domain.falsePositives)
      && isNonNegativeInteger(domain.falseNegatives)
      && domain.support === domain.truePositives + domain.falseNegatives
      && isNullableFiniteNumber(domain.precision)
      && domain.precision === ratio(
        domain.truePositives,
        domain.truePositives + domain.falsePositives,
      )
      && isNullableFiniteNumber(domain.recall)
      && domain.recall === ratio(
        domain.truePositives,
        domain.truePositives + domain.falseNegatives,
      )
    ))
    && surface.perDomain.reduce((sum, domain) => sum + domain.support, 0) === surface.covered
    && surface.perDomain.reduce((sum, domain) => sum + domain.truePositives, 0) === surface.correct
    && surface.perDomain.reduce((sum, domain) => sum + domain.falsePositives, 0)
      === surface.covered - surface.correct
    && isRoutingCalibration(surface.calibration, surface.covered, surface.correct)
    && isNullableFiniteNumber(surface.recommendedClarifyThreshold)
    && (
      surface.recommendedClarifyThreshold === null
      || (
        surface.recommendedClarifyThreshold >= 0
        && surface.recommendedClarifyThreshold <= 1
      )
    )
  ));
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isRoutingCalibration(
  value: unknown,
  covered: number,
  surfaceCorrect: number,
): value is RoutingCalibrationBucket[] {
  if (!Array.isArray(value) || value.length !== 5) return false;
  const expected = [
    { bucket: '0.0-0.2', lowerBound: 0, upperBound: 0.2 },
    { bucket: '0.2-0.4', lowerBound: 0.2, upperBound: 0.4 },
    { bucket: '0.4-0.6', lowerBound: 0.4, upperBound: 0.6 },
    { bucket: '0.6-0.8', lowerBound: 0.6, upperBound: 0.8 },
    { bucket: '0.8-1.0', lowerBound: 0.8, upperBound: 1 },
  ] as const;
  let calibrated = 0;
  let calibratedCorrect = 0;
  for (let index = 0; index < expected.length; index += 1) {
    const bucket = value[index] as Partial<RoutingCalibrationBucket> | undefined;
    const boundary = expected[index];
    if (
      !bucket
      || bucket.bucket !== boundary.bucket
      || bucket.lowerBound !== boundary.lowerBound
      || bucket.upperBound !== boundary.upperBound
      || !isNonNegativeInteger(bucket.count)
      || !isNonNegativeInteger(bucket.correct)
      || bucket.correct > bucket.count
      || bucket.empiricalAccuracy !== ratio(bucket.correct, bucket.count)
      || (
        bucket.count === 0
          ? bucket.averageStatedConfidence !== null
          : !isFiniteNumber(bucket.averageStatedConfidence)
            || bucket.averageStatedConfidence < boundary.lowerBound
            || bucket.averageStatedConfidence > boundary.upperBound
      )
    ) {
      return false;
    }
    calibrated += bucket.count;
    calibratedCorrect += bucket.correct;
  }
  return calibrated <= covered
    && calibratedCorrect <= surfaceCorrect
    && calibrated - calibratedCorrect <= covered - surfaceCorrect;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : round4(numerator / denominator);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}
