// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import { recordTrainingPlanCorrectionObservations } from '../../src/services/training-learning-producers';
import { buildProductLearningObservabilityReadModel } from '../../src/services/product-learning-observability';

describe('product learning observability tenant isolation', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createMigratedTestDatabase();
  });

  afterEach(() => {
    db.close();
  });

  it('aggregates only the requested tenant and never returns case/user payloads', () => {
    recordTrainingPlanCorrectionObservations({
      scope: { tenantId: 7, userId: 7 },
      currentContentHash: 'a'.repeat(64),
      proposedContentHash: 'b'.repeat(64),
      changedFields: ['location'],
      observedAt: '2026-07-15T10:00:00.000Z',
    }, db);
    recordTrainingPlanCorrectionObservations({
      scope: { tenantId: 8, userId: 8 },
      currentContentHash: 'c'.repeat(64),
      proposedContentHash: 'd'.repeat(64),
      changedFields: ['availableDays'],
      observedAt: '2026-07-15T11:00:00.000Z',
    }, db);

    const tenantSeven = buildProductLearningObservabilityReadModel({ tenantId: 7, db });
    const tenantEight = buildProductLearningObservabilityReadModel({ tenantId: 8, db });
    const global = buildProductLearningObservabilityReadModel({ db });

    expect(tenantSeven.totals.cases).toBe(1);
    expect(tenantSeven.categories.find((entry) => entry.kind === 'capacity_conflict_accuracy')?.observedCount).toBe(0);
    expect(tenantEight.totals.cases).toBe(2);
    expect(global.totals.cases).toBe(3);
    expect(tenantSeven.scope).toEqual({ tenantId: 7 });
    const serialized = JSON.stringify(tenantSeven);
    expect(serialized).not.toContain('userId');
    expect(serialized).not.toContain('redactedInput');
    expect(serialized).not.toContain('evidenceReferences');
    expect(serialized).not.toContain('availableDays');
  });
});
