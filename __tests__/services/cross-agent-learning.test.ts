/**
 * Tests for src/services/cross-agent-learning.ts
 *
 * Validates:
 * - buildAgentContext() signal consumption and typing
 * - formatContextForPrompt() text generation
 * - produceLearningDigest() aggregation
 * - writeContentFormula() signal writing
 * - Signal type extraction functions
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

// ── Test helpers ───────────────────────────────────────────────────

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

function applyMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT DEFAULT (datetime('now'))
    )
  `);
  const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
  for (const file of files) {
    const applied = db.prepare('SELECT 1 FROM _migrations WHERE name = ?').get(file);
    if (!applied) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
      db.exec(sql);
      db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(file);
    }
  }
}

// ── Mocks ────────────────────────────────────────────────────────

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { setDbProvider, writeSignal } from '../../src/services/intelligence-bus';
import {
  buildAgentContext,
  formatContextForPrompt,
  produceLearningDigest,
  writeContentFormula,
} from '../../src/services/cross-agent-learning';

// ═══════════════════════════════════════════════════════════════════
// BUILD AGENT CONTEXT
// ═══════════════════════════════════════════════════════════════════

describe('buildAgentContext', () => {
  beforeEach(() => {
    testDb = createTestDb();
    applyMigrations(testDb);
    setDbProvider(() => testDb);
  });
  afterEach(() => { testDb.close(); });

  it('returns empty context when no signals exist', () => {
    const ctx = buildAgentContext('performance-agent');
    expect(ctx.voicePatterns).toHaveLength(0);
    expect(ctx.pillarRankings).toHaveLength(0);
    expect(ctx.signalsConsumed).toBe(0);
  });

  it('consumes voice_pattern signals for performance-agent', () => {
    writeSignal({
      source_agent: 'voice-evolution',
      signal_type: 'voice_pattern',
      payload: {
        observation: 'Felipe uses anecdotes frequently',
        patterns: [{ pattern: 'personal story', frequency: 'often' }],
        strength: 0.85,
      },
    });

    const ctx = buildAgentContext('performance-agent');
    expect(ctx.voicePatterns).toHaveLength(1);
    expect(ctx.voicePatterns[0].observation).toBe('Felipe uses anecdotes frequently');
    expect(ctx.voicePatterns[0].strength).toBe(0.85);
    expect(ctx.signalsConsumed).toBe(1);
  });

  it('consumes pillar_performance for seo-agent', () => {
    writeSignal({
      source_agent: 'performance-agent',
      signal_type: 'pillar_performance',
      payload: {
        rankings: [
          { pillar: 'fitness', avg_views: 5000, engagement_rate: 0.08, trend: 'rising' },
          { pillar: 'economics', avg_views: 3000, engagement_rate: 0.05, trend: 'stable' },
        ],
      },
    });

    const ctx = buildAgentContext('seo-agent');
    expect(ctx.pillarRankings).toHaveLength(2);
    expect(ctx.pillarRankings[0].pillar).toBe('fitness');
    expect(ctx.pillarRankings[0].trend).toBe('rising');
  });

  it('consumes hook_effectiveness for seo-agent', () => {
    writeSignal({
      source_agent: 'performance-agent',
      signal_type: 'hook_effectiveness',
      payload: {
        hook_type: 'question',
        effectiveness: 0.85,
        examples: ['Did you know...?'],
      },
    });

    const ctx = buildAgentContext('seo-agent');
    expect(ctx.hookInsights).toHaveLength(1);
    expect(ctx.hookInsights[0].hookType).toBe('question');
    expect(ctx.hookInsights[0].effectiveness).toBe(0.85);
  });

  it('consumes keyword_opportunity for pipeline-agent', () => {
    writeSignal({
      source_agent: 'seo-agent',
      signal_type: 'keyword_opportunity',
      payload: {
        keyword: 'treino híbrido',
        direction: 'up',
        volume_hint: 'high',
      },
    });

    const ctx = buildAgentContext('pipeline-agent');
    expect(ctx.keywordOpportunities).toHaveLength(1);
    expect(ctx.keywordOpportunities[0].keyword).toBe('treino híbrido');
  });

  it('consumes content_formula for all agents', () => {
    writeSignal({
      source_agent: 'performance-agent',
      signal_type: 'content_formula',
      payload: {
        formula: 'Fitness + personal story = high engagement',
        pillar: 'fitness',
        confidence: 0.9,
      },
    });

    const ctx = buildAgentContext('seo-agent');
    expect(ctx.contentFormulas).toHaveLength(1);
    expect(ctx.contentFormulas[0].formula).toContain('Fitness');
  });

  it('does not consume signals already consumed by this agent', () => {
    writeSignal({
      source_agent: 'voice-evolution',
      signal_type: 'voice_pattern',
      payload: { observation: 'test', patterns: [], strength: 0.5 },
    });

    // First call consumes it
    const ctx1 = buildAgentContext('performance-agent');
    expect(ctx1.voicePatterns).toHaveLength(1);

    // Second call finds nothing new
    const ctx2 = buildAgentContext('performance-agent');
    expect(ctx2.voicePatterns).toHaveLength(0);
  });

  it('returns empty context for unknown agent', () => {
    const ctx = buildAgentContext('unknown-agent');
    expect(ctx.signalsConsumed).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════
// FORMAT CONTEXT FOR PROMPT
// ═══════════════════════════════════════════════════════════════════

describe('formatContextForPrompt', () => {
  it('returns empty string for empty context', () => {
    const ctx = buildAgentContext('performance-agent');
    const text = formatContextForPrompt(ctx);
    expect(text).toBe('');
  });

  it('formats voice patterns when present', () => {
    const ctx = {
      voicePatterns: [{ observation: 'Uses anecdotes', patterns: [], strength: 0.8 }],
      pillarRankings: [],
      hookInsights: [],
      retentionInsights: [],
      keywordOpportunities: [],
      contentFormulas: [],
      signalsConsumed: 1,
    };
    const text = formatContextForPrompt(ctx);
    expect(text).toContain('Voice patterns');
    expect(text).toContain('Uses anecdotes');
    expect(text).toContain('80%');
  });

  it('formats pillar rankings when present', () => {
    const ctx = {
      voicePatterns: [],
      pillarRankings: [{ pillar: 'fitness', avgViews: 5000, engagementRate: 0.08, trend: 'rising' }],
      hookInsights: [],
      retentionInsights: [],
      keywordOpportunities: [],
      contentFormulas: [],
      signalsConsumed: 1,
    };
    const text = formatContextForPrompt(ctx);
    expect(text).toContain('Pillar performance');
    expect(text).toContain('fitness');
    expect(text).toContain('5000');
  });

  it('filters low-confidence voice patterns', () => {
    const ctx = {
      voicePatterns: [{ observation: 'Weak signal', patterns: [], strength: 0.3 }],
      pillarRankings: [],
      hookInsights: [],
      retentionInsights: [],
      keywordOpportunities: [],
      contentFormulas: [],
      signalsConsumed: 1,
    };
    const text = formatContextForPrompt(ctx);
    expect(text).toBe(''); // filtered out due to low strength
  });
});

// ═══════════════════════════════════════════════════════════════════
// LEARNING DIGEST
// ═══════════════════════════════════════════════════════════════════

describe('produceLearningDigest', () => {
  beforeEach(() => {
    testDb = createTestDb();
    applyMigrations(testDb);
    setDbProvider(() => testDb);
  });
  afterEach(() => { testDb.close(); });

  it('returns -1 when no signals to digest', () => {
    const id = produceLearningDigest();
    expect(id).toBe(-1);
  });

  it('produces a digest signal from peer signals', () => {
    writeSignal({
      source_agent: 'performance-agent',
      signal_type: 'pillar_performance',
      payload: {
        rankings: [{ pillar: 'fitness', avg_views: 5000, engagement_rate: 0.08, trend: 'rising' }],
      },
    });
    writeSignal({
      source_agent: 'voice-evolution',
      signal_type: 'voice_pattern',
      payload: { observation: 'Strong opener', patterns: [], strength: 0.9 },
    });

    const id = produceLearningDigest();
    expect(id).toBeGreaterThan(0);

    // Verify the digest was written
    const row = testDb.prepare('SELECT * FROM agent_signals WHERE id = ?').get(id) as any;
    expect(row.signal_type).toBe('learning_digest');
    const payload = JSON.parse(row.payload);
    expect(payload.topPillars).toHaveLength(1);
    expect(payload.voiceInsights).toHaveLength(1);
    expect(payload.summary).toContain('fitness');
  });
});

// ═══════════════════════════════════════════════════════════════════
// CONTENT FORMULA WRITER
// ═══════════════════════════════════════════════════════════════════

describe('writeContentFormula', () => {
  beforeEach(() => {
    testDb = createTestDb();
    applyMigrations(testDb);
    setDbProvider(() => testDb);
  });
  afterEach(() => { testDb.close(); });

  it('writes a content_formula signal', () => {
    const id = writeContentFormula(
      'performance-agent',
      'Fitness + anecdote = engagement',
      'fitness',
      0.85,
      '3 of top 5 videos follow this pattern',
    );
    expect(id).toBeGreaterThan(0);

    const row = testDb.prepare('SELECT * FROM agent_signals WHERE id = ?').get(id) as any;
    expect(row.signal_type).toBe('content_formula');
    const payload = JSON.parse(row.payload);
    expect(payload.formula).toContain('Fitness');
    expect(payload.confidence).toBe(0.85);
    expect(payload.pillar).toBe('fitness');
  });

  it('sets priority based on confidence', () => {
    const highId = writeContentFormula('test', 'high', 'p', 0.9, 'evidence');
    const lowId = writeContentFormula('test', 'low', 'p', 0.5, 'evidence');

    const high = testDb.prepare('SELECT priority FROM agent_signals WHERE id = ?').get(highId) as any;
    const low = testDb.prepare('SELECT priority FROM agent_signals WHERE id = ?').get(lowId) as any;

    expect(high.priority).toBe('normal');
    expect(low.priority).toBe('background');
  });
});
