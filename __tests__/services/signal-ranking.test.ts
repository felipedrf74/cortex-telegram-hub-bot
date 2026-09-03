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
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import { createMigratedDatabaseWithLegacySavedIdeas } from '../helpers/legacy-saved-ideas-fixture';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import {
  writeSignal,
  readRankedSignals,
  setDbProvider,
  setPlanningInvalidator,
} from '../../src/services/intelligence-bus';
import { getPipelineOperationalMetrics } from '../../src/agents/pipeline-agent';

let testDb: Database.Database;
const CONTENT_SCOPE = { tenantId: 42, userId: 42 };

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

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
  LOGGER_REDACTION_PATHS: [],
}));

vi.mock('../../src/config', () => ({
  config: {
    anthropic: { apiKey: 'test' },
    app: { timezone: 'Europe/Lisbon' },
    garmin: { tokenPath: '/tmp' },
  },
}));


// ═══════════════════════════════════════════════════════════════════
// 1. Signal Schema Upgrade
// ═══════════════════════════════════════════════════════════════════

describe('signal-ranking: schema upgrade', () => {
  beforeEach(() => {
    testDb = createMigratedTestDatabase();
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

  it('agent_signals table has mesh_priority column', () => {
    const cols = testDb.prepare("PRAGMA table_info('agent_signals')").all() as any[];
    expect(cols.map((c: any) => c.name)).toContain('mesh_priority');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. writeSignal with new fields
// ═══════════════════════════════════════════════════════════════════

describe('signal-ranking: writeSignal with new fields', () => {
  beforeEach(() => {
    testDb = createMigratedTestDatabase();
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
      user_id: 42,
      tenant_id: 42,
      payload: { observation: 'test' },
    });

    const row = testDb.prepare('SELECT confidence FROM agent_signals WHERE id = ?').get(id) as any;
    expect(row.confidence).toBe(0.5);
  });

  it('writes meshPriority and invalidates plan caches for priority-1 signals', () => {
    const planningInvalidations: Array<number | undefined> = [];
    setPlanningInvalidator((userId) => planningInvalidations.push(userId));

    const id = writeSignal({
      source_agent: 'mesh-agent',
      signal_type: 'tax_deadline',
      payload: { dueAt: '2026-04-28T12:00:00Z' },
      meshPriority: 1,
      user_id: 42,
    });

    const row = testDb.prepare('SELECT mesh_priority FROM agent_signals WHERE id = ?').get(id) as any;
    expect(row.mesh_priority).toBe(1);
    expect(planningInvalidations).toEqual([42]);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. readRankedSignals — Relevance Scoring
// ═══════════════════════════════════════════════════════════════════

describe('signal-ranking: readRankedSignals', () => {
  beforeEach(() => {
    testDb = createMigratedTestDatabase();
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
    testDb = createMigratedTestDatabase();
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

describe('signal-ranking: pipeline metrics', () => {
  beforeEach(() => {
    testDb = createMigratedTestDatabase();
  });
  afterEach(() => testDb?.close());

  it('returns unavailable publication metrics on an empty pipeline', () => {
    const metrics = getPipelineOperationalMetrics(CONTENT_SCOPE);
    expect(metrics.totalEverEntered).toBe(0);
    expect(metrics.totalPublished).toBeNull();
    expect(metrics.approvalToPublishRate).toBeNull();
    expect(metrics.publicationTracking.reasonCode).toBe('CONTENT_PUBLICATION_TRACKING_NOT_SUPPORTED');
    expect(metrics.staleInventory).toHaveLength(0);
  });

  it('computes script conversion without inventing a publication conversion rate', () => {
    // Insert pipeline entries at various stages
    seedWorkspaceMetricItem('Approved', 'active', 'idea');
    seedWorkspaceMetricItem('Scripted', 'active', 'draft');
    seedWorkspaceMetricItem('Filming compatibility', 'active', 'draft');
    const publishedA = seedWorkspaceMetricItem('Published A', 'published', 'final');
    const publishedB = seedWorkspaceMetricItem('Published B', 'published', 'final');
    seedWorkspacePublishEvent(publishedA, '-2 days');
    seedWorkspacePublishEvent(publishedB, '-8 days');

    const metrics = getPipelineOperationalMetrics(CONTENT_SCOPE);
    expect(metrics.totalEverEntered).toBe(5);
    expect(metrics.totalPublished).toBeNull();
    expect(metrics.approvalToPublishRate).toBeNull();
    expect(metrics.approvalToScriptRate).toBe(80); // 4/5 (scripted+filming+published)
  });

  it('detects stale inventory', () => {
    // Insert item stuck at 'scripted' for 10 days
    seedWorkspaceMetricItem('Stuck Topic', 'active', 'draft', '-10 days');

    const metrics = getPipelineOperationalMetrics(CONTENT_SCOPE);
    expect(metrics.staleInventory).toHaveLength(1);
    expect(metrics.staleInventory[0].title).toBe('Stuck Topic');
    expect(metrics.staleInventory[0].daysStuck).toBeGreaterThanOrEqual(9);
  });

  it('keeps weekly publication throughput unavailable without receipts', () => {
    // Insert a published item from 2 days ago
    const itemId = seedWorkspaceMetricItem('Recent Pub', 'published', 'final', '-2 days');
    seedWorkspacePublishEvent(itemId, '-2 days');

    const metrics = getPipelineOperationalMetrics(CONTENT_SCOPE);
    expect(metrics.weeklyThroughput).toBeNull();
    expect(metrics.publicationTracking.availability).toBe('unavailable');
  });
});

function seedWorkspaceMetricItem(
  title: string,
  productionState: string,
  artifactPhase: string,
  updatedOffset = '0 days',
): number {
  return Number(testDb.prepare(`
    INSERT INTO content_domain_objects (
      tenant_id, owner_user_id, visibility_scope, scope_status,
      object_type, lifecycle_state, title, production_state, artifact_phase,
      format_id, created_by, updated_by, created_at, updated_at
    ) VALUES (?, ?, 'user_private', 'active', 'content_item', ?, ?, ?, ?,
      'video', ?, ?, datetime('now', ?), datetime('now', ?))
  `).run(
    CONTENT_SCOPE.tenantId,
    CONTENT_SCOPE.userId,
    productionState,
    title,
    productionState,
    artifactPhase,
    CONTENT_SCOPE.userId,
    CONTENT_SCOPE.userId,
    updatedOffset,
    updatedOffset,
  ).lastInsertRowid);
}

function seedWorkspacePublishEvent(itemId: number, offset: string): void {
  testDb.prepare(`
    INSERT INTO content_workflow_events (
      tenant_id, owner_user_id, visibility_scope, scope_status,
      object_type, object_id, action, from_state, to_state,
      actor_user_id, created_at
    ) VALUES (?, ?, 'user_private', 'active', 'content_item', ?,
      'workspace_state_changed', 'approved', 'published', ?, datetime('now', ?))
  `).run(CONTENT_SCOPE.tenantId, CONTENT_SCOPE.userId, String(itemId), CONTENT_SCOPE.userId, offset);
}

// ═══════════════════════════════════════════════════════════════════
// 6. Workflow Scoping
// ═══════════════════════════════════════════════════════════════════

describe('signal-ranking: workflow scoping', () => {
  beforeEach(() => {
    testDb = createMigratedTestDatabase();
  });
  afterEach(() => testDb?.close());

  it('getWorkflowEligibleIdeas accepts userId parameter', async () => {
    const { getWorkflowEligibleIdeas } = await import('../../src/state/saved-ideas');
    // Should not throw with userId parameter
    const ideas = getWorkflowEligibleIdeas(1);
    expect(Array.isArray(ideas)).toBe(true);
  });

  it('getWorkflowEligibleIdeas scopes by userId when provided', async () => {
    testDb.close();
    testDb = createMigratedDatabaseWithLegacySavedIdeas((database) => {
      database.prepare(`
        INSERT INTO saved_ideas (title, source_date, status, source, score, workflow_eligible, user_id)
        VALUES ('User 1 Idea', date('now'), 'saved', 'discovery', 90, 1, 1)
      `).run();
      database.prepare(`
        INSERT INTO saved_ideas (title, source_date, status, source, score, workflow_eligible, user_id)
        VALUES ('User 2 Idea', date('now'), 'saved', 'discovery', 85, 1, 2)
      `).run();
    });

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
      path.resolve(__dirname, '../../src/portal/intelligence-routes.ts'),
      'utf8',
    );
    expect(source).toContain("'/api/pipeline/metrics'");
    expect(source).toContain('getPipelineOperationalMetrics');
  });

  it('portal has /api/signals/ranked endpoint', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../src/portal/intelligence-routes.ts'),
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
