/**
 * Quality Scorer Tests
 *
 * Tests that:
 * - runQualityChecks produces correct scores based on pass/fail combos
 * - saveQualityScore persists to DB with correct values
 * - getQualityByAgent aggregates correctly
 * - execSync is mocked to simulate different environments
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import Database from 'better-sqlite3';
function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}


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
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  LOGGER_REDACTION_PATHS: [],
}));

// Mock child_process.execSync for runQualityChecks
const mockExecSync = vi.fn();
vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

describe('Quality Scorer', () => {
  beforeEach(() => {
    testDb = createMigratedTestDatabase();
    mockExecSync.mockReset();
  });

  afterEach(() => {
    testDb?.close();
  });

  describe('runQualityChecks', () => {
    it('should score 100 when all checks pass', async () => {
      // Mock all commands succeeding
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes('vitest')) return Buffer.from('Tests passed');
        if (cmd.includes('tsc')) return Buffer.from('');
        if (cmd.includes('eslint')) return Buffer.from('');
        if (cmd.includes('git diff')) return Buffer.from('file1.ts\nfile2.ts\nfile3.ts');
        return Buffer.from('');
      });

      const { runQualityChecks } = await import('../../src/services/quality-scorer');
      const report = runQualityChecks('/tmp/test');

      expect(report.testsPassing).toBe(true);
      expect(report.typesClean).toBe(true);
      expect(report.lintClean).toBe(true);
      expect(report.filesChanged).toBe(3);
      expect(report.overallScore).toBe(100);
    });

    it('should score 0 when all checks fail', async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes('git diff')) return Buffer.from('');
        throw new Error('command failed');
      });

      const { runQualityChecks } = await import('../../src/services/quality-scorer');
      const report = runQualityChecks('/tmp/test');

      expect(report.testsPassing).toBe(false);
      expect(report.typesClean).toBe(false);
      expect(report.lintClean).toBe(false);
      expect(report.filesChanged).toBe(0);
      expect(report.overallScore).toBe(0);
    });

    it('should score 70 when tests and types pass but lint fails', async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes('vitest')) return Buffer.from('ok');
        if (cmd.includes('tsc')) return Buffer.from('ok');
        if (cmd.includes('eslint')) throw new Error('lint errors');
        if (cmd.includes('git diff')) return Buffer.from('changed.ts');
        return Buffer.from('');
      });

      const { runQualityChecks } = await import('../../src/services/quality-scorer');
      const report = runQualityChecks('/tmp/test');

      expect(report.testsPassing).toBe(true);
      expect(report.typesClean).toBe(true);
      expect(report.lintClean).toBe(false);
      expect(report.overallScore).toBe(80); // 40 + 30 + 0 + 10
    });

    it('should treat missing eslint config as lint-clean', async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes('vitest')) return Buffer.from('ok');
        if (cmd.includes('tsc')) return Buffer.from('ok');
        if (cmd.includes('eslint')) throw new Error('No ESLint configuration found');
        if (cmd.includes('git diff')) return Buffer.from('a.ts');
        return Buffer.from('');
      });

      const { runQualityChecks } = await import('../../src/services/quality-scorer');
      const report = runQualityChecks('/tmp/test');

      expect(report.lintClean).toBe(true);
      expect(report.overallScore).toBe(100);
    });
  });

  describe('saveQualityScore', () => {
    it('should persist quality score to database', async () => {
      const { saveQualityScore } = await import('../../src/services/quality-scorer');
      const report = {
        testsPassing: true,
        typesClean: true,
        lintClean: false,
        filesChanged: 5,
        testCoverage: null,
        overallScore: 80,
        details: { tests: 'ok', types: 'ok', lint: 'errors' },
      };

      const id = saveQualityScore(null, 'task-abc', 'backend', report);
      expect(id).toBeGreaterThan(0);

      const row = testDb.prepare('SELECT * FROM quality_scores WHERE id = ?').get(id) as any;
      expect(row.notion_task_id).toBe('task-abc');
      expect(row.agent).toBe('backend');
      expect(row.tests_passing).toBe(1);
      expect(row.types_clean).toBe(1);
      expect(row.lint_clean).toBe(0);
      expect(row.files_changed).toBe(5);
      expect(row.overall_score).toBe(80);
    });
  });

  describe('getQualityByAgent', () => {
    it('should aggregate scores by agent', async () => {
      const { saveQualityScore, getQualityByAgent } = await import('../../src/services/quality-scorer');

      const goodReport = { testsPassing: true, typesClean: true, lintClean: true, filesChanged: 3, testCoverage: null, overallScore: 100, details: {} };
      const badReport = { testsPassing: false, typesClean: false, lintClean: false, filesChanged: 1, testCoverage: null, overallScore: 10, details: {} };

      saveQualityScore(null, 't1', 'backend', goodReport);
      saveQualityScore(null, 't2', 'backend', goodReport);
      saveQualityScore(null, 't3', 'qa', badReport);

      const results = getQualityByAgent(30);
      expect(results).toHaveLength(2);

      const backend = results.find(r => r.agent === 'backend');
      expect(backend).toBeTruthy();
      expect(backend!.avgScore).toBe(100);
      expect(backend!.totalTasks).toBe(2);
      expect(backend!.passRate).toBe(1);

      const qa = results.find(r => r.agent === 'qa');
      expect(qa).toBeTruthy();
      expect(qa!.avgScore).toBe(10);
      expect(qa!.passRate).toBe(0);
    });

    it('should return empty array when no scores exist', async () => {
      const { getQualityByAgent } = await import('../../src/services/quality-scorer');
      const results = getQualityByAgent(30);
      expect(results).toEqual([]);
    });
  });
});
