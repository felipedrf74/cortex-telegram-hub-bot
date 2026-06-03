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

import {
  buildSkillDecisionFixtureIntent,
  createDecisionIntent,
  ensureDecisionCenterTables,
  getDecisionItem,
  performDecisionAction,
} from '../../src/services/decision-center';
import { ensureNotificationTables } from '../../src/services/notification-orchestrator';

describe('Decision Center Command Bus equivalence', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-03T10:00:00.000Z'));
    testDb = new Database(':memory:');
    process.env.NOTIFICATION_DELIVERY_MODE = 'mock';
    delete process.env.DECISION_CENTER_COMMAND_BUS_ENABLED;
    ensureNotificationTables();
    ensureDecisionCenterTables();
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
