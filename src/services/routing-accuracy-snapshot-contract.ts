// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Provider-free contract for persisted accepted routing-accuracy snapshots.
 *
 * Keep this module dependency-free: release tooling loads its compiled output
 * to validate a stored ratchet without initializing classifiers, providers,
 * database singletons, or network clients.
 */

export const ROUTING_ACCURACY_VERSION = 'routing-accuracy@1.1.0';

export const ROUTING_ACCURACY_SURFACES = [
  'classifier_keyword',
  'shadow_route_guess',
  'orchestrator_analyze',
  'intent_resolver',
  'llm_classify_cache',
] as const;

export const ROUTING_ACCURACY_SNAPSHOT_MINIMUM_LABELED_ITEMS = 300;

export type RoutingAccuracySurface = (typeof ROUTING_ACCURACY_SURFACES)[number];

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

/**
 * Parse one persisted accepted snapshot. Error text and JSON parse causes are
 * part of the fail-closed release contract.
 */
export function parseAcceptedRoutingAccuracySnapshot(
  snapshotJson: string,
): RoutingAccuracyReport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(snapshotJson);
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

export function isRoutingAccuracyReport(value: unknown): value is RoutingAccuracyReport {
  if (!value || typeof value !== 'object') return false;
  const report = value as Partial<RoutingAccuracyReport>;
  if (
    typeof report.version !== 'string'
    || typeof report.generatedAt !== 'string'
    || !isNonNegativeInteger(report.itemCount)
    || report.itemCount < ROUTING_ACCURACY_SNAPSHOT_MINIMUM_LABELED_ITEMS
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

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNullableFiniteNumber(value: unknown): value is number | null {
  return value === null || isFiniteNumber(value);
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

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}
