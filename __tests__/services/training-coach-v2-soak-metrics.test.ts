// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
}));

import {
  getTrainingCoachV2SoakSnapshot,
  recordTrainingCoachV2AcceptedPlanWeek,
  recordTrainingCoachV2RuleFirings,
  recordTrainingCoachV2RuleReview,
  TRAINING_COACH_V2_LAUNCH_RULE_SET,
  TRAINING_COACH_V2_LAUNCH_RULE_SET_DIGEST,
  TrainingCoachV2SoakMetricError,
} from '../../src/services/training-coach-v2-soak-metrics';
import { getSciencePolicyVersion } from '../../src/services/coach-kernel/training-principles';
import { loadCoachKnowledge } from '../../src/services/coach-kernel/knowledge-loader';

const FROM = '2026-08-01T00:00:00.000Z';
const TO = '2026-08-31T23:59:59.999Z';

describe('Training Coach V2 durable soak metrics', () => {
  beforeEach(() => {
    testDb = createMigratedTestDatabase();
  });
  afterEach(() => testDb.close());

  it('fails closed on insufficient samples and exact threshold boundaries', () => {
    for (let index = 0; index < 100; index += 1) {
      const proposalId = `threshold-${index}`;
      recordTrainingCoachV2RuleFirings({
        tenantId: 1,
        userId: 1,
        proposalId,
        evidence: { reasonCodes: ['deload_applied'] },
        firedAt: FROM,
        db: testDb,
      });
      recordTrainingCoachV2RuleReview({
        tenantId: 1,
        userId: 1,
        proposalId,
        ruleId: 'deload_applied',
        outcome: index < 5 ? 'incorrect' : 'correct',
        idempotencyKey: `review-threshold-${index}`,
        reviewedAt: FROM,
        db: testDb,
      });
    }
    const snapshot = getTrainingCoachV2SoakSnapshot({ from: FROM, to: TO, db: testDb });
    expect(snapshot.rules.find((rule) => rule.ruleId === 'deload_applied')).toEqual(expect.objectContaining({
      ruleId: 'deload_applied',
      reviewedFirings: 100,
      falsePositiveRate: 0.05,
      sampleReady: true,
      thresholdPassed: false,
      verdict: 'NO_GO',
    }));
    expect(snapshot.churn).toMatchObject({ adaptedPlanWeeks: 0, sampleReady: false, verdict: 'NO_GO' });
    expect(snapshot.verdict).toBe('NO_GO');
  });

  it('calculates per-rule false positives and seven-day non-safety churn across durable rows', () => {
    for (let index = 0; index < 100; index += 1) {
      const proposalId = `go-${index}`;
      recordTrainingCoachV2RuleFirings({
        tenantId: 2,
        userId: 2,
        proposalId,
        evidence: { reasonCodes: [...TRAINING_COACH_V2_LAUNCH_RULE_SET.ruleIds] },
        firedAt: '2026-08-10T00:00:00.000Z',
        db: testDb,
      });
      for (const ruleId of TRAINING_COACH_V2_LAUNCH_RULE_SET.ruleIds) {
        recordTrainingCoachV2RuleReview({
          tenantId: 2,
          userId: 2,
          proposalId,
          ruleId,
          outcome: index < 4 ? 'incorrect' : 'correct',
          idempotencyKey: `review-go-${ruleId}-${index}`,
          reviewedAt: '2026-08-10T01:00:00.000Z',
          db: testDb,
        });
      }
      recordTrainingCoachV2AcceptedPlanWeek({
        tenantId: 2,
        userId: 2,
        proposalId,
        planId: 2000 + index,
        weekId: 3000 + index,
        evidence: { reasonCodes: ['minimum_viable_week'] },
        acceptedAt: '2026-08-10T02:00:00.000Z',
        db: testDb,
      });
      if (index < 20) {
        recordTrainingCoachV2AcceptedPlanWeek({
          tenantId: 2,
          userId: 2,
          proposalId: `go-followup-${index}`,
          planId: 2000 + index,
          weekId: 3000 + index,
          evidence: { reasonCodes: ['deload_applied'] },
          acceptedAt: '2026-08-14T02:00:00.000Z',
          db: testDb,
        });
      }
    }
    const snapshot = getTrainingCoachV2SoakSnapshot({ from: FROM, to: TO, db: testDb });
    expect(snapshot.rules.find((rule) => rule.ruleId === 'minimum_viable_week')).toMatchObject({
      reviewedFirings: 100,
      incorrectReviewedFirings: 4,
      falsePositiveRate: 0.04,
      verdict: 'GO',
    });
    expect(snapshot.churn).toMatchObject({
      adaptedPlanWeeks: 100,
      churnedPlanWeeks: 20,
      sampleReady: true,
      thresholdPassed: true,
      verdict: 'GO',
    });
    expect(snapshot.churn.churnRate).toBeCloseTo(0.2);
    expect(snapshot.verdict).toBe('GO');
  });

  it('pins every enabled launch rule to the current science-policy configuration', () => {
    const snapshot = getTrainingCoachV2SoakSnapshot({ from: FROM, to: TO, db: testDb });
    expect(snapshot.ruleSet).toEqual({
      contractVersion: TRAINING_COACH_V2_LAUNCH_RULE_SET.contractVersion,
      sciencePolicyVersion: getSciencePolicyVersion(loadCoachKnowledge().principles),
      configurationDigest: TRAINING_COACH_V2_LAUNCH_RULE_SET_DIGEST,
      ruleIds: TRAINING_COACH_V2_LAUNCH_RULE_SET.ruleIds,
    });
    expect(snapshot.rules).toHaveLength(TRAINING_COACH_V2_LAUNCH_RULE_SET.ruleIds.length);
    expect(snapshot.rules.every((rule) => rule.verdict === 'NO_GO')).toBe(true);
    expect(snapshot.verdict).toBe('NO_GO');
  });

  it('excludes adaptations that have not completed the seven-day observation window', () => {
    for (let index = 0; index < 100; index += 1) {
      recordTrainingCoachV2AcceptedPlanWeek({
        tenantId: 9,
        userId: 9,
        proposalId: `recent-${index}`,
        planId: 9000 + index,
        weekId: 10000 + index,
        evidence: { reasonCodes: ['minimum_viable_week'] },
        acceptedAt: '2026-08-30T00:00:00.000Z',
        db: testDb,
      });
    }

    const snapshot = getTrainingCoachV2SoakSnapshot({ from: FROM, to: TO, db: testDb });
    expect(snapshot.churn).toMatchObject({
      adaptedPlanWeeks: 0,
      churnedPlanWeeks: 0,
      churnRate: null,
      sampleReady: false,
      thresholdPassed: false,
      verdict: 'NO_GO',
    });
  });

  it('binds reviews to scoped firings with idempotent conflict protection', () => {
    recordTrainingCoachV2RuleFirings({
      tenantId: 3,
      userId: 3,
      proposalId: 'bound-proposal',
      evidence: { reasonCodes: ['medical_referral+deload_applied', 'INVALID VALUE'] },
      firedAt: FROM,
      db: testDb,
    });
    const first = recordTrainingCoachV2RuleReview({
      tenantId: 3,
      userId: 3,
      proposalId: 'bound-proposal',
      ruleId: 'medical_referral',
      outcome: 'correct',
      idempotencyKey: 'bound-review',
      db: testDb,
    });
    const replay = recordTrainingCoachV2RuleReview({
      tenantId: 3,
      userId: 3,
      proposalId: 'bound-proposal',
      ruleId: 'medical_referral',
      outcome: 'correct',
      idempotencyKey: 'bound-review',
      db: testDb,
    });
    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(() => recordTrainingCoachV2RuleReview({
      tenantId: 3,
      userId: 3,
      proposalId: 'bound-proposal',
      ruleId: 'medical_referral',
      outcome: 'incorrect',
      idempotencyKey: 'bound-review',
      db: testDb,
    })).toThrow(expect.objectContaining<Partial<TrainingCoachV2SoakMetricError>>({ code: 'IDEMPOTENCY_CONFLICT' }));
    expect(() => recordTrainingCoachV2RuleReview({
      tenantId: 4,
      userId: 3,
      proposalId: 'bound-proposal',
      ruleId: 'medical_referral',
      outcome: 'correct',
      idempotencyKey: 'foreign-review',
      db: testDb,
    })).toThrow(expect.objectContaining<Partial<TrainingCoachV2SoakMetricError>>({ code: 'RULE_FIRING_NOT_FOUND' }));
  });
});
