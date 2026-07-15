// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import {
  getLearningCase,
  recordTrainingLearningObservation,
  transitionStoredLearningCase,
} from '../../src/services/product-learning';
import {
  recordPhysicalDeviceLearningObservation,
  recordTrainingCompatibilityRegression,
  recordTrainingMediaLookupObservations,
  recordTrainingPlanCorrectionObservations,
} from '../../src/services/training-learning-producers';
import { buildProductLearningObservabilityReadModel } from '../../src/services/product-learning-observability';

describe('governed Training learning producers', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createMigratedTestDatabase();
  });

  afterEach(() => {
    db.close();
  });

  it('records explicit plan and capacity corrections without persisting edited values', () => {
    const input = {
      scope: { tenantId: 7, userId: 7 },
      currentContentHash: 'a'.repeat(64),
      proposedContentHash: 'b'.repeat(64),
      changedFields: ['availableDays', 'sessionDurationMinutes'],
      observedAt: '2026-07-15T12:00:00.000Z',
    };

    expect(recordTrainingPlanCorrectionObservations(input, db).map((entry) => entry.redactedInput.kind))
      .toEqual(['plan_correction', 'capacity_conflict_accuracy']);
    expect(recordTrainingPlanCorrectionObservations(input, db)).toHaveLength(2);

    const rows = db.prepare(`
      SELECT redacted_input_json AS input, evidence_references_json AS evidence
        FROM product_learning_cases
       WHERE tenant_id = 7 AND user_id = 7
       ORDER BY case_id
    `).all() as Array<{ input: string; evidence: string }>;
    expect(rows).toHaveLength(2);
    const stored = JSON.stringify(rows);
    expect(stored).not.toContain('monday');
    expect(stored).not.toContain('sessionDurationMinutes');
    expect(stored).not.toContain('availableDays');
    expect(rows.every((row) => JSON.parse(row.input).subjectFingerprint.match(/^[a-f0-9]{64}$/))).toBe(true);
  });

  it('records compatibility fallback and daily media outcomes with opaque fingerprints', () => {
    const compatibility = recordTrainingCompatibilityRegression({
      scope: { tenantId: 7, userId: 7 },
      revisionId: 'revision-private-looking-name',
      contentHash: 'c'.repeat(64),
      observedAt: '2026-07-15T10:00:00.000Z',
      reviewModel: {
        schemaVersion: 'training-plan-review-read-model.v1',
        revisionId: 'revision-private-looking-name',
        sourceDocumentSchemaVersion: 'future-schema',
        presentationMode: 'UNKNOWN_FALLBACK',
        horizonWeeks: null,
        phases: [],
        weeks: [{
          weekNumber: 1,
          phaseKey: null,
          workouts: [{
            workoutKey: 'private-workout-key',
            sessionType: 'unknown-private-value',
            sessionTypeClassification: 'UNKNOWN',
            presentationFamily: 'unknown',
            presentationLabel: 'Unknown workout type',
            plannedDurationMinutes: null,
            isStandalone: false,
            phaseKey: null,
            blocks: [],
            fallbackUsed: true,
            newlyPrescribable: false,
          }],
        }],
      },
    }, db);
    expect(compatibility?.redactedInput).toMatchObject({
      kind: 'compatibility_regression',
      outcomeCode: 'detected',
    });

    const mediaCases = recordTrainingMediaLookupObservations({
      scope: { tenantId: 7, userId: 7 },
      observedAt: '2026-07-15T18:30:00.000Z',
      result: {
        schemaVersion: 'training_exercise_media_api.v1',
        manifestVersion: 'media-package-v1',
        catalogVersion: 'training-exercise-identity.v1',
        catalogSourceHash: 'd'.repeat(64),
        requestedLocale: 'pt-PT',
        eTag: '"opaque-etag"',
        items: [
          {
            kind: 'UNAVAILABLE',
            requestedExerciseId: 'private-exercise-alias',
            rawIdentifier: 'private-exercise-alias',
            reason: 'UNKNOWN_EXERCISE',
            textFallbackRequired: true,
          },
          {
            kind: 'UNAVAILABLE',
            requestedExerciseId: 'second-private-exercise',
            rawIdentifier: 'second-private-exercise',
            reason: 'MEDIA_UNAVAILABLE',
            textFallbackRequired: true,
          },
        ],
      } as any,
    }, db);
    expect(mediaCases.map((entry) => `${entry.redactedInput.kind}:${entry.redactedInput.outcomeCode}`).sort())
      .toEqual(['media_fallback:fallback_failed', 'media_missing_mapping:mapping_missing']);
    expect(recordTrainingMediaLookupObservations({
      scope: { tenantId: 7, userId: 7 },
      observedAt: '2026-07-15T22:00:00.000Z',
      result: {
        schemaVersion: 'training_exercise_media_api.v1',
        manifestVersion: 'media-package-v1',
        catalogVersion: 'training-exercise-identity.v1',
        catalogSourceHash: 'd'.repeat(64),
        requestedLocale: 'pt-PT',
        eTag: '"opaque-etag"',
        items: mediaCases.length ? [{
          kind: 'UNAVAILABLE', requestedExerciseId: 'private-exercise-alias', rawIdentifier: 'private-exercise-alias',
          reason: 'UNKNOWN_EXERCISE', textFallbackRequired: true,
        }, {
          kind: 'UNAVAILABLE', requestedExerciseId: 'second-private-exercise', rawIdentifier: 'second-private-exercise',
          reason: 'MEDIA_UNAVAILABLE', textFallbackRequired: true,
        }] : [],
      } as any,
    }, db)).toHaveLength(2);

    const stored = JSON.stringify(db.prepare(`
      SELECT redacted_input_json, expected_contract_json, evidence_references_json
        FROM product_learning_cases WHERE tenant_id = 7
    `).all());
    expect(stored).not.toContain('private-exercise-alias');
    expect(stored).not.toContain('private-workout-key');
    expect(stored).not.toContain('unknown-private-value');
  });

  it('requires explicit closed TestFlight evidence and keeps physical observations at observed', () => {
    const observation = {
      observationId: 'build-56-review-availability-20260715',
      tenantId: 7,
      userId: 7,
      buildNumber: '56',
      checkCode: 'review_availability' as const,
      result: 'failed' as const,
      evidenceReference: 'testflight://build/56/review-availability',
      observedAt: '2026-07-15T12:30:00.000Z',
    };
    const first = recordPhysicalDeviceLearningObservation(observation, db);
    const replay = recordPhysicalDeviceLearningObservation(observation, db);
    expect(replay.id).toBe(first.id);
    expect(first).toMatchObject({ lifecycle: 'observed', tenantId: 7, userId: 7 });
    expect(first.redactedInput).toEqual(expect.objectContaining({
      kind: 'physical_device_observation',
      outcomeCode: 'failed',
    }));
    expect(JSON.stringify(first)).not.toContain('build-56-review-availability-20260715');

    expect(() => recordPhysicalDeviceLearningObservation({
      ...observation,
      evidenceReference: 'testflight://build/55/review-availability',
    }, db)).toThrow(/exact TestFlight build and check/);
    expect(() => recordPhysicalDeviceLearningObservation({ ...observation, tenantId: 8 }, db))
      .toThrow(/contract is invalid/);
  });

  it('builds aggregate lifecycle, stale, promotion, feedback, and category coverage KPIs', () => {
    const observedAt = '2026-01-01T00:00:00.000Z';
    const expiresAt = '2027-02-01T00:00:00.000Z';
    const capacity = recordTrainingLearningObservation({
      id: 'capacity-stale-7', tenantId: 7, userId: 7,
      kind: 'capacity_conflict_accuracy', outcomeCode: 'confirmed',
      expectedContractId: 'training.capacity_conflict.v1', evidenceReferences: ['outcome://training/capacity/a'],
      producerVersion: 'training-learning-test.v1', confidence: 1, observedAt, expiresAt,
    }, db);
    transitionStoredLearningCase(7, 7, capacity.id, 'candidate', undefined, db);
    for (const [id, kind, outcomeCode, contract] of [
      ['adaptation-accepted-7', 'adaptation_accepted', 'user_approved', 'training.adaptation.activation.v1'],
      ['adaptation-rejected-7', 'adaptation_rejected', 'user_rejected', 'training.adaptation.rejection.v1'],
    ] as const) {
      recordTrainingLearningObservation({
        id, tenantId: 7, userId: 7, kind, outcomeCode, expectedContractId: contract,
        evidenceReferences: [`outcome://training/adaptation/${id}`], producerVersion: 'training-learning-test.v1',
        confidence: 1, observedAt: '2026-07-15T00:00:00.000Z', expiresAt: '2029-01-01T00:00:00.000Z',
      }, db);
    }

    const summary = buildProductLearningObservabilityReadModel({
      tenantId: 7,
      now: new Date('2028-07-15T20:00:00.000Z'),
      db,
    });
    expect(summary.schemaAvailable).toBe(true);
    expect(summary.totals).toMatchObject({ cases: 3, staleCases: 1, promotions: 1 });
    expect(summary.lifecycleCounts).toMatchObject({ observed: 2, candidate: 1 });
    expect(summary.transitionCounts).toMatchObject({ observed_to_candidate: 1 });
    expect(summary.feedback).toEqual({
      adaptationAccepted: 1,
      adaptationDismissed: 1,
      acceptanceRate: 0.5,
    });
    expect(summary.coverage.observedCategories).toBe(3);
    expect(summary.coverage.missingCategories).toContain('physical_device_observation');
    expect(getLearningCase(7, 7, capacity.id, db)?.lifecycle).toBe('candidate');
  });
});
