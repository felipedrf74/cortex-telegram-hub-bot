import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

function envWithoutMigrationEvidence() {
  const env = { ...process.env };
  delete env.NEXUS_MIGRATION_APPROVER;
  delete env.NEXUS_MIGRATION_BACKUP_EVIDENCE;
  return env;
}

describe('migration-safety-check', () => {
  it('blocks changed irreversible migrations without backup evidence and approver', () => {
    const result = spawnSync(
      'node',
      [
        'scripts/migration-safety-check.mjs',
        '--changed-only',
        '--files',
        'migrations/200_content_radar_phase0_rollout_guards.sql',
        '--json',
      ],
      { encoding: 'utf8', env: envWithoutMigrationEvidence() },
    );

    expect(result.status).toBe(1);
    const payload = JSON.parse(result.stdout) as { errors: string[] };
    expect(payload.errors.some((error) => error.startsWith('irreversible_migration_fast_path_blocked'))).toBe(true);
  });

  it('allows changed irreversible migrations when backup evidence and approver are recorded', () => {
    const result = spawnSync(
      'node',
      [
        'scripts/migration-safety-check.mjs',
        '--changed-only',
        '--files',
        'migrations/200_content_radar_phase0_rollout_guards.sql',
        '--json',
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          NEXUS_MIGRATION_APPROVER: 'release-owner',
          NEXUS_MIGRATION_BACKUP_EVIDENCE: 'manual-db-backup-2026-06-04',
        },
      },
    );

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      checks: { changedIrreversiblePolicy: boolean };
      irreversibleChangedMigrations: Array<{ file: string }>;
    };
    expect(payload.checks.changedIrreversiblePolicy).toBe(true);
    expect(payload.irreversibleChangedMigrations).toContainEqual({
      file: 'migrations/200_content_radar_phase0_rollout_guards.sql',
      reason: 'DROP TABLE',
    });
  });
});
