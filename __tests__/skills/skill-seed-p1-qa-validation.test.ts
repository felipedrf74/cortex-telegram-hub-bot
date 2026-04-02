/**
 * QA Validation — P1 Skill Enable/Disable False Positive Fix
 *
 * Validates: BUG P1: Skill enable/disable returns false positive error
 * Root cause: seedDefaultSkills() was never called on startup, so DB had no rows
 * to update → enable/disable returned false → user saw "Could not enable" error.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { DEFAULT_SKILLS } from '../../src/skills/skill-config';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

function applyMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL UNIQUE,
      applied_at TEXT DEFAULT (datetime('now'))
    );
  `);
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql') && !f.includes(' 2'))
    .sort();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
    db.exec(sql);
    db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
  }
}

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Import AFTER mocks
import {
  seedDefaultSkills,
  enableSkill,
  disableSkill,
  enableSubSkill,
  disableSubSkill,
  getSkillStatus,
} from '../../src/skills/skill-manager';

beforeEach(() => {
  testDb = createTestDb();
  applyMigrations(testDb);
});

afterEach(() => {
  testDb?.close();
});

describe('P1 Fix: seedDefaultSkills called at startup', () => {
  it('seedDefaultSkills creates all domain skills', () => {
    seedDefaultSkills();
    const domains = Object.keys(DEFAULT_SKILLS);
    for (const domain of domains) {
      const status = getSkillStatus(domain as any);
      expect(status).toBeDefined();
      expect(status.name).toBe(domain);
    }
  });

  it('all skills are enabled by default after seeding', () => {
    seedDefaultSkills();
    const domains = Object.keys(DEFAULT_SKILLS);
    for (const domain of domains) {
      const status = getSkillStatus(domain as any);
      expect(status.enabled).toBe(true);
    }
  });
});

describe('P1 Fix: enable/disable returns true after seeding (not false positive)', () => {
  it('enableSubSkill returns true for valid sub-skill after seeding', () => {
    seedDefaultSkills();
    // Disable first, then enable — should return true both ways
    const disResult = disableSubSkill('secretary', 'email');
    expect(disResult).toBe(true);
    const enResult = enableSubSkill('secretary', 'email');
    expect(enResult).toBe(true);
  });

  it('enableSubSkill returns false for non-existent sub-skill', () => {
    seedDefaultSkills();
    const result = enableSubSkill('secretary', 'nonexistent-module');
    expect(result).toBe(false);
  });

  it('enableSkill returns true for valid domain after seeding', () => {
    seedDefaultSkills();
    // Disable first to ensure we're enabling from disabled state
    disableSkill('cooking');
    const result = enableSkill('cooking');
    expect(result).toBe(true);
  });

  it('enableSkill returns false without seeding (the original bug)', () => {
    // Without seeding, no rows exist → returns false → "Could not enable" error
    const result = enableSkill('cooking');
    expect(result).toBe(false);
  });
});

describe('P1 Fix: seeding is idempotent', () => {
  it('calling seedDefaultSkills twice does not duplicate or reset user toggles', () => {
    seedDefaultSkills();
    disableSubSkill('secretary', 'email');
    // Second seed should NOT re-enable email
    seedDefaultSkills();
    const status = getSkillStatus('secretary');
    const email = status.subSkills.find((s: any) => s.name === 'email');
    expect(email?.enabled).toBe(false);
  });
});

describe('P1 Fix: index.ts calls seedDefaultSkills after initDatabase', () => {
  it('index.ts imports seedDefaultSkills', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const indexSource = fs.readFileSync(
      path.resolve(__dirname, '../../src/index.ts'),
      'utf8',
    );
    expect(indexSource).toContain("import { seedDefaultSkills }");
    expect(indexSource).toContain("seedDefaultSkills()");
  });

  it('seedDefaultSkills is called after initDatabase in index.ts', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const indexSource = fs.readFileSync(
      path.resolve(__dirname, '../../src/index.ts'),
      'utf8',
    );
    const initDbPos = indexSource.indexOf('initDatabase()');
    const seedPos = indexSource.indexOf('seedDefaultSkills()');
    expect(initDbPos).toBeGreaterThan(-1);
    expect(seedPos).toBeGreaterThan(-1);
    expect(seedPos).toBeGreaterThan(initDbPos);
  });
});
