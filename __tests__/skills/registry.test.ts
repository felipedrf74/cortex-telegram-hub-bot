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
import type { SkillManifest } from '../../src/skills/types';

// ─── Test Helpers ───────────────────────────────────────────────────

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

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
    version: '1.0.0',
    description: 'A test skill',
    author: 'Test Author',
    license: 'MIT',
    hubVersion: '>=1.0.0',
    platforms: ['telegram'],
    category: 'productivity',
    tier: 'private',
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
  installFromManifest,
  uninstall,
  enable,
  disable,
  getEnabled,
  getByDomain,
  getByName,
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
    _resetStmts();
  });

  afterEach(() => {
    testDb.close();
  });

  // ── install() ───────────────────────────────────────────────────

  describe('install()', () => {
    it('should insert a skill into installed_skills', () => {
      const row = install({ name: 'my-skill', version: '2.0.0' });

      expect(row.name).toBe('my-skill');
      expect(row.version).toBe('2.0.0');
      expect(row.enabled).toBe(1);
      expect(row.domain).toBeNull();
      expect(row.id).toBeGreaterThan(0);
    });

    it('should store config as JSON', () => {
      const row = install({
        name: 'cfg-skill',
        config: { apiKey: 'abc', retries: 3 },
      });

      const parsed = JSON.parse(row.config_json!);
      expect(parsed.apiKey).toBe('abc');
      expect(parsed.retries).toBe(3);
    });

    it('should store domain when provided', () => {
      const row = install({ name: 'tri-skill', domain: 'triathlon' });
      expect(row.domain).toBe('triathlon');
    });

    it('should store description when provided', () => {
      const row = install({ name: 'desc-skill', description: 'A great skill' });
      expect(row.description).toBe('A great skill');
    });

    it('should install submodules', () => {
      const row = install({
        name: 'with-subs',
        submodules: [
          { module_name: 'garmin-sync', version: '1.0.0' },
          { module_name: 'nutrition' },
        ],
      });

      const subs = getSubmodules(row.id);
      expect(subs).toHaveLength(2);
      expect(subs.map(s => s.module_name).sort()).toEqual(['garmin-sync', 'nutrition']);
    });

    it('should upsert on duplicate name (update instead of error)', () => {
      install({ name: 'dup-skill', version: '1.0.0' });
      install({ name: 'dup-skill', version: '2.0.0', description: 'Updated' });

      const all = getAll();
      expect(all).toHaveLength(1);
      expect(all[0].version).toBe('2.0.0');
      expect(all[0].description).toBe('Updated');
    });

    it('should default version to 1.0.0', () => {
      const row = install({ name: 'no-version' });
      expect(row.version).toBe('1.0.0');
    });

    it('should default config_json to null', () => {
      const row = install({ name: 'no-config' });
      expect(row.config_json).toBeNull();
    });
  });

  // ── installFromManifest() ───────────────────────────────────────

  describe('installFromManifest()', () => {
    it('should install from a SkillManifest', () => {
      const manifest = createManifest({ id: 'from-manifest', version: '3.0.0' });
      const row = installFromManifest(manifest, { domain: 'content' });

      expect(row.name).toBe('from-manifest');
      expect(row.version).toBe('3.0.0');
      expect(row.domain).toBe('content');
    });

    it('should install manifest subModules as submodules', () => {
      const manifest = createManifest({
        id: 'manifest-subs',
        subModules: [
          { id: 'garmin-sync', name: 'Garmin Sync', description: 'Sync', default: false },
          { id: 'nutrition', name: 'Nutrition', description: 'Meals', default: true },
        ],
      });

      const row = installFromManifest(manifest);
      const subs = getSubmodules(row.id);

      expect(subs).toHaveLength(2);
      expect(subs.map(s => s.module_name).sort()).toEqual(['garmin-sync', 'nutrition']);
    });
  });

  // ── uninstall() ─────────────────────────────────────────────────

  describe('uninstall()', () => {
    it('should remove an installed skill', () => {
      install({ name: 'remove-me' });
      expect(getByName('remove-me')).toBeDefined();

      const result = uninstall('remove-me');
      expect(result).toBe(true);
      expect(getByName('remove-me')).toBeUndefined();
    });

    it('should cascade delete submodules', () => {
      const row = install({
        name: 'cascade-test',
        submodules: [{ module_name: 'sub-a' }],
      });
      expect(getSubmodules(row.id)).toHaveLength(1);

      uninstall('cascade-test');
      expect(getSubmodules(row.id)).toHaveLength(0);
    });

    it('should return false for non-existent skill', () => {
      expect(uninstall('ghost-skill')).toBe(false);
    });
  });

  // ── enable() / disable() ───────────────────────────────────────

  describe('enable() / disable()', () => {
    it('should disable then re-enable a skill', () => {
      install({ name: 'toggle-skill' });

      expect(disable('toggle-skill')).toBe(true);
      expect(getByName('toggle-skill')!.enabled).toBe(0);

      expect(enable('toggle-skill')).toBe(true);
      expect(getByName('toggle-skill')!.enabled).toBe(1);
    });

    it('should return false for non-existent skill', () => {
      expect(enable('nope')).toBe(false);
      expect(disable('nope')).toBe(false);
    });

    it('should update the updated_at timestamp', () => {
      install({ name: 'ts-skill' });
      const before = getByName('ts-skill')!.updated_at;

      disable('ts-skill');
      const after = getByName('ts-skill')!.updated_at;

      expect(after >= before).toBe(true);
    });
  });

  // ── getEnabled() ──────────────────────────────────────────────

  describe('getEnabled()', () => {
    it('should return only enabled skills', () => {
      install({ name: 'skill-a' });
      install({ name: 'skill-b' });
      install({ name: 'skill-c' });
      disable('skill-b');

      const enabled = getEnabled();
      expect(enabled).toHaveLength(2);
      expect(enabled.map(s => s.name).sort()).toEqual(['skill-a', 'skill-c']);
    });

    it('should return empty array when no skills installed', () => {
      expect(getEnabled()).toEqual([]);
    });
  });

  // ── getByDomain() ─────────────────────────────────────────────

  describe('getByDomain()', () => {
    it('should return enabled skills for a domain', () => {
      install({ name: 'tri-1', domain: 'triathlon' });
      install({ name: 'tri-2', domain: 'triathlon' });
      install({ name: 'sec-1', domain: 'secretary' });

      const tri = getByDomain('triathlon');
      expect(tri).toHaveLength(2);
      expect(tri.every(s => s.domain === 'triathlon')).toBe(true);
    });

    it('should exclude disabled skills', () => {
      install({ name: 'dis-1', domain: 'content' });
      install({ name: 'dis-2', domain: 'content' });
      disable('dis-1');

      expect(getByDomain('content')).toHaveLength(1);
    });

    it('should return empty array for unknown domain', () => {
      expect(getByDomain('nonexistent')).toEqual([]);
    });
  });

  // ── getByName() / getAll() ────────────────────────────────────

  describe('getByName() / getAll()', () => {
    it('should return undefined for missing skill', () => {
      expect(getByName('missing')).toBeUndefined();
    });

    it('should return all skills regardless of enabled state', () => {
      install({ name: 'all-1' });
      install({ name: 'all-2' });
      disable('all-2');

      expect(getAll()).toHaveLength(2);
    });
  });

  // ── Submodule operations ──────────────────────────────────────

  describe('submodule operations', () => {
    let skillId: number;

    beforeEach(() => {
      const row = install({
        name: 'sub-skill',
        submodules: [
          { module_name: 'mod-a' },
          { module_name: 'mod-b' },
        ],
      });
      skillId = row.id;
    });

    it('should disable then re-enable a submodule', () => {
      expect(disableSubmodule(skillId, 'mod-a')).toBe(true);
      const subs = getSubmodules(skillId);
      expect(subs.find(s => s.module_name === 'mod-a')!.enabled).toBe(0);

      expect(enableSubmodule(skillId, 'mod-a')).toBe(true);
      const subsAfter = getSubmodules(skillId);
      expect(subsAfter.find(s => s.module_name === 'mod-a')!.enabled).toBe(1);
    });

    it('should return false for non-existent submodule', () => {
      expect(enableSubmodule(skillId, 'mod-z')).toBe(false);
      expect(disableSubmodule(skillId, 'mod-z')).toBe(false);
    });
  });

  // ── updateConfig() ────────────────────────────────────────────

  describe('updateConfig()', () => {
    it('should update skill config JSON', () => {
      install({ name: 'cfg-skill' });
      updateConfig('cfg-skill', { theme: 'dark', maxRetries: 5 });

      const row = getByName('cfg-skill')!;
      const parsed = JSON.parse(row.config_json!);
      expect(parsed.theme).toBe('dark');
      expect(parsed.maxRetries).toBe(5);
    });

    it('should return false for non-existent skill', () => {
      expect(updateConfig('ghost', { x: 1 })).toBe(false);
    });
  });
});
