// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';

const DOWN = readFileSync(resolve(process.cwd(), 'migrations/down/245_content_workspace_observability.sql'), 'utf8');
const ROLLOUT_DOWN = readFileSync(resolve(process.cwd(), 'migrations/down/248_content_workspace_rollout_observability.sql'), 'utf8');
const TABLES = [
  'content_workspace_reliability_metrics',
  'content_workspace_operation_metrics',
  'content_workspace_reason_metrics',
  'content_workspace_product_metrics',
  'content_workspace_quality_metrics',
] as const;

describe('migration 245 durable Content workspace observability', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createMigratedTestDatabase();
  });

  afterEach(() => db.close());

  it('creates only closed, aggregate-only metric schemas', () => {
    const names = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
      .map((row) => row.name));
    for (const table of TABLES) expect(names.has(table)).toBe(true);

    const forbidden = ['tenant', 'user', 'content', 'prompt', 'url', 'hash', 'fingerprint', 'payload', 'provider_response', 'timestamp'];
    for (const table of TABLES) {
      const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name);
      const serialized = columns.join(' ').toLowerCase();
      for (const fragment of forbidden) expect(serialized).not.toContain(fragment);
    }
  });

  it('accepts valid closed metrics and rejects unknown or unsafe values', () => {
    db.prepare(`
      INSERT INTO content_workspace_reliability_metrics (counter_name, metric_value)
      VALUES ('schedule_confirm_success_total', 1)
    `).run();
    db.prepare(`
      INSERT INTO content_workspace_reason_metrics (reason, metric_value)
      VALUES ('schedule_slot_changed', 2)
    `).run();
    db.prepare(`
      INSERT INTO content_workspace_product_metrics (signal, metric_value)
      VALUES ('content_scheduled', 3)
    `).run();
    db.prepare(`
      INSERT INTO content_workspace_quality_metrics (signal, metric_value)
      VALUES ('factuality_warning', 4)
    `).run();
    db.prepare(`
      INSERT INTO content_workspace_operation_metrics (operation, blocked_count)
      VALUES ('rollout_gate', 5)
    `).run();
    db.prepare(`
      INSERT INTO content_workspace_reason_metrics (reason, metric_value)
      VALUES ('rollout_write_disabled', 5)
    `).run();
    db.prepare(`
      INSERT INTO content_workspace_product_metrics (signal, metric_value)
      VALUES ('legacy_topics_compatibility_mutation', 6)
    `).run();

    expect(() => db.prepare(`
      INSERT INTO content_workspace_reliability_metrics (counter_name, metric_value) VALUES ('private_payload', 1)
    `).run()).toThrow(/CHECK constraint failed/i);
    expect(() => db.prepare(`
      INSERT INTO content_workspace_reason_metrics (reason, metric_value) VALUES ('raw_error_message', 1)
    `).run()).toThrow(/CHECK constraint failed/i);
    expect(() => db.prepare(`
      INSERT INTO content_workspace_product_metrics (signal, metric_value) VALUES ('content_scheduled', -1)
    `).run()).toThrow(/CHECK constraint failed/i);
    expect(() => db.prepare(`
      INSERT INTO content_workspace_quality_metrics (signal, metric_value) VALUES ('brand_voice_warning', 9007199254740992)
    `).run()).toThrow(/CHECK constraint failed/i);
  });

  it('enforces timer bucket/count and min/max integrity', () => {
    db.prepare(`
      INSERT INTO content_workspace_operation_metrics (
        operation, success_count, timer_count, timer_total_ms,
        timer_min_ms, timer_max_ms, bucket_lt_50_ms
      ) VALUES ('schedule_preview', 1, 1, 20, 20, 20, 1)
    `).run();
    expect(() => db.prepare(`
      INSERT INTO content_workspace_operation_metrics (
        operation, timer_count, timer_total_ms, timer_min_ms, timer_max_ms
      ) VALUES ('schedule_confirm', 1, 20, 20, 20)
    `).run()).toThrow(/CHECK constraint failed/i);
    expect(() => db.prepare(`
      INSERT INTO content_workspace_operation_metrics (
        operation, timer_count, timer_total_ms, timer_min_ms, timer_max_ms, bucket_lt_50_ms
      ) VALUES ('schedule_cancel', 1, 10, 30, 10, 1)
    `).run()).toThrow(/CHECK constraint failed/i);
  });

  it('reverses only the disposable rollout taxonomy while preserving older totals', () => {
    db.prepare(`INSERT INTO content_workspace_product_metrics (signal, metric_value) VALUES ('idea_captured', 7)`).run();
    db.prepare(`INSERT INTO content_workspace_product_metrics (signal, metric_value) VALUES ('legacy_pipeline_compatibility_read', 3)`).run();
    db.prepare(`INSERT INTO content_workspace_operation_metrics (operation, blocked_count) VALUES ('rollout_gate', 3)`).run();

    db.exec(ROLLOUT_DOWN);

    expect(db.prepare(`SELECT metric_value FROM content_workspace_product_metrics WHERE signal = 'idea_captured'`).get())
      .toEqual({ metric_value: 7 });
    expect(db.prepare(`SELECT metric_value FROM content_workspace_product_metrics WHERE signal = 'legacy_pipeline_compatibility_read'`).get())
      .toBeUndefined();
    expect(db.prepare(`SELECT * FROM content_workspace_operation_metrics WHERE operation = 'rollout_gate'`).get())
      .toBeUndefined();
    expect(() => db.prepare(`
      INSERT INTO content_workspace_reason_metrics (reason, metric_value) VALUES ('rollout_write_disabled', 1)
    `).run()).toThrow(/CHECK constraint failed/i);
  });

  it('rolls back only the five disposable aggregate tables', () => {
    db.exec(DOWN);
    const names = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
      .map((row) => row.name));
    for (const table of TABLES) expect(names.has(table)).toBe(false);
    expect(names.has('content_domain_objects')).toBe(true);
    expect(names.has('content_revisions')).toBe(true);
    expect(names.has('content_schedule_bindings')).toBe(true);
  });
});
