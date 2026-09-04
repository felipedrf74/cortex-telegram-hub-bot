import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  db: null as null | InstanceType<typeof import('better-sqlite3')>,
  sentryEnabled: false,
}));

vi.mock('../../src/config', () => ({
  config: {
    app: { databasePath: ':memory:' },
    portal: {
      adminToken: 'admin-token-strong-value',
      token: '',
      allowLegacyFallback: false,
      allowLocalBypass: false,
      sessionSecret: '',
      requireSessionAuth: false,
      adminActorAllowlist: [],
      adminRequireActor: false,
      adminActorSignatureSecret: '',
      betaHardened: false,
    },
    ios: { enabled: true },
    ollama: { enabled: false },
  },
}));

vi.mock('../../src/services/database', () => ({
  getDb: () => {
    if (!hoisted.db) throw new Error('db not ready');
    return hoisted.db;
  },
  applyMigrationFileForTest: vi.fn(),
  closeDatabase: vi.fn(),
  filterAlreadyAppliedAddColumnStatements: vi.fn(),
  initializeDatabaseCore: vi.fn(),
  runMigrationsForTest: vi.fn(),
  withDatabaseForTest: vi.fn(),
  withDatabaseForTestAsync: vi.fn(),
  withReleaseMaintenanceDatabase: vi.fn(),
}));

vi.mock('../../src/services/error-tracker', () => ({
  isEnabled: () => hoisted.sentryEnabled,
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  flush: vi.fn(),
  getStatus: vi.fn(),
  init: vi.fn(),
  sanitizeSentryEvent: vi.fn(),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
  LOGGER_REDACTION_PATHS: [],
}));

import { getMigrationStatus, getReleaseInfo, readReleaseStamp } from '../../src/services/release-info';

let tmp = '';

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'release-info-'));
  hoisted.db = new Database(':memory:');
  hoisted.db.exec('CREATE TABLE _migrations (id INTEGER PRIMARY KEY, filename TEXT NOT NULL UNIQUE, applied_at TEXT)');
  hoisted.db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run('001_a.sql');
  hoisted.db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run('002_b.sql');
  fs.mkdirSync(path.join(tmp, 'migrations'));
  for (const file of ['001_a.sql', '002_b.sql', '003_c.sql']) {
    fs.writeFileSync(path.join(tmp, 'migrations', file), '-- sql');
  }
  hoisted.sentryEnabled = false;
});

afterEach(() => {
  hoisted.db?.close();
  hoisted.db = null;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('release info', () => {
  it('diffs migrations on disk against the applied ledger', () => {
    const status = getMigrationStatus(path.join(tmp, 'migrations'));

    expect(status).toEqual({
      applied: 2,
      available: 3,
      latestApplied: '002_b.sql',
      pending: ['003_c.sql'],
      unknownApplied: [],
    });
  });

  it('reports the build stamp, deploy time, exposure mode and integration booleans', () => {
    const stampPath = path.join(tmp, 'release-stamp.json');
    fs.writeFileSync(stampPath, JSON.stringify({
      stampVersion: 1,
      version: '4.14.300',
      gitSha: 'abcdef0123456789abcdef0123456789abcdef01',
      gitShortSha: 'abcdef01',
      branch: 'main',
      commitTime: '2026-09-01T10:00:00+01:00',
      dirty: false,
      migrationCount: 3,
    }));
    hoisted.sentryEnabled = true;
    const startedAt = Date.parse('2026-09-03T08:00:00Z');

    const info = getReleaseInfo({
      startedAt,
      stampPath,
      migrationsDir: path.join(tmp, 'migrations'),
      env: { NODE_ENV: 'staging', OPERATOR_ALERT_WEBHOOK_URL: 'https://hooks.example/x', ANTHROPIC_ENABLED: 'false' },
      now: startedAt + 90_000,
    });

    expect(info.version).toBe('4.14.300');
    expect(info.gitShortSha).toBe('abcdef01');
    expect(info.stampPresent).toBe(true);
    expect(info.deployedAt).toBe(fs.statSync(stampPath).mtime.toISOString());
    expect(info.bootedAt).toBe('2026-09-03T08:00:00.000Z');
    expect(info.uptimeSeconds).toBe(90);
    expect(info.env).toBe('staging');
    expect(info.migrations.pending).toEqual(['003_c.sql']);
    expect(info.adminExposureMode).toBe('static_open');
    expect(info.betaHardened).toBe(false);
    expect(info.integrations).toEqual({
      sentry: true,
      operatorAlertWebhook: true,
      iosApi: true,
      anthropic: false,
      ollama: false,
    });
    expect(info.db.sizeBytes).toBeGreaterThan(0);
    expect(JSON.stringify(info)).not.toContain('hooks.example');
  });

  it('falls back to package.json version when the stamp is missing', () => {
    const info = getReleaseInfo({
      startedAt: Date.now(),
      stampPath: path.join(tmp, 'missing-stamp.json'),
      migrationsDir: path.join(tmp, 'migrations'),
      env: {},
    });

    expect(info.stampPresent).toBe(false);
    expect(info.gitSha).toBeNull();
    expect(info.deployedAt).toBeNull();
    expect(info.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(info.integrations.operatorAlertWebhook).toBe(false);
  });

  it('treats an unreadable stamp as absent', () => {
    const stampPath = path.join(tmp, 'broken.json');
    fs.writeFileSync(stampPath, '{not json');

    expect(readReleaseStamp(stampPath)).toBeNull();
  });
});
