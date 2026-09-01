import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createTrainingLearningCase,
  getLearningCase,
  listLearningCases,
  promoteLearningCase,
  recordLearningCaseReviewApproval,
  recordTrainingLearningObservation,
  storeLearningCase,
  transitionStoredLearningCase,
  validateLearningCase,
  type LearningCase,
} from '../../src/services/product-learning';
import { withDatabaseForTest, withDatabaseForTestAsync } from '../../src/services/database';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import {
  deleteAllUserData as deleteAllUserDataWithToken,
  exportAllUserData,
} from '../../src/services/user-data-export';
import {
  beginSkillInferenceAccountDeletionFence,
  clearSkillInferenceAccountDeletionFence,
} from '../../src/services/skill-inference-account-lifecycle';
import { createDecisionIntent, performDecisionAction } from '../../src/services/decision-center';
import { buildSkillNotificationFixtureIntent } from '../../src/services/notification-orchestrator';

let db: Database.Database;

function scoped<T>(callback: () => T): T {
  return withDatabaseForTest(db, callback);
}

function deleteAllUserData(userId: number): Record<string, number> {
  const fenceToken = beginSkillInferenceAccountDeletionFence(userId, db);
  try {
    return deleteAllUserDataWithToken(userId, fenceToken);
  } catch (error) {
    clearSkillInferenceAccountDeletionFence(userId, fenceToken, db);
    throw error;
  }
}

interface ReviewExecutionSeed {
  tenantId?: number;
  userId?: number;
  caseId: string;
  executionId?: string;
  actionId?: string;
  resultCaseId?: string;
  approved?: boolean;
  status?: string;
  completedAt?: 'past' | 'future';
}

function seedCompletedLearningReviewExecution(input: ReviewExecutionSeed): string {
  const tenantId = input.tenantId ?? 42;
  const userId = input.userId ?? tenantId;
  const executionId = input.executionId ?? `execution-${tenantId}-${userId}-${input.caseId}`;
  const intentId = `intent-${executionId}`;
  const decisionId = `decision-${executionId}`;
  db.prepare(`
    INSERT INTO notification_intents (
      intent_id, user_id, tenant_id, source_skill, type, priority,
      related_entity_id, related_entity_type, title, body,
      action_buttons_json, requires_user_action, status
    ) VALUES (?, ?, ?, 'training', 'product_learning_review', 'high',
      ?, 'product_learning_case', 'Review learning case', 'Review learning case',
      '[]', 1, 'delivered')
  `).run(intentId, userId, tenantId, input.caseId);
  db.prepare(`
    INSERT INTO notification_center_items (
      item_id, intent_id, user_id, tenant_id, title, body, safe_body,
      source_skill, type, priority, status, actions_json, decision_state
    ) VALUES (?, ?, ?, ?, 'Review learning case', 'Review learning case',
      'Review learning case', 'training', 'product_learning_review', 'high',
      'actioned', '[]', 'completed')
  `).run(decisionId, intentId, userId, tenantId);
  const completedAtExpression = input.completedAt === 'future'
    ? "datetime('now', '+1 day')"
    : "datetime('now', '-1 second')";
  db.prepare(`
    INSERT INTO decision_action_executions (
      action_execution_id, decision_id, action_id, user_id, tenant_id,
      idempotency_key, executor_skill, status, expected_effect_json,
      result_json, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'training', ?, '{}', ?, ${completedAtExpression})
  `).run(
    executionId,
    decisionId,
    input.actionId ?? 'approve_product_learning_case',
    userId,
    tenantId,
    `idempotency-${executionId}`,
    input.status ?? 'succeeded',
    JSON.stringify({
      productLearningCaseId: input.resultCaseId ?? input.caseId,
      approved: input.approved ?? true,
    }),
  );
  return executionId;
}

function approveCandidate(candidate: LearningCase, executionId?: string) {
  const actionExecutionId = seedCompletedLearningReviewExecution({
    tenantId: candidate.tenantId,
    userId: candidate.userId,
    caseId: candidate.id,
    executionId,
  });
  return recordLearningCaseReviewApproval({
    tenantId: candidate.tenantId,
    userId: candidate.userId,
    caseId: candidate.id,
    actionExecutionId,
  }, db);
}

const observed = (tenantId = 42, userId = tenantId, id = `training-capacity-correction-${tenantId}`): LearningCase => ({
  id,
  tenantId,
  userId,
  owner: 'training',
  lifecycle: 'observed',
  privacyClass: 'redacted-product',
  redactedInput: { kind: 'capacity_conflict_accuracy', outcomeCode: 'corrected' },
  expectedContract: { contractId: 'training.capacity_conflict.v1' },
  evidenceReferences: ['ci://run/123/case/1'],
  producerVersion: 'training-learning.v1',
  confidence: 0.9,
  observedAt: '2026-07-15T00:00:00.000Z',
  expiresAt: '2099-01-11T00:00:00.000Z',
});

describe('governed product learning', () => {
  beforeEach(() => {
    db = createMigratedTestDatabase();
  });

  afterEach(() => {
    db.close();
  });

  it('rejects raw private fields and private-looking values', () => {
    expect(validateLearningCase({ ...observed(), redactedInput: { calendarContents: 'private' } }))
      .toContain('redaction_failed');
    expect(validateLearningCase({ ...observed(), expectedContract: { note: 'person@example.com' } }))
      .toContain('redaction_failed');
    expect(validateLearningCase({ ...observed(), redactedInput: {
      kind: 'capacity_conflict_accuracy', outcomeCode: 'corrected', note: 'private medical condition at home',
    } })).toContain('training_taxonomy_invalid');
    expect(validateLearningCase({ ...observed(), evidenceReferences: ['external://person@example.com/case'] }))
      .toContain('evidence_reference_invalid');
    expect(validateLearningCase({
      ...observed(),
      evidenceReferences: ['event://training/adaptation/98082612-9468-4e38-9775-adfb5eaca5fa'],
    })).not.toContain('evidence_reference_invalid');
    expect(validateLearningCase({
      ...observed(),
      evidenceReferences: ['event://training/adaptation/98082612-9468'],
    })).toContain('evidence_reference_invalid');
  });

  it('requires ordered review and evidence before golden promotion', () => {
    expect(() => promoteLearningCase(observed(), 'golden')).toThrow(/observed->golden/);
    storeLearningCase(observed(), db);
    const candidate = transitionStoredLearningCase(42, 42, observed().id, 'candidate', undefined, db);
    expect(() => promoteLearningCase(candidate, 'reviewed', undefined, db))
      .toThrow(/trusted learning review approval receipt is required/);
    const receipt = approveCandidate(candidate);
    expect(() => promoteLearningCase(candidate, 'reviewed', {
      approvalReference: receipt.approvalReference,
      reviewedAt: '2099-01-01T00:00:00.000Z',
    } as any, db)).toThrow(/server-authoritative/);
    const reviewed = promoteLearningCase(candidate, 'reviewed', {
      approvalReference: receipt.approvalReference,
    }, db);
    expect(() => promoteLearningCase({ ...reviewed, evidenceReferences: [] }, 'golden'))
      .toThrow(/trusted learning review approval database is required/);
    expect(() => promoteLearningCase({ ...reviewed, evidenceReferences: [] }, 'golden', undefined, db))
      .toThrow(/golden_requires_evidence/);
    expect(promoteLearningCase(reviewed, 'golden', undefined, db)).toMatchObject({
      lifecycle: 'golden',
      reviewedAt: receipt.reviewedAt,
      reviewedBy: 'user:42',
      reviewApprovalReference: receipt.approvalReference,
    });
  });

  it('stores, reads, and transitions only inside the exact tenant scope', () => {
    scoped(() => {
      storeLearningCase(observed(42));
      storeLearningCase(observed(77));

      expect(getLearningCase(42, 42, observed(42).id)?.tenantId).toBe(42);
      expect(getLearningCase(77, 77, observed(42).id)).toBeNull();
      expect(listLearningCases(42, 42)).toHaveLength(1);
      expect(listLearningCases(77, 77)).toHaveLength(1);

      const candidate = transitionStoredLearningCase(42, 42, observed(42).id, 'candidate');
      const receipt = approveCandidate(candidate);
      const reviewed = transitionStoredLearningCase(42, 42, candidate.id, 'reviewed', {
        approvalReference: receipt.approvalReference,
      });
      const golden = transitionStoredLearningCase(42, 42, reviewed.id, 'golden');
      expect(golden.lifecycle).toBe('golden');
      expect(golden.reviewedAt).toBe(receipt.reviewedAt);
      expect(listLearningCases(42, 42, 'golden')).toHaveLength(1);
      expect(db.prepare(`
        SELECT from_lifecycle AS fromLifecycle, to_lifecycle AS toLifecycle,
               actor, approval_reference AS approvalReference
          FROM product_learning_case_transitions
         WHERE tenant_id = 42 AND user_id = 42 AND case_id = ?
         ORDER BY rowid
      `).all(golden.id)).toEqual([
        { fromLifecycle: null, toLifecycle: 'observed', actor: 'system:observation', approvalReference: null },
        { fromLifecycle: 'observed', toLifecycle: 'candidate', actor: 'system:lifecycle', approvalReference: null },
        { fromLifecycle: 'candidate', toLifecycle: 'reviewed', actor: 'user:42', approvalReference: receipt.approvalReference },
        { fromLifecycle: 'reviewed', toLifecycle: 'golden', actor: 'system:lifecycle', approvalReference: null },
      ]);
    });
  });

  it('creates the review receipt through the authenticated Decision Center action path', async () => {
    const priorDecisionFlow = process.env.DECISION_FLOW_V1_ENFORCE_ENABLED;
    const priorTrainingFlow = process.env.TRAINING_DECISION_FLOW_V1_ENFORCE_ENABLED_USER_42;
    process.env.DECISION_FLOW_V1_ENFORCE_ENABLED = 'false';
    process.env.TRAINING_DECISION_FLOW_V1_ENFORCE_ENABLED_USER_42 = 'false';
    try {
      await withDatabaseForTestAsync(db, async () => {
        storeLearningCase(observed());
        const candidate = transitionStoredLearningCase(42, 42, observed().id, 'candidate');
        const created = await createDecisionIntent(buildSkillNotificationFixtureIntent('training', 42, {
          type: 'approval_required',
          priority: 'time_sensitive',
          relatedEntityId: candidate.id,
          relatedEntityType: 'product_learning_case',
          title: 'Learning case needs review',
          body: 'Review this redacted product learning case before promotion.',
          actionButtons: [{ id: 'approve_product_learning_case', label: 'Approve review', style: 'primary' }],
          dedupeKey: `training:product-learning-review:${candidate.id}`,
          requiresUserAction: true,
        }));
        expect(created.item?.actions).toEqual(expect.arrayContaining([
          expect.objectContaining({ id: 'approve_product_learning_case' }),
        ]));
        await expect(performDecisionAction(
          created.item!.decisionId,
          'approve_product_learning_case',
          42,
          42,
          {
            idempotencyKey: 'reject-apns-learning-approval',
            channel: 'apns',
            expectedVersion: created.item!.recordVersion,
            contextVersion: created.item!.contextVersion,
          },
        )).rejects.toMatchObject({ code: 'APNS_ACTION_NOT_ALLOWED' });

        const action = await performDecisionAction(
          created.item!.decisionId,
          'approve_product_learning_case',
          42,
          42,
          {
            idempotencyKey: 'approve-learning-case',
            expectedVersion: created.item!.recordVersion,
            contextVersion: created.item!.contextVersion,
          },
        );
        expect(action).toMatchObject({
          status: 'succeeded',
          verification: {
            readBackOk: true,
            actualEffect: {
              productLearningCaseId: candidate.id,
              approved: true,
              approvalReference: expect.stringMatching(/^approval:\/\/product-learning\/[a-f0-9]{64}$/),
            },
          },
        });
        const receipt = db.prepare(`
          SELECT approval_reference AS approvalReference,
                 action_execution_id AS actionExecutionId
            FROM product_learning_case_review_approvals
           WHERE tenant_id = 42 AND user_id = 42 AND case_id = ?
        `).get(candidate.id) as { approvalReference: string; actionExecutionId: string };
        const reviewed = transitionStoredLearningCase(42, 42, candidate.id, 'reviewed', {
          approvalReference: receipt.approvalReference,
        });
        expect(reviewed.reviewedBy).toBe('user:42');

        const replay = await performDecisionAction(
          created.item!.decisionId,
          'approve_product_learning_case',
          42,
          42,
          {
            idempotencyKey: 'approve-learning-case',
            expectedVersion: created.item!.recordVersion,
            contextVersion: created.item!.contextVersion,
          },
        );
        expect(replay).toMatchObject({ status: 'idempotent', idempotent: true });
      });
    } finally {
      if (priorDecisionFlow === undefined) delete process.env.DECISION_FLOW_V1_ENFORCE_ENABLED;
      else process.env.DECISION_FLOW_V1_ENFORCE_ENABLED = priorDecisionFlow;
      if (priorTrainingFlow === undefined) delete process.env.TRAINING_DECISION_FLOW_V1_ENFORCE_ENABLED_USER_42;
      else process.env.TRAINING_DECISION_FLOW_V1_ENFORCE_ENABLED_USER_42 = priorTrainingFlow;
    }
  });

  it('supports the same user and case id in distinct tenant scopes without cross-scope reads', () => {
    scoped(() => {
      const first = observed(44, 7, 'shared-training-case');
      const second = { ...observed(55, 7, 'shared-training-case'), evidenceReferences: ['ci://run/123/case/2'] };
      storeLearningCase(first);
      storeLearningCase(second);
      expect(getLearningCase(44, 7, first.id)?.evidenceReferences).toEqual(first.evidenceReferences);
      expect(getLearningCase(55, 7, second.id)?.evidenceReferences).toEqual(second.evidenceReferences);
      expect(getLearningCase(44, 8, first.id)).toBeNull();
    });
  });

  it('rejects fake, missing, future, mismatched, and cross-tenant review approvals', () => {
    scoped(() => {
      const first = observed(44, 7, 'shared-approval-case');
      const second = { ...observed(55, 7, 'shared-approval-case'), evidenceReferences: ['ci://run/123/case/2'] };
      storeLearningCase(first);
      storeLearningCase(second);
      const firstCandidate = transitionStoredLearningCase(44, 7, first.id, 'candidate');
      transitionStoredLearningCase(55, 7, second.id, 'candidate');

      expect(() => transitionStoredLearningCase(44, 7, firstCandidate.id, 'reviewed', {
        approvalReference: `approval://product-learning/${'f'.repeat(64)}`,
      })).toThrow(/missing or outside tenant scope/);
      expect(() => recordLearningCaseReviewApproval({
        tenantId: 44,
        userId: 7,
        caseId: firstCandidate.id,
        actionExecutionId: 'missing-execution',
      }, db)).toThrow(/completed scoped Decision Center execution/);

      const scopedExecution = seedCompletedLearningReviewExecution({
        tenantId: 44,
        userId: 7,
        caseId: firstCandidate.id,
        executionId: 'execution-cross-tenant',
      });
      expect(() => recordLearningCaseReviewApproval({
        tenantId: 55,
        userId: 7,
        caseId: second.id,
        actionExecutionId: scopedExecution,
      }, db)).toThrow(/completed scoped Decision Center execution/);

      const futureExecution = seedCompletedLearningReviewExecution({
        tenantId: 44,
        userId: 7,
        caseId: firstCandidate.id,
        executionId: 'execution-future',
        completedAt: 'future',
      });
      expect(() => recordLearningCaseReviewApproval({
        tenantId: 44,
        userId: 7,
        caseId: firstCandidate.id,
        actionExecutionId: futureExecution,
      }, db)).toThrow(/completed scoped Decision Center execution/);

      const mismatchedExecution = seedCompletedLearningReviewExecution({
        tenantId: 44,
        userId: 7,
        caseId: firstCandidate.id,
        executionId: 'execution-wrong-case-result',
        resultCaseId: 'different-learning-case',
      });
      expect(() => recordLearningCaseReviewApproval({
        tenantId: 44,
        userId: 7,
        caseId: firstCandidate.id,
        actionExecutionId: mismatchedExecution,
      }, db)).toThrow(/completed scoped Decision Center execution/);

      expect(() => db.prepare(`
        INSERT INTO product_learning_case_review_approvals (
          approval_reference, tenant_id, user_id, case_id, action_execution_id,
          decision_id, action_id, reviewed_by, reviewed_at
        ) VALUES (?, 44, 7, ?, 'fake-execution', 'fake-decision',
          'approve_product_learning_case', 'user:7', datetime('now', '-1 second'))
      `).run(`approval://product-learning/${'e'.repeat(64)}`, firstCandidate.id))
        .toThrow(/completed scoped Decision Center execution/);
    });
  });

  it('revalidates the immutable approval receipt before golden promotion', () => {
    scoped(() => {
      storeLearningCase(observed());
      const candidate = transitionStoredLearningCase(42, 42, observed().id, 'candidate');
      const receipt = approveCandidate(candidate, 'execution-golden-revalidation');
      const reviewed = transitionStoredLearningCase(42, 42, candidate.id, 'reviewed', {
        approvalReference: receipt.approvalReference,
      });
      expect(() => db.prepare(`
        UPDATE product_learning_case_review_approvals SET reviewed_by = 'user:7'
         WHERE approval_reference = ?
      `).run(receipt.approvalReference)).toThrow(/append-only/);
      expect(() => db.prepare(`
        DELETE FROM product_learning_case_review_approvals WHERE approval_reference = ?
      `).run(receipt.approvalReference)).toThrow(/erasure authorization/);
      expect(() => db.prepare(`
        DELETE FROM decision_action_executions WHERE action_execution_id = ?
      `).run(receipt.actionExecutionId)).toThrow(/FOREIGN KEY constraint/);
      expect(() => db.prepare(`
        DELETE FROM notification_center_items WHERE item_id = ?
      `).run(receipt.decisionId)).toThrow(/FOREIGN KEY constraint/);
      db.prepare(`UPDATE decision_action_executions SET status = 'failed' WHERE action_execution_id = ?`)
        .run(receipt.actionExecutionId);
      expect(() => transitionStoredLearningCase(42, 42, reviewed.id, 'golden'))
        .toThrow(/missing or outside tenant scope/);
      expect(() => db.prepare(`
        UPDATE product_learning_cases SET lifecycle = 'golden'
         WHERE tenant_id = 42 AND user_id = 42 AND case_id = ?
      `).run(reviewed.id)).toThrow(/invalid product learning case lifecycle/);
      db.prepare(`UPDATE decision_action_executions SET status = 'succeeded' WHERE action_execution_id = ?`)
        .run(receipt.actionExecutionId);
      expect(transitionStoredLearningCase(42, 42, reviewed.id, 'golden').lifecycle).toBe('golden');
    });
  });

  it('preserves immutable review proof when reviewed and golden cases retire', () => {
    scoped(() => {
      storeLearningCase(observed());
      const candidate = transitionStoredLearningCase(42, 42, observed().id, 'candidate');
      const receipt = approveCandidate(candidate, 'execution-reviewed-retirement');
      const reviewed = transitionStoredLearningCase(42, 42, candidate.id, 'reviewed', {
        approvalReference: receipt.approvalReference,
      });
      const retiredReviewed = transitionStoredLearningCase(42, 42, reviewed.id, 'retired');
      expect(retiredReviewed).toMatchObject({
        lifecycle: 'retired',
        reviewedAt: receipt.reviewedAt,
        reviewedBy: receipt.reviewedBy,
        reviewApprovalReference: receipt.approvalReference,
      });

      const goldenCase = observed(42, 42, 'golden-retirement-case');
      storeLearningCase(goldenCase);
      const goldenCandidate = transitionStoredLearningCase(42, 42, goldenCase.id, 'candidate');
      const goldenReceipt = approveCandidate(goldenCandidate, 'execution-golden-retirement');
      const goldenReviewed = transitionStoredLearningCase(42, 42, goldenCase.id, 'reviewed', {
        approvalReference: goldenReceipt.approvalReference,
      });
      transitionStoredLearningCase(42, 42, goldenReviewed.id, 'golden');
      const retiredGolden = transitionStoredLearningCase(42, 42, goldenReviewed.id, 'retired');
      expect(retiredGolden).toMatchObject({
        lifecycle: 'retired',
        reviewedAt: goldenReceipt.reviewedAt,
        reviewedBy: goldenReceipt.reviewedBy,
        reviewApprovalReference: goldenReceipt.approvalReference,
      });
    });
  });

  it('rejects evidence mutation and invalid lifecycle transitions at the database boundary', () => {
    scoped(() => {
      storeLearningCase(observed());
      expect(() => db.prepare(`
        UPDATE product_learning_cases SET redacted_input_json = '{}' WHERE case_id = ?
      `).run(observed().id)).toThrow(/evidence is immutable/);
      expect(() => db.prepare(`
        UPDATE product_learning_cases SET lifecycle = 'golden' WHERE case_id = ?
      `).run(observed().id)).toThrow(/invalid product learning case lifecycle/);
      expect(() => db.prepare(`
        UPDATE product_learning_cases SET reviewed_at = datetime('now') WHERE case_id = ?
      `).run(observed().id)).toThrow(/review evidence is immutable/);
      expect(() => db.prepare(`
        UPDATE product_learning_case_transitions SET actor = 'tampered' WHERE case_id = ?
      `).run(observed().id)).toThrow(/append-only/);
      expect(() => db.prepare(`
        DELETE FROM product_learning_case_transitions WHERE case_id = ?
      `).run(observed().id)).toThrow(/erasure authorization/);
    });
  });

  it('enforces taxonomy and PII boundaries for direct database writes', () => {
    scoped(() => {
      const insert = db.prepare(`
        INSERT INTO product_learning_cases (
          case_id, tenant_id, user_id, owner, lifecycle, privacy_class,
          redacted_input_json, expected_contract_json, evidence_references_json,
          producer_version, confidence, observed_at, expires_at
        ) VALUES (?, 42, 42, 'training', 'observed', 'redacted-product', ?, ?, ?,
          'training-learning.v1', 1, '2026-07-15T00:00:00.000Z', '2099-01-11T00:00:00.000Z')
      `);
      expect(() => insert.run(
        'raw-private-case',
        JSON.stringify({
          kind: 'capacity_conflict_accuracy',
          outcomeCode: 'corrected',
          note: 'private medical condition at home',
        }),
        JSON.stringify({ contractId: 'training.capacity_conflict.v1' }),
        JSON.stringify(['ci://run/1/case/1']),
      )).toThrow(/taxonomy or privacy boundary/);
      expect(() => insert.run(
        'pii-evidence-case',
        JSON.stringify({ kind: 'capacity_conflict_accuracy', outcomeCode: 'corrected' }),
        JSON.stringify({ contractId: 'training.capacity_conflict.v1' }),
        JSON.stringify(['external://person@example.com/case']),
      )).toThrow(/taxonomy or privacy boundary/);
    });
  });

  it('records only closed-taxonomy, fingerprinted Training observations', () => {
    const observation = {
      id: 'training-adaptation-rejected-42-a1',
      tenantId: 42,
      userId: 42,
      kind: 'adaptation_rejected' as const,
      outcomeCode: 'user_rejected',
      expectedContractId: 'training.adaptation.rejection.v1',
      evidenceReferences: ['outcome://training/adaptation/a1/rejected'],
      producerVersion: 'training-adaptation.v1',
      confidence: 1,
      observedAt: '2026-07-15T02:00:00.000Z',
      subjectFingerprint: 'a'.repeat(64),
      expiresAt: '2099-01-11T02:00:00.000Z',
    };
    expect(createTrainingLearningCase(observation).redactedInput).toEqual({
      kind: 'adaptation_rejected',
      outcomeCode: 'user_rejected',
      subjectFingerprint: 'a'.repeat(64),
    });
    scoped(() => {
      expect(recordTrainingLearningObservation(observation).lifecycle).toBe('observed');
      expect(recordTrainingLearningObservation(observation).lifecycle).toBe('observed');
      expect(listLearningCases(42, 42)).toHaveLength(1);
      expect(() => recordTrainingLearningObservation({ ...observation, confidence: 0.8 }))
        .toThrow(/idempotency key conflicts/);
    });
    expect(() => createTrainingLearningCase({ ...observation, outcomeCode: 'raw private text here' }))
      .toThrow(/closed taxonomy/);
    expect(() => createTrainingLearningCase({
      ...observation,
      kind: 'not_a_real_kind' as any,
      outcomeCode: 'felipe_private_note',
      expectedContractId: 'training.fake.v1',
    })).toThrow(/closed taxonomy/);
    expect(() => createTrainingLearningCase({
      ...observation,
      observedAt: new Date(Date.now() + 10 * 60 * 1_000).toISOString(),
    })).toThrow(/observed_at_future/);
  });

  it('rejects direct reviewed or golden insertion at service and database boundaries', () => {
    const reviewed = {
      ...observed(),
      lifecycle: 'reviewed' as const,
      reviewedAt: '2026-07-15T01:00:00.000Z',
      reviewedBy: 'user:42',
      reviewApprovalReference: `approval://product-learning/${'f'.repeat(64)}`,
    };
    expect(() => scoped(() => storeLearningCase(reviewed))).toThrow(/enter through the observed lifecycle/);
    expect(() => scoped(() => db.prepare(`
      INSERT INTO product_learning_cases (
        case_id, tenant_id, user_id, owner, lifecycle, privacy_class,
        redacted_input_json, expected_contract_json, evidence_references_json,
        producer_version, confidence, observed_at, reviewed_at, reviewed_by,
        review_approval_reference, expires_at
      ) VALUES ('direct-golden', 42, 42, 'training', 'golden', 'redacted-product',
        '{"kind":"capacity_conflict_accuracy","outcomeCode":"corrected"}',
        '{"contractId":"training.capacity_conflict.v1"}', '["ci://run/123/case/1"]',
        'training-learning.v1', 1, '2026-07-15T00:00:00.000Z',
        '2026-07-15T01:00:00.000Z', 'user:42',
        'approval://product-learning/fake', '2099-01-11T00:00:00.000Z')
    `).run())).toThrow(/enter through observed lifecycle/);
  });

  it('allows an expired observation to retire but blocks promotion', () => {
    const expired = { ...observed(), observedAt: '2025-01-01T00:00:00.000Z', expiresAt: '2025-02-01T00:00:00.000Z' };
    scoped(() => {
      storeLearningCase(expired);
      expect(() => transitionStoredLearningCase(42, 42, expired.id, 'candidate'))
        .toThrow(/can only be retired/);
      expect(transitionStoredLearningCase(42, 42, expired.id, 'retired').lifecycle).toBe('retired');
    });
  });

  it('supports migration up, down, and re-up without residue', () => {
    const fresh = new Database(':memory:');
    try {
      fresh.pragma('foreign_keys = ON');
      fresh.exec(`
        CREATE TABLE training_revision_erasure_authorizations (
          subject_user_id INTEGER NOT NULL,
          expires_at TEXT NOT NULL
        );
        CREATE TABLE notification_center_items (
          item_id TEXT PRIMARY KEY
        );
        CREATE TABLE decision_action_executions (
          action_execution_id TEXT PRIMARY KEY
        );
      `);
      const up = readFileSync(resolve(__dirname, '../../migrations/232_product_learning_cases.sql'), 'utf8');
      const down = readFileSync(resolve(__dirname, '../../migrations/down/232_product_learning_cases.sql'), 'utf8');
      fresh.exec(up);
      expect(fresh.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'product_learning_cases'").get())
        .toBeTruthy();
      expect(fresh.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'product_learning_case_review_approvals'").get())
        .toBeTruthy();
      expect(fresh.pragma('foreign_key_check')).toEqual([]);
      fresh.exec(down);
      expect(fresh.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'product_learning_cases'").get())
        .toBeUndefined();
      expect(fresh.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'product_learning_case_review_approvals'").get())
        .toBeUndefined();
      fresh.exec(up);
      expect(fresh.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'product_learning_case_transitions'").get())
        .toBeTruthy();
      expect(fresh.pragma('foreign_key_check')).toEqual([]);
    } finally {
      fresh.close();
    }
  });

  it('exports and erases learning evidence through the account privacy boundary', () => {
    scoped(() => {
      storeLearningCase(observed());
      const candidate = transitionStoredLearningCase(42, 42, observed().id, 'candidate');
      const receipt = approveCandidate(candidate, 'execution-export-delete');
      transitionStoredLearningCase(42, 42, candidate.id, 'reviewed', {
        approvalReference: receipt.approvalReference,
      });
      const exported = exportAllUserData(42);
      expect(exported.productLearningCases).toEqual([
        expect.objectContaining({
          caseId: observed().id,
          tenantId: 42,
          userId: 42,
          lifecycle: 'reviewed',
          redactedInput: observed().redactedInput,
          reviewedBy: 'user:42',
          reviewApprovalReference: receipt.approvalReference,
        }),
      ]);
      expect(exported.productLearningCaseReviewApprovals).toEqual([
        expect.objectContaining({
          tenantId: 42,
          userId: 42,
          caseId: observed().id,
          actionExecutionId: receipt.actionExecutionId,
          approvalReference: receipt.approvalReference,
          reviewedBy: 'user:42',
        }),
      ]);

      const deleted = deleteAllUserData(42);
      expect(deleted.product_learning_case_review_approvals).toBe(1);
      expect(deleted.product_learning_case_transitions).toBe(3);
      expect(deleted.product_learning_cases).toBe(1);
      expect(listLearningCases(42, 42)).toEqual([]);
    });
  });
});
