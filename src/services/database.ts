// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { logger } from '../utils/logger';
import { SQLiteStorage, setStorageProvider, clearStorageProvider } from './storage-provider';

let db: Database.Database;
let storage: SQLiteStorage | null = null;

type MigrationPrefixCollision = {
  prefix: string;
  files: string[];
};

const LEGACY_MIGRATION_PREFIX_COLLISIONS: Record<string, string[]> = {
  '008': ['008_api_cache.sql', '008_email_log.sql'],
  '009': ['009_api_usage_provider.sql', '009_job_history.sql'],
  '022': ['022_finance_tables.sql', '022_webhook_events.sql'],
  '023': ['023_fitness_training_plans.sql', '023_onboarding.sql'],
  '024': ['024_cooking_tables.sql', '024_usage_metering.sql'],
};

function sameMembers(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((value, index) => value === right[index]);
}

export function findUnexpectedMigrationPrefixCollisions(
  files: readonly string[],
): MigrationPrefixCollision[] {
  const prefixMap = new Map<string, string[]>();
  for (const f of files) {
    const m = f.match(/^(\d{3})_/);
    if (m) {
      const prefix = m[1];
      const list = prefixMap.get(prefix) ?? [];
      list.push(f);
      prefixMap.set(prefix, list);
    }
  }

  return [...prefixMap.entries()]
    .filter(([, list]) => list.length > 1)
    .filter(([prefix, list]) => !sameMembers(list, LEGACY_MIGRATION_PREFIX_COLLISIONS[prefix] ?? []))
    .map(([prefix, list]) => ({ prefix, files: [...list].sort() }));
}

export function assertNoUnexpectedMigrationPrefixCollisions(files: readonly string[]): void {
  const collisions = findUnexpectedMigrationPrefixCollisions(files);
  if (collisions.length === 0) return;

  const details = collisions
    .map(({ prefix, files: list }) => `${prefix}: ${list.join(', ')}`)
    .join('; ');
  throw new Error(
    `Unexpected migration prefix collision(s): ${details}. Use a unique migration prefix; legacy duplicate prefixes are explicitly allowlisted only for historical files.`,
  );
}

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

  // Load persisted model overrides from kv_store (after migrations create the table)
  try {
    const { loadModelOverrides } = require('./model-config');
    loadModelOverrides();
  } catch { /* model-config not yet available — non-critical */ }

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

function runMigrations(): void {
  const migrationsDir = path.resolve(__dirname, '../../migrations');
  if (!fs.existsSync(migrationsDir)) {
    logger.warn('Migrations directory not found');
    return;
  }

  const files = fs.readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  // Lint: fail on numeric prefix collisions. Apply order between two files
  // sharing the same prefix is filesystem-sort-dependent (locale, OS), so
  // collisions are silent timebombs for cross-environment schema drift.
  assertNoUnexpectedMigrationPrefixCollisions(files);

  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL UNIQUE,
      applied_at TEXT DEFAULT (datetime('now'))
    );
  `);

  const applied = new Set(
    db.prepare('SELECT filename FROM _migrations').all()
      .map((row: any) => row.filename)
  );

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    applyMigration(file, sql);
    logger.info({ migration: file }, 'Migration applied');
  }
}

function applyMigration(filename: string, rawSql: string): void {
  const needsForeignKeysOff = /\bPRAGMA\s+foreign_keys\s*=\s*OFF\b/i.test(rawSql);
  const priorForeignKeys = Number(db.pragma('foreign_keys', { simple: true })) === 1;
  const sql = filterAlreadyAppliedAddColumnStatements(
    stripWrappingTransactionStatements(stripForeignKeyPragmas(rawSql)),
  );

  if (needsForeignKeysOff) {
    db.pragma('foreign_keys = OFF');
  }

  try {
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(filename);
    })();
  } finally {
    db.pragma(`foreign_keys = ${priorForeignKeys ? 'ON' : 'OFF'}`);
  }
}

function stripForeignKeyPragmas(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !/^\s*PRAGMA\s+foreign_keys\s*=/i.test(line))
    .join('\n');
}

export function stripWrappingTransactionStatements(sql: string): string {
  let insideTrigger = false;
  return sql
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      if (/^CREATE\s+(?:TEMP(?:ORARY)?\s+)?TRIGGER\b/i.test(trimmed)) {
        insideTrigger = true;
      }
      const isWrapper = !insideTrigger
        && /^(BEGIN(?:\s+TRANSACTION)?|COMMIT(?:\s+TRANSACTION)?|END(?:\s+TRANSACTION)?)\s*;$/i.test(trimmed);
      if (insideTrigger && /^END\s*;$/i.test(trimmed)) {
        insideTrigger = false;
      }
      return !isWrapper;
    })
    .join('\n');
}

export function runMigrationsForTest(testDb: Database.Database): void {
  const previousDb = db as Database.Database | undefined;
  (db as any) = testDb;
  try {
    runMigrations();
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
  return sql
    .split(';')
    .map((statement, index, statements) => {
      const suffix = index < statements.length - 1 ? ';' : '';
      const match = statement.match(/\bALTER\s+TABLE\s+([A-Za-z_][\w]*)\s+ADD\s+COLUMN\s+([A-Za-z_][\w]*)\b/i);
      if (!match) return `${statement}${suffix}`;
      const [, table, column] = match;
      try {
        if (!columnExists(table, column)) return `${statement}${suffix}`;
        logger.warn({ table, column }, 'Migration ADD COLUMN already applied; skipping duplicate column statement');
        return '';
      } catch {
        return `${statement}${suffix}`;
      }
    })
    .join('');
}

export function closeDatabase(): void {
  if (storage) {
    storage.close();
    clearStorageProvider();
    storage = null;
  }
  logger.info('Database closed');
}
