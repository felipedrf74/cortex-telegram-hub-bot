// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

type MigrationLogger = Pick<typeof import('../utils/logger').logger, 'info' | 'warn'>;

export type MigrationPrefixCollision = {
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
  for (const file of files) {
    const match = file.match(/^(\d{3})_/);
    if (!match) continue;
    const list = prefixMap.get(match[1]) ?? [];
    list.push(file);
    prefixMap.set(match[1], list);
  }

  return [...prefixMap.entries()]
    .filter(([, list]) => list.length > 1)
    .filter(([prefix, list]) => !sameMembers(list, LEGACY_MIGRATION_PREFIX_COLLISIONS[prefix] ?? []))
    .map(([prefix, list]) => ({ prefix, files: [...list].sort() }));
}

export function assertNoUnexpectedMigrationPrefixCollisions(files: readonly string[]): void {
  const collisions = findUnexpectedMigrationPrefixCollisions(files);
  if (collisions.length === 0) return;
  const details = collisions.map(({ prefix, files: list }) => `${prefix}: ${list.join(', ')}`).join('; ');
  throw new Error(
    `Unexpected migration prefix collision(s): ${details}. Use a unique migration prefix; legacy duplicate prefixes are explicitly allowlisted only for historical files.`,
  );
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
      if (/^CREATE\s+(?:TEMP(?:ORARY)?\s+)?TRIGGER\b/i.test(trimmed)) insideTrigger = true;
      const isWrapper = !insideTrigger
        && /^(BEGIN(?:\s+TRANSACTION)?|COMMIT(?:\s+TRANSACTION)?|END(?:\s+TRANSACTION)?)\s*;$/i.test(trimmed);
      if (insideTrigger && /^END\s*;$/i.test(trimmed)) insideTrigger = false;
      return !isWrapper;
    })
    .join('\n');
}

export function filterAlreadyAppliedAddColumnStatements(
  database: Database.Database,
  sql: string,
  columnExists: (table: string, column: string) => boolean = (table, column) => {
    const columns = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return columns.some((entry) => entry.name === column);
  },
  logger?: MigrationLogger,
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
        logger?.warn({ table, column }, 'Migration ADD COLUMN already applied; skipping duplicate column statement');
        return '';
      } catch {
        return `${statement}${suffix}`;
      }
    })
    .join('');
}

function applyMigration(
  database: Database.Database,
  filename: string,
  rawSql: string,
  logger?: MigrationLogger,
): void {
  const needsForeignKeysOff = /\bPRAGMA\s+foreign_keys\s*=\s*OFF\b/i.test(rawSql);
  const priorForeignKeys = Number(database.pragma('foreign_keys', { simple: true })) === 1;
  const sql = filterAlreadyAppliedAddColumnStatements(
    database,
    stripWrappingTransactionStatements(stripForeignKeyPragmas(rawSql)),
    undefined,
    logger,
  );

  if (needsForeignKeysOff) database.pragma('foreign_keys = OFF');
  try {
    database.transaction(() => {
      database.exec(sql);
      database.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(filename);
    })();
  } finally {
    database.pragma(`foreign_keys = ${priorForeignKeys ? 'ON' : 'OFF'}`);
  }
}

export function applyPendingMigrations(
  database: Database.Database,
  options: {
    excludeFiles?: ReadonlySet<string>;
    stopBefore?: string;
    logger?: MigrationLogger;
  } = {},
): void {
  const migrationsDir = path.resolve(__dirname, '../../migrations');
  if (!fs.existsSync(migrationsDir)) {
    options.logger?.warn('Migrations directory not found');
    return;
  }
  const files = fs.readdirSync(migrationsDir).filter((file) => file.endsWith('.sql')).sort();
  assertNoUnexpectedMigrationPrefixCollisions(files);
  database.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL UNIQUE,
      applied_at TEXT DEFAULT (datetime('now'))
    );
  `);
  const applied = new Set(
    (database.prepare('SELECT filename FROM _migrations').all() as Array<{ filename: string }>)
      .map((row) => row.filename),
  );
  for (const file of files) {
    if (options.excludeFiles?.has(file)) continue;
    if (options.stopBefore && file >= options.stopBefore) break;
    if (applied.has(file)) continue;
    applyMigration(database, file, fs.readFileSync(path.join(migrationsDir, file), 'utf8'), options.logger);
    options.logger?.info({ migration: file }, 'Migration applied');
  }
}

export function applyMigrationFile(
  database: Database.Database,
  filename: string,
  logger?: MigrationLogger,
): void {
  const migrationsDir = path.resolve(__dirname, '../../migrations');
  const filePath = path.join(migrationsDir, filename);
  if (!fs.existsSync(filePath)) throw new Error(`Migration not found: ${filename}`);
  database.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL UNIQUE,
      applied_at TEXT DEFAULT (datetime('now'))
    );
  `);
  if (database.prepare('SELECT 1 FROM _migrations WHERE filename = ?').get(filename)) return;
  applyMigration(database, filename, fs.readFileSync(filePath, 'utf8'), logger);
}
