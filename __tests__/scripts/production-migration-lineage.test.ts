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
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadProductionMigrationLineagePolicy,
  PRODUCTION_MIGRATION_LINEAGE_SCHEMA,
  resolveProductionMigrationLineage,
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
    for (const entry of parsed.lineages[0].migrations) {
      cpSync(
        join(ROOT, 'migrations', entry.replacement.file),
        join(temporaryRoot, 'migrations', entry.replacement.file),
      );
    }
    return parsed;
  }

  it('loads the signed replacement inventory and resolves only canonical or exact retired sets', () => {
    const policy = loadProductionMigrationLineagePolicy({ root: ROOT });
    expect(policy.schema).toBe(PRODUCTION_MIGRATION_LINEAGE_SCHEMA);
    expect(policy.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(policy.lineages).toHaveLength(1);
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
});
