// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';

const UP = readFileSync(
  resolve(process.cwd(), 'migrations/303_training_coach_v2_contracts.sql'),
  'utf8',
);
const DOWN = readFileSync(
  resolve(process.cwd(), 'migrations/down/303_training_coach_v2_contracts.sql'),
  'utf8',
);

function columns(db: ReturnType<typeof createMigratedTestDatabase>, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((row) => row.name);
}

describe('migration 303 — Training Coach V2 contracts', () => {
  it('applies, reverses, and re-applies without leaving dependent schema behind', () => {
    const db = createMigratedTestDatabase({
      excludeFiles: [
        '303_training_coach_v2_contracts.sql',
        '305_training_coach_v2_soak_metrics.sql',
      ],
    });
    try {
      expect(columns(db, 'fitness_training_plans')).not.toContain('coach_plan_policy_version');

      db.exec(UP);
      expect(columns(db, 'fitness_training_plans')).toContain('coach_plan_policy_version');
      expect(columns(db, 'travel_windows')).toEqual(expect.arrayContaining([
        'version', 'updated_at', 'idempotency_key', 'request_hash',
      ]));
      expect(columns(db, 'athlete_health_signals')).toEqual(expect.arrayContaining([
        'expires_at', 'idempotency_key', 'request_hash',
      ]));
      expect(columns(db, 'health_data_mutation_receipts')).toEqual(expect.arrayContaining([
        'tenant_id', 'user_id', 'operation', 'idempotency_key', 'request_hash', 'response_json',
      ]));
      expect(db.prepare(`
        SELECT name FROM sqlite_master
         WHERE type = 'table' AND name LIKE 'training_coach_v2_%'
         ORDER BY name
      `).all()).toEqual([
        { name: 'training_coach_v2_proposals' },
        { name: 'training_coach_v2_reflow_previews' },
      ]);
      expect(db.pragma('foreign_key_check')).toEqual([]);

      db.exec(DOWN);
      expect(columns(db, 'fitness_training_plans')).not.toContain('coach_plan_policy_version');
      expect(columns(db, 'travel_windows')).not.toContain('version');
      expect(columns(db, 'athlete_health_signals')).not.toContain('expires_at');
      expect(db.prepare(`
        SELECT name FROM sqlite_master
         WHERE type = 'table' AND name = 'health_data_mutation_receipts'
      `).get()).toBeUndefined();
      expect(db.prepare(`
        SELECT name FROM sqlite_master
         WHERE type = 'table' AND name LIKE 'training_coach_v2_%'
      `).all()).toEqual([]);
      expect(db.pragma('foreign_key_check')).toEqual([]);

      db.exec(UP);
      expect(columns(db, 'fitness_training_plans')).toContain('coach_plan_policy_version');
      expect(columns(db, 'training_coach_v2_proposals')).toEqual(expect.arrayContaining([
        'client_request_hash', 'preview_id', 'proposed_revision_id',
      ]));
      expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('stores composite ownership without coupling rollback to predecessor tables', () => {
    const db = createMigratedTestDatabase();
    try {
      const correctionFks = db.pragma('foreign_key_list(athlete_health_signal_corrections)') as Array<{
        table: string; from: string; to: string;
      }>;
      expect(correctionFks).toEqual([]);
      expect(columns(db, 'athlete_health_signal_corrections')).toEqual(expect.arrayContaining([
        'tenant_id', 'user_id', 'signal_id', 'idempotency_key', 'request_hash',
      ]));

      const proposalFks = db.pragma('foreign_key_list(training_coach_v2_proposals)') as Array<{
        table: string; from: string; to: string;
      }>;
      expect(proposalFks).toEqual([]);
      expect(columns(db, 'training_coach_v2_proposals')).toEqual(expect.arrayContaining([
        'tenant_id', 'user_id', 'plan_id', 'week_id', 'preview_id', 'proposed_revision_id',
      ]));
    } finally {
      db.close();
    }
  });
});
