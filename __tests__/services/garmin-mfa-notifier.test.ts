import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

let testDb: Database.Database;

const mockCreateNotificationIntent = vi.fn();
const mockRecordOperatorAlert = vi.fn();
const mockGetOwnerBootstrapTarget = vi.fn();
const mockSetMfaNotifier = vi.fn();

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
}));

vi.mock('../../src/services/notification-orchestrator', () => ({
  createNotificationIntent: (...args: unknown[]) => mockCreateNotificationIntent(...args),
}));

vi.mock('../../src/services/operator-alerts', () => ({
  recordOperatorAlert: (...args: unknown[]) => mockRecordOperatorAlert(...args),
}));

vi.mock('../../src/services/user-service', () => ({
  getOwnerBootstrapTarget: (...args: unknown[]) => mockGetOwnerBootstrapTarget(...args),
}));

vi.mock('../../src/services/garmin', () => ({
  setMfaNotifier: (...args: unknown[]) => mockSetMfaNotifier(...args),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

function seedUsersTable(): void {
  testDb.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      telegram_id INTEGER,
      tier TEXT NOT NULL,
      status TEXT NOT NULL
    );
  `);
}

describe('Garmin MFA notifier', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    mockCreateNotificationIntent.mockReset();
    mockCreateNotificationIntent.mockResolvedValue({ decision: 'in_app_only' });
    mockRecordOperatorAlert.mockReset();
    mockRecordOperatorAlert.mockReturnValue({ ok: true, action: 'created' });
    mockGetOwnerBootstrapTarget.mockReset();
    mockGetOwnerBootstrapTarget.mockReturnValue(null);
    mockSetMfaNotifier.mockReset();
  });

  afterEach(() => {
    testDb.close();
  });

  it('records an operator alert and sends APNs intents to active owner tenants only', async () => {
    seedUsersTable();
    testDb.prepare('INSERT INTO users (id, telegram_id, tier, status) VALUES (?, ?, ?, ?)').run(11, 1011, 'owner', 'active');
    testDb.prepare('INSERT INTO users (id, telegram_id, tier, status) VALUES (?, ?, ?, ?)').run(22, 1022, 'pro', 'active');
    testDb.prepare('INSERT INTO users (id, telegram_id, tier, status) VALUES (?, ?, ?, ?)').run(33, 1033, 'owner', 'suspended');

    const { notifyGarminMfaRequired } = await import('../../src/services/garmin-mfa-notifier');

    await notifyGarminMfaRequired('<b>Telegram-only MFA body</b>');

    expect(mockRecordOperatorAlert).toHaveBeenCalledWith(expect.objectContaining({
      source: 'garmin_mfa',
      dedupeKey: 'garmin:mfa:required',
      title: 'Garmin needs verification',
      metadata: expect.objectContaining({
        ownerTenantCount: 1,
        delivery: 'operator_alert_and_apns',
      }),
    }));
    expect(JSON.stringify(mockRecordOperatorAlert.mock.calls[0][0])).not.toContain('Telegram-only MFA body');

    expect(mockCreateNotificationIntent).toHaveBeenCalledTimes(1);
    expect(mockCreateNotificationIntent).toHaveBeenCalledWith(expect.objectContaining({
      userId: 11,
      tenantId: 11,
      sourceSkill: 'security',
      type: 'security_account',
      priority: 'time_sensitive',
      deliveryPolicy: 'push_allowed',
      privacyPolicy: 'sensitive',
      requiresUserAction: true,
      deeplink: 'nexus://connections/garmin/reauth',
      expiresAt: expect.any(String),
      decisionDeadline: expect.any(String),
      visibilityScope: 'user_private',
      decisionContext: expect.objectContaining({
        entityTitle: 'Garmin Connect',
        providerName: 'Garmin',
        sourceState: 'mfa_pending',
        reasonCodes: ['garmin_mfa_required'],
      }),
    }));
    const payload = mockCreateNotificationIntent.mock.calls[0][0];
    expect(payload.decisionDeadline).toBe(payload.expiresAt);
    expect(Date.parse(payload.decisionDeadline)).toBeGreaterThan(Date.now());
  });

  it('falls back to the owner bootstrap tenant when the users table is unavailable', async () => {
    mockGetOwnerBootstrapTarget.mockReturnValue({ tenantId: 99, telegramId: 1099 });
    const { notifyGarminMfaRequired } = await import('../../src/services/garmin-mfa-notifier');

    await notifyGarminMfaRequired();

    expect(mockCreateNotificationIntent).toHaveBeenCalledWith(expect.objectContaining({
      userId: 99,
      tenantId: 99,
    }));
  });

  it('registers the APNs/operator-alert notifier with the Garmin service at startup', async () => {
    const { notifyGarminMfaRequired, registerGarminMfaNotifier } = await import('../../src/services/garmin-mfa-notifier');

    registerGarminMfaNotifier();

    expect(mockSetMfaNotifier).toHaveBeenCalledWith(notifyGarminMfaRequired);
  });
});
