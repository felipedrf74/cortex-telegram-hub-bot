import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';

describe('agent_job_runs migration', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createMigratedTestDatabase();
  });

  afterEach(() => {
    db.close();
  });

  it('stores only governed run identity, opaque fingerprints, and usage totals', () => {
    db.prepare(`
      INSERT INTO agent_job_runs (
        run_id, job_id, job_version, tenant_id, user_id, attempt, status,
        input_fingerprint, output_fingerprint, provider_calls, cost_usd,
        duration_ms, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'run-1',
      'tuesday_reels',
      '1.0.0',
      42,
      42,
      1,
      'success',
      'a'.repeat(64),
      'b'.repeat(64),
      1,
      0.01,
      12,
      '2026-07-15T20:00:00.000Z',
    );

    const row = db.prepare(`
      SELECT job_id, tenant_id, user_id, status, provider_calls, cost_usd,
             input_fingerprint, output_fingerprint
        FROM agent_job_runs
       WHERE run_id = 'run-1'
    `).get() as Record<string, unknown>;
    expect(row).toEqual({
      job_id: 'tuesday_reels',
      tenant_id: 42,
      user_id: 42,
      status: 'success',
      provider_calls: 1,
      cost_usd: 0.01,
      input_fingerprint: 'a'.repeat(64),
      output_fingerprint: 'b'.repeat(64),
    });

    const columns = db.prepare('PRAGMA table_info(agent_job_runs)').all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).not.toEqual(expect.arrayContaining([
      'prompt',
      'provider_response',
      'input_json',
      'output_json',
    ]));
  });

  it('rejects invalid statuses, negative usage, and duplicate run ids', () => {
    const insert = db.prepare(`
      INSERT INTO agent_job_runs (
        run_id, job_id, job_version, tenant_id, user_id, attempt, status,
        provider_calls, cost_usd
      ) VALUES (?, 'autoresearch', '1.0.0', 0, 0, 1, ?, ?, ?)
    `);

    expect(() => insert.run('bad-status', 'invented', 0, 0)).toThrow();
    expect(() => insert.run('bad-calls', 'failed', -1, 0)).toThrow();
    expect(() => insert.run('bad-cost', 'failed', 0, -0.1)).toThrow();
    insert.run('unique-run', 'failed', 0, 0);
    expect(() => insert.run('unique-run', 'failed', 0, 0)).toThrow();
  });
});
