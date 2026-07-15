/**
 * QA Validation Tests — Cross-Agent Learning v2
 *
 * Validates cross-agent learning service edge cases, signal consumption maps,
 * prompt formatting boundaries, content formula writing, and agent integration.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import Database from 'better-sqlite3';

const TEST_USER_ID = 42;
const TEST_TENANT_ID = 42;

let testDb: Database.Database;
vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
  LOGGER_REDACTION_PATHS: [],
}));
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

import { writeSignal, readSignals, setDbProvider } from '../../src/services/intelligence-bus';
import {
  buildAgentContext,
  formatContextForPrompt,
  produceLearningDigest,
} from '../../src/services/cross-agent-learning';

describe('Cross-Agent Learning — QA Validation', () => {
  beforeAll(() => {
    testDb = createMigratedTestDatabase();
    setDbProvider(() => testDb);
  });

  beforeEach(() => {
    testDb.exec('SAVEPOINT qa_test_case');
  });

  afterEach(() => {
    testDb.exec('ROLLBACK TO qa_test_case');
    testDb.exec('RELEASE qa_test_case');
  });

  afterAll(() => {
    testDb.close();
  });

  // ── Agent Peer Signal Map Validation ────────────────────────────

  describe('agent peer signal consumption maps', () => {
    it('each known agent type returns a non-empty context structure', () => {
      const agents = ['performance-agent', 'seo-agent', 'reaction-radar', 'voice-evolution', 'pipeline-agent'];
      for (const agent of agents) {
        const ctx = buildAgentContext(agent);
        expect(ctx).toBeDefined();
        expect(ctx.signalsConsumed).toBe(0); // no signals inserted yet
        expect(ctx.voicePatterns).toEqual([]);
        expect(ctx.pillarRankings).toEqual([]);
      }
    });

  });

  // ── Signal Extraction Edge Cases ────────────────────────────────

  describe('signal extraction edge cases', () => {
    it('handles voice_pattern with missing fields gracefully', () => {
      writeSignal({
        source_agent: 'voice-evolution',
        signal_type: 'voice_pattern',
        user_id: TEST_USER_ID,
        tenant_id: TEST_TENANT_ID,
        payload: {}, // no observation, no patterns, no strength
        priority: 'normal',
      });

      const ctx = buildAgentContext('performance-agent', TEST_USER_ID, TEST_TENANT_ID);
      expect(ctx.voicePatterns.length).toBe(1);
      expect(ctx.voicePatterns[0].observation).toBe('');
      expect(ctx.voicePatterns[0].patterns).toEqual([]);
      expect(ctx.voicePatterns[0].strength).toBe(0.5); // default
    });

    it('handles pillar_performance with non-array rankings', () => {
      writeSignal({
        source_agent: 'performance-agent',
        signal_type: 'pillar_performance',
        payload: { rankings: 'not an array' }, // malformed
        priority: 'normal',
      });

      const ctx = buildAgentContext('seo-agent');
      // Should not throw, pillarRankings should be empty
      expect(ctx.pillarRankings).toEqual([]);
    });

    it('extracts multiple pillar rankings from one signal', () => {
      writeSignal({
        source_agent: 'performance-agent',
        signal_type: 'pillar_performance',
        payload: {
          rankings: [
            { pillar: 'AI', avg_views: 10000, engagement_rate: 0.08, trend: 'up' },
            { pillar: 'Fitness', avg_views: 5000, engagement_rate: 0.12, trend: 'stable' },
            { pillar: 'Coding', avg_views: 7500, engagement_rate: 0.06, trend: 'down' },
          ],
        },
        priority: 'normal',
      });

      const ctx = buildAgentContext('seo-agent');
      expect(ctx.pillarRankings.length).toBe(3);
      expect(ctx.pillarRankings[0].pillar).toBe('AI');
      expect(ctx.pillarRankings[1].engagementRate).toBe(0.12);
    });
  });

  // ── Prompt Formatting ───────────────────────────────────────────

  describe('formatContextForPrompt', () => {
    it('filters out stable keywords', () => {
      writeSignal({
        source_agent: 'seo-agent',
        signal_type: 'keyword_opportunity',
        payload: { keyword: 'trending topic', direction: 'up', volume_hint: 'high' },
        priority: 'normal',
      });
      writeSignal({
        source_agent: 'seo-agent',
        signal_type: 'keyword_opportunity',
        payload: { keyword: 'stable topic', direction: 'stable', volume_hint: 'medium' },
        priority: 'normal',
      });

      const ctx = buildAgentContext('pipeline-agent');
      const text = formatContextForPrompt(ctx);
      expect(text).toContain('trending topic');
      expect(text).not.toContain('stable topic');
    });

    it('filters out low-confidence content formulas (< 0.6)', () => {
      writeSignal({
        source_agent: 'performance-agent',
        signal_type: 'content_formula',
        payload: { formula: 'Low confidence', pillar: 'AI', confidence: 0.4 },
        priority: 'normal',
      });
      writeSignal({
        source_agent: 'performance-agent',
        signal_type: 'content_formula',
        payload: { formula: 'High confidence', pillar: 'AI', confidence: 0.9 },
        priority: 'normal',
      });

      const ctx = buildAgentContext('seo-agent');
      const text = formatContextForPrompt(ctx);
      expect(text).toContain('High confidence');
      expect(text).not.toContain('Low confidence');
    });

    it('includes section headers in formatted output', () => {
      writeSignal({
        source_agent: 'voice-evolution',
        signal_type: 'voice_pattern',
        user_id: TEST_USER_ID,
        tenant_id: TEST_TENANT_ID,
        payload: { observation: 'Direct style', strength: 0.9 },
        priority: 'normal',
      });
      writeSignal({
        source_agent: 'performance-agent',
        signal_type: 'pillar_performance',
        payload: { rankings: [{ pillar: 'AI', avg_views: 10000, engagement_rate: 0.1, trend: 'up' }] },
        priority: 'normal',
      });

      const ctx = buildAgentContext('reaction-radar', TEST_USER_ID, TEST_TENANT_ID);
      const text = formatContextForPrompt(ctx);
      expect(text).toContain('Cross-Agent Learnings');
      expect(text).toContain('Voice patterns');
      expect(text).toContain('Pillar performance');
    });
  });

  // ── Learning Digest ─────────────────────────────────────────────

  describe('produceLearningDigest', () => {
    it('filters low-strength voice patterns from digest', () => {
      writeSignal({
        source_agent: 'voice-evolution',
        signal_type: 'voice_pattern',
        user_id: TEST_USER_ID,
        tenant_id: TEST_TENANT_ID,
        payload: { observation: 'Weak', strength: 0.4 },
        priority: 'normal',
      });
      writeSignal({
        source_agent: 'performance-agent',
        signal_type: 'pillar_performance',
        payload: { rankings: [{ pillar: 'AI', avg_views: 5000, engagement_rate: 0.05, trend: 'stable' }] },
        priority: 'normal',
      });

      const id = produceLearningDigest();
      expect(id).toBeGreaterThan(0);

      const digestSignals = readSignals('digest-reader', ['learning_digest'], 10);
      expect(digestSignals[0].payload.voiceInsights.length).toBe(0);
    });
  });

  // ── markConsumed Integration ────────────────────────────────────

  describe('signal consumption tracking', () => {
    it('different agents can consume the same signal independently', () => {
      writeSignal({
        source_agent: 'voice-evolution',
        signal_type: 'voice_pattern',
        user_id: TEST_USER_ID,
        tenant_id: TEST_TENANT_ID,
        payload: { observation: 'Test', strength: 0.9 },
        priority: 'normal',
      });

      const ctx1 = buildAgentContext('performance-agent', TEST_USER_ID, TEST_TENANT_ID);
      expect(ctx1.signalsConsumed).toBe(1);

      // reaction-radar should also consume voice_pattern
      const ctx2 = buildAgentContext('reaction-radar', TEST_USER_ID, TEST_TENANT_ID);
      expect(ctx2.signalsConsumed).toBe(1);
    });
  });

});
