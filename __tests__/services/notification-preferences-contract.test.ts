/**
 * Preference contract honesty.
 *
 * `PUT /api/v1/notifications/preferences` used to answer HTTP 200 for writes
 * it dropped on the floor. Three separate ways:
 *
 *   1. Unknown keys were swallowed — `updateNotificationProfile` only reads the
 *      fields named in its UPDATE statement.
 *   2. Invalid values were silently coerced back to the current value by
 *      `normalizeTime` / `positiveIntOr` / `stringOr`.
 *   3. Five "decision preferences" (`autoHideResolved`, `homePreviewMode`,
 *      `askBefore*`) are returned by `getDecisionPreferences` as hardcoded
 *      literals, so a client could send `false` and be told `true`.
 *
 * These tests pin the reporting, not a behaviour change: invalid input still
 * falls back rather than 400ing, because iOS builds already in the wild send
 * fields this server never honoured. What changed is that the caller is told.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
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
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

import {
  applyNotificationProfilePatch,
  ensureNotificationTables,
  getOrCreateNotificationProfile,
} from '../../src/services/notification-orchestrator';

const U = 401;

function rejectionFor(result: ReturnType<typeof applyNotificationProfilePatch>, field: string) {
  return result.rejected.find((r) => r.field === field);
}

describe('notification preference contract', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    ensureNotificationTables();
    getOrCreateNotificationProfile(U, U);
  });

  afterEach(() => testDb?.close());

  it('applies a valid patch and reports every field it applied', () => {
    const result = applyNotificationProfilePatch(U, U, {
      pushEnabled: false,
      dailyDigestTime: '07:15',
      workoutReminderMinutes: 90,
      quietHours: { start: '23:00', end: '06:30' },
    });

    expect(result.rejected).toEqual([]);
    expect(result.applied.sort()).toEqual(['dailyDigestTime', 'pushEnabled', 'quietHours', 'workoutReminderMinutes']);
    expect(result.profile.pushEnabled).toBe(false);
    expect(result.profile.dailyDigestTime).toBe('07:15');
    expect(result.profile.workoutReminderMinutes).toBe(90);
    expect(result.profile.quietHours).toEqual({ start: '23:00', end: '06:30' });
  });

  it('reports an invalid value instead of silently keeping the old one', () => {
    const before = getOrCreateNotificationProfile(U, U).dailyDigestTime;
    const result = applyNotificationProfilePatch(U, U, { dailyDigestTime: '25:99' });

    // Behaviour is unchanged — the old value survives, no throw.
    expect(result.profile.dailyDigestTime).toBe(before);
    // The difference: the caller is told.
    expect(result.applied).not.toContain('dailyDigestTime');
    expect(rejectionFor(result, 'dailyDigestTime')).toMatchObject({ reason: 'invalid_value' });
  });

  it('rejects a non-positive reminder lead time', () => {
    const result = applyNotificationProfilePatch(U, U, { workoutReminderMinutes: 0 });
    expect(rejectionFor(result, 'workoutReminderMinutes')).toMatchObject({ reason: 'invalid_value' });
    expect(result.profile.workoutReminderMinutes).toBe(60);
  });

  it('rejects an unparseable timezone rather than pretending it took', () => {
    const result = applyNotificationProfilePatch(U, U, { timezone: 'Mars/Olympus_Mons' });
    expect(rejectionFor(result, 'timezone')).toMatchObject({ reason: 'invalid_value' });
    expect(result.profile.timezone).not.toBe('Mars/Olympus_Mons');
  });

  it('rejects quiet hours whose start equals its end', () => {
    // Previously this threw, 400ing the whole request even when every other
    // field in the patch was valid.
    const result = applyNotificationProfilePatch(U, U, {
      quietHours: { start: '22:00', end: '22:00' },
      pushEnabled: false,
    });
    expect(rejectionFor(result, 'quietHours')).toMatchObject({ reason: 'invalid_value' });
    // The valid sibling field still lands.
    expect(result.applied).toContain('pushEnabled');
    expect(result.profile.pushEnabled).toBe(false);
  });

  it('names unknown fields instead of swallowing them', () => {
    const result = applyNotificationProfilePatch(U, U, { thisIsNotAPreference: true });
    expect(rejectionFor(result, 'thisIsNotAPreference')).toMatchObject({ reason: 'unknown_field' });
    expect(result.applied).toEqual([]);
  });

  it('marks the five hardcoded decision preferences as not implemented', () => {
    // getDecisionPreferences returns these as literals, so the old endpoint
    // answered 200 and echoed a value the client never sent.
    const result = applyNotificationProfilePatch(U, U, {
      autoHideResolved: false,
      homePreviewMode: 'everything',
      askBeforeScheduleChanges: false,
      askBeforeContentPublishing: false,
      askBeforeTrainingReflow: false,
    });

    for (const field of [
      'autoHideResolved', 'homePreviewMode', 'askBeforeScheduleChanges',
      'askBeforeContentPublishing', 'askBeforeTrainingReflow',
    ]) {
      expect(rejectionFor(result, field), field).toMatchObject({ reason: 'not_implemented' });
    }
    expect(result.applied).toEqual([]);
  });

  it('marks preference columns that exist but gate nothing', () => {
    // These persist (the column is real) but no code reads them, so a settings
    // screen must not render them as working switches.
    const result = applyNotificationProfilePatch(U, U, {
      localEnabled: false,
      emailEnabled: true,
      doNotNotifyRules: [{ skill: 'training' }],
      contentReminderMinutes: 240,
    });
    for (const field of ['localEnabled', 'emailEnabled', 'doNotNotifyRules', 'contentReminderMinutes']) {
      expect(rejectionFor(result, field), field).toMatchObject({ reason: 'not_implemented' });
    }
    // Still persisted, so the value survives a future wiring.
    expect(result.profile.contentReminderMinutes).toBe(240);
  });

  it('validates skill preferences individually', () => {
    const result = applyNotificationProfilePatch(U, U, {
      skillPreferences: { training: false, notaskill: true, finance: 'yes' },
    });

    expect(rejectionFor(result, 'skillPreferences.notaskill')).toMatchObject({ reason: 'unknown_field' });
    expect(rejectionFor(result, 'skillPreferences.finance')).toMatchObject({ reason: 'invalid_value' });
    // The one good entry still lands — a typo in one skill must not discard the rest.
    expect(result.profile.skillPreferences.training).toBe(false);
    expect(result.profile.skillPreferences.finance).toBe(true);
  });

  it('ignores undefined fields without reporting them', () => {
    const result = applyNotificationProfilePatch(U, U, { pushEnabled: undefined, portalEnabled: true });
    expect(result.applied).toEqual(['portalEnabled']);
    expect(result.rejected).toEqual([]);
  });
});
