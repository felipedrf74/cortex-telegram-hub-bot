// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Finance-specific service tests (OI-DATA-003c, 2026-04-23).
 * Mirrors the Secretary/Training test shape.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');
let testDb: Database.Database;


// OI-UX-106 rebase cleanup: prevent this file's vi.mock('services/database')
// from polluting later test files in the shared vitest fork (the project's
// vitest.config.ts sets `poolOptions.forks.singleFork: true`, which runs every
// test file in one process and keeps module mocks alive across files unless
// explicitly cleared). doUnmock + resetModules together mark the mock inert
// AND flush the cached version, so the next file's `import { getDb }` hits
// either its own mock or the real module.
afterAll(() => {
  vi.doUnmock('../../src/services/database');
  vi.doUnmock('../../src/utils/logger');
  vi.resetModules();
});

vi.mock('../../src/services/database', () => ({ getDb: () => testDb }));
vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    fatal: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis(),
  },
}));

function applyMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, filename TEXT UNIQUE, applied_at TEXT DEFAULT (datetime('now')))`);
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (db.prepare('SELECT 1 FROM _migrations WHERE filename = ?').get(file)) continue;
    try {
      db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
      db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
    } catch { /* skip */ }
  }
}
function seedUser(db: Database.Database, email: string): number {
  const r = db.prepare(
    `INSERT INTO users (email, tier, email_verified, status, auth_provider, created_at)
     VALUES (?, 'free', 1, 'active', 'email', datetime('now'))`,
  ).run(email);
  const uid = Number(r.lastInsertRowid);
  db.prepare(`INSERT OR IGNORE INTO tenants (id, slug, display_name, plan) VALUES (?, ?, ?, 'free')`)
    .run(uid, `user-${uid}`, email);
  db.prepare(`INSERT OR IGNORE INTO tenant_members (tenant_id, user_id, role) VALUES (?, ?, 'tenant_admin')`)
    .run(uid, uid);
  return uid;
}

import {
  getSkillConfig,
  putSkillConfig,
  SkillConfigError,
} from '../../src/services/tenant-skill-config-service';

describe('tenant-skill-config-service — Finance schema (OI-DATA-003c)', () => {
  let alice: number;
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
    alice = seedUser(testDb, 'alice-fin@e.com');
  });
  afterEach(() => testDb?.close());

  it('fresh tenant: returns 6 fields with correct defaults', () => {
    const row = getSkillConfig(alice, 'finance');
    expect(row.skillId).toBe('finance');
    // String fields default to ''.
    expect(row.config.budget_monthly).toBe('');
    expect(row.config.saving_goals).toBe('');
    expect(row.config.affordability_rules).toBe('');
    expect(row.config.extra_notes).toBe('');
    // Enum defaults.
    expect(row.config.primary_currency).toBe('USD');
    expect(row.config.decision_style).toBe('balanced');
  });

  it('put + get round-trip for all 6 fields', () => {
    putSkillConfig(alice, 'finance', alice, {
      budget_monthly: '$4,500 total. Rent $1,800. Food $700. Transport $400. Savings $1,000.',
      saving_goals: 'Emergency: $15k by Dec. House: $40k in 18mo.',
      affordability_rules: 'Never finance vacation. Car max 10% monthly income.',
      primary_currency: 'EUR',
      decision_style: 'conservative',
      extra_notes: 'Self-employed — quarterly taxes.',
    });
    const row = getSkillConfig(alice, 'finance');
    expect(row.config.budget_monthly).toContain('$4,500');
    expect(row.config.saving_goals).toContain('Emergency');
    expect(row.config.affordability_rules).toContain('Never finance');
    expect(row.config.primary_currency).toBe('EUR');
    expect(row.config.decision_style).toBe('conservative');
    expect(row.config.extra_notes).toContain('quarterly');
  });

  it('primary_currency enum: all 6 values accepted', () => {
    for (const v of ['USD', 'EUR', 'BRL', 'GBP', 'JPY', 'other']) {
      putSkillConfig(alice, 'finance', alice, { primary_currency: v as any });
    }
  });

  it('primary_currency enum: rejects unknown "CHF"', () => {
    expect(() => putSkillConfig(alice, 'finance', alice, {
      primary_currency: 'CHF' as any,
    })).toThrow(/must be one of/);
  });

  it('decision_style enum: all 3 values accepted', () => {
    for (const v of ['conservative', 'balanced', 'risk_tolerant']) {
      putSkillConfig(alice, 'finance', alice, { decision_style: v as any });
    }
  });

  it('decision_style enum: rejects unknown "aggressive"', () => {
    expect(() => putSkillConfig(alice, 'finance', alice, {
      decision_style: 'aggressive' as any,
    })).toThrow(/must be one of/);
  });

  it('budget_monthly cap: rejects >2000 chars', () => {
    expect(() => putSkillConfig(alice, 'finance', alice, {
      budget_monthly: 'x'.repeat(2001),
    })).toThrow(/too long/);
  });

  it('saving_goals cap: rejects >2000 chars', () => {
    expect(() => putSkillConfig(alice, 'finance', alice, {
      saving_goals: 'x'.repeat(2001),
    })).toThrow(/too long/);
  });

  it('affordability_rules cap: rejects >2000 chars', () => {
    expect(() => putSkillConfig(alice, 'finance', alice, {
      affordability_rules: 'x'.repeat(2001),
    })).toThrow(/too long/);
  });

  it('empty string on budget_monthly stores as null', () => {
    putSkillConfig(alice, 'finance', alice, { budget_monthly: 'v1' });
    putSkillConfig(alice, 'finance', alice, { budget_monthly: '' });
    expect(getSkillConfig(alice, 'finance').config.budget_monthly).toBeNull();
  });

  it('unknown Finance field: 400 with 6 allowed fields in details', () => {
    try {
      putSkillConfig(alice, 'finance', alice, { voice_guidelines: 'x' } as any);
      throw new Error('expected throw');
    } catch (e) {
      expect((e as SkillConfigError).code).toBe('BAD_REQUEST');
      const allowed = (e as SkillConfigError).details?.allowed as string[];
      expect(allowed).toEqual(expect.arrayContaining([
        'budget_monthly',
        'saving_goals',
        'affordability_rules',
        'primary_currency',
        'decision_style',
        'extra_notes',
      ]));
    }
  });

  it('diff-style patch: setting only decision_style leaves budget alone', () => {
    putSkillConfig(alice, 'finance', alice, { budget_monthly: 'preserve me' });
    putSkillConfig(alice, 'finance', alice, { decision_style: 'risk_tolerant' });
    const row = getSkillConfig(alice, 'finance');
    expect(row.config.budget_monthly).toBe('preserve me');
    expect(row.config.decision_style).toBe('risk_tolerant');
  });
});
