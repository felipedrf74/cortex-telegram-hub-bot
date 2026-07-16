// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import { recordTrainingPlanCorrectionObservations } from '../../src/services/training-learning-producers';
import { buildProductLearningObservabilityReadModel } from '../../src/services/product-learning-observability';
import {
  recordLearningCaseReviewApproval,
  recordTrainingLearningObservation,
  transitionStoredLearningCase,
  type LearningCase,
  type TrainingLearningKind,
} from '../../src/services/product-learning';

describe('product learning observability tenant isolation', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createMigratedTestDatabase();
  });

  afterEach(() => {
    db.close();
  });

  function seedReviewExecution(learningCase: LearningCase): string {
    const executionId = `execution-${learningCase.id}`;
    const intentId = `intent-${learningCase.id}`;
    const decisionId = `decision-${learningCase.id}`;
    db.prepare(`
      INSERT INTO notification_intents (
        intent_id, user_id, tenant_id, source_skill, type, priority,
        related_entity_id, related_entity_type, title, body,
        action_buttons_json, requires_user_action, status
      ) VALUES (?, ?, ?, 'training', 'product_learning_review', 'high',
        ?, 'product_learning_case', 'Review learning case', 'Review learning case',
        '[]', 1, 'delivered')
    `).run(intentId, learningCase.userId, learningCase.tenantId, learningCase.id);
    db.prepare(`
      INSERT INTO notification_center_items (
        item_id, intent_id, user_id, tenant_id, title, body, safe_body,
        source_skill, type, priority, status, actions_json, decision_state
      ) VALUES (?, ?, ?, ?, 'Review learning case', 'Review learning case',
        'Review learning case', 'training', 'product_learning_review', 'high',
        'actioned', '[]', 'completed')
    `).run(decisionId, intentId, learningCase.userId, learningCase.tenantId);
    db.prepare(`
      INSERT INTO decision_action_executions (
        action_execution_id, decision_id, action_id, user_id, tenant_id,
        idempotency_key, executor_skill, status, expected_effect_json,
        result_json, completed_at
      ) VALUES (?, ?, 'approve_product_learning_case', ?, ?, ?, 'training',
        'succeeded', '{}', ?, datetime('now', '-1 second'))
    `).run(
      executionId,
      decisionId,
      learningCase.userId,
      learningCase.tenantId,
      `idempotency-${executionId}`,
      JSON.stringify({ productLearningCaseId: learningCase.id, approved: true }),
    );
    return executionId;
  }

  function promoteToGolden(learningCase: LearningCase): LearningCase {
    const candidate = transitionStoredLearningCase(
      learningCase.tenantId,
      learningCase.userId,
      learningCase.id,
      'candidate',
      undefined,
      db,
    );
    const receipt = recordLearningCaseReviewApproval({
      tenantId: candidate.tenantId,
      userId: candidate.userId,
      caseId: candidate.id,
      actionExecutionId: seedReviewExecution(candidate),
    }, db);
    const reviewed = transitionStoredLearningCase(
      candidate.tenantId,
      candidate.userId,
      candidate.id,
      'reviewed',
      { approvalReference: receipt.approvalReference },
      db,
    );
    return transitionStoredLearningCase(
      reviewed.tenantId,
      reviewed.userId,
      reviewed.id,
      'golden',
      undefined,
      db,
    );
  }

  function recordFeedbackCase(input: {
    id: string;
    kind: Extract<TrainingLearningKind, 'adaptation_accepted' | 'adaptation_rejected'>;
    outcomeCode: 'user_approved' | 'user_rejected';
    contractId: 'training.adaptation.activation.v1' | 'training.adaptation.rejection.v1';
    expiresAt: string;
  }): LearningCase {
    return recordTrainingLearningObservation({
      id: input.id,
      tenantId: 7,
      userId: 7,
      kind: input.kind,
      outcomeCode: input.outcomeCode,
      expectedContractId: input.contractId,
      evidenceReferences: [`outcome://training/observability/${input.id}`],
      producerVersion: 'training-learning-observability-test.v1',
      confidence: 1,
      observedAt: '2026-07-15T00:00:00.000Z',
      expiresAt: input.expiresAt,
    }, db);
  }

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

  it('keeps expired golden and retired cases historical and export-ineligible', () => {
    promoteToGolden(recordFeedbackCase({
      id: 'active-golden-adaptation-accepted',
      kind: 'adaptation_accepted',
      outcomeCode: 'user_approved',
      contractId: 'training.adaptation.activation.v1',
      expiresAt: '2101-01-01T00:00:00.000Z',
    }));
    promoteToGolden(recordFeedbackCase({
      id: 'expired-golden-adaptation-rejected',
      kind: 'adaptation_rejected',
      outcomeCode: 'user_rejected',
      contractId: 'training.adaptation.rejection.v1',
      expiresAt: '2099-01-01T00:00:00.000Z',
    }));
    const retired = recordFeedbackCase({
      id: 'retired-adaptation-accepted',
      kind: 'adaptation_accepted',
      outcomeCode: 'user_approved',
      contractId: 'training.adaptation.activation.v1',
      expiresAt: '2101-01-01T00:00:00.000Z',
    });
    transitionStoredLearningCase(7, 7, retired.id, 'retired', undefined, db);

    const summary = buildProductLearningObservabilityReadModel({
      tenantId: 7,
      now: new Date('2100-01-01T00:00:00.000Z'),
      db,
    });

    expect(summary.totals).toMatchObject({
      cases: 3,
      activeCases: 1,
      historicalCases: 2,
      retiredCases: 1,
      staleCases: 1,
      exportEligibleGoldenCases: 1,
    });
    expect(summary.activity.active).toMatchObject({
      cases: 1,
      lifecycleCounts: { golden: 1, retired: 0 },
      feedback: { adaptationAccepted: 1, adaptationDismissed: 0, acceptanceRate: 1 },
    });
    expect(summary.activity.historical).toMatchObject({
      cases: 2,
      lifecycleCounts: { golden: 1, retired: 1 },
      feedback: { adaptationAccepted: 1, adaptationDismissed: 1, acceptanceRate: 0.5 },
    });
    expect(summary.categories.find((entry) => entry.kind === 'adaptation_accepted')).toMatchObject({
      observedCount: 2,
      activeCount: 1,
      historicalCount: 1,
    });
    expect(summary.categories.find((entry) => entry.kind === 'adaptation_rejected')).toMatchObject({
      observedCount: 1,
      activeCount: 0,
      historicalCount: 1,
      staleCount: 1,
    });
  });
});
