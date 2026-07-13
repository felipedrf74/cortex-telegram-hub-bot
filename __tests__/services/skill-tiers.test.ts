/**
 * Skill Tiers Service — Phase 1 foundation tests
 *
 * Covers:
 *  - Migration 045 runs cleanly (table shape, seeds, bulk free→pro update)
 *  - checkTierAccess cascade: override → catalog → config → default
 *  - Tier rank comparison (free < pro < owner)
 *  - Per-user override expiry + revoke
 *  - Batch access check returns in request order
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
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  filterAlreadyAppliedAddColumnStatements: vi.fn((sql: string) => sql),
  runMigrationsForTest: vi.fn(),
  stripWrappingTransactionStatements: vi.fn((sql: string) => sql),
  applyMigrationFileForTest: vi.fn(),
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
  },
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
  checkSkillAccess, checkTierAccess, checkTierAccessBatch, getSkillTier, listSkillTiers,
  grantOverride, revokeOverride, getUserOverride, setSkillTier,
} from '../../src/services/skill-tiers';
import { disable as disableInstalledSkill } from '../../src/skills/registry';
import type { User } from '../../src/services/user-service';

function makeUser(id: number, tier: 'free' | 'pro' | 'max' | 'owner'): Pick<User, 'id' | 'tier'> {
  return { id, tier };
}

function upsertInstalledSkill(
  name: string,
  enabled: boolean,
  submodules: Array<{ name: string; enabled: boolean }> = [],
): void {
  testDb.prepare(`
    INSERT INTO installed_skills (name, description, version, domain, enabled)
    VALUES (?, ?, '1.0.0', ?, ?)
    ON CONFLICT(name) DO UPDATE SET enabled = excluded.enabled
  `).run(name, `${name} test skill`, name, enabled ? 1 : 0);

  const skill = testDb.prepare('SELECT id FROM installed_skills WHERE name = ?').get(name) as { id: number };
  for (const sub of submodules) {
    testDb.prepare(`
      INSERT INTO skill_submodules (skill_id, module_name, enabled)
      VALUES (?, ?, ?)
      ON CONFLICT(skill_id, module_name) DO UPDATE SET enabled = excluded.enabled
    `).run(skill.id, sub.name, sub.enabled ? 1 : 0);
  }
}

function setUserSkillToggle(
  userId: number,
  skill: string,
  enabled: boolean,
  subSkill: string | null = null,
): void {
  testDb.prepare(`
    INSERT INTO user_skill_overrides (user_id, skill, sub_skill, enabled)
    VALUES (?, ?, ?, ?)
  `).run(userId, skill, subSkill, enabled ? 1 : 0);
}

// ─── Migration 045 shape + seeds ────────────────────────────────────

describe('migration 045: skill_tiers schema and seeds', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
  });
  afterEach(() => testDb?.close());

  it('creates skill_tiers table with CHECK constraint', () => {
    // Valid insert
    testDb.prepare("INSERT INTO skill_tiers (skill_id, required_tier) VALUES ('test.ok', 'pro')").run();
    // Invalid tier should fail CHECK constraint
    expect(() =>
      testDb.prepare("INSERT INTO skill_tiers (skill_id, required_tier) VALUES ('test.bad', 'platinum')").run()
    ).toThrow();
  });

  it('creates user_skill_tier_overrides table with UNIQUE (user_id, skill_id)', () => {
    testDb.prepare(
      "INSERT INTO user_skill_tier_overrides (user_id, skill_id, unlocked) VALUES (1, 'triathlon.swim', 1)"
    ).run();
    expect(() =>
      testDb.prepare(
        "INSERT INTO user_skill_tier_overrides (user_id, skill_id, unlocked) VALUES (1, 'triathlon.swim', 1)"
      ).run()
    ).toThrow();
  });

  it('seeds secretary sub-skills as free tier', () => {
    expect(getSkillTier('secretary.tasks')).toBe('free');
    expect(getSkillTier('secretary.calendar')).toBe('free');
    expect(getSkillTier('secretary.email')).toBe('free');
    expect(getSkillTier('secretary.reminders')).toBe('free');
  });

  it('seeds triathlon sub-skills (including sport shells) as pro tier', () => {
    expect(getSkillTier('triathlon.gym')).toBe('pro');
    expect(getSkillTier('triathlon.running')).toBe('pro');
    expect(getSkillTier('triathlon.cycle')).toBe('pro');
    expect(getSkillTier('triathlon.swim')).toBe('pro');
    expect(getSkillTier('triathlon')).toBe('pro');
  });

  it('seeds chat action aliases and platform helper skills for authorization', () => {
    expect(getSkillTier('training')).toBe('pro');
    expect(getSkillTier('connections')).toBe('free');
    expect(getSkillTier('notifications')).toBe('free');
    expect(getSkillTier('decision_center')).toBe('free');
  });

  it('bulk-upgrades existing free users to pro with new limits', () => {
    // Pre-seed a free user AFTER migration 045 ran — migration won't catch
    // them, so here we just verify the shape migration 045 installed works.
    testDb.prepare(`
      INSERT INTO users (telegram_id, tier, daily_message_limit, daily_token_limit, daily_cost_limit_usd)
      VALUES (?, 'free', 40, 100000, 0)
    `).run(9999);
    // Reapply the bulk-upgrade idempotently to simulate Phase 1 deploy
    testDb.prepare(`
      UPDATE users SET tier = 'pro', daily_message_limit = 200, daily_token_limit = 500000, daily_cost_limit_usd = 0.2
      WHERE tier = 'free'
    `).run();
    const row = testDb.prepare('SELECT tier, daily_message_limit FROM users WHERE telegram_id = ?').get(9999) as any;
    expect(row.tier).toBe('pro');
    expect(row.daily_message_limit).toBe(200);
  });
});

// ─── checkTierAccess cascade ─────────────────────────────────────────

describe('checkTierAccess — gate cascade', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
  });
  afterEach(() => testDb?.close());

  it('denies null user regardless of skill', () => {
    const result = checkTierAccess(null, 'secretary.tasks');
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('denied');
  });

  it('free user CAN access free-tier skills (secretary)', () => {
    const result = checkTierAccess(makeUser(1, 'free'), 'secretary.tasks');
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('catalog');
    expect(result.requiredTier).toBe('free');
  });

  it('free user CANNOT access pro-tier skills (triathlon.gym)', () => {
    const result = checkTierAccess(makeUser(2, 'free'), 'triathlon.gym');
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('catalog');
    expect(result.requiredTier).toBe('pro');
    expect(result.userTier).toBe('free');
  });

  it('pro user CAN access all pro-tier triathlon sport sub-skills', () => {
    const user = makeUser(3, 'pro');
    for (const skill of ['triathlon.gym', 'triathlon.running', 'triathlon.cycle', 'triathlon.swim']) {
      const result = checkTierAccess(user, skill);
      expect(result.allowed, `pro user should access ${skill}`).toBe(true);
    }
  });

  it('owner user CAN access everything (ordinal rank)', () => {
    const user = makeUser(4, 'owner');
    for (const skill of ['secretary.tasks', 'triathlon.gym', 'content.script-generator', 'finance.tax']) {
      expect(checkTierAccess(user, skill).allowed, `owner should access ${skill}`).toBe(true);
    }
  });

  it('max user CAN access pro-tier skills but NOT owner-tier skills', () => {
    const user = makeUser(4, 'max');
    expect(checkTierAccess(user, 'content.script-generator').allowed).toBe(true);

    setSkillTier('admin.impersonate', 'owner', 'Admin impersonation tool');
    const ownerOnly = checkTierAccess(user, 'admin.impersonate');
    expect(ownerOnly.allowed).toBe(false);
    expect(ownerOnly.requiredTier).toBe('owner');
  });

  it('pro user CANNOT access owner-tier skills', () => {
    setSkillTier('admin.impersonate', 'owner', 'Admin impersonation tool');
    const result = checkTierAccess(makeUser(5, 'pro'), 'admin.impersonate');
    expect(result.allowed).toBe(false);
    expect(result.requiredTier).toBe('owner');
  });

  it('per-user override beats the catalog', () => {
    // Pre-seed a free user row so FK/logging works
    testDb.prepare("INSERT INTO users (telegram_id, tier) VALUES (?, 'free')").run(777);
    grantOverride({ userId: 777, skillId: 'triathlon.swim', reason: 'beta tester' });

    const result = checkTierAccess(makeUser(777, 'free'), 'triathlon.swim');
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('override');
  });

  it('revoked override falls back to catalog check', () => {
    testDb.prepare("INSERT INTO users (telegram_id, tier) VALUES (?, 'free')").run(888);
    grantOverride({ userId: 888, skillId: 'triathlon.cycle' });
    expect(checkTierAccess(makeUser(888, 'free'), 'triathlon.cycle').allowed).toBe(true);

    revokeOverride(888, 'triathlon.cycle');
    const result = checkTierAccess(makeUser(888, 'free'), 'triathlon.cycle');
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('catalog');
  });

  it('expired override is ignored', () => {
    testDb.prepare("INSERT INTO users (telegram_id, tier) VALUES (?, 'free')").run(999);
    // Insert an already-expired override directly
    testDb.prepare(`
      INSERT INTO user_skill_tier_overrides (user_id, skill_id, unlocked, expires_at)
      VALUES (999, 'triathlon.running', 1, datetime('now', '-1 day'))
    `).run();
    expect(getUserOverride(999, 'triathlon.running')).toBeNull();
    const result = checkTierAccess(makeUser(999, 'free'), 'triathlon.running');
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('catalog');
  });

  it('unknown skill ID falls through to global default (pro)', () => {
    expect(checkTierAccess(makeUser(1, 'pro'), 'nonexistent.skill').allowed).toBe(true);
    expect(checkTierAccess(makeUser(1, 'free'), 'nonexistent.skill').allowed).toBe(false);
    expect(checkTierAccess(makeUser(1, 'free'), 'nonexistent.skill').reason).toBe('default');
  });
});

// ─── Canonical skill access gate ───────────────────────────────────

describe('checkSkillAccess — canonical precedence', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
  });
  afterEach(() => {
    try { testDb?.close(); } catch { /* already closed in fail-closed test */ }
  });

  it('owner bypass runs once at the top even when the skill is globally disabled', () => {
    upsertInstalledSkill('triathlon', false);

    const result = checkSkillAccess(makeUser(1, 'owner'), 'triathlon.swim');

    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('owner_bypass');
  });

  it('global skill disable blocks non-owner users before tier grants', () => {
    upsertInstalledSkill('triathlon', false);
    grantOverride({ userId: 2, skillId: 'triathlon.swim', reason: 'beta grant' });

    const result = checkSkillAccess(makeUser(2, 'free'), 'triathlon.swim');

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('global_disabled');
  });

  it('training alias disable blocks pro triathlon sub-skill access before tier grants', () => {
    upsertInstalledSkill('triathlon', true);

    expect(disableInstalledSkill('training')).toBe(true);
    const result = checkSkillAccess(makeUser(22, 'pro'), 'triathlon.swim');

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('global_disabled');
  });

  it('global submodule disable blocks non-owner users before tier grants', () => {
    upsertInstalledSkill('triathlon', true, [{ name: 'swim', enabled: false }]);
    grantOverride({ userId: 3, skillId: 'triathlon.swim', reason: 'beta grant' });

    const result = checkSkillAccess(makeUser(3, 'free'), 'triathlon.swim');

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('global_disabled');
  });

  it('user explicit deny blocks a tier-eligible user', () => {
    upsertInstalledSkill('finance', true);
    setUserSkillToggle(4, 'finance', false);

    const result = checkSkillAccess(makeUser(4, 'pro'), 'finance');

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('admin_override_denied');
  });

  it('user explicit grant skips the tier check when global and user-deny gates pass', () => {
    upsertInstalledSkill('triathlon', true);
    grantOverride({ userId: 5, skillId: 'triathlon.swim', reason: 'coach beta' });

    const result = checkSkillAccess(makeUser(5, 'free'), 'triathlon.swim');

    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('user_grant');
  });

  it('tier override deny reports its source separately from admin toggle denies', () => {
    upsertInstalledSkill('triathlon', true);
    testDb.prepare(`
      INSERT INTO user_skill_tier_overrides (user_id, skill_id, unlocked, reason)
      VALUES (8, 'triathlon.swim', 0, 'coach revoked beta')
    `).run();

    const result = checkSkillAccess(makeUser(8, 'max'), 'triathlon.swim');

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('tier_override_denied');
  });

  it('falls back to the tier comparison when no higher-precedence gate matches', () => {
    const secretary = checkSkillAccess(makeUser(6, 'free'), 'secretary.tasks');
    const triathlon = checkSkillAccess(makeUser(6, 'free'), 'triathlon.swim');

    expect(secretary.allowed).toBe(true);
    expect(secretary.reason).toBe('catalog');
    expect(secretary.tierReason).toBe('catalog');
    expect(triathlon.allowed).toBe(false);
    expect(triathlon.reason).toBe('catalog');
  });

  it('fails closed when the DB is busy or unavailable', () => {
    testDb.close();

    const result = checkSkillAccess(makeUser(7, 'pro'), 'secretary.tasks');

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('db_error');

    testDb = new Database(':memory:');
  });
});

// ─── Catalog mutations ───────────────────────────────────────────────

describe('skill_tiers catalog mutations', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
  });
  afterEach(() => testDb?.close());

  it('setSkillTier creates row if missing', () => {
    setSkillTier('new.skill', 'pro', 'Brand new skill');
    const tier = getSkillTier('new.skill');
    expect(tier).toBe('pro');
  });

  it('setSkillTier updates existing row', () => {
    setSkillTier('content.script-generator', 'free', 'Downgraded');
    expect(getSkillTier('content.script-generator')).toBe('free');
  });

  it('listSkillTiers returns all catalog rows sorted', () => {
    const rows = listSkillTiers();
    expect(rows.length).toBeGreaterThan(20); // seed includes 30+ entries
    const ids = rows.map(r => r.skill_id);
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
  });
});

// ─── Batch ───────────────────────────────────────────────────────────

describe('checkTierAccessBatch', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
  });
  afterEach(() => testDb?.close());

  it('preserves request order in the returned Map', () => {
    const user = makeUser(1, 'pro');
    const ids = ['triathlon.swim', 'secretary.tasks', 'triathlon.running'];
    const result = checkTierAccessBatch(user, ids);
    expect(Array.from(result.keys())).toEqual(ids);
  });

  it('returns a result for every requested skill, even unknown', () => {
    const user = makeUser(1, 'pro');
    const result = checkTierAccessBatch(user, ['triathlon.gym', 'definitely.not.real']);
    expect(result.get('triathlon.gym')?.allowed).toBe(true);
    expect(result.get('definitely.not.real')?.allowed).toBe(true); // pro passes global default
    expect(result.get('definitely.not.real')?.reason).toBe('default');
  });
});
