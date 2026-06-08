import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  assertNoUnexpectedMigrationPrefixCollisions,
  filterAlreadyAppliedAddColumnStatements,
  findUnexpectedMigrationPrefixCollisions,
} from '../../src/services/database';

describe('database migration prefix collision lint', () => {
  it('does not report the known historical duplicate migration prefixes', () => {
    const collisions = findUnexpectedMigrationPrefixCollisions([
      '001_initial.sql',
      '008_api_cache.sql',
      '008_email_log.sql',
      '009_api_usage_provider.sql',
      '009_job_history.sql',
      '022_finance_tables.sql',
      '022_webhook_events.sql',
      '023_fitness_training_plans.sql',
      '023_onboarding.sql',
      '024_cooking_tables.sql',
      '024_usage_metering.sql',
    ]);

    expect(collisions).toEqual([]);
  });

  it('reports when a new duplicate numeric prefix is introduced', () => {
    const collisions = findUnexpectedMigrationPrefixCollisions([
      '107_new_feature.sql',
      '107_other_feature.sql',
    ]);

    expect(collisions).toEqual([
      {
        prefix: '107',
        files: ['107_new_feature.sql', '107_other_feature.sql'],
      },
    ]);
  });

  it('reports when a historical duplicate group gains an unexpected file', () => {
    const collisions = findUnexpectedMigrationPrefixCollisions([
      '008_api_cache.sql',
      '008_email_log.sql',
      '008_new_surprise.sql',
    ]);

    expect(collisions).toEqual([
      {
        prefix: '008',
        files: ['008_api_cache.sql', '008_email_log.sql', '008_new_surprise.sql'],
      },
    ]);
  });

  it('throws before startup can apply migrations with a new prefix collision', () => {
    expect(() =>
      assertNoUnexpectedMigrationPrefixCollisions([
        '108_first.sql',
        '108_second.sql',
      ]),
    ).toThrow(/Unexpected migration prefix collision\(s\): 108/);
  });

  it('allows startup when only legacy duplicate prefixes are present', () => {
    expect(() =>
      assertNoUnexpectedMigrationPrefixCollisions([
        '008_api_cache.sql',
        '008_email_log.sql',
        '009_api_usage_provider.sql',
        '009_job_history.sql',
      ]),
    ).not.toThrow();
  });
});

describe('database migration duplicate ADD COLUMN guard', () => {
  it('skips duplicate ADD COLUMN statements even when the migration formats them across multiple lines', () => {
    const filtered = filterAlreadyAppliedAddColumnStatements(
      `
        CREATE TABLE IF NOT EXISTS fitness_training_plans (id INTEGER PRIMARY KEY);

        ALTER TABLE fitness_training_plans
          ADD COLUMN adaptation_revision INTEGER NOT NULL DEFAULT 0;

        CREATE INDEX IF NOT EXISTS idx_training_plan_adaptation_revision
          ON fitness_training_plans(adaptation_revision);
      `,
      (table, column) => table === 'fitness_training_plans' && column === 'adaptation_revision',
    );

    expect(filtered).toContain('CREATE TABLE IF NOT EXISTS fitness_training_plans');
    expect(filtered).toContain('CREATE INDEX IF NOT EXISTS idx_training_plan_adaptation_revision');
    expect(filtered).not.toMatch(/ADD\s+COLUMN\s+adaptation_revision/i);
  });

  it('preserves multiline ADD COLUMN statements for columns that are not already present', () => {
    const filtered = filterAlreadyAppliedAddColumnStatements(
      `
        ALTER TABLE fitness_training_plans
          ADD COLUMN adaptation_revision INTEGER NOT NULL DEFAULT 0;
      `,
      () => false,
    );

    expect(filtered).toMatch(/ALTER\s+TABLE\s+fitness_training_plans\s+ADD\s+COLUMN\s+adaptation_revision/i);
  });

  it('makes migration 204 idempotent for Secretary reminder schema hardening columns', () => {
    const migration204 = fs.readFileSync(
      path.resolve(__dirname, '../../migrations/204_secretary_reminder_schema_hardening.sql'),
      'utf8',
    );
    const filtered = filterAlreadyAppliedAddColumnStatements(
      migration204,
      (table, column) => (
        table === 'secretary_agenda_items' && column === 'reasoning_trail_json'
      ) || (
        table === 'reminders' && (column === 'tenant_id' || column === 'timezone')
      ),
    );

    expect(filtered).not.toMatch(/ADD\s+COLUMN\s+reasoning_trail_json/i);
    expect(filtered).not.toMatch(/ADD\s+COLUMN\s+tenant_id/i);
    expect(filtered).not.toMatch(/ADD\s+COLUMN\s+timezone/i);
    expect(filtered).toContain('UPDATE reminders');
    expect(filtered).toContain('idx_reminders_tenant_user_status');
  });
});
