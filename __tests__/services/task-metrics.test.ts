/**
 * Task Execution Metrics Tests
 *
 * Tests that:
 * - startTaskExecution creates a running record and returns an ID
 * - completeTaskExecution updates status, metrics, and calculates duration
 * - getTaskExecutionSummary returns correct aggregates (totals, cost, failure rate)
 * - getRecentExecutions returns rows in descending order
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

// ── Test helpers ────────────────────────────────────────────────────

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
    const applied = db.prepare('SELECT 1 FROM _migrations WHERE filename = ?').get(file);
    if (!applied) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      try {
        db.exec(sql);
        db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
      } catch {
        // Some migrations may depend on tables created by others; skip on error
      }
    }
  }
}

// ── Mocks ──────────────────────────────────────────────────────────

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

// ── Tests ──────────────────────────────────────────────────────────

describe('Task Execution Metrics', () => {
  beforeEach(() => {
    testDb = createTestDb();
    applyMigrations(testDb);
  });

  afterEach(() => {
    testDb?.close();
  });

  describe('startTaskExecution', () => {
    it('should create a running record and return an ID', async () => {
      const { startTaskExecution } = await import('../../src/services/task-metrics');
      const id = startTaskExecution('task-123', 'Test Task', 'backend');

      expect(id).toBeGreaterThan(0);

      const row = testDb.prepare('SELECT * FROM task_execution_metrics WHERE id = ?').get(id) as any;
      expect(row.notion_task_id).toBe('task-123');
      expect(row.task_title).toBe('Test Task');
      expect(row.agent).toBe('backend');
      expect(row.status).toBe('running');
      expect(row.start_time).toBeTruthy();
      expect(row.end_time).toBeNull();
    });
  });

  describe('completeTaskExecution', () => {
    it('should update status and metrics on completion', async () => {
      const { startTaskExecution, completeTaskExecution } = await import('../../src/services/task-metrics');
      const id = startTaskExecution('task-456', 'Deploy Feature', 'devops');

      completeTaskExecution(id, 'success', {
        apiCalls: 5,
        inputTokens: 10000,
        outputTokens: 3000,
        costUsd: 0.18,
      });

      const row = testDb.prepare('SELECT * FROM task_execution_metrics WHERE id = ?').get(id) as any;
      expect(row.status).toBe('success');
      expect(row.end_time).toBeTruthy();
      expect(row.api_calls).toBe(5);
      expect(row.input_tokens).toBe(10000);
      expect(row.output_tokens).toBe(3000);
      expect(row.total_tokens).toBe(13000);
      expect(row.cost_usd).toBeCloseTo(0.18);
      expect(row.duration_ms).toBeGreaterThanOrEqual(0);
    });

    it('should record failure with error message', async () => {
      const { startTaskExecution, completeTaskExecution } = await import('../../src/services/task-metrics');
      const id = startTaskExecution('task-789', 'Broken Task', 'backend');

      completeTaskExecution(id, 'failed', {
        apiCalls: 2,
        inputTokens: 5000,
        outputTokens: 1000,
        costUsd: 0.05,
        errorMessage: 'TypeError: foo is not a function',
        retryCount: 3,
      });

      const row = testDb.prepare('SELECT * FROM task_execution_metrics WHERE id = ?').get(id) as any;
      expect(row.status).toBe('failed');
      expect(row.error_message).toBe('TypeError: foo is not a function');
      expect(row.retry_count).toBe(3);
    });
  });

  describe('getTaskExecutionSummary', () => {
    it('should return zero-state summary with no data', async () => {
      const { getTaskExecutionSummary } = await import('../../src/services/task-metrics');
      const summary = getTaskExecutionSummary(7);

      expect(summary.totalTasks).toBe(0);
      expect(summary.totalCost).toBe(0);
      expect(summary.failureRate).toBe(0);
      expect(summary.costByAgent).toEqual({});
    });

    it('should aggregate metrics correctly', async () => {
      const { startTaskExecution, completeTaskExecution, getTaskExecutionSummary } = await import('../../src/services/task-metrics');

      const id1 = startTaskExecution('t1', 'Task 1', 'backend');
      completeTaskExecution(id1, 'success', { apiCalls: 3, inputTokens: 5000, outputTokens: 1000, costUsd: 0.10 });

      const id2 = startTaskExecution('t2', 'Task 2', 'qa');
      completeTaskExecution(id2, 'failed', { apiCalls: 2, inputTokens: 3000, outputTokens: 500, costUsd: 0.05, errorMessage: 'test fail' });

      const id3 = startTaskExecution('t3', 'Task 3', 'backend');
      completeTaskExecution(id3, 'success', { apiCalls: 4, inputTokens: 8000, outputTokens: 2000, costUsd: 0.20 });

      const summary = getTaskExecutionSummary(7);
      expect(summary.totalTasks).toBe(3);
      expect(summary.totalCost).toBeCloseTo(0.35);
      expect(summary.failureRate).toBeCloseTo(1 / 3);
      expect(summary.costByAgent.backend).toBeCloseTo(0.30);
      expect(summary.costByAgent.qa).toBeCloseTo(0.05);
    });
  });

  describe('getRecentExecutions', () => {
    it('should return recent executions in descending order', async () => {
      const { startTaskExecution, completeTaskExecution, getRecentExecutions } = await import('../../src/services/task-metrics');

      startTaskExecution('t1', 'First', 'backend');
      startTaskExecution('t2', 'Second', 'qa');
      startTaskExecution('t3', 'Third', 'devops');

      const recent = getRecentExecutions(2);
      expect(recent).toHaveLength(2);
      expect(recent[0].taskTitle).toBe('Third');
      expect(recent[1].taskTitle).toBe('Second');
    });
  });
});
