/**
 * User Skill Access Tests
 *
 * Tests per-user skill enable/disable, owner bypass, parent-child inheritance,
 * catalog, and state merging for portal display.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
  LOGGER_REDACTION_PATHS: [],
}));

vi.mock('../../src/config', () => ({
  config: { telegram: { allowedUserIds: [111111] }, app: { timezone: 'Europe/Lisbon' } },
}));

const entitlementMocks = vi.hoisted(() => ({ ownerIds: new Set<number>() }));
vi.mock('../../src/services/entitlement', () => ({
  getEffectiveEntitlement: (userId: number) => ({
    isOwner: entitlementMocks.ownerIds.has(userId),
  }),
}));

// Mock oauth-store for connection status
vi.mock('../../src/services/oauth-store', () => ({
  isConnected: () => false,
}));

function applyMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, filename TEXT UNIQUE, applied_at TEXT DEFAULT (datetime('now')))`);
  const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (!db.prepare('SELECT 1 FROM _migrations WHERE filename = ?').get(file)) {
      try {
        db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
        db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
      } catch { /* skip deps */ }
    }
  }
}

import {
  isSkillEnabledForUser, setSkillAccess, getUserSkillOverrides,
  getSkillCatalog, getUserSkillState, resetUserSkillOverrides, SKILL_CATALOG,
} from '../../src/services/user-skill-access';

const USER_A = 222222;  // Not owner
const OWNER = 111111;

describe('user-skill-access', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
    entitlementMocks.ownerIds.clear();
  });

  afterEach(() => {
    testDb?.close();
  });

  describe('isSkillEnabledForUser', () => {
    it('returns true by default (no override)', () => {
      expect(isSkillEnabledForUser(USER_A, 'secretary')).toBe(true);
      expect(isSkillEnabledForUser(USER_A, 'triathlon')).toBe(true);
    });

    it('returns false when override exists with enabled=0', () => {
      setSkillAccess(USER_A, 'finance', false);
      expect(isSkillEnabledForUser(USER_A, 'finance')).toBe(false);
    });

    it('returns true after re-enabling', () => {
      setSkillAccess(USER_A, 'finance', false);
      setSkillAccess(USER_A, 'finance', true);
      expect(isSkillEnabledForUser(USER_A, 'finance')).toBe(true);
    });

    it('always returns true for the canonical owner', () => {
      entitlementMocks.ownerIds.add(OWNER);
      setSkillAccess(OWNER, 'finance', false);
      expect(isSkillEnabledForUser(OWNER, 'finance')).toBe(true);
    });

    it('does not grant owner bypass from an unverified numeric identity', () => {
      setSkillAccess(OWNER, 'finance', false);
      expect(isSkillEnabledForUser(OWNER, 'finance')).toBe(false);
    });

    it('checks sub-skill independently', () => {
      setSkillAccess(USER_A, 'secretary', true, { subSkill: 'email' });
      expect(isSkillEnabledForUser(USER_A, 'secretary', 'email')).toBe(true);

      setSkillAccess(USER_A, 'secretary', false, { subSkill: 'email' });
      expect(isSkillEnabledForUser(USER_A, 'secretary', 'email')).toBe(false);
    });

    it('disabling parent skill makes sub-skills return disabled', () => {
      setSkillAccess(USER_A, 'secretary', false);
      expect(isSkillEnabledForUser(USER_A, 'secretary', 'calendar')).toBe(false);
      expect(isSkillEnabledForUser(USER_A, 'secretary', 'email')).toBe(false);
    });
  });

  describe('setSkillAccess', () => {
    it('creates override in DB', () => {
      setSkillAccess(USER_A, 'finance', false, { reason: 'testing' });
      const overrides = getUserSkillOverrides(USER_A);
      expect(overrides).toHaveLength(1);
      expect(overrides[0].skill).toBe('finance');
      expect(overrides[0].enabled).toBe(false);
      expect(overrides[0].reason).toBe('testing');
    });

    it('updates existing override', () => {
      setSkillAccess(USER_A, 'finance', false);
      setSkillAccess(USER_A, 'finance', true);
      const overrides = getUserSkillOverrides(USER_A);
      expect(overrides).toHaveLength(1);
      expect(overrides[0].enabled).toBe(true);
    });
  });

  describe('getUserSkillOverrides', () => {
    it('returns empty for user with no overrides', () => {
      expect(getUserSkillOverrides(USER_A)).toEqual([]);
    });

    it('returns all overrides for a user', () => {
      setSkillAccess(USER_A, 'finance', false);
      setSkillAccess(USER_A, 'cooking', false);
      expect(getUserSkillOverrides(USER_A)).toHaveLength(2);
    });
  });

  describe('getSkillCatalog', () => {
    it('returns all skills', () => {
      const catalog = getSkillCatalog();
      expect(catalog.length).toBe(5);
      expect(catalog.map(s => s.skill)).toEqual(['secretary', 'triathlon', 'content', 'cooking', 'finance']);
    });
  });

  describe('getUserSkillState', () => {
    it('returns all skills with default state', () => {
      const state = getUserSkillState(USER_A);
      expect(state).toHaveLength(5);
      for (const s of state) {
        expect(s.enabled).toBe(true);
        expect(s.source).toBe('default');
      }
    });

    it('marks overridden skills correctly', () => {
      setSkillAccess(USER_A, 'finance', false);
      const state = getUserSkillState(USER_A);
      const finance = state.find(s => s.skill === 'finance')!;
      expect(finance.enabled).toBe(false);
      expect(finance.source).toBe('override');
    });

    it('includes sub-skills with correct state', () => {
      setSkillAccess(USER_A, 'secretary', false, { subSkill: 'email' });
      const state = getUserSkillState(USER_A);
      const secretary = state.find(s => s.skill === 'secretary')!;
      const email = secretary.subSkills.find(ss => ss.id === 'email')!;
      expect(email.enabled).toBe(false);
      expect(email.source).toBe('override');
    });

    it('parent disabled → all sub-skills disabled', () => {
      setSkillAccess(USER_A, 'secretary', false);
      const state = getUserSkillState(USER_A);
      const secretary = state.find(s => s.skill === 'secretary')!;
      for (const sub of secretary.subSkills) {
        expect(sub.enabled).toBe(false);
      }
    });
  });

  describe('resetUserSkillOverrides', () => {
    it('clears all overrides', () => {
      setSkillAccess(USER_A, 'finance', false);
      setSkillAccess(USER_A, 'cooking', false);
      resetUserSkillOverrides(USER_A);
      expect(getUserSkillOverrides(USER_A)).toEqual([]);
    });
  });

  describe('SKILL_CATALOG', () => {
    it('has labels and descriptions', () => {
      for (const s of SKILL_CATALOG) {
        expect(s.label).toBeTruthy();
        expect(s.description).toBeTruthy();
      }
    });

    it('secretary has 5 sub-skills', () => {
      const sec = SKILL_CATALOG.find(s => s.skill === 'secretary')!;
      expect(sec.subSkills).toHaveLength(5);
    });
  });
});
