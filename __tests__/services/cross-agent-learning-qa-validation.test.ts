/**
 * QA Validation Tests — Cross-Agent Learning v2
 *
 * Validates cross-agent learning service edge cases, signal consumption maps,
 * prompt formatting boundaries, content formula writing, and agent integration.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

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
    .filter(f => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
    db.exec(sql);
    db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
  }
}

let testDb: Database.Database;
vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
}));
vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
}));

import { writeSignal, readSignals, markConsumed, setDbProvider } from '../../src/services/intelligence-bus';
import {
  buildAgentContext,
  formatContextForPrompt,
  produceLearningDigest,
  writeContentFormula,
  type AgentContext,
} from '../../src/services/cross-agent-learning';

describe('Cross-Agent Learning — QA Validation', () => {
  beforeEach(() => {
    testDb = createTestDb();
    applyMigrations(testDb);
    setDbProvider(() => testDb);
  });

  afterEach(() => {
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

    it('unknown agent type returns empty context without error', () => {
      const ctx = buildAgentContext('nonexistent-agent');
      expect(ctx.signalsConsumed).toBe(0);
      expect(ctx.voicePatterns).toEqual([]);
    });

    it('performance-agent consumes voice_pattern signals', () => {
      writeSignal({
        source_agent: 'voice-evolution',
        signal_type: 'voice_pattern',
        payload: { observation: 'Direct tone works', patterns: [{ pattern: 'imperative', frequency: 'high' }], strength: 0.8 },
        priority: 'normal',
      });

      const ctx = buildAgentContext('performance-agent');
      expect(ctx.signalsConsumed).toBe(1);
      expect(ctx.voicePatterns.length).toBe(1);
      expect(ctx.voicePatterns[0].observation).toBe('Direct tone works');
    });

    it('seo-agent consumes retention_pattern and hook_effectiveness', () => {
      writeSignal({
        source_agent: 'performance-agent',
        signal_type: 'retention_pattern',
        payload: { pattern: 'Quick intro', impact: 'positive', avg_retention: 0.65 },
        priority: 'normal',
      });
      writeSignal({
        source_agent: 'performance-agent',
        signal_type: 'hook_effectiveness',
        payload: { hook_type: 'question', effectiveness: 0.8, examples: ['Did you know...'] },
        priority: 'normal',
      });

      const ctx = buildAgentContext('seo-agent');
      expect(ctx.signalsConsumed).toBe(2);
      expect(ctx.retentionInsights.length).toBe(1);
      expect(ctx.hookInsights.length).toBe(1);
    });

    it('pipeline-agent consumes keyword_opportunity signals', () => {
      writeSignal({
        source_agent: 'seo-agent',
        signal_type: 'keyword_opportunity',
        payload: { keyword: 'AI tools 2024', direction: 'up', volume_hint: 'high' },
        priority: 'normal',
      });

      const ctx = buildAgentContext('pipeline-agent');
      expect(ctx.keywordOpportunities.length).toBe(1);
      expect(ctx.keywordOpportunities[0].keyword).toBe('AI tools 2024');
    });
  });

  // ── Signal Extraction Edge Cases ────────────────────────────────

  describe('signal extraction edge cases', () => {
    it('handles voice_pattern with missing fields gracefully', () => {
      writeSignal({
        source_agent: 'voice-evolution',
        signal_type: 'voice_pattern',
        payload: {}, // no observation, no patterns, no strength
        priority: 'normal',
      });

      const ctx = buildAgentContext('performance-agent');
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
    it('returns empty string for empty context', () => {
      const ctx = buildAgentContext('nonexistent-agent');
      const text = formatContextForPrompt(ctx);
      expect(text).toBe('');
    });

    it('filters out low-strength voice patterns (< 0.5)', () => {
      writeSignal({
        source_agent: 'voice-evolution',
        signal_type: 'voice_pattern',
        payload: { observation: 'Weak signal', strength: 0.3 },
        priority: 'normal',
      });
      writeSignal({
        source_agent: 'voice-evolution',
        signal_type: 'voice_pattern',
        payload: { observation: 'Strong signal', strength: 0.8 },
        priority: 'normal',
      });

      const ctx = buildAgentContext('performance-agent');
      const text = formatContextForPrompt(ctx);
      expect(text).toContain('Strong signal');
      expect(text).not.toContain('Weak signal');
    });

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
        payload: { observation: 'Direct style', strength: 0.9 },
        priority: 'normal',
      });
      writeSignal({
        source_agent: 'performance-agent',
        signal_type: 'pillar_performance',
        payload: { rankings: [{ pillar: 'AI', avg_views: 10000, engagement_rate: 0.1, trend: 'up' }] },
        priority: 'normal',
      });

      const ctx = buildAgentContext('reaction-radar');
      const text = formatContextForPrompt(ctx);
      expect(text).toContain('Cross-Agent Learnings');
      expect(text).toContain('Voice patterns');
      expect(text).toContain('Pillar performance');
    });
  });

  // ── Content Formula Writer ──────────────────────────────────────

  describe('writeContentFormula', () => {
    it('writes a content_formula signal', () => {
      const id = writeContentFormula(
        'performance-agent',
        'Tutorial + personal anecdote',
        'AI',
        0.85,
        'Top 3 videos use this pattern',
      );
      expect(id).toBeGreaterThan(0);

      // Should be readable by agents that consume content_formula
      const ctx = buildAgentContext('seo-agent');
      expect(ctx.contentFormulas.length).toBe(1);
      expect(ctx.contentFormulas[0].formula).toBe('Tutorial + personal anecdote');
      expect(ctx.contentFormulas[0].confidence).toBe(0.85);
    });

    it('high confidence formulas get normal priority', () => {
      const id = writeContentFormula('test', 'formula', 'AI', 0.9, 'evidence');
      const signals = readSignals('test-reader', ['content_formula'], 10);
      const signal = signals.find(s => s.id === id);
      expect(signal?.priority).toBe('normal');
    });

    it('low confidence formulas get background priority', () => {
      const id = writeContentFormula('test', 'formula', 'AI', 0.5, 'evidence');
      const signals = readSignals('test-reader', ['content_formula'], 10);
      const signal = signals.find(s => s.id === id);
      expect(signal?.priority).toBe('background');
    });
  });

  // ── Learning Digest ─────────────────────────────────────────────

  describe('produceLearningDigest', () => {
    it('returns -1 when no signals exist', () => {
      const id = produceLearningDigest();
      expect(id).toBe(-1);
    });

    it('produces digest from available signals', () => {
      writeSignal({
        source_agent: 'performance-agent',
        signal_type: 'pillar_performance',
        payload: { rankings: [{ pillar: 'AI', avg_views: 10000, engagement_rate: 0.1, trend: 'up' }] },
        priority: 'normal',
      });
      writeSignal({
        source_agent: 'voice-evolution',
        signal_type: 'voice_pattern',
        payload: { observation: 'Confident tone', strength: 0.9 },
        priority: 'normal',
      });

      const id = produceLearningDigest();
      expect(id).toBeGreaterThan(0);

      // The digest should be readable
      const digestSignals = readSignals('digest-reader', ['learning_digest'], 10);
      expect(digestSignals.length).toBe(1);
      const payload = digestSignals[0].payload;
      expect(payload.topPillars.length).toBe(1);
      expect(payload.voiceInsights.length).toBe(1);
      expect(payload.summary).toContain('AI');
    });

    it('filters low-strength voice patterns from digest', () => {
      writeSignal({
        source_agent: 'voice-evolution',
        signal_type: 'voice_pattern',
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
    it('consumed signals are not returned to the same agent again', () => {
      writeSignal({
        source_agent: 'voice-evolution',
        signal_type: 'voice_pattern',
        payload: { observation: 'Test', strength: 0.9 },
        priority: 'normal',
      });

      // First read consumes the signal
      const ctx1 = buildAgentContext('performance-agent');
      expect(ctx1.signalsConsumed).toBe(1);

      // Second read should find nothing new
      const ctx2 = buildAgentContext('performance-agent');
      expect(ctx2.signalsConsumed).toBe(0);
    });

    it('different agents can consume the same signal independently', () => {
      writeSignal({
        source_agent: 'voice-evolution',
        signal_type: 'voice_pattern',
        payload: { observation: 'Test', strength: 0.9 },
        priority: 'normal',
      });

      const ctx1 = buildAgentContext('performance-agent');
      expect(ctx1.signalsConsumed).toBe(1);

      // reaction-radar should also consume voice_pattern
      const ctx2 = buildAgentContext('reaction-radar');
      expect(ctx2.signalsConsumed).toBe(1);
    });
  });

  // ── Agent Integration Verification ──────────────────────────────

  describe('agent file integration', () => {
    it('performance-agent imports cross-agent-learning', async () => {
      const content = fs.readFileSync(
        path.resolve(__dirname, '../../src/agents/performance-agent.ts'), 'utf-8'
      );
      expect(content).toContain('cross-agent-learning');
      expect(content).toContain('buildAgentContext');
    });

    it('seo-agent imports cross-agent-learning', async () => {
      const content = fs.readFileSync(
        path.resolve(__dirname, '../../src/agents/seo-agent.ts'), 'utf-8'
      );
      expect(content).toContain('cross-agent-learning');
    });

    it('reaction-radar-agent imports cross-agent-learning', async () => {
      const content = fs.readFileSync(
        path.resolve(__dirname, '../../src/agents/reaction-radar-agent.ts'), 'utf-8'
      );
      expect(content).toContain('cross-agent-learning');
    });

    it('pipeline-agent imports cross-agent-learning', async () => {
      const content = fs.readFileSync(
        path.resolve(__dirname, '../../src/agents/pipeline-agent.ts'), 'utf-8'
      );
      expect(content).toContain('cross-agent-learning');
    });

    it('voice-evolution-agent imports cross-agent-learning', async () => {
      const content = fs.readFileSync(
        path.resolve(__dirname, '../../src/agents/voice-evolution-agent.ts'), 'utf-8'
      );
      expect(content).toContain('cross-agent-learning');
    });
  });
});
