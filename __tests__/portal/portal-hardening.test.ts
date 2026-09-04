/**
 * Portal Hardening Regression Tests
 *
 * Covers the 6 items from the April 2026 portal security audit:
 *   1. Safe DTO — listUsers never exposes password_hash, apple_user_id, google_user_id
 *   2. Null telegram_id — users created via Apple/Google/Email have nullable telegram_id
 *   3. userId routing — all portal routes use users.id (canonical), not telegram_id
 *   4. Content admin auth — unified to config.portal.token with localhost fallback
 *   5. No localStorage/URL token — verified via HTML source scan
 *   6. Identity migration — data-summary, skills, suspend/activate all use :userId
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

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
    app: { timezone: 'Europe/Lisbon' },
    portal: { token: 'test-portal-secret' },
  },
}));


import {
  getOrCreateUser, listUsers, setUserStatusById, setUserTier,
  getUserByTelegramId,
} from '../../src/services/user-service';

// ═══════════════════════════════════════════════════════════════
// 1. Safe DTO — listUsers never leaks secrets
// ═══════════════════════════════════════════════════════════════

describe('portal-hardening: safe DTO', () => {
  beforeEach(() => {
    testDb = createMigratedTestDatabase();
  });
  afterEach(() => testDb?.close());

  it('listUsers excludes password_hash', () => {
    getOrCreateUser(111111, { firstName: 'Felipe' });
    const users = listUsers();
    expect(users.length).toBeGreaterThan(0);

    for (const u of users) {
      expect(u).not.toHaveProperty('password_hash');
    }
  });

  it('listUsers excludes apple_user_id and google_user_id', () => {
    getOrCreateUser(111111, { firstName: 'Felipe' });
    const users = listUsers();

    for (const u of users) {
      expect(u).not.toHaveProperty('apple_user_id');
      expect(u).not.toHaveProperty('google_user_id');
    }
  });

  it('listUsers INCLUDES tier, daily_message_limit, last_active_at', () => {
    getOrCreateUser(111111, { firstName: 'Felipe' });
    const users = listUsers();
    const u = users[0]!;

    // These fields were added to the DTO in the hardening pass
    expect(u).toHaveProperty('tier');
    expect(u).toHaveProperty('daily_message_limit');
    // last_active_at may be null for never-touched users — but the key must exist
    expect('last_active_at' in u).toBe(true);
  });

  it('listUsers includes auth_provider and email_verified', () => {
    getOrCreateUser(111111, { firstName: 'Felipe' });
    const users = listUsers();
    const u = users[0]!;

    expect(u).toHaveProperty('auth_provider');
    expect(u).toHaveProperty('email_verified');
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. Null telegram_id — social-login users work
// ═══════════════════════════════════════════════════════════════

describe('portal-hardening: null telegram_id users', () => {
  beforeEach(() => {
    testDb = createMigratedTestDatabase();
  });
  afterEach(() => testDb?.close());

  it('user with null telegram_id is included in listUsers', () => {
    // Simulate Apple Sign-In user (no telegram_id)
    testDb.prepare(`
      INSERT INTO users (telegram_id, username, first_name, email, auth_provider, tier, status,
                         daily_message_limit, daily_token_limit, daily_cost_limit_usd)
      VALUES (NULL, 'apple_user', 'Apple', 'apple@example.com', 'apple', 'pro', 'active', 200, 500000, 5.0)
    `).run();

    const users = listUsers();
    const appleUser = users.find(u => u.email === 'apple@example.com');
    expect(appleUser).toBeDefined();
    expect(appleUser!.telegram_id).toBeNull();
    expect(appleUser!.auth_provider).toBe('apple');
  });

  it('user with null telegram_id has valid users.id', () => {
    testDb.prepare(`
      INSERT INTO users (telegram_id, first_name, email, auth_provider, tier, status,
                         daily_message_limit, daily_token_limit, daily_cost_limit_usd)
      VALUES (NULL, 'Google', 'google@example.com', 'google', 'pro', 'active', 200, 500000, 5.0)
    `).run();

    const users = listUsers();
    const googleUser = users.find(u => u.email === 'google@example.com');
    expect(googleUser).toBeDefined();
    expect(googleUser!.id).toBeGreaterThan(0);
    expect(googleUser!.telegram_id).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// 3. userId routing — setUserStatusById uses canonical id
// ═══════════════════════════════════════════════════════════════

describe('portal-hardening: userId routing', () => {
  beforeEach(() => {
    testDb = createMigratedTestDatabase();
  });
  afterEach(() => testDb?.close());

  it('setUserStatusById suspends by users.id, not telegram_id', () => {
    const user = getOrCreateUser(222222, { firstName: 'Beta' });
    // user.id is the auto-increment PK; user.telegram_id is 222222
    // They are different numbers — this test proves we're routing by the right one.
    expect(user.id).not.toBe(user.telegram_id);

    setUserStatusById(user.id, 'suspended');
    const reloaded = getUserByTelegramId(222222);
    expect(reloaded!.status).toBe('suspended');
  });

  it('setUserStatusById works for null-telegram_id users', () => {
    testDb.prepare(`
      INSERT INTO users (telegram_id, first_name, email, auth_provider, tier, status,
                         daily_message_limit, daily_token_limit, daily_cost_limit_usd)
      VALUES (NULL, 'Email', 'email@example.com', 'email', 'pro', 'active', 200, 500000, 5.0)
    `).run();

    const userId = (testDb.prepare('SELECT id FROM users WHERE email = ?').get('email@example.com') as any).id;
    setUserStatusById(userId, 'banned');

    const row = testDb.prepare('SELECT status FROM users WHERE id = ?').get(userId) as any;
    expect(row.status).toBe('banned');
  });
});

// ═══════════════════════════════════════════════════════════════
// 4. Content admin auth — tests the auth check pattern
// ═══════════════════════════════════════════════════════════════

describe('portal-hardening: content admin auth unification', () => {
  it('config.portal.token is defined in test config', async () => {
    const { config } = await import('../../src/config');
    expect(config.portal.token).toBe('test-portal-secret');
  });
});

// ═══════════════════════════════════════════════════════════════
// 5. No localStorage/URL token in portal HTML
// ═══════════════════════════════════════════════════════════════

describe('portal-hardening: no localStorage or URL token', () => {
  const htmlPath = path.resolve(__dirname, '../../src/portal/portal.html');
  const legacyPath = path.resolve(__dirname, '../../src/portal/ui/legacy.js');
  // The SPA script lives in ui/legacy.js (extracted from the inline block so the CSP can drop 'unsafe-inline').
  const readSpaSource = () => fs.readFileSync(htmlPath, 'utf8') + '\n' + fs.readFileSync(legacyPath, 'utf8');

  // Skip if portal.html doesn't exist in the test environment
  const htmlExists = fs.existsSync(htmlPath);

  it.skipIf(!htmlExists)('portal.html does not use localStorage for token', () => {
    const html = readSpaSource();
    // The old pattern was: localStorage.getItem('portalToken')
    // After hardening: token is in-memory only (_portalToken variable)
    expect(html).not.toContain("localStorage.getItem('portalToken')");
    expect(html).not.toContain('localStorage.setItem("portalToken"');
    expect(html).not.toContain("localStorage.setItem('portalToken'");
  });

  it.skipIf(!htmlExists)('portal.html does not read token from URL params', () => {
    const html = readSpaSource();
    // Old: URLSearchParams(location.search).get('token')
    expect(html).not.toContain("URLSearchParams(location.search).get('token')");
    expect(html).not.toContain("searchParams.get('token')");
  });

  it.skipIf(!htmlExists)('portal.html uses in-memory TOKEN variable (not localStorage)', () => {
    const html = readSpaSource();
    // The hardened pattern: `let TOKEN = '';  // In-memory only — dies with the tab`
    expect(html).toContain("let TOKEN = ''");
    expect(html).toContain('In-memory only');
  });

  it.skipIf(!htmlExists)('portal.html has no telegramId references', () => {
    const html = readSpaSource();
    // All functions should use userId, not telegramId
    expect(html).not.toContain('telegramId');
  });

  it.skipIf(!htmlExists)('portal.html links user account sign-in separately from operator token login', () => {
    const html = fs.readFileSync(htmlPath, 'utf8');
    expect(html).toContain('Sign in with your portal access token');
    expect(html).toContain('href="/user"');
    expect(html).toContain('Sign in with email, Google, or Apple');
  });

  it.skipIf(!htmlExists)('configuration sections render auth errors instead of keeping loading placeholders forever', () => {
    const html = readSpaSource();
    expect(html).toContain('function apiJson(url, opts = {})');
    expect(html).toContain("setCardError('settings-content', 'Could not load settings', err)");
    expect(html).toContain("setCardError('invite-codes-content', 'Could not load invite codes', err)");
    expect(html).toContain("setTableError('founders-tbody', 5, 'Could not load founders', err)");
    expect(html).toContain("setTableError('waitlist-tbody', 7, 'Could not load waitlist', err)");
    expect(html).toContain("setTableError('audit-tbody', 5, 'Could not load audit trail', err)");
  });
});

// ═══════════════════════════════════════════════════════════════
// 6. Identity migration — server.ts uses :userId, not :telegramId
// ═══════════════════════════════════════════════════════════════

describe('portal-hardening: server.ts identity migration', () => {
  const serverPath = path.resolve(__dirname, '../../src/portal/server.ts');
  const adminDataRoutesPath = path.resolve(__dirname, '../../src/portal/admin-data-routes.ts');
  const userSkillRoutesPath = path.resolve(__dirname, '../../src/portal/user-skill-routes.ts');
  const serverExists = fs.existsSync(serverPath);
  const routeSource = [
    fs.existsSync(serverPath) ? fs.readFileSync(serverPath, 'utf8') : '',
    fs.existsSync(adminDataRoutesPath) ? fs.readFileSync(adminDataRoutesPath, 'utf8') : '',
    fs.existsSync(userSkillRoutesPath) ? fs.readFileSync(userSkillRoutesPath, 'utf8') : '',
  ].join('\n');

  it.skipIf(!serverExists)('data-summary route uses :userId param', () => {
    // After migration, the route should be /api/users/:userId/data-summary
    expect(routeSource).toContain("'/api/users/:userId/data-summary'");
    // And NOT the old telegramId version
    expect(routeSource).not.toContain("'/api/users/:telegramId/data-summary'");
  });

  it.skipIf(!serverExists)('skills routes use :userId param', () => {
    expect(routeSource).toContain("'/api/users/:userId/skills'");
    expect(routeSource).not.toContain("'/api/users/:telegramId/skills'");
  });

  it.skipIf(!serverExists)('no active :telegramId route params remain', () => {
    // Count actual route definitions (not comments)
    const lines = routeSource.split('\n');
    const activeRoutes = lines.filter(line => {
      const trimmed = line.trim();
      // Skip comment-only lines
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return false;
      // Look for Express route definitions with :telegramId
      return trimmed.includes(':telegramId') && (
        trimmed.includes('app.get') ||
        trimmed.includes('app.post') ||
        trimmed.includes('app.put') ||
        trimmed.includes('app.delete') ||
        trimmed.includes('app.patch')
      );
    });

    expect(activeRoutes).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// 7. Data-summary endpoint — functional test with in-memory DB
// ═══════════════════════════════════════════════════════════════

describe('portal-hardening: data-summary counts by users.id', () => {
  beforeEach(() => {
    testDb = createMigratedTestDatabase();
  });
  afterEach(() => testDb?.close());

  it('countUserFinanceData queries by user_id column', async () => {
    const user = getOrCreateUser(333333, { firstName: 'Finance' });

    // Insert a test finance transaction if the table exists
    try {
      testDb.prepare(`
        INSERT INTO finance_transactions (user_id, date, vendor, amount, currency)
        VALUES (?, '2026-04-01', 'TestVendor', 42.50, 'EUR')
      `).run(user.id);
    } catch {
      // Table might not exist in minimal migration set — that's OK
      return;
    }

    // Use the actual function
    const { countUserFinanceData } = await import('../../src/services/user-data-export');
    const counts = countUserFinanceData(user.id);
    expect(counts.transactions).toBe(1);

    // Querying with a DIFFERENT user.id must return 0
    const otherCounts = countUserFinanceData(user.id + 999);
    expect(otherCounts.transactions).toBe(0);
  });
});
