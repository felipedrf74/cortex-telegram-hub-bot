// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import Database from 'better-sqlite3';
import { config } from '../config';
import { logger } from '../utils/logger';
import { SQLiteStorage, setStorageProvider, clearStorageProvider } from './storage-provider';
import { assertContentWorkspaceBootReadiness } from './content-workspace-boot-readiness';
import {
  applyMigrationFile,
  applyPendingMigrations,
  ensureMigrationSqlFunctions,
  filterAlreadyAppliedAddColumnStatements as filterMigrationAddColumns,
  loadReleaseMigrationPlan,
  pendingMigrationFiles,
} from './migration-runner';
import {
  assertReleaseDataMaintenanceComplete,
  releaseDataMaintenanceIdentityFromEnvironment,
} from './release-data-maintenance';

export {
  assertNoUnexpectedMigrationPrefixCollisions,
  findUnexpectedMigrationPrefixCollisions,
  stripWrappingTransactionStatements,
} from './migration-runner';
let db: Database.Database;
let storage: SQLiteStorage | null = null;

export function getDb(): Database.Database {
  if (!db) {
    throw new Error(
      'Database not initialized. Call database-bootstrap initDatabase() first.',
    );
  }
  return db;
}

/**
 * Open the process-owned connection and verify/apply the SQL migration
 * boundary. Runtime boot and one-shot data maintenance live in
 * database-bootstrap.ts, whose one-way imports avoid a database -> service ->
 * database cycle.
 */
export function initializeDatabaseCore(): Database.Database {
  storage = new SQLiteStorage();
  storage.open(config.app.databasePath);
  setStorageProvider(storage);
  db = storage.raw();
  runMigrations();
  return db;
}

/** Bind an already-open release database only in a fresh one-shot process. */
export function withReleaseMaintenanceDatabase<T>(
  releaseDatabase: Database.Database,
  callback: () => T,
): T {
  const previousDb = db as Database.Database | undefined;
  if (previousDb !== undefined || storage !== null) {
    throw new Error('release data maintenance requires an uninitialized one-shot database process');
  }
  (db as any) = releaseDatabase;
  try {
    return callback();
  } finally {
    (db as any) = previousDb;
  }
}

function runMigrations(
  options: {
    excludeFiles?: ReadonlySet<string>;
    stopBefore?: string;
    migrationsDirectory?: string;
  } = {},
  contentWorkspaceReadinessCheck: ((database: Database.Database) => void) | null = assertContentWorkspaceBootReadiness,
): void {
  if (config.app.migrationsMode === 'external') {
    // Fail closed rather than skipping quietly. A silent skip would let the
    // application serve traffic against a schema the release never migrated;
    // refusing to boot surfaces the missing migrator run while the previous
    // container is still the one answering requests.
    ensureMigrationSqlFunctions(db);
    const plan = loadReleaseMigrationPlan(options);
    if (!plan && process.env.NODE_ENV === 'production') {
      throw new Error(
        'MIGRATIONS_MODE=external requires NEXUS_RELEASE_MIGRATION_PLAN in production',
      );
    }
    const releaseIdentity = releaseDataMaintenanceIdentityFromEnvironment();
    if (plan && (
      releaseIdentity.releaseId !== plan.identity.releaseId
      || releaseIdentity.sourceSha !== plan.identity.sourceSha
      || releaseIdentity.backendImageDigest !== plan.identity.backendImageDigest
    )) {
      throw new Error('release migration plan identity does not match the application release identity');
    }
    const pending = pendingMigrationFiles(db, {
      ...options,
      requireCompleteInventory: true,
      allowedLegacyFiles: plan
        ? new Set(plan.legacyRows.map((entry) => entry.file))
        : undefined,
      allowedForwardFiles: plan?.mode === 'rollback'
        ? new Set(plan.forwardApplied.map((entry) => entry.file))
        : undefined,
    });
    if (pending.length > 0) {
      throw new Error(
        `MIGRATIONS_MODE=external but ${pending.length} migration(s) are unapplied `
        + `(first: ${pending[0]}). Run the release migrator before starting the application.`,
      );
    }
    assertReleaseDataMaintenanceComplete(db, releaseIdentity);
    logger.info(
      { migrationsMode: 'external', releaseId: releaseIdentity.releaseId },
      'SQL migrations and release data maintenance verified as externally completed',
    );
  } else {
    applyPendingMigrations(db, { ...options, logger });
  }

  if (contentWorkspaceReadinessCheck) {
    // Migrations 246, 247, 249, 250, 251, and 253 retire legacy Content
    // authorities. Refuse to serve if any reviewed canonical cutover invariant
    // is missing or has drifted.
    contentWorkspaceReadinessCheck(db);
  }
}

export function runMigrationsForTest(
  testDb: Database.Database,
  options: {
    excludeFiles?: readonly string[];
    stopBefore?: string;
    migrationsDirectory?: string;
    contentWorkspaceReadinessCheck?: (database: Database.Database) => void;
  } = {},
): void {
  const previousDb = db as Database.Database | undefined;
  (db as any) = testDb;
  try {
    runMigrations({
      excludeFiles: new Set(options.excludeFiles ?? []),
      stopBefore: options.stopBefore,
      migrationsDirectory: options.migrationsDirectory,
    }, options.contentWorkspaceReadinessCheck ?? null);
  } finally {
    (db as any) = previousDb;
  }
}

/**
 * Exercise the exact production migration application path in migration tests,
 * including duplicate-column filtering after runtime self-healing. This does
 * not bypass ordering in production; callers must name an explicit test file.
 */
export function applyMigrationFileForTest(testDb: Database.Database, filename: string): void {
  applyMigrationFile(testDb, filename, logger);
}

/** Bind getDb() to an in-memory database while exercising runtime self-heal code. */
export function withDatabaseForTest<T>(testDb: Database.Database, callback: () => T): T {
  const previousDb = db as Database.Database | undefined;
  (db as any) = testDb;
  try {
    return callback();
  } finally {
    (db as any) = previousDb;
  }
}

/** Async counterpart used by services that hold a scoped test database across locks/awaits. */
export async function withDatabaseForTestAsync<T>(
  testDb: Database.Database,
  callback: () => Promise<T>,
  options: { requireUninitialized?: boolean } = {},
): Promise<T> {
  const previousDb = db as Database.Database | undefined;
  if (
    options.requireUninitialized
    && (previousDb !== undefined || storage !== null)
  ) {
    throw new Error(
      'Standalone operational-tool database binding requires an uninitialized process database.',
    );
  }
  (db as any) = testDb;
  try {
    return await callback();
  } finally {
    (db as any) = previousDb;
  }
}

export function filterAlreadyAppliedAddColumnStatements(
  sql: string,
  columnExists: (table: string, column: string) => boolean = (table, column) => {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return columns.some((entry) => entry.name === column);
  },
): string {
  return filterMigrationAddColumns(db, sql, columnExists, logger);
}

export function closeDatabase(): void {
  if (storage) {
    storage.close();
    clearStorageProvider();
    storage = null;
  }
  logger.info('Database closed');
}
