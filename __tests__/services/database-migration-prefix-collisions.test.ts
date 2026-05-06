import { describe, expect, it } from 'vitest';
import {
  assertNoUnexpectedMigrationPrefixCollisions,
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
