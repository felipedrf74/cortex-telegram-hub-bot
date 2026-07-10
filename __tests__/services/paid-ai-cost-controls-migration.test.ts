import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('migration 226 paid AI cost controls', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        tier TEXT,
        daily_cost_limit_usd REAL
      );
      CREATE TABLE plan_configs (
        plan_id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        daily_cost_usd REAL NOT NULL DEFAULT 0,
        daily_token_limit INTEGER,
        daily_message_limit INTEGER,
        allowed_skills_json TEXT NOT NULL DEFAULT '[]',
        per_skill_caps_json TEXT NOT NULL DEFAULT '{}',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        active INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_by INTEGER
      );
      CREATE TABLE user_ai_budget_overrides (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL UNIQUE,
        daily_cost_usd REAL NOT NULL,
        reason TEXT,
        expires_at TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        updated_by INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE api_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL DEFAULT (datetime('now')),
        category TEXT NOT NULL,
        model TEXT NOT NULL,
        user_id INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0
      );
      INSERT INTO users (id, tier, daily_cost_limit_usd) VALUES (1, 'free', 0.005), (2, 'pro', 0.04);
      INSERT INTO plan_configs (plan_id, display_name, daily_cost_usd, allowed_skills_json)
      VALUES
        ('free', 'Free', 0.005, '["secretary"]'),
        ('pro', 'Pro', 0.04, '["secretary"]'),
        ('max', 'Max', 0.06, '["secretary"]'),
        ('owner', 'Owner', 100, '["secretary"]');
      INSERT INTO api_usage (category, model, user_id, cost_usd) VALUES
        ('coach_analysis_openai_fallback', 'gpt-4o-mini', 2, 0.01),
        ('content_workflow_reel', 'gemini-2.5-flash', 2, 0.01),
        ('channel_analysis', 'gemini-2.5-flash', 2, 0.01),
        ('knowledge_synthesis', 'gemini-2.5-flash', 2, 0.01),
        ('chat_secretary', 'gemini-2.5-flash', 2, 0.01),
        ('autoresearch_topic_gen', 'gemini-2.5-flash', 0, 0.01);
    `);
    db.exec(readFileSync('migrations/226_paid_ai_cost_controls.sql', 'utf8'));
  });

  afterEach(() => db.close());

  it('seeds paid monthly caps and zeroes Free and beta model budgets', () => {
    const rows = db.prepare(`
      SELECT plan_id, daily_cost_usd, monthly_cost_usd
      FROM plan_configs
      ORDER BY plan_id
    `).all() as Array<{ plan_id: string; daily_cost_usd: number; monthly_cost_usd: number }>;
    expect(rows).toEqual(expect.arrayContaining([
      { plan_id: 'free', daily_cost_usd: 0, monthly_cost_usd: 0 },
      { plan_id: 'beta', daily_cost_usd: 0, monthly_cost_usd: 0 },
      { plan_id: 'pro', daily_cost_usd: 0.04, monthly_cost_usd: 1.2 },
      { plan_id: 'max', daily_cost_usd: 0.06, monthly_cost_usd: 1.8 },
    ]));
    expect(db.prepare('SELECT allowed_skills_json AS skills FROM plan_configs WHERE plan_id = ?').get('beta')).toEqual({
      skills: '["secretary","triathlon","training","content","cooking","finance"]',
    });
    expect(db.prepare('SELECT daily_cost_limit_usd AS cap FROM users WHERE id = 1').get()).toEqual({ cap: 0 });
  });

  it('backfills known background families conservatively and system-attributed rows exhaustively', () => {
    const rows = db.prepare(`
      SELECT category, request_source, base_category
      FROM api_usage
      ORDER BY id
    `).all() as Array<{ category: string; request_source: string; base_category: string }>;
    expect(rows.slice(0, 4).every((row) => row.request_source === 'automation')).toBe(true);
    expect(rows[4]).toMatchObject({ category: 'chat_secretary', request_source: 'interactive' });
    expect(rows[5]).toMatchObject({ category: 'autoresearch_topic_gen', request_source: 'system' });
    expect(rows.every((row) => row.base_category === row.category)).toBe(true);
  });

  it('adds attribution, override, deferral, and query-index contracts', () => {
    const apiColumns = db.prepare('PRAGMA table_info(api_usage)').all() as Array<{ name: string }>;
    expect(apiColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
      'request_source', 'job_name', 'base_category', 'run_id',
      'provider_tool_cost_usd', 'web_search_requests', 'grounded_search_prompts',
    ]));
    const overrideColumns = db.prepare('PRAGMA table_info(user_ai_budget_overrides)').all() as Array<{ name: string }>;
    expect(overrideColumns.map((column) => column.name)).toContain('monthly_cost_usd');
    const indexes = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all() as Array<{ name: string }>;
    expect(indexes.map((index) => index.name)).toEqual(expect.arrayContaining([
      'idx_api_usage_user_source_ts',
      'idx_api_usage_source_ts',
      'idx_api_usage_source_base_category_ts',
      'idx_api_usage_user_base_category_ts',
      'idx_api_usage_run_id',
      'idx_ai_budget_deferrals_user_created',
    ]));
    expect(() => db.prepare(`
      UPDATE plan_configs SET monthly_cost_usd = -1 WHERE plan_id = 'pro'
    `).run()).toThrow();
    expect(() => db.prepare(`
      INSERT INTO user_ai_budget_overrides (user_id, daily_cost_usd, monthly_cost_usd)
      VALUES (99, 0.1, -1)
    `).run()).toThrow();
  });
});
