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
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
  LOGGER_REDACTION_PATHS: [],
}));

vi.mock('../../src/config', () => ({
  config: {
    google: { clientId: 'google-web-client', iosClientId: 'google-ios-client', clientSecret: 'secret' },
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
        // Only auth/user tables are required here.
      }
    }
  }
}

function googlePayload(overrides: Record<string, unknown> = {}) {
  return {
    iss: 'https://accounts.google.com',
    aud: 'google-ios-client',
    sub: 'google-sub-1',
    email: 'verified@example.com',
    emailVerified: true,
    name: 'Verified User',
    picture: 'https://example.com/avatar.png',
    ...overrides,
  };
}

function seedEmailUser(email: string, verified: boolean): number {
  return Number(testDb.prepare(`
    INSERT INTO users (email, password_hash, first_name, email_verified, auth_provider, daily_cost_limit_usd)
    VALUES (?, ?, ?, ?, 'email', 0.05)
  `).run(email, 'bcrypt-hash', 'Existing', verified ? 1 : 0).lastInsertRowid);
}

describe('google-sign-in identity resolution', () => {
  beforeEach(async () => {
    testDb = new Database(':memory:');
    applyMigrations(testDb);
    vi.resetModules();
  });

  afterEach(() => {
    testDb?.close();
    vi.resetModules();
  });

  it('rejects Google sign-in when Google email_verified is false', async () => {
    const { resolveGoogleIdentityUser, GoogleEmailNotVerifiedError } = await import('../../src/services/google-sign-in');

    expect(() => resolveGoogleIdentityUser(googlePayload({ emailVerified: false }))).toThrow(GoogleEmailNotVerifiedError);
    const users = testDb.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number };
    expect(users.count).toBe(0);
  });

  it('does not link Google to an existing unverified email/password account', async () => {
    const userId = seedEmailUser('verified@example.com', false);
    const { resolveGoogleIdentityUser, GoogleAccountLinkRequiresVerificationError } = await import('../../src/services/google-sign-in');

    expect(() => resolveGoogleIdentityUser(googlePayload())).toThrow(GoogleAccountLinkRequiresVerificationError);
    const row = testDb.prepare('SELECT google_user_id FROM users WHERE id = ?').get(userId) as { google_user_id: string | null };
    expect(row.google_user_id).toBeNull();
  });

  it('links Google only when the existing email/password account is verified', async () => {
    const userId = seedEmailUser('verified@example.com', true);
    const { resolveGoogleIdentityUser } = await import('../../src/services/google-sign-in');

    const user = resolveGoogleIdentityUser(googlePayload({ sub: 'google-sub-verified' }));

    expect(user.id).toBe(userId);
    const row = testDb.prepare('SELECT google_user_id FROM users WHERE id = ?').get(userId) as { google_user_id: string | null };
    expect(row.google_user_id).toBe('google-sub-verified');
  });
});
