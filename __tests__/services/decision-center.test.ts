import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

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
  getDecisionSummary,
  listDecisionItems,
  performDecisionAction,
} from '../../src/services/decision-center';
import { buildSkillNotificationFixtureIntent, ensureNotificationTables } from '../../src/services/notification-orchestrator';

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

    await expect(performDecisionAction(created.item!.decisionId, 'accept_reflow', 3, 3))
      .rejects.toThrow(/deterministic executor/);

    const items = listDecisionItems(3, 3, { status: 'all' });
    expect(items[0].status).toBe('failed');
  });

  it('denies wrong-user decision list/detail/action access by scope', async () => {
    const created = await createDecisionIntent(buildSkillDecisionFixtureIntent('content', 4, {
      dedupeKey: 'content:scope',
    }));

    expect(listDecisionItems(5, 5)).toHaveLength(0);
    await expect(performDecisionAction(created.item!.decisionId, 'approve_script', 5, 5))
      .rejects.toThrow(/Decision not found/);
  });
});
