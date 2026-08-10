import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadProductionMigrationLineagePolicy,
  PRODUCTION_MIGRATION_LINEAGE_SCHEMA,
  resolveProductionMigrationLineage,
  verifyProductionMigrationLineageHistory,
} from '../../scripts/lib/production-migration-lineage.mjs';

const ROOT = resolve(process.cwd());

describe('production migration lineage policy', () => {
  let temporaryRoot = '';

  afterEach(() => {
    if (temporaryRoot) rmSync(temporaryRoot, { recursive: true, force: true });
    temporaryRoot = '';
  });

  function copyPolicyRoot() {
    temporaryRoot = mkdtempSync(join(tmpdir(), 'nexus-production-lineage-'));
    mkdirSync(join(temporaryRoot, 'config'));
    mkdirSync(join(temporaryRoot, 'migrations'));
    cpSync(
      join(ROOT, 'config/production-migration-lineages.json'),
      join(temporaryRoot, 'config/production-migration-lineages.json'),
    );
    const parsed = JSON.parse(readFileSync(
      join(ROOT, 'config/production-migration-lineages.json'),
      'utf8',
    ));
    for (const entry of parsed.lineages.flatMap((lineage: any) => lineage.migrations)) {
      cpSync(
        join(ROOT, 'migrations', entry.replacement.file),
        join(temporaryRoot, 'migrations', entry.replacement.file),
      );
    }
    for (const file of ['058_composite_unique_constraints.sql', '283_release_schema_convergence.sql']) {
      cpSync(join(ROOT, 'migrations', file), join(temporaryRoot, 'migrations', file));
    }
    return parsed;
  }

  it('loads the signed replacement inventory and resolves only canonical or exact retired sets', () => {
    const policy = loadProductionMigrationLineagePolicy({ root: ROOT });
    expect(policy.schema).toBe(PRODUCTION_MIGRATION_LINEAGE_SCHEMA);
    expect(policy.schema).toBe('nexus.production-migration-lineages.v3');
    expect(policy.releaseReconciliation.schema)
      .toBe('nexus.release-migration-reconciliation.v2');
    expect(policy.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(policy.lineages).toHaveLength(2);
    expect(policy.lineages[0]).toMatchObject({
      id: 'production-2026-05-branch-history',
      migrationCount: 19,
    });
    const canonical = resolveProductionMigrationLineage(policy, []);
    expect(canonical).toMatchObject({ id: 'canonical', migrationCount: 0 });
    expect(resolveProductionMigrationLineage(
      policy,
      [...policy.lineages[0].migrationFiles].reverse(),
    )).toBe(policy.lineages[0]);
    expect(resolveProductionMigrationLineage(
      policy,
      policy.lineages[0].migrationFiles.slice(1),
    )).toBeNull();
    expect(resolveProductionMigrationLineage(policy, ['999_unknown.sql'])).toBeNull();
    expect(policy.releaseReconciliation.environments.production.legacyRows).toHaveLength(19);
    expect(policy.releaseReconciliation.environments.staging.legacyRows).toHaveLength(23);
    expect(policy.releaseReconciliation.environments.production.legacyRows)
      .toContainEqual(expect.objectContaining({
        file: '136_training_session_schedule_truth.sql',
        replacement: expect.objectContaining({
          file: '255_training_session_schedule_truth_reconciliation.sql',
        }),
      }));
    expect(policy.releaseReconciliation.environments.staging.legacyRows)
      .toContainEqual(expect.objectContaining({
        file: '228_notification_correctness_phase0.sql',
        replacement: expect.objectContaining({ file: '268_notification_correctness_phase0.sql' }),
      }));
    expect(policy.releaseReconciliation.compatibilityExemptions[0].allowedDropIndexes)
      .toEqual([
        expect.objectContaining({
          name: 'idx_ref_channels_url',
          tableName: 'content_ref_channels',
          columns: ['channel_url'],
          unique: true,
          allowAbsent: true,
          replacement: expect.objectContaining({
            name: 'idx_content_ref_channels_user_url',
            tableName: 'content_ref_channels',
            columns: ['user_id', 'channel_url'],
            unique: true,
          }),
        }),
        expect.objectContaining({ name: 'idx_transcript_video' }),
        expect.objectContaining({ name: 'idx_vendor_sender' }),
      ]);
  });

  it('proves every retired digest from its exact source commit before signing', () => {
    const policy = loadProductionMigrationLineagePolicy({ root: ROOT });
    expect(verifyProductionMigrationLineageHistory({
      policy,
      readHistoricalMigration: ({ commit, file }: { commit: string; file: string }) => (
        execFileSync('git', ['show', `${commit}:migrations/${file}`], { cwd: ROOT })
      ),
      readReplacementMigration: ({ file }: { file: string }) => (
        readFileSync(join(ROOT, 'migrations', file))
      ),
    })).toEqual({ verifiedCount: 23 });
    expect(() => verifyProductionMigrationLineageHistory({
      policy,
      readHistoricalMigration: () => Buffer.from('-- forged\n'),
      readReplacementMigration: ({ file }: { file: string }) => (
        readFileSync(join(ROOT, 'migrations', file))
      ),
    })).toThrow(/digest does not match its source commit/);
  });

  it('rejects executable SQL drift behind a comment-only relationship', () => {
    const retired = Buffer.from('-- retired number\nCREATE TABLE x (id INTEGER);\n');
    const replacement = Buffer.from('-- current number\nCREATE TABLE x (id TEXT);\n');
    const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
    const policy = {
      lineages: [{
        migrations: [{
          file: '001_x.sql',
          sha256: digest(retired),
          sourceCommit: 'a'.repeat(40),
          replacement: {
            file: '002_x.sql',
            sha256: digest(replacement),
            relationship: 'comment_only_renumber',
          },
        }],
      }],
    };
    expect(() => verifyProductionMigrationLineageHistory({
      policy,
      readHistoricalMigration: () => retired,
      readReplacementMigration: () => replacement,
    })).toThrow(/comment-only replacement changes executable SQL/);
  });

  it('rejects replacement tampering and executable retired files', () => {
    const parsed = copyPolicyRoot();
    const first = parsed.lineages[0].migrations[0];
    writeFileSync(join(temporaryRoot, 'migrations', first.replacement.file), '-- tampered\n');
    expect(() => loadProductionMigrationLineagePolicy({ root: temporaryRoot }))
      .toThrow(`replacement migration digest mismatch: ${first.replacement.file}`);

    cpSync(
      join(ROOT, 'migrations', first.replacement.file),
      join(temporaryRoot, 'migrations', first.replacement.file),
    );
    writeFileSync(join(temporaryRoot, 'migrations', first.file), '-- must remain retired\n');
    expect(() => loadProductionMigrationLineagePolicy({ root: temporaryRoot }))
      .toThrow(`retired migration remains executable: ${first.file}`);
  });

  it('rejects malformed, unsorted, duplicate, and path-escaping policy entries', () => {
    for (const mutate of [
      (value: any) => { value.schema = 'wrong'; },
      (value: any) => { value.lineages[0].migrations.reverse(); },
      (value: any) => { value.lineages[0].migrations[1].file = value.lineages[0].migrations[0].file; },
      (value: any) => { value.lineages[0].migrations[0].file = '../escape.sql'; },
      (value: any) => { value.lineages[0].migrations[0].sourceCommit = 'not-a-commit'; },
    ]) {
      const parsed = copyPolicyRoot();
      mutate(parsed);
      writeFileSync(
        join(temporaryRoot, 'config/production-migration-lineages.json'),
        `${JSON.stringify(parsed)}\n`,
      );
      expect(() => loadProductionMigrationLineagePolicy({ root: temporaryRoot })).toThrow();
      rmSync(temporaryRoot, { recursive: true, force: true });
      temporaryRoot = '';
    }
  });

  it('rejects any digest or scope drift in the one-time compatibility exemption', () => {
    for (const mutate of [
      (value: any) => { value.release.compatibilityExemptions[0].sha256 = '0'.repeat(64); },
      (value: any) => { value.release.compatibilityExemptions[0].allowedDropIndexes.pop(); },
      (value: any) => {
        value.release.compatibilityExemptions[0].allowedDropIndexes[0].tableName = 'wrong_table';
      },
      (value: any) => {
        value.release.compatibilityExemptions[0]
          .allowedDropIndexes[0].replacement.columns.reverse();
      },
      (value: any) => { value.release.environmentLineages.staging.pop(); },
    ]) {
      const parsed = copyPolicyRoot();
      mutate(parsed);
      writeFileSync(
        join(temporaryRoot, 'config/production-migration-lineages.json'),
        `${JSON.stringify(parsed)}\n`,
      );
      expect(() => loadProductionMigrationLineagePolicy({ root: temporaryRoot })).toThrow();
      rmSync(temporaryRoot, { recursive: true, force: true });
      temporaryRoot = '';
    }
  });

  it('binds replacement names to exact unique table and ordered-column definitions', () => {
    copyPolicyRoot();
    const migration = join(temporaryRoot, 'migrations', '058_composite_unique_constraints.sql');
    writeFileSync(
      migration,
      readFileSync(migration, 'utf8').replace(
        'ON content_ref_channels(user_id, channel_url)',
        'ON content_ref_channels(channel_url, user_id)',
      ),
    );
    expect(() => loadProductionMigrationLineagePolicy({ root: temporaryRoot }))
      .toThrow(/no exact governed replacement index/);
  });
});
