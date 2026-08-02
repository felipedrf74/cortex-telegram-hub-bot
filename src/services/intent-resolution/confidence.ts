// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Milestone 14 — calibrated routing confidence table.
 *
 * Runtime lookup for `config/routing-calibration.json`, the generated
 * calibration artifact produced by `scripts/calibrate-routing-confidence.ts`.
 * The table routes the previously hardcoded routing confidences through one
 * place:
 *
 *   - orchestrator branches   chat-skill-orchestrator resolveConfidence
 *                             (0.4 / 0.96 / 0.92 / 0.9 / 0.72 / 0.84) and the
 *                             >=0.86 route-override threshold
 *   - classifier floors       router/classifier low-confidence secretary
 *                             default (<0.6) and the active-context pin floor
 *                             (0.51)
 *   - intent-resolver buckets rawScore → empirical precision for the manifest
 *                             resolver (used only by the flag-gated clarify
 *                             policy — no legacy surface reads them)
 *   - clarify policy          epsilon + actionable floor for the M14 clarify
 *                             decision (flag AI_ROUTING_CLARIFY, default OFF)
 *
 * Fail-open contract: the table is loaded once per process; a missing or
 * invalid file falls back to the embedded BOOTSTRAP constants, which
 * reproduce the legacy hardcoded values EXACTLY. The checked-in artifact is
 * generated from the reviewed routing corpus; bootstrap is now only the
 * runtime fallback for a missing or invalid artifact.
 */

import fs from 'fs';
import path from 'path';
import { logger } from '../../utils/logger';
import { chatCapabilityRuntimeAllowsFlags } from '../chat-capability-runtime-guard';
import { MANIFEST_ROUTING_MASTER_KILL_ENV_VAR } from './manifest-routing-flags';

export const ROUTING_CALIBRATION_VERSION = 'routing-calibration@1.0.0';
export const ROUTING_CALIBRATION_FILE = 'config/routing-calibration.json';

/** Minimum observations a bucket/branch needs before its empirical precision replaces the prior. */
export const CALIBRATION_MIN_BUCKET_SAMPLES = 10;

const DEFAULT_CLARIFY_ACCURACY_TARGET = 0.85;

// ─── Table shape ──────────────────────────────────────────────────

export interface RoutingCalibrationProvenance {
  source: 'bootstrap' | 'corpus';
  corpusSize: number;
  generatedAt: string;
}

export interface OrchestratorBranchCalibration {
  no_primary_domain: number;
  scheduling_cross_skill: number;
  scheduling: number;
  destructive: number;
  ambiguous_reference: number;
  default: number;
}

export type OrchestratorConfidenceBranch = keyof OrchestratorBranchCalibration;

export interface IntentResolverScoreBucket {
  /** Inclusive lower bound of the resolver rawScore range this bucket covers. */
  minScore: number;
  calibratedPrecision: number;
}

export interface RoutingCalibrationTable {
  version: string;
  provenance: RoutingCalibrationProvenance;
  orchestrator: {
    branches: OrchestratorBranchCalibration;
    /** applyChatSkillRoutingDecision override gate (legacy constant 0.86). */
    overrideThreshold: number;
  };
  classifier: {
    /** classifyWithClaude low-confidence pin threshold (legacy constant 0.6). */
    lowConfidenceFloor: number;
    /** Pinned-domain minimum confidence (legacy constant 0.51). Policy, never calibrated. */
    pinnedConfidenceMin: number;
  };
  intentResolver: {
    /** Sorted by minScore DESC; lookup walks top-down to the first bucket whose minScore <= rawScore. */
    scoreBuckets: IntentResolverScoreBucket[];
  };
  clarify: {
    /** Max calibrated-precision gap between top-2 candidates that still counts as ambiguous. Policy constant. */
    epsilon: number;
    /** Both candidates must calibrate at or above this floor to be worth clarifying between. */
    actionableFloor: number;
  };
}

/**
 * BOOTSTRAP table — reproduces the current hardcoded constants EXACTLY.
 *
 * orchestrator.branches / overrideThreshold and classifier.* are the legacy
 * literals lifted verbatim from chat-skill-orchestrator.resolveConfidence,
 * applyChatSkillRoutingDecision, and router/classifier.classifyWithClaude.
 *
 * intentResolver.scoreBuckets and clarify.* are documented BOOTSTRAP PRIORS:
 * no legacy surface consumed such values, so they cannot change existing
 * behavior — they only feed the flag-gated (default OFF) clarify policy.
 *   - minScore 5 → 0.95: a normalized example-utterance match (+5) is the
 *     resolver's decisive evidence tier (see M12 classifier convergence).
 *   - minScore 2 → 0.75: multiple independent vocabulary matchers.
 *   - minScore 1 → 0.6: single matcher — aligned with the classifier's 0.6
 *     low-confidence floor.
 *   - minScore 0 → 0.4: sub-matcher evidence (context nudges only) — aligned
 *     with the orchestrator's no-primary-domain floor.
 *   - clarify.epsilon 0.05: policy constant (same-bucket ties clarify;
 *     cross-bucket gaps act).
 *   - clarify.actionableFloor 0.6: aligned with the classifier floor.
 */
export const BOOTSTRAP_ROUTING_CALIBRATION: RoutingCalibrationTable = {
  version: ROUTING_CALIBRATION_VERSION,
  provenance: {
    source: 'bootstrap',
    corpusSize: 0,
    generatedAt: '2026-07-21T00:00:00.000Z',
  },
  orchestrator: {
    branches: {
      no_primary_domain: 0.4,
      scheduling_cross_skill: 0.96,
      scheduling: 0.92,
      destructive: 0.9,
      ambiguous_reference: 0.72,
      default: 0.84,
    },
    overrideThreshold: 0.86,
  },
  classifier: {
    lowConfidenceFloor: 0.6,
    pinnedConfidenceMin: 0.51,
  },
  intentResolver: {
    scoreBuckets: [
      { minScore: 5, calibratedPrecision: 0.95 },
      { minScore: 2, calibratedPrecision: 0.75 },
      { minScore: 1, calibratedPrecision: 0.6 },
      { minScore: 0, calibratedPrecision: 0.4 },
    ],
  },
  clarify: {
    epsilon: 0.05,
    actionableFloor: 0.6,
  },
};

// ─── Validation (fail-open) ───────────────────────────────────────

function isConfidence(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

const ORCHESTRATOR_BRANCH_KEYS: OrchestratorConfidenceBranch[] = [
  'no_primary_domain',
  'scheduling_cross_skill',
  'scheduling',
  'destructive',
  'ambiguous_reference',
  'default',
];

/**
 * Parse + validate an untrusted JSON payload into a calibration table.
 * Returns null on ANY shape problem so callers can fail open to bootstrap.
 */
export function parseRoutingCalibration(raw: unknown): RoutingCalibrationTable | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const candidate = raw as Record<string, unknown>;
  const provenance = candidate.provenance as Record<string, unknown> | undefined;
  const orchestrator = candidate.orchestrator as Record<string, unknown> | undefined;
  const classifier = candidate.classifier as Record<string, unknown> | undefined;
  const intentResolver = candidate.intentResolver as Record<string, unknown> | undefined;
  const clarify = candidate.clarify as Record<string, unknown> | undefined;
  if (typeof candidate.version !== 'string' || candidate.version.length === 0) return null;
  if (!provenance || typeof provenance !== 'object') return null;
  if (provenance.source !== 'bootstrap' && provenance.source !== 'corpus') return null;
  if (typeof provenance.corpusSize !== 'number' || !Number.isFinite(provenance.corpusSize) || provenance.corpusSize < 0) return null;
  if (typeof provenance.generatedAt !== 'string' || provenance.generatedAt.length === 0) return null;
  if (!orchestrator || typeof orchestrator !== 'object') return null;
  const branches = orchestrator.branches as Record<string, unknown> | undefined;
  if (!branches || typeof branches !== 'object') return null;
  for (const key of ORCHESTRATOR_BRANCH_KEYS) {
    if (!isConfidence(branches[key])) return null;
  }
  if (!isConfidence(orchestrator.overrideThreshold)) return null;
  if (!classifier || !isConfidence(classifier.lowConfidenceFloor) || !isConfidence(classifier.pinnedConfidenceMin)) return null;
  if (!intentResolver || !Array.isArray(intentResolver.scoreBuckets) || intentResolver.scoreBuckets.length === 0) return null;
  for (const bucket of intentResolver.scoreBuckets as Array<Record<string, unknown>>) {
    if (!bucket || typeof bucket !== 'object') return null;
    if (typeof bucket.minScore !== 'number' || !Number.isFinite(bucket.minScore) || bucket.minScore < 0) return null;
    if (!isConfidence(bucket.calibratedPrecision)) return null;
  }
  if (!clarify || !isConfidence(clarify.epsilon) || !isConfidence(clarify.actionableFloor)) return null;
  return {
    version: candidate.version,
    provenance: {
      source: provenance.source,
      corpusSize: provenance.corpusSize,
      generatedAt: provenance.generatedAt,
    },
    orchestrator: {
      branches: Object.fromEntries(
        ORCHESTRATOR_BRANCH_KEYS.map((key) => [key, branches[key] as number]),
      ) as unknown as OrchestratorBranchCalibration,
      overrideThreshold: orchestrator.overrideThreshold as number,
    },
    classifier: {
      lowConfidenceFloor: classifier.lowConfidenceFloor as number,
      pinnedConfidenceMin: classifier.pinnedConfidenceMin as number,
    },
    intentResolver: {
      scoreBuckets: [...(intentResolver.scoreBuckets as IntentResolverScoreBucket[])]
        .map((bucket) => ({ minScore: bucket.minScore, calibratedPrecision: bucket.calibratedPrecision }))
        .sort((left, right) => right.minScore - left.minScore),
    },
    clarify: {
      epsilon: clarify.epsilon as number,
      actionableFloor: clarify.actionableFloor as number,
    },
  };
}

/** Read + parse a calibration file from disk. Null on missing/unreadable/invalid. */
export function loadRoutingCalibrationFile(filePath?: string): RoutingCalibrationTable | null {
  const resolved = filePath ?? path.resolve(process.cwd(), ROUTING_CALIBRATION_FILE);
  let rawText: string;
  try {
    rawText = fs.readFileSync(resolved, 'utf8');
  } catch {
    // Missing file is an expected fail-open state (fresh checkout before
    // generation) — stay silent and serve bootstrap.
    return null;
  }
  try {
    const parsed = parseRoutingCalibration(JSON.parse(rawText));
    if (!parsed) {
      logger.warn({ filePath: resolved }, 'routing-calibration file invalid — failing open to bootstrap constants');
    }
    return parsed;
  } catch (err) {
    logger.warn(
      { filePath: resolved, err: err instanceof Error ? err.message : String(err) },
      'routing-calibration file unparsable — failing open to bootstrap constants',
    );
    return null;
  }
}

// ─── Singleton + test seams ───────────────────────────────────────

let cachedTable: RoutingCalibrationTable | null = null;
let loadAttempted = false;

/** Active calibration table — loaded once, fail-open to bootstrap. */
export function getRoutingCalibration(): RoutingCalibrationTable {
  if (!loadAttempted && cachedTable === null) {
    loadAttempted = true;
    cachedTable = loadRoutingCalibrationFile();
  }
  return cachedTable ?? BOOTSTRAP_ROUTING_CALIBRATION;
}

export function _resetRoutingCalibrationForTests(): void {
  cachedTable = null;
  loadAttempted = false;
}

/**
 * Test seam: install an explicit table (or null to force the bootstrap
 * fail-open path without touching disk). Pair with
 * _resetRoutingCalibrationForTests() in afterEach.
 */
export function _setRoutingCalibrationForTests(table: RoutingCalibrationTable | null): void {
  cachedTable = table;
  loadAttempted = true;
}

// ─── Runtime helpers (replace the inline constants) ───────────────

export function getOrchestratorBranchConfidence(branch: OrchestratorConfidenceBranch): number {
  return getRoutingCalibration().orchestrator.branches[branch];
}

export function getOrchestratorOverrideThreshold(): number {
  return getRoutingCalibration().orchestrator.overrideThreshold;
}

export function getClassifierLowConfidenceFloor(): number {
  return getRoutingCalibration().classifier.lowConfidenceFloor;
}

export function getClassifierPinnedConfidenceMin(): number {
  return getRoutingCalibration().classifier.pinnedConfidenceMin;
}

export function getClarifyPolicy(): { epsilon: number; actionableFloor: number } {
  const { clarify } = getRoutingCalibration();
  return { epsilon: clarify.epsilon, actionableFloor: clarify.actionableFloor };
}

/** Map a manifest intent-resolver rawScore to its calibrated empirical precision. */
export function calibrateIntentResolverScore(rawScore: number): number {
  const buckets = getRoutingCalibration().intentResolver.scoreBuckets;
  for (const bucket of buckets) {
    if (rawScore >= bucket.minScore) return bucket.calibratedPrecision;
  }
  return buckets[buckets.length - 1]?.calibratedPrecision ?? 0;
}

// ─── Clarify flag (AI_ROUTING_CLARIFY, master kill respected) ─────

type EnvLike = Record<string, string | undefined>;

export const ROUTING_CLARIFY_ENV_VAR = 'AI_ROUTING_CLARIFY';

function parseBoolean(raw: string | undefined): boolean {
  const normalized = String(raw ?? '').trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes';
}

/**
 * Whether the deterministic clarify policy may emit clarify decisions.
 * Default OFF; the manifest-routing master kill (AI_ROUTING_MANIFEST_KILL)
 * always wins, mirroring the M12 per-surface flag precedence rule.
 */
export function isRoutingClarifyEnabled(env: EnvLike = process.env): boolean {
  if (!chatCapabilityRuntimeAllowsFlags()) return false;
  if (parseBoolean(env[MANIFEST_ROUTING_MASTER_KILL_ENV_VAR])) return false;
  return parseBoolean(env[ROUTING_CLARIFY_ENV_VAR]);
}

// ─── Corpus-mode calibration math (used by the offline script) ────

export interface OrchestratorCalibrationObservation {
  statedConfidence: number;
  correct: boolean;
}

export interface ResolverCalibrationObservation {
  rawScore: number;
  correct: boolean;
}

export interface ClassifierCalibrationObservation {
  statedConfidence: number;
  correct: boolean;
}

export interface BuildCorpusRoutingCalibrationInput {
  orchestrator: OrchestratorCalibrationObservation[];
  resolver: ResolverCalibrationObservation[];
  llmClassifier?: ClassifierCalibrationObservation[];
  corpusSize: number;
  generatedAt?: string;
  clarifyAccuracyTarget?: number;
  /**
   * Table active while the observations were replayed. Branch grouping keys
   * on this table's stated-confidence values so a SECOND corpus regeneration
   * (when branches already carry empirical values) still groups correctly.
   * Two branches that collide on the same stated value share the pooled
   * empirical precision — documented limitation.
   */
  baseline?: RoutingCalibrationTable;
}

export interface ClassifierFloorCalibrationResult {
  lowConfidenceFloor: number;
  coverageComplete: boolean;
  calibrated: boolean;
}

/**
 * Derive the classifier safety floor only from complete corpus coverage.
 *
 * A bounded cache refresh can be ordered by domain and is therefore not a
 * representative sample. Even at complete coverage, retaining the baseline
 * because no threshold satisfies the target is not a successful calibration.
 */
export function deriveClassifierFloorCalibration(input: {
  observations: ClassifierCalibrationObservation[];
  corpusSize: number;
  baselineFloor: number;
  target?: number;
}): ClassifierFloorCalibrationResult {
  const coverageComplete = input.corpusSize > 0
    && input.observations.length === input.corpusSize;
  if (!coverageComplete) {
    return {
      lowConfidenceFloor: input.baselineFloor,
      coverageComplete: false,
      calibrated: false,
    };
  }

  const threshold = recommendThresholdMeetingTarget(
    input.observations.map((observation) => ({
      confidence: observation.statedConfidence,
      correct: observation.correct,
    })),
    input.target ?? DEFAULT_CLARIFY_ACCURACY_TARGET,
  );
  return {
    lowConfidenceFloor: threshold ?? input.baselineFloor,
    coverageComplete: true,
    calibrated: threshold !== null,
  };
}

/**
 * Build a corpus-mode calibration table from replayed labeled observations.
 * Deterministic, zero LLM. Per-branch/bucket smoothing: buckets with fewer
 * than CALIBRATION_MIN_BUCKET_SAMPLES observations keep the baseline value
 * instead of trusting thin empirical evidence.
 *
 * Floor derivation reuses routing-accuracy's recommendClarifyThreshold math
 * (lowest 0.05-step threshold whose above-threshold accuracy meets the
 * target). Policy constants (clarify.epsilon, classifier.pinnedConfidenceMin)
 * are never calibrated.
 */
export function buildCorpusRoutingCalibration(
  input: BuildCorpusRoutingCalibrationInput,
): RoutingCalibrationTable {
  const baseline = input.baseline ?? getRoutingCalibration();
  const target = input.clarifyAccuracyTarget ?? DEFAULT_CLARIFY_ACCURACY_TARGET;

  const branches = { ...baseline.orchestrator.branches };
  for (const branch of ORCHESTRATOR_BRANCH_KEYS) {
    const statedValue = baseline.orchestrator.branches[branch];
    const inBranch = input.orchestrator.filter(
      (observation) => Math.abs(observation.statedConfidence - statedValue) < 1e-9,
    );
    if (inBranch.length >= CALIBRATION_MIN_BUCKET_SAMPLES) {
      branches[branch] = round4(inBranch.filter((observation) => observation.correct).length / inBranch.length);
    }
  }

  const baselineBuckets = baseline.intentResolver.scoreBuckets;
  const scoreBuckets: IntentResolverScoreBucket[] = baselineBuckets.map((bucket, index) => {
    const upper = index === 0 ? Number.POSITIVE_INFINITY : baselineBuckets[index - 1].minScore;
    const inBucket = input.resolver.filter(
      (observation) => observation.rawScore >= bucket.minScore && observation.rawScore < upper,
    );
    if (inBucket.length < CALIBRATION_MIN_BUCKET_SAMPLES) {
      return { minScore: bucket.minScore, calibratedPrecision: bucket.calibratedPrecision };
    }
    return {
      minScore: bucket.minScore,
      calibratedPrecision: round4(inBucket.filter((observation) => observation.correct).length / inBucket.length),
    };
  });

  // The classifier floor affects runtime behavior even while manifest prompt
  // routing is OFF. A partial cache can be badly skewed by refresh ordering
  // (for example, the first 25 rows may all be one domain), so it is not a
  // representative basis for lowering this guard. Keep the reviewed baseline
  // until every labeled corpus item has an LLM-cache observation.
  const classifierFloor = deriveClassifierFloorCalibration({
    observations: input.llmClassifier ?? [],
    corpusSize: input.corpusSize,
    baselineFloor: baseline.classifier.lowConfidenceFloor,
    target,
  });

  const calibrate = (rawScore: number): number => {
    for (const bucket of scoreBuckets) {
      if (rawScore >= bucket.minScore) return bucket.calibratedPrecision;
    }
    return scoreBuckets[scoreBuckets.length - 1]?.calibratedPrecision ?? 0;
  };
  const resolverCalibratedObservations = input.resolver.map((observation) => ({
    confidence: calibrate(observation.rawScore),
    correct: observation.correct,
  }));
  const actionableFloor = recommendThresholdMeetingTarget(resolverCalibratedObservations, target)
    ?? baseline.clarify.actionableFloor;

  return {
    version: ROUTING_CALIBRATION_VERSION,
    provenance: {
      source: 'corpus',
      corpusSize: input.corpusSize,
      generatedAt: input.generatedAt ?? new Date().toISOString(),
    },
    orchestrator: {
      branches,
      overrideThreshold: baseline.orchestrator.overrideThreshold,
    },
    classifier: {
      lowConfidenceFloor: classifierFloor.lowConfidenceFloor,
      pinnedConfidenceMin: baseline.classifier.pinnedConfidenceMin,
    },
    intentResolver: { scoreBuckets },
    clarify: {
      epsilon: baseline.clarify.epsilon,
      actionableFloor,
    },
  };
}

/**
 * Lowest threshold t (in 0.05 steps) such that observations with confidence
 * >= t are correct at least `target` of the time. Null when no observations
 * carry a confidence or no threshold qualifies.
 *
 * MIRRORS routing-accuracy.recommendClarifyThreshold exactly (M7). A static
 * import would create the cycle routing-accuracy → router/classifier →
 * intent-resolution/confidence, so the math is mirrored here and pinned to
 * the original by a parity test in
 * __tests__/services/intent-resolution/confidence.test.ts.
 */
export function recommendThresholdMeetingTarget(
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

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}
