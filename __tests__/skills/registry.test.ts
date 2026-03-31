/**
 * Tests for src/skills/registry.ts
 *
 * Uses an in-memory SQLite database with migrations applied.
 * Mocks getDb() to return the test database instance.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import type { SkillManifest, SemVer } from '../../src/skills/types';

// ─── Test Helpers ───────────────────────────────────────────────────

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Apply all migrations
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
    db.exec(sql);
  }

  return db;
}

function createManifest(overrides: Partial<SkillManifest> = {}): SkillManifest {
  return {
    id: 'test-skill',
    name: 'Test Skill',
    version: '1.0.0' as SemVer,
    description: 'A test skill',
    author: 'Test Author',
    tier: 'private',
    minCoreVersion: '0.1.0' as SemVer,
    ...overrides,
  };
}

// ─── Mock getDb ─────────────────────────────────────────────────────

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
}));

// ─── Import after mock ─────────────────────────────────────────────

import {
  install,
  uninstall,
  enable,
  disable,
  getEnabled,
  getByDomain,
  getById,
  getAll,
  getSubmodules,
  enableSubmodule,
  disableSubmodule,
  updateConfig,
  _resetStmts,
} from '../../src/skills/registry';

// ─── Tests ──────────────────────────────────────────────────────────

describe('skills/registry', () => {
  beforeEach(() => {
    testDb = createTestDb();
    _resetStmts(); // Clear cached prepared statements
  });

  afterEach(() => {
    testDb.close();
  });

  // ── install() ───────────────────────────────────────────────────

  describe('install()', () => {
    it('should insert a skill into installed_skills', () => {
      const manifest = createManifest({ id: 'my-skill', version: '2.0.0' as SemVer });
      const row = install(manifest);

      expect(row.id).toBe('my-skill');
      expect(row.version).toBe('2.0.0');
      expect(row.enabled).toBe(1);
      expect(row.domain).toBeNull();
    });

    it('should store config as JSON', () => {
      const manifest = createManifest();
      const row = install(manifest, { config: { apiKey: 'abc', retries: 3 } });

      const parsed = JSON.parse(row.config);
      expect(parsed.apiKey).toBe('abc');
      expect(parsed.retries).toBe(3);
    });

    it('should store domain when provided', () => {
      const manifest = createManifest({ id: 'tri-skill' });
      const row = install(manifest, { domain: 'triathlon' });

      expect(row.domain).toBe('triathlon');
    });

    it('should insert submodules with default enabled state', () => {
      const manifest = createManifest({
        id: 'with-subs',
        subModules: [
          { id: 'garmin-sync', name: 'Garmin Sync', description: 'Sync', enabledByDefault: false },
          { id: 'nutrition', name: 'Nutrition', description: 'Meals', enabledByDefault: true },
        ],
      });

      install(manifest);
      const subs = getSubmodules('with-subs');

      expect(subs).toHaveLength(2);
      const garmin = subs.find(s => s.submodule_id === 'garmin-sync');
      const nutrition = subs.find(s => s.submodule_id === 'nutrition');
      expect(garmin!.enabled).toBe(0);
      expect(nutrition!.enabled).toBe(1);
    });

    it('should return existing row if skill already installed', () => {
      const manifest = createManifest({ id: 'dup-skill' });
      const first = install(manifest);
      const second = install(manifest);

      expect(first.id).toBe(second.id);
      expect(getAll()).toHaveLength(1);
    });

    it('should default config to empty JSON object', () => {
      const manifest = createManifest();
      const row = install(manifest);

      expect(JSON.parse(row.config)).toEqual({});
    });
  });

  // ── uninstall() ─────────────────────────────────────────────────

  describe('uninstall()', () => {
    it('should remove an installed skill', () => {
      install(createManifest({ id: 'remove-me' }));
      expect(getById('remove-me')).toBeDefined();

      const result = uninstall('remove-me');
      expect(result).toBe(true);
      expect(getById('remove-me')).toBeUndefined();
    });

    it('should cascade delete submodules', () => {
      const manifest = createManifest({
        id: 'cascade-test',
        subModules: [
          { id: 'sub-a', name: 'A', description: 'A', enabledByDefault: true },
        ],
      });
      install(manifest);
      expect(getSubmodules('cascade-test')).toHaveLength(1);

      uninstall('cascade-test');
      expect(getSubmodules('cascade-test')).toHaveLength(0);
    });

    it('should return false for non-existent skill', () => {
      expect(uninstall('ghost-skill')).toBe(false);
    });
  });

  // ── enable() / disable() ───────────────────────────────────────

  describe('enable() / disable()', () => {
    it('should disable then re-enable a skill', () => {
      install(createManifest({ id: 'toggle-skill' }));

      expect(disable('toggle-skill')).toBe(true);
      expect(getById('toggle-skill')!.enabled).toBe(0);

      expect(enable('toggle-skill')).toBe(true);
      expect(getById('toggle-skill')!.enabled).toBe(1);
    });

    it('should return false for non-existent skill', () => {
      expect(enable('nope')).toBe(false);
      expect(disable('nope')).toBe(false);
    });

    it('should update the updated_at timestamp', () => {
      install(createManifest({ id: 'ts-skill' }));
      const before = getById('ts-skill')!.updated_at;

      disable('ts-skill');
      const after = getById('ts-skill')!.updated_at;

      // Both are datetime strings — after should be >= before
      expect(after >= before).toBe(true);
    });
  });

  // ── getEnabled() ──────────────────────────────────────────────

  describe('getEnabled()', () => {
    it('should return only enabled skills', () => {
      install(createManifest({ id: 'skill-a' }));
      install(createManifest({ id: 'skill-b' }));
      install(createManifest({ id: 'skill-c' }));
      disable('skill-b');

      const enabled = getEnabled();
      expect(enabled).toHaveLength(2);
      expect(enabled.map(s => s.id).sort()).toEqual(['skill-a', 'skill-c']);
    });

    it('should return empty array when no skills installed', () => {
      expect(getEnabled()).toEqual([]);
    });
  });

  // ── getByDomain() ─────────────────────────────────────────────

  describe('getByDomain()', () => {
    it('should return enabled skills for a domain', () => {
      install(createManifest({ id: 'tri-1' }), { domain: 'triathlon' });
      install(createManifest({ id: 'tri-2' }), { domain: 'triathlon' });
      install(createManifest({ id: 'sec-1' }), { domain: 'secretary' });

      const tri = getByDomain('triathlon');
      expect(tri).toHaveLength(2);
      expect(tri.every(s => s.domain === 'triathlon')).toBe(true);
    });

    it('should exclude disabled skills', () => {
      install(createManifest({ id: 'dis-1' }), { domain: 'content' });
      install(createManifest({ id: 'dis-2' }), { domain: 'content' });
      disable('dis-1');

      expect(getByDomain('content')).toHaveLength(1);
    });

    it('should return empty array for unknown domain', () => {
      expect(getByDomain('nonexistent')).toEqual([]);
    });
  });

  // ── getById() / getAll() ──────────────────────────────────────

  describe('getById() / getAll()', () => {
    it('should return undefined for missing skill', () => {
      expect(getById('missing')).toBeUndefined();
    });

    it('should return all skills regardless of enabled state', () => {
      install(createManifest({ id: 'all-1' }));
      install(createManifest({ id: 'all-2' }));
      disable('all-2');

      expect(getAll()).toHaveLength(2);
    });
  });

  // ── Submodule operations ──────────────────────────────────────

  describe('submodule operations', () => {
    beforeEach(() => {
      install(createManifest({
        id: 'sub-skill',
        subModules: [
          { id: 'mod-a', name: 'A', description: 'A', enabledByDefault: true },
          { id: 'mod-b', name: 'B', description: 'B', enabledByDefault: false },
        ],
      }));
    });

    it('should enable a disabled submodule', () => {
      expect(enableSubmodule('sub-skill', 'mod-b')).toBe(true);
      const subs = getSubmodules('sub-skill');
      expect(subs.find(s => s.submodule_id === 'mod-b')!.enabled).toBe(1);
    });

    it('should disable an enabled submodule', () => {
      expect(disableSubmodule('sub-skill', 'mod-a')).toBe(true);
      const subs = getSubmodules('sub-skill');
      expect(subs.find(s => s.submodule_id === 'mod-a')!.enabled).toBe(0);
    });

    it('should return false for non-existent submodule', () => {
      expect(enableSubmodule('sub-skill', 'mod-z')).toBe(false);
      expect(disableSubmodule('sub-skill', 'mod-z')).toBe(false);
    });
  });

  // ── updateConfig() ────────────────────────────────────────────

  describe('updateConfig()', () => {
    it('should update skill config JSON', () => {
      install(createManifest({ id: 'cfg-skill' }));
      updateConfig('cfg-skill', { theme: 'dark', maxRetries: 5 });

      const row = getById('cfg-skill')!;
      const parsed = JSON.parse(row.config);
      expect(parsed.theme).toBe('dark');
      expect(parsed.maxRetries).toBe(5);
    });

    it('should return false for non-existent skill', () => {
      expect(updateConfig('ghost', { x: 1 })).toBe(false);
    });
  });
});
