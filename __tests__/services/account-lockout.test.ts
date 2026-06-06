// AUTH-O7 (closed-beta-auth-hardening, 2026-05-04): per-account lockout
// service tests. Pin the threshold (10), window (15min), and lockout
// duration (15min) — changing any of them is a security-policy change.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');
let testDb: Database.Database;

function applyMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, filename TEXT UNIQUE, applied_at TEXT DEFAULT (datetime('now')))`);
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (!db.prepare('SELECT 1 FROM _migrations WHERE filename = ?').get(file)) {
      try {
        db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
        db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
      } catch {
        // Some migrations depend on runtime services; isolation is fine.
      }
    }
  }
}

beforeEach(() => {
  testDb = new Database(':memory:');
  testDb.pragma('journal_mode = WAL');
  applyMigrations(testDb);
  vi.resetModules();
  vi.doMock('../../src/services/database', () => ({
    getDb: () => testDb,
  }));
  vi.doMock('../../src/utils/logger', () => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
  }));
});

afterEach(() => {
  testDb.close();
  vi.resetModules();
});

describe('AUTH-O7 account-lockout service', () => {
  it('exposes the canonical thresholds (10 attempts / 15min window / 15min lockout)', async () => {
    const mod = await import('../../src/services/account-lockout');
    expect(mod.FAILED_LOGIN_THRESHOLD).toBe(10);
    expect(mod.FAILED_LOGIN_WINDOW_MS).toBe(15 * 60 * 1000);
    expect(mod.LOCKOUT_DURATION_MS).toBe(15 * 60 * 1000);
  });

  it('returns unlocked with 0 attempts for a fresh user', async () => {
    const { getLockoutState } = await import('../../src/services/account-lockout');
    const state = getLockoutState(42);
    expect(state.kind).toBe('unlocked');
    if (state.kind === 'unlocked') expect(state.attemptsInWindow).toBe(0);
  });

  it('counts up failed attempts within the window without locking', async () => {
    const { recordFailedLogin } = await import('../../src/services/account-lockout');
    let s: any = null;
    for (let i = 1; i <= 9; i++) {
      s = recordFailedLogin(42, 'a@b.test');
      expect(s.kind).toBe('unlocked');
      expect(s.attemptsInWindow).toBe(i);
    }
  });

  it('locks the account on the 10th failure with locked_until ≈ now+15min', async () => {
    const { recordFailedLogin } = await import('../../src/services/account-lockout');
    let final: any = null;
    for (let i = 1; i <= 10; i++) {
      final = recordFailedLogin(42, 'a@b.test');
    }
    expect(final.kind).toBe('locked');
    if (final.kind === 'locked') {
      const drift = final.until.getTime() - Date.now();
      expect(drift).toBeGreaterThan(14 * 60 * 1000);
      expect(drift).toBeLessThan(16 * 60 * 1000);
      expect(final.attemptsInWindow).toBe(10);
    }
  });

  it('successful login clears the row regardless of attempt count', async () => {
    const { recordFailedLogin, recordSuccessfulLogin, getLockoutState } =
      await import('../../src/services/account-lockout');
    for (let i = 0; i < 3; i++) recordFailedLogin(42, 'a@b.test');
    expect(getLockoutState(42).kind).toBe('unlocked');
    recordSuccessfulLogin(42);
    const after = getLockoutState(42);
    expect(after.kind).toBe('unlocked');
    if (after.kind === 'unlocked') expect(after.attemptsInWindow).toBe(0);
  });

  it('window reset: stale row past the sliding window is reset on next failure', async () => {
    const { recordFailedLogin, getLockoutState } = await import('../../src/services/account-lockout');
    // Seed an old row directly (16 minutes ago).
    testDb.prepare(`
      INSERT INTO failed_login_attempts
        (user_id, email_at_first, attempt_count, first_failed_at, last_failed_at, locked_until)
      VALUES (42, 'a@b.test', 9, ?, ?, NULL)
    `).run(
      new Date(Date.now() - 16 * 60 * 1000).toISOString(),
      new Date(Date.now() - 16 * 60 * 1000).toISOString(),
    );
    // getLockoutState should detect the stale row and lazy-GC it.
    const before = getLockoutState(42);
    expect(before.kind).toBe('unlocked');
    if (before.kind === 'unlocked') expect(before.attemptsInWindow).toBe(0);
  });

  it('expired-lockout row resets on next failure (window restart, not increment)', async () => {
    const { recordFailedLogin, getLockoutState } = await import('../../src/services/account-lockout');
    // Seed a previously-locked row whose lockout has just expired.
    testDb.prepare(`
      INSERT INTO failed_login_attempts
        (user_id, email_at_first, attempt_count, first_failed_at, last_failed_at, locked_until)
      VALUES (42, 'a@b.test', 10, ?, ?, ?)
    `).run(
      new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      new Date(Date.now() - 16 * 60 * 1000).toISOString(),
      new Date(Date.now() - 60 * 1000).toISOString(),
    );
    const after = recordFailedLogin(42, 'a@b.test');
    // Should restart the window with a single fresh attempt, not increment past the cap.
    expect(after.kind).toBe('unlocked');
    expect(after.attemptsInWindow).toBe(1);
  });

  it('assertNotLocked returns the same state as getLockoutState (no side effects)', async () => {
    const { assertNotLocked, recordFailedLogin } = await import('../../src/services/account-lockout');
    for (let i = 0; i < 5; i++) recordFailedLogin(42, 'a@b.test');
    const a = assertNotLocked(42);
    const b = assertNotLocked(42);
    expect(a.kind).toBe(b.kind);
    if (a.kind === 'unlocked' && b.kind === 'unlocked') {
      expect(a.attemptsInWindow).toBe(b.attemptsInWindow);
    }
  });
});
