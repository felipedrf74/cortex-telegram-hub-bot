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
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import Database from 'better-sqlite3';
const TEST_USER_ID = 42;
const TEST_TENANT_ID = 4200;

// ── Test helpers ───────────────────────────────────────────────────

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}


// ── Mocks ────────────────────────────────────────────────────────

let testDb: Database.Database;

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
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

import { readSignals, setDbProvider, writeSignal } from '../../src/services/intelligence-bus';
import {
  buildAgentContext,
  formatContextForPrompt,
  produceLearningDigest,
  writeContentFormula,
} from '../../src/services/cross-agent-learning';
import * as crossAgentLearningFacade from '../../src/services/cross-agent-learning';
import * as signalLearningAdapter from '../../src/services/cross-agent-learning/signal-learning';
import * as trainingMeshAdapter from '../../src/services/cross-agent-learning/training-mesh-context';
import * as cookingMeshAdapter from '../../src/services/cross-agent-learning/cooking-mesh-context';
import * as contentMeshAdapter from '../../src/services/cross-agent-learning/content-mesh-context';
import * as secretaryMeshAdapter from '../../src/services/cross-agent-learning/secretary-mesh-context';
import * as financeMeshAdapter from '../../src/services/cross-agent-learning/finance-mesh-context';

describe('cross-agent-learning compatibility facade', () => {
  it('re-exports each deterministic adapter without wrapping or changing identity', () => {
    expect(crossAgentLearningFacade.buildAgentContext).toBe(signalLearningAdapter.buildAgentContext);
    expect(crossAgentLearningFacade.formatContextForPrompt).toBe(signalLearningAdapter.formatContextForPrompt);
    expect(crossAgentLearningFacade.produceLearningDigest).toBe(signalLearningAdapter.produceLearningDigest);
    expect(crossAgentLearningFacade.writeContentFormula).toBe(signalLearningAdapter.writeContentFormula);
    expect(crossAgentLearningFacade.readTrainingMeshContext).toBe(trainingMeshAdapter.readTrainingMeshContext);
    expect(crossAgentLearningFacade.readCookingMeshContext).toBe(cookingMeshAdapter.readCookingMeshContext);
    expect(crossAgentLearningFacade.readContentMeshContext).toBe(contentMeshAdapter.readContentMeshContext);
    expect(crossAgentLearningFacade.readSecretaryMeshContext).toBe(secretaryMeshAdapter.readSecretaryMeshContext);
    expect(crossAgentLearningFacade.readFinanceMeshContext).toBe(financeMeshAdapter.readFinanceMeshContext);
  });
});

// ═══════════════════════════════════════════════════════════════════
// BUILD AGENT CONTEXT
// ═══════════════════════════════════════════════════════════════════

describe('buildAgentContext', () => {
  beforeEach(() => {
    testDb = createMigratedTestDatabase();
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
      user_id: TEST_USER_ID,
      tenant_id: TEST_TENANT_ID,
      payload: {
        observation: 'Felipe uses anecdotes frequently',
        patterns: [{ pattern: 'personal story', frequency: 'often' }],
        strength: 0.85,
      },
    });

    const ctx = buildAgentContext('performance-agent', TEST_USER_ID, TEST_TENANT_ID);
    expect(ctx.voicePatterns).toHaveLength(1);
    expect(ctx.voicePatterns[0].observation).toBe('Felipe uses anecdotes frequently');
    expect(ctx.voicePatterns[0].strength).toBe(0.85);
    expect(ctx.signalsConsumed).toBe(1);
  });

  it('does not aggregate peer signals from another tenant for the same user', () => {
    writeSignal({
      source_agent: 'voice-evolution',
      signal_type: 'voice_pattern',
      user_id: TEST_USER_ID,
      tenant_id: TEST_TENANT_ID,
      payload: { observation: 'owner tenant', patterns: [], strength: 0.9 },
    });
    writeSignal({
      source_agent: 'voice-evolution',
      signal_type: 'voice_pattern',
      user_id: TEST_USER_ID,
      tenant_id: TEST_TENANT_ID + 1,
      payload: { observation: 'other tenant', patterns: [], strength: 0.9 },
    });

    const owner = buildAgentContext('performance-agent', TEST_USER_ID, TEST_TENANT_ID);
    expect(owner.voicePatterns.map((voice) => voice.observation)).toEqual(['owner tenant']);

    const other = buildAgentContext('performance-agent', TEST_USER_ID, TEST_TENANT_ID + 1);
    expect(other.voicePatterns.map((voice) => voice.observation)).toEqual(['other tenant']);
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
      user_id: TEST_USER_ID,
      tenant_id: TEST_TENANT_ID,
      payload: { observation: 'test', patterns: [], strength: 0.5 },
    });

    // First call consumes it
    const ctx1 = buildAgentContext('performance-agent', TEST_USER_ID, TEST_TENANT_ID);
    expect(ctx1.voicePatterns).toHaveLength(1);

    // Second call finds nothing new
    const ctx2 = buildAgentContext('performance-agent', TEST_USER_ID, TEST_TENANT_ID);
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
    testDb = createMigratedTestDatabase();
    setDbProvider(() => testDb);
  });
  afterEach(() => { testDb.close(); });

  it('returns -1 when no signals to digest', () => {
    const id = produceLearningDigest();
    expect(id).toBe(-1);
  });

  it('keeps a creator digest private within a shared tenant', () => {
    const pillarSignalId = writeSignal({
      source_agent: 'performance-agent',
      signal_type: 'pillar_performance',
      payload: {
        rankings: [{ pillar: 'fitness', avg_views: 5000, engagement_rate: 0.08, trend: 'rising' }],
      },
    });
    writeSignal({
      source_agent: 'voice-evolution',
      signal_type: 'voice_pattern',
      user_id: TEST_USER_ID,
      tenant_id: TEST_TENANT_ID,
      payload: { observation: 'Strong opener', patterns: [], strength: 0.9 },
    });

    const id = produceLearningDigest(TEST_USER_ID, TEST_TENANT_ID);
    expect(id).toBeGreaterThan(0);

    // Verify the digest was written
    const row = testDb.prepare('SELECT * FROM agent_signals WHERE id = ?').get(id) as any;
    expect(row.signal_type).toBe('creator_learning_digest');
    expect(row.tenant_id).toBe(TEST_TENANT_ID);
    expect(row.user_id).toBe(TEST_USER_ID);
    const payload = JSON.parse(row.payload);
    expect(payload.topPillars).toHaveLength(1);
    expect(payload.voiceInsights).toHaveLength(1);
    expect(payload.summary).toContain('fitness');

    expect(readSignals(
      'digest-owner',
      ['creator_learning_digest'],
      10,
      TEST_USER_ID,
      undefined,
      TEST_TENANT_ID,
    )).toEqual([expect.objectContaining({ id })]);
    expect(readSignals(
      'digest-other-user',
      ['creator_learning_digest'],
      10,
      TEST_USER_ID + 1,
      undefined,
      TEST_TENANT_ID,
    )).toEqual([]);
    expect(readSignals('digest-global-reader', ['learning_digest'], 10)).toEqual([]);

    const otherUserId = TEST_USER_ID + 1;
    const otherDigestId = produceLearningDigest(otherUserId, TEST_TENANT_ID);
    expect(otherDigestId).toBeGreaterThan(0);
    expect(testDb.prepare(`
      SELECT signal_type, tenant_id, user_id
      FROM agent_signals
      WHERE id = ?
    `).get(otherDigestId)).toMatchObject({
      signal_type: 'creator_learning_digest',
      tenant_id: TEST_TENANT_ID,
      user_id: otherUserId,
    });
    const sourceSignal = testDb.prepare(`
      SELECT consumed_by
      FROM agent_signals
      WHERE id = ?
    `).get(pillarSignalId) as { consumed_by: string };
    expect(JSON.parse(sourceSignal.consumed_by)).toEqual(expect.arrayContaining([
      `learning-digest:t:${TEST_TENANT_ID}:u:${TEST_USER_ID}`,
      `learning-digest:t:${TEST_TENANT_ID}:u:${otherUserId}`,
    ]));
  });
});

// ═══════════════════════════════════════════════════════════════════
// CONTENT FORMULA WRITER
// ═══════════════════════════════════════════════════════════════════

describe('writeContentFormula', () => {
  beforeEach(() => {
    testDb = createMigratedTestDatabase();
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

  it('persists versioned provenance, bounded confidence, and a future expiry', () => {
    const id = writeContentFormula('performance-agent', 'governed', 'fitness', 0.85, 'measured evidence');
    const [signal] = readSignals('formula-governance-reader', ['content_formula'], 10);

    expect(signal).toMatchObject({
      id,
      confidence: 0.5,
      provenance: {
        producerVersion: 'cross-agent-learning.v2',
        source: 'runtime',
      },
    });
    expect(Date.parse(signal.provenance!.observedAt)).not.toBeNaN();
    expect(Date.parse(signal.expires_at)).toBeGreaterThan(Date.parse(signal.created_at));
  });
});
