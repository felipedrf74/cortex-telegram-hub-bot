import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

let testDb: Database.Database;

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
  withDatabaseForTestAsync: vi.fn(),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
  LOGGER_REDACTION_PATHS: [],
}));

vi.mock('../../src/config', () => ({
  config: {
    telegram: { allowedUserIds: [111111] },
    google: { clientId: 'gid', clientSecret: 'gsec', refreshToken: null },
    outlook: { clientId: 'oid', clientSecret: null, tenantId: 'common', refreshToken: null },
    financeEncryption: { masterKey: '' },
    app: { timezone: 'Europe/Lisbon' },
  },
}));

function applyMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, filename TEXT UNIQUE, applied_at TEXT DEFAULT (datetime('now')))`);
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith('.sql')).sort();
  for (const file of files) {
    if (!db.prepare('SELECT 1 FROM _migrations WHERE filename = ?').get(file)) {
      try {
        db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
        db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
      } catch {
        // Some migrations depend on optional tables; not needed here.
      }
    }
  }
}

import { storeTokens, _resetDecryptCacheForTests } from '../../src/services/oauth-store';
import { getOwnerGoogleRefreshToken } from '../../src/services/google-auth';
import { isMicrosoftConfigured } from '../../src/services/microsoft-auth';

describe('owner integration bootstrap token resolution', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
    vi.unstubAllEnvs();
    vi.stubEnv('OWNER_TELEGRAM_ID', '');
    process.env.OAUTH_ENCRYPTION_KEY = 'test-key-deterministic-for-vitest-32chars';
    _resetDecryptCacheForTests();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    testDb?.close();
  });

  it('prefers the canonical owner users.id when reading Google owner tokens', () => {
    testDb.prepare(`
      INSERT INTO users (telegram_id, first_name, tier, status, daily_message_limit, daily_token_limit, daily_cost_limit_usd)
      VALUES (111111, 'Owner', 'owner', 'active', 0, 0, 0)
    `).run();
    const owner = testDb.prepare('SELECT id FROM users WHERE telegram_id = 111111').get() as { id: number };

    storeTokens(owner.id, 'google', {
      accessToken: '',
      refreshToken: 'canonical-google-token',
      tokenType: 'Bearer',
      expiresAt: null,
      scopes: [],
    });

    expect(getOwnerGoogleRefreshToken()).toBe('canonical-google-token');
  });

  it('falls back to legacy telegram-keyed Google owner tokens when canonical rows are absent', () => {
    testDb.prepare(`
      INSERT INTO users (telegram_id, first_name, tier, status, daily_message_limit, daily_token_limit, daily_cost_limit_usd)
      VALUES (111111, 'Owner', 'owner', 'active', 0, 0, 0)
    `).run();

    storeTokens(111111, 'google', {
      accessToken: '',
      refreshToken: 'legacy-google-token',
      tokenType: 'Bearer',
      expiresAt: null,
      scopes: [],
    });

    expect(getOwnerGoogleRefreshToken()).toBe('legacy-google-token');
  });

  it('treats legacy telegram-keyed Outlook owner tokens as configured when canonical rows are absent', () => {
    testDb.prepare(`
      INSERT INTO users (telegram_id, first_name, tier, status, daily_message_limit, daily_token_limit, daily_cost_limit_usd)
      VALUES (111111, 'Owner', 'owner', 'active', 0, 0, 0)
    `).run();

    storeTokens(111111, 'outlook', {
      accessToken: '',
      refreshToken: 'legacy-outlook-token',
      tokenType: 'Bearer',
      expiresAt: null,
      scopes: [],
    });

    expect(isMicrosoftConfigured()).toBe(true);
  });
});
