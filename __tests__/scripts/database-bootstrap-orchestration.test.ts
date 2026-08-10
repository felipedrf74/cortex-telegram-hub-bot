// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
// Focused release/bootstrap orchestration coverage; no live database is opened.

import { afterAll, describe, expect, it, vi } from 'vitest';

const identity = {
  releaseId: 'a'.repeat(32),
  sourceSha: 'b'.repeat(40),
  backendImageDigest: `sha256:${'c'.repeat(64)}`,
};

const mockedModules = [
  '../../src/config',
  '../../src/skills/skill-manager',
  '../../src/utils/logger',
  '../../src/services/config-provider',
  '../../src/services/database',
  '../../src/services/finance-tracker',
  '../../src/services/garmin-session-store',
  '../../src/services/ios-auth-session',
  '../../src/services/model-config',
  '../../src/services/oauth-store',
  '../../src/services/persisted-model-overrides',
  '../../src/services/release-data-maintenance',
  '../../src/services/user-service',
] as const;

type MaintenanceOverrides = {
  refreshTokenError?: Error;
  archiveError?: Error;
  oauthError?: Error;
  seedSkillsError?: Error;
  settingsError?: Error;
  archivedRows?: number;
  encryptedOAuthRows?: number;
  encryptedTransactions?: number;
  encryptedTaxEvents?: number;
  encryptedSessions?: number;
  encryptedUserTokens?: number;
};

function resultOrThrow<T>(result: T, error?: Error): () => T {
  return vi.fn(() => {
    if (error) throw error;
    return result;
  });
}

async function loadBootstrap(overrides: MaintenanceOverrides = {}) {
  vi.resetModules();

  const logger = {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
  const runtimeDatabase = {};
  const immediate = vi.fn();
  const releaseDatabase = {
    transaction: vi.fn((action: () => void) => {
      immediate.mockImplementation(action);
      return { immediate };
    }),
  };
  const loadPersistedSettings = resultOrThrow(undefined, overrides.settingsError);
  const setConfigProvider = vi.fn();
  const backfillLegacyRefreshTokenHashes = resultOrThrow(
    { hashedRows: 0, clearedPlaintextRows: 0 },
    overrides.refreshTokenError,
  );
  const backfillTelegramIdentityArchive = resultOrThrow(
    { archivedRows: overrides.archivedRows ?? 0 },
    overrides.archiveError,
  );
  const encryptPlaintextOAuthTokens = resultOrThrow(
    { encryptedRows: overrides.encryptedOAuthRows ?? 0 },
    overrides.oauthError,
  );
  const encryptPlaintextFinanceRows = vi.fn(() => ({
    encryptedTransactions: overrides.encryptedTransactions ?? 0,
    encryptedTaxEvents: overrides.encryptedTaxEvents ?? 0,
  }));
  const encryptPlaintextGarminTokens = vi.fn(() => ({
    encryptedSessions: overrides.encryptedSessions ?? 0,
    encryptedUserTokens: overrides.encryptedUserTokens ?? 0,
  }));
  const seedDefaultSkills = resultOrThrow(undefined, overrides.seedSkillsError);
  const loadModelOverrides = vi.fn();

  vi.doMock('../../src/config', () => ({
    config: {
      app: {
        databasePath: '/tmp/database-bootstrap-orchestration.db',
        migrationsMode: 'boot',
      },
    },
  }));
  vi.doMock('../../src/skills/skill-manager', () => ({ seedDefaultSkills }));
  vi.doMock('../../src/utils/logger', () => ({ logger }));
  vi.doMock('../../src/services/config-provider', () => ({
    DatabaseConfigProvider: class {
      loadPersistedSettings = loadPersistedSettings;
    },
    setConfigProvider,
  }));
  vi.doMock('../../src/services/database', () => ({
    getDb: vi.fn(() => runtimeDatabase),
    initializeDatabaseCore: vi.fn(() => runtimeDatabase),
    withReleaseMaintenanceDatabase: vi.fn(
      (_database: unknown, action: () => void) => action(),
    ),
  }));
  vi.doMock('../../src/services/finance-tracker', () => ({
    assertFinanceEncryptionConfigured: vi.fn(),
    encryptPlaintextFinanceRows,
  }));
  vi.doMock('../../src/services/garmin-session-store', () => ({
    assertGarminEncryptionConfigured: vi.fn(),
    encryptPlaintextGarminTokens,
  }));
  vi.doMock('../../src/services/ios-auth-session', () => ({
    backfillLegacyRefreshTokenHashes,
  }));
  vi.doMock('../../src/services/model-config', () => ({ loadModelOverrides }));
  vi.doMock('../../src/services/oauth-store', () => ({
    assertOAuthEncryptionConfigured: vi.fn(),
    encryptPlaintextOAuthTokens,
    migrateOwnerTokens: vi.fn(),
  }));
  vi.doMock('../../src/services/persisted-model-overrides', () => ({
    loadPersistedModelOverrides: vi.fn((loader: () => void) => loader()),
  }));
  vi.doMock('../../src/services/release-data-maintenance', () => ({
    recordReleaseDataMaintenanceCompletion: vi.fn(),
  }));
  vi.doMock('../../src/services/user-service', () => ({
    assertOwnerBootstrapReadyForRuntime: vi.fn(),
    backfillTelegramIdentityArchive,
    seedOwnerUser: vi.fn(),
  }));

  const bootstrap = await import('../../src/services/database-bootstrap');
  return {
    bootstrap,
    immediate,
    loadModelOverrides,
    loadPersistedSettings,
    logger,
    releaseDatabase,
    runtimeDatabase,
    setConfigProvider,
  };
}

afterAll(() => {
  for (const modulePath of mockedModules) vi.doUnmock(modulePath);
  vi.resetModules();
});

describe('database bootstrap orchestration', () => {
  it('logs every positive release-maintenance result', async () => {
    const { bootstrap, immediate, logger, releaseDatabase } = await loadBootstrap({
      archivedRows: 1,
      encryptedOAuthRows: 1,
      encryptedTaxEvents: 1,
      encryptedUserTokens: 1,
    });

    bootstrap.runReleaseDataMaintenanceForMigrator(releaseDatabase as never, identity);

    expect(immediate).toHaveBeenCalledOnce();
    expect(logger.info).toHaveBeenCalledWith(
      { archivedRows: 1 },
      'Telegram identity archive backfill copied rows',
    );
    expect(logger.warn).toHaveBeenCalledWith(
      { encryptedRows: 1 },
      'OAuth migration: encrypted 1 legacy plaintext rows in-place',
    );
    expect(logger.warn).toHaveBeenCalledWith(
      { encryptedTransactions: 0, encryptedTaxEvents: 1 },
      'Finance migration: encrypted legacy plaintext finance rows in-place',
    );
    expect(logger.warn).toHaveBeenCalledWith(
      { encryptedSessions: 0, encryptedUserTokens: 1 },
      'Garmin migration: encrypted legacy plaintext token rows in-place',
    );
  });

  it.each([
    [
      'refresh-token backfill',
      { refreshTokenError: new Error('refresh-failed') },
      /refresh-failed/,
    ],
    ['identity archive', { archiveError: new Error('archive-failed') }, /archive-failed/],
    ['OAuth encryption', { oauthError: new Error('oauth-failed') }, /oauth-failed/],
    ['default skill seeding', { seedSkillsError: new Error('skills-failed') }, /skills-failed/],
  ] as const)('fails closed when release %s fails', async (_name, overrides, expected) => {
    const { bootstrap, releaseDatabase } = await loadBootstrap(overrides);

    expect(() => bootstrap.runReleaseDataMaintenanceForMigrator(
      releaseDatabase as never,
      identity,
    )).toThrow(expected);
  });

  it('keeps local boot best-effort while preserving its fail-closed prerequisites', async () => {
    const {
      bootstrap,
      loadModelOverrides,
      loadPersistedSettings,
      logger,
      runtimeDatabase,
      setConfigProvider,
    } = await loadBootstrap({
      refreshTokenError: new Error('refresh-failed'),
      archiveError: new Error('archive-failed'),
      oauthError: new Error('oauth-failed'),
      seedSkillsError: new Error('skills-failed'),
      settingsError: new Error('settings-failed'),
    });

    expect(bootstrap.initDatabase()).toBe(runtimeDatabase);
    expect(loadModelOverrides).toHaveBeenCalledWith({ ensureStore: true });
    expect(loadPersistedSettings).toHaveBeenCalledWith('default', { ensureStore: true });
    expect(setConfigProvider).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      { err: expect.objectContaining({ message: 'refresh-failed' }) },
      'iOS auth refresh-token hash backfill failed — investigate before next deploy',
    );
    expect(logger.warn).toHaveBeenCalledWith(
      { err: expect.objectContaining({ message: 'archive-failed' }) },
      'Telegram identity archive backfill failed — investigate before next deploy',
    );
    expect(logger.error).toHaveBeenCalledWith(
      { err: expect.objectContaining({ message: 'oauth-failed' }) },
      'OAuth plaintext migration failed — investigate before next deploy',
    );
    expect(logger.error).toHaveBeenCalledWith(
      { err: expect.objectContaining({ message: 'skills-failed' }) },
      'Default skill data maintenance failed — investigate before next deploy',
    );
  });
});
