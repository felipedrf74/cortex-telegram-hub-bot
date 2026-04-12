/**
 * Signal Ranking & Agent Mesh Upgrade Tests
 *
 * Covers:
 *   1. Signal schema: confidence, format_tag, pillar_tag, evidence_count
 *   2. readRankedSignals(): confidence × freshness × priority scoring
 *   3. Pillar and format filtering
 *   4. Malformed/low-confidence signal handling
 *   5. Pipeline operational metrics
 *   6. User scoping in saved ideas
 *   7. Source code structural checks
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
}));

vi.mock('../../src/config', () => ({
  config: {
    anthropic: { apiKey: 'test' },
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

// ═══════════════════════════════════════════════════════════════════
// 1. Signal Schema Upgrade
// ═══════════════════════════════════════════════════════════════════

describe('signal-ranking: schema upgrade', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
  });
  afterEach(() => testDb?.close());

  it('agent_signals table has confidence column', () => {
    const cols = testDb.prepare("PRAGMA table_info('agent_signals')").all() as any[];
    const colNames = cols.map((c: any) => c.name);
    expect(colNames).toContain('confidence');
  });

  it('agent_signals table has format_tag column', () => {
    const cols = testDb.prepare("PRAGMA table_info('agent_signals')").all() as any[];
    expect(cols.map((c: any) => c.name)).toContain('format_tag');
  });

  it('agent_signals table has pillar_tag column', () => {
    const cols = testDb.prepare("PRAGMA table_info('agent_signals')").all() as any[];
    expect(cols.map((c: any) => c.name)).toContain('pillar_tag');
  });

  it('agent_signals table has evidence_count column', () => {
    const cols = testDb.prepare("PRAGMA table_info('agent_signals')").all() as any[];
    expect(cols.map((c: any) => c.name)).toContain('evidence_count');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. writeSignal with new fields
// ═══════════════════════════════════════════════════════════════════

import { writeSignal, readRankedSignals, setDbProvider } from '../../src/services/intelligence-bus';

describe('signal-ranking: writeSignal with new fields', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
    setDbProvider(() => testDb);
  });
  afterEach(() => testDb?.close());

  it('writes signal with confidence and tags', () => {
    const id = writeSignal({
      source_agent: 'test-agent',
      signal_type: 'hook_effectiveness',
      payload: { hook: 'question opener', avgRetention: 55 },
      confidence: 0.85,
      format_tag: 'youtube',
      pillar_tag: 'tech',
      evidence_count: 12,
    });

    expect(id).toBeGreaterThan(0);

    const row = testDb.prepare('SELECT * FROM agent_signals WHERE id = ?').get(id) as any;
    expect(row.confidence).toBe(0.85);
    expect(row.format_tag).toBe('youtube');
    expect(row.pillar_tag).toBe('tech');
    expect(row.evidence_count).toBe(12);
  });

  it('defaults confidence to 0.5 when omitted', () => {
    const id = writeSignal({
      source_agent: 'test-agent',
      signal_type: 'voice_pattern',
      payload: { observation: 'test' },
    });

    const row = testDb.prepare('SELECT confidence FROM agent_signals WHERE id = ?').get(id) as any;
    expect(row.confidence).toBe(0.5);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. readRankedSignals — Relevance Scoring
// ═══════════════════════════════════════════════════════════════════

describe('signal-ranking: readRankedSignals', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
    setDbProvider(() => testDb);
  });
  afterEach(() => testDb?.close());

  it('returns signals sorted by relevanceScore DESC', () => {
    // High confidence signal
    writeSignal({
      source_agent: 'agent-a',
      signal_type: 'hook_effectiveness',
      payload: { hook: 'high confidence hook' },
      confidence: 0.95,
    });

    // Low confidence signal
    writeSignal({
      source_agent: 'agent-b',
      signal_type: 'hook_effectiveness',
      payload: { hook: 'low confidence hook' },
      confidence: 0.2,
    });

    const ranked = readRankedSignals('test-consumer', ['hook_effectiveness']);

    expect(ranked).toHaveLength(2);
    expect(ranked[0].confidence).toBe(0.95);
    expect(ranked[1].confidence).toBe(0.2);
    expect(ranked[0].relevanceScore).toBeGreaterThan(ranked[1].relevanceScore);
  });

  it('each ranked signal has relevanceScore and ageHours', () => {
    writeSignal({
      source_agent: 'test',
      signal_type: 'pillar_performance',
      payload: { pillar: 'tech' },
      confidence: 0.7,
    });

    const ranked = readRankedSignals('consumer', ['pillar_performance']);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]).toHaveProperty('relevanceScore');
    expect(ranked[0]).toHaveProperty('ageHours');
    expect(ranked[0].relevanceScore).toBeGreaterThan(0);
    expect(ranked[0].ageHours).toBeGreaterThanOrEqual(0);
  });

  it('filters by minConfidence', () => {
    writeSignal({
      source_agent: 'a',
      signal_type: 'retention_pattern',
      payload: {},
      confidence: 0.9,
    });
    writeSignal({
      source_agent: 'b',
      signal_type: 'retention_pattern',
      payload: {},
      confidence: 0.05,
    });

    const ranked = readRankedSignals('c', ['retention_pattern'], { minConfidence: 0.5 });
    expect(ranked).toHaveLength(1);
    expect(ranked[0].confidence).toBe(0.9);
  });

  it('filters by pillar (includes untagged)', () => {
    writeSignal({
      source_agent: 'a',
      signal_type: 'hook_effectiveness',
      payload: {},
      confidence: 0.8,
      pillar_tag: 'tech',
    });
    writeSignal({
      source_agent: 'b',
      signal_type: 'hook_effectiveness',
      payload: {},
      confidence: 0.7,
      pillar_tag: 'fitness',
    });
    writeSignal({
      source_agent: 'c',
      signal_type: 'hook_effectiveness',
      payload: {},
      confidence: 0.6,
      // no pillar_tag — should be included when filtering for 'tech'
    });

    const ranked = readRankedSignals('consumer', ['hook_effectiveness'], { pillar: 'tech' });
    // Should include: tech (0.8) + untagged (0.6). Excludes: fitness (0.7).
    expect(ranked).toHaveLength(2);
    expect(ranked.find((s: any) => s.pillar_tag === 'fitness')).toBeUndefined();
  });

  it('respects limit parameter', () => {
    for (let i = 0; i < 10; i++) {
      writeSignal({
        source_agent: 'bulk',
        signal_type: 'content_formula',
        payload: { idx: i },
        confidence: 0.5 + i * 0.05,
      });
    }

    const ranked = readRankedSignals('consumer', ['content_formula'], { limit: 3 });
    expect(ranked).toHaveLength(3);
    // Should be top 3 by relevance
    expect(ranked[0].confidence).toBeGreaterThanOrEqual(ranked[1].confidence);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 4. Malformed Signal Handling
// ═══════════════════════════════════════════════════════════════════

describe('signal-ranking: malformed signal handling', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
    setDbProvider(() => testDb);
  });
  afterEach(() => testDb?.close());

  it('readRankedSignals returns empty array on no matches', () => {
    const ranked = readRankedSignals('consumer', ['hook_effectiveness']);
    expect(ranked).toEqual([]);
  });

  it('signals with invalid payload JSON are handled', () => {
    // Insert signal with broken JSON directly
    testDb.prepare(`
      INSERT INTO agent_signals (source_agent, signal_type, payload, priority, expires_at, confidence)
      VALUES ('bad-agent', 'hook_effectiveness', 'not-json', 'normal', datetime('now', '+1 day'), 0.5)
    `).run();

    // readRankedSignals should not crash
    const ranked = readRankedSignals('consumer', ['hook_effectiveness']);
    // Either empty (parse failed) or contains the signal with fallback parsing
    expect(Array.isArray(ranked)).toBe(true);
  });

  it('negative confidence is stored but filtered by minConfidence', () => {
    writeSignal({
      source_agent: 'test',
      signal_type: 'voice_pattern',
      payload: {},
      confidence: -0.5,
    });

    const ranked = readRankedSignals('c', ['voice_pattern'], { minConfidence: 0.0 });
    // Signal has confidence -0.5 which is < 0.0
    expect(ranked).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 5. Pipeline Operational Metrics
// ═══════════════════════════════════════════════════════════════════

import { getPipelineOperationalMetrics } from '../../src/agents/pipeline-agent';

describe('signal-ranking: pipeline metrics', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
  });
  afterEach(() => testDb?.close());

  it('returns zero metrics on empty pipeline', () => {
    const metrics = getPipelineOperationalMetrics();
    expect(metrics.totalEverEntered).toBe(0);
    expect(metrics.totalPublished).toBe(0);
    expect(metrics.approvalToPublishRate).toBe(0);
    expect(metrics.staleInventory).toHaveLength(0);
  });

  it('computes conversion rates', () => {
    // Insert pipeline entries at various stages
    const stages = ['approved', 'scripted', 'filming', 'published', 'published'];
    for (const stage of stages) {
      testDb.prepare(`
        INSERT INTO content_pipeline (topic_title, niche, stage, stage_history)
        VALUES ('Topic ' || ?, 'tech', ?, '[]')
      `).run(stage, stage);
    }

    const metrics = getPipelineOperationalMetrics();
    expect(metrics.totalEverEntered).toBe(5);
    expect(metrics.totalPublished).toBe(2);
    expect(metrics.approvalToPublishRate).toBe(40); // 2/5 = 40%
    expect(metrics.approvalToScriptRate).toBe(80); // 4/5 (scripted+filming+published)
  });

  it('detects stale inventory', () => {
    // Insert item stuck at 'scripted' for 10 days
    testDb.prepare(`
      INSERT INTO content_pipeline (topic_title, niche, stage, stage_history, updated_at)
      VALUES ('Stuck Topic', 'fitness', 'scripted', '[]', datetime('now', '-10 days'))
    `).run();

    const metrics = getPipelineOperationalMetrics();
    expect(metrics.staleInventory).toHaveLength(1);
    expect(metrics.staleInventory[0].title).toBe('Stuck Topic');
    expect(metrics.staleInventory[0].daysStuck).toBeGreaterThanOrEqual(9);
  });

  it('computes weekly throughput', () => {
    // Insert a published item from 2 days ago
    testDb.prepare(`
      INSERT INTO content_pipeline (topic_title, stage, stage_history, updated_at)
      VALUES ('Recent Pub', 'published', '[]', datetime('now', '-2 days'))
    `).run();

    const metrics = getPipelineOperationalMetrics();
    // The most recent week (weeklyThroughput[3]) should have 1
    expect(metrics.weeklyThroughput).toHaveLength(4);
    expect(metrics.weeklyThroughput[3]).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 6. Workflow Scoping
// ═══════════════════════════════════════════════════════════════════

describe('signal-ranking: workflow scoping', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
  });
  afterEach(() => testDb?.close());

  it('getWorkflowEligibleIdeas accepts userId parameter', async () => {
    const { getWorkflowEligibleIdeas } = await import('../../src/state/saved-ideas');
    // Should not throw with userId parameter
    const ideas = getWorkflowEligibleIdeas(1);
    expect(Array.isArray(ideas)).toBe(true);
  });

  it('getWorkflowEligibleIdeas scopes by userId when provided', async () => {
    // Insert ideas for two different users
    testDb.prepare(`
      INSERT INTO saved_ideas (title, source_date, status, source, score, workflow_eligible, user_id)
      VALUES ('User 1 Idea', date('now'), 'saved', 'discovery', 90, 1, 1)
    `).run();
    testDb.prepare(`
      INSERT INTO saved_ideas (title, source_date, status, source, score, workflow_eligible, user_id)
      VALUES ('User 2 Idea', date('now'), 'saved', 'discovery', 85, 1, 2)
    `).run();

    const { getWorkflowEligibleIdeas } = await import('../../src/state/saved-ideas');

    const user1Ideas = getWorkflowEligibleIdeas(1);
    const user2Ideas = getWorkflowEligibleIdeas(2);

    expect(user1Ideas).toHaveLength(1);
    expect(user1Ideas[0].title).toBe('User 1 Idea');
    expect(user2Ideas).toHaveLength(1);
    expect(user2Ideas[0].title).toBe('User 2 Idea');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 7. Structural Checks
// ═══════════════════════════════════════════════════════════════════

describe('signal-ranking: structural', () => {
  it('readRankedSignals is exported from intelligence-bus', async () => {
    const bus = await import('../../src/services/intelligence-bus');
    expect(bus.readRankedSignals).toBeDefined();
    expect(typeof bus.readRankedSignals).toBe('function');
  });

  it('RankedSignal type has relevanceScore field', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../src/services/intelligence-bus.ts'),
      'utf8',
    );
    expect(source).toContain('interface RankedSignal');
    expect(source).toContain('relevanceScore: number');
    expect(source).toContain('ageHours: number');
  });

  it('getPipelineOperationalMetrics is exported from pipeline-agent', async () => {
    const agent = await import('../../src/agents/pipeline-agent');
    expect(agent.getPipelineOperationalMetrics).toBeDefined();
    expect(typeof agent.getPipelineOperationalMetrics).toBe('function');
  });

  it('portal has /api/pipeline/metrics endpoint', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../src/portal/server.ts'),
      'utf8',
    );
    expect(source).toContain("'/api/pipeline/metrics'");
    expect(source).toContain('getPipelineOperationalMetrics');
  });

  it('portal has /api/signals/ranked endpoint', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../src/portal/server.ts'),
      'utf8',
    );
    expect(source).toContain("'/api/signals/ranked'");
    expect(source).toContain('readRankedSignals');
  });

  it('migration 060 adds ranking columns', () => {
    const migration = fs.readFileSync(
      path.resolve(__dirname, '../../migrations/060_signal_ranking.sql'),
      'utf8',
    );
    expect(migration).toContain('ADD COLUMN confidence');
    expect(migration).toContain('ADD COLUMN format_tag');
    expect(migration).toContain('ADD COLUMN pillar_tag');
    expect(migration).toContain('ADD COLUMN evidence_count');
  });
});
