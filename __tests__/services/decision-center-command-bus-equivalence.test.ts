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

import {
  buildSkillDecisionFixtureIntent,
  createDecisionIntent,
  ensureDecisionCenterTables,
  getDecisionItem,
  performDecisionAction,
} from '../../src/services/decision-center';
import { ensureNotificationTables } from '../../src/services/notification-orchestrator';
import {
  createContentWorkflowObject,
  getContentWorkflowObject,
} from '../../src/services/content-editorial-workflow';

describe('Decision Center Command Bus equivalence', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-03T10:00:00.000Z'));
    testDb = new Database(':memory:');
    process.env.NOTIFICATION_DELIVERY_MODE = 'mock';
    delete process.env.DECISION_CENTER_COMMAND_BUS_ENABLED;
    ensureNotificationTables();
    ensureDecisionCenterTables();
    testDb.exec(readFileSync('migrations/183_chat_core_v2_command_events.sql', 'utf8'));
  });

  afterEach(() => {
    delete process.env.NOTIFICATION_DELIVERY_MODE;
    delete process.env.DECISION_CENTER_COMMAND_BUS_ENABLED;
    vi.useRealTimers();
    testDb?.close();
  });

  it('keeps dismiss status, execution ledger, and outcome count equivalent while adding bus command events only when enabled', async () => {
    const legacy = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 70, {
      tenantId: 70,
      dedupeKey: 'decision-bus-equivalence-legacy',
      actionButtons: [
        { id: 'dismiss', label: 'Dismiss', style: 'secondary' },
        { id: 'open_detail', label: 'Open details', style: 'primary' },
      ],
    }));
    const legacyResult = await performDecisionAction(legacy.item!.decisionId, 'dismiss', 70, 70, {
      idempotencyKey: 'dismiss-legacy',
    });

    process.env.DECISION_CENTER_COMMAND_BUS_ENABLED = 'true';
    const bus = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 71, {
      tenantId: 71,
      dedupeKey: 'decision-bus-equivalence-enabled',
      actionButtons: [
        { id: 'dismiss', label: 'Dismiss', style: 'secondary' },
        { id: 'open_detail', label: 'Open details', style: 'primary' },
      ],
    }));
    const busResult = await performDecisionAction(bus.item!.decisionId, 'dismiss', 71, 71, {
      idempotencyKey: 'dismiss-bus',
    });

    expect(legacyResult.status).toBe('succeeded');
    expect(busResult.status).toBe('succeeded');
    expect(getDecisionItem(legacy.item!.decisionId, 70, 70)?.status).toBe('dismissed');
    expect(getDecisionItem(bus.item!.decisionId, 71, 71)?.status).toBe('dismissed');
    expect(legacyResult.verification.expectedEffect.decisionStatus).toBe('dismissed');
    expect(busResult.verification.expectedEffect.decisionStatus).toBe('dismissed');
    expect(legacyResult.verification.actualEffect.viaCommandBus).toBeUndefined();
    expect(busResult.verification.actualEffect).toMatchObject({
      viaCommandBus: true,
      commandBusOutcomeRecorded: true,
      commandStatus: 'verified',
      capabilityId: 'decision_center.dismiss',
    });

    const legacyExecution = executionFor(legacy.item!.decisionId);
    const busExecution = executionFor(bus.item!.decisionId);
    expect(legacyExecution).toMatchObject({ status: 'succeeded' });
    expect(busExecution).toMatchObject({ status: 'succeeded' });
    expect(JSON.parse(legacyExecution.expected_effect_json)).toMatchObject({ decisionStatus: 'dismissed' });
    expect(JSON.parse(busExecution.expected_effect_json)).toMatchObject({ decisionStatus: 'dismissed', viaCommandBus: true });

    expect(outcomeCountFor(legacy.item!.decisionId)).toBe(1);
    expect(outcomeCountFor(bus.item!.decisionId)).toBe(1);
    expect(commandEventCountForScope(70, 70)).toBe(0);
    expect(commandEventCountForScope(71, 71)).toBeGreaterThanOrEqual(3);

    const busCommandEvents = testDb.prepare(`
      SELECT origin, command_type, status, redacted_summary, metadata_json
      FROM chat_v2_command_events
      WHERE user_id = '71' AND tenant_id = '71'
      ORDER BY id ASC
    `).all() as Array<{
      origin: string;
      command_type: string;
      status: string;
      redacted_summary: string;
      metadata_json: string;
    }>;
    expect(busCommandEvents.some((event) => event.status === 'verified')).toBe(true);
    expect(busCommandEvents.every((event) => event.origin === 'decision_center')).toBe(true);
    expect(busCommandEvents.every((event) => event.command_type === 'decision_center.dismiss')).toBe(true);
    expect(JSON.stringify(busCommandEvents)).not.toContain(bus.item!.title);
  });

  it.each([
    ['approve_script', 'approved'],
    ['request_rewrite', 'rejected'],
  ] as const)('keeps direct owner content %s equivalent while atomically verifying source and decision projections', async (actionId, expectedApprovalState) => {
    const legacyObject = createContentWorkflowObject({
      userId: 72,
      tenantId: 72,
      objectType: 'script',
      title: 'Legacy private draft',
      editorialState: 'drafted',
    });
    const legacy = await createDecisionIntent(buildSkillDecisionFixtureIntent('content', 72, {
      tenantId: 72,
      relatedEntityId: legacyObject.id,
      relatedEntityType: 'content_workflow_object',
      dedupeKey: `decision-bus-content-legacy-${actionId}`,
      actionButtons: [
        { id: 'approve_script', label: 'Approve', style: 'primary', mutating: true },
        { id: 'request_rewrite', label: 'Request changes', style: 'secondary', mutating: true },
      ],
    }));
    const legacyResult = await performDecisionAction(legacy.item!.decisionId, actionId, 72, 72, {
      idempotencyKey: `content-legacy-${actionId}`,
    });

    process.env.DECISION_CENTER_COMMAND_BUS_ENABLED = 'true';
    const busObject = createContentWorkflowObject({
      userId: 73,
      tenantId: 73,
      objectType: 'script',
      title: 'Bus private draft',
      editorialState: 'drafted',
    });
    const bus = await createDecisionIntent(buildSkillDecisionFixtureIntent('content', 73, {
      tenantId: 73,
      relatedEntityId: busObject.id,
      relatedEntityType: 'content_workflow_object',
      dedupeKey: `decision-bus-content-enabled-${actionId}`,
      actionButtons: [
        { id: 'approve_script', label: 'Approve', style: 'primary', mutating: true },
        { id: 'request_rewrite', label: 'Request changes', style: 'secondary', mutating: true },
      ],
    }));
    const busResult = await performDecisionAction(bus.item!.decisionId, actionId, 73, 73, {
      idempotencyKey: `content-bus-${actionId}`,
    });

    expect(legacyResult.status).toBe('succeeded');
    expect(busResult.status).toBe('succeeded');
    expect(getContentWorkflowObject(72, legacyObject.id, 72)?.approvalState).toBe(expectedApprovalState);
    expect(getContentWorkflowObject(73, busObject.id, 73)?.approvalState).toBe(expectedApprovalState);
    expect(busResult.verification.actualEffect).toMatchObject({
      decisionStatus: 'actioned',
      contentObjectId: busObject.id,
      contentApprovalState: expectedApprovalState,
      providerActionExecuted: false,
      viaCommandBus: true,
      commandStatus: 'verified',
      capabilityId: `content.${actionId}`,
    });
    expect(legacyResult.verification.actualEffect.viaCommandBus).toBeUndefined();
    expect(executionFor(bus.item!.decisionId).status).toBe('succeeded');
    expect(outcomeCountFor(legacy.item!.decisionId)).toBe(1);
    expect(outcomeCountFor(bus.item!.decisionId)).toBe(1);
    expect(commandEventTypesForScope(73, 73)).toContain(`content.${actionId}`);
    expect(JSON.stringify(commandEventsForScope(73, 73))).not.toContain('Bus private draft');
  });

  it('keeps tenant-shared content on the legacy executor until an explicit tenant approver role exists', async () => {
    process.env.DECISION_CENTER_COMMAND_BUS_ENABLED = 'true';
    const object = createContentWorkflowObject({
      userId: 74,
      tenantId: 740,
      visibilityScope: 'tenant_shared',
      objectType: 'script',
      title: 'Shared draft',
      editorialState: 'drafted',
    });
    const created = await createDecisionIntent(buildSkillDecisionFixtureIntent('content', 74, {
      tenantId: 740,
      relatedEntityId: object.id,
      relatedEntityType: 'content_workflow_object',
      dedupeKey: 'decision-bus-content-shared-fallback',
      actionButtons: [{ id: 'approve_script', label: 'Approve', style: 'primary', mutating: true }],
    }));

    const result = await performDecisionAction(created.item!.decisionId, 'approve_script', 74, 740, {
      idempotencyKey: 'content-shared-legacy-fallback',
    });

    expect(result.status).toBe('succeeded');
    expect(result.verification.actualEffect.viaCommandBus).toBeUndefined();
    expect(commandEventCountForScope(74, 740)).toBe(0);
  });

  it('keeps chat fixer acceptance projection-only and equivalent while adding Command Bus audit events', async () => {
    const fixture = async (userId: number, tenantId: number, suffix: string) => createDecisionIntent(
      buildSkillDecisionFixtureIntent('chat', userId, {
        tenantId,
        relatedEntityId: `fixer_job_${suffix}`,
        relatedEntityType: 'chat_action_fixer_review',
        dedupeKey: `decision-bus-fixer-${suffix}`,
        actionButtons: [
          { id: 'accept_chat_action_fix', label: 'Accept correction', style: 'primary', mutating: true },
          { id: 'dismiss', label: 'Not now', style: 'secondary', mutating: true },
        ],
      }),
    );
    const legacy = await fixture(75, 750, 'legacy');
    const legacyResult = await performDecisionAction(legacy.item!.decisionId, 'accept_chat_action_fix', 75, 750, {
      idempotencyKey: 'fixer-legacy',
    });

    process.env.DECISION_CENTER_COMMAND_BUS_ENABLED = 'true';
    const bus = await fixture(76, 760, 'enabled');
    const busResult = await performDecisionAction(bus.item!.decisionId, 'accept_chat_action_fix', 76, 760, {
      idempotencyKey: 'fixer-bus',
    });

    expect(legacyResult.verification.actualEffect).toMatchObject({
      providerActionExecuted: false,
      freshConfirmationRequired: true,
    });
    expect(busResult.verification.actualEffect).toMatchObject({
      decisionStatus: 'actioned',
      providerActionExecuted: false,
      freshConfirmationRequired: true,
      viaCommandBus: true,
      capabilityId: 'decision_center.accept_chat_action_fix',
    });
    expect(commandEventTypesForScope(76, 760)).toContain('decision_center.accept_chat_action_fix');
    const actionResult = testDb.prepare(`
      SELECT action_result_json AS resultJson
        FROM notification_center_items
       WHERE item_id = ? AND user_id = ? AND tenant_id = ?
    `).get(bus.item!.decisionId, 76, 760) as { resultJson: string };
    expect(JSON.parse(actionResult.resultJson)).toMatchObject({
      providerActionExecuted: false,
      freshConfirmationRequired: true,
    });
    expect(outcomeCountFor(legacy.item!.decisionId)).toBe(1);
    expect(outcomeCountFor(bus.item!.decisionId)).toBe(1);
  });
});

function executionFor(decisionId: string): { status: string; expected_effect_json: string; result_json: string } {
  return testDb.prepare(`
    SELECT status, expected_effect_json, result_json
    FROM decision_action_executions
    WHERE decision_id = ?
  `).get(decisionId) as { status: string; expected_effect_json: string; result_json: string };
}

function outcomeCountFor(decisionId: string): number {
  const row = testDb.prepare(`
    SELECT COUNT(*) AS count
    FROM decision_outcome_ledger
    WHERE decision_id = ?
  `).get(decisionId) as { count: number };
  return row.count;
}

function commandEventCountForScope(userId: number, tenantId: number): number {
  const row = testDb.prepare(`
    SELECT COUNT(*) AS count
    FROM chat_v2_command_events
    WHERE command_type = 'decision_center.dismiss'
      AND user_id = ?
      AND tenant_id = ?
  `).get(String(userId), String(tenantId)) as { count: number };
  return row.count;
}

function commandEventsForScope(userId: number, tenantId: number): Array<Record<string, unknown>> {
  return testDb.prepare(`
    SELECT command_type, event_name, status, redacted_summary, metadata_json
      FROM chat_v2_command_events
     WHERE user_id = ? AND tenant_id = ?
     ORDER BY id ASC
  `).all(String(userId), String(tenantId)) as Array<Record<string, unknown>>;
}

function commandEventTypesForScope(userId: number, tenantId: number): string[] {
  return commandEventsForScope(userId, tenantId).map((row) => String(row.command_type));
}
