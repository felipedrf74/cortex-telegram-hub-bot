import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
}));

vi.mock('../../src/services/apns-sender', () => ({
  getPushTokensForUser: vi.fn(() => []),
  isApnsConfigured: vi.fn(() => false),
  sendPushNotification: vi.fn(),
  deleteDeadPushToken: vi.fn(),
  closeApnsClient: vi.fn(),
  _resetForTests: vi.fn(),
  sendPushToUsers: vi.fn(),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

import { createContentWorkflowObject } from '../../src/services/content-editorial-workflow';
import {
  buildSkillDecisionFixtureIntent,
  createDecisionIntent,
  ensureDecisionCenterTables,
  evaluateDecisionEligibility,
  getDecisionItem,
  getDecisionSummary,
  listDecisionItems,
  performDecisionAction,
} from '../../src/services/decision-center';
import { buildSkillNotificationFixtureIntent, ensureNotificationTables } from '../../src/services/notification-orchestrator';

async function createContentApprovalDecision(userId: number, tenantId: number, dedupeKey: string) {
  const object = createContentWorkflowObject({
    userId,
    tenantId,
    objectType: 'script',
    title: `Draft ${dedupeKey}`,
    editorialState: 'drafted',
  });
  const created = await createDecisionIntent(buildSkillDecisionFixtureIntent('content', userId, {
    tenantId,
    relatedEntityId: object.id,
    relatedEntityType: 'content_workflow_object',
    dedupeKey,
  }));
  return { object, created };
}

describe('Decision Center facade', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-10T10:00:00.000Z'));
    testDb = new Database(':memory:');
    process.env.NOTIFICATION_DELIVERY_MODE = 'mock';
    ensureNotificationTables();
    ensureDecisionCenterTables();
  });

  afterEach(() => {
    delete process.env.NOTIFICATION_DELIVERY_MODE;
    vi.useRealTimers();
    testDb?.close();
  });

  it('classifies true decisions separately from routine notifications and passive insights', () => {
    expect(evaluateDecisionEligibility({
      sourceSkill: 'cooking',
      type: 'reminder',
      priority: 'active',
      requiresUserAction: false,
      actionButtons: [{ id: 'open_detail', label: 'Open' }],
    }).classification).toBe('notification');

    const conflict = evaluateDecisionEligibility({
      sourceSkill: 'secretary',
      type: 'conflict_detected',
      priority: 'time_sensitive',
      requiresUserAction: true,
      actionButtons: [{ id: 'accept_reflow', label: 'Accept' }],
    });
    expect(conflict.classification).toBe('decision');
    expect(conflict.apnsEligible).toBe(true);

    const insight = evaluateDecisionEligibility({
      sourceSkill: 'system',
      type: 'insight',
      priority: 'passive',
      requiresUserAction: false,
    });
    expect(insight.classification).toBe('insight');
    expect(insight.apnsEligible).toBe(false);
  });

  it('creates a bounded Home summary from scoped decision-worthy items only', async () => {
    await createDecisionIntent(buildSkillDecisionFixtureIntent('secretary', 1, {
      dedupeKey: 'secretary:decision',
    }));
    await createDecisionIntent(buildSkillNotificationFixtureIntent('cooking', 1, {
      type: 'reminder',
      requiresUserAction: false,
      actionButtons: [{ id: 'open_detail', label: 'Open' }],
      dedupeKey: 'cooking:routine',
    }));

    const items = listDecisionItems(1, 1);
    expect(items).toHaveLength(1);
    expect(items[0].sourceSkill).toBe('secretary');

    const summary = getDecisionSummary(1, 1);
    expect(summary.openCount).toBe(1);
    expect(summary.urgentCount).toBe(1);
    expect(summary.ctaLabel).toBe('Urgent Decision');
    expect(summary.previewItems).toHaveLength(1);
    expect(summary.previewItems[0].safePreviewBody).not.toContain('Calendar details');
  });

  it('executes content approval actions through Content and read-back verifies state', async () => {
    const object = createContentWorkflowObject({
      userId: 2,
      tenantId: 2,
      objectType: 'script',
      title: 'Draft for approval',
      editorialState: 'drafted',
    });
    const created = await createDecisionIntent(buildSkillDecisionFixtureIntent('content', 2, {
      relatedEntityId: object.id,
      relatedEntityType: 'content_workflow_object',
      dedupeKey: 'content:approval',
    }));
    expect(created.item?.status).toBe('unread');

    const result = await performDecisionAction(created.item!.decisionId, 'approve_script', 2, 2, {
      idempotencyKey: 'tap-1',
    });
    expect(result.status).toBe('succeeded');
    expect(result.verification.readBackOk).toBe(true);
    expect(result.item.status).toBe('actioned');
    expect(result.verification.actualEffect.contentApprovalState).toBe('approved');

    const duplicate = await performDecisionAction(created.item!.decisionId, 'approve_script', 2, 2, {
      idempotencyKey: 'tap-1',
    });
    expect(duplicate.idempotent).toBe(true);
    expect(duplicate.status).toBe('idempotent');
  });

  it('blocks unsupported mutating actions and leaves the decision failed instead of faking success', async () => {
    const created = await createDecisionIntent(buildSkillDecisionFixtureIntent('secretary', 3, {
      dedupeKey: 'secretary:unsupported',
    }));

    await expect(performDecisionAction(created.item!.decisionId, 'accept_reflow', 3, 3, {
      idempotencyKey: 'unsupported-tap',
    }))
      .rejects.toThrow(/deterministic executor/);

    const items = listDecisionItems(3, 3, { status: 'all' });
    expect(items[0].status).toBe('failed');
  });

  it('denies wrong-user decision list/detail/action access by scope', async () => {
    const created = await createDecisionIntent(buildSkillDecisionFixtureIntent('content', 4, {
      dedupeKey: 'content:scope',
    }));

    expect(listDecisionItems(5, 5)).toHaveLength(0);
    await expect(performDecisionAction(created.item!.decisionId, 'approve_script', 5, 5, {
      idempotencyKey: 'wrong-user-tap',
    }))
      .rejects.toThrow(/Decision not found/);
  });

  it('isolates two users inside the same tenant for list, detail, and action access', async () => {
    await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 10, { tenantId: 77, dedupeKey: 'u10:a' }));
    await createDecisionIntent(buildSkillDecisionFixtureIntent('secretary', 10, { tenantId: 77, dedupeKey: 'u10:b' }));
    const userB = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 11, { tenantId: 77, dedupeKey: 'u11:a' }));

    const userAItems = listDecisionItems(10, 77);
    expect(userAItems).toHaveLength(2);
    expect(userAItems.every((item) => item.userId === 10 && item.tenantId === 77)).toBe(true);

    const userBItems = listDecisionItems(11, 77);
    expect(userBItems).toHaveLength(1);
    expect(getDecisionItem(userB.item!.decisionId, 10, 77)).toBeNull();
    await expect(performDecisionAction(userB.item!.decisionId, 'open_detail', 10, 77, {
      idempotencyKey: 'wrong-user-open',
    })).rejects.toThrow(/Decision not found/);
  });

  it('isolates same numeric user id across different tenants', async () => {
    const tenantOne = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 100, { tenantId: 1, dedupeKey: 'same-user:t1' }));
    const tenantTwo = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 100, { tenantId: 2, dedupeKey: 'same-user:t2' }));

    expect(listDecisionItems(100, 1).map((item) => item.decisionId)).toEqual([tenantOne.item!.decisionId]);
    expect(listDecisionItems(100, 2).map((item) => item.decisionId)).toEqual([tenantTwo.item!.decisionId]);
    expect(getDecisionItem(tenantTwo.item!.decisionId, 100, 1)).toBeNull();
    expect(getDecisionItem(tenantOne.item!.decisionId, 100, 2)).toBeNull();
  });

  it('coalesces concurrent duplicate actions into one execution and one underlying write', async () => {
    vi.useRealTimers();
    const { object, created } = await createContentApprovalDecision(20, 20, 'content:concurrent');

    const [first, second] = await Promise.all([
      performDecisionAction(created.item!.decisionId, 'approve_script', 20, 20, { idempotencyKey: 'same-tap' }),
      performDecisionAction(created.item!.decisionId, 'approve_script', 20, 20, { idempotencyKey: 'same-tap' }),
    ]);

    expect([first.status, second.status].sort()).toEqual(['idempotent', 'succeeded']);
    const executions = testDb.prepare(`
      SELECT COUNT(*) AS count
      FROM decision_action_executions
      WHERE decision_id = ? AND action_id = 'approve_script' AND idempotency_key = 'same-tap'
    `).get(created.item!.decisionId) as { count: number };
    expect(executions.count).toBe(1);

    const workflow = testDb.prepare(`SELECT workflow_version, approval_state FROM content_domain_objects WHERE id = ?`).get(object.id) as { workflow_version: number; approval_state: string };
    expect(workflow.workflow_version).toBe(2);
    expect(workflow.approval_state).toBe('approved');
  });

  it('denies expired, superseded, dismissed, and already-actioned decisions correctly', async () => {
    const expired = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 30, { dedupeKey: 'expired' }));
    testDb.prepare(`UPDATE notification_center_items SET expires_at = ? WHERE item_id = ?`)
      .run('2026-05-09T10:00:00.000Z', expired.item!.decisionId);
    await expect(performDecisionAction(expired.item!.decisionId, 'open_detail', 30, 30, { idempotencyKey: 'expired-tap' }))
      .rejects.toThrow(/expired/i);

    const superseded = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 31, { dedupeKey: 'superseded' }));
    testDb.prepare(`UPDATE notification_center_items SET status = 'superseded' WHERE item_id = ?`).run(superseded.item!.decisionId);
    await expect(performDecisionAction(superseded.item!.decisionId, 'open_detail', 31, 31, { idempotencyKey: 'superseded-tap' }))
      .rejects.toThrow(/superseded/i);

    const dismissed = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 32, { dedupeKey: 'dismissed' }));
    testDb.prepare(`UPDATE notification_center_items SET status = 'dismissed' WHERE item_id = ?`).run(dismissed.item!.decisionId);
    await expect(performDecisionAction(dismissed.item!.decisionId, 'open_detail', 32, 32, { idempotencyKey: 'dismissed-tap' }))
      .rejects.toThrow(/dismissed/i);

    const { created } = await createContentApprovalDecision(33, 33, 'already-actioned');
    await performDecisionAction(created.item!.decisionId, 'approve_script', 33, 33, { idempotencyKey: 'action-once' });
    const duplicate = await performDecisionAction(created.item!.decisionId, 'approve_script', 33, 33, { idempotencyKey: 'action-once' });
    expect(duplicate.status).toBe('idempotent');
    await expect(performDecisionAction(created.item!.decisionId, 'approve_script', 33, 33, { idempotencyKey: 'action-twice' }))
      .rejects.toThrow(/already actioned/i);
  });

  it('marks decisions failed when fresh read-back status does not match the expected effect', async () => {
    const created = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 40, { dedupeKey: 'readback-mismatch' }));
    testDb.exec(`
      CREATE TRIGGER force_decision_readback_mismatch
      AFTER UPDATE OF status ON notification_center_items
      WHEN NEW.item_id = '${created.item!.decisionId}' AND NEW.status = 'read'
      BEGIN
        UPDATE notification_center_items SET status = 'unread' WHERE item_id = NEW.item_id;
      END;
    `);

    await expect(performDecisionAction(created.item!.decisionId, 'open_detail', 40, 40, { idempotencyKey: 'mismatch-tap' }))
      .rejects.toThrow(/read-back/i);
    const item = getDecisionItem(created.item!.decisionId, 40, 40);
    expect(item?.status).toBe('failed');
    const execution = testDb.prepare(`
      SELECT status, error_code
      FROM decision_action_executions
      WHERE decision_id = ? AND idempotency_key = 'mismatch-tap'
    `).get(created.item!.decisionId) as { status: string; error_code: string };
    expect(execution).toMatchObject({ status: 'failed', error_code: 'DECISION_READBACK_MISMATCH' });
  });

  it('requires client-supplied idempotency keys for decision actions', async () => {
    const created = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 41, { dedupeKey: 'missing-idempotency' }));
    await expect(performDecisionAction(created.item!.decisionId, 'open_detail', 41, 41))
      .rejects.toThrow(/idempotency key/i);
  });

  it('can replay migration 119 without duplicate-column failures', () => {
    const sql = readFileSync('migrations/119_decision_center_facade.sql', 'utf8');
    expect(() => {
      testDb.exec(sql);
      testDb.exec(sql);
    }).not.toThrow();
  });
});
