// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { afterEach, describe, expect, it, vi } from 'vitest';

const mockLoggerWarn = vi.fn();
const mockLoggerInfo = vi.fn();
const mockPushEvent = vi.fn();
const mockRecordOperatorAlert = vi.fn();
const mockGetDb = vi.fn();

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: (...args: unknown[]) => mockLoggerInfo(...args),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    error: vi.fn(),
    debug: vi.fn(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

vi.mock('../../src/portal/telemetry', () => ({
  pushEvent: (...args: unknown[]) => mockPushEvent(...args),
}));

vi.mock('../../src/services/operator-alerts', () => ({
  recordOperatorAlert: (...args: unknown[]) => mockRecordOperatorAlert(...args),
}));

vi.mock('../../src/services/database', () => ({
  getDb: (...args: unknown[]) => mockGetDb(...args),
  withDatabaseForTestAsync: vi.fn(),
}));

describe('integration health Garmin passive probe', () => {
  afterEach(async () => {
    const { _resetIntegrationHealthDepsForTests } = await import('../../src/services/integration-health');
    _resetIntegrationHealthDepsForTests();
    vi.clearAllMocks();
  });

  it('mirrors garmin_keepalive history without touching Garmin auth or SSO APIs', async () => {
    const keepAlive = vi.fn();
    const ensureAuthenticated = vi.fn();
    const getUserSettings = vi.fn();
    const prepare = vi.fn((sql: string) => ({
      get: vi.fn(() => {
        if (sql.includes("WHERE job_name = 'garmin_keepalive'")) {
          return {
            result: 'success',
            duration_ms: 42,
            error_message: null,
            ts: new Date().toISOString().replace(/Z$/, ''),
          };
        }
        return undefined;
      }),
      run: vi.fn(),
      all: vi.fn(() => []),
    }));
    mockGetDb.mockReturnValue({ prepare });

    const {
      _setIntegrationHealthDepsForTests,
      runHealthProbes,
    } = await import('../../src/services/integration-health');

    _setIntegrationHealthDepsForTests({
      getGarminModule: () => ({
        isGarminConfigured: () => true,
        keepAlive,
        ensureAuthenticated,
        getUserSettings,
      } as any),
      // The probe decides "configured" from per-user connection state rather
      // than the deployment-wide credential pair, which reported
      // `skipped: not configured` on deployments where users had linked their
      // own accounts and the keep-alive cron was running for them.
      getGarminSessionStoreModule: () => ({
        listGarminConnectedUserIds: () => [1],
      }),
      getGoogleAuthModule: () => ({
        isGoogleConfigured: () => false,
        buildGoogleOAuth2Client: () => ({ getAccessToken: vi.fn() }),
      }),
      getMicrosoftAuthModule: () => ({
        isMicrosoftConfigured: () => false,
        getGraphClient: () => ({
          api: () => ({ select: () => ({ get: vi.fn() }) }),
        }),
      }),
    });

    const results = await runHealthProbes();

    expect(results.find((result) => result.provider === 'garmin')).toMatchObject({
      provider: 'garmin',
      status: 'ok',
      latencyMs: 42,
    });
    expect(keepAlive).not.toHaveBeenCalled();
    expect(ensureAuthenticated).not.toHaveBeenCalled();
    expect(getUserSettings).not.toHaveBeenCalled();
  });
});
