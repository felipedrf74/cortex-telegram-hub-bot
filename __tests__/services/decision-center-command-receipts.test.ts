import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
}));

import { createDecisionMutationCommand } from '../../src/services/decision-center/contracts';
import { executeDecisionMutationWithReceipt } from '../../src/services/decision-center/command-receipts';
import {
  compactDecisionExecutionReceiptEvidence,
  createDecisionCommandReceipt,
  decisionCommandReceiptId,
  listDecisionCommandReceipts,
  readDecisionCommandReceipt,
} from '../../src/services/decision-center/command-response-receipts';

function command(
  payload: Readonly<Record<string, unknown>> = { pushEnabled: true },
  decisionId = 'decision-preferences',
) {
  return createDecisionMutationCommand({
    commandId: 'command-preferences-1',
    decisionId,
    operation: 'update_preferences',
    actionId: 'update_preferences',
    scope: { userId: 7, tenantId: 11 },
    channel: 'rest',
    idempotencyKey: 'preferences-attempt-1',
    recordVersion: null,
    contextVersion: null,
    approval: { requiredLevel: 'none', evidence: null },
    execution: {
      executorId: 'decision-center.update_preferences',
      strategy: 'synchronous',
      riskLevel: 'low',
      reversible: true,
      supportsIdempotency: true,
    },
    readback: {
      verifierId: 'decision-center.update_preferences.readback',
      entityType: 'decision_center_preferences',
      entityId: decisionId,
      mode: 'exact',
      expectedState: {},
    },
    payload,
    requestedAt: '2026-08-31T10:00:00.000Z',
  });
}

function genericCommand(input: {
  decisionId: string;
  operation: 'suppress_type' | 'unsuppress_type' | 'record_exposure';
  actionId: string;
  idempotencyKey: string;
  entityType: string;
  payload: Readonly<Record<string, unknown>>;
}) {
  return createDecisionMutationCommand({
    commandId: `command-${input.operation}`,
    decisionId: input.decisionId,
    operation: input.operation,
    actionId: input.actionId,
    scope: { userId: 7, tenantId: 11 },
    channel: 'rest',
    idempotencyKey: input.idempotencyKey,
    recordVersion: null,
    contextVersion: null,
    approval: { requiredLevel: 'none', evidence: null },
    execution: {
      executorId: `decision-center.${input.operation}`,
      strategy: 'synchronous',
      riskLevel: 'low',
      reversible: true,
      supportsIdempotency: true,
    },
    readback: {
      verifierId: `decision-center.${input.operation}.readback`,
      entityType: input.entityType,
      entityId: input.decisionId,
      mode: 'exact',
      expectedState: {},
    },
    payload: input.payload,
    requestedAt: '2026-08-31T10:00:00.000Z',
  });
}

describe('Decision Center command receipts', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.exec(`
      CREATE TABLE decision_lifecycle_events (
        event_id TEXT PRIMARY KEY,
        decision_id TEXT NOT NULL,
        user_id INTEGER NOT NULL,
        tenant_id INTEGER NOT NULL,
        event TEXT NOT NULL,
        to_status TEXT,
        action_id TEXT,
        reason TEXT,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE mutation_effects (value TEXT NOT NULL);
    `);
  });

  afterEach(() => testDb.close());

  it('persists the exact readback once and replays it without executing again', () => {
    let executions = 0;
    const first = executeDecisionMutationWithReceipt(command(), () => {
      executions += 1;
      return { pushEnabled: true };
    });
    const replay = executeDecisionMutationWithReceipt(command(), () => {
      executions += 1;
      return { pushEnabled: false };
    });

    expect(first.result).toEqual({ pushEnabled: true });
    expect(first.idempotent).toBe(false);
    expect(first.commandReceipt).toMatchObject({
      schemaVersion: 'decision_command_receipt@1.0.0',
      decisionId: 'decision-preferences',
      operation: 'update_preferences',
      actionId: 'update_preferences',
      status: 'succeeded',
      idempotencyKeyHash: createHash('sha256').update('preferences-attempt-1').digest('hex'),
    });
    expect(replay).toEqual({
      result: { pushEnabled: true },
      idempotent: true,
      commandReceipt: first.commandReceipt,
    });
    expect(executions).toBe(1);
    expect(testDb.prepare("SELECT COUNT(*) AS count FROM decision_lifecycle_events WHERE event = 'mutation_receipt'").get())
      .toEqual({ count: 2 });
    expect(JSON.stringify(first.commandReceipt)).not.toContain('preferences-attempt-1');
    expect(JSON.stringify(first.commandReceipt)).not.toContain('userId');
    expect(JSON.stringify(first.commandReceipt)).not.toContain('tenantId');
  });

  it('rejects reuse of a key for a different command payload', () => {
    executeDecisionMutationWithReceipt(command(), () => ({ pushEnabled: true }));

    expect(() => executeDecisionMutationWithReceipt(command({ pushEnabled: false }), () => ({ pushEnabled: false })))
      .toThrow(expect.objectContaining({ code: 'IDEMPOTENCY_KEY_REUSED', status: 409 }));
  });

  it.each([
    ['schemaVersion', 'decision_mutation_receipt@0.9.0'],
    ['commandSchemaVersion', 'decision_mutation_command@0.0.1'],
    ['operation', 'suppress_type'],
  ] as const)('rejects replay when the stored receipt %s no longer matches the command', (field, value) => {
    let executions = 0;
    executeDecisionMutationWithReceipt(command(), () => {
      executions += 1;
      return { pushEnabled: true };
    });
    const row = testDb.prepare(`
      SELECT event_id AS eventId, metadata_json AS metadataJson FROM decision_lifecycle_events
       WHERE event = 'mutation_receipt' AND reason = 'idempotent_command_receipt'
    `).get() as { eventId: string; metadataJson: string };
    const tampered = { ...JSON.parse(row.metadataJson), [field]: value };
    testDb.prepare('UPDATE decision_lifecycle_events SET metadata_json = ? WHERE event_id = ?')
      .run(JSON.stringify(tampered), row.eventId);

    // A stored receipt that no longer describes this exact command contract
    // must never replay as that command's success, and must never re-execute.
    expect(() => executeDecisionMutationWithReceipt(command(), () => {
      executions += 1;
      return { pushEnabled: true };
    })).toThrow(expect.objectContaining({ code: 'IDEMPOTENCY_KEY_REUSED', status: 409 }));
    expect(executions).toBe(1);
  });

  it('atomically backfills a canonical receipt for a predecessor preference identity', () => {
    let executions = 0;
    const legacy = command(
      { pushEnabled: true },
      'decision-preferences:11:7',
    );
    const predecessor = executeDecisionMutationWithReceipt(legacy, () => {
      executions += 1;
      return { pushEnabled: true };
    });
    testDb.prepare(`
      DELETE FROM decision_lifecycle_events
       WHERE event_id = ? AND reason = 'immutable_command_receipt'
    `).run(predecessor.commandReceipt!.receiptId);

    const replay = executeDecisionMutationWithReceipt(command(), () => {
      executions += 1;
      return { pushEnabled: false };
    });

    expect(executions).toBe(1);
    expect(replay).toMatchObject({
      idempotent: true,
      result: { pushEnabled: true },
      commandReceipt: {
        decisionId: 'decision-preferences',
        operation: 'update_preferences',
        status: 'succeeded',
      },
    });
    expect(replay.commandReceipt?.idempotencyKeyHash)
      .toBe(createHash('sha256').update('preferences-attempt-1').digest('hex'));
    expect(listDecisionCommandReceipts('decision-preferences', 7, 11))
      .toEqual([replay.commandReceipt]);
  });

  it('backfills predecessor suppression and exposure receipts without replaying their effects', () => {
    const suppressionPayload = {
      sourceSkill: 'cooking',
      type: 'decision_required',
      mode: 'dont_show_type',
      untilDays: null,
      recipe: null,
    };
    const cases = [
      {
        legacy: genericCommand({
          decisionId: 'decision-suppression:cooking:decision_required:*',
          operation: 'suppress_type',
          actionId: 'suppress_type',
          idempotencyKey: 'suppress-predecessor-k1',
          entityType: 'decision_type_suppression',
          payload: suppressionPayload,
        }),
        current: genericCommand({
          decisionId: `decision-suppression:${'c'.repeat(64)}`,
          operation: 'suppress_type',
          actionId: 'suppress_type',
          idempotencyKey: 'suppress-predecessor-k1',
          entityType: 'decision_type_suppression',
          payload: suppressionPayload,
        }),
      },
      {
        legacy: genericCommand({
          decisionId: 'decision-suppression:cooking:decision_required:*',
          operation: 'unsuppress_type',
          actionId: 'unsuppress_type',
          idempotencyKey: 'unsuppress-predecessor-k1',
          entityType: 'decision_type_suppression',
          payload: {
            sourceSkill: 'cooking',
            type: 'decision_required',
            recipe: null,
          },
        }),
        current: genericCommand({
          decisionId: `decision-suppression:${'d'.repeat(64)}`,
          operation: 'unsuppress_type',
          actionId: 'unsuppress_type',
          idempotencyKey: 'unsuppress-predecessor-k1',
          entityType: 'decision_type_suppression',
          payload: {
            sourceSkill: 'cooking',
            type: 'decision_required',
            recipe: null,
          },
        }),
      },
      {
        legacy: genericCommand({
          decisionId: 'decision-exposures',
          operation: 'record_exposure',
          actionId: 'record_exposure',
          idempotencyKey: 'exposure-predecessor-k1',
          entityType: 'decision_exposure_batch',
          payload: { decisionIds: ['nc_1'] },
        }),
        current: genericCommand({
          decisionId: 'decision-exposures',
          operation: 'record_exposure',
          actionId: 'record_exposure',
          idempotencyKey: 'exposure-predecessor-k1',
          entityType: 'decision_exposure_batch',
          payload: { decisionIds: ['nc_1'] },
        }),
      },
    ];
    let executions = 0;
    for (const [index, candidate] of cases.entries()) {
      const predecessor = executeDecisionMutationWithReceipt(candidate.legacy, () => {
        executions += 1;
        return { applied: index + 1 };
      });
      testDb.prepare(`
        DELETE FROM decision_lifecycle_events
         WHERE event_id = ? AND reason = 'immutable_command_receipt'
      `).run(predecessor.commandReceipt!.receiptId);
      const replay = executeDecisionMutationWithReceipt(candidate.current, () => {
        executions += 1;
        return { applied: 999 };
      });
      expect(replay).toMatchObject({
        idempotent: true,
        result: { applied: index + 1 },
        commandReceipt: {
          decisionId: candidate.current.decisionId,
          operation: candidate.current.operation,
          status: 'succeeded',
        },
      });
    }
    expect(executions).toBe(3);
  });

  it('rolls back both the domain effect and receipt when the mutation fails', () => {
    expect(() => executeDecisionMutationWithReceipt(command(), () => {
      testDb.prepare('INSERT INTO mutation_effects (value) VALUES (?)').run('written');
      throw new Error('rollback');
    })).toThrow('rollback');

    expect(testDb.prepare('SELECT COUNT(*) AS count FROM mutation_effects').get()).toEqual({ count: 0 });
    expect(testDb.prepare('SELECT COUNT(*) AS count FROM decision_lifecycle_events').get()).toEqual({ count: 0 });
  });

  it('binds lookup to tenant and user scope and ignores unrelated receipt-shaped lifecycle rows', () => {
    const first = executeDecisionMutationWithReceipt(command(), () => ({ pushEnabled: true }));
    const receipt = first.commandReceipt!;

    expect(readDecisionCommandReceipt(receipt.receiptId, receipt.decisionId, 7, 11)).toEqual(receipt);
    expect(readDecisionCommandReceipt(receipt.receiptId, receipt.decisionId, 8, 11)).toBeNull();
    expect(readDecisionCommandReceipt(receipt.receiptId, receipt.decisionId, 7, 12)).toBeNull();

    testDb.prepare(`
      INSERT INTO decision_lifecycle_events (
        event_id, decision_id, user_id, tenant_id, event, action_id,
        reason, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, 'mutation_receipt', 'noise', 'idempotent_command_receipt', ?, ?)
    `).run('unrelated-malformed-row', 'decision-preferences', 7, 11, '{bad-json', '2026-09-03T10:00:00.000Z');

    expect(listDecisionCommandReceipts('decision-preferences', 7, 11)).toEqual([receipt]);
  });

  it('minimizes private effect keys and emits only the raw-key SHA-256 digest', () => {
    const idempotencyKey = 'journal-secret-k1';
    const receipt = createDecisionCommandReceipt({
      receiptId: decisionCommandReceiptId({
        decisionId: 'decision-1',
        operation: 'review',
        actionId: 'review:approve',
        userId: 7,
        tenantId: 11,
        idempotencyKey,
      }),
      decisionId: 'decision-1',
      operation: 'review',
      actionId: 'review:approve',
      idempotencyKey,
      status: 'succeeded',
      completedAt: '2026-09-03T10:00:00.000Z',
      requestedRecordVersion: 4,
      readbackItem: {
        decisionId: 'decision-1',
        recordVersion: 5,
        status: 'read',
        actionId: 'review:approve',
        actionStatus: 'succeeded',
      },
      verification: {
        readBackOk: true,
        expectedEffect: {
          status: 'read',
          userId: 7,
          tenantId: 11,
          emailAddress: 'private@example.com',
          promptText: 'private prompt',
          idempotencyKey,
        },
        actualEffect: {
          status: 'read',
          contentTitle: 'private title',
          sourceObjectId: 'private-id',
        },
        message: 'untrusted provider message containing private user copy',
      },
    });

    expect(receipt.idempotencyKeyHash).toBe(createHash('sha256').update(idempotencyKey).digest('hex'));
    expect(receipt.verification?.expectedEffect).toEqual({ status: 'read' });
    expect(receipt.verification?.actualEffect).toEqual({ status: 'read' });
    expect(receipt.verification?.message).toBe(
      'Decision review succeeded; authoritative readback matched.',
    );
    const encoded = JSON.stringify(receipt);
    expect(encoded).not.toContain(idempotencyKey);
    expect(encoded).not.toContain('private@example.com');
    expect(encoded).not.toContain('private prompt');
    expect(encoded).not.toContain('private title');
    expect(encoded).not.toContain('private-id');
  });

  it('projects failed executor evidence through a fixed allowlist', () => {
    const evidence = compactDecisionExecutionReceiptEvidence({
      expectedEffect: {
        verifier: 'content_workflow_state',
        title: 'Private draft title',
        nested: { promptText: 'ignore prior instructions', userEmail: 'private@example.com' },
      },
      actualEffect: {
        status: 'failed',
        providerPayload: {
          body: 'private body',
          accountName: 'Felipe',
        },
      },
      effectResults: [
        { effectId: 'private-object-id', status: 'succeeded', message: 'private result' },
        { effectId: 'private-second-id', status: 'unknown', raw: 'private raw response' },
      ],
      status: 'partially_failed',
      errorCode: 'PROVIDER_TIMEOUT',
    });

    expect(evidence.expectedEffect).toEqual({
      evidenceHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      verifier: 'content_workflow_state',
    });
    expect(evidence.actualEffect).toEqual({
      evidenceHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      executionStatus: 'partially_failed',
      errorCode: 'PROVIDER_TIMEOUT',
      effectStatusCounts: { succeeded: 1, unknown: 1 },
    });
    const encoded = JSON.stringify(evidence);
    for (const privateValue of [
      'Private draft title',
      'ignore prior instructions',
      'private@example.com',
      'private body',
      'Felipe',
      'private-object-id',
      'private result',
      'private raw response',
    ]) expect(encoded).not.toContain(privateValue);
  });

  it('fails closed on incoherent status, suffix, action, proof, and present-null nested fields', () => {
    const input = {
      decisionId: 'decision-invalid',
      operation: 'review' as const,
      actionId: 'review:approve',
      userId: 7,
      tenantId: 11,
      idempotencyKey: 'invalid-receipt-attempt',
    };
    const baseReceiptId = decisionCommandReceiptId(input);

    expect(() => createDecisionCommandReceipt({
      receiptId: baseReceiptId,
      decisionId: input.decisionId,
      operation: input.operation,
      actionId: input.actionId,
      idempotencyKey: input.idempotencyKey,
      status: 'partially_failed',
      completedAt: '2026-09-03T10:00:00.000Z',
    })).toThrow(expect.objectContaining({ code: 'DECISION_COMMAND_RECEIPT_INVALID' }));

    expect(() => createDecisionCommandReceipt({
      receiptId: baseReceiptId,
      decisionId: input.decisionId,
      operation: input.operation,
      actionId: 'review:unsupported',
      idempotencyKey: input.idempotencyKey,
      status: 'succeeded',
      completedAt: '2026-09-03T10:00:00.000Z',
      verification: {
        readBackOk: true,
        expectedEffect: {},
        actualEffect: {},
        message: 'ignored',
      },
    })).toThrow(expect.objectContaining({ code: 'DECISION_COMMAND_RECEIPT_INVALID' }));

    expect(() => createDecisionCommandReceipt({
      receiptId: baseReceiptId,
      decisionId: input.decisionId,
      operation: input.operation,
      actionId: input.actionId,
      idempotencyKey: input.idempotencyKey,
      status: 'failed',
      completedAt: '2026-09-03T10:00:00.000Z',
      verification: {
        readBackOk: true,
        expectedEffect: {},
        actualEffect: {},
        message: 'ignored',
      },
    })).toThrow(expect.objectContaining({ code: 'DECISION_COMMAND_RECEIPT_INVALID' }));

    const valid = createDecisionCommandReceipt({
      receiptId: baseReceiptId,
      decisionId: input.decisionId,
      operation: input.operation,
      actionId: input.actionId,
      idempotencyKey: input.idempotencyKey,
      status: 'succeeded',
      completedAt: '2026-09-03T10:00:00.000Z',
      readbackItem: {
        decisionId: input.decisionId,
        recordVersion: 2,
        status: 'read',
        actionId: input.actionId,
        actionStatus: 'succeeded',
      },
      verification: {
        readBackOk: true,
        expectedEffect: {},
        actualEffect: {},
        message: 'ignored',
      },
    });
    testDb.prepare(`
      INSERT INTO decision_lifecycle_events (
        event_id, decision_id, user_id, tenant_id, event, action_id,
        reason, metadata_json, created_at
      ) VALUES (?, ?, 7, 11, 'mutation_receipt', 'review:approve',
                'immutable_command_receipt', ?, '2026-09-03T10:00:00.000Z')
    `).run(valid.receiptId, valid.decisionId, JSON.stringify({
      commandReceipt: { ...valid, verification: null },
    }));
    expect(() => readDecisionCommandReceipt(valid.receiptId, valid.decisionId, 7, 11))
      .toThrow(expect.objectContaining({ code: 'DECISION_COMMAND_RECEIPT_INVALID' }));
  });

  it('requires complete success proof and an exact resolved defer readback', () => {
    const scope = { userId: 7, tenantId: 11 };
    const verification = {
      readBackOk: true,
      expectedEffect: {},
      actualEffect: {},
      message: 'ignored',
    };
    const review = {
      decisionId: 'decision-proof',
      operation: 'review' as const,
      actionId: 'review:approve',
      idempotencyKey: 'review-proof-key',
      ...scope,
    };
    const reviewReceiptId = decisionCommandReceiptId(review);

    expect(() => createDecisionCommandReceipt({
      receiptId: reviewReceiptId,
      decisionId: review.decisionId,
      operation: review.operation,
      actionId: review.actionId,
      idempotencyKey: review.idempotencyKey,
      status: 'succeeded',
      completedAt: '2026-09-03T10:00:00.000Z',
      readbackItem: {
        decisionId: review.decisionId,
        recordVersion: 2,
        status: 'read',
      },
    })).toThrow(expect.objectContaining({ code: 'DECISION_COMMAND_RECEIPT_INVALID' }));

    expect(() => createDecisionCommandReceipt({
      receiptId: reviewReceiptId,
      decisionId: review.decisionId,
      operation: review.operation,
      actionId: review.actionId,
      idempotencyKey: review.idempotencyKey,
      status: 'succeeded',
      completedAt: '2026-09-03T10:00:00.000Z',
      verification,
    })).toThrow(expect.objectContaining({ code: 'DECISION_COMMAND_RECEIPT_INVALID' }));

    const action = {
      decisionId: 'decision-action-proof',
      operation: 'act' as const,
      actionId: 'accept_reflow',
      idempotencyKey: 'action-proof-key',
      ...scope,
    };
    expect(createDecisionCommandReceipt({
      receiptId: decisionCommandReceiptId(action),
      decisionId: action.decisionId,
      operation: action.operation,
      actionId: action.actionId,
      idempotencyKey: action.idempotencyKey,
      status: 'succeeded',
      executionAttemptId: 'attempt-action-proof',
      completedAt: '2026-09-03T10:00:00.000Z',
      verification,
    })).toMatchObject({ status: 'succeeded', executionAttemptId: 'attempt-action-proof' });

    for (const deferred of [
      {
        decisionId: 'decision-snooze-proof',
        operation: 'snooze' as const,
        actionId: 'snooze',
        idempotencyKey: 'snooze-proof-key',
        executionAttemptId: 'attempt-snooze-proof',
      },
      {
        decisionId: 'decision-review-defer-proof',
        operation: 'review' as const,
        actionId: 'review:defer',
        idempotencyKey: 'review-defer-proof-key',
        executionAttemptId: undefined,
      },
    ]) {
      const receiptId = decisionCommandReceiptId({ ...deferred, ...scope });
      expect(() => createDecisionCommandReceipt({
        receiptId,
        decisionId: deferred.decisionId,
        operation: deferred.operation,
        actionId: deferred.actionId,
        idempotencyKey: deferred.idempotencyKey,
        status: 'succeeded',
        executionAttemptId: deferred.executionAttemptId,
        completedAt: '2026-09-03T10:00:00.000Z',
        readbackItem: {
          decisionId: deferred.decisionId,
          recordVersion: 2,
          status: 'snoozed',
        },
        verification,
      })).toThrow(expect.objectContaining({ code: 'DECISION_COMMAND_RECEIPT_INVALID' }));

      expect(createDecisionCommandReceipt({
        receiptId,
        decisionId: deferred.decisionId,
        operation: deferred.operation,
        actionId: deferred.actionId,
        idempotencyKey: deferred.idempotencyKey,
        status: 'succeeded',
        executionAttemptId: deferred.executionAttemptId,
        completedAt: '2026-09-03T10:00:00.000Z',
        readbackItem: {
          decisionId: deferred.decisionId,
          recordVersion: 2,
          status: 'snoozed',
          snoozedUntil: '2026-09-10T09:00:00.000Z',
        },
        verification,
      })).toMatchObject({
        status: 'succeeded',
        readbackItem: { status: 'snoozed', snoozedUntil: '2026-09-10T09:00:00.000Z' },
      });
    }
  });
});
