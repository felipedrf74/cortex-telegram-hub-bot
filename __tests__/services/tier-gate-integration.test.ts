/**
 * Tier Gate Integration — Phase 1 Slice C
 *
 * The chat handlers (Telegram, iOS REST, iOS WebSocket) all use the
 * same pattern: after routing a message to a domain, they check
 * `checkSkillAccess({ id, tier }, route.domain)` and short-circuit when
 * the user isn't authorized. The primitive `checkSkillAccess` is covered
 * in skill-tiers.test.ts — this file locks the BOUNDARY conditions
 * specifically exercised by the chat entrypoints:
 *
 *  - Gate against PARENT domain names (what route.domain returns) vs
 *    sub-skill IDs (what the catalog stores most finely).
 *  - Tier-required i18n string renders with variable substitution.
 *  - Secretary (free tier anchor) is accessible to every tier.
 *  - Every non-secretary parent domain requires pro for free users.
 *  - The recently-bumped defaults (new users → 'pro') mean a fresh
 *    signup lands on the happy path for every domain.
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

import { checkSkillAccess, setSkillTier } from '../../src/services/skill-tiers';
import { t } from '../../src/utils/i18n';
import { getOrCreateUser } from '../../src/services/user-service';

// ─── Parent-domain gate tests (what the chat handlers actually check) ───

describe('Tier gate — parent domain names from RouteResult', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
  });
  afterEach(() => testDb?.close());

  const parents = ['secretary', 'triathlon', 'content', 'finance', 'cooking'] as const;

  it('free user can reach secretary but NOT any other parent domain', () => {
    const free = { id: 1, tier: 'free' as const };
    expect(checkSkillAccess(free, 'secretary').allowed).toBe(true);
    for (const domain of parents.filter(d => d !== 'secretary')) {
      const result = checkSkillAccess(free, domain);
      expect(result.allowed, `free should NOT access ${domain}`).toBe(false);
      expect(result.requiredTier).toBe('pro');
    }
  });

  it('pro user can reach every parent domain (including secretary)', () => {
    const pro = { id: 2, tier: 'pro' as const };
    for (const domain of parents) {
      const result = checkSkillAccess(pro, domain);
      expect(result.allowed, `pro should access ${domain}`).toBe(true);
    }
  });

  it('owner user can reach every parent domain', () => {
    const owner = { id: 3, tier: 'owner' as const };
    for (const domain of parents) {
      const result = checkSkillAccess(owner, domain);
      expect(result.allowed, `owner should access ${domain}`).toBe(true);
    }
  });

  it('max user can reach every non-owner parent domain', () => {
    const max = { id: 4, tier: 'max' as const };
    for (const domain of parents) {
      const result = checkSkillAccess(max, domain);
      expect(result.allowed, `max should access ${domain}`).toBe(true);
    }
  });
});

// ─── New-user default tier integration ─────────────────────────────

describe('Tier gate — new user signup default', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
  });
  afterEach(() => testDb?.close());

  it('a brand-new user (created via getOrCreateUser) can access triathlon on day 1', () => {
    const user = getOrCreateUser(555, { username: 'new', firstName: 'New' });
    // Phase 1 default: new signups → pro
    expect(user.tier).toBe('pro');

    const result = checkSkillAccess({ id: user.id, tier: user.tier }, 'triathlon');
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('catalog');
  });

  it('existing free users bumped to pro by migration 045 can access triathlon', () => {
    // Simulate a legacy free user left over from pre-migration data.
    // The migration bulk-update should have converted them to pro.
    testDb.prepare(`
      INSERT INTO users (telegram_id, tier, daily_message_limit, daily_token_limit, daily_cost_limit_usd)
      VALUES (?, 'free', 40, 100000, 0)
    `).run(666);

    // Re-run the migration's upgrade clause to simulate deploy.
    testDb.prepare(`
      UPDATE users SET tier = 'pro', daily_message_limit = 200, daily_token_limit = 500000, daily_cost_limit_usd = 5.0
      WHERE tier = 'free'
    `).run();

    const bumped = testDb.prepare('SELECT id, tier FROM users WHERE telegram_id = ?').get(666) as any;
    expect(bumped.tier).toBe('pro');

    const result = checkSkillAccess({ id: bumped.id, tier: bumped.tier }, 'triathlon');
    expect(result.allowed).toBe(true);
  });
});

// ─── i18n rendering for the blocked-response path ──────────────────

describe('Tier gate — i18n error rendering', () => {
  it('skill_tier_required renders pt-BR with variable substitution', () => {
    const msg = t('skill_tier_required', 'pt-BR', {
      tier: 'pro',
      current: 'free',
    });
    expect(msg).toContain('<b>pro</b>');
    expect(msg).toContain('<b>free</b>');
    expect(msg).toContain('plano');
  });

  it('skill_tier_required renders en-US with variable substitution', () => {
    const msg = t('skill_tier_required', 'en-US', {
      tier: 'pro',
      current: 'free',
    });
    expect(msg).toContain('<b>pro</b>');
    expect(msg).toContain('<b>free</b>');
    expect(msg).toContain('tier');
  });

  it('skill_tier_required falls back to en-US for unknown lang', () => {
    const msg = t('skill_tier_required', 'fr-FR' as any, {
      tier: 'pro',
      current: 'free',
    });
    // Falls back to en-US via t()'s default branch
    expect(msg).toContain('tier');
  });
});

// ─── Owner-tier skill blocks pro ────────────────────────────────────

describe('Tier gate — owner-only skills', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
  });
  afterEach(() => testDb?.close());

  it('pro user is blocked from an owner-tier skill', () => {
    setSkillTier('admin.audit', 'owner', 'Admin audit log');
    const result = checkSkillAccess({ id: 1, tier: 'pro' }, 'admin.audit');
    expect(result.allowed).toBe(false);
    expect(result.requiredTier).toBe('owner');
  });

  it('owner user reaches the same owner-tier skill', () => {
    setSkillTier('admin.audit', 'owner');
    const result = checkSkillAccess({ id: 2, tier: 'owner' }, 'admin.audit');
    expect(result.allowed).toBe(true);
  });
});
