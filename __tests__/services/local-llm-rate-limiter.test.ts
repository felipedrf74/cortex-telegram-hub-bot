// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ db: null as Database.Database | null }));

vi.mock('../../src/config', () => ({
  config: {
    ollama: {
      rateLimit: { perUserHourly: 1, perUserDaily: 1, scriptGenPerUserDaily: 1 },
    },
  },
}));
vi.mock('../../src/services/database', () => ({ getDb: () => state.db }));
vi.mock('../../src/utils/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('local LLM rate limiter shadow isolation', () => {
  beforeEach(() => {
    state.db = new Database(':memory:');
    state.db.exec(`CREATE TABLE api_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL DEFAULT (datetime('now')),
      provider TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      local_request_units INTEGER NOT NULL DEFAULT 0,
      category TEXT NOT NULL,
      job_name TEXT,
      base_category TEXT
    )`);
  });

  afterEach(() => {
    state.db?.close();
    state.db = null;
  });

  it('does not let shadow rows consume visible hourly, daily, or script capacity', async () => {
    const limiter = await import('../../src/services/local-llm-rate-limiter');
    limiter._resetLocalLLMRateLimiterSchemaCacheForTests();
    const insert = state.db!.prepare(`INSERT INTO api_usage (
      provider, user_id, local_request_units, category, job_name, base_category
    ) VALUES ('ollama', 42, 1, ?, ?, ?)`);
    insert.run('script_gen_local', 'local_primary_shadow', 'local_primary_shadow:script_gen_local');
    insert.run('classify_shadow', 'classify_shadow', 'classify_shadow');

    expect(limiter.checkAndConsumeLocalLLMRateLimit({ userId: 42, scope: 'script' }))
      .toEqual({ allowed: true });

    insert.run('script_gen_local', 'visible_script', 'script_gen_local');
    expect(limiter.checkAndConsumeLocalLLMRateLimit({ userId: 42, scope: 'script' }))
      .toMatchObject({ allowed: false, reasonScope: 'user_hourly' });
  });

  it('does not treat SQL LIKE wildcard lookalikes as shadow attribution', async () => {
    const limiter = await import('../../src/services/local-llm-rate-limiter');
    limiter._resetLocalLLMRateLimiterSchemaCacheForTests();
    state.db!.prepare(`INSERT INTO api_usage (
      provider, user_id, local_request_units, category, job_name, base_category
    ) VALUES ('ollama', 42, 1, ?, ?, ?)`).run(
      'script_gen_local',
      'visible_near_collision',
      'localXprimaryYshadow:script_gen_local',
    );

    expect(limiter.checkAndConsumeLocalLLMRateLimit({ userId: 42, scope: 'script' }))
      .toMatchObject({ allowed: false, reasonScope: 'user_hourly' });
  });
});
