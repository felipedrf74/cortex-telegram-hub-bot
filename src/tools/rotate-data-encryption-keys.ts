// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Offline, fail-closed rotation for the encrypted OAuth, webhook, Garmin,
 * Apple Health, and finance fields stored in SQLite.
 *
 * Dry-run is the default. Apply is deliberately guarded by an exact
 * service-stop acknowledgement and a protected SQLite backup whose encrypted
 * rotation surface matches the source database. Secrets are accepted only via
 * the programmatic API or environment variables; the CLI never accepts or
 * prints key material or decrypted values.
 */

import crypto from 'node:crypto';
import {
  accessSync,
  constants as fsConstants,
  realpathSync,
  statSync,
} from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import { decryptValue, encryptValue } from '../utils/encryption';

export const SERVICE_STOPPED_ACKNOWLEDGEMENT = 'SERVICES_STOPPED_AND_WRITES_DRAINED';

type RotationDomain = 'oauth' | 'garmin' | 'health' | 'finance';

export interface DataEncryptionDomainKeys {
  oauth: string;
  garmin: string;
  health: string;
  finance: string;
}

export interface DataEncryptionRotationKeys {
  /** Keys that currently decrypt the rows. Shared legacy keys are allowed. */
  old: DataEncryptionDomainKeys;
  /** New, dedicated keys for this environment. */
  next: DataEncryptionDomainKeys;
  /** Active keys in the other environment, used to prevent cross-environment reuse. */
  peer: DataEncryptionDomainKeys;
}

export interface DataEncryptionRotationOptions {
  databasePath: string;
  environment: 'production' | 'staging';
  keys: DataEncryptionRotationKeys;
  apply?: boolean;
  backupPath?: string;
  servicesStoppedAcknowledgement?: string;
}

export interface DataEncryptionRotationTableReport {
  table: string;
  present: boolean;
  rows: number;
  nonempty: number;
  needsRotation: number;
  alreadyNew: number;
  undecryptable: number;
}

export interface DataEncryptionRotationCounts {
  nonempty: number;
  needsRotation: number;
  alreadyNew: number;
  undecryptable: number;
}

export interface DataEncryptionRotationResult {
  mode: 'dry-run' | 'apply';
  environment: 'production' | 'staging';
  tables: DataEncryptionRotationTableReport[];
  totals: DataEncryptionRotationCounts;
  appliedValues: number;
  backupVerified: boolean;
  postVerification: DataEncryptionRotationCounts & { verified: boolean };
}

type RotationTableSpec = {
  table: string;
  primaryKey: string;
  userIdColumn: string;
  domain: RotationDomain;
  encryptedColumns: readonly string[];
  requirePositiveUserId?: boolean;
  envelopePrefix?: string;
  legacyJsonColumns?: readonly string[];
};

type RotationCandidate = {
  table: string;
  primaryKey: number;
  primaryKeyColumn: string;
  userId: number;
  column: string;
  originalCiphertext: string;
  plaintext: string;
  destinationKey: string;
  envelopePrefix?: string;
};

type ScanResult = {
  tables: DataEncryptionRotationTableReport[];
  totals: DataEncryptionRotationCounts;
  candidates: RotationCandidate[];
};

const TABLE_SPECS: readonly RotationTableSpec[] = [
  {
    table: 'user_oauth_tokens',
    primaryKey: 'id',
    userIdColumn: 'user_id',
    domain: 'oauth',
    encryptedColumns: ['access_token', 'refresh_token'],
  },
  {
    table: 'webhook_subscriptions',
    primaryKey: 'id',
    userIdColumn: 'user_id',
    domain: 'oauth',
    encryptedColumns: ['secret', 'metadata'],
    requirePositiveUserId: true,
    envelopePrefix: 'nexus-webhook-json-v1:',
    legacyJsonColumns: ['metadata'],
  },
  {
    table: 'webhook_events',
    primaryKey: 'id',
    userIdColumn: 'user_id',
    domain: 'oauth',
    encryptedColumns: ['payload', 'headers'],
    requirePositiveUserId: true,
    envelopePrefix: 'nexus-webhook-json-v1:',
    legacyJsonColumns: ['payload', 'headers'],
  },
  {
    table: 'garmin_sessions',
    primaryKey: 'user_id',
    userIdColumn: 'user_id',
    domain: 'garmin',
    encryptedColumns: ['oauth1_token_json', 'oauth2_token_json'],
  },
  {
    table: 'garmin_user_tokens',
    primaryKey: 'id',
    userIdColumn: 'user_id',
    domain: 'garmin',
    encryptedColumns: ['garmin_email', 'tokens_json'],
  },
  {
    table: 'apple_health_data',
    primaryKey: 'id',
    userIdColumn: 'user_id',
    domain: 'health',
    encryptedColumns: ['encrypted_data_json'],
  },
  {
    table: 'finance_transactions',
    primaryKey: 'id',
    userIdColumn: 'user_id',
    domain: 'finance',
    encryptedColumns: ['encrypted_amount', 'encrypted_description'],
  },
  {
    table: 'finance_tax_events',
    primaryKey: 'id',
    userIdColumn: 'user_id',
    domain: 'finance',
    encryptedColumns: [
      'encrypted_gross_income',
      'encrypted_deductions',
      'encrypted_taxable_income',
      'encrypted_tax_due',
      'encrypted_inss_due',
      'encrypted_notes',
    ],
  },
] as const;

function tableExists(db: Database.Database, table: string): boolean {
  return Boolean(db.prepare(`
    SELECT 1
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
  `).get(table));
}

function assertExpectedColumns(db: Database.Database, spec: RotationTableSpec): void {
  const actual = new Set(
    (db.prepare(`PRAGMA table_info(${spec.table})`).all() as Array<{ name: string }>)
      .map((column) => column.name),
  );
  const expected = [spec.primaryKey, spec.userIdColumn, ...spec.encryptedColumns];
  const missing = expected.filter((column) => !actual.has(column));
  if (missing.length > 0) {
    throw new Error(`${spec.table} is missing required rotation columns`);
  }
}

function isValidRowId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function canDecrypt(ciphertext: string, key: string, userId: number): string | undefined {
  try {
    return decryptValue(ciphertext, key, userId);
  } catch {
    return undefined;
  }
}

function isValidLegacyPlaintext(
  spec: RotationTableSpec,
  column: string,
  plaintext: string,
): boolean {
  if (!spec.legacyJsonColumns?.includes(column)) return true;
  try {
    JSON.parse(plaintext);
    return true;
  } catch {
    return false;
  }
}

function emptyTableReport(spec: RotationTableSpec, present: boolean): DataEncryptionRotationTableReport {
  return {
    table: spec.table,
    present,
    rows: 0,
    nonempty: 0,
    needsRotation: 0,
    alreadyNew: 0,
    undecryptable: 0,
  };
}

function addCounts(
  target: DataEncryptionRotationCounts,
  source: DataEncryptionRotationTableReport,
): void {
  target.nonempty += source.nonempty;
  target.needsRotation += source.needsRotation;
  target.alreadyNew += source.alreadyNew;
  target.undecryptable += source.undecryptable;
}

function scanDatabase(
  db: Database.Database,
  keys: DataEncryptionRotationKeys,
  collectPlaintext: boolean,
): ScanResult {
  const tables: DataEncryptionRotationTableReport[] = [];
  const candidates: RotationCandidate[] = [];
  const totals: DataEncryptionRotationCounts = {
    nonempty: 0,
    needsRotation: 0,
    alreadyNew: 0,
    undecryptable: 0,
  };

  for (const spec of TABLE_SPECS) {
    if (!tableExists(db, spec.table)) {
      tables.push(emptyTableReport(spec, false));
      continue;
    }

    assertExpectedColumns(db, spec);
    const report = emptyTableReport(spec, true);
    const selectedColumns = Array.from(new Set([
      spec.primaryKey,
      spec.userIdColumn,
      ...spec.encryptedColumns,
    ])).join(', ');
    const rows = db.prepare(`
      SELECT ${selectedColumns}
      FROM ${spec.table}
      ORDER BY ${spec.primaryKey}
    `).all() as Array<Record<string, unknown>>;
    report.rows = rows.length;

    for (const row of rows) {
      const primaryKey = row[spec.primaryKey];
      const userId = row[spec.userIdColumn];
      if (!isValidRowId(primaryKey) || !isValidRowId(userId)) {
        throw new Error(`${spec.table} contains an invalid rotation identity`);
      }
      if (spec.requirePositiveUserId && userId <= 0) {
        throw new Error(`${spec.table} contains a non-positive rotation owner`);
      }

      for (const column of spec.encryptedColumns) {
        const value = row[column];
        if (value == null || value === '') continue;
        report.nonempty += 1;
        if (typeof value !== 'string') {
          report.undecryptable += 1;
          continue;
        }

        const envelopePrefix = spec.envelopePrefix;
        if (envelopePrefix && !value.startsWith(envelopePrefix)) {
          if (!isValidLegacyPlaintext(spec, column, value)) {
            report.undecryptable += 1;
            continue;
          }
          report.needsRotation += 1;
          if (collectPlaintext) {
            candidates.push({
              table: spec.table,
              primaryKey,
              primaryKeyColumn: spec.primaryKey,
              userId,
              column,
              originalCiphertext: value,
              plaintext: value,
              destinationKey: keys.next[spec.domain],
              envelopePrefix,
            });
          }
          continue;
        }

        const ciphertext = envelopePrefix ? value.slice(envelopePrefix.length) : value;
        const destinationPlaintext = canDecrypt(ciphertext, keys.next[spec.domain], userId);
        if (destinationPlaintext !== undefined) {
          if (isValidLegacyPlaintext(spec, column, destinationPlaintext)) {
            report.alreadyNew += 1;
          } else {
            report.undecryptable += 1;
          }
          continue;
        }

        const oldPlaintext = canDecrypt(ciphertext, keys.old[spec.domain], userId);
        if (oldPlaintext === undefined || !isValidLegacyPlaintext(spec, column, oldPlaintext)) {
          report.undecryptable += 1;
          continue;
        }

        report.needsRotation += 1;
        if (collectPlaintext) {
          candidates.push({
            table: spec.table,
            primaryKey,
            primaryKeyColumn: spec.primaryKey,
            userId,
            column,
            originalCiphertext: value,
            plaintext: oldPlaintext,
            destinationKey: keys.next[spec.domain],
            envelopePrefix,
          });
        }
      }
    }

    addCounts(totals, report);
    tables.push(report);
  }

  return { tables, totals, candidates };
}

function assertNoUndecryptableValues(scan: ScanResult): void {
  if (scan.totals.undecryptable > 0) {
    throw new Error(
      `rotation aborted: ${scan.totals.undecryptable} undecryptable nonempty value(s)`,
    );
  }
}

function validateKey(label: string, key: string): void {
  if (typeof key !== 'string' || Buffer.byteLength(key, 'utf8') < 32) {
    throw new Error(`${label} must be an explicit key of at least 32 bytes`);
  }
}

function validateKeys(keys: DataEncryptionRotationKeys): void {
  const domains: readonly RotationDomain[] = ['oauth', 'garmin', 'health', 'finance'];
  for (const group of ['old', 'next', 'peer'] as const) {
    for (const domain of domains) {
      validateKey(`${group}.${domain}`, keys[group][domain]);
    }
  }

  for (const domain of domains) {
    if (keys.old[domain] === keys.next[domain]) {
      throw new Error(`${domain} destination key must differ from its old key`);
    }
  }

  if (new Set(Object.values(keys.next)).size !== domains.length) {
    throw new Error('destination keys must be distinct across encryption domains');
  }
  const oldKeys = new Set(Object.values(keys.old));
  for (const key of Object.values(keys.next)) {
    if (oldKeys.has(key)) {
      throw new Error('destination keys must not reuse any old encryption key');
    }
    if (Object.values(keys.peer).includes(key)) {
      throw new Error('destination keys must differ from every peer environment key');
    }
  }
}

function validateDatabasePath(databasePath: string): string {
  if (!path.isAbsolute(databasePath)) {
    throw new Error('database path must be absolute');
  }
  const resolved = realpathSync(databasePath);
  const stat = statSync(resolved);
  if (!stat.isFile()) throw new Error('database path must refer to a regular file');
  return resolved;
}

function assertProtectedBackup(sourcePath: string, backupPath: string | undefined): string {
  if (!backupPath) {
    throw new Error('apply requires a protected backup path');
  }
  if (!path.isAbsolute(backupPath)) {
    throw new Error('protected backup path must be absolute');
  }

  const sourceRealPath = realpathSync(sourcePath);
  const backupRealPath = realpathSync(backupPath);
  const sourceStat = statSync(sourceRealPath);
  const backupStat = statSync(backupRealPath);
  if (!backupStat.isFile()) throw new Error('protected backup must be a regular file');
  if (sourceRealPath === backupRealPath || (
    sourceStat.dev === backupStat.dev && sourceStat.ino === backupStat.ino
  )) {
    throw new Error('protected backup must be a separate file');
  }
  if ((backupStat.mode & 0o077) !== 0) {
    throw new Error('backup permissions must deny all group and other access');
  }
  if (typeof process.getuid === 'function' && backupStat.uid !== process.getuid()) {
    throw new Error('protected backup must be owned by the current operator');
  }
  try {
    // accessSync is deliberately invoked through fs constants to make the
    // required read permission explicit without opening or printing data.
    accessSync(backupRealPath, fsConstants.R_OK);
  } catch {
    throw new Error('protected backup is not readable by the current operator');
  }
  return backupRealPath;
}

function assertDatabaseIntegrity(db: Database.Database, label: string): void {
  const rows = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
  if (rows.length !== 1 || rows[0]?.integrity_check !== 'ok') {
    throw new Error(`${label} failed SQLite integrity_check`);
  }
}

function updateHashPart(hash: crypto.Hash, value: unknown): void {
  const text = value == null ? '<NULL>' : String(value);
  const bytes = Buffer.from(text, 'utf8');
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  hash.update(length);
  hash.update(bytes);
}

function rotationSurfaceDigest(db: Database.Database): string {
  const hash = crypto.createHash('sha256');
  for (const spec of TABLE_SPECS) {
    updateHashPart(hash, spec.table);
    if (!tableExists(db, spec.table)) {
      updateHashPart(hash, '<MISSING_TABLE>');
      continue;
    }
    assertExpectedColumns(db, spec);
    const selectedColumns = Array.from(new Set([
      spec.primaryKey,
      spec.userIdColumn,
      ...spec.encryptedColumns,
    ]));
    const rows = db.prepare(`
      SELECT ${selectedColumns.join(', ')}
      FROM ${spec.table}
      ORDER BY ${spec.primaryKey}
    `).all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      for (const column of selectedColumns) {
        updateHashPart(hash, column);
        updateHashPart(hash, row[column]);
      }
    }
  }
  return hash.digest('hex');
}

function inspectBackup(backupPath: string): string {
  const backup = new Database(backupPath, { readonly: true, fileMustExist: true });
  try {
    assertDatabaseIntegrity(backup, 'protected backup');
    return rotationSurfaceDigest(backup);
  } finally {
    backup.close();
  }
}

function applyCandidates(db: Database.Database, candidates: RotationCandidate[]): number {
  let applied = 0;
  for (const candidate of candidates) {
    const encrypted = encryptValue(
      candidate.plaintext,
      candidate.destinationKey,
      candidate.userId,
    );
    const replacement = `${candidate.envelopePrefix ?? ''}${encrypted}`;
    const result = db.prepare(`
      UPDATE ${candidate.table}
      SET ${candidate.column} = ?
      WHERE ${candidate.primaryKeyColumn} = ? AND ${candidate.column} = ?
    `).run(replacement, candidate.primaryKey, candidate.originalCiphertext);
    if (result.changes !== 1) {
      throw new Error('compare-and-swap update did not affect exactly one value');
    }
    applied += 1;
  }
  return applied;
}

function verifiedCounts(scan: ScanResult): DataEncryptionRotationCounts & { verified: boolean } {
  return {
    ...scan.totals,
    verified: scan.totals.needsRotation === 0 && scan.totals.undecryptable === 0,
  };
}

export function runDataEncryptionKeyRotation(
  options: DataEncryptionRotationOptions,
): DataEncryptionRotationResult {
  if (options.environment !== 'production' && options.environment !== 'staging') {
    throw new Error('environment must be production or staging');
  }
  validateKeys(options.keys);
  const databasePath = validateDatabasePath(options.databasePath);

  if (!options.apply) {
    const db = new Database(databasePath, { readonly: true, fileMustExist: true });
    try {
      const scan = scanDatabase(db, options.keys, false);
      assertNoUndecryptableValues(scan);
      return {
        mode: 'dry-run',
        environment: options.environment,
        tables: scan.tables,
        totals: scan.totals,
        appliedValues: 0,
        backupVerified: false,
        postVerification: verifiedCounts(scan),
      };
    } finally {
      db.close();
    }
  }

  if (options.servicesStoppedAcknowledgement !== SERVICE_STOPPED_ACKNOWLEDGEMENT) {
    throw new Error(
      `apply requires the exact service-stopped acknowledgement ${SERVICE_STOPPED_ACKNOWLEDGEMENT}`,
    );
  }
  const backupPath = assertProtectedBackup(databasePath, options.backupPath);
  const backupDigest = inspectBackup(backupPath);

  const db = new Database(databasePath, { fileMustExist: true });
  db.pragma('busy_timeout = 5000');
  let appliedValues = 0;
  let preflight: ScanResult | undefined;
  try {
    // Give the operator an actionable, non-sensitive error for an already
    // stale backup. The same comparison is repeated under BEGIN IMMEDIATE to
    // close the race between this diagnostic check and mutation.
    assertDatabaseIntegrity(db, 'source database');
    if (rotationSurfaceDigest(db) !== backupDigest) {
      throw new Error('protected backup does not match the source rotation surface');
    }
    const diagnosticPreflight = scanDatabase(db, options.keys, false);
    assertNoUndecryptableValues(diagnosticPreflight);

    const transaction = db.transaction(() => {
      assertDatabaseIntegrity(db, 'source database');
      if (rotationSurfaceDigest(db) !== backupDigest) {
        throw new Error('protected backup does not match the source rotation surface');
      }

      preflight = scanDatabase(db, options.keys, true);
      assertNoUndecryptableValues(preflight);
      appliedValues = applyCandidates(db, preflight.candidates);

      const inTransactionVerification = scanDatabase(db, options.keys, false);
      if (!verifiedCounts(inTransactionVerification).verified) {
        throw new Error('in-transaction post-rotation verification failed');
      }
    });

    try {
      transaction.immediate();
    } catch {
      throw new Error('rotation transaction failed; no changes were committed');
    }
  } finally {
    db.close();
  }

  if (!preflight) {
    throw new Error('rotation transaction failed; no preflight report was produced');
  }

  const verifyDb = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const post = scanDatabase(verifyDb, options.keys, false);
    assertNoUndecryptableValues(post);
    const postVerification = verifiedCounts(post);
    if (!postVerification.verified) {
      throw new Error('post-rotation verification failed');
    }
    return {
      mode: 'apply',
      environment: options.environment,
      tables: preflight.tables,
      totals: preflight.totals,
      appliedValues,
      backupVerified: true,
      postVerification,
    };
  } finally {
    verifyDb.close();
  }
}

function argumentValue(argv: readonly string[], name: string): string | undefined {
  const prefix = `${name}=`;
  const matches = argv.filter((argument) => argument.startsWith(prefix));
  if (matches.length > 1) throw new Error(`${name} may be supplied only once`);
  return matches[0]?.slice(prefix.length);
}

function requiredEnvironmentKey(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function keysFromEnvironment(): DataEncryptionRotationKeys {
  return {
    old: {
      oauth: requiredEnvironmentKey('OLD_OAUTH_ENCRYPTION_KEY'),
      garmin: requiredEnvironmentKey('OLD_GARMIN_ENCRYPTION_KEY'),
      health: requiredEnvironmentKey('OLD_HEALTH_DATA_ENCRYPTION_KEY'),
      finance: requiredEnvironmentKey('OLD_FINANCE_ENCRYPTION_KEY'),
    },
    next: {
      oauth: requiredEnvironmentKey('NEW_OAUTH_ENCRYPTION_KEY'),
      garmin: requiredEnvironmentKey('NEW_GARMIN_ENCRYPTION_KEY'),
      health: requiredEnvironmentKey('NEW_HEALTH_DATA_ENCRYPTION_KEY'),
      finance: requiredEnvironmentKey('NEW_FINANCE_ENCRYPTION_KEY'),
    },
    peer: {
      oauth: requiredEnvironmentKey('PEER_OAUTH_ENCRYPTION_KEY'),
      garmin: requiredEnvironmentKey('PEER_GARMIN_ENCRYPTION_KEY'),
      health: requiredEnvironmentKey('PEER_HEALTH_DATA_ENCRYPTION_KEY'),
      finance: requiredEnvironmentKey('PEER_FINANCE_ENCRYPTION_KEY'),
    },
  };
}

const USAGE = `Nexus data-encryption key rotation

Usage:
  npm run security:rotate-data-encryption -- \\
    --environment=staging|production \\
    --database=/absolute/path/to/database.db \\
    [--apply \\
     --backup=/absolute/path/to/protected-backup.db \\
     --services-stopped-ack=${SERVICE_STOPPED_ACKNOWLEDGEMENT}]

Dry-run is the default. Keys are required through OLD_*, NEW_*, and PEER_*
environment variables; key material is never accepted as a CLI argument or
included in output. Apply requires stopped/drained writers and a separate
owner-readable backup with no group or other permissions.`;

function main(argv: readonly string[] = process.argv.slice(2)): void {
  if (argv.includes('--help') || argv.includes('-h')) {
    if (argv.length !== 1) throw new Error('--help cannot be combined with other arguments');
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  const allowed = /^(--apply|--environment=.+|--database=.+|--backup=.+|--services-stopped-ack=.+)$/;
  for (const argument of argv) {
    // Do not echo rejected input. An operator following an obsolete command
    // might accidentally place key material in an unsupported CLI argument.
    if (!allowed.test(argument)) throw new Error('unknown or malformed argument');
  }

  const environment = argumentValue(argv, '--environment');
  if (environment !== 'production' && environment !== 'staging') {
    throw new Error('--environment must be production or staging');
  }
  const databasePath = argumentValue(argv, '--database');
  if (!databasePath) throw new Error('--database is required');
  const applyCount = argv.filter((argument) => argument === '--apply').length;
  if (applyCount > 1) throw new Error('--apply may be supplied only once');
  const apply = applyCount === 1;
  if (!apply && (
    argumentValue(argv, '--backup') != null
    || argumentValue(argv, '--services-stopped-ack') != null
  )) {
    throw new Error('--backup and --services-stopped-ack are apply-only arguments');
  }

  const result = runDataEncryptionKeyRotation({
    databasePath,
    environment,
    keys: keysFromEnvironment(),
    apply,
    backupPath: argumentValue(argv, '--backup'),
    servicesStoppedAcknowledgement: argumentValue(argv, '--services-stopped-ack'),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown rotation failure';
    process.stderr.write(`Data-encryption key rotation failed: ${message}\n`);
    process.exitCode = 1;
  }
}
