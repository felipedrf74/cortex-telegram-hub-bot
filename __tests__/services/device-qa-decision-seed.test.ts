import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';

let testDb: Database.Database;

vi.mock('../../src/services/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/database')>()),
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  withDatabaseForTestAsync: vi.fn(),
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
  DEVICE_QA_EMAILS_ENV,
  DEVICE_QA_SEED_DEDUPE_PREFIX,
  DeviceQaDecisionSeedError,
  isDeviceQaSeedPrincipal,
  seedDeviceQaApproveGatedDecision,
} from '../../src/services/device-qa-decision-seed';
import {
  dismissDecision,
  ensureDecisionCenterTables,
  getDecisionOverview,
  performDecisionAction,
} from '../../src/services/decision-center';
import { ensureNotificationTables } from '../../src/services/notification-orchestrator';
import { initializeDecisionCenterSchemaForTests } from '../../src/testing/decision-center-test-schema';

const QA_USER_ID = 1200032;
const OWNER_USER_ID = 1;
const STRANGER_USER_ID = 44;

function ensureSecretaryAgendaFixtureTables(): void {
  testDb.exec(readFileSync('migrations/083_secretary_agenda_ledger.sql', 'utf8'));
  const columns = new Set((testDb.prepare('PRAGMA table_info(secretary_agenda_items)').all() as Array<{ name: string }>)
    .map((column) => column.name));
  if (!columns.has('decision_explanation')) {
    testDb.exec('ALTER TABLE secretary_agenda_items ADD COLUMN decision_explanation TEXT');
  }
  if (!columns.has('reasoning_trail_json')) {
    testDb.exec('ALTER TABLE secretary_agenda_items ADD COLUMN reasoning_trail_json TEXT');
  }
}

function ensureUsersTable(): void {
  testDb.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      telegram_id INTEGER,
      email TEXT,
      first_name TEXT,
      language TEXT NOT NULL DEFAULT 'pt-PT',
      timezone TEXT NOT NULL DEFAULT 'Europe/Lisbon',
      tier TEXT NOT NULL DEFAULT 'max',
      status TEXT NOT NULL DEFAULT 'active'
    )
  `);
}

function insertUser(input: {
  id: number;
  firstName: string;
  tier?: string;
  email?: string | null;
  status?: string;
}): void {
  testDb.prepare(`
    INSERT INTO users (id, telegram_id, email, first_name, language, timezone, tier, status)
    VALUES (?, ?, ?, ?, 'pt-PT', 'Europe/Lisbon', ?, ?)
  `).run(
    input.id,
    input.id + 9_000_000,
    input.email ?? null,
    input.firstName,
    input.tier ?? 'max',
    input.status ?? 'active',
  );
}

describe('DeviceQA Decision Center seed', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-06T12:00:00.000Z'));
    testDb = new Database(':memory:');
    process.env.NOTIFICATION_DELIVERY_MODE = 'mock';
    delete process.env[DEVICE_QA_EMAILS_ENV];
    delete process.env.OWNER_TELEGRAM_ID;
    delete process.env.DECISION_CENTER_REWRITE_MODE;
    ensureUsersTable();
    ensureSecretaryAgendaFixtureTables();
    ensureNotificationTables();
    initializeDecisionCenterSchemaForTests();
    ensureDecisionCenterTables();
    insertUser({ id: QA_USER_ID, firstName: 'DeviceQA', email: 'deviceqa@example.test' });
    insertUser({ id: OWNER_USER_ID, firstName: 'DeviceQA', tier: 'owner', email: 'owner@example.test' });
    insertUser({ id: STRANGER_USER_ID, firstName: 'Felipe', email: 'stranger@example.test' });
  });

  afterEach(() => {
    delete process.env.NOTIFICATION_DELIVERY_MODE;
    delete process.env[DEVICE_QA_EMAILS_ENV];
    delete process.env.OWNER_TELEGRAM_ID;
    delete process.env.DECISION_CENTER_REWRITE_MODE;
    vi.useRealTimers();
    testDb?.close();
  });

  it('recognizes only a non-owner DeviceQA personal principal', () => {
    expect(isDeviceQaSeedPrincipal({ userId: QA_USER_ID, tenantId: QA_USER_ID })).toBe(true);
    expect(isDeviceQaSeedPrincipal({ userId: QA_USER_ID, tenantId: OWNER_USER_ID })).toBe(false);
    expect(isDeviceQaSeedPrincipal({ userId: OWNER_USER_ID, tenantId: OWNER_USER_ID })).toBe(false);
    expect(isDeviceQaSeedPrincipal({ userId: STRANGER_USER_ID, tenantId: STRANGER_USER_ID })).toBe(false);
  });

  it('honors an explicit DeviceQA email allowlist when configured', () => {
    process.env[DEVICE_QA_EMAILS_ENV] = 'deviceqa@example.test';
    expect(isDeviceQaSeedPrincipal({ userId: QA_USER_ID, tenantId: QA_USER_ID })).toBe(true);
    process.env[DEVICE_QA_EMAILS_ENV] = 'other-qa@example.test';
    expect(isDeviceQaSeedPrincipal({ userId: QA_USER_ID, tenantId: QA_USER_ID })).toBe(false);
  });

  it('creates an open approve-gated Decision Center item without a calendar provider', async () => {
    const created = await seedDeviceQaApproveGatedDecision({
      userId: QA_USER_ID,
      tenantId: QA_USER_ID,
      idempotencyKey: 'device-qa-seed-1',
      proposalRequestFingerprint: 'a'.repeat(64),
    });

    expect(created.item).toMatchObject({
      userId: QA_USER_ID,
      tenantId: QA_USER_ID,
      sourceSkill: 'secretary',
      status: 'unread',
      relatedEntities: [expect.objectContaining({ type: 'secretary_agenda_item' })],
    });
    expect(created.item?.actions.some((action) => action.id === 'accept_reflow')).toBe(true);
    expect(created.item?.dedupeKey ?? created.item?.itemId).toBeTruthy();
    expect(getDecisionOverview(QA_USER_ID, QA_USER_ID).openCount).toBe(1);

    const replay = await seedDeviceQaApproveGatedDecision({
      userId: QA_USER_ID,
      tenantId: QA_USER_ID,
      idempotencyKey: 'device-qa-seed-2',
      proposalRequestFingerprint: 'b'.repeat(64),
    });
    expect(replay.item?.decisionId).toBe(created.item?.decisionId);
    expect(getDecisionOverview(QA_USER_ID, QA_USER_ID).openCount).toBe(1);
  });

  it('keeps the approve-gated seed in overview after the source-freshness window', async () => {
    const created = await seedDeviceQaApproveGatedDecision({
      userId: QA_USER_ID,
      tenantId: QA_USER_ID,
      idempotencyKey: 'device-qa-seed-stale-window',
      proposalRequestFingerprint: 'aa'.repeat(32),
    });
    expect(created.item).not.toBeNull();

    vi.setSystemTime(new Date('2026-09-06T12:20:00.000Z'));

    const overview = getDecisionOverview(QA_USER_ID, QA_USER_ID);
    const visible = overview.items.find((item) => item.decisionId === created.item!.decisionId);
    expect(visible).toBeDefined();
    expect(visible?.recommendedAction).toMatchObject({ id: 'accept_reflow', label: 'Aprovar' });
    expect(visible?.analysis.sourceFreshness).toBe('stale');
    expect(overview.openCount).toBeGreaterThanOrEqual(1);
  });

  it('recreates the DeviceQA seed after dismiss and after handle', async () => {
    const first = await seedDeviceQaApproveGatedDecision({
      userId: QA_USER_ID,
      tenantId: QA_USER_ID,
      idempotencyKey: 'device-qa-seed-dismiss',
      proposalRequestFingerprint: 'ab'.repeat(32),
    });
    expect(first.item).not.toBeNull();

    dismissDecision(first.item!.decisionId, QA_USER_ID, QA_USER_ID, 'not_relevant', first.item!.recordVersion);
    expect(getDecisionOverview(QA_USER_ID, QA_USER_ID).openCount).toBe(0);

    const afterDismiss = await seedDeviceQaApproveGatedDecision({
      userId: QA_USER_ID,
      tenantId: QA_USER_ID,
      idempotencyKey: 'device-qa-seed-dismiss-retry',
      proposalRequestFingerprint: 'ac'.repeat(32),
    });
    expect(afterDismiss.item).not.toBeNull();
    expect(afterDismiss.item?.decisionId).not.toBe(first.item?.decisionId);
    expect(getDecisionOverview(QA_USER_ID, QA_USER_ID).openCount).toBe(1);

    const handled = await performDecisionAction(
      afterDismiss.item!.decisionId,
      'accept_reflow',
      QA_USER_ID,
      QA_USER_ID,
      {
        idempotencyKey: 'device-qa-accept-reflow-retry',
        expectedVersion: afterDismiss.item!.recordVersion,
      },
    );
    expect(handled.status).toBe('succeeded');
    expect(getDecisionOverview(QA_USER_ID, QA_USER_ID).openCount).toBe(0);

    const afterHandle = await seedDeviceQaApproveGatedDecision({
      userId: QA_USER_ID,
      tenantId: QA_USER_ID,
      idempotencyKey: 'device-qa-seed-handle-retry',
      proposalRequestFingerprint: 'ad'.repeat(32),
    });
    expect(afterHandle.item).not.toBeNull();
    expect(afterHandle.item?.decisionId).not.toBe(afterDismiss.item?.decisionId);
    expect(getDecisionOverview(QA_USER_ID, QA_USER_ID).openCount).toBe(1);
  });

  it('lets DeviceQA approve the seeded reflow and clears the Home open count', async () => {
    const created = await seedDeviceQaApproveGatedDecision({
      userId: QA_USER_ID,
      tenantId: QA_USER_ID,
      idempotencyKey: 'device-qa-seed-approve',
      proposalRequestFingerprint: 'c'.repeat(64),
    });
    expect(created.item).not.toBeNull();

    const result = await performDecisionAction(
      created.item!.decisionId,
      'accept_reflow',
      QA_USER_ID,
      QA_USER_ID,
      {
        idempotencyKey: 'device-qa-accept-reflow',
        expectedVersion: created.item!.recordVersion,
      },
    );

    expect(result.status).toBe('succeeded');
    expect(result.item.status).toBe('actioned');
    expect(getDecisionOverview(QA_USER_ID, QA_USER_ID).openCount).toBe(0);
    expect(getDecisionOverview(QA_USER_ID, QA_USER_ID).handledCount).toBeGreaterThan(0);
  });

  it('refuses owner and ordinary users', async () => {
    await expect(seedDeviceQaApproveGatedDecision({
      userId: OWNER_USER_ID,
      tenantId: OWNER_USER_ID,
      idempotencyKey: 'owner-seed',
      proposalRequestFingerprint: 'd'.repeat(64),
    })).rejects.toBeInstanceOf(DeviceQaDecisionSeedError);

    await expect(seedDeviceQaApproveGatedDecision({
      userId: STRANGER_USER_ID,
      tenantId: STRANGER_USER_ID,
      idempotencyKey: 'stranger-seed',
      proposalRequestFingerprint: 'e'.repeat(64),
    })).rejects.toBeInstanceOf(DeviceQaDecisionSeedError);

    expect(getDecisionOverview(OWNER_USER_ID, OWNER_USER_ID).openCount).toBe(0);
    expect(getDecisionOverview(STRANGER_USER_ID, STRANGER_USER_ID).openCount).toBe(0);
  });
});

describe('DeviceQA seed contract markers', () => {
  it('keeps the DeviceQA dedupe prefix stable', () => {
    expect(DEVICE_QA_SEED_DEDUPE_PREFIX).toBe('device-qa:dc-seed:secretary:');
  });
});
