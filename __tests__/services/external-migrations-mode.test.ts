import Database from 'better-sqlite3';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  applyPendingMigrations,
  ensureMigrationSqlFunctions,
  pendingMigrationFiles,
} from '../../src/services/migration-runner';
import {
  assertReleaseDataMaintenanceComplete,
  recordReleaseDataMaintenanceCompletion,
  type ReleaseDataMaintenanceIdentity,
} from '../../src/services/release-data-maintenance';
import { runReleaseMigrations } from '../../src/tools/run-release-migrations';

/**
 * Release containers run with `MIGRATIONS_MODE=external`, and the guarantee that
 * buys is: the application cannot apply a migration. Migrations happen only in
 * the dedicated one-shot migrator, against a database that was just backed up.
 *
 * These tests exercise the real runner against real SQLite files, because the
 * property being protected is about actual schema state — a mocked ledger would
 * prove nothing.
 */

let workspace: string;

const PLAN_RELEASE_ID = 'a'.repeat(32);
const PLAN_SOURCE_SHA = 'b'.repeat(40);
const PLAN_BACKEND_DIGEST = `sha256:${'c'.repeat(64)}`;

const planIdentity = (): ReleaseDataMaintenanceIdentity => ({
  releaseId: PLAN_RELEASE_ID,
  sourceSha: PLAN_SOURCE_SHA,
  backendImageDigest: PLAN_BACKEND_DIGEST,
});

function collectRuntimeSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collectRuntimeSourceFiles(path);
    return entry.isFile() && /\.(?:[cm]?js|ts)$/.test(entry.name) ? [path] : [];
  });
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'nexus-migrations-'));
  // These tests drive the migrator directly, which is the local-development path.
  // Production requires a signed plan; declaring the mode here keeps that gate
  // asserted by its own tests instead of being implicitly bypassed by every
  // other one. Individual tests override this to prove the gate.
  vi.stubEnv('NEXUS_MIGRATOR_ALLOW_UNPLANNED', 'local-development');
  vi.stubEnv('NEXUS_RELEASE_ID', PLAN_RELEASE_ID);
  vi.stubEnv('NEXUS_RELEASE_SOURCE_SHA', PLAN_SOURCE_SHA);
  vi.stubEnv('NEXUS_RELEASE_BACKEND_DIGEST', PLAN_BACKEND_DIGEST);
  vi.stubEnv('NEXUS_RELEASE_ENVIRONMENT', 'production');
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.resetModules();
});

function migrationFileCount(): number {
  return readdirSync(join(process.cwd(), 'migrations'))
    .filter((file) => /^\d{3}_.*\.sql$/.test(file)).length;
}

function writeSignedPlan(
  migrationsDirectory: string,
  files: readonly string[],
  legacyFiles: readonly string[] = [],
): string {
  const inventory = files.map((file) => ({
    file,
    sha256: createHash('sha256')
      .update(readFileSync(join(migrationsDirectory, file)))
      .digest('hex'),
    kind: 'expand',
    predecessorCompatible: true,
  }));
  const legacyRows = legacyFiles.map((file) => ({
    file,
    retiredSha256: 'd'.repeat(64),
    sourceCommit: 'e'.repeat(40),
    replacement: {
      file: inventory[0].file,
      sha256: inventory[0].sha256,
      relationship: 'comment_only_renumber',
    },
  })).sort((left, right) => left.file.localeCompare(right.file));
  const reconciliation = {
    schema: 'nexus.release-migration-reconciliation.v2',
    sourcePolicySha256: 'f'.repeat(64),
    environments: {
      production: { lineageIds: ['fixture'], legacyRows },
      staging: { lineageIds: ['fixture'], legacyRows },
    },
    compatibilityExemptions: [{
      id: 'fixture',
      file: inventory[0].file,
      sha256: inventory[0].sha256,
      genericKind: 'contract',
      effectiveKind: 'expand',
      reason: 'fixture',
      allowedDropIndexes: [{
        name: 'idx_fixture_old',
        tableName: 'fixture_values',
        columns: ['value'],
        unique: true,
        allowAbsent: true,
        replacement: {
          name: 'idx_fixture_user_value',
          tableName: 'fixture_values',
          columns: ['user_id', 'value'],
          unique: true,
        },
      }],
    }],
    semanticSchemaExclusions: [],
  };
  const canonical = (value: any): string => {
    if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonical(value[key])}`
    )).join(',')}}`;
  };
  const planPath = join(workspace, `plan-${files.length}-${Date.now()}.json`);
  writeFileSync(planPath, JSON.stringify({
    schema: 'nexus.release-migration-plan.v2',
    releaseId: PLAN_RELEASE_ID,
    sourceSha: PLAN_SOURCE_SHA,
    backendImageDigest: PLAN_BACKEND_DIGEST,
    inventory,
    reconciliation,
    reconciliationDigest: createHash('sha256').update(canonical(reconciliation)).digest('hex'),
  }));
  return planPath;
}

function writeRollbackPlan(
  migrationsDirectory: string,
  files: readonly string[],
  forwardApplied: Array<{ file: string; sha256: string }>,
): string {
  const candidatePath = writeSignedPlan(migrationsDirectory, files);
  const plan = JSON.parse(readFileSync(candidatePath, 'utf8'));
  plan.schema = 'nexus.release-migration-plan.v3';
  plan.rollback = {
    successor: {
      releaseId: '2'.repeat(32),
      sourceSha: 'b'.repeat(40),
      backendImageDigest: `sha256:${'3'.repeat(64)}`,
      releasePayloadDigest: `sha256:${'4'.repeat(64)}`,
      manifestDigest: '5'.repeat(64),
    },
    forwardApplied,
  };
  const rollbackPath = join(workspace, `rollback-plan-${Date.now()}.json`);
  writeFileSync(rollbackPath, JSON.stringify(plan));
  return rollbackPath;
}

function recordFixtureDataMaintenance(
  database: Database.Database,
  identity: ReleaseDataMaintenanceIdentity,
): void {
  // The two-file signed-plan fixtures intentionally do not contain migration
  // 028. Give those isolated migrator-admission tests the governed table shape;
  // production still independently requires the exact immutable receipt after
  // this injectable fixture returns.
  database.exec(`
    CREATE TABLE kv_store (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  recordReleaseDataMaintenanceCompletion(
    database,
    identity,
    '2026-08-09T00:00:00.000Z',
  );
}

describe('external migrations mode', () => {
  it('keeps database lifecycle bypass capabilities private to the bootstrap boundary', () => {
    const consumers = [
      ...collectRuntimeSourceFiles(join(process.cwd(), 'src')),
      ...collectRuntimeSourceFiles(join(process.cwd(), 'scripts')),
    ]
      .filter((file) => /initializeDatabaseCore|withReleaseMaintenanceDatabase/
        .test(readFileSync(file, 'utf8')))
      .map((file) => file.slice(process.cwd().length + 1))
      .sort();

    expect(consumers).toEqual([
      'src/services/database-bootstrap.ts',
      'src/services/database.ts',
    ]);
  });

  it('reports every migration as pending on a fresh database', () => {
    const database = new Database(join(workspace, 'fresh.db'));
    try {
      ensureMigrationSqlFunctions(database);
      const pending = pendingMigrationFiles(database);
      expect(pending.length).toBe(migrationFileCount());
      expect(pending[0]).toMatch(/^\d{3}_/);
    } finally {
      database.close();
    }
  });

  it('reports nothing pending once the migrator has run', () => {
    const path = join(workspace, 'migrated.db');
    const result = runReleaseMigrations(path);
    expect(result.appliedCount).toBe(migrationFileCount());
    expect(result.pendingAfter).toEqual([]);

    const database = new Database(path);
    try {
      expect(pendingMigrationFiles(database)).toEqual([]);
    } finally {
      database.close();
    }
  });

  it('is idempotent, because the poller may retry a release whose migrator ran', () => {
    const path = join(workspace, 'twice.db');
    runReleaseMigrations(path);
    const second = runReleaseMigrations(path);
    expect(second.appliedCount).toBe(0);
    expect(second.pendingBefore).toEqual([]);
  });

  it('waits for a bounded live-writer lock before applying the migration set', async () => {
    const databasePath = join(workspace, 'live-writer-lock.db');
    const lockHolder = spawn(process.execPath, ['-e', `
      const Database = require('better-sqlite3');
      const database = new Database(process.argv[1]);
      const journalMode = database.pragma('journal_mode', { simple: true });
      database.exec('BEGIN IMMEDIATE');
      process.stdout.write(String(journalMode) + '\\n');
      setTimeout(() => {
        database.exec('COMMIT');
        database.close();
      }, 6_000);
    `, databasePath], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('lock holder did not become ready')), 5_000);
        lockHolder.once('error', reject);
        lockHolder.stdout.once('data', (chunk) => {
          clearTimeout(timeout);
          expect(String(chunk).trim().toUpperCase()).toBe('DELETE');
          resolve();
        });
      });
      expect(() => runReleaseMigrations(databasePath)).not.toThrow();
      const proof = new Database(databasePath, { readonly: true });
      try {
        expect(String(proof.pragma('journal_mode', { simple: true })).toUpperCase()).toBe('WAL');
      } finally {
        proof.close();
      }
    } finally {
      if (lockHolder.exitCode === null) lockHolder.kill('SIGTERM');
    }
  }, 20_000);

  it('verifies integrity and foreign keys after migrating', () => {
    // runReleaseMigrations throws on either failure; reaching here with a
    // populated ledger is the assertion that both checks ran and passed.
    const path = join(workspace, 'integrity.db');
    expect(() => runReleaseMigrations(path)).not.toThrow();
    const database = new Database(path);
    try {
      const integrity = database.pragma('integrity_check') as Array<{ integrity_check: string }>;
      expect(integrity[0].integrity_check).toBe('ok');
      expect((database.pragma('foreign_key_check') as unknown[]).length).toBe(0);
    } finally {
      database.close();
    }
  });

  it('exposes a read-only pending check that applies nothing', () => {
    const path = join(workspace, 'readonly.db');
    const database = new Database(path);
    try {
      ensureMigrationSqlFunctions(database);
      const before = pendingMigrationFiles(database);
      // Calling it repeatedly must not advance the ledger.
      expect(pendingMigrationFiles(database)).toEqual(before);
      const ledger = database
        .prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='_migrations'")
        .get();
      expect(ledger).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it('never reports a missing or empty migrations directory as fully applied', () => {
    const database = new Database(join(workspace, 'missing-source.db'));
    try {
      expect(() => pendingMigrationFiles(database, {
        migrationsDirectory: join(workspace, 'not-packaged'),
      })).toThrow(/Migrations directory not found/);

      const empty = join(workspace, 'empty-migrations');
      mkdirSync(empty);
      expect(() => pendingMigrationFiles(database, { migrationsDirectory: empty }))
        .toThrow(/contains no governed migration files/);
    } finally {
      database.close();
    }
  });

  it('honours excludeFiles and stopBefore the same way the applier does', () => {
    const path = join(workspace, 'partial.db');
    const database = new Database(path);
    try {
      ensureMigrationSqlFunctions(database);
      const all = pendingMigrationFiles(database);
      const stopBefore = all[5];
      applyPendingMigrations(database, { stopBefore });
      const remaining = pendingMigrationFiles(database);
      // Everything before the stop point is applied; the stop point is not.
      expect(remaining[0]).toBe(stopBefore);
      expect(remaining.length).toBe(all.length - 5);

      const excluded = new Set([stopBefore]);
      expect(pendingMigrationFiles(database, { excludeFiles: excluded }))
        .not.toContain(stopBefore);
    } finally {
      database.close();
    }
  });

  it('refuses to boot when MIGRATIONS_MODE=external and the ledger is behind', async () => {
    // The acceptance criterion: a release container cannot migrate itself. A
    // silent skip would serve traffic against a schema the release never
    // migrated; refusing to boot surfaces the missing migrator run while the
    // previous container is still answering requests.
    vi.resetModules();
    vi.stubEnv('MIGRATIONS_MODE', 'external');
    vi.stubEnv('DATABASE_PATH', join(workspace, 'unmigrated.db'));

    const { config } = await import('../../src/config');
    expect(config.app.migrationsMode).toBe('external');

    const { initDatabase } = await import('../../src/services/database-bootstrap');
    const { closeDatabase } = await import('../../src/services/database');
    try {
      expect(() => initDatabase()).toThrow(/MIGRATIONS_MODE=external/);
    } finally {
      try {
        closeDatabase();
      } catch {
        // initDatabase threw before the connection was fully registered
      }
    }
  });

  it('refuses external application boot when the packaged migration source is absent', async () => {
    vi.resetModules();
    vi.stubEnv('MIGRATIONS_MODE', 'external');
    const { config } = await import('../../src/config');
    expect(config.app.migrationsMode).toBe('external');
    const { runMigrationsForTest } = await import('../../src/services/database');
    const database = new Database(join(workspace, 'external-missing-source.db'));
    try {
      expect(() => runMigrationsForTest(database, {
        migrationsDirectory: join(workspace, 'missing-from-image'),
      })).toThrow(/Migrations directory not found/);
    } finally {
      database.close();
    }
  });

  it('refuses external application boot when an applied migration is absent from the image', async () => {
    const packaged = join(workspace, 'partial-package');
    mkdirSync(packaged);
    writeFileSync(join(packaged, '001_present.sql'), 'CREATE TABLE present_value(id INTEGER);\n');

    vi.resetModules();
    vi.stubEnv('MIGRATIONS_MODE', 'external');
    const { runMigrationsForTest } = await import('../../src/services/database');
    const database = new Database(join(workspace, 'external-partial-source.db'));
    try {
      database.exec('CREATE TABLE _migrations(filename TEXT PRIMARY KEY);');
      const insert = database.prepare('INSERT INTO _migrations(filename) VALUES (?)');
      insert.run('001_present.sql');
      insert.run('002_absent.sql');
      expect(() => runMigrationsForTest(database, { migrationsDirectory: packaged }))
        .toThrow(/signed legacy set plus rollback suffix \(unexpected: 002_absent\.sql; missing: none\)/);
    } finally {
      database.close();
    }
  });

  it('applies migrations at boot in the default mode', async () => {
    // The inverse guard: outside a release container the application still
    // migrates itself, so local development and tests are unaffected.
    vi.resetModules();
    vi.stubEnv('DATABASE_PATH', join(workspace, 'boot-mode.db'));

    const { config } = await import('../../src/config');
    expect(config.app.migrationsMode).toBe('boot');
  });

  // An unrecognized value used to fall back to `boot`, silently restoring the
  // application's ability to migrate itself inside a release container — the exact
  // thing the flag exists to prevent. It now fails closed at import time.
  it.each(['EXTERNAL', 'exteral', 'off', 'true', 'external ', 'none'])(
    'rejects MIGRATIONS_MODE=%j instead of defaulting to boot',
    async (value) => {
      vi.resetModules();
      vi.stubEnv('MIGRATIONS_MODE', value);
      await expect(import('../../src/config')).rejects.toThrow(/MIGRATIONS_MODE must be/);
    },
  );

  it.each(['boot', 'external'])('accepts the exact governed value %j', async (value) => {
    vi.resetModules();
    vi.stubEnv('MIGRATIONS_MODE', value);
    const { config } = await import('../../src/config');
    expect(config.app.migrationsMode).toBe(value);
  });

  it('treats an unset or empty value as boot, for local development and tests', async () => {
    vi.resetModules();
    vi.stubEnv('MIGRATIONS_MODE', '');
    const { config } = await import('../../src/config');
    expect(config.app.migrationsMode).toBe('boot');
  });

  it('refuses to apply a migration the signed plan does not authorize', async () => {
    // The migrator applies every ledger-pending file. Without the plan it would
    // happily apply a migration no signed release vouched for.
    vi.resetModules();
    const packaged = join(workspace, 'unauthorized-package');
    mkdirSync(packaged);
    const files = ['001_authorized.sql', '002_unauthorized.sql'];
    writeFileSync(join(packaged, files[0]), 'CREATE TABLE authorized_value(id INTEGER);\n');
    writeFileSync(join(packaged, files[1]), 'CREATE TABLE unauthorized_value(id INTEGER);\n');
    // The valid v2 plan deliberately authorizes only the first packaged file.
    const planPath = writeSignedPlan(packaged, [files[0]]);
    vi.stubEnv('NEXUS_RELEASE_MIGRATION_PLAN', planPath);
    const { runReleaseMigrations: guarded } = await import('../../src/tools/run-release-migrations');
    expect(() => guarded(join(workspace, 'planned.db'), { migrationsDirectory: packaged }))
      .toThrow(/does not exactly match packaged migration files/);
  });

  it('refuses a plan with an unsupported schema', async () => {
    vi.resetModules();
    const planPath = join(workspace, 'bad-plan.json');
    writeFileSync(planPath, JSON.stringify({ schema: 'something.else', inventory: [] }));
    vi.stubEnv('NEXUS_RELEASE_MIGRATION_PLAN', planPath);
    const { runReleaseMigrations: guarded } = await import('../../src/tools/run-release-migrations');
    expect(() => guarded(join(workspace, 'bad.db'))).toThrow(/governed schema|unsupported schema/);
  });

  it('refuses a signed nonempty plan when migrations were omitted from the package', async () => {
    vi.resetModules();
    const planPath = join(workspace, 'missing-package-plan.json');
    writeFileSync(planPath, JSON.stringify({
      schema: 'nexus.release-migration-plan.v1',
      releaseId: PLAN_RELEASE_ID,
      sourceSha: PLAN_SOURCE_SHA,
      backendImageDigest: PLAN_BACKEND_DIGEST,
      inventory: [{
        file: '001_expected.sql',
        sha256: 'c'.repeat(64),
        kind: 'expand',
        predecessorCompatible: true,
      }],
    }));
    vi.stubEnv('NEXUS_RELEASE_MIGRATION_PLAN', planPath);
    const { runReleaseMigrations: guarded } = await import('../../src/tools/run-release-migrations');
    expect(() => guarded(join(workspace, 'missing-package.db'), {
      migrationsDirectory: join(workspace, 'missing-package'),
    })).toThrow(/Migrations directory not found/);
  });

  it('validates the exact complete signed inventory before applying or returning success', async () => {
    const packaged = join(workspace, 'complete-package');
    mkdirSync(packaged);
    const files = ['001_fixture.sql', '002_fixture.sql'];
    writeFileSync(join(packaged, files[0]), 'CREATE TABLE fixture_one(id INTEGER);\n');
    writeFileSync(join(packaged, files[1]), 'CREATE TABLE fixture_two(id INTEGER);\n');
    const planPath = writeSignedPlan(packaged, files);

    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXUS_RELEASE_MIGRATION_PLAN', planPath);
    const databasePath = join(workspace, 'complete-package.db');
    const first = runReleaseMigrations(databasePath, {
      migrationsDirectory: packaged,
      dataMaintenanceRunner: recordFixtureDataMaintenance,
    });
    expect(first.appliedCount).toBe(2);
    expect(first.pendingAfter).toEqual([]);
    const second = runReleaseMigrations(databasePath, {
      migrationsDirectory: packaged,
      dataMaintenanceRunner: (_database, identity) => {
        // The retry must accept the first insert-only receipt without rewriting
        // it, just as a poller retry does for a real release.
        assertReleaseDataMaintenanceComplete(_database, identity);
      },
    });
    expect(second.appliedCount).toBe(0);
    expect(second.pendingBefore).toEqual([]);

    const database = new Database(databasePath);
    try {
      database.prepare('INSERT INTO _migrations(filename) VALUES (?)').run('999_absent.sql');
    } finally {
      database.close();
    }
    expect(() => runReleaseMigrations(databasePath, { migrationsDirectory: packaged }))
      .toThrow(/signed legacy set/);

    // Even the no-pending path revalidates the complete package, not just the
    // ledger delta. Removing one inventory entry must turn the no-op into a hard
    // failure before SQLite is considered current.
    vi.stubEnv('NEXUS_RELEASE_MIGRATION_PLAN', writeSignedPlan(packaged, [files[0]]));
    expect(() => runReleaseMigrations(databasePath, { migrationsDirectory: packaged }))
      .toThrow(/does not exactly match packaged migration files/);
  });

  it('accepts only the exact environment-specific legacy ledger set', () => {
    const packaged = join(workspace, 'legacy-plan-package');
    mkdirSync(packaged);
    const files = ['001_fixture.sql'];
    writeFileSync(join(packaged, files[0]), 'CREATE TABLE fixture_one(id INTEGER);\n');
    const legacyFile = '000_retired_fixture.sql';
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXUS_RELEASE_MIGRATION_PLAN', writeSignedPlan(packaged, files, [legacyFile]));

    const acceptedPath = join(workspace, 'legacy-accepted.db');
    const accepted = new Database(acceptedPath);
    accepted.exec(`CREATE TABLE _migrations(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL UNIQUE,
      applied_at TEXT DEFAULT (datetime('now'))
    )`);
    accepted.prepare('INSERT INTO _migrations(filename) VALUES (?)').run(legacyFile);
    accepted.close();
    expect(runReleaseMigrations(acceptedPath, {
      migrationsDirectory: packaged,
      dataMaintenanceRunner: recordFixtureDataMaintenance,
    }).appliedCount).toBe(1);

    expect(() => runReleaseMigrations(join(workspace, 'legacy-missing.db'), {
      migrationsDirectory: packaged,
    })).toThrow(/signed legacy set.*missing/);

    const extraPath = join(workspace, 'legacy-extra.db');
    const extra = new Database(extraPath);
    extra.exec('CREATE TABLE _migrations(filename TEXT PRIMARY KEY)');
    extra.prepare('INSERT INTO _migrations(filename) VALUES (?)').run(legacyFile);
    extra.prepare('INSERT INTO _migrations(filename) VALUES (?)').run('000_unknown.sql');
    extra.close();
    expect(() => runReleaseMigrations(extraPath, { migrationsDirectory: packaged }))
      .toThrow(/signed legacy set.*unexpected/);
  });

  it('boots a predecessor only with the signed successor forward-applied suffix', async () => {
    const packaged = join(workspace, 'rollback-plan-package');
    mkdirSync(packaged);
    const files = ['001_predecessor.sql'];
    writeFileSync(join(packaged, files[0]), 'CREATE TABLE predecessor_value(id INTEGER);\n');
    const forwardApplied = [{ file: '002_successor_expand.sql', sha256: '6'.repeat(64) }];
    const planPath = writeRollbackPlan(packaged, files, forwardApplied);

    vi.resetModules();
    vi.stubEnv('MIGRATIONS_MODE', 'external');
    vi.stubEnv('NEXUS_RELEASE_MIGRATION_PLAN', planPath);
    const { runMigrationsForTest } = await import('../../src/services/database');
    const database = new Database(join(workspace, 'rollback-plan.db'));
    try {
      database.exec(`
        CREATE TABLE _migrations(filename TEXT PRIMARY KEY);
        CREATE TABLE predecessor_value(id INTEGER);
      `);
      const insert = database.prepare('INSERT INTO _migrations(filename) VALUES (?)');
      insert.run(files[0]);
      insert.run(forwardApplied[0].file);
      recordFixtureDataMaintenance(database, planIdentity());
      expect(() => runMigrationsForTest(database, { migrationsDirectory: packaged }))
        .not.toThrow();

      insert.run('003_unknown_successor.sql');
      expect(() => runMigrationsForTest(database, { migrationsDirectory: packaged }))
        .toThrow(/signed legacy set plus rollback suffix.*unexpected/);
    } finally {
      database.close();
    }

    vi.stubEnv('NODE_ENV', 'production');
    expect(() => runReleaseMigrations(join(workspace, 'rollback-migrator.db'), {
      migrationsDirectory: packaged,
    })).toThrow(/rollback migration plans are verification-only/);
  });

  it('refuses a canonical ledger gap before applying the pending signed suffix', () => {
    const packaged = join(workspace, 'non-prefix-plan-package');
    mkdirSync(packaged);
    const files = ['001_fixture.sql', '002_fixture.sql', '003_fixture.sql'];
    writeFileSync(join(packaged, files[0]), 'CREATE TABLE prefix_fixture(id INTEGER);\n');
    writeFileSync(join(packaged, files[1]), 'CREATE TABLE gap_must_not_apply(id INTEGER);\n');
    writeFileSync(join(packaged, files[2]), 'CREATE TABLE later_fixture(id INTEGER);\n');
    const legacyFile = '000_retired_fixture.sql';
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXUS_RELEASE_MIGRATION_PLAN', writeSignedPlan(packaged, files, [legacyFile]));

    const databasePath = join(workspace, 'non-prefix.db');
    const database = new Database(databasePath);
    database.exec(`
      CREATE TABLE _migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        filename TEXT NOT NULL UNIQUE
      );
      CREATE TABLE prefix_fixture(id INTEGER);
      CREATE TABLE later_fixture(id INTEGER);
    `);
    const insert = database.prepare('INSERT INTO _migrations(filename) VALUES (?)');
    insert.run(files[0]);
    insert.run(legacyFile);
    insert.run(files[2]);
    database.close();

    expect(() => runReleaseMigrations(databasePath, { migrationsDirectory: packaged }))
      .toThrow(/ordered packaged inventory prefix/);

    const proof = new Database(databasePath, { readonly: true });
    try {
      expect(proof.prepare(
        "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='gap_must_not_apply'",
      ).get()).toBeUndefined();
      expect(proof.prepare(
        'SELECT filename FROM _migrations WHERE filename = ?',
      ).get(legacyFile)).toEqual({ filename: legacyFile });
    } finally {
      proof.close();
    }
  });

  it('does not let a fully migrated production database bypass a missing signed plan', async () => {
    const packaged = join(workspace, 'no-plan-noop-package');
    mkdirSync(packaged);
    const files = ['001_fixture.sql'];
    writeFileSync(join(packaged, files[0]), 'CREATE TABLE complete_fixture(id INTEGER);\n');

    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXUS_RELEASE_MIGRATION_PLAN', writeSignedPlan(packaged, files));
    const databasePath = join(workspace, 'no-plan-noop.db');
    expect(runReleaseMigrations(databasePath, {
      migrationsDirectory: packaged,
      dataMaintenanceRunner: recordFixtureDataMaintenance,
    }).appliedCount).toBe(1);

    vi.stubEnv('NEXUS_RELEASE_MIGRATION_PLAN', '');
    expect(() => runReleaseMigrations(databasePath, { migrationsDirectory: packaged }))
      .toThrow(/NEXUS_RELEASE_MIGRATION_PLAN is required/);
  });

  it('refuses to migrate production without a signed plan, opt-in or not', () => {
    // Two independent conditions guard the unplanned path, so neither a stray
    // environment variable nor a missing one can open it in production.
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => runReleaseMigrations(join(workspace, 'prod-noplan.db')))
      .toThrow(/NEXUS_RELEASE_MIGRATION_PLAN is required to migrate in production/);

    // Even with the local-development opt-in explicitly set.
    vi.stubEnv('NEXUS_MIGRATOR_ALLOW_UNPLANNED', 'local-development');
    expect(() => runReleaseMigrations(join(workspace, 'prod-optin.db')))
      .toThrow(/NEXUS_RELEASE_MIGRATION_PLAN is required to migrate in production/);
  });

  it('refuses an unplanned migration set outside production without the exact opt-in', () => {
    vi.stubEnv('NODE_ENV', 'test');
    for (const value of ['', 'true', '1', 'yes', 'Local-Development']) {
      vi.stubEnv('NEXUS_MIGRATOR_ALLOW_UNPLANNED', value);
      expect(() => runReleaseMigrations(join(workspace, `optin-${value || 'empty'}.db`)))
        .toThrow(/NEXUS_MIGRATOR_ALLOW_UNPLANNED is not set to "local-development"/);
    }
  });

  it('allows the unplanned path only under the exact local-development opt-in', () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('NEXUS_MIGRATOR_ALLOW_UNPLANNED', 'local-development');
    const result = runReleaseMigrations(join(workspace, 'local-dev.db'));
    expect(result.appliedCount).toBe(migrationFileCount());
  });

  it('keeps immutable completion receipts for candidate and predecessor identities', () => {
    const database = new Database(join(workspace, 'maintenance-receipts.db'));
    try {
      database.exec(`
        CREATE TABLE kv_store (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      const candidate = planIdentity();
      const predecessor: ReleaseDataMaintenanceIdentity = {
        releaseId: 'd'.repeat(32),
        sourceSha: 'e'.repeat(40),
        backendImageDigest: `sha256:${'f'.repeat(64)}`,
      };
      recordReleaseDataMaintenanceCompletion(
        database,
        candidate,
        '2026-08-09T00:00:00.000Z',
      );
      const candidateKey = `release_data_maintenance:${candidate.releaseId}`;
      const original = database.prepare('SELECT value FROM kv_store WHERE key = ?')
        .get(candidateKey) as { value: string };

      // A retry cannot rewrite even the timestamp, and a later release gets a
      // distinct key so rollback proof remains independently addressable.
      recordReleaseDataMaintenanceCompletion(
        database,
        candidate,
        '2026-08-09T00:01:00.000Z',
      );
      recordReleaseDataMaintenanceCompletion(
        database,
        predecessor,
        '2026-08-09T00:02:00.000Z',
      );
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM kv_store WHERE key LIKE 'release_data_maintenance:%'",
      ).get()).toEqual({ count: 2 });
      expect(database.prepare('SELECT value FROM kv_store WHERE key = ?')
        .get(candidateKey)).toEqual(original);

      // The release ID is the immutable key. Reusing it for different source or
      // image content cannot overwrite the existing evidence into a match.
      expect(() => recordReleaseDataMaintenanceCompletion(database, {
        ...candidate,
        sourceSha: 'd'.repeat(40),
      }, '2026-08-09T00:03:00.000Z')).toThrow(/release data maintenance is incomplete/);
      expect(database.prepare('SELECT value FROM kv_store WHERE key = ?')
        .get(candidateKey)).toEqual(original);
    } finally {
      database.close();
    }
  });

  it('rolls back partial maintenance and its marker inside one IMMEDIATE transaction', async () => {
    const databasePath = join(workspace, 'atomic-maintenance.db');
    runReleaseMigrations(databasePath);
    const database = new Database(databasePath);
    try {
      database.prepare(`
        INSERT INTO ios_devices (user_id, device_id, refresh_token, refresh_token_hash)
        VALUES (999, 'atomic-fixture', 'legacy-plaintext', NULL)
      `).run();
      // Force a failure after the early refresh-token mutation has run.
      database.exec('DROP TABLE users');
      vi.stubEnv('OAUTH_ENCRYPTION_KEY', '1'.repeat(64));
      vi.resetModules();
      const { runReleaseDataMaintenanceForMigrator } = await import('../../src/services/database-bootstrap');

      const originalTransaction = database.transaction.bind(database);
      let immediateCalls = 0;
      (database as any).transaction = (action: () => unknown) => {
        const transaction = originalTransaction(action) as any;
        const instrumented = (...args: unknown[]) => transaction(...args);
        Object.defineProperty(instrumented, 'immediate', {
          value: (...args: unknown[]) => {
            immediateCalls += 1;
            return transaction.immediate(...args);
          },
        });
        return instrumented;
      };

      expect(() => runReleaseDataMaintenanceForMigrator(database, planIdentity()))
        .toThrow(/requires the governed users schema/);
      expect(immediateCalls).toBe(1);
      expect(database.prepare(`
        SELECT refresh_token, refresh_token_hash
        FROM ios_devices WHERE device_id = 'atomic-fixture'
      `).get()).toEqual({ refresh_token: 'legacy-plaintext', refresh_token_hash: null });
      expect(() => assertReleaseDataMaintenanceComplete(database, planIdentity()))
        .toThrow(/release data maintenance is incomplete/);
    } finally {
      database.close();
    }
  });

  it('requires the exact marker before app-side kv_store self-heal can run', async () => {
    const databasePath = join(workspace, 'missing-maintenance-ledger.db');
    runReleaseMigrations(databasePath);
    const setup = new Database(databasePath);
    setup.exec('DROP TABLE kv_store');
    setup.close();

    vi.resetModules();
    vi.stubEnv('MIGRATIONS_MODE', 'external');
    vi.stubEnv('DATABASE_PATH', databasePath);
    vi.stubEnv('OAUTH_ENCRYPTION_KEY', '1'.repeat(64));
    const { initDatabase } = await import('../../src/services/database-bootstrap');
    const { closeDatabase } = await import('../../src/services/database');
    try {
      expect(() => initDatabase()).toThrow(/completion ledger is absent/);
    } finally {
      try { closeDatabase(); } catch { /* startup failed before registration */ }
    }

    const proof = new Database(databasePath);
    try {
      expect(proof.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'kv_store'",
      ).get()).toBeUndefined();
    } finally {
      proof.close();
    }
  });

  it('refuses external boot instead of repairing a malformed kv_store after maintenance', async () => {
    const databasePath = join(workspace, 'malformed-runtime-store.db');
    runReleaseMigrations(databasePath);
    vi.stubEnv('OAUTH_ENCRYPTION_KEY', '1'.repeat(64));
    vi.resetModules();
    const { runReleaseDataMaintenanceForMigrator } = await import('../../src/services/database-bootstrap');
    const setup = new Database(databasePath);
    try {
      runReleaseDataMaintenanceForMigrator(setup, planIdentity());
      assertReleaseDataMaintenanceComplete(setup, planIdentity());
      ensureMigrationSqlFunctions(setup);
      setup.exec(`
        DROP INDEX idx_kv_store_updated;
        ALTER TABLE kv_store DROP COLUMN updated_at;
      `);
    } finally {
      setup.close();
    }

    vi.resetModules();
    vi.doMock('../../src/services/content-workspace-boot-readiness', () => ({
      assertContentWorkspaceBootReadiness: () => undefined,
    }));
    vi.stubEnv('MIGRATIONS_MODE', 'external');
    vi.stubEnv('DATABASE_PATH', databasePath);
    const execSpy = vi.spyOn(Database.prototype, 'exec');
    const { initDatabase } = await import('../../src/services/database-bootstrap');
    const { closeDatabase } = await import('../../src/services/database');
    try {
      expect(() => initDatabase()).toThrow(/requires the migrated kv_store schema/);
      expect(execSpy).not.toHaveBeenCalled();
    } finally {
      try { closeDatabase(); } catch { /* startup failed before registration */ }
      execSpy.mockRestore();
      vi.doUnmock('../../src/services/content-workspace-boot-readiness');
    }

    const proof = new Database(databasePath);
    try {
      const columns = proof.prepare('PRAGMA table_info(kv_store)').all() as { name: string }[];
      expect(columns.map(({ name }) => name)).toEqual(['key', 'value']);
    } finally {
      proof.close();
    }
  });

  it.each([
    ['missing required index', 'DROP INDEX idx_kv_store_updated'],
    ['wrong constraints and default', `
      CREATE TABLE kv_store_bad (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at TEXT DEFAULT 'not-canonical'
      );
      INSERT INTO kv_store_bad (key, value, updated_at)
        SELECT key, value, updated_at FROM kv_store;
      DROP TABLE kv_store;
      ALTER TABLE kv_store_bad RENAME TO kv_store;
      CREATE INDEX idx_kv_store_updated ON kv_store (updated_at);
    `],
  ])('refuses external boot for a kv_store with %s', async (_case, mutationSql) => {
    const databasePath = join(workspace, `malformed-runtime-store-${_case.replaceAll(' ', '-')}.db`);
    runReleaseMigrations(databasePath);
    vi.stubEnv('OAUTH_ENCRYPTION_KEY', '1'.repeat(64));
    vi.resetModules();
    const { runReleaseDataMaintenanceForMigrator } = await import('../../src/services/database-bootstrap');
    const setup = new Database(databasePath);
    try {
      runReleaseDataMaintenanceForMigrator(setup, planIdentity());
      assertReleaseDataMaintenanceComplete(setup, planIdentity());
      ensureMigrationSqlFunctions(setup);
      setup.exec(mutationSql);
    } finally {
      setup.close();
    }

    vi.resetModules();
    vi.doMock('../../src/services/content-workspace-boot-readiness', () => ({
      assertContentWorkspaceBootReadiness: () => undefined,
    }));
    vi.stubEnv('MIGRATIONS_MODE', 'external');
    vi.stubEnv('DATABASE_PATH', databasePath);
    const execSpy = vi.spyOn(Database.prototype, 'exec');
    const { initDatabase } = await import('../../src/services/database-bootstrap');
    const { closeDatabase } = await import('../../src/services/database');
    try {
      expect(() => initDatabase()).toThrow(/requires the migrated kv_store schema/);
      expect(execSpy).not.toHaveBeenCalled();
    } finally {
      try { closeDatabase(); } catch { /* startup failed before registration */ }
      execSpy.mockRestore();
      vi.doUnmock('../../src/services/content-workspace-boot-readiness');
    }
  });

  it('fails external boot when the persisted-settings read fails after schema proof', async () => {
    const databasePath = join(workspace, 'settings-read-failure.db');
    runReleaseMigrations(databasePath);
    vi.stubEnv('OAUTH_ENCRYPTION_KEY', '1'.repeat(64));
    vi.resetModules();
    const { runReleaseDataMaintenanceForMigrator } = await import('../../src/services/database-bootstrap');
    const setup = new Database(databasePath);
    try {
      runReleaseDataMaintenanceForMigrator(setup, planIdentity());
      assertReleaseDataMaintenanceComplete(setup, planIdentity());
    } finally {
      setup.close();
    }

    vi.resetModules();
    vi.doMock('../../src/services/content-workspace-boot-readiness', () => ({
      assertContentWorkspaceBootReadiness: () => undefined,
    }));
    vi.stubEnv('MIGRATIONS_MODE', 'external');
    vi.stubEnv('DATABASE_PATH', databasePath);
    const { DatabaseConfigProvider } = await import('../../src/services/config-provider');
    const settingsSpy = vi.spyOn(DatabaseConfigProvider.prototype, 'loadPersistedSettings')
      .mockImplementation(() => {
        throw new Error('external-settings-read-failed');
      });
    const { initDatabase } = await import('../../src/services/database-bootstrap');
    const { closeDatabase } = await import('../../src/services/database');
    try {
      expect(() => initDatabase()).toThrow(/external-settings-read-failed/);
    } finally {
      try { closeDatabase(); } catch { /* startup failed before registration */ }
      settingsSpy.mockRestore();
      vi.doUnmock('../../src/services/content-workspace-boot-readiness');
    }
  });

  it('runs maintenance in the one-shot and performs no boot transformations externally', async () => {
    const databasePath = join(workspace, 'external-verification-only.db');
    runReleaseMigrations(databasePath);
    vi.stubEnv('OAUTH_ENCRYPTION_KEY', '1'.repeat(64));
    vi.resetModules();
    const { runReleaseDataMaintenanceForMigrator } = await import('../../src/services/database-bootstrap');
    const database = new Database(databasePath);
    try {
      runReleaseDataMaintenanceForMigrator(database, planIdentity());
      assertReleaseDataMaintenanceComplete(database, planIdentity());
      // Simulate legacy plaintext introduced after the one-shot boundary. An
      // external application boot must verify only; it cannot hash/clear it.
      database.prepare(`
        INSERT INTO ios_devices (user_id, device_id, refresh_token, refresh_token_hash)
        VALUES (999, 'post-maintenance-fixture', 'leave-at-boot', NULL)
      `).run();
    } finally {
      database.close();
    }

    vi.resetModules();
    // This case isolates the release-mode mutation boundary. Content workspace
    // readiness has its own boot-path suite and lazy CommonJS loaders, which are
    // not resolvable from Vitest's in-memory TypeScript module graph.
    vi.doMock('../../src/services/content-workspace-boot-readiness', () => ({
      assertContentWorkspaceBootReadiness: () => undefined,
    }));
    vi.stubEnv('MIGRATIONS_MODE', 'external');
    vi.stubEnv('DATABASE_PATH', databasePath);
    const execSpy = vi.spyOn(Database.prototype, 'exec');
    const { initDatabase } = await import('../../src/services/database-bootstrap');
    const { closeDatabase } = await import('../../src/services/database');
    try {
      expect(() => initDatabase()).not.toThrow();
      expect(execSpy).not.toHaveBeenCalled();
    } finally {
      closeDatabase();
      execSpy.mockRestore();
      vi.doUnmock('../../src/services/content-workspace-boot-readiness');
    }

    const proof = new Database(databasePath);
    try {
      expect(proof.prepare(`
        SELECT refresh_token, refresh_token_hash
        FROM ios_devices WHERE device_id = 'post-maintenance-fixture'
      `).get()).toEqual({ refresh_token: 'leave-at-boot', refresh_token_hash: null });
    } finally {
      proof.close();
    }
  });

  it('counts 292 executable up migrations and 59 down files', () => {
    // The plan requires these numbers to be measured, not quoted. The up count is
    // what the runner applies; the down files are not wired to any runner.
    expect(migrationFileCount()).toBe(292);
    const downFiles = readdirSync(join(process.cwd(), 'migrations/down'))
      .filter((file) => file.endsWith('.sql'));
    expect(downFiles.length).toBe(59);
  });

  it('mounts the same signed plan read-only into migrator and backend', () => {
    const compose = readFileSync(join(process.cwd(), 'docker-compose.release.yml'), 'utf8');
    const backend = compose.slice(compose.indexOf('  backend:'), compose.indexOf('  migrator:'));
    expect(backend).toContain('NEXUS_RELEASE_MIGRATION_PLAN: /release/migration-plan.json');
    expect(backend).toContain('${NEXUS_RELEASE_PLAN_DIR:?release plan directory is required}:/release:ro');
    expect(backend).toContain('NEXUS_RELEASE_ENVIRONMENT:');
  });
});
