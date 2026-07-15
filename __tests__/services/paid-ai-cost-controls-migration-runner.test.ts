import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { runMigrationsForTest } from '../../src/services/database';

describe('paid AI migration real-runner rehearsal', () => {
  let db: Database.Database | undefined;
  let directory: string | undefined;

  afterEach(() => {
    db?.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it('runs 001 through 226 with historical edge rows and is idempotent on a second pass', { timeout: 30_000 }, () => {
    directory = mkdtempSync(path.join(os.tmpdir(), 'nexus-paid-ai-migration-'));
    db = new Database(path.join(directory, 'rehearsal.db'));

    // Use the production migration runner for the complete historical chain,
    // pausing immediately before the migration under rehearsal so realistic
    // pre-226 rows can be seeded.
    runMigrationsForTest(db, { stopBefore: '226_paid_ai_cost_controls.sql' });

    db.exec(`
      INSERT INTO api_usage (
        category, model, user_id, tenant_id, input_tokens, output_tokens,
        cost_usd, duration_ms, provider, pricing_status
      ) VALUES
        ('coach_analysis_openai_fallback', 'gpt-4o-mini', 7001, 7001, 100, 20, 0.001, 25, 'openai', 'legacy'),
        ('channel_analysis_gemini_model_fallback', 'gemini-2.5-flash', 7001, 7001, 100, 20, 0.001, 25, 'gemini', 'legacy'),
        ('autoresearch_topic_gen_fallback', 'gemini-2.5-flash', 0, 0, 100, 20, 0.001, 25, 'gemini', 'legacy');

      UPDATE plan_configs
         SET daily_cost_usd = 0.75
       WHERE plan_id = 'beta';

      -- A hand-repaired historical database can contain a NULL tier even
      -- though current fresh-chain DDL is stricter. Rebuild only this legacy
      -- surface after the 001-225 chain so 226's repair is rehearsed too.
      ALTER TABLE users RENAME TO users_pre226;
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        tier TEXT,
        daily_cost_limit_usd REAL
      );
      INSERT INTO users (id, tier, daily_cost_limit_usd)
      VALUES (7001, 'beta', 0.75), (7002, NULL, 0.005);
    `);

    runMigrationsForTest(db);

    expect(db.prepare(`
      SELECT category, request_source, base_category, pricing_status
        FROM api_usage
       WHERE category IN (
         'coach_analysis_openai_fallback',
         'channel_analysis_gemini_model_fallback',
         'autoresearch_topic_gen_fallback'
       )
       ORDER BY category
    `).all()).toEqual([
      {
        category: 'autoresearch_topic_gen_fallback',
        request_source: 'system',
        base_category: 'autoresearch_topic_gen',
        pricing_status: 'legacy',
      },
      {
        category: 'channel_analysis_gemini_model_fallback',
        request_source: 'automation',
        base_category: 'channel_analysis',
        pricing_status: 'legacy',
      },
      {
        category: 'coach_analysis_openai_fallback',
        request_source: 'automation',
        base_category: 'coach_analysis',
        pricing_status: 'legacy',
      },
    ]);
    expect(db.prepare(`
      SELECT id, daily_cost_limit_usd FROM users ORDER BY id
    `).all()).toEqual([
      { id: 7001, daily_cost_limit_usd: 0.75 },
      { id: 7002, daily_cost_limit_usd: 0 },
    ]);
    expect(db.prepare(`
      SELECT daily_cost_usd, monthly_cost_usd
        FROM plan_configs WHERE plan_id = 'beta'
    `).get()).toEqual({ daily_cost_usd: 0, monthly_cost_usd: 0 });

    const appliedBefore = db.prepare('SELECT COUNT(*) AS count FROM _migrations').get() as { count: number };
    const rowCountBefore = db.prepare('SELECT COUNT(*) AS count FROM api_usage').get() as { count: number };
    runMigrationsForTest(db);
    expect(db.prepare('SELECT COUNT(*) AS count FROM _migrations').get()).toEqual(appliedBefore);
    expect(db.prepare('SELECT COUNT(*) AS count FROM api_usage').get()).toEqual(rowCountBefore);
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM _migrations
       WHERE filename = '226_paid_ai_cost_controls.sql'
    `).get()).toEqual({ count: 1 });
  });
});
