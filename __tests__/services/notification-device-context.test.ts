/**
 * Device-reported context: timezone drift and authorization tier.
 *
 * Two gaps that made existing behaviour wrong rather than merely incomplete:
 *
 *   - `notification_profiles.timezone` is seeded once and never updated, and
 *     `users.timezone` has no write path at all. Every lead-time producer and
 *     every scheduled slot is computed in that stale zone, so a user who moves
 *     gets their 08:30 brief at 03:30.
 *   - The backend could not tell "denied" from "never asked" from "token
 *     expired". Under `.provisional` iOS delivers quietly and IGNORES
 *     interruption-level, so a time-sensitive push the server believed would
 *     ring simply does not.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

let testDb: Database.Database;
const mockSendPushNotification = vi.fn();

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
}));

vi.mock('../../src/services/user-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/user-service')>()),
  getUserLanguageById: () => 'en-US',
}));

vi.mock('../../src/services/apns-sender', () => ({
  getPushTokensForUser: vi.fn(() => [{ token: 'tok', environment: 'production' }]),
  isApnsConfigured: vi.fn(() => true),
  sendPushNotification: (...args: unknown[]) => mockSendPushNotification(...args),
  deleteDeadPushToken: vi.fn(),
  closeApnsClient: vi.fn(),
  _resetForTests: vi.fn(),
  sendPushToUsers: vi.fn(),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

import {
  createNotificationIntent,
  ensureNotificationTables,
  getOrCreateNotificationProfile,
  notificationReachability,
  notificationTimezoneDrift,
  registerNotificationDeviceToken,
  updateNotificationProfile,
} from '../../src/services/notification-orchestrator';

/**
 * Pinned clock. Neither of these suites used fake timers, so they ran against
 * the real wall clock — and the default profile quiet hours are 22:00-07:00.
 * Every push therefore became `quiet_hours_delayed` when the suite happened to
 * run at night, and these tests passed only between 07:00 and 22:00 local.
 *
 * 12:00Z is 13:00 in the default Europe/Lisbon profile zone: comfortably inside
 * waking hours, and far from any DST edge.
 */
const FIXED_NOW = new Date('2026-05-07T12:00:00.000Z');

describe('device timezone reporting', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    testDb = new Database(':memory:');
    ensureNotificationTables();
  });

  afterEach(() => {
    vi.useRealTimers();
    testDb?.close();
  });

  it('stores a device-reported zone without moving the profile', () => {
    getOrCreateNotificationProfile(500, 500);
    updateNotificationProfile(500, 500, { timezone: 'Europe/Lisbon' });

    registerNotificationDeviceToken({
      userId: 500, tenantId: 500, token: 'tok-500', deviceTimezone: 'America/New_York',
    });

    const drift = notificationTimezoneDrift(500, 500);
    expect(drift.deviceTimezone).toBe('America/New_York');
    expect(drift.drifted).toBe(true);
    // Advisory only. Auto-shifting would move every scheduled notification
    // without the user asking, and would thrash for a cross-border commuter.
    expect(drift.profileTimezone).toBe('Europe/Lisbon');
    expect(getOrCreateNotificationProfile(500, 500).timezone).toBe('Europe/Lisbon');
  });

  it('reports no drift when the device agrees with the profile', () => {
    getOrCreateNotificationProfile(501, 501);
    updateNotificationProfile(501, 501, { timezone: 'Europe/Lisbon' });
    registerNotificationDeviceToken({
      userId: 501, tenantId: 501, token: 'tok-501', deviceTimezone: 'Europe/Lisbon',
    });
    expect(notificationTimezoneDrift(501, 501).drifted).toBe(false);
  });

  it('ignores a malformed zone rather than refusing to register the token', () => {
    getOrCreateNotificationProfile(502, 502);
    // A bad zone from a client must never cost the user push entirely.
    const token = registerNotificationDeviceToken({
      userId: 502, tenantId: 502, token: 'tok-502', deviceTimezone: 'Mars/Olympus_Mons',
    });
    expect(token.tokenId).toBeTruthy();
    expect(notificationTimezoneDrift(502, 502).deviceTimezone).toBeNull();
  });

  it('keeps a previously reported zone when a later registration omits it', () => {
    getOrCreateNotificationProfile(503, 503);
    registerNotificationDeviceToken({
      userId: 503, tenantId: 503, token: 'tok-503', deviceTimezone: 'Asia/Tokyo',
    });
    registerNotificationDeviceToken({ userId: 503, tenantId: 503, token: 'tok-503' });
    expect(notificationTimezoneDrift(503, 503).deviceTimezone).toBe('Asia/Tokyo');
  });
});

describe('authorization tier and reachability', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    testDb = new Database(':memory:');
    ensureNotificationTables();
    mockSendPushNotification.mockReset();
    mockSendPushNotification.mockResolvedValue({ sent: 1, failed: 0, skipped: 0, retriable: 0, unregistered: [] });
    process.env.NOTIFICATION_DELIVERY_MODE = 'apns';
  });
  afterEach(() => {
    delete process.env.NOTIFICATION_DELIVERY_MODE;
    vi.useRealTimers();
    testDb?.close();
  });

  it('treats an unreported tier as a full grant', () => {
    // Every token minted before this field existed came from a full
    // authorization request.
    getOrCreateNotificationProfile(510, 510);
    registerNotificationDeviceToken({ userId: 510, tenantId: 510, token: 'tok-510' });
    expect(notificationReachability(510, 510)).toMatchObject({ hasToken: true, canInterrupt: true });
  });

  it('knows a provisional device cannot interrupt', () => {
    getOrCreateNotificationProfile(511, 511);
    registerNotificationDeviceToken({
      userId: 511, tenantId: 511, token: 'tok-511', authorizationTier: 'provisional',
    });
    expect(notificationReachability(511, 511)).toMatchObject({ hasToken: true, canInterrupt: false });
  });

  it('counts a user with any fully-authorized device as interruptible', () => {
    getOrCreateNotificationProfile(512, 512);
    registerNotificationDeviceToken({ userId: 512, tenantId: 512, token: 'tok-a', deviceId: 'dev-a', authorizationTier: 'provisional' });
    registerNotificationDeviceToken({ userId: 512, tenantId: 512, token: 'tok-b', deviceId: 'dev-b', authorizationTier: 'authorized' });
    expect(notificationReachability(512, 512).canInterrupt).toBe(true);
  });

  it('rejects an unknown tier rather than storing it', () => {
    getOrCreateNotificationProfile(513, 513);
    registerNotificationDeviceToken({
      userId: 513, tenantId: 513, token: 'tok-513', authorizationTier: 'nonsense' as never,
    });
    expect(notificationReachability(513, 513).tiers).toEqual(['authorized']);
  });

  it('downgrades the payload to passive for a provisional-only user', async () => {
    getOrCreateNotificationProfile(514, 514);
    registerNotificationDeviceToken({
      userId: 514, tenantId: 514, token: 'tok-514', authorizationTier: 'provisional',
    });

    const result = await createNotificationIntent({
      userId: 514, tenantId: 514, sourceSkill: 'security', type: 'security_account',
      priority: 'time_sensitive', relatedEntityId: 'mfa-1', relatedEntityType: 'garmin_connection',
      title: 'Garmin needs a code', body: 'Open Nexus to finish verification.',
      deeplink: 'nexus://notifications', dedupeKey: 'prov:514',
    });

    // Claiming time-sensitive would be a promise iOS will not keep.
    expect(result.pushPayload?.interruptionLevel).toBe('passive');
  });

  it('keeps time-sensitive for a fully authorized user', async () => {
    getOrCreateNotificationProfile(515, 515);
    registerNotificationDeviceToken({
      userId: 515, tenantId: 515, token: 'tok-515', authorizationTier: 'authorized',
    });

    const result = await createNotificationIntent({
      userId: 515, tenantId: 515, sourceSkill: 'security', type: 'security_account',
      priority: 'time_sensitive', relatedEntityId: 'mfa-2', relatedEntityType: 'garmin_connection',
      title: 'Garmin needs a code', body: 'Open Nexus to finish verification.',
      deeplink: 'nexus://notifications', dedupeKey: 'prov:515',
    });

    expect(result.pushPayload?.interruptionLevel).toBe('time-sensitive');
  });

  it('does not breach quiet hours for a device that cannot ring', async () => {
    getOrCreateNotificationProfile(516, 516);
    updateNotificationProfile(516, 516, { quietHours: { start: '00:00', end: '23:59' } });
    registerNotificationDeviceToken({
      userId: 516, tenantId: 516, token: 'tok-516', authorizationTier: 'provisional',
    });

    const result = await createNotificationIntent({
      userId: 516, tenantId: 516, sourceSkill: 'security', type: 'security_account',
      priority: 'time_sensitive', quietHoursPolicy: 'send_now',
      relatedEntityId: 'mfa-3', relatedEntityType: 'garmin_connection',
      title: 'Garmin needs a code', body: 'Open Nexus to finish verification.',
      deeplink: 'nexus://notifications', dedupeKey: 'prov:516',
    });

    // A quiet-hours breakthrough on a silent device wakes nobody but still
    // spends the credibility of the send_now escape hatch.
    expect(result.decisionLog!.decision).toBe('quiet_hours_delayed');
  });

  it('fails open when reachability cannot be read', async () => {
    getOrCreateNotificationProfile(517, 517);
    testDb.exec('ALTER TABLE notification_device_tokens RENAME TO notification_device_tokens_moved');
    try {
      // Withholding on a transient read fault would silently drop a real alert.
      expect(notificationReachability(517, 517)).toMatchObject({ hasToken: true, canInterrupt: true });
    } finally {
      testDb.exec('ALTER TABLE notification_device_tokens_moved RENAME TO notification_device_tokens');
    }
  });
});
