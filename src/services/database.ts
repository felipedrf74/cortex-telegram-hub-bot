// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import Database from 'better-sqlite3';
import { config } from '../config';
import { logger } from '../utils/logger';
import { SQLiteStorage, setStorageProvider, clearStorageProvider } from './storage-provider';
import { assertContentWorkspaceBootReadiness } from './content-workspace-boot-readiness';
import { loadPersistedModelOverrides } from './persisted-model-overrides';
import {
  applyMigrationFile,
  applyPendingMigrations,
  filterAlreadyAppliedAddColumnStatements as filterMigrationAddColumns,
} from './migration-runner';

export {
  assertNoUnexpectedMigrationPrefixCollisions,
  findUnexpectedMigrationPrefixCollisions,
  stripWrappingTransactionStatements,
} from './migration-runner';
let db: Database.Database;
let storage: SQLiteStorage | null = null;

export function getDb(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return db;
}

export function initDatabase(): Database.Database {
  // Initialize via StorageProvider — single connection, shared via raw()
  storage = new SQLiteStorage();
  storage.open(config.app.databasePath);
  setStorageProvider(storage);

  // Expose raw driver for backward compatibility (state files use getDb())
  db = storage.raw();

  runMigrations();

  try {
    const { backfillLegacyRefreshTokenHashes } = require('./ios-auth-session');
    const result = backfillLegacyRefreshTokenHashes();
    if (result.hashedRows > 0 || result.clearedPlaintextRows > 0) {
      logger.warn(
        result,
        'iOS auth migration: hashed legacy refresh tokens and cleared plaintext',
      );
    }
  } catch (err) {
    logger.error({ err }, 'iOS auth refresh-token hash backfill failed — investigate before next deploy');
  }

  // Load persisted model overrides from kv_store after migrations create the
  // table. This is fail-closed: an invalid local-model selector must prevent
  // startup rather than silently falling back to another routing state.
  loadPersistedModelOverrides();

  // Load persisted settings overrides from kv_store
  try {
    const { DatabaseConfigProvider, setConfigProvider } = require('./config-provider');
    const dbConfig = new DatabaseConfigProvider();
    dbConfig.loadPersistedSettings();
    setConfigProvider(dbConfig);
  } catch { /* config-provider not yet available — non-critical */ }

  // Seed the owner user only from explicit OWNER_TELEGRAM_ID, then verify
  // the runtime still has an unambiguous owner bootstrap source.
  try {
    const { seedOwnerUser, assertOwnerBootstrapReadyForRuntime } = require('./user-service');
    seedOwnerUser();
    assertOwnerBootstrapReadyForRuntime();
  } catch (err) {
    logger.error({ err }, 'Owner bootstrap initialization failed');
    throw err;
  }

  // OAuth encryption is mandatory: refuse to start without a key, then
  // run a one-shot in-place migration that encrypts any legacy plaintext
  // rows. See audit P0-7. assertOAuthEncryptionConfigured() throws if no
  // key is set — that's intentional, the bot must not run without it.
  const { assertOAuthEncryptionConfigured, encryptPlaintextOAuthTokens, migrateOwnerTokens } = require('./oauth-store');
  assertOAuthEncryptionConfigured();
  try {
    const result = encryptPlaintextOAuthTokens();
    if (result.encryptedRows > 0) {
      logger.warn(
        result,
        `OAuth migration: encrypted ${result.encryptedRows} legacy plaintext rows in-place`,
      );
    } else {
      logger.info(result, 'OAuth migration: all rows already encrypted');
    }
  } catch (err) {
    logger.error({ err }, 'OAuth plaintext migration failed — investigate before next deploy');
  }

  // Finance and Garmin hold user-sensitive data that is also covered by
  // database backups. Assert encryption at boot in production and encrypt
  // any legacy plaintext shadow columns before the app starts serving.
  try {
    const { assertFinanceEncryptionConfigured, encryptPlaintextFinanceRows } = require('./finance-tracker');
    assertFinanceEncryptionConfigured();
    const result = encryptPlaintextFinanceRows();
    if (result.encryptedTransactions > 0 || result.encryptedTaxEvents > 0) {
      logger.warn(result, 'Finance migration: encrypted legacy plaintext finance rows in-place');
    } else {
      logger.info(result, 'Finance migration: all rows already encrypted');
    }
  } catch (err) {
    logger.error({ err }, 'Finance plaintext migration failed — investigate before next deploy');
    throw err;
  }

  try {
    const { assertGarminEncryptionConfigured, encryptPlaintextGarminTokens } = require('./garmin-session-store');
    assertGarminEncryptionConfigured();
    const result = encryptPlaintextGarminTokens();
    if (result.encryptedSessions > 0 || result.encryptedUserTokens > 0) {
      logger.warn(result, 'Garmin migration: encrypted legacy plaintext token rows in-place');
    } else {
      logger.info(result, 'Garmin migration: all rows already encrypted');
    }
  } catch (err) {
    logger.error({ err }, 'Garmin plaintext migration failed — investigate before next deploy');
    throw err;
  }

  // Migrate owner's OAuth tokens from .env to per-user storage
  try {
    migrateOwnerTokens();
  } catch { /* oauth-store not yet available — non-critical */ }

  // Seed default skills into installed_skills table (idempotent)
  try {
    const { seedDefaultSkills } = require('../skills/skill-manager');
    seedDefaultSkills();
  } catch { /* skill-manager not yet available — non-critical */ }

  logger.info({ path: config.app.databasePath }, 'Database initialized');
  return db;
}

function runMigrations(
  options: {
    excludeFiles?: ReadonlySet<string>;
    stopBefore?: string;
  } = {},
  contentWorkspaceReadinessCheck: ((database: Database.Database) => void) | null = assertContentWorkspaceBootReadiness,
): void {
  applyPendingMigrations(db, { ...options, logger });

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
    contentWorkspaceReadinessCheck?: (database: Database.Database) => void;
  } = {},
): void {
  const previousDb = db as Database.Database | undefined;
  (db as any) = testDb;
  try {
    runMigrations({
      excludeFiles: new Set(options.excludeFiles ?? []),
      stopBefore: options.stopBefore,
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
): Promise<T> {
  const previousDb = db as Database.Database | undefined;
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
