import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { insertApiUsageFallback } from '../../src/services/api-usage-fallback';
import {
  resolveApiUsageAttribution,
  runWithApiUsageAttribution,
} from '../../src/services/api-usage-attribution';

describe('api_usage workload attribution', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE api_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL,
        model TEXT NOT NULL,
        provider TEXT,
        tenant_id INTEGER,
        user_id INTEGER,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cache_read_tokens INTEGER,
        cache_write_tokens INTEGER,
        cost_usd REAL,
        duration_ms INTEGER,
        pricing_status TEXT,
        pricing_model_key TEXT,
        request_source TEXT,
        job_name TEXT,
        base_category TEXT,
        run_id TEXT
      );
    `);
  });

  afterEach(() => db.close());

  it('carries automation context through async provider fallback writes', async () => {
    await runWithApiUsageAttribution({
      requestSource: 'automation',
      jobName: 'weekly_channel_learning',
      baseCategory: 'channel_analysis',
      runId: 'run:2026-07-09',
    }, async () => {
      await Promise.resolve();
      insertApiUsageFallback(db, {
        category: 'channel_analysis_openai_fallback',
        model: 'gpt-4o-mini',
        provider: 'openai',
        userId: 7,
        inputTokens: 100,
        outputTokens: 50,
        costUsd: 0.001,
      });
    });

    expect(db.prepare(`
      SELECT request_source, job_name, base_category, run_id FROM api_usage
    `).get()).toEqual({
      request_source: 'automation',
      job_name: 'weekly_channel_learning',
      base_category: 'channel_analysis',
      run_id: 'run:2026-07-09',
    });
  });

  it('defaults unattributed user calls to interactive and user_id=0 calls to system', () => {
    expect(resolveApiUsageAttribution('coach_analysis_openai_fallback', 9)).toEqual({
      requestSource: 'interactive',
      jobName: null,
      baseCategory: 'coach_analysis',
      runId: null,
    });
    expect(resolveApiUsageAttribution('autoresearch_topic_gen', 0)).toEqual({
      requestSource: 'system',
      jobName: null,
      baseCategory: 'autoresearch_topic_gen',
      runId: null,
    });
  });
});
