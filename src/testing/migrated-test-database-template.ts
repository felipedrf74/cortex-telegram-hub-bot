// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { applyPendingMigrations } from '../services/migration-runner';

export const MIGRATED_TEST_DATABASE_TEMPLATE_SCHEMA =
  'nexus.migrated-test-database-template.v1';
export const MIGRATED_TEST_DATABASE_TEMPLATE_ALGORITHM =
  'sha256-ordered-migration-records-v1';

const MAX_RECEIPT_BYTES = 256 * 1024;
const MAX_DATABASE_BYTES = 128 * 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export type MigrationTemplateFileIdentity = {
  filename: string;
  sha256: string;
  sizeBytes: number;
};

export type MigrationTemplateIdentity = {
  algorithm: typeof MIGRATED_TEST_DATABASE_TEMPLATE_ALGORITHM;
  count: number;
  files: MigrationTemplateFileIdentity[];
  sha256: string;
};

export type MigratedTestDatabaseTemplateReceipt = {
  schema: typeof MIGRATED_TEST_DATABASE_TEMPLATE_SCHEMA;
  migrationIdentity: MigrationTemplateIdentity;
  database: {
    format: 'sqlite3';
    sha256: string;
    sizeBytes: number;
  };
};

export type BuiltMigratedTestDatabaseTemplate = {
  databasePath: string;
  databaseSha256: string;
  migrationCount: number;
  migrationSha256: string;
  receiptPath: string;
};

export type MigratedTestDatabaseTemplateReference = {
  databasePath: string;
  expectedDatabaseSha256: string;
  expectedMigrationSha256: string;
  receiptPath: string;
};

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function migrationIdentitySha256(files: readonly MigrationTemplateFileIdentity[]): string {
  const digest = createHash('sha256');
  digest.update(`${MIGRATED_TEST_DATABASE_TEMPLATE_ALGORITHM}\0`);
  for (const file of files) {
    digest.update(`${Buffer.byteLength(file.filename, 'utf8')}:`);
    digest.update(file.filename, 'utf8');
    digest.update(`:${file.sizeBytes}:${file.sha256}\n`);
  }
  return digest.digest('hex');
}

function assertSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
}

function assertCurrentUserOwner(stat: fs.Stats, label: string): void {
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`${label} must be owned by the current user`);
  }
}

function assertPrivateDirectory(directory: string): void {
  const resolved = path.resolve(directory);
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Migrated test database template directory must be a real directory: ${resolved}`);
  }
  assertCurrentUserOwner(stat, 'Migrated test database template directory');
  if ((stat.mode & 0o777) !== 0o700) {
    throw new Error('Migrated test database template directory permissions must be 0700');
  }
}

function assertPrivateRegularFile(stat: fs.Stats, label: string): void {
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${label} must be a regular file, not a symlink or special file`);
  }
  assertCurrentUserOwner(stat, label);
  if (stat.nlink !== 1) {
    throw new Error(`${label} must have exactly one hard link`);
  }
  if ((stat.mode & 0o777) !== 0o600) {
    throw new Error(`${label} permissions must be 0600`);
  }
}

function readPrivateFile(
  filePath: string,
  label: string,
  maximumBytes: number,
): Buffer {
  const resolved = path.resolve(filePath);
  const before = fs.lstatSync(resolved);
  assertPrivateRegularFile(before, label);
  if (before.size <= 0 || before.size > maximumBytes) {
    throw new Error(`${label} has an invalid size`);
  }

  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  const descriptor = fs.openSync(resolved, fs.constants.O_RDONLY | noFollow);
  try {
    const opened = fs.fstatSync(descriptor);
    assertPrivateRegularFile(opened, label);
    if (
      opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.size !== before.size
    ) {
      throw new Error(`${label} changed while it was being opened`);
    }
    return fs.readFileSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function readMigrationFile(filePath: string): Buffer {
  const before = fs.lstatSync(filePath);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error(`Migration must be a regular file, not a symlink: ${filePath}`);
  }
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
  try {
    const opened = fs.fstatSync(descriptor);
    if (
      !opened.isFile()
      || opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.size !== before.size
    ) {
      throw new Error(`Migration changed while it was being opened: ${filePath}`);
    }
    return fs.readFileSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function migrationsDirectory(): string {
  return path.resolve(__dirname, '../../migrations');
}

export function calculateOrderedMigrationIdentity(
  directory = migrationsDirectory(),
): MigrationTemplateIdentity {
  const resolved = path.resolve(directory);
  const directoryStat = fs.lstatSync(resolved);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    throw new Error(`Migrations path must be a real directory: ${resolved}`);
  }

  const filenames = fs.readdirSync(resolved)
    .filter((filename) => filename.endsWith('.sql'))
    .sort();
  if (filenames.length === 0) {
    throw new Error(`No SQL migrations found in ${resolved}`);
  }

  const files = filenames.map((filename): MigrationTemplateFileIdentity => {
    if (
      path.basename(filename) !== filename
      || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.sql$/.test(filename)
    ) {
      throw new Error(`Unsafe migration filename: ${filename}`);
    }
    const bytes = readMigrationFile(path.join(resolved, filename));
    return {
      filename,
      sha256: sha256(bytes),
      sizeBytes: bytes.length,
    };
  });

  return {
    algorithm: MIGRATED_TEST_DATABASE_TEMPLATE_ALGORITHM,
    count: files.length,
    files,
    sha256: migrationIdentitySha256(files),
  };
}

function writePrivateFileAtomically(filePath: string, bytes: Buffer): void {
  const temporaryPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  const descriptor = fs.openSync(
    temporaryPath,
    fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
    0o600,
  );
  try {
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporaryPath, filePath);
  fs.chmodSync(filePath, 0o600);
}

function assertSameMigrationIdentity(
  before: MigrationTemplateIdentity,
  after: MigrationTemplateIdentity,
): void {
  if (before.sha256 !== after.sha256 || before.count !== after.count) {
    throw new Error('Ordered migration digest changed while building the migrated test database template');
  }
}

export function buildMigratedTestDatabaseTemplate(
  outputDirectory: string,
): BuiltMigratedTestDatabaseTemplate {
  const resolvedOutputDirectory = path.resolve(outputDirectory);
  assertPrivateDirectory(resolvedOutputDirectory);

  const migrationIdentity = calculateOrderedMigrationIdentity();
  const database = new Database(':memory:');
  let databaseBytes: Buffer;
  try {
    database.pragma('foreign_keys = ON');
    applyPendingMigrations(database);
    const integrity = database.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') {
      throw new Error(`Generated migrated test database failed integrity_check: ${String(integrity)}`);
    }
    const appliedMigrations = (
      database.prepare('SELECT filename FROM _migrations ORDER BY filename').all() as
        Array<{ filename: string }>
    ).map(({ filename }) => filename);
    const expectedMigrations = migrationIdentity.files.map(({ filename }) => filename);
    if (
      appliedMigrations.length !== expectedMigrations.length
      || appliedMigrations.some((filename, index) => filename !== expectedMigrations[index])
    ) {
      throw new Error('Generated migrated test database does not contain the exact ordered migration set');
    }
    databaseBytes = Buffer.from(database.serialize());
  } finally {
    database.close();
  }

  assertSameMigrationIdentity(migrationIdentity, calculateOrderedMigrationIdentity());
  if (databaseBytes.length <= 0 || databaseBytes.length > MAX_DATABASE_BYTES) {
    throw new Error('Generated migrated test database has an invalid size');
  }

  const databaseSha256 = sha256(databaseBytes);
  const receipt: MigratedTestDatabaseTemplateReceipt = {
    schema: MIGRATED_TEST_DATABASE_TEMPLATE_SCHEMA,
    migrationIdentity,
    database: {
      format: 'sqlite3',
      sha256: databaseSha256,
      sizeBytes: databaseBytes.length,
    },
  };
  const databasePath = path.join(resolvedOutputDirectory, 'template.sqlite');
  const receiptPath = path.join(resolvedOutputDirectory, 'template-receipt.json');
  writePrivateFileAtomically(databasePath, databaseBytes);
  writePrivateFileAtomically(
    receiptPath,
    Buffer.from(`${JSON.stringify(receipt)}\n`, 'utf8'),
  );

  return {
    databasePath,
    databaseSha256,
    migrationCount: migrationIdentity.count,
    migrationSha256: migrationIdentity.sha256,
    receiptPath,
  };
}

function parseReceipt(bytes: Buffer): MigratedTestDatabaseTemplateReceipt {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('Migrated test database template receipt is malformed JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Migrated test database template receipt must be an object');
  }
  const receipt = value as Partial<MigratedTestDatabaseTemplateReceipt>;
  if (receipt.schema !== MIGRATED_TEST_DATABASE_TEMPLATE_SCHEMA) {
    throw new Error('Migrated test database template receipt schema is unsupported');
  }
  if (!receipt.migrationIdentity || typeof receipt.migrationIdentity !== 'object') {
    throw new Error('Migrated test database template receipt has no migration identity');
  }
  if (
    receipt.migrationIdentity.algorithm !== MIGRATED_TEST_DATABASE_TEMPLATE_ALGORITHM
    || !Number.isSafeInteger(receipt.migrationIdentity.count)
    || receipt.migrationIdentity.count < 1
    || !Array.isArray(receipt.migrationIdentity.files)
  ) {
    throw new Error('Migrated test database template migration identity is malformed');
  }
  assertSha256(
    receipt.migrationIdentity.sha256,
    'Migrated test database template migration digest',
  );

  let previousFilename: string | null = null;
  const seen = new Set<string>();
  for (const file of receipt.migrationIdentity.files) {
    if (
      !file
      || typeof file !== 'object'
      || typeof file.filename !== 'string'
      || path.basename(file.filename) !== file.filename
      || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.sql$/.test(file.filename)
      || !Number.isSafeInteger(file.sizeBytes)
      || file.sizeBytes < 0
    ) {
      throw new Error('Migrated test database template migration file identity is malformed');
    }
    assertSha256(file.sha256, 'Migrated test database template migration file digest');
    if (
      seen.has(file.filename)
      || (previousFilename !== null && previousFilename >= file.filename)
    ) {
      throw new Error('Migrated test database template migration files are not uniquely ordered');
    }
    seen.add(file.filename);
    previousFilename = file.filename;
  }
  if (receipt.migrationIdentity.files.length !== receipt.migrationIdentity.count) {
    throw new Error('Migrated test database template migration count does not match its file list');
  }
  if (
    migrationIdentitySha256(receipt.migrationIdentity.files)
    !== receipt.migrationIdentity.sha256
  ) {
    throw new Error('Migrated test database template ordered migration digest is invalid');
  }

  if (
    !receipt.database
    || typeof receipt.database !== 'object'
    || receipt.database.format !== 'sqlite3'
    || !Number.isSafeInteger(receipt.database.sizeBytes)
    || receipt.database.sizeBytes <= 0
    || receipt.database.sizeBytes > MAX_DATABASE_BYTES
  ) {
    throw new Error('Migrated test database template database identity is malformed');
  }
  assertSha256(receipt.database.sha256, 'Migrated test database template database digest');
  return receipt as MigratedTestDatabaseTemplateReceipt;
}

export function readMigratedTestDatabaseTemplate(
  reference: MigratedTestDatabaseTemplateReference,
): Buffer {
  assertSha256(
    reference.expectedDatabaseSha256,
    'Expected migrated test database template digest',
  );
  assertSha256(
    reference.expectedMigrationSha256,
    'Expected ordered migration digest',
  );

  const databasePath = path.resolve(reference.databasePath);
  const receiptPath = path.resolve(reference.receiptPath);
  const databaseDirectory = path.dirname(databasePath);
  if (databaseDirectory !== path.dirname(receiptPath)) {
    throw new Error('Migrated test database template and receipt must share one private directory');
  }
  assertPrivateDirectory(databaseDirectory);

  const receipt = parseReceipt(readPrivateFile(
    receiptPath,
    'Migrated test database template receipt',
    MAX_RECEIPT_BYTES,
  ));
  const currentMigrationIdentity = calculateOrderedMigrationIdentity();
  if (
    receipt.migrationIdentity.sha256 !== currentMigrationIdentity.sha256
    || receipt.migrationIdentity.count !== currentMigrationIdentity.count
  ) {
    throw new Error('Migrated test database template does not match the current migration tree');
  }
  if (receipt.migrationIdentity.sha256 !== reference.expectedMigrationSha256) {
    throw new Error('Migrated test database template has a stale ordered migration digest');
  }
  if (receipt.database.sha256 !== reference.expectedDatabaseSha256) {
    throw new Error('Migrated test database template receipt database digest is not the expected digest');
  }

  const databaseBytes = readPrivateFile(
    databasePath,
    'Migrated test database template',
    MAX_DATABASE_BYTES,
  );
  if (
    databaseBytes.length !== receipt.database.sizeBytes
    || sha256(databaseBytes) !== receipt.database.sha256
  ) {
    throw new Error('Migrated test database template bytes do not match the signed-in-process receipt');
  }

  let database: Database.Database | undefined;
  try {
    database = new Database(Buffer.from(databaseBytes));
    const integrity = database.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') {
      throw new Error(`integrity_check returned ${String(integrity)}`);
    }
    const appliedMigrations = (
      database.prepare('SELECT filename FROM _migrations ORDER BY filename').all() as
        Array<{ filename: string }>
    ).map(({ filename }) => filename);
    const expectedMigrations = receipt.migrationIdentity.files.map(({ filename }) => filename);
    if (
      appliedMigrations.length !== expectedMigrations.length
      || appliedMigrations.some((filename, index) => filename !== expectedMigrations[index])
    ) {
      throw new Error('database migration set differs from the receipt');
    }
  } catch (error) {
    throw new Error(
      `Migrated test database template is malformed or tampered: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  } finally {
    database?.close();
  }

  return databaseBytes;
}
