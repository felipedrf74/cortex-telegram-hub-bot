import { afterEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';

function seedUser(db: Database.Database, userId: number, tier: 'owner' | 'pro' = 'pro'): void {
  db.prepare(`
    INSERT OR IGNORE INTO users (id, telegram_id, first_name, tier, auth_provider, status)
    VALUES (?, ?, ?, ?, 'test', 'active')
  `).run(userId, 900000000 + userId, tier === 'owner' ? 'Owner' : 'Athlete', tier);
}

function seedAppleHealthData(db: Database.Database, userId: number): void {
  const today = new Date().toISOString().slice(0, 10);
  const insert = db.prepare(`
    INSERT OR REPLACE INTO apple_health_data (user_id, data_type, date, data_json, source_name)
    VALUES (?, ?, ?, ?, 'p0-garmin-applehealth-test')
  `);
  const dateDaysAgo = (days: number) => {
    const d = new Date();
    d.setDate(d.getDate() - days);
    return d.toISOString().slice(0, 10);
  };

  for (let day = 1; day <= 7; day += 1) {
    insert.run(userId, 'hrv', dateDaysAgo(day), JSON.stringify({ value: 62 + day }));
    insert.run(userId, 'resting_heart_rate', dateDaysAgo(day), JSON.stringify({ value: 55 + (day % 2) }));
  }

  insert.run(userId, 'hrv', today, JSON.stringify({ value: 74 }));
  insert.run(userId, 'sleep', today, JSON.stringify({
    totalSleepSeconds: 8 * 3600,
    deepSleepSeconds: 90 * 60,
    remSleepSeconds: 100 * 60,
  }));
  insert.run(userId, 'resting_heart_rate', today, JSON.stringify({ value: 53 }));
  insert.run(userId, 'daily_summary', today, JSON.stringify({
    activeCalories: 320,
    exerciseMinutes: 35,
    steps: 7200,
  }));
}

type AppleHealthMetric = 'hrv' | 'sleep' | 'rhr';

function seedPartialAppleHealthData(
  db: Database.Database,
  userId: number,
  metrics: readonly AppleHealthMetric[],
): void {
  const today = new Date().toISOString().slice(0, 10);
  const insert = db.prepare(`
    INSERT OR REPLACE INTO apple_health_data (user_id, data_type, date, data_json, source_name)
    VALUES (?, ?, ?, ?, 'p0-garmin-partial-applehealth-test')
  `);
  const dateDaysAgo = (days: number) => {
    const d = new Date();
    d.setDate(d.getDate() - days);
    return d.toISOString().slice(0, 10);
  };
  const has = (metric: AppleHealthMetric) => metrics.includes(metric);

  if (has('hrv')) {
    for (let day = 1; day <= 7; day += 1) {
      insert.run(userId, 'hrv', dateDaysAgo(day), JSON.stringify({ value: 58 + day }));
    }
    insert.run(userId, 'hrv', today, JSON.stringify({ value: 72 }));
  }

  if (has('sleep')) {
    insert.run(userId, 'sleep', today, JSON.stringify({
      totalSleepSeconds: 7.5 * 3600,
      deepSleepSeconds: 82 * 60,
      remSleepSeconds: 96 * 60,
    }));
  }

  if (has('rhr')) {
    for (let day = 1; day <= 7; day += 1) {
      insert.run(userId, 'resting_heart_rate', dateDaysAgo(day), JSON.stringify({ value: 56 + (day % 2) }));
    }
    insert.run(userId, 'resting_heart_rate', today, JSON.stringify({ value: 54 }));
  }
}

function isSyntheticNeutralReadiness(result: any): boolean {
  return result?.score === 60
    && result?.reasonCode === 'WEARABLE_INTEGRATION_MISSING'
    && result?.factors?.bodyBattery?.current === 0;
}

async function importGarminWithMocks({
  userId,
  isOwner,
  session = null,
  legacyFilesExist = true,
  settingsOk = true,
}: {
  userId: number;
  isOwner: boolean;
  session?: any;
  legacyFilesExist?: boolean;
  settingsOk?: boolean;
}) {
  vi.resetModules();
  vi.doUnmock('../../src/services/garmin');

  const mocks = {
    getGarminSession: vi.fn(() => session),
    resolveGarminUserId: vi.fn(() => userId),
    markGarminNeedsReauth: vi.fn(async () => undefined),
    touchGarminConnection: vi.fn(),
    upsertGarminSession: vi.fn(),
    markGarminConnectionActive: vi.fn(),
    migrateLegacyGarminTokensToSession: vi.fn(() => false),
    clearGarminSession: vi.fn(),
    isOwnerGarminUserId: vi.fn(() => isOwner),
    existsSync: vi.fn(() => legacyFilesExist),
    loadTokenByFile: vi.fn(),
    getUserSettings: settingsOk ? vi.fn(async () => ({ displayName: 'Owner' })) : vi.fn(async () => { throw new Error('invalid'); }),
    garminGet: vi.fn(async () => ({ totalSteps: 1234 })),
    fetchOauthConsumer: vi.fn(),
  };

  vi.doMock('../../src/services/garmin-session-store', () => ({
    getGarminSession: mocks.getGarminSession,
    resolveGarminUserId: mocks.resolveGarminUserId,
    markGarminNeedsReauth: mocks.markGarminNeedsReauth,
    touchGarminConnection: mocks.touchGarminConnection,
    upsertGarminSession: mocks.upsertGarminSession,
    markGarminConnectionActive: mocks.markGarminConnectionActive,
    migrateLegacyGarminTokensToSession: mocks.migrateLegacyGarminTokensToSession,
    clearGarminSession: mocks.clearGarminSession,
    isOwnerGarminUserId: mocks.isOwnerGarminUserId,
    hasActiveGarminConnection: vi.fn(() => false),
  }));
  vi.doMock('../../src/config', () => ({
    config: {
      garmin: {
        email: 'owner-garmin@example.com',
        password: 'secret',
        tokenPath: '/tmp/p0-garmin-token-files',
        coachEnabled: true,
        coachTime: '07:00',
      },
      telegram: { allowedUserIds: [1] },
      app: { timezone: 'Europe/Lisbon' },
    },
  }));
  vi.doMock('../../src/utils/logger', () => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
    LOGGER_REDACTION_PATHS: [],
  }));
  vi.doMock('fs', () => ({
    default: {
      existsSync: mocks.existsSync,
      readFileSync: vi.fn(),
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
    },
    existsSync: mocks.existsSync,
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  }));
  vi.doMock('axios', () => ({
    default: {
      create: () => ({
        get: vi.fn(),
        post: vi.fn(),
        interceptors: { response: { use: vi.fn() }, request: { use: vi.fn() } },
      }),
    },
  }));
  vi.doMock('garmin-connect', () => ({
    GarminConnect: class MockGarminConnect {
      client = {
        oauth1Token: { token: 'owner-oauth1-token' },
        oauth2Token: { token: 'owner-oauth2-token' },
        refreshOauth2Token: vi.fn(),
        fetchOauthConsumer: mocks.fetchOauthConsumer,
      };

      loadToken = vi.fn();
      loadTokenByFile = mocks.loadTokenByFile;
      getUserSettings = mocks.getUserSettings;
      get = mocks.garminGet;
    },
  }));

  const garmin = await import('../../src/services/garmin');
  return { garmin, mocks };
}

async function importReadinessWithDb() {
  vi.resetModules();
  const db = createMigratedTestDatabase();

  vi.doMock('../../src/services/database', () => ({
    getDb: () => db,
    initDatabase: vi.fn(),
    closeDatabase: vi.fn(),
    findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  }));
  vi.doMock('../../src/config', () => ({
    config: {
      garmin: { email: 'owner-garmin@example.com', password: 'secret' },
      financeEncryption: { enabled: false, masterKey: '' },
      telegram: { allowedUserIds: [1] },
      app: { timezone: 'Europe/Lisbon' },
    },
  }));
  vi.doMock('../../src/utils/logger', () => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
    LOGGER_REDACTION_PATHS: [],
  }));
  vi.doMock('../../src/services/garmin', () => ({
    isGarminConfigured: vi.fn(() => true),
    getHrvData: vi.fn(),
    getSleepData: vi.fn(),
    getBodyBatteryEvents: vi.fn(),
    getTrainingReadiness: vi.fn(),
    getDailySummary: vi.fn(),
    getActivitiesByDate: vi.fn(),
  }));
  vi.doMock('../../src/services/wearable/wearable-service', () => ({
    getReadiness: vi.fn(async () => null),
  }));
  vi.doMock('../../src/services/training-signals', () => ({
    publishLowSleep: vi.fn(),
    publishLowHrv: vi.fn(),
    publishLowReadiness: vi.fn(),
  }));

  const readiness = await import('../../src/services/readiness-scorer');
  return { db, readiness };
}

describe('readiness provider cascade — non-owner user', () => {
  let dbs: Database.Database[] = [];

  afterEach(() => {
    for (const db of dbs) db.close();
    dbs = [];
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('blocks Garmin filesystem fallback for non-owner with no session', async () => {
    const { garmin, mocks } = await importGarminWithMocks({
      userId: 1000005,
      isOwner: false,
      session: null,
      legacyFilesExist: true,
    });

    garmin.setSilentMode(true);
    const result = await garmin.getDailySummary(new Date().toISOString().slice(0, 10));

    expect(result).toBeNull();
    expect(mocks.isOwnerGarminUserId).toHaveBeenCalledWith(1000005);
    expect(mocks.loadTokenByFile).not.toHaveBeenCalled();
    expect(mocks.upsertGarminSession).not.toHaveBeenCalled();
    expect(mocks.markGarminConnectionActive).not.toHaveBeenCalled();
  });

  it('does NOT contaminate non-owner garmin_sessions row', async () => {
    const { garmin, mocks } = await importGarminWithMocks({
      userId: 1000005,
      isOwner: false,
      session: null,
      legacyFilesExist: true,
    });

    garmin.setSilentMode(true);
    await garmin.getDailySummary(new Date().toISOString().slice(0, 10));

    expect(mocks.upsertGarminSession).not.toHaveBeenCalled();
    expect(mocks.touchGarminConnection).not.toHaveBeenCalled();
    expect(mocks.markGarminConnectionActive).not.toHaveBeenCalled();
  });

  it('blocks global Garmin credential MFA login for non-owner with no session', async () => {
    const { garmin, mocks } = await importGarminWithMocks({
      userId: 1000005,
      isOwner: false,
      session: null,
      legacyFilesExist: true,
    });

    const ok = await garmin.ensureAuthenticated({ silent: false });

    expect(ok).toBe(false);
    expect(mocks.fetchOauthConsumer).not.toHaveBeenCalled();
    expect(mocks.upsertGarminSession).not.toHaveBeenCalled();
    expect(mocks.markGarminConnectionActive).not.toHaveBeenCalled();
  });

  it('falls back to Apple Health when user has health data but no Garmin', async () => {
    const { db, readiness } = await importReadinessWithDb();
    dbs.push(db);
    seedUser(db, 1000006, 'pro');
    seedAppleHealthData(db, 1000006);

    const result = await readiness.calculateReadiness(1000006);

    expect(isSyntheticNeutralReadiness(result)).toBe(false);
    expect(result.score).toBeGreaterThan(0);
    expect(result.score).toBeLessThanOrEqual(100);
    expect(result.factors.bodyBattery.current).toBeGreaterThan(0);
    expect(result.reasoning.toLowerCase()).toContain('apple health');
  });

  it.each([
    ['hrvOnly', 1000101, ['hrv'] as const],
    ['sleepOnly', 1000102, ['sleep'] as const],
    ['rhrOnly', 1000103, ['rhr'] as const],
    ['hrvSleep', 1000104, ['hrv', 'sleep'] as const],
    ['hrvRhr', 1000105, ['hrv', 'rhr'] as const],
    ['sleepRhr', 1000106, ['sleep', 'rhr'] as const],
  ])('uses Apple Health readiness when partial data exists: %s', async (_caseName, userId, metrics) => {
    const { db, readiness } = await importReadinessWithDb();
    dbs.push(db);
    seedUser(db, userId, 'pro');
    seedPartialAppleHealthData(db, userId, metrics);

    const result = await readiness.calculateReadiness(userId);

    expect(result).not.toBeNull();
    expect(isSyntheticNeutralReadiness(result)).toBe(false);
    expect(result.score).toBeGreaterThan(0);
    expect(result.score).toBeLessThanOrEqual(100);
    expect(result.reasoning.toLowerCase()).toContain('apple health');
  });

  it('returns synthetic neutral when neither Garmin nor Apple Health has data', async () => {
    const { db, readiness } = await importReadinessWithDb();
    dbs.push(db);
    seedUser(db, 1000007, 'pro');

    const result = await readiness.calculateReadiness(1000007);

    expect(isSyntheticNeutralReadiness(result)).toBe(true);
    expect(result.reasoning).toContain('No wearable connected');
  });

  it('owner request still uses filesystem fallback when applicable', async () => {
    const { garmin, mocks } = await importGarminWithMocks({
      userId: 1,
      isOwner: true,
      session: null,
      legacyFilesExist: true,
    });

    garmin.setSilentMode(true);
    const result = await garmin.getDailySummary(new Date().toISOString().slice(0, 10));

    expect(result).toEqual({ totalSteps: 1234 });
    expect(mocks.loadTokenByFile).toHaveBeenCalledWith('/tmp/p0-garmin-token-files');
    expect(mocks.upsertGarminSession).toHaveBeenCalledWith(1, {
      oauth1: { token: 'owner-oauth1-token' },
      oauth2: { token: 'owner-oauth2-token' },
    });
    expect(mocks.markGarminConnectionActive).toHaveBeenCalledWith(1, 'owner-garmin@example.com');
  });
});
