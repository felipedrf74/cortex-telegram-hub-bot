/**
 * Model Config Tests
 *
 * Tests runtime model override system:
 * - get/set/clear overrides
 * - config mutation (live patching)
 * - KV store persistence
 * - loadModelOverrides from DB
 * - getAllModelStates for portal
 * - MODEL_OPTIONS validation
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

// ─── Mock database ──────────────────────────────────────────────────

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
}));

// ─── Mock config with mutable properties ────────────────────────────
// Defined inline in factory to avoid hoisting issues with vi.mock

vi.mock('../../src/config', () => ({
  config: {
    anthropic: {
      apiKey: 'sk-test',
      model: 'claude-sonnet-4-6',
      classifierModel: 'claude-haiku-4-5-20251001',
      maxTokens: 1024,
      secretaryMaxTokens: 2048,
    },
    openai: {
      apiKey: 'sk-openai-test',
      model: 'gpt-4o',
      classifierModel: 'gpt-4o-mini',
      maxTokens: 1024,
      secretaryMaxTokens: 2048,
    },
    gemini: {
      apiKey: 'gemini-key',
      model: 'gemini-2.0-flash',
      classifierModel: 'gemini-2.0-flash',
      maxTokens: 1024,
      secretaryMaxTokens: 2048,
    },
  },
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    trace: vi.fn(), child: vi.fn().mockReturnThis(),
  },
}));

// ─── Imports ─────────────────────────────────────────────────────────

import {
  getActiveModel,
  setActiveModel,
  clearModelOverride,
  loadModelOverrides,
  getAllModelStates,
  MODEL_OPTIONS,
  _resetOverrides,
} from '../../src/services/model-config';
import { config } from '../../src/config';

// Reference to the mocked config for assertion
const mockConfig = config as { anthropic: Record<string, any>; openai: Record<string, any>; gemini: Record<string, any> };

// ═══════════════════════════════════════════════════════════════════

describe('model-config', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    testDb.exec(`
      CREATE TABLE IF NOT EXISTS kv_store (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    _resetOverrides();

    // Reset mock config to defaults
    mockConfig.anthropic.model = 'claude-sonnet-4-6';
    mockConfig.anthropic.classifierModel = 'claude-haiku-4-5-20251001';
    mockConfig.openai.model = 'gpt-4o';
    mockConfig.openai.classifierModel = 'gpt-4o-mini';
    mockConfig.gemini.model = 'gemini-2.0-flash';
    mockConfig.gemini.classifierModel = 'gemini-2.0-flash';
  });

  afterEach(() => {
    _resetOverrides();
    testDb?.close();
  });

  // ── getActiveModel ────────────────────────────────────────────────

  describe('getActiveModel', () => {
    it('returns default from config when no override', () => {
      expect(getActiveModel('anthropic', 'chat')).toBe('claude-sonnet-4-6');
      expect(getActiveModel('anthropic', 'classifier')).toBe('claude-haiku-4-5-20251001');
    });

    it('returns override when set', () => {
      setActiveModel('anthropic', 'chat', 'claude-opus-4-6');
      expect(getActiveModel('anthropic', 'chat')).toBe('claude-opus-4-6');
    });
  });

  // ── setActiveModel ────────────────────────────────────────────────

  describe('setActiveModel', () => {
    it('updates in-memory cache', () => {
      setActiveModel('openai', 'chat', 'gpt-4.1');
      expect(getActiveModel('openai', 'chat')).toBe('gpt-4.1');
    });

    it('persists to kv_store table', () => {
      setActiveModel('anthropic', 'chat', 'claude-opus-4-6');
      const row = testDb.prepare("SELECT value FROM kv_store WHERE key = 'model_override:anthropic:chat'").get() as { value: string } | undefined;
      expect(row).toBeDefined();
      expect(JSON.parse(row!.value)).toBe('claude-opus-4-6');
    });

    it('patches live config object', () => {
      setActiveModel('anthropic', 'chat', 'claude-opus-4-6');
      expect(mockConfig.anthropic.model).toBe('claude-opus-4-6');
    });

    it('works for all three providers', () => {
      setActiveModel('anthropic', 'chat', 'claude-opus-4-6');
      setActiveModel('openai', 'chat', 'gpt-4.1');
      setActiveModel('gemini', 'chat', 'gemini-2.5-pro-preview-03-25');

      expect(mockConfig.anthropic.model).toBe('claude-opus-4-6');
      expect(mockConfig.openai.model).toBe('gpt-4.1');
      expect(mockConfig.gemini.model).toBe('gemini-2.5-pro-preview-03-25');
    });

    it('works for both roles (chat, classifier)', () => {
      setActiveModel('anthropic', 'chat', 'claude-opus-4-6');
      setActiveModel('anthropic', 'classifier', 'claude-sonnet-4-6');

      expect(mockConfig.anthropic.model).toBe('claude-opus-4-6');
      expect(mockConfig.anthropic.classifierModel).toBe('claude-sonnet-4-6');
    });
  });

  // ── clearModelOverride ────────────────────────────────────────────

  describe('clearModelOverride', () => {
    it('removes override, reverts to default', () => {
      setActiveModel('anthropic', 'chat', 'claude-opus-4-6');
      clearModelOverride('anthropic', 'chat');
      expect(getActiveModel('anthropic', 'chat')).toBe('claude-sonnet-4-6');
    });

    it('deletes from kv_store', () => {
      setActiveModel('anthropic', 'chat', 'claude-opus-4-6');
      clearModelOverride('anthropic', 'chat');
      const row = testDb.prepare("SELECT 1 FROM kv_store WHERE key = 'model_override:anthropic:chat'").get();
      expect(row).toBeUndefined();
    });

    it('patches config back to default', () => {
      setActiveModel('anthropic', 'chat', 'claude-opus-4-6');
      expect(mockConfig.anthropic.model).toBe('claude-opus-4-6');

      clearModelOverride('anthropic', 'chat');
      expect(mockConfig.anthropic.model).toBe('claude-sonnet-4-6');
    });
  });

  // ── loadModelOverrides ────────────────────────────────────────────

  describe('loadModelOverrides', () => {
    it('loads persisted overrides from kv_store on startup', () => {
      // Manually insert an override into DB
      testDb.prepare(`
        INSERT INTO kv_store (key, value) VALUES ('model_override:openai:chat', '"gpt-4.1"')
      `).run();

      loadModelOverrides();
      expect(getActiveModel('openai', 'chat')).toBe('gpt-4.1');
      expect(mockConfig.openai.model).toBe('gpt-4.1');
    });

    it('patches config for each loaded override', () => {
      testDb.prepare(`INSERT INTO kv_store (key, value) VALUES ('model_override:anthropic:chat', '"claude-opus-4-6"')`).run();
      testDb.prepare(`INSERT INTO kv_store (key, value) VALUES ('model_override:gemini:classifier', '"gemini-2.5-flash-preview-04-17"')`).run();

      loadModelOverrides();
      expect(mockConfig.anthropic.model).toBe('claude-opus-4-6');
      expect(mockConfig.gemini.classifierModel).toBe('gemini-2.5-flash-preview-04-17');
    });

    it('handles empty kv_store gracefully', () => {
      expect(() => loadModelOverrides()).not.toThrow();
    });

    it('handles missing kv_store table (creates it)', () => {
      testDb.exec('DROP TABLE IF EXISTS kv_store');
      expect(() => loadModelOverrides()).not.toThrow();
      // Table should now exist
      const tables = testDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='kv_store'").all();
      expect(tables).toHaveLength(1);
    });
  });

  // ── getAllModelStates ──────────────────────────────────────────────

  describe('getAllModelStates', () => {
    it('returns all 3 providers with chat + classifier', () => {
      const states = getAllModelStates();
      expect(states).toHaveLength(3);
      const names = states.map(s => s.provider);
      expect(names).toContain('anthropic');
      expect(names).toContain('openai');
      expect(names).toContain('gemini');
    });

    it('marks overridden models with source: override', () => {
      setActiveModel('anthropic', 'chat', 'claude-opus-4-6');
      const states = getAllModelStates();
      const anthropic = states.find(s => s.provider === 'anthropic')!;
      expect(anthropic.chat.source).toBe('override');
      expect(anthropic.chat.model).toBe('claude-opus-4-6');
    });

    it('marks defaults with source: default', () => {
      const states = getAllModelStates();
      const anthropic = states.find(s => s.provider === 'anthropic')!;
      expect(anthropic.chat.source).toBe('default');
      expect(anthropic.classifier.source).toBe('default');
    });
  });

  // ── MODEL_OPTIONS ─────────────────────────────────────────────────

  describe('MODEL_OPTIONS', () => {
    it('has entries for all three providers', () => {
      expect(MODEL_OPTIONS).toHaveProperty('anthropic');
      expect(MODEL_OPTIONS).toHaveProperty('openai');
      expect(MODEL_OPTIONS).toHaveProperty('gemini');
    });

    it('chat and classifier arrays are non-empty', () => {
      for (const provider of ['anthropic', 'openai', 'gemini'] as const) {
        expect(MODEL_OPTIONS[provider].chat.length).toBeGreaterThan(0);
        expect(MODEL_OPTIONS[provider].classifier.length).toBeGreaterThan(0);
      }
    });
  });
});
