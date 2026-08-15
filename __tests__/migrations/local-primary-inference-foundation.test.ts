// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

const upSql = readFileSync(
  resolve(__dirname, '../../migrations/284_local_primary_inference_foundation.sql'),
  'utf8',
);
const downSql = readFileSync(
  resolve(__dirname, '../../migrations/down/284_local_primary_inference_foundation.sql'),
  'utf8',
);

function database(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE plan_configs (
      plan_id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      daily_cost_usd REAL NOT NULL DEFAULT 0,
      monthly_cost_usd REAL NOT NULL DEFAULT 0,
      allowed_skills_json TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE subscriptions (user_id INTEGER PRIMARY KEY, plan TEXT NOT NULL);
    CREATE TABLE api_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL DEFAULT (datetime('now')),
      user_id INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO plan_configs (plan_id, display_name) VALUES
      ('free', 'Free'), ('beta', 'Beta'), ('pro', 'Pro'), ('max', 'Max'), ('owner', 'Owner');
  `);
  return db;
}

describe('migration 284 local-primary inference foundation', () => {
  it('is additive, default-off, and seeds the locked Pro/Max policies', () => {
    const db = database();
    db.exec(upSql);

    expect(db.prepare(`SELECT environment, mode, rollout_percent
      FROM local_inference_runtime_control ORDER BY environment`).all()).toEqual([
      { environment: 'production', mode: 'off', rollout_percent: 0 },
      { environment: 'staging', mode: 'off', rollout_percent: 0 },
    ]);
    expect(db.prepare(`SELECT COUNT(*) AS count FROM local_inference_control_events`).get())
      .toEqual({ count: 0 });
    expect(() => db.prepare(`INSERT INTO local_inference_control_events (
      environment, previous_mode, mode, rollout_percent, actor_type,
      actor_user_id, reason
    ) VALUES ('production', 'active', 'off', 0, 'system_monitor', NULL, 'emergency')`).run())
      .not.toThrow();
    expect(() => db.prepare(`INSERT INTO local_inference_control_events (
      environment, previous_mode, mode, rollout_percent, actor_type,
      actor_user_id, reason
    ) VALUES ('production', 'off', 'shadow', 0, 'owner', NULL, 'invalid owner')`).run())
      .toThrow();
    expect(db.prepare(`SELECT plan_id, local_operations_hourly, local_operations_daily,
      longform_scripts_daily, active_content_jobs, ordinary_context_tokens,
      content_context_tokens, script_segment_output_tokens, local_queue_weight,
      local_cloud_fallback_run_usd, local_cloud_fallback_daily_usd
      FROM plan_configs WHERE plan_id IN ('pro', 'max') ORDER BY plan_id`).all()).toEqual([
      {
        plan_id: 'max', local_operations_hourly: 40, local_operations_daily: 200,
        longform_scripts_daily: 20, active_content_jobs: 2,
        ordinary_context_tokens: 12288, content_context_tokens: 16384,
        script_segment_output_tokens: 6144, local_queue_weight: 2,
        local_cloud_fallback_run_usd: 0.25, local_cloud_fallback_daily_usd: 0.60,
      },
      {
        plan_id: 'pro', local_operations_hourly: 20, local_operations_daily: 100,
        longform_scripts_daily: 6, active_content_jobs: 1,
        ordinary_context_tokens: 8192, content_context_tokens: 12288,
        script_segment_output_tokens: 5120, local_queue_weight: 1,
        local_cloud_fallback_run_usd: 0.15, local_cloud_fallback_daily_usd: 0.40,
      },
    ]);
    expect(db.prepare(`SELECT plan_id, local_operations_daily
      FROM plan_configs WHERE plan_id IN ('free', 'beta') ORDER BY plan_id`).all()).toEqual([
      { plan_id: 'beta', local_operations_daily: 0 },
      { plan_id: 'free', local_operations_daily: 0 },
    ]);
    expect(db.prepare(`SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'migration_284_plan_configs_preimage'`).get())
      .toBeUndefined();
    expect(() => db.prepare(`INSERT INTO local_inference_account_deletion_fences (
      user_id, fence_token, runtime_instance_id, expires_at
    ) VALUES (42, ?, ?, ?)`).run(
      '00000000-0000-4000-8000-000000000042',
      '00000000-0000-4000-8000-000000000099',
      Date.now() + 60_000,
    ))
      .not.toThrow();
    expect(() => db.prepare(`INSERT INTO local_inference_account_deletion_fences (
      user_id, fence_token, runtime_instance_id, expires_at
    ) VALUES (43, 'not-a-uuid', 'not-an-instance', 1)`).run()).toThrow();
    db.close();
  });

  it('keeps inference telemetry content-free and script payloads tenant-owned', () => {
    const db = database();
    db.exec(upSql);
    db.prepare(`INSERT INTO skill_inference_runs (
      run_id, operation_id, tenant_id, user_id, plan_id, skill_id, task_type,
      risk_class, execution_class, local_admission_requested, profile_version, status, schema_id,
      context_limit_tokens, output_limit_tokens
    ) VALUES ('run-1', 'operation-1', 42, 42, 'pro', 'content', 'script',
      'low', 'background', 1, 'v1', 'admitted', 'content_script', 12288, 5120)`).run();
    const columns = db.prepare(`PRAGMA table_info(skill_inference_runs)`).all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).not.toContain('prompt');
    expect(columns.map((column) => column.name)).not.toContain('output_text');

    db.prepare(`INSERT INTO content_script_jobs (
      job_id, tenant_id, owner_user_id, plan_id, idempotency_key, request_hash,
      operation_id, request_json, status
    ) VALUES ('job-1', 42, 42, 'pro', 'idem-1', ?, 'operation-1', ?, 'queued')`)
      .run('a'.repeat(64), JSON.stringify({ schema: 'encrypted', ciphertext: 'opaque' }));
    expect(() => db.prepare(`INSERT INTO content_script_jobs (
      job_id, tenant_id, owner_user_id, plan_id, idempotency_key, request_hash,
      operation_id, request_json, status
    ) VALUES ('job-uppercase-hash', 42, 42, 'pro', 'idem-2', ?, 'operation-2', '{}', 'queued')`)
      .run('A'.repeat(64))).toThrow();
    expect(db.prepare(`SELECT fair_use_admitted_at, infrastructure_requeue_count,
        final_repair_count, next_attempt_at
      FROM content_script_jobs
      WHERE job_id = 'job-1'`).get()).toEqual({
        fair_use_admitted_at: expect.any(String),
        infrastructure_requeue_count: 0,
        final_repair_count: 0,
        next_attempt_at: null,
      });
    expect(() => db.prepare(`INSERT INTO content_script_job_checkpoints (
      job_id, section_index, section_key, state, word_budget
    ) VALUES ('job-1', 0, 'outline', 'unexpected_state', 100)`).run()).toThrow();
    expect(db.prepare(`SELECT job_id FROM content_script_jobs
      WHERE tenant_id = 7 AND owner_user_id = 7`).get()).toBeUndefined();
    db.close();
  });

  it('has an isolated inverse while production rollback remains mode-off', () => {
    const db = database();
    db.prepare(`UPDATE plan_configs SET updated_at = CASE plan_id
      WHEN 'pro' THEN '2026-01-01T01:02:03.000Z'
      WHEN 'max' THEN '2026-01-02T01:02:03.000Z'
      ELSE '2026-01-03T01:02:03.000Z' END`).run();
    const updatedAtPreimage = db.prepare(`SELECT plan_id, updated_at FROM plan_configs
      ORDER BY plan_id`).all();
    db.exec(upSql);
    db.exec(downSql);
    expect(db.prepare(`SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'skill_inference_runs'`).get()).toBeUndefined();
    expect(db.prepare(`SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'local_inference_control_events'`).get()).toBeUndefined();
    expect(db.prepare(`SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'local_inference_account_deletion_fences'`).get()).toBeUndefined();
    const columns = db.prepare('PRAGMA table_info(plan_configs)').all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).not.toContain('local_operations_daily');
    expect(db.prepare(`SELECT plan_id, updated_at FROM plan_configs ORDER BY plan_id`).all())
      .toEqual(updatedAtPreimage);
    expect(db.prepare(`SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'migration_284_plan_configs_preimage'`).get())
      .toBeUndefined();
    db.close();
  });
});
// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
