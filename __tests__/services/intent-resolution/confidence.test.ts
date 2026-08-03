// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Milestone 14 — calibrated routing confidence table.
 *
 * Golden contracts: the embedded BOOTSTRAP table reproduces the legacy
 * constants exactly for fail-open behavior, while the checked-in config is
 * the owner-reviewed 300-item corpus calibration.
 */

import fs from 'fs';
import path from 'path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BOOTSTRAP_ROUTING_CALIBRATION,
  CALIBRATION_MIN_BUCKET_SAMPLES,
  ROUTING_CALIBRATION_VERSION,
  buildCorpusRoutingCalibration,
  calibrateIntentResolverScore,
  deriveClassifierFloorCalibration,
  getClarifyPolicy,
  getClassifierLowConfidenceFloor,
  getClassifierPinnedConfidenceMin,
  getOrchestratorBranchConfidence,
  getOrchestratorOverrideThreshold,
  isRoutingClarifyEnabled,
  parseRoutingCalibration,
  parseRoutingCalibrationForCorpusBaseline,
  recommendThresholdMeetingTarget,
  _resetRoutingCalibrationForTests,
  _setRoutingCalibrationForTests,
} from '../../../src/services/intent-resolution/confidence';
import { recommendClarifyThreshold } from '../../../src/services/routing-accuracy';

afterEach(() => {
  _resetRoutingCalibrationForTests();
});

describe('routing calibration table golden contracts', () => {
  it('reproduces the orchestrator resolveConfidence constants exactly', () => {
    expect(BOOTSTRAP_ROUTING_CALIBRATION.orchestrator.branches).toEqual({
      no_primary_domain: 0.4,
      scheduling_cross_skill: 0.96,
      scheduling: 0.92,
      destructive: 0.9,
      ambiguous_reference: 0.72,
      default: 0.84,
    });
    expect(BOOTSTRAP_ROUTING_CALIBRATION.orchestrator.overrideThreshold).toBe(0.86);
  });

  it('reproduces the classifier low-confidence pin constants exactly', () => {
    expect(BOOTSTRAP_ROUTING_CALIBRATION.classifier.lowConfidenceFloor).toBe(0.6);
    expect(BOOTSTRAP_ROUTING_CALIBRATION.classifier.pinnedConfidenceMin).toBe(0.51);
  });

  it('carries bootstrap provenance', () => {
    expect(BOOTSTRAP_ROUTING_CALIBRATION.provenance.source).toBe('bootstrap');
    expect(BOOTSTRAP_ROUTING_CALIBRATION.provenance.corpusSize).toBe(0);
  });

  it('checked-in config/routing-calibration.json is the reviewed 300-item corpus calibration', () => {
    const filePath = path.resolve(process.cwd(), 'config/routing-calibration.json');
    const fileBytes = fs.readFileSync(filePath, 'utf8');
    const parsed = parseRoutingCalibration(JSON.parse(fileBytes));
    expect(parsed).not.toBeNull();
    expect(parsed!.version).toBe(ROUTING_CALIBRATION_VERSION);
    expect(parsed!.provenance).toEqual({
      source: 'corpus',
      corpusSize: 300,
      generatedAt: '2026-08-03T05:48:45.873Z',
    });
    // Partial 25/300 LLM-cache coverage cannot lower the active classifier
    // safety floor; it stays at the reviewed bootstrap value.
    expect(parsed!.classifier).toEqual({
      lowConfidenceFloor: 0.6,
      pinnedConfidenceMin: 0.51,
    });
    expect(parsed!.orchestrator).toEqual({
      branches: {
        no_primary_domain: 0.4,
        scheduling_cross_skill: 0.96,
        scheduling: 0.7813,
        destructive: 0.8333,
        ambiguous_reference: 0.5217,
        default: 0.5251,
      },
      overrideThreshold: 0.86,
    });
    expect(parsed!.intentResolver.scoreBuckets).toEqual([
      { minScore: 5, calibratedPrecision: 0.9341 },
      { minScore: 2, calibratedPrecision: 0.9341 },
      { minScore: 1, calibratedPrecision: 0.843 },
      { minScore: 0, calibratedPrecision: 0.1633 },
    ]);
    expect(parsed!.clarify).toEqual({ epsilon: 0.05, actionableFloor: 0.2 });
    expect(createHash('sha256').update(fileBytes).digest('hex')).toBe(
      '0e22443181b7b4ed2998c1b144b10126bcc17679eb5726f41af3cd5b561be6b7',
    );
  });

  it('runtime helpers serve the bootstrap constants by default', () => {
    _setRoutingCalibrationForTests(BOOTSTRAP_ROUTING_CALIBRATION);
    expect(getOrchestratorBranchConfidence('scheduling')).toBe(0.92);
    expect(getOrchestratorBranchConfidence('default')).toBe(0.84);
    expect(getOrchestratorOverrideThreshold()).toBe(0.86);
    expect(getClassifierLowConfidenceFloor()).toBe(0.6);
    expect(getClassifierPinnedConfidenceMin()).toBe(0.51);
    expect(getClarifyPolicy()).toEqual({ epsilon: 0.05, actionableFloor: 0.6 });
  });
});

describe('parseRoutingCalibration fail-open validation', () => {
  it('rejects non-objects and missing sections', () => {
    expect(parseRoutingCalibration(null)).toBeNull();
    expect(parseRoutingCalibration('nope')).toBeNull();
    expect(parseRoutingCalibration({})).toBeNull();
    expect(parseRoutingCalibration({ ...BOOTSTRAP_ROUTING_CALIBRATION, orchestrator: undefined })).toBeNull();
  });

  it('rejects out-of-range confidences', () => {
    const bad = JSON.parse(JSON.stringify(BOOTSTRAP_ROUTING_CALIBRATION));
    bad.orchestrator.branches.scheduling = 1.7;
    expect(parseRoutingCalibration(bad)).toBeNull();
  });

  it('rejects unordered, duplicate, or non-monotonic resolver buckets', () => {
    const unordered = JSON.parse(JSON.stringify(BOOTSTRAP_ROUTING_CALIBRATION));
    [unordered.intentResolver.scoreBuckets[0], unordered.intentResolver.scoreBuckets[1]] = [
      unordered.intentResolver.scoreBuckets[1],
      unordered.intentResolver.scoreBuckets[0],
    ];
    expect(parseRoutingCalibration(unordered)).toBeNull();

    const duplicate = JSON.parse(JSON.stringify(BOOTSTRAP_ROUTING_CALIBRATION));
    duplicate.intentResolver.scoreBuckets[1].minScore = duplicate.intentResolver.scoreBuckets[0].minScore;
    expect(parseRoutingCalibration(duplicate)).toBeNull();

    const nonMonotonic = JSON.parse(JSON.stringify(BOOTSTRAP_ROUTING_CALIBRATION));
    nonMonotonic.intentResolver.scoreBuckets[1].calibratedPrecision = 0.99;
    expect(parseRoutingCalibration(nonMonotonic)).toBeNull();
    expect(parseRoutingCalibrationForCorpusBaseline(nonMonotonic)).not.toBeNull();
    expect(parseRoutingCalibrationForCorpusBaseline(unordered)).toBeNull();
    expect(parseRoutingCalibrationForCorpusBaseline(duplicate)).toBeNull();
  });

  it('rejects unsupported versions and incomplete resolver bucket topologies at both seams', () => {
    const futureVersion = JSON.parse(JSON.stringify(BOOTSTRAP_ROUTING_CALIBRATION));
    futureVersion.version = 'routing-calibration@999.0.0';

    const missingTerminalBucket = JSON.parse(JSON.stringify(BOOTSTRAP_ROUTING_CALIBRATION));
    missingTerminalBucket.intentResolver.scoreBuckets.pop();

    const changedThreshold = JSON.parse(JSON.stringify(BOOTSTRAP_ROUTING_CALIBRATION));
    changedThreshold.intentResolver.scoreBuckets[1].minScore = 3;

    const extraBucket = JSON.parse(JSON.stringify(BOOTSTRAP_ROUTING_CALIBRATION));
    extraBucket.intentResolver.scoreBuckets.splice(3, 0, {
      minScore: 0.5,
      calibratedPrecision: 0.5,
    });

    for (const candidate of [
      futureVersion,
      missingTerminalBucket,
      changedThreshold,
      extraBucket,
    ]) {
      expect(parseRoutingCalibration(candidate)).toBeNull();
      expect(parseRoutingCalibrationForCorpusBaseline(candidate)).toBeNull();
    }
  });

  it('rejects invalid provenance sources', () => {
    const bad = JSON.parse(JSON.stringify(BOOTSTRAP_ROUTING_CALIBRATION));
    bad.provenance.source = 'guess';
    expect(parseRoutingCalibration(bad)).toBeNull();
  });

  it('helpers fail open to bootstrap constants when the table is invalid/missing', () => {
    // Simulate an unusable file: reset forces a reload; the test seam injects
    // "no table" so helpers must serve the embedded bootstrap constants.
    _setRoutingCalibrationForTests(null);
    expect(getOrchestratorBranchConfidence('destructive')).toBe(0.9);
    expect(getClassifierLowConfidenceFloor()).toBe(0.6);
  });
});

describe('calibrateIntentResolverScore', () => {
  it('walks the score buckets from highest minScore down', () => {
    _setRoutingCalibrationForTests(BOOTSTRAP_ROUTING_CALIBRATION);
    expect(calibrateIntentResolverScore(6)).toBe(0.95);
    expect(calibrateIntentResolverScore(5)).toBe(0.95);
    expect(calibrateIntentResolverScore(3)).toBe(0.75);
    expect(calibrateIntentResolverScore(1.25)).toBe(0.6);
    expect(calibrateIntentResolverScore(0.25)).toBe(0.4);
    expect(calibrateIntentResolverScore(0)).toBe(0.4);
  });
});

describe('buildCorpusRoutingCalibration (synthetic labeled data)', () => {
  const makeObservations = (statedConfidence: number, total: number, correct: number) =>
    Array.from({ length: total }, (_, index) => ({ statedConfidence, correct: index < correct }));

  it('replaces a branch constant with empirical precision when the bucket has enough samples', () => {
    const table = buildCorpusRoutingCalibration({
      orchestrator: [
        ...makeObservations(0.92, 20, 15), // scheduling → 0.75 empirical
        ...makeObservations(0.84, 4, 4),   // default → below min samples, keep bootstrap
      ],
      resolver: [],
      corpusSize: 24,
      generatedAt: '2026-07-21T00:00:00.000Z',
      baseline: BOOTSTRAP_ROUTING_CALIBRATION,
    });
    expect(table.provenance).toEqual({ source: 'corpus', corpusSize: 24, generatedAt: '2026-07-21T00:00:00.000Z' });
    expect(table.orchestrator.branches.scheduling).toBe(0.75);
    expect(table.orchestrator.branches.default).toBe(0.84);
    expect(table.orchestrator.branches.destructive).toBe(0.9);
  });

  it('replaces resolver score buckets with empirical precision per bucket', () => {
    const resolver = [
      ...Array.from({ length: 10 }, (_, index) => ({ rawScore: 5, correct: index < 9 })),   // >=5 → 0.9
      ...Array.from({ length: 10 }, (_, index) => ({ rawScore: 2.5, correct: index < 6 })), // [2,5) → 0.6
      ...Array.from({ length: 3 }, () => ({ rawScore: 1, correct: true })),                 // below min samples
    ];
    const table = buildCorpusRoutingCalibration({
      orchestrator: [],
      resolver,
      corpusSize: 23,
      generatedAt: '2026-07-21T00:00:00.000Z',
      baseline: BOOTSTRAP_ROUTING_CALIBRATION,
    });
    const byMin = Object.fromEntries(table.intentResolver.scoreBuckets.map((bucket) => [bucket.minScore, bucket.calibratedPrecision]));
    expect(byMin[5]).toBe(0.9);
    expect(byMin[2]).toBe(0.6);
    expect(byMin[1]).toBe(0.6);  // bootstrap kept (only 3 samples)
    expect(byMin[0]).toBe(0.4);  // bootstrap kept (no samples)
    expect(CALIBRATION_MIN_BUCKET_SAMPLES).toBe(10);
  });

  it('uses weighted adjacent pooling when a sparse high-score prior inverts a populated bucket', () => {
    const baseline = JSON.parse(JSON.stringify(BOOTSTRAP_ROUTING_CALIBRATION));
    baseline.intentResolver.scoreBuckets = [
      { minScore: 5, calibratedPrecision: 0.8846 },
      { minScore: 2, calibratedPrecision: 0.8984 },
      { minScore: 1, calibratedPrecision: 0.7551 },
      { minScore: 0, calibratedPrecision: 0.1778 },
    ];
    const resolver = [
      { rawScore: 5, correct: true },
      ...Array.from({ length: 129 }, (_, index) => ({ rawScore: 2, correct: index < 121 })),
      ...Array.from({ length: 121 }, (_, index) => ({ rawScore: 1, correct: index < 102 })),
      ...Array.from({ length: 49 }, (_, index) => ({ rawScore: 0, correct: index < 8 })),
    ];
    const table = buildCorpusRoutingCalibration({
      orchestrator: [],
      resolver,
      corpusSize: 300,
      generatedAt: '2026-08-03T05:48:45.873Z',
      baseline,
    });
    expect(table.intentResolver.scoreBuckets).toEqual([
      { minScore: 5, calibratedPrecision: 0.9341 },
      { minScore: 2, calibratedPrecision: 0.9341 },
      { minScore: 1, calibratedPrecision: 0.843 },
      { minScore: 0, calibratedPrecision: 0.1633 },
    ]);
  });

  it('pools repeated adjacent monotonicity violations to one weighted block', () => {
    const resolver = [
      ...Array.from({ length: 10 }, (_, index) => ({ rawScore: 5, correct: index < 4 })),
      ...Array.from({ length: 10 }, (_, index) => ({ rawScore: 2, correct: index < 8 })),
      ...Array.from({ length: 10 }, (_, index) => ({ rawScore: 1, correct: index < 6 })),
      ...Array.from({ length: 10 }, (_, index) => ({ rawScore: 0, correct: index < 9 })),
    ];
    const table = buildCorpusRoutingCalibration({
      orchestrator: [],
      resolver,
      corpusSize: 40,
      generatedAt: '2026-08-03T00:00:00.000Z',
      baseline: BOOTSTRAP_ROUTING_CALIBRATION,
    });
    expect(table.intentResolver.scoreBuckets.map((bucket) => bucket.calibratedPrecision)).toEqual([
      0.675,
      0.675,
      0.675,
      0.675,
    ]);
  });

  it('derives the classifier floor and clarify actionable floor from the accuracy-target math', () => {
    // LLM observations: everything >= 0.8 is always right, 0.5 is 50/50 —
    // recommendClarifyThreshold walks 0.05 steps and returns the LOWEST
    // threshold whose above-threshold accuracy meets the 0.85 target, which
    // is 0.55 here (the first step that excludes the 0.5 bucket).
    const llm = [
      ...makeObservations(0.9, 10, 10),
      ...makeObservations(0.8, 10, 10),
      ...makeObservations(0.5, 20, 10),
    ];
    // Resolver: strong scores always right, weak scores always wrong.
    const resolver = [
      ...Array.from({ length: 20 }, () => ({ rawScore: 5, correct: true })),
      ...Array.from({ length: 20 }, () => ({ rawScore: 1, correct: false })),
    ];
    const table = buildCorpusRoutingCalibration({
      orchestrator: [],
      resolver,
      llmClassifier: llm,
      corpusSize: 40,
      generatedAt: '2026-07-21T00:00:00.000Z',
      baseline: BOOTSTRAP_ROUTING_CALIBRATION,
    });
    expect(table.classifier.lowConfidenceFloor).toBe(0.55);
    // Policy constants stay policy: pinned min and epsilon are not calibrated.
    expect(table.classifier.pinnedConfidenceMin).toBe(0.51);
    expect(table.clarify.epsilon).toBe(0.05);
    // Actionable floor: lowest calibrated-precision threshold whose
    // above-threshold resolver accuracy meets the target (buckets: >=5 → 1, >=1 → 0).
    expect(table.clarify.actionableFloor).toBeGreaterThan(0);
    expect(table.clarify.actionableFloor).toBeLessThanOrEqual(1);
  });

  it('keeps the baseline classifier floor when LLM cache coverage is partial', () => {
    expect(deriveClassifierFloorCalibration({
      observations: makeObservations(0.9, 25, 25),
      corpusSize: 300,
      baselineFloor: 0.6,
    })).toEqual({
      lowConfidenceFloor: 0.6,
      coverageComplete: false,
      calibrated: false,
    });
    expect(deriveClassifierFloorCalibration({
      observations: [],
      corpusSize: 0,
      baselineFloor: 0.6,
    })).toEqual({
      lowConfidenceFloor: 0.6,
      coverageComplete: false,
      calibrated: false,
    });

    const table = buildCorpusRoutingCalibration({
      orchestrator: [],
      resolver: [],
      llmClassifier: makeObservations(0.9, 25, 25),
      corpusSize: 300,
      generatedAt: '2026-07-30T00:00:00.000Z',
      baseline: BOOTSTRAP_ROUTING_CALIBRATION,
    });

    expect(table.classifier.lowConfidenceFloor).toBe(
      BOOTSTRAP_ROUTING_CALIBRATION.classifier.lowConfidenceFloor,
    );
  });

  it('does not claim calibration when complete LLM coverage has no qualifying threshold', () => {
    expect(deriveClassifierFloorCalibration({
      observations: makeObservations(0.9, 10, 0),
      corpusSize: 10,
      baselineFloor: 0.6,
    })).toEqual({
      lowConfidenceFloor: 0.6,
      coverageComplete: true,
      calibrated: false,
    });
  });

  it('keeps bootstrap floors when the corpus provides no usable signal', () => {
    const table = buildCorpusRoutingCalibration({
      orchestrator: [],
      resolver: [],
      corpusSize: 0,
      generatedAt: '2026-07-21T00:00:00.000Z',
      baseline: BOOTSTRAP_ROUTING_CALIBRATION,
    });
    expect(table.classifier.lowConfidenceFloor).toBe(0.6);
    expect(table.clarify.actionableFloor).toBe(0.6);
    expect(table.provenance.source).toBe('corpus');
  });
});

describe('recommendThresholdMeetingTarget mirrors routing-accuracy math', () => {
  it('agrees with recommendClarifyThreshold on representative fixtures', () => {
    const fixtures: Array<Array<{ confidence?: number; correct: boolean }>> = [
      [],
      [{ correct: true }],
      [{ confidence: 0.9, correct: true }, { confidence: 0.9, correct: false }],
      [
        { confidence: 0.95, correct: true },
        { confidence: 0.9, correct: true },
        { confidence: 0.5, correct: false },
        { confidence: 0.3, correct: false },
      ],
      Array.from({ length: 40 }, (_, index) => ({
        confidence: (index % 20) / 20,
        correct: index % 3 !== 0,
      })),
    ];
    for (const observations of fixtures) {
      for (const target of [0.5, 0.85, 0.99]) {
        expect(recommendThresholdMeetingTarget(observations, target))
          .toBe(recommendClarifyThreshold(observations, target));
      }
    }
  });
});

describe('isRoutingClarifyEnabled', () => {
  it('defaults OFF', () => {
    expect(isRoutingClarifyEnabled({})).toBe(false);
  });

  it('turns on with AI_ROUTING_CLARIFY', () => {
    expect(isRoutingClarifyEnabled({ AI_ROUTING_CLARIFY: 'true' })).toBe(true);
    expect(isRoutingClarifyEnabled({ AI_ROUTING_CLARIFY: '1' })).toBe(true);
    expect(isRoutingClarifyEnabled({ AI_ROUTING_CLARIFY: 'false' })).toBe(false);
  });

  it('is suppressed by the manifest-routing master kill', () => {
    expect(isRoutingClarifyEnabled({ AI_ROUTING_CLARIFY: 'true', AI_ROUTING_MANIFEST_KILL: 'true' })).toBe(false);
  });
});
