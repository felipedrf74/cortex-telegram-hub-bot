// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';

const TEST_USER_ID = 42;
const TEST_TENANT_ID = 4200;

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

import { readSignals, setDbProvider, writeSignal } from '../../src/services/intelligence-bus';
import {
  buildAgentContext,
  formatContextForPrompt,
  produceLearningDigest,
} from '../../src/services/cross-agent-learning';

describe('Cross-Agent Learning public contracts', () => {
  beforeAll(() => {
    testDb = createMigratedTestDatabase();
    setDbProvider(() => testDb);
  });

  beforeEach(() => {
    testDb.exec('SAVEPOINT cross_agent_contract');
  });

  afterEach(() => {
    testDb.exec('ROLLBACK TO cross_agent_contract');
    testDb.exec('RELEASE cross_agent_contract');
  });

  afterAll(() => {
    setDbProvider(() => null as any);
    testDb.close();
  });

  it('normalizes incomplete voice payloads and ignores malformed pillar rankings', () => {
    writeSignal({
      source_agent: 'voice-evolution',
      signal_type: 'voice_pattern',
      user_id: TEST_USER_ID,
      tenant_id: TEST_TENANT_ID,
      payload: {},
      priority: 'normal',
    });
    writeSignal({
      source_agent: 'content.performance-reviewer',
      signal_type: 'pillar_performance',
      payload: { rankings: 'not-an-array' },
      priority: 'normal',
    });

    const voiceContext = buildAgentContext('performance-agent', TEST_USER_ID, TEST_TENANT_ID);
    expect(voiceContext.voicePatterns).toEqual([{
      observation: '',
      patterns: [],
      strength: 0.5,
    }]);
    expect(buildAgentContext('seo-agent').pillarRankings).toEqual([]);
  });

  it('extracts every valid pillar ranking from one signal', () => {
    writeSignal({
      source_agent: 'content.performance-reviewer',
      signal_type: 'pillar_performance',
      payload: {
        rankings: [
          { pillar: 'AI', avg_views: 10_000, engagement_rate: 0.08, trend: 'up' },
          { pillar: 'Fitness', avg_views: 5_000, engagement_rate: 0.12, trend: 'stable' },
          { pillar: 'Coding', avg_views: 7_500, engagement_rate: 0.06, trend: 'down' },
        ],
      },
      priority: 'normal',
    });

    expect(buildAgentContext('seo-agent').pillarRankings).toEqual([
      expect.objectContaining({ pillar: 'AI', avgViews: 10_000 }),
      expect.objectContaining({ pillar: 'Fitness', engagementRate: 0.12 }),
      expect.objectContaining({ pillar: 'Coding', trend: 'down' }),
    ]);
  });

  it('formats only actionable keywords and sufficiently confident content formulas', () => {
    for (const payload of [
      { keyword: 'trending topic', direction: 'up', volume_hint: 'high' },
      { keyword: 'stable topic', direction: 'stable', volume_hint: 'medium' },
    ]) {
      writeSignal({
        source_agent: 'content.keyword-researcher',
        signal_type: 'keyword_opportunity',
        payload,
        priority: 'normal',
      });
    }
    for (const payload of [
      { formula: 'Low confidence', pillar: 'AI', confidence: 0.4 },
      { formula: 'Boundary confidence', pillar: 'AI', confidence: 0.6 },
      { formula: 'High confidence', pillar: 'AI', confidence: 0.9 },
    ]) {
      writeSignal({
        source_agent: 'content.performance-reviewer',
        signal_type: 'content_formula',
        payload,
        priority: 'normal',
      });
    }

    const prompt = formatContextForPrompt(buildAgentContext('pipeline-agent'));
    expect(prompt).toContain('Cross-Agent Learnings');
    expect(prompt).toContain('trending topic');
    expect(prompt).toContain('Boundary confidence');
    expect(prompt).toContain('High confidence');
    expect(prompt).not.toContain('stable topic');
    expect(prompt).not.toContain('Low confidence');
  });

  it('excludes weak creator voice evidence from a learning digest', () => {
    writeSignal({
      source_agent: 'voice-evolution',
      signal_type: 'voice_pattern',
      user_id: TEST_USER_ID,
      tenant_id: TEST_TENANT_ID,
      payload: { observation: 'Weak', strength: 0.4 },
      priority: 'normal',
    });
    writeSignal({
      source_agent: 'voice-evolution',
      signal_type: 'voice_pattern',
      user_id: TEST_USER_ID,
      tenant_id: TEST_TENANT_ID,
      payload: { observation: 'Boundary', strength: 0.7 },
      priority: 'normal',
    });
    writeSignal({
      source_agent: 'content.performance-reviewer',
      signal_type: 'pillar_performance',
      payload: {
        rankings: [{ pillar: 'AI', avg_views: 5_000, engagement_rate: 0.05, trend: 'stable' }],
      },
      priority: 'normal',
    });

    expect(produceLearningDigest(TEST_USER_ID, TEST_TENANT_ID)).toBeGreaterThan(0);
    const digests = readSignals(
      'digest-contract-reader',
      ['creator_learning_digest'],
      10,
      TEST_USER_ID,
      undefined,
      TEST_TENANT_ID,
    );
    expect(digests).toHaveLength(1);
    expect(digests[0].payload.voiceInsights).toEqual([
      expect.objectContaining({ observation: 'Boundary', strength: 0.7 }),
    ]);
  });

  it('tracks consumption independently for each peer agent', () => {
    writeSignal({
      source_agent: 'voice-evolution',
      signal_type: 'voice_pattern',
      user_id: TEST_USER_ID,
      tenant_id: TEST_TENANT_ID,
      payload: { observation: 'Scoped voice', strength: 0.9 },
      priority: 'normal',
    });

    expect(buildAgentContext('performance-agent', TEST_USER_ID, TEST_TENANT_ID).signalsConsumed).toBe(1);
    expect(buildAgentContext('reaction-radar', TEST_USER_ID, TEST_TENANT_ID).signalsConsumed).toBe(1);
  });
});
