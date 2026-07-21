// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
//
// Chat M20 — migration 257 (chat_v2_route_exit_samples) idempotency + down.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');
const UP = readFileSync(path.join(MIGRATIONS_DIR, '257_chat_v2_route_exit_samples.sql'), 'utf8');
const DOWN = readFileSync(path.join(MIGRATIONS_DIR, 'down', '257_chat_v2_route_exit_samples.sql'), 'utf8');

function tableNames(db: Database.Database): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>)
    .map((row) => row.name);
}

describe('migration 257 — chat_v2_route_exit_samples', () => {
  it('is applied by the migration runner and is idempotent on re-exec', () => {
    const db = createMigratedTestDatabase();
    try {
      expect(tableNames(db)).toEqual(expect.arrayContaining(['chat_v2_route_exit_samples']));
      // The high-water-mark state table from earlier drafts must NOT exist:
      // both source tables upsert in place, so sync is a full rescan.
      expect(tableNames(db)).not.toEqual(expect.arrayContaining(['chat_v2_route_exit_sampler_state']));
      // Re-applying the file is a no-op (CREATE IF NOT EXISTS throughout).
      expect(() => db.exec(UP)).not.toThrow();
      expect(() => db.exec(UP)).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('enforces source/kind/parity CHECK constraints and natural-key dedupe', () => {
    const db = new Database(':memory:');
    try {
      db.exec(UP);
      const insert = db.prepare(`
        INSERT INTO chat_v2_route_exit_samples (
          source, source_row_id, source_key, route_id, kind, parity, health_ok, sampled_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const at = '2026-07-20T00:00:00.000Z';
      // Parity rows: 1 / 0 / NULL (parity_unknown) are all valid.
      insert.run('shadow_replay_bundle', 1, 'bundle-1', 'chat_message_shortcut_after_route', 'parity', 1, null, at);
      insert.run('shadow_replay_bundle', 2, 'bundle-2', 'chat_message_shortcut_after_route', 'parity', 0, null, at);
      insert.run('shadow_replay_bundle', 3, 'bundle-3', 'chat_message_shortcut_after_route', 'parity', null, null, at);
      // Health rows carry health_ok, never parity.
      insert.run('online_eval_sample', 4, 'sample-1', 'chat_reasoning_engine_v1', 'health', null, 1, at);
      insert.run('online_eval_sample', 5, 'sample-2', 'chat_reasoning_engine_v1', 'health', null, 0, at);
      // Constraint violations.
      expect(() => insert.run('bad_source', 6, 'x', 'r', 'parity', 1, null, at)).toThrow(/CHECK/);
      expect(() => insert.run('eval_history_scenario', 7, 'y', 'r', 'parity', 1, null, at)).toThrow(/CHECK/);
      expect(() => insert.run('shadow_replay_bundle', 8, 'z', 'r', 'bad_kind', 1, null, at)).toThrow(/CHECK/);
      expect(() => insert.run('shadow_replay_bundle', 9, 'w', 'r', 'parity', 2, null, at)).toThrow(/CHECK/);
      // Health rows must not claim parity; parity rows must not claim health_ok.
      expect(() => insert.run('online_eval_sample', 10, 'v', 'r', 'health', 1, null, at)).toThrow(/CHECK/);
      expect(() => insert.run('shadow_replay_bundle', 11, 'u', 'r', 'parity', 1, 1, at)).toThrow(/CHECK/);
      // Natural-key dedupe.
      expect(() => insert.run('shadow_replay_bundle', 12, 'bundle-1', 'r', 'parity', 1, null, at)).toThrow(/UNIQUE/);
    } finally {
      db.close();
    }
  });

  it('down migration drops the table and up recreates it', () => {
    const db = new Database(':memory:');
    try {
      db.exec(UP);
      db.exec(DOWN);
      expect(tableNames(db)).not.toEqual(expect.arrayContaining(['chat_v2_route_exit_samples']));
      // Down is itself idempotent, and up restores the schema.
      expect(() => db.exec(DOWN)).not.toThrow();
      db.exec(UP);
      expect(tableNames(db)).toEqual(expect.arrayContaining(['chat_v2_route_exit_samples']));
    } finally {
      db.close();
    }
  });
});
