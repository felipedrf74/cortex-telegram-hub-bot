import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadProductionMigrationLineagePolicy,
  PRODUCTION_MIGRATION_LINEAGE_SCHEMA,
  readRepositoryArchiveFromGitIndex,
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
    mkdirSync(
      join(temporaryRoot, 'docs/release/evidence/retired-migrations'),
      { recursive: true },
    );
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
      if (entry.sourceMode === 'repository_archive') {
        mkdirSync(dirname(join(temporaryRoot, entry.sourcePath)), { recursive: true });
        cpSync(
          join(ROOT, entry.sourcePath),
          join(temporaryRoot, entry.sourcePath),
        );
      }
    }
    for (const file of ['058_composite_unique_constraints.sql', '283_release_schema_convergence.sql']) {
      cpSync(join(ROOT, 'migrations', file), join(temporaryRoot, 'migrations', file));
    }
    return parsed;
  }

  it('loads the signed replacement inventory and resolves only canonical or exact retired sets', () => {
    const policy = loadProductionMigrationLineagePolicy({ root: ROOT });
    expect(policy.schema).toBe(PRODUCTION_MIGRATION_LINEAGE_SCHEMA);
    expect(policy.schema).toBe('nexus.production-migration-lineages.v4');
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
    const archived = policy.lineages
      .flatMap((lineage: any) => lineage.migrations)
      .find((migration: any) => migration.file === '136_training_session_schedule_truth.sql');
    expect(archived).toMatchObject({
      sourceCommit: 'cb2c262ff1f77f55ccee6267e7cf1d1970b1ff05',
      sourceMode: 'repository_archive',
      sourcePath:
        'docs/release/evidence/retired-migrations/'
        + 'cb2c262ff1f77f55ccee6267e7cf1d1970b1ff05/'
        + '136_training_session_schedule_truth.sql',
    });
    const projected = policy.releaseReconciliation.environments.production.legacyRows
      .find((migration: any) => migration.file === '136_training_session_schedule_truth.sql');
    expect(projected).not.toHaveProperty('sourceMode');
    expect(projected).not.toHaveProperty('sourcePath');
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

  it('proves every retired digest from its exact hosted source before signing', () => {
    const policy = loadProductionMigrationLineagePolicy({ root: ROOT });
    expect(verifyProductionMigrationLineageHistory({
      policy,
      readHistoricalMigration: ({ commit, sourcePath }: {
        commit: string;
        sourcePath: string;
      }) => (
        execFileSync('git', ['show', `${commit}:${sourcePath}`], { cwd: ROOT })
      ),
      readRepositoryArchive: ({ sourcePath }: { sourcePath: string }) => (
        readFileSync(join(ROOT, sourcePath))
      ),
      readReplacementMigration: ({ file }: { file: string }) => (
        readFileSync(join(ROOT, 'migrations', file))
      ),
    })).toEqual({ verifiedCount: 23 });
    expect(() => verifyProductionMigrationLineageHistory({
      policy,
      readHistoricalMigration: () => Buffer.from('-- forged\n'),
      readRepositoryArchive: ({ sourcePath }: { sourcePath: string }) => (
        readFileSync(join(ROOT, sourcePath))
      ),
      readReplacementMigration: ({ file }: { file: string }) => (
        readFileSync(join(ROOT, 'migrations', file))
      ),
    })).toThrow(/digest does not match its source commit/);
    expect(() => verifyProductionMigrationLineageHistory({
      policy,
      readHistoricalMigration: ({ commit, sourcePath }: {
        commit: string;
        sourcePath: string;
      }) => execFileSync('git', ['show', `${commit}:${sourcePath}`], { cwd: ROOT }),
      readRepositoryArchive: () => Buffer.from('-- forged archive\n'),
      readReplacementMigration: ({ file }: { file: string }) => (
        readFileSync(join(ROOT, 'migrations', file))
      ),
    })).toThrow(/digest does not match its repository archive/);
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
      readRepositoryArchive: () => retired,
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

  it('loads archive locators when runtime release bundles omit documentation evidence', () => {
    const parsed = copyPolicyRoot();
    rmSync(join(temporaryRoot, 'docs'), { recursive: true, force: true });
    const policy = loadProductionMigrationLineagePolicy({ root: temporaryRoot });
    expect(policy.lineages.flatMap((lineage: any) => lineage.migrations))
      .toContainEqual(expect.objectContaining({
        file: parsed.lineages[0].migrations[1].file,
        sourceMode: 'repository_archive',
      }));
  });

  it('reads archive bytes only from one regular staged Git entry', () => {
    temporaryRoot = mkdtempSync(join(tmpdir(), 'nexus-production-archive-index-'));
    const git = (...args: string[]) => execFileSync('git', args, {
      cwd: temporaryRoot,
      encoding: 'utf8',
    }).trim();
    git('init', '--initial-branch=main');
    const sourceCommit = 'a'.repeat(40);
    const file = '900_retired_fixture.sql';
    const sourcePath = `docs/release/evidence/retired-migrations/${sourceCommit}/${file}`;
    const archivePath = join(temporaryRoot, sourcePath);
    mkdirSync(dirname(archivePath), { recursive: true });
    writeFileSync(archivePath, '-- exact archive\n');

    const read = () => readRepositoryArchiveFromGitIndex({
      root: temporaryRoot,
      sourceCommit,
      file,
      sourcePath,
    });
    expect(read).toThrow(/not an exact staged file/);

    git('add', '--', sourcePath);
    expect(read()).toEqual(Buffer.from('-- exact archive\n'));

    git('update-index', '--force-remove', '--', sourcePath);
    expect(read).toThrow(/not an exact staged file/);

    rmSync(archivePath);
    expect(read).toThrow(/not an exact staged file/);
    symlinkSync(join(temporaryRoot, 'outside.sql'), archivePath);
    git('add', '--', sourcePath);
    expect(read).toThrow(/unsafe staged identity/);

    const objectId = 'b'.repeat(40);
    const duplicateIndexEntries = Buffer.from(
      `100644 ${objectId} 0\t${sourcePath}\0`
      + `100644 ${objectId} 0\t${sourcePath}\0`,
    );
    expect(() => readRepositoryArchiveFromGitIndex({
      root: temporaryRoot,
      sourceCommit,
      file,
      sourcePath,
      execGit: (_command: string, args: string[]) => (
        args[0] === 'ls-files' ? duplicateIndexEntries : Buffer.from('-- exact archive\n')
      ),
    })).toThrow(/not an exact staged file/);
  });

  it('never falls back between repository archives and historical commits', () => {
    const bytes = Buffer.from('CREATE TABLE x (id INTEGER);\n');
    const digest = createHash('sha256').update(bytes).digest('hex');
    const replacement = () => bytes;
    let historicalReads = 0;
    let archiveReads = 0;
    const archivePolicy = { lineages: [{ migrations: [{
      file: '001_x.sql',
      sha256: digest,
      sourceCommit: 'a'.repeat(40),
      sourceMode: 'repository_archive',
      sourcePath: `docs/release/evidence/retired-migrations/${'a'.repeat(40)}/001_x.sql`,
      replacement: {
        file: '002_x.sql', sha256: digest, relationship: 'byte_identical_renumber',
      },
    }] }] };
    expect(() => verifyProductionMigrationLineageHistory({
      policy: archivePolicy,
      readHistoricalMigration: () => { historicalReads += 1; return bytes; },
      readRepositoryArchive: () => { archiveReads += 1; throw new Error('missing'); },
      readReplacementMigration: replacement,
    })).toThrow(/absent from its repository archive/);
    expect({ historicalReads, archiveReads }).toEqual({ historicalReads: 0, archiveReads: 1 });

    const historyPolicy = structuredClone(archivePolicy);
    delete (historyPolicy.lineages[0].migrations[0] as any).sourceMode;
    delete (historyPolicy.lineages[0].migrations[0] as any).sourcePath;
    historicalReads = 0;
    archiveReads = 0;
    expect(() => verifyProductionMigrationLineageHistory({
      policy: historyPolicy,
      readHistoricalMigration: () => { historicalReads += 1; throw new Error('missing'); },
      readRepositoryArchive: () => { archiveReads += 1; return bytes; },
      readReplacementMigration: replacement,
    })).toThrow(/absent from its source commit/);
    expect({ historicalReads, archiveReads }).toEqual({ historicalReads: 1, archiveReads: 0 });
  });

  it('binds archive locators into the v2 projection source-policy digest', () => {
    const parsed = copyPolicyRoot();
    const withArchive = loadProductionMigrationLineagePolicy({ root: temporaryRoot });
    const archived = parsed.lineages[0].migrations.find(
      (entry: any) => entry.sourceMode === 'repository_archive',
    );
    delete archived.sourceMode;
    delete archived.sourcePath;
    writeFileSync(
      join(temporaryRoot, 'config/production-migration-lineages.json'),
      `${JSON.stringify(parsed, null, 2)}\n`,
    );
    const withoutArchive = loadProductionMigrationLineagePolicy({ root: temporaryRoot });
    expect(withoutArchive.sha256).not.toBe(withArchive.sha256);
    expect(withoutArchive.releaseReconciliation.sourcePolicySha256)
      .not.toBe(withArchive.releaseReconciliation.sourcePolicySha256);
  });

  it('rejects malformed, unsorted, duplicate, and path-escaping policy entries', () => {
    for (const mutate of [
      (value: any) => { value.schema = 'wrong'; },
      (value: any) => { value.lineages[0].migrations.reverse(); },
      (value: any) => { value.lineages[0].migrations[1].file = value.lineages[0].migrations[0].file; },
      (value: any) => { value.lineages[0].migrations[0].file = '../escape.sql'; },
      (value: any) => { value.lineages[0].migrations[0].sourceCommit = 'not-a-commit'; },
      (value: any) => { value.lineages[0].migrations[1].sourceCommit = 'a'.repeat(40); },
      (value: any) => {
        value.lineages[0].migrations[1].sourcePath = '../../migrations/001_escape.sql';
      },
      (value: any) => {
        value.lineages[0].migrations[1].sourcePath =
          'docs/release/evidence/retired-migrations/228_notification_correctness_phase0.sql';
      },
      (value: any) => { delete value.lineages[0].migrations[1].sourceMode; },
      (value: any) => { value.lineages[0].migrations[0].unexpected = true; },
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
