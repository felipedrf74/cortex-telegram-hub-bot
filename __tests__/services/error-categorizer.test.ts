/**
 * Error Categorizer Tests
 *
 * Tests that:
 * - Error messages are correctly classified by category
 * - Each category maps to the correct retry strategy
 * - shouldRetry respects maxRetries boundary
 * - logCategorizedError persists to error_log with JSON context
 * - getErrorDistribution aggregates by category
 * - Unknown errors escalate
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
    const applied = db.prepare('SELECT 1 FROM _migrations WHERE filename = ?').get(file);
    if (!applied) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      try {
        db.exec(sql);
        db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
      } catch { /* skip migrations with missing dependencies */ }
    }
  }
}

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../src/portal/telemetry', () => ({
  pushEvent: vi.fn(),
}));

describe('Error Categorizer', () => {
  beforeEach(() => {
    testDb = createTestDb();
    applyMigrations(testDb);
  });

  afterEach(() => {
    testDb?.close();
  });

  describe('categorizeError', () => {
    it('should classify SyntaxError as syntax with auto_fix strategy', async () => {
      const { categorizeError } = await import('../../src/services/error-categorizer');
      const result = categorizeError('SyntaxError: Unexpected token }');
      expect(result.category).toBe('syntax');
      expect(result.strategy).toBe('auto_fix');
      expect(result.maxRetries).toBe(3);
    });

    it('should classify TypeError as syntax', async () => {
      const { categorizeError } = await import('../../src/services/error-categorizer');
      const result = categorizeError('TypeError: foo is not a function');
      expect(result.category).toBe('syntax');
      expect(result.strategy).toBe('auto_fix');
    });

    it('should classify tsc errors as syntax', async () => {
      const { categorizeError } = await import('../../src/services/error-categorizer');
      const result = categorizeError('src/foo.ts(12,5): tsc error TS2345: Argument of type...');
      expect(result.category).toBe('syntax');
    });

    it('should classify vitest failures as test_failure', async () => {
      const { categorizeError } = await import('../../src/services/error-categorizer');
      const result = categorizeError('FAIL __tests__/foo.test.ts > should work');
      expect(result.category).toBe('test_failure');
      expect(result.strategy).toBe('auto_fix');
    });

    it('should classify 429 as rate_limit with wait_retry', async () => {
      const { categorizeError } = await import('../../src/services/error-categorizer');
      const result = categorizeError('429 Too Many Requests');
      expect(result.category).toBe('rate_limit');
      expect(result.strategy).toBe('wait_retry');
      expect(result.maxRetries).toBe(5);
      expect(result.backoffMs).toBe(60000);
    });

    it('should classify timeout errors as timeout with backoff', async () => {
      const { categorizeError } = await import('../../src/services/error-categorizer');
      const result = categorizeError('ETIMEDOUT: connection timed out');
      expect(result.category).toBe('timeout');
      expect(result.strategy).toBe('backoff_retry');
      expect(result.backoffMs).toBe(5000);
    });

    it('should classify token limit as context_overflow', async () => {
      const { categorizeError } = await import('../../src/services/error-categorizer');
      const result = categorizeError('max tokens exceeded: context length is 200000');
      expect(result.category).toBe('context_overflow');
      expect(result.strategy).toBe('summarize_retry');
    });

    it('should classify ECONNREFUSED as integration', async () => {
      const { categorizeError } = await import('../../src/services/error-categorizer');
      const result = categorizeError('ECONNREFUSED: connection refused');
      expect(result.category).toBe('integration');
      expect(result.strategy).toBe('backoff_retry');
    });

    it('should classify unknown errors as unknown with escalate', async () => {
      const { categorizeError } = await import('../../src/services/error-categorizer');
      const result = categorizeError('some gibberish error that matches nothing');
      expect(result.category).toBe('unknown');
      expect(result.strategy).toBe('escalate');
      expect(result.maxRetries).toBe(1);
    });

    it('should also check stack traces for classification', async () => {
      const { categorizeError } = await import('../../src/services/error-categorizer');
      const result = categorizeError('Error occurred', 'at Object.<anonymous> TypeError: x is not defined');
      expect(result.category).toBe('syntax');
    });
  });

  describe('shouldRetry', () => {
    it('should return true when retries remain', async () => {
      const { shouldRetry } = await import('../../src/services/error-categorizer');
      const categorized = { category: 'syntax' as const, strategy: 'auto_fix' as const, maxRetries: 3, backoffMs: 0 };
      expect(shouldRetry(categorized, 0)).toBe(true);
      expect(shouldRetry(categorized, 2)).toBe(true);
    });

    it('should return false when retries exhausted', async () => {
      const { shouldRetry } = await import('../../src/services/error-categorizer');
      const categorized = { category: 'syntax' as const, strategy: 'auto_fix' as const, maxRetries: 3, backoffMs: 0 };
      expect(shouldRetry(categorized, 3)).toBe(false);
      expect(shouldRetry(categorized, 5)).toBe(false);
    });
  });

  describe('logCategorizedError', () => {
    it('should persist error to error_log with JSON context', async () => {
      const { logCategorizedError } = await import('../../src/services/error-categorizer');
      const categorized = { category: 'syntax' as const, strategy: 'auto_fix' as const, maxRetries: 3, backoffMs: 0 };

      logCategorizedError('task-abc', 'backend', 'SyntaxError: oops', categorized, 1);

      const row = testDb.prepare('SELECT * FROM error_log WHERE source = ?').get('agent') as any;
      expect(row).toBeTruthy();
      expect(row.message).toBe('SyntaxError: oops');
      const ctx = JSON.parse(row.context);
      expect(ctx.category).toBe('syntax');
      expect(ctx.strategy).toBe('auto_fix');
      expect(ctx.taskId).toBe('task-abc');
      expect(ctx.agent).toBe('backend');
      expect(ctx.retryAttempt).toBe(1);
    });

    it('should sanitize sensitive error messages before durable persistence', async () => {
      const { logCategorizedError } = await import('../../src/services/error-categorizer');
      const categorized = { category: 'integration' as const, strategy: 'backoff_retry' as const, maxRetries: 3, backoffMs: 10000 };

      logCategorizedError(
        'task-secret',
        'content',
        'provider failed prompt=private strategy token=secret-token',
        categorized,
        1,
      );

      const row = testDb.prepare('SELECT * FROM error_log WHERE source = ?').get('agent') as any;
      expect(row.message).toContain('prompt=[Redacted]');
      expect(row.message).toContain('token=[Redacted]');
      expect(row.message).not.toContain('private strategy');
      expect(row.message).not.toContain('secret-token');
    });
  });

  describe('getErrorDistribution', () => {
    it('should aggregate errors by category', async () => {
      const { logCategorizedError, getErrorDistribution } = await import('../../src/services/error-categorizer');

      logCategorizedError('t1', 'backend', 'SyntaxError', { category: 'syntax', strategy: 'auto_fix', maxRetries: 3, backoffMs: 0 }, 1);
      logCategorizedError('t2', 'qa', 'SyntaxError', { category: 'syntax', strategy: 'auto_fix', maxRetries: 3, backoffMs: 0 }, 1);
      logCategorizedError('t3', 'backend', '429 rate limit', { category: 'rate_limit', strategy: 'wait_retry', maxRetries: 5, backoffMs: 60000 }, 1);

      const dist = getErrorDistribution(7);
      expect(dist.syntax).toBe(2);
      expect(dist.rate_limit).toBe(1);
    });

    it('should return empty object when no errors exist', async () => {
      const { getErrorDistribution } = await import('../../src/services/error-categorizer');
      const dist = getErrorDistribution(7);
      expect(dist).toEqual({});
    });
  });
});
