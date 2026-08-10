// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { createHash } from 'node:crypto';

type MigrationLogger = Pick<typeof import('../utils/logger').logger, 'info' | 'warn'>;

export type MigrationPrefixCollision = {
  prefix: string;
  files: string[];
};

export type MigrationSourceOptions = {
  migrationsDirectory?: string;
};

export type MigrationSelectionOptions = MigrationSourceOptions & {
  excludeFiles?: ReadonlySet<string>;
  stopBefore?: string;
  requireCompleteInventory?: boolean;
  allowedLegacyFiles?: ReadonlySet<string>;
  allowedForwardFiles?: ReadonlySet<string>;
};

export type MigrationInventoryEntry = {
  file: string;
  sha256: string;
  kind: 'expand' | 'backfill' | 'neutral' | 'contract' | 'unknown';
  predecessorCompatible: boolean;
};

export type ReleaseMigrationLegacyRow = {
  file: string;
  retiredSha256: string;
  sourceCommit: string;
  replacement: {
    file: string;
    sha256: string;
    relationship: 'byte_identical_renumber' | 'comment_only_renumber' | 'schema_reconciliation';
  };
};

export type ReleaseMigrationPlan = {
  mode: 'candidate' | 'rollback';
  identity: {
    releaseId: string;
    sourceSha: string;
    backendImageDigest: string;
  };
  inventory: MigrationInventoryEntry[];
  reconciliationDigest: string;
  legacyRows: ReleaseMigrationLegacyRow[];
  forwardApplied: Array<{ file: string; sha256: string }>;
  rollbackSuccessor: null | {
    releaseId: string;
    sourceSha: string;
    backendImageDigest: string;
    releasePayloadDigest: string;
    manifestDigest: string;
  };
};

const LEGACY_MIGRATION_PREFIX_COLLISIONS: Record<string, string[]> = {
  '008': ['008_api_cache.sql', '008_email_log.sql'],
  '009': ['009_api_usage_provider.sql', '009_job_history.sql'],
  '022': ['022_finance_tables.sql', '022_webhook_events.sql'],
  '023': ['023_fitness_training_plans.sql', '023_onboarding.sql'],
  '024': ['024_cooking_tables.sql', '024_usage_metering.sql'],
};

const migrationFunctionsRegistered = new WeakSet<Database.Database>();

/** Deterministic, non-secret hashing helpers used by data-copy migrations. */
export function ensureMigrationSqlFunctions(database: Database.Database): void {
  if (migrationFunctionsRegistered.has(database)) return;
  database.function('nexus_sha256', { deterministic: true }, (value: unknown) => (
    createHash('sha256').update(String(value ?? '')).digest('hex')
  ));
  database.function('nexus_plain_text_revision_hash', { deterministic: true }, (value: unknown) => (
    createHash('sha256')
      .update(JSON.stringify({ format: 'plain_text', text: String(value ?? '') }))
      .digest('hex')
  ));
  migrationFunctionsRegistered.add(database);
}

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

const GOVERNED_MIGRATION_FILE = /^\d{3}_[^/]*\.sql$/;
const PREDECESSOR_COMPATIBLE_KINDS = new Set(['expand', 'backfill', 'neutral']);
const MIGRATION_KINDS = new Set([
  ...PREDECESSOR_COMPATIBLE_KINDS,
  'contract',
  'unknown',
]);
const SHA256 = /^[0-9a-f]{64}$/;
const FULL_SHA = /^[0-9a-f]{40}$/;
const OCI_DIGEST = /^sha256:[0-9a-f]{64}$/;
const RELEASE_ENVIRONMENTS = new Set(['production', 'staging']);
const RELEASE_RECONCILIATION_SCHEMA = 'nexus.release-migration-reconciliation.v2';

function exactObjectKeys(
  value: unknown,
  expected: readonly string[],
  label: string,
): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== [...expected].sort().join(',')) {
    throw new Error(`${label} fields do not match the governed schema`);
  }
  return value as Record<string, any>;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(object[key])}`
  )).join(',')}}`;
}

function resolveMigrationsDirectory(override?: string): string {
  const migrationsDirectory = path.resolve(
    override ?? path.resolve(__dirname, '../../migrations'),
  );
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(migrationsDirectory);
  } catch {
    throw new Error(`Migrations directory not found: ${migrationsDirectory}`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Migrations path is not a real directory: ${migrationsDirectory}`);
  }
  return migrationsDirectory;
}

/**
 * Resolve the complete governed migration source from the packaged runtime.
 *
 * Missing or empty cannot mean "fully migrated": both the application external
 * mode and the release migrator use this source as part of their admission
 * proof. A symlinked SQL entry is rejected as well, so a digest check cannot be
 * redirected between inventory validation and application.
 */
export function readGovernedMigrationSource(
  options: MigrationSourceOptions = {},
): { migrationsDirectory: string; files: string[] } {
  const migrationsDirectory = resolveMigrationsDirectory(options.migrationsDirectory);
  const sqlEntries = fs.readdirSync(migrationsDirectory, { withFileTypes: true })
    .filter((entry) => entry.name.endsWith('.sql'));
  const nonFiles = sqlEntries.filter((entry) => !entry.isFile()).map((entry) => entry.name).sort();
  if (nonFiles.length > 0) {
    throw new Error(`Migration source contains non-regular SQL entries: ${nonFiles.join(', ')}`);
  }
  const files = sqlEntries.map((entry) => entry.name).sort();
  if (files.length === 0) {
    throw new Error(`Migrations directory contains no governed migration files: ${migrationsDirectory}`);
  }
  const invalid = files.filter((file) => file.includes('..') || !GOVERNED_MIGRATION_FILE.test(file));
  if (invalid.length > 0) {
    throw new Error(`Migration source contains ungoverned filenames: ${invalid.join(', ')}`);
  }
  assertNoUnexpectedMigrationPrefixCollisions(files);
  return { migrationsDirectory, files };
}

/** Validate that a signed plan describes every packaged migration byte exactly. */
export function assertExactMigrationInventory(
  inventory: unknown,
  options: MigrationSourceOptions = {},
): MigrationInventoryEntry[] {
  if (!Array.isArray(inventory) || inventory.length === 0) {
    throw new Error('release migration plan inventory must be a non-empty ordered array');
  }
  const entries: MigrationInventoryEntry[] = [];
  let previous = '';
  for (const candidate of inventory) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error('release migration plan inventory entry is not an object');
    }
    const entry = candidate as Record<string, unknown>;
    if (Object.keys(entry).sort().join(',') !== 'file,kind,predecessorCompatible,sha256') {
      throw new Error('release migration plan inventory entry fields do not match the governed schema');
    }
    if (typeof entry.file !== 'string'
      || entry.file.includes('..')
      || !GOVERNED_MIGRATION_FILE.test(entry.file)) {
      throw new Error(`release migration plan entry ${String(entry.file)} is not a migration filename`);
    }
    if (entry.file <= previous) {
      throw new Error('release migration plan inventory is not strictly ordered');
    }
    if (typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
      throw new Error(`release migration plan entry ${entry.file} has no byte digest`);
    }
    if (typeof entry.kind !== 'string' || !MIGRATION_KINDS.has(entry.kind)) {
      throw new Error(`release migration plan entry ${entry.file} has an ungoverned kind`);
    }
    if (typeof entry.predecessorCompatible !== 'boolean') {
      throw new Error(`release migration plan entry ${entry.file} has no compatibility flag`);
    }
    const derivedCompatible = PREDECESSOR_COMPATIBLE_KINDS.has(entry.kind);
    if (entry.predecessorCompatible !== derivedCompatible) {
      throw new Error(
        `release migration plan entry ${entry.file} contradicts kind ${entry.kind}`,
      );
    }
    entries.push(entry as MigrationInventoryEntry);
    previous = entry.file;
  }

  const source = readGovernedMigrationSource(options);
  if (source.files.length !== entries.length
      || source.files.some((file, index) => entries[index]?.file !== file)) {
    throw new Error('release migration plan does not exactly match packaged migration files');
  }
  for (const entry of entries) {
    const actual = createHash('sha256')
      .update(fs.readFileSync(path.join(source.migrationsDirectory, entry.file)))
      .digest('hex');
    if (actual !== entry.sha256) {
      throw new Error(`release migration ${entry.file} does not match its signed byte digest`);
    }
  }
  return entries;
}

/**
 * Load the root-materialized projection of the verified signed manifest.
 * Runtime services never infer legacy aliases from filenames: the selected
 * environment must match the exact legacy rows carried by this plan.
 */
export function loadReleaseMigrationPlan(
  options: MigrationSourceOptions = {},
): ReleaseMigrationPlan | null {
  const planPath = process.env.NEXUS_RELEASE_MIGRATION_PLAN || '';
  if (!planPath) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  } catch {
    throw new Error('release migration plan is unreadable or invalid JSON');
  }
  const rawSchema = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>).schema
    : null;
  if (rawSchema !== 'nexus.release-migration-plan.v2'
      && rawSchema !== 'nexus.release-migration-plan.v3') {
    throw new Error('release migration plan is missing or has an unsupported schema');
  }
  const rollbackMode = rawSchema === 'nexus.release-migration-plan.v3';
  const plan = exactObjectKeys(raw, [
    'backendImageDigest', 'inventory', 'reconciliation', 'reconciliationDigest',
    'releaseId', ...(rollbackMode ? ['rollback'] : []), 'schema', 'sourceSha',
  ], 'release migration plan');
  if (typeof plan.releaseId !== 'string' || !/^[0-9a-f]{32}$/.test(plan.releaseId)
      || typeof plan.sourceSha !== 'string' || !FULL_SHA.test(plan.sourceSha)
      || typeof plan.backendImageDigest !== 'string' || !OCI_DIGEST.test(plan.backendImageDigest)
      || typeof plan.reconciliationDigest !== 'string' || !SHA256.test(plan.reconciliationDigest)) {
    throw new Error('release migration plan is missing or has an unsupported schema');
  }
  const inventory = assertExactMigrationInventory(plan.inventory, options);
  const reconciliation = exactObjectKeys(plan.reconciliation, [
    'compatibilityExemptions', 'environments', 'schema', 'semanticSchemaExclusions',
    'sourcePolicySha256',
  ], 'release migration reconciliation');
  if (reconciliation.schema !== RELEASE_RECONCILIATION_SCHEMA
      || typeof reconciliation.sourcePolicySha256 !== 'string'
      || !SHA256.test(reconciliation.sourcePolicySha256)
      || createHash('sha256').update(canonicalJson(reconciliation)).digest('hex')
        !== plan.reconciliationDigest) {
    throw new Error('release migration reconciliation digest or schema is invalid');
  }
  const environments = exactObjectKeys(
    reconciliation.environments,
    ['production', 'staging'],
    'release migration reconciliation environments',
  );
  const selectedEnvironment = process.env.NEXUS_RELEASE_ENVIRONMENT || '';
  if (!RELEASE_ENVIRONMENTS.has(selectedEnvironment)) {
    throw new Error('NEXUS_RELEASE_ENVIRONMENT must select production or staging');
  }
  const selected = exactObjectKeys(
    environments[selectedEnvironment],
    ['legacyRows', 'lineageIds'],
    `release migration reconciliation ${selectedEnvironment}`,
  );
  if (!Array.isArray(selected.lineageIds) || selected.lineageIds.length === 0
      || new Set(selected.lineageIds).size !== selected.lineageIds.length
      || selected.lineageIds.some((id: unknown) => (
        typeof id !== 'string' || !/^[a-z0-9-]+$/.test(id)
      ))
      || !Array.isArray(selected.legacyRows)) {
    throw new Error(`release migration reconciliation ${selectedEnvironment} is invalid`);
  }
  const inventoryByFile = new Map(inventory.map((entry) => [entry.file, entry]));
  let previous = '';
  const legacyRows = selected.legacyRows.map((candidate: unknown) => {
    const legacy = exactObjectKeys(
      candidate,
      ['file', 'replacement', 'retiredSha256', 'sourceCommit'],
      `release migration reconciliation ${selectedEnvironment} legacy row`,
    );
    const replacement = exactObjectKeys(
      legacy.replacement,
      ['file', 'relationship', 'sha256'],
      `release migration reconciliation ${selectedEnvironment} replacement`,
    );
    if (typeof legacy.file !== 'string' || !GOVERNED_MIGRATION_FILE.test(legacy.file)
        || legacy.file <= previous
        || typeof legacy.sourceCommit !== 'string' || !FULL_SHA.test(legacy.sourceCommit)
        || typeof replacement.file !== 'string' || !GOVERNED_MIGRATION_FILE.test(replacement.file)
        || typeof replacement.sha256 !== 'string' || !SHA256.test(replacement.sha256)
        || !['byte_identical_renumber', 'comment_only_renumber', 'schema_reconciliation']
          .includes(replacement.relationship)
        || inventoryByFile.get(replacement.file)?.sha256 !== replacement.sha256) {
      throw new Error(`release migration reconciliation ${selectedEnvironment} legacy row is invalid`);
    }
    previous = legacy.file;
    return legacy as ReleaseMigrationLegacyRow;
  });
  if (!Array.isArray(reconciliation.compatibilityExemptions)
      || reconciliation.compatibilityExemptions.length !== 1
      || !Array.isArray(reconciliation.semanticSchemaExclusions)) {
    throw new Error('release migration reconciliation governed policies are invalid');
  }
  for (const candidate of reconciliation.compatibilityExemptions) {
    const exemption = exactObjectKeys(candidate, [
      'allowedDropIndexes', 'effectiveKind', 'file', 'genericKind', 'id', 'reason', 'sha256',
    ], 'release migration compatibility exemption');
    const entry = inventoryByFile.get(exemption.file);
    if (!entry || entry.sha256 !== exemption.sha256
        || entry.kind !== exemption.effectiveKind
        || entry.predecessorCompatible !== true
        || !Array.isArray(exemption.allowedDropIndexes)
        || exemption.allowedDropIndexes.length === 0) {
      throw new Error('release migration compatibility exemption does not match inventory');
    }
    for (const candidateTransition of exemption.allowedDropIndexes) {
      const transition = exactObjectKeys(candidateTransition, [
        'allowAbsent', 'columns', 'name', 'replacement', 'tableName', 'unique',
      ], 'release migration compatibility index transition');
      const replacement = exactObjectKeys(transition.replacement, [
        'columns', 'name', 'tableName', 'unique',
      ], 'release migration compatibility replacement index');
      const validIdentifier = (value: unknown) => (
        typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value)
      );
      const validColumns = (value: unknown) => (
        Array.isArray(value) && value.length > 0
        && new Set(value).size === value.length
        && value.every(validIdentifier)
      );
      if (!validIdentifier(transition.name) || !validIdentifier(transition.tableName)
          || !validColumns(transition.columns) || transition.unique !== true
          || transition.allowAbsent !== true
          || !validIdentifier(replacement.name) || !validIdentifier(replacement.tableName)
          || !validColumns(replacement.columns) || replacement.unique !== true) {
        throw new Error('release migration compatibility index transition is invalid');
      }
    }
  }
  let forwardApplied: Array<{ file: string; sha256: string }> = [];
  let rollbackSuccessor: ReleaseMigrationPlan['rollbackSuccessor'] = null;
  if (rollbackMode) {
    if (selectedEnvironment !== 'production') {
      throw new Error('rollback migration plans are admitted only for production verification');
    }
    const rollback = exactObjectKeys(
      plan.rollback,
      ['forwardApplied', 'successor'],
      'release rollback migration plan',
    );
    const successor = exactObjectKeys(rollback.successor, [
      'backendImageDigest', 'manifestDigest', 'releaseId', 'releasePayloadDigest', 'sourceSha',
    ], 'release rollback successor');
    if (typeof successor.releaseId !== 'string'
        || !/^[0-9a-f]{32}$/.test(successor.releaseId)
        || successor.releaseId === plan.releaseId
        || typeof successor.sourceSha !== 'string' || !FULL_SHA.test(successor.sourceSha)
        || typeof successor.backendImageDigest !== 'string'
        || !OCI_DIGEST.test(successor.backendImageDigest)
        || typeof successor.releasePayloadDigest !== 'string'
        || !OCI_DIGEST.test(successor.releasePayloadDigest)
        || typeof successor.manifestDigest !== 'string' || !SHA256.test(successor.manifestDigest)) {
      throw new Error('release rollback successor identity is invalid');
    }
    if (!Array.isArray(rollback.forwardApplied) || rollback.forwardApplied.length > 1024) {
      throw new Error('release rollback forward-applied suffix is invalid');
    }
    let previousForward = inventory[inventory.length - 1]?.file ?? '';
    forwardApplied = rollback.forwardApplied.map((candidate: unknown) => {
      const entry = exactObjectKeys(
        candidate,
        ['file', 'sha256'],
        'release rollback forward-applied entry',
      );
      if (typeof entry.file !== 'string'
          || !GOVERNED_MIGRATION_FILE.test(entry.file)
          || entry.file <= previousForward
          || legacyRows.some((legacy) => legacy.file === entry.file)
          || typeof entry.sha256 !== 'string' || !SHA256.test(entry.sha256)) {
        throw new Error('release rollback forward-applied suffix is not strictly ordered');
      }
      previousForward = entry.file;
      return { file: entry.file, sha256: entry.sha256 };
    });
    rollbackSuccessor = {
      releaseId: successor.releaseId,
      sourceSha: successor.sourceSha,
      backendImageDigest: successor.backendImageDigest,
      releasePayloadDigest: successor.releasePayloadDigest,
      manifestDigest: successor.manifestDigest,
    };
  }
  return {
    mode: rollbackMode ? 'rollback' : 'candidate',
    identity: {
      releaseId: plan.releaseId,
      sourceSha: plan.sourceSha,
      backendImageDigest: plan.backendImageDigest,
    },
    inventory,
    reconciliationDigest: plan.reconciliationDigest,
    legacyRows,
    forwardApplied,
    rollbackSuccessor,
  };
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
  ensureMigrationSqlFunctions(database);
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

/**
 * List migrations present on disk that the ledger has not recorded.
 *
 * This is read-only on purpose: containerized deployments apply migrations from
 * a dedicated one-shot service, and the application process needs a way to
 * verify that already happened without being able to apply anything itself.
 */
export function pendingMigrationFiles(
  database: Database.Database,
  options: MigrationSelectionOptions = {},
): string[] {
  const source = readGovernedMigrationSource(options);
  const files = source.files;
  let applied = new Set<string>();
  const ledgerExists = database
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_migrations'")
    .get();
  if (ledgerExists) {
    applied = new Set(
      (database.prepare('SELECT filename FROM _migrations').all() as Array<{ filename: string }>)
        .map((row) => row.filename),
    );
  }
  if (options.requireCompleteInventory) {
    const packaged = new Set(files);
    const absent = [...applied].filter((file) => !packaged.has(file)).sort();
    const allowedOutsideInventory = [...new Set([
      ...(options.allowedLegacyFiles ?? new Set<string>()),
      ...(options.allowedForwardFiles ?? new Set<string>()),
    ])].sort();
    if (!sameMembers(absent, allowedOutsideInventory)) {
      const allowed = new Set(allowedOutsideInventory);
      const unexpected = absent.filter((file) => !allowed.has(file));
      const missing = allowedOutsideInventory.filter((file) => !applied.has(file));
      throw new Error(
        'applied migration files outside the packaged inventory do not exactly match '
        + `the signed legacy set plus rollback suffix (unexpected: ${unexpected[0] ?? 'none'}; `
        + `missing: ${missing[0] ?? 'none'})`,
      );
    }
    // Membership alone is insufficient: 001 + 003 with 002 absent would make
    // the migrator apply older SQL after a later schema transition. Require the
    // canonical rows to be exactly the leading packaged prefix before returning
    // any pending suffix. Exact signed legacy and authorized rollback-forward
    // rows remain outside this predecessor-package ordering.
    const canonicalApplied = files.filter((file) => applied.has(file));
    const expectedPrefix = files.slice(0, canonicalApplied.length);
    const divergence = canonicalApplied.findIndex((file, index) => file !== expectedPrefix[index]);
    if (divergence !== -1) {
      throw new Error(
        'applied canonical migrations do not form an ordered packaged inventory prefix '
        + `(unexpected: ${canonicalApplied[divergence]}; expected: ${expectedPrefix[divergence]})`,
      );
    }
  }
  return files.filter((file) => {
    if (options.excludeFiles?.has(file)) return false;
    if (options.stopBefore && file >= options.stopBefore) return false;
    return !applied.has(file);
  });
}

export function applyPendingMigrations(
  database: Database.Database,
  options: {
    excludeFiles?: ReadonlySet<string>;
    stopBefore?: string;
    logger?: MigrationLogger;
    migrationsDirectory?: string;
  } = {},
): void {
  // SQLite functions are connection-local. Register them even when every
  // migration is already applied so runtime readiness views remain queryable
  // after another process opens the same migrated database.
  ensureMigrationSqlFunctions(database);
  const source = readGovernedMigrationSource(options);
  const migrationsDir = source.migrationsDirectory;
  const files = source.files;
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
  migrationsDirectory?: string,
): void {
  if (filename.includes('..') || !GOVERNED_MIGRATION_FILE.test(filename)) {
    throw new Error(`Migration filename is not governed: ${filename}`);
  }
  const migrationsDir = resolveMigrationsDirectory(migrationsDirectory);
  const filePath = path.join(migrationsDir, filename);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch {
    throw new Error(`Migration not found: ${filename}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Migration is not a regular file: ${filename}`);
  }
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
