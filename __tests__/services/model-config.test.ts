/**
 * Model Config Tests
 *
 * Tests runtime model override system:
 * - Provider-level get/set/clear overrides (chat, classifier)
 * - Domain-level get/set/clear overrides (secretary, triathlon, etc.)
 * - Resolution chain: domain override → tier override → config default
 * - Config mutation (live patching)
 * - KV store persistence
 * - loadModelOverrides from DB
 * - getAllModelStates for portal (includes domain states)
 * - MODEL_OPTIONS validation
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

// ─── Mock database ──────────────────────────────────────────────────

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
}));

// ─── Mock config (inline to avoid hoisting issues) ──────────────────

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
  LOGGER_REDACTION_PATHS: [],
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
  setDomainModel,
  clearDomainModel,
  getDomainModelOverride,
  getEffectiveDomainModel,
  DOMAIN_ROLES,
  VALID_ROLES,
} from '../../src/services/model-config';
import { config } from '../../src/config';

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

  // ── Provider-level: getActiveModel ────────────────────────────────

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

  // ── Provider-level: setActiveModel ────────────────────────────────

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

    it('patches live config object for provider-level roles', () => {
      setActiveModel('anthropic', 'chat', 'claude-opus-4-6');
      expect(mockConfig.anthropic.model).toBe('claude-opus-4-6');
    });

    it('does NOT patch config for domain-level roles', () => {
      setActiveModel('anthropic', 'secretary', 'claude-opus-4-6');
      // config.anthropic.model should NOT change — domain overrides are resolved in getModelRouting
      expect(mockConfig.anthropic.model).toBe('claude-sonnet-4-6');
    });

    it('works for all three providers', () => {
      setActiveModel('anthropic', 'chat', 'claude-opus-4-6');
      setActiveModel('openai', 'chat', 'gpt-4.1');
      setActiveModel('gemini', 'chat', 'gemini-2.5-pro-preview-03-25');

      expect(mockConfig.anthropic.model).toBe('claude-opus-4-6');
      expect(mockConfig.openai.model).toBe('gpt-4.1');
      expect(mockConfig.gemini.model).toBe('gemini-2.5-pro-preview-03-25');
    });

    it('works for both provider roles (chat, classifier)', () => {
      setActiveModel('anthropic', 'chat', 'claude-opus-4-6');
      setActiveModel('anthropic', 'classifier', 'claude-sonnet-4-6');

      expect(mockConfig.anthropic.model).toBe('claude-opus-4-6');
      expect(mockConfig.anthropic.classifierModel).toBe('claude-sonnet-4-6');
    });
  });

  // ── Provider-level: clearModelOverride ─────────────────────────────

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
      clearModelOverride('anthropic', 'chat');
      expect(mockConfig.anthropic.model).toBe('claude-sonnet-4-6');
    });
  });

  // ── Domain-level overrides ────────────────────────────────────────

  describe('domain-level overrides', () => {
    it('setDomainModel stores a domain-specific override', () => {
      setDomainModel('anthropic', 'triathlon', 'claude-sonnet-4-6');
      expect(getDomainModelOverride('anthropic', 'triathlon')).toBe('claude-sonnet-4-6');
    });

    it('getDomainModelOverride returns undefined when no override', () => {
      expect(getDomainModelOverride('anthropic', 'secretary')).toBeUndefined();
    });

    it('domain override persists to kv_store', () => {
      setDomainModel('anthropic', 'cooking', 'claude-haiku-4-5-20251001');
      const row = testDb.prepare("SELECT value FROM kv_store WHERE key = 'model_override:anthropic:cooking'").get() as any;
      expect(JSON.parse(row.value)).toBe('claude-haiku-4-5-20251001');
    });

    it('clearDomainModel removes domain override', () => {
      setDomainModel('anthropic', 'secretary', 'claude-opus-4-6');
      clearDomainModel('anthropic', 'secretary');
      expect(getDomainModelOverride('anthropic', 'secretary')).toBeUndefined();
    });

    it('clearDomainModel deletes from kv_store', () => {
      setDomainModel('openai', 'finance', 'gpt-4.1-nano');
      clearDomainModel('openai', 'finance');
      const row = testDb.prepare("SELECT 1 FROM kv_store WHERE key = 'model_override:openai:finance'").get();
      expect(row).toBeUndefined();
    });
  });

  // ── Resolution chain: getEffectiveDomainModel ─────────────────────

  describe('getEffectiveDomainModel (resolution chain)', () => {
    it('returns domain override when set (highest priority)', () => {
      setDomainModel('anthropic', 'triathlon', 'claude-opus-4-6');
      expect(getEffectiveDomainModel('anthropic', 'triathlon')).toBe('claude-opus-4-6');
    });

    it('falls through to provider-tier when no domain override', () => {
      // secretary uses 'chat' tier → defaults to config.anthropic.model
      expect(getEffectiveDomainModel('anthropic', 'secretary')).toBe('claude-sonnet-4-6');
      // triathlon uses 'classifier' tier → defaults to config.anthropic.classifierModel
      expect(getEffectiveDomainModel('anthropic', 'triathlon')).toBe('claude-haiku-4-5-20251001');
    });

    it('uses provider-level override when no domain override exists', () => {
      // Set a provider-level chat tier override
      setActiveModel('anthropic', 'chat', 'claude-opus-4-6');
      // secretary (chat tier) should pick up the provider override
      expect(getEffectiveDomainModel('anthropic', 'secretary')).toBe('claude-opus-4-6');
      // triathlon (classifier tier) should NOT be affected
      expect(getEffectiveDomainModel('anthropic', 'triathlon')).toBe('claude-haiku-4-5-20251001');
    });

    it('domain override takes precedence over provider-tier override', () => {
      setActiveModel('anthropic', 'chat', 'claude-opus-4-6');
      setDomainModel('anthropic', 'secretary', 'claude-haiku-4-5-20251001');
      // Domain override wins over tier override
      expect(getEffectiveDomainModel('anthropic', 'secretary')).toBe('claude-haiku-4-5-20251001');
    });

    it('independent domains can use different models', () => {
      setDomainModel('anthropic', 'secretary', 'claude-opus-4-6');
      setDomainModel('anthropic', 'triathlon', 'claude-sonnet-4-6');
      setDomainModel('anthropic', 'cooking', 'claude-haiku-4-5-20251001');

      expect(getEffectiveDomainModel('anthropic', 'secretary')).toBe('claude-opus-4-6');
      expect(getEffectiveDomainModel('anthropic', 'triathlon')).toBe('claude-sonnet-4-6');
      expect(getEffectiveDomainModel('anthropic', 'cooking')).toBe('claude-haiku-4-5-20251001');
      // finance has no override → falls to classifier tier default
      expect(getEffectiveDomainModel('anthropic', 'finance')).toBe('claude-haiku-4-5-20251001');
    });

    it('works across providers', () => {
      setDomainModel('openai', 'secretary', 'gpt-4.1');
      setDomainModel('gemini', 'content', 'gemini-2.5-pro-preview-03-25');

      expect(getEffectiveDomainModel('openai', 'secretary')).toBe('gpt-4.1');
      expect(getEffectiveDomainModel('gemini', 'content')).toBe('gemini-2.5-pro-preview-03-25');
    });
  });

  // ── loadModelOverrides ────────────────────────────────────────────

  describe('loadModelOverrides', () => {
    it('loads provider-level overrides from kv_store', () => {
      testDb.prepare(`INSERT INTO kv_store (key, value) VALUES ('model_override:openai:chat', '"gpt-4.1"')`).run();
      loadModelOverrides();
      expect(getActiveModel('openai', 'chat')).toBe('gpt-4.1');
      expect(mockConfig.openai.model).toBe('gpt-4.1');
    });

    it('loads domain-level overrides from kv_store', () => {
      testDb.prepare(`INSERT INTO kv_store (key, value) VALUES ('model_override:anthropic:triathlon', '"claude-sonnet-4-6"')`).run();
      loadModelOverrides();
      expect(getDomainModelOverride('anthropic', 'triathlon')).toBe('claude-sonnet-4-6');
    });

    it('handles empty kv_store gracefully', () => {
      expect(() => loadModelOverrides()).not.toThrow();
    });

    it('handles missing kv_store table (creates it)', () => {
      testDb.exec('DROP TABLE IF EXISTS kv_store');
      expect(() => loadModelOverrides()).not.toThrow();
    });
  });

  // ── getAllModelStates ──────────────────────────────────────────────

  describe('getAllModelStates', () => {
    it('returns all 3 providers with chat + classifier + domains', () => {
      const states = getAllModelStates();
      expect(states).toHaveLength(3);
      for (const s of states) {
        expect(s.chat).toBeDefined();
        expect(s.classifier).toBeDefined();
        expect(s.domains).toBeDefined();
        expect(Object.keys(s.domains)).toEqual(
          expect.arrayContaining(['secretary', 'triathlon', 'content', 'finance', 'cooking'])
        );
      }
    });

    it('marks provider-level overrides with source: override', () => {
      setActiveModel('anthropic', 'chat', 'claude-opus-4-6');
      const states = getAllModelStates();
      const anthropic = states.find(s => s.provider === 'anthropic')!;
      expect(anthropic.chat.source).toBe('override');
    });

    it('marks domain overrides with source: override', () => {
      setDomainModel('anthropic', 'secretary', 'claude-opus-4-6');
      const states = getAllModelStates();
      const anthropic = states.find(s => s.provider === 'anthropic')!;
      expect(anthropic.domains.secretary.source).toBe('override');
      expect(anthropic.domains.secretary.model).toBe('claude-opus-4-6');
    });

    it('marks non-overridden domains with source: tier-default', () => {
      const states = getAllModelStates();
      const anthropic = states.find(s => s.provider === 'anthropic')!;
      expect(anthropic.domains.triathlon.source).toBe('tier-default');
    });
  });

  // ── MODEL_OPTIONS + VALID_ROLES ───────────────────────────────────

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

    it('exposes the runtime OpenAI nano default in both portal pickers', () => {
      expect(MODEL_OPTIONS.openai.chat).toContain('gpt-5.4-nano');
      expect(MODEL_OPTIONS.openai.classifier).toContain('gpt-5.4-nano');
    });
  });

  describe('VALID_ROLES', () => {
    it('includes both provider and domain roles', () => {
      expect(VALID_ROLES).toContain('chat');
      expect(VALID_ROLES).toContain('classifier');
      expect(VALID_ROLES).toContain('secretary');
      expect(VALID_ROLES).toContain('triathlon');
      expect(VALID_ROLES).toContain('content');
      expect(VALID_ROLES).toContain('finance');
      expect(VALID_ROLES).toContain('cooking');
    });
  });

  describe('DOMAIN_ROLES', () => {
    it('has all 5 domains', () => {
      expect(DOMAIN_ROLES).toHaveLength(5);
    });
  });
});
