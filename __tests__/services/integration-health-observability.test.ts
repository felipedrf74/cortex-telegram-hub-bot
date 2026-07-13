import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

let testDb: Database.Database;

const pushEvent = vi.fn();

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  applyMigrationFileForTest: vi.fn(),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  filterAlreadyAppliedAddColumnStatements: vi.fn((sql: string) => sql),
  runMigrationsForTest: vi.fn(),
  stripWrappingTransactionStatements: vi.fn((sql: string) => sql),
  withDatabaseForTest: vi.fn(),
}));

vi.mock('../../src/portal/telemetry', () => ({
  pushEvent,
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

describe('integration health observability', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.exec(`
      CREATE TABLE integration_health (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL DEFAULT (datetime('now')),
        provider TEXT NOT NULL,
        status TEXT NOT NULL,
        latency_ms INTEGER,
        error_message TEXT
      );
    `);
    for (const file of ['076_operator_alerts.sql', '077_operator_alert_delivery.sql']) {
      testDb.exec(fs.readFileSync(
        path.resolve(__dirname, '../../migrations', file),
        'utf8',
      ));
    }
    pushEvent.mockReset();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    const mod = await import('../../src/services/integration-health');
    mod._resetIntegrationHealthDepsForTests();
    testDb.close();
  });

  it('emits an operator event when a provider reaches the repeated-failure threshold', async () => {
    const mod = await import('../../src/services/integration-health');
    const { logger } = await import('../../src/utils/logger');
    const getAccessToken = vi.fn().mockRejectedValue(new Error('invalid_grant'));
    mod._setIntegrationHealthDepsForTests({
      getGarminModule: () => ({ isGarminConfigured: () => false }),
      getGoogleAuthModule: () => ({
        isGoogleConfigured: () => true,
        buildGoogleOAuth2Client: () => ({ getAccessToken }),
      }),
      getMicrosoftAuthModule: () => ({
        isMicrosoftConfigured: () => false,
        getGraphClient: () => ({
          api: () => ({
            select: () => ({
              get: vi.fn(),
            }),
          }),
        }),
      }),
    });

    const threshold = mod._getFailureAlertThresholdForTests();
    for (let i = 0; i < threshold - 1; i += 1) {
      testDb
        .prepare(`INSERT INTO integration_health (provider, status, latency_ms, error_message) VALUES (?, ?, ?, ?)`)
        .run('google', 'fail', 1200, 'invalid_grant');
    }
    const results = await mod.runHealthProbes();

    expect(results.find((result) => result.provider === 'google')?.status).toBe('fail');
    expect(pushEvent).toHaveBeenCalledTimes(2);
    expect(pushEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        summary: `Integration google degraded (${threshold} fails)`,
        detail: 'invalid_grant',
      }),
    );
    expect(pushEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        summary: 'Operator alert: Integração google degradada',
        detail: expect.stringContaining('integration_health'),
      }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'google',
        streak: threshold,
        errorMessage: 'invalid_grant',
      }),
      'Integration health degraded after repeated probe failures',
    );
    const alert = testDb.prepare('SELECT * FROM operator_alerts').get() as any;
    expect(alert).toMatchObject({
      severity: 'warning',
      source: 'integration_health',
      dedupe_key: 'integration:google:degraded',
      title: 'Integração google degradada',
      detail: 'invalid_grant',
      status: 'open',
      occurrence_count: 1,
      delivery_status: 'pending',
      owner: 'ops',
      suspected_area: 'integration_sync',
    });
    expect(JSON.parse(alert.metadata_json)).toMatchObject({
      provider: 'google',
      failureStreak: threshold,
    });
  });

  it('does not emit repeated degradation events after the threshold has already been crossed', async () => {
    const mod = await import('../../src/services/integration-health');
    const getAccessToken = vi.fn().mockRejectedValue(new Error('invalid_grant'));
    mod._setIntegrationHealthDepsForTests({
      getGarminModule: () => ({ isGarminConfigured: () => false }),
      getGoogleAuthModule: () => ({
        isGoogleConfigured: () => true,
        buildGoogleOAuth2Client: () => ({ getAccessToken }),
      }),
      getMicrosoftAuthModule: () => ({
        isMicrosoftConfigured: () => false,
        getGraphClient: () => ({
          api: () => ({
            select: () => ({
              get: vi.fn(),
            }),
          }),
        }),
      }),
    });

    const threshold = mod._getFailureAlertThresholdForTests();
    for (let i = 0; i < threshold; i += 1) {
      testDb
        .prepare(`INSERT INTO integration_health (provider, status, latency_ms, error_message) VALUES (?, ?, ?, ?)`)
        .run('google', 'fail', 1200, 'invalid_grant');
    }
    await mod.runHealthProbes();

    expect(pushEvent).not.toHaveBeenCalled();
    const alerts = testDb.prepare('SELECT * FROM operator_alerts').all();
    expect(alerts).toHaveLength(0);
  });
});
