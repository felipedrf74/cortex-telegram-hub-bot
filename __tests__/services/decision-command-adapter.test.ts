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
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
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
import { ensureChatCoreV2CommandEventTables } from '../../src/services/chat-core-v2/command-events';
import { decisionDismissVersionForItem } from '../../src/services/chat-core-v2/command-status-policy';
import { isDecisionCenterCommandBusEnabled } from '../../src/services/runtime-flags';
import {
  buildDecisionDismissEnvelope,
  isDecisionActionBusEligible,
  runDecisionActionViaCommandBus,
} from '../../src/services/decision-command-adapter';

const DISMISSIBLE_ACTIONS = [
  { id: 'open_detail', label: 'Open', style: 'primary' as const },
  { id: 'dismiss', label: 'Not now', style: 'secondary' as const },
];
const statusOf = (id: string) =>
  (testDb.prepare('SELECT status FROM notification_center_items WHERE item_id = ?').get(id) as { status: string }).status;

describe('Decision Center → Command Bus adapter (unblock)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-10T10:00:00.000Z'));
    testDb = new Database(':memory:');
    process.env.NOTIFICATION_DELIVERY_MODE = 'mock';
    ensureNotificationTables();
    ensureDecisionCenterTables();
    ensureChatCoreV2CommandEventTables(testDb);
  });

  afterEach(() => {
    delete process.env.NOTIFICATION_DELIVERY_MODE;
    delete process.env.DECISION_CENTER_COMMAND_BUS_ENABLED;
    vi.useRealTimers();
    testDb?.close();
  });

  it('defaults the flag OFF and routes only the dismiss family', () => {
    expect(isDecisionCenterCommandBusEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(isDecisionCenterCommandBusEnabled({ DECISION_CENTER_COMMAND_BUS_ENABLED: 'true' } as NodeJS.ProcessEnv)).toBe(true);
    expect(isDecisionActionBusEligible('dismiss')).toBe(true);
    expect(isDecisionActionBusEligible('not_now')).toBe(true);
    expect(isDecisionActionBusEligible('reject_reflow')).toBe(true);
    expect(isDecisionActionBusEligible('snooze')).toBe(false);
    expect(isDecisionActionBusEligible('approve_script')).toBe(false);
  });

  it('builds an execute-gate-matching dismiss envelope (origin decision_center)', async () => {
    const created = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 71, { dedupeKey: 'bus-envelope', actionButtons: DISMISSIBLE_ACTIONS }));
    const item = getDecisionItem(created.item!.decisionId, 71, 71)!;
    const envelope = buildDecisionDismissEnvelope(item, 71, 71, new Date());
    expect(envelope.origin).toBe('decision_center');
    expect(envelope.domain).toBe('decision_center');
    expect(envelope.commandType).toBe('decision_center.dismiss');
    // The version the executor recomputes live MUST equal what we put in preconditions.
    const liveVersion = decisionDismissVersionForItem(item);
    expect(envelope.preconditions.requiredDecisionVersion).toBe(liveVersion);
    expect(envelope.preconditions.requiredEntityVersions[`decision:${item.decisionId}`]).toBe(liveVersion);
    expect(envelope.authorization.delegatedScopes).toContain('decision_center:write');
    expect((envelope.payload as Record<string, unknown>).decisionId).toBe(item.decisionId);
  });

  it('dismisses a decision end-to-end through the committed bus', async () => {
    const created = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 72, { dedupeKey: 'bus-dismiss', actionButtons: DISMISSIBLE_ACTIONS }));
    const item = getDecisionItem(created.item!.decisionId, 72, 72)!;
    const outcome = await runDecisionActionViaCommandBus(item, { id: 'dismiss', label: 'Not now' } as never, 72, 72, new Date());
    expect(outcome.readBackOk).toBe(true);
    expect(statusOf(item.decisionId)).toBe('dismissed');
  });

  it('performDecisionAction(dismiss) is equivalent with the flag ON vs OFF', async () => {
    const off = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 73, { dedupeKey: 'equiv-off', actionButtons: DISMISSIBLE_ACTIONS }));
    const offResult = await performDecisionAction(off.item!.decisionId, 'dismiss', 73, 73, { idempotencyKey: 'off-1' });
    const offStatus = statusOf(off.item!.decisionId);

    process.env.DECISION_CENTER_COMMAND_BUS_ENABLED = 'true';
    const on = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 74, { dedupeKey: 'equiv-on', actionButtons: DISMISSIBLE_ACTIONS }));
    const onResult = await performDecisionAction(on.item!.decisionId, 'dismiss', 74, 74, { idempotencyKey: 'on-1' });
    const onStatus = statusOf(on.item!.decisionId);

    expect(offResult.status).toBe('succeeded');
    expect(onResult.status).toBe('succeeded');
    expect(onStatus).toBe(offStatus); // same terminal status via either path
  });

  it('flag-ON: rejects expired + already-dismissed dismisses, and is idempotent on repeat', async () => {
    process.env.DECISION_CENTER_COMMAND_BUS_ENABLED = 'true';

    // expired → rejected (guardActionable fires before the adapter, regardless of flag)
    const expired = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 75, { tenantId: 75, dedupeKey: 're-exp', actionButtons: DISMISSIBLE_ACTIONS }));
    testDb.prepare('UPDATE notification_center_items SET expires_at = ? WHERE item_id = ?').run('2020-01-01T00:00:00.000Z', expired.item!.decisionId);
    await expect(performDecisionAction(expired.item!.decisionId, 'dismiss', 75, 75, { idempotencyKey: 're-exp-1' })).rejects.toThrow();

    // double-submit with the same idempotency key → second is idempotent (single mutation)
    const dbl = await createDecisionIntent(buildSkillDecisionFixtureIntent('training', 75, { tenantId: 75, dedupeKey: 're-dbl', actionButtons: DISMISSIBLE_ACTIONS }));
    const first = await performDecisionAction(dbl.item!.decisionId, 'dismiss', 75, 75, { idempotencyKey: 're-dbl-k' });
    const second = await performDecisionAction(dbl.item!.decisionId, 'dismiss', 75, 75, { idempotencyKey: 're-dbl-k' });
    expect(first.status).toBe('succeeded');
    expect(second.idempotent).toBe(true);

    // a fresh dismiss of the now-dismissed decision → rejected
    await expect(performDecisionAction(dbl.item!.decisionId, 'dismiss', 75, 75, { idempotencyKey: 're-dbl-k2' })).rejects.toThrow();
  });
});
