import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

let testDb: Database.Database;

const mockReadTrainingMeshContext = vi.fn();
const mockReadCookingMeshContext = vi.fn();
const mockReadFinanceMeshContext = vi.fn();
const mockReadContentMeshContext = vi.fn();
const mockReadSecretaryMeshContext = vi.fn();

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

vi.mock('../../src/services/cross-agent-learning', () => ({
  readTrainingMeshContext: (...args: unknown[]) => mockReadTrainingMeshContext(...args),
  readCookingMeshContext: (...args: unknown[]) => mockReadCookingMeshContext(...args),
  readFinanceMeshContext: (...args: unknown[]) => mockReadFinanceMeshContext(...args),
  readContentMeshContext: (...args: unknown[]) => mockReadContentMeshContext(...args),
  readSecretaryMeshContext: (...args: unknown[]) => mockReadSecretaryMeshContext(...args),
}));

import {
  readSignals,
  setDbProvider,
  setScopeAnomalyReporter,
  writeSignal,
} from '../../src/services/intelligence-bus';
import {
  buildSharedDecisionContext,
  resetSharedDecisionContextCacheForTests,
} from '../../src/services/shared-decision-context';
import {
  clearTenantScopeAnomaliesForTests,
  getTenantScopeAnomalies,
  recordTenantScopeAnomaly,
} from '../../src/services/tenant-scope-observability';

function applyMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, filename TEXT UNIQUE, applied_at TEXT DEFAULT (datetime('now')))`);
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (!db.prepare('SELECT 1 FROM _migrations WHERE filename = ?').get(file)) {
      try {
        db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
        db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
      } catch {
        // Some migrations depend on optional local tables; skip those for focused tests.
      }
    }
  }
}

describe('tenant-scope observability', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
    setDbProvider(() => testDb as any);
    setScopeAnomalyReporter(recordTenantScopeAnomaly);
    clearTenantScopeAnomaliesForTests();
    resetSharedDecisionContextCacheForTests();

    mockReadTrainingMeshContext.mockReset();
    mockReadCookingMeshContext.mockReset();
    mockReadFinanceMeshContext.mockReset();
    mockReadContentMeshContext.mockReset();
    mockReadSecretaryMeshContext.mockReset();
  });

  afterEach(() => {
    setScopeAnomalyReporter(null);
    testDb?.close();
  });

  it('fails closed for per-user signal writes without a tenant id and records the anomaly', () => {
    const signalId = writeSignal({
      source_agent: 'training.test',
      signal_type: 'low_sleep',
      payload: { score: 35 },
    });

    expect(signalId).toBe(-1);
    const row = testDb.prepare('SELECT COUNT(*) as count FROM agent_signals').get() as { count: number };
    expect(row.count).toBe(0);

    const anomalies = getTenantScopeAnomalies();
    expect(anomalies[0]).toMatchObject({
      layer: 'intelligence_bus',
      operation: 'write_signal',
      reason: 'missing_user_scope',
      signalType: 'low_sleep',
      userId: null,
    });
  });

  it('rejects unregistered or malformed signal source agents before persistence', () => {
    const signalId = writeSignal({
      source_agent: 'evil.agent\nsource',
      signal_type: 'low_sleep',
      payload: { score: 35 },
      user_id: 7,
      tenant_id: 100,
    });

    expect(signalId).toBe(-1);
    const row = testDb.prepare('SELECT COUNT(*) as count FROM agent_signals').get() as { count: number };
    expect(row.count).toBe(0);
    expect(getTenantScopeAnomalies()[0]).toMatchObject({
      layer: 'intelligence_bus',
      operation: 'write_signal',
      reason: 'invalid_user_scope',
      signalType: 'low_sleep',
      userId: 7,
      details: expect.objectContaining({
        invalidSourceAgent: true,
      }),
    });
  });

  it('records unexpected user scope on global mesh signals and normalizes them to system rows', () => {
    const signalId = writeSignal({
      source_agent: 'content.test',
      signal_type: 'content_formula',
      payload: { formula: 'hook -> payoff' },
      user_id: 42,
    });

    expect(signalId).toBeGreaterThan(0);
    const row = testDb.prepare('SELECT tenant_id, user_id FROM agent_signals WHERE id = ?').get(signalId) as { tenant_id: number | null; user_id: number | null };
    expect(row.tenant_id).toBe(42);
    expect(row.user_id).toBeNull();

    const anomalies = getTenantScopeAnomalies();
    expect(anomalies[0]).toMatchObject({
      layer: 'intelligence_bus',
      operation: 'write_signal',
      reason: 'unexpected_user_scope',
      signalType: 'content_formula',
      userId: 42,
    });
  });

  it('partitions signal reads by tenant even for the same user id', () => {
    writeSignal({
      source_agent: 'training.test',
      signal_type: 'low_sleep',
      payload: { score: 35 },
      user_id: 7,
      tenant_id: 100,
    });
    writeSignal({
      source_agent: 'training.test',
      signal_type: 'low_sleep',
      payload: { score: 91 },
      user_id: 7,
      tenant_id: 200,
    });

    expect(readSignals('consumer-a', ['low_sleep'], 10, 7, undefined, 100).map((signal) => signal.payload.score))
      .toEqual([35]);
    expect(readSignals('consumer-b', ['low_sleep'], 10, 7, undefined, 200).map((signal) => signal.payload.score))
      .toEqual([91]);
  });

  it('records invalid scoped reads and falls back to global rows only', () => {
    writeSignal({
      source_agent: 'content.test',
      signal_type: 'content_formula',
      payload: { formula: 'system-shared' },
    });
    writeSignal({
      source_agent: 'training.test',
      signal_type: 'low_sleep',
      payload: { score: 32 },
      user_id: 51,
    });

    const signals = readSignals('consumer', ['content_formula', 'low_sleep'], 10, 0);

    expect(signals).toHaveLength(1);
    expect(signals[0].signal_type).toBe('content_formula');
    expect(getTenantScopeAnomalies()[0]).toMatchObject({
      layer: 'intelligence_bus',
      operation: 'read_signals',
      reason: 'invalid_user_scope',
      userId: 0,
    });
  });

  it('records invalid shared decision context scope and skips peer reads', async () => {
    const context = await buildSharedDecisionContext('secretary', 0);

    expect(context).toBe('');
    expect(mockReadTrainingMeshContext).not.toHaveBeenCalled();
    expect(mockReadCookingMeshContext).not.toHaveBeenCalled();
    expect(mockReadFinanceMeshContext).not.toHaveBeenCalled();
    expect(mockReadContentMeshContext).not.toHaveBeenCalled();
    expect(mockReadSecretaryMeshContext).not.toHaveBeenCalled();
    expect(getTenantScopeAnomalies()[0]).toMatchObject({
      layer: 'shared_decision_context',
      operation: 'build_shared_decision_context',
      reason: 'invalid_user_scope',
      userId: 0,
      details: { domain: 'secretary' },
    });
  });
});
