// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Invoice Queue Service
 *
 * When durable object storage is temporarily unavailable, invoices are saved
 * to local disk and queued in SQLite for later retry.
 *
 * A cron job runs every 15 minutes to flush the queue once storage accepts
 * the checksum-verified write. Users are notified via telemetry on queue and flush.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getDb } from './database';
import type { InvoiceAnalysis } from './invoice-filer';
import { recordFiling } from '../state/invoice-filings';
import { pushEvent } from '../portal/telemetry';
import { logger } from '../utils/logger';
import { config } from '../config';
import {
  beginInvoiceArtifactWrite,
  assertInvoiceAccountAvailable,
  assertInvoiceArtifactWriteCanProceed,
  claimInvoiceArtifactDeletion,
  completeInvoiceArtifactDeletion,
  completeInvoiceArtifactWrite,
  InvoiceArtifactDeletionIdentity,
  InvoiceArtifactDeletionUnprovenError,
  InvoiceArtifactManifestOwnership,
} from './invoice-artifact-admission';

// ─── Queue Directory ──────────────────────────────────────────────────

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const INVOICE_QUEUE_FLUSH_CLAIM_LEASE_MS = 30 * 60 * 1_000;
const INVOICE_QUEUE_FLUSH_CLAIM_HEARTBEAT_MS = Math.floor(
  INVOICE_QUEUE_FLUSH_CLAIM_LEASE_MS / 3,
);
const TERMINAL_SPOOL_CLEANUP_LIMIT = 200;
const INODE_DELETION_UNPROVEN = 'invoice_queue_inode_deletion_unproven';

function queueDirectory(): string {
  return path.join(path.dirname(config.app.databasePath), 'invoice-queue');
}

function assertOwnedByCurrentUser(stat: fs.Stats, label: string): void {
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (currentUid !== null && stat.uid !== currentUid) {
    throw new Error(`${label} is not owned by the current process user`);
  }
}

interface BoundQueueDirectory {
  descriptor: number;
  identity: fs.Stats;
  namespacePath: string;
  ownershipRequired: boolean;
  privateDirectory: boolean;
}

interface PrivateQueueLocation {
  bindings: BoundQueueDirectory[];
  queue: BoundQueueDirectory;
  targetName: string;
  targetPath: string;
}

function sameFileIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function queueDirectoryOpenFlags(): number {
  const noFollow = fs.constants.O_NOFOLLOW;
  const directory = fs.constants.O_DIRECTORY;
  if (typeof noFollow !== 'number' || typeof directory !== 'number') {
    throw new Error('Invoice queue requires no-follow directory descriptors');
  }
  return fs.constants.O_RDONLY | noFollow | directory;
}

function assertQueueDirectoryMetadata(
  stat: fs.Stats,
  label: string,
  ownershipRequired: boolean,
  privateDirectory: boolean,
): void {
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} is not a directory`);
  }
  if (ownershipRequired) assertOwnedByCurrentUser(stat, label);
  if (privateDirectory && (stat.mode & 0o077) !== 0) {
    throw new Error(`${label} permissions are not private`);
  }
}

function assertBoundQueueDirectory(binding: BoundQueueDirectory): void {
  const opened = fs.fstatSync(binding.descriptor);
  const named = fs.lstatSync(binding.namespacePath);
  assertQueueDirectoryMetadata(
    opened,
    'Invoice queue directory descriptor',
    binding.ownershipRequired,
    binding.privateDirectory,
  );
  assertQueueDirectoryMetadata(
    named,
    'Invoice queue directory',
    binding.ownershipRequired,
    binding.privateDirectory,
  );
  if (!sameFileIdentity(opened, binding.identity) || !sameFileIdentity(named, binding.identity)) {
    throw new Error('Invoice queue directory authority changed');
  }
}

function openBoundQueueDirectory(
  namespacePath: string,
  operationPath: string,
  privateDirectory: boolean,
  expectedIdentity?: fs.Stats,
  ownershipRequired = privateDirectory,
): BoundQueueDirectory {
  const descriptor = fs.openSync(operationPath, queueDirectoryOpenFlags());
  try {
    const opened = fs.fstatSync(descriptor);
    assertQueueDirectoryMetadata(opened, 'Invoice queue directory descriptor', false, false);
    if (privateDirectory) fs.fchmodSync(descriptor, PRIVATE_DIRECTORY_MODE);
    const secured = fs.fstatSync(descriptor);
    const named = fs.lstatSync(namespacePath);
    assertQueueDirectoryMetadata(
      secured,
      'Invoice queue directory descriptor',
      ownershipRequired,
      privateDirectory,
    );
    assertQueueDirectoryMetadata(
      named,
      'Invoice queue directory',
      ownershipRequired,
      privateDirectory,
    );
    if (!sameFileIdentity(secured, named)
        || (expectedIdentity && !sameFileIdentity(secured, expectedIdentity))) {
      throw new Error('Invoice queue directory path and descriptor disagree');
    }
    return {
      descriptor,
      identity: secured,
      namespacePath,
      ownershipRequired,
      privateDirectory,
    };
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

function queueDescriptorDirectoryPath(directory: BoundQueueDirectory): string {
  assertBoundQueueDirectory(directory);
  const descriptorPath = `/proc/self/fd/${directory.descriptor}`;
  let descriptorStat: fs.Stats;
  try {
    descriptorStat = fs.statSync(descriptorPath);
  } catch {
    throw new Error('Invoice queue requires procfs descriptor-relative operations');
  }
  if (!sameFileIdentity(descriptorStat, directory.identity)) {
    throw new Error('Invoice queue directory descriptor path disagrees');
  }
  return descriptorPath;
}

function queueDescriptorRelativePath(directory: BoundQueueDirectory, childName: string): string {
  if (childName === '.' || childName === '..' || childName.includes('/') || childName.includes('\\')) {
    throw new Error('Unsafe invoice queue path component');
  }
  return path.join(queueDescriptorDirectoryPath(directory), childName);
}

function closeQueueDirectoryBindings(bindings: BoundQueueDirectory[]): void {
  for (const binding of [...bindings].reverse()) fs.closeSync(binding.descriptor);
}

function openQueueChildDirectory(
  parent: BoundQueueDirectory,
  childName: string,
  create: boolean,
  privateDirectory: boolean,
  ownershipRequired = privateDirectory,
): BoundQueueDirectory | null {
  if (create && !privateDirectory) {
    throw new Error('Invoice queue cannot create a non-private directory');
  }
  const namespacePath = path.join(parent.namespacePath, childName);
  const operationPath = queueDescriptorRelativePath(parent, childName);
  if (create) {
    try {
      fs.mkdirSync(operationPath, { recursive: false, mode: PRIVATE_DIRECTORY_MODE });
      fs.fsyncSync(parent.descriptor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  let observed: fs.Stats;
  try {
    observed = fs.lstatSync(operationPath);
  } catch (error) {
    if (!create && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      assertBoundQueueDirectory(parent);
      return null;
    }
    throw error;
  }
  let child: BoundQueueDirectory | null = null;
  try {
    child = openBoundQueueDirectory(
      namespacePath,
      operationPath,
      privateDirectory,
      observed,
      ownershipRequired,
    );
    assertBoundQueueDirectory(parent);
    return child;
  } catch (error) {
    if (child) fs.closeSync(child.descriptor);
    throw error;
  }
}

function openQueueDirectory(create: boolean): {
  bindings: BoundQueueDirectory[];
  queue: BoundQueueDirectory;
} | null {
  if (process.platform !== 'linux') {
    throw new Error('Invoice queue requires Linux descriptor-relative operations');
  }
  const queuePath = path.resolve(queueDirectory());
  const parentPath = path.dirname(queuePath);
  const filesystemAnchor = path.parse(parentPath).root;
  if (parentPath === filesystemAnchor) {
    throw new Error('Invoice queue parent cannot be the filesystem root');
  }
  const parentParts = path.relative(filesystemAnchor, parentPath).split(path.sep).filter(Boolean);

  const bindings: BoundQueueDirectory[] = [];
  try {
    let current = openBoundQueueDirectory(filesystemAnchor, filesystemAnchor, false);
    bindings.push(current);
    for (const [index, part] of parentParts.entries()) {
      const isParent = index === parentParts.length - 1;
      const child = openQueueChildDirectory(current, part, false, false, isParent);
      if (!child) {
        if (!create) {
          closeQueueDirectoryBindings(bindings);
          return null;
        }
        throw new Error('Invoice queue parent directory is unavailable');
      }
      bindings.push(child);
      current = child;
    }
    const queue = openQueueChildDirectory(current, path.basename(queuePath), create, true);
    if (!queue) {
      closeQueueDirectoryBindings(bindings);
      return null;
    }
    bindings.push(queue);
    return { bindings, queue };
  } catch (error) {
    closeQueueDirectoryBindings(bindings);
    throw error;
  }
}

function ensureQueueDir(): void {
  const opened = openQueueDirectory(true);
  if (!opened) throw new Error('Invoice queue directory could not be created');
  closeQueueDirectoryBindings(opened.bindings);
}

function openPrivateQueueLocation(localPath: string, createDirectory: boolean): PrivateQueueLocation | null {
  const resolvedPath = path.resolve(localPath);
  const queuePath = path.resolve(queueDirectory());
  if (path.dirname(resolvedPath) !== queuePath) {
    throw new Error('Invoice queue file escaped the canonical queue directory');
  }
  const opened = openQueueDirectory(createDirectory);
  if (!opened) return null;
  return {
    bindings: opened.bindings,
    queue: opened.queue,
    targetName: path.basename(resolvedPath),
    targetPath: resolvedPath,
  };
}

function assertPrivateQueueFileMetadata(stat: fs.Stats, label: string): void {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error(`${label} is not a private regular file`);
  }
  assertOwnedByCurrentUser(stat, label);
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`${label} permissions are not private`);
  }
}

function openPrivateQueueFileForRead(
  location: PrivateQueueLocation,
): { descriptor: number; stat: fs.Stats } {
  const noFollow = fs.constants.O_NOFOLLOW;
  if (typeof noFollow !== 'number') {
    throw new Error('Invoice queue requires no-follow file reads');
  }
  const operationPath = queueDescriptorRelativePath(location.queue, location.targetName);
  const descriptor = fs.openSync(operationPath, fs.constants.O_RDONLY | noFollow);
  try {
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.nlink !== 1) {
      throw new Error('Invoice queue read descriptor is not a private regular file');
    }
    assertOwnedByCurrentUser(opened, 'Invoice queue read descriptor');
    // Repair files produced by the pre-hardening writer only after validating
    // the descriptor as an owned, canonical, single-link regular file.
    fs.fchmodSync(descriptor, PRIVATE_FILE_MODE);
    const secured = fs.fstatSync(descriptor);
    const named = fs.lstatSync(location.targetPath);
    assertPrivateQueueFileMetadata(secured, 'Invoice queue read descriptor');
    assertPrivateQueueFileMetadata(named, 'Invoice queue file');
    if (!sameFileIdentity(secured, named)) {
      throw new Error('Invoice queue path and read descriptor disagree');
    }
    assertBoundQueueDirectory(location.queue);
    return { descriptor, stat: secured };
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

function writePrivateQueueFile(
  localPath: string,
  buffer: Buffer,
  onCreated: (identity: InvoiceArtifactDeletionIdentity) => void,
): void {
  const location = openPrivateQueueLocation(localPath, true);
  if (!location) throw new Error('Invoice queue directory could not be created');
  const noFollow = fs.constants.O_NOFOLLOW;
  if (typeof noFollow !== 'number') {
    closeQueueDirectoryBindings(location.bindings);
    throw new Error('Invoice queue requires no-follow file creation support');
  }
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow;
  let descriptor: number | null = null;

  try {
    const operationPath = queueDescriptorRelativePath(location.queue, location.targetName);
    descriptor = fs.openSync(operationPath, flags, PRIVATE_FILE_MODE);
    const opened = fs.fstatSync(descriptor);
    onCreated({ device: String(opened.dev), inode: String(opened.ino) });
    if (!opened.isFile() || opened.nlink !== 1) {
      throw new Error('Invoice queue file descriptor is not an exclusive regular file');
    }
    assertOwnedByCurrentUser(opened, 'Invoice queue file descriptor');
    fs.fchmodSync(descriptor, PRIVATE_FILE_MODE);
    fs.writeFileSync(descriptor, buffer);
    fs.fsyncSync(descriptor);
    const secured = fs.fstatSync(descriptor);
    const named = fs.lstatSync(location.targetPath);
    assertPrivateQueueFileMetadata(secured, 'Invoice queue file descriptor');
    assertPrivateQueueFileMetadata(named, 'Invoice queue file');
    if (!sameFileIdentity(secured, named)) {
      throw new Error('Invoice queue path and descriptor disagree');
    }
    assertBoundQueueDirectory(location.queue);
    fs.fsyncSync(location.queue.descriptor);
    assertBoundQueueDirectory(location.queue);
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
    closeQueueDirectoryBindings(location.bindings);
  }
}

function privateQueueEntryExists(location: PrivateQueueLocation): boolean {
  const operationPath = queueDescriptorRelativePath(location.queue, location.targetName);
  try {
    fs.lstatSync(operationPath);
    assertBoundQueueDirectory(location.queue);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    assertBoundQueueDirectory(location.queue);
    return false;
  }
}

function queueFileExists(localPath: string): boolean {
  const location = openPrivateQueueLocation(localPath, false);
  if (!location) return false;
  try {
    return privateQueueEntryExists(location);
  } finally {
    closeQueueDirectoryBindings(location.bindings);
  }
}

function readPrivateQueueFile(localPath: string): Buffer {
  const location = openPrivateQueueLocation(localPath, false);
  if (!location) throw Object.assign(new Error('Invoice queue file is missing'), { code: 'ENOENT' });
  try {
    const opened = openPrivateQueueFileForRead(location);
    try {
      return fs.readFileSync(opened.descriptor);
    } finally {
      fs.closeSync(opened.descriptor);
    }
  } finally {
    closeQueueDirectoryBindings(location.bindings);
  }
}

function markQueueInodeDeletionUnproven(localPath: string): void {
  getDb().prepare(`UPDATE invoice_queue SET error_message = ?
    WHERE local_path = ? AND local_file_deleted_at IS NULL`)
    .run(INODE_DELETION_UNPROVEN, localPath);
}

function assertQueueInodeDeletionIsProvable(localPath: string): void {
  const poisoned = getDb().prepare(`SELECT 1 AS present FROM invoice_queue
    WHERE local_path = ? AND local_file_deleted_at IS NULL AND error_message = ? LIMIT 1`)
    .get(localPath, INODE_DELETION_UNPROVEN) as { present: number } | undefined;
  if (poisoned?.present === 1) throw new InvoiceArtifactDeletionUnprovenError();
}

function throwIfValidatedInodeEscaped(
  location: PrivateQueueLocation,
  opened: { descriptor: number; stat: fs.Stats },
): void {
  const live = fs.fstatSync(opened.descriptor);
  if (live.nlink === 0) return;
  const operationPath = queueDescriptorRelativePath(location.queue, location.targetName);
  let canonical: fs.Stats | null = null;
  try {
    canonical = fs.lstatSync(operationPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (!canonical || !sameFileIdentity(canonical, opened.stat)) {
    markQueueInodeDeletionUnproven(location.targetPath);
    throw new InvoiceArtifactDeletionUnprovenError();
  }
}

function unlinkPrivateQueueFile(
  location: PrivateQueueLocation,
  opened: { descriptor: number; stat: fs.Stats },
): void {
  try {
    const operationPath = queueDescriptorRelativePath(location.queue, location.targetName);
    const current = fs.lstatSync(operationPath);
    if (current.dev !== opened.stat.dev || current.ino !== opened.stat.ino || current.nlink !== 1) {
      markQueueInodeDeletionUnproven(location.targetPath);
      throw new InvoiceArtifactDeletionUnprovenError();
    }
    try {
      fs.unlinkSync(operationPath);
    } catch (error) {
      throwIfValidatedInodeEscaped(location, opened);
      throw error;
    }
    fs.fsyncSync(location.queue.descriptor);
    const unlinked = fs.fstatSync(opened.descriptor);
    if (unlinked.nlink !== 0) {
      markQueueInodeDeletionUnproven(location.targetPath);
      throw new InvoiceArtifactDeletionUnprovenError();
    }
    if (privateQueueEntryExists(location)) {
      markQueueInodeDeletionUnproven(location.targetPath);
      throw new InvoiceArtifactDeletionUnprovenError();
    }
  } catch (error) {
    throw error;
  }
}

export function deleteInvoiceQueueSpoolFileForAccountDeletion(
  localPath: string,
  options: {
    db?: ReturnType<typeof getDb>;
    ownership?: InvoiceArtifactManifestOwnership;
    expectedIdentity?: InvoiceArtifactDeletionIdentity;
    expectedWriteToken?: string;
  } = {},
): { deleted: boolean; alreadyMissing: boolean } {
  const queueDir = queueDirectory();
  const resolvedPath = path.resolve(localPath);
  if (path.dirname(resolvedPath) !== path.resolve(queueDir)) {
    throw new Error('Invoice queue deletion path escaped the canonical queue directory');
  }
  if (process.platform !== 'linux') {
    throw new Error('Invoice queue requires Linux descriptor-relative operations');
  }
  assertQueueInodeDeletionIsProvable(resolvedPath);
  const db = options.db ?? getDb();
  const liveManifest = db.prepare(`SELECT id FROM invoice_artifact_manifests
    WHERE artifact_kind = 'queue_spool' AND artifact_locator = ? AND deleted_at IS NULL`)
    .get(resolvedPath) as { id: number } | undefined;
  if (liveManifest && (!options.ownership || liveManifest.id !== options.ownership.manifestId)) {
    throw new Error('Invoice queue deletion requires its exact live manifest ownership.');
  }
  let location: PrivateQueueLocation | null = null;
  let opened: { descriptor: number; stat: fs.Stats } | null = null;
  try {
    try {
      location = openPrivateQueueLocation(resolvedPath, false);
      if (location && privateQueueEntryExists(location)) {
        opened = openPrivateQueueFileForRead(location);
      }
    } catch (error) {
      if (!options.ownership) throw error;
    }
    if (options.ownership) {
      let claim;
      try {
        claim = claimInvoiceArtifactDeletion({
          ownership: options.ownership,
          artifactKind: 'queue_spool',
          artifactLocator: resolvedPath,
          storageBackend: 'filesystem',
          observedIdentity: opened
            ? { device: String(opened.stat.dev), inode: String(opened.stat.ino) }
            : null,
          expectedIdentity: options.expectedIdentity,
          expectedWriteToken: options.expectedWriteToken,
        }, db);
      } catch (error) {
        if (error instanceof InvoiceArtifactDeletionUnprovenError) {
          markQueueInodeDeletionUnproven(resolvedPath);
        }
        throw error;
      }
      if (!location || !opened) {
        markQueueInodeDeletionUnproven(resolvedPath);
        throw new InvoiceArtifactDeletionUnprovenError();
      }
      unlinkPrivateQueueFile(location, opened);
      completeInvoiceArtifactDeletion(claim, db);
      return { deleted: true, alreadyMissing: false };
    }
    if (!location || !opened) return { deleted: false, alreadyMissing: true };
    throw new Error('Invoice queue deletion requires a durable ownership manifest.');
  } finally {
    if (opened) fs.closeSync(opened.descriptor);
    if (location) closeQueueDirectoryBindings(location.bindings);
  }
}

function safeErrorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function isConnectivityFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : '';
  return message.includes('Connection') || message.includes('timed out');
}

// ─── Prepared Statements ──────────────────────────────────────────────

import type BetterSqlite3 from 'better-sqlite3';

let _stmts: Record<string, BetterSqlite3.Statement> | null = null;
let _stmtsDb: BetterSqlite3.Database | null = null;

function getStmts(): Record<string, BetterSqlite3.Statement> {
  const db = getDb();
  if (_stmts && _stmtsDb === db) return _stmts;
  _stmtsDb = db;
  _stmts = {
    enqueue: db.prepare(`
      INSERT INTO invoice_queue (type, local_path, media_type, analysis_json, source, tenant_id, user_id, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`),
    pending: db.prepare(`
      SELECT * FROM invoice_queue WHERE status = 'pending' ORDER BY created_at ASC`),
    pendingCount: db.prepare(`
      SELECT COUNT(*) as c FROM invoice_queue WHERE status = 'pending'`),
    claimPending: db.prepare(`
      UPDATE invoice_queue
      SET flush_claim_token = ?, flush_claim_expires_at = ?
      WHERE status = 'pending'
        AND (flush_claim_token IS NULL OR flush_claim_expires_at IS NULL
          OR flush_claim_expires_at <= ?)`),
    claimed: db.prepare(`
      SELECT * FROM invoice_queue
      WHERE status = 'pending' AND flush_claim_token = ?
      ORDER BY created_at ASC, id ASC`),
    renewClaim: db.prepare(`
      UPDATE invoice_queue SET flush_claim_expires_at = ?
      WHERE id = ? AND status = 'pending' AND flush_claim_token = ?`),
    releaseClaims: db.prepare(`
      UPDATE invoice_queue SET flush_claim_token = NULL, flush_claim_expires_at = NULL
      WHERE status = 'pending' AND flush_claim_token = ?`),
    markFiled: db.prepare(`
      UPDATE invoice_queue
      SET status = 'filed', filed_at = datetime('now'), error_message = NULL,
          flush_claim_token = NULL, flush_claim_expires_at = NULL
      WHERE id = ? AND status = 'pending' AND flush_claim_token = ?`),
    markRetry: db.prepare(`
      UPDATE invoice_queue
      SET retries = retries + 1, last_retry_at = datetime('now'), error_message = ?,
          flush_claim_token = NULL, flush_claim_expires_at = NULL
      WHERE id = ? AND status = 'pending' AND flush_claim_token = ?`),
    markFailed: db.prepare(`
      UPDATE invoice_queue
      SET status = 'failed', error_message = ?,
          flush_claim_token = NULL, flush_claim_expires_at = NULL
      WHERE id = ? AND status = 'pending' AND flush_claim_token = ?`),
  };
  return _stmts;
}

// ─── Types ────────────────────────────────────────────────────────────

export interface QueuedInvoice {
  id: number;
  type: string;
  local_path: string;
  media_type: string | null;
  analysis_json: string;
  source: string;
  tenant_id: number;
  user_id: number;
  status: string;
  retries: number;
  last_retry_at: string | null;
  error_message: string | null;
  created_at: string;
  filed_at: string | null;
  flush_claim_token: string | null;
  flush_claim_expires_at: number | null;
}

interface TerminalQueueSpool {
  id: number;
  tenant_id: number;
  user_id: number;
  local_path: string;
}

interface StoredQueueSpoolManifest {
  id: number;
  tenant_id: number;
  user_id: number;
  storage_backend: string;
  state: string;
  deleted_at: string | null;
  deletion_device: string | null;
  deletion_inode: string | null;
  deletion_attempted_at: string | null;
}

function getQueueSpoolManifest(
  row: TerminalQueueSpool,
  db: ReturnType<typeof getDb>,
): StoredQueueSpoolManifest | undefined {
  if (!Number.isSafeInteger(row.tenant_id) || row.tenant_id <= 0
      || !Number.isSafeInteger(row.user_id) || row.user_id <= 0) {
    throw new Error('Invoice queue spool ownership identifiers are invalid.');
  }
  return db.prepare(`SELECT id, tenant_id, user_id, storage_backend, state, deleted_at,
      deletion_device, deletion_inode, deletion_attempted_at
    FROM invoice_artifact_manifests
    WHERE artifact_kind = 'queue_spool' AND artifact_locator = ?`)
    .get(row.local_path) as StoredQueueSpoolManifest | undefined;
}

function requireStoredQueueSpoolManifest(
  row: TerminalQueueSpool,
  db: ReturnType<typeof getDb>,
): StoredQueueSpoolManifest {
  const manifest = getQueueSpoolManifest(row, db);
  if (!manifest || manifest.tenant_id !== row.tenant_id || manifest.user_id !== row.user_id
      || manifest.storage_backend !== 'filesystem' || manifest.state !== 'stored'
      || manifest.deleted_at !== null) {
    throw new Error('Invoice queue requires an exact stored spool ownership manifest.');
  }
  return manifest;
}

function assertQueueSpoolReadyForFiling(row: TerminalQueueSpool): void {
  const db = getDb();
  db.transaction(() => {
    assertInvoiceAccountAvailable(row.user_id, db);
    requireStoredQueueSpoolManifest(row, db);
  }).immediate();
}

function claimPendingInvoices(): { claimToken: string; items: QueuedInvoice[] } {
  const db = getDb();
  const stmts = getStmts();
  return db.transaction(() => {
    const claimToken = crypto.randomUUID();
    const now = Date.now();
    stmts.claimPending.run(claimToken, now + INVOICE_QUEUE_FLUSH_CLAIM_LEASE_MS, now);
    return {
      claimToken,
      items: stmts.claimed.all(claimToken) as QueuedInvoice[],
    };
  }).immediate();
}

function renewInvoiceQueueClaim(itemId: number, claimToken: string): boolean {
  return getStmts().renewClaim.run(
    Date.now() + INVOICE_QUEUE_FLUSH_CLAIM_LEASE_MS,
    itemId,
    claimToken,
  ).changes === 1;
}

async function withInvoiceQueueClaimHeartbeat<T>(
  itemId: number,
  claimToken: string,
  operation: () => Promise<T>,
): Promise<T> {
  let claimLost = false;
  const heartbeat = setInterval(() => {
    try {
      if (!renewInvoiceQueueClaim(itemId, claimToken)) claimLost = true;
    } catch (error) {
      // The final synchronous renewal remains authoritative. A transient busy
      // failure here must not conceal the filing result or leak private errors.
      logger.warn(
        { queueId: itemId, errorName: safeErrorName(error) },
        'Invoice queue claim heartbeat could not be renewed',
      );
    }
  }, INVOICE_QUEUE_FLUSH_CLAIM_HEARTBEAT_MS);
  heartbeat.unref?.();
  try {
    const result = await operation();
    if (claimLost || !renewInvoiceQueueClaim(itemId, claimToken)) {
      throw new Error('Invoice queue flush claim expired during filing.');
    }
    return result;
  } finally {
    clearInterval(heartbeat);
  }
}

function releaseInvoiceQueueClaims(claimToken: string): void {
  getStmts().releaseClaims.run(claimToken);
}

function persistTerminalQueueSpoolDeletionProof(row: TerminalQueueSpool): boolean {
  const db = getDb();
  if (hasLiveQueueObjectIntent(row)) {
    throw new Error('Invoice queue object intent requires reconciliation before spool cleanup.');
  }
  const manifest = db.transaction(() => {
    assertInvoiceAccountAvailable(row.user_id, db);
    const owned = getQueueSpoolManifest(row, db);
    if (!owned || owned.tenant_id !== row.tenant_id || owned.user_id !== row.user_id
        || owned.storage_backend !== 'filesystem'
        || (owned.state !== 'stored' && owned.state !== 'deleting' && owned.state !== 'deleted')
        || (owned.state === 'deleted' && (!owned.deleted_at || !owned.deletion_device
          || !owned.deletion_inode || !owned.deletion_attempted_at))) {
      throw new Error('Invoice queue requires exact spool ownership for terminal cleanup.');
    }
    return owned;
  }).immediate();

  let deleted = false;
  if (manifest.state !== 'deleted' || manifest.deleted_at === null) {
    const outcome = deleteInvoiceQueueSpoolFileForAccountDeletion(row.local_path, {
      ownership: {
        manifestId: manifest.id,
        tenantId: row.tenant_id,
        userId: row.user_id,
      },
    });
    deleted = outcome.deleted;
  }

  db.transaction(() => {
    const durableManifestProof = db.prepare(`SELECT 1 AS present
      FROM invoice_artifact_manifests
      WHERE id = ? AND tenant_id = ? AND user_id = ?
        AND artifact_kind = 'queue_spool' AND artifact_locator = ?
        AND storage_backend = 'filesystem' AND state = 'deleted' AND deleted_at IS NOT NULL
        AND deletion_device IS NOT NULL AND deletion_inode IS NOT NULL
        AND deletion_attempted_at IS NOT NULL`)
      .get(manifest.id, row.tenant_id, row.user_id, row.local_path) as {
        present: number;
      } | undefined;
    if (durableManifestProof?.present !== 1) {
      throw new Error('Invoice queue spool manifest deletion proof is unavailable.');
    }
    const timestamp = new Date().toISOString();
    const queueProof = db.prepare(`UPDATE invoice_queue
      SET local_file_deleted_at = ?
      WHERE id = ? AND tenant_id = ? AND user_id = ? AND local_path = ?
        AND status IN ('filed', 'failed') AND local_file_deleted_at IS NULL`)
      .run(timestamp, row.id, row.tenant_id, row.user_id, row.local_path);
    if (queueProof.changes !== 1) {
      const existing = db.prepare(`SELECT 1 AS present FROM invoice_queue
        WHERE id = ? AND tenant_id = ? AND user_id = ? AND local_path = ?
          AND local_file_deleted_at IS NOT NULL`)
        .get(row.id, row.tenant_id, row.user_id, row.local_path) as { present: number } | undefined;
      if (existing?.present !== 1) {
        throw new Error('Invoice queue spool row deletion proof could not be persisted.');
      }
    }
  }).immediate();
  return deleted;
}

function tryReconcileTerminalQueueSpool(row: TerminalQueueSpool): boolean {
  try {
    return persistTerminalQueueSpoolDeletionProof(row);
  } catch (error) {
    logger.warn(
      { queueId: row.id, errorName: safeErrorName(error) },
      'Invoice queue terminal spool cleanup remains pending',
    );
    return false;
  }
}

export function reconcileTerminalInvoiceQueueSpools(
  limit = TERMINAL_SPOOL_CLEANUP_LIMIT,
): { proven: number; deleted: number; failed: number } {
  const boundedLimit = Number.isSafeInteger(limit) && limit > 0
    ? Math.min(limit, 5_000)
    : TERMINAL_SPOOL_CLEANUP_LIMIT;
  const rows = getDb().prepare(`SELECT id, tenant_id, user_id, local_path
    FROM invoice_queue
    WHERE status IN ('filed', 'failed') AND local_file_deleted_at IS NULL
      AND local_path IS NOT NULL AND TRIM(local_path) <> ''
    ORDER BY COALESCE(filed_at, created_at), id
    LIMIT ?`).all(boundedLimit) as TerminalQueueSpool[];
  let proven = 0;
  let deleted = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      if (persistTerminalQueueSpoolDeletionProof(row)) deleted += 1;
      proven += 1;
    } catch (error) {
      failed += 1;
      logger.warn(
        { queueId: row.id, errorName: safeErrorName(error) },
        'Invoice queue terminal spool cleanup remains pending',
      );
    }
  }
  return { proven, deleted, failed };
}

// ─── Queue Operations ─────────────────────────────────────────────────

/**
 * Save an invoice to local disk and queue it for later filing.
 * Returns the queue entry ID.
 */
export function enqueueInvoice(
  buffer: Buffer,
  type: 'image' | 'pdf',
  mediaType: string | null,
  analysisJson: string,
  source: string,
  userId: number,
  tenantId = userId,
): number {
  ensureQueueDir();

  const ext = type === 'pdf' ? 'pdf'
    : mediaType === 'image/png' ? 'png'
    : mediaType === 'image/webp' ? 'webp'
    : 'jpg';
  const filename = `queued_${Date.now()}_${crypto.randomBytes(12).toString('hex')}.${ext}`;
  const localPath = path.join(queueDirectory(), filename);
  const stmts = getStmts();
  const db = getDb();
  const admission = beginInvoiceArtifactWrite({
    tenantId,
    userId,
    artifactKind: 'queue_spool',
    artifactLocator: localPath,
    storageBackend: 'filesystem',
  }, db);
  let result: BetterSqlite3.RunResult;
  let createdIdentity: InvoiceArtifactDeletionIdentity | null = null;
  try {
    result = db.transaction(() => {
      // Serialize cleanup's durable `deleting` claim against the final
      // fence/lease check, synchronous spool creation, queue ownership row,
      // and manifest transition.
      assertInvoiceArtifactWriteCanProceed(admission, db);
      writePrivateQueueFile(localPath, buffer, (identity) => { createdIdentity = identity; });
      const inserted = stmts.enqueue.run(
        type,
        localPath,
        mediaType,
        analysisJson,
        source,
        tenantId,
        userId,
      );
      completeInvoiceArtifactWrite(admission, 'stored', db);
      return inserted;
    }).immediate();
  } catch (error) {
    // The queue insert is inside the immediate transaction and is already
    // rolled back when this catch runs. Do not delete by the rolled-back
    // lastInsertRowid: SQLite may reuse it for another account before a
    // compensating DELETE executes.
    if (createdIdentity) {
      try {
        deleteInvoiceQueueSpoolFileForAccountDeletion(localPath, {
          ownership: { manifestId: admission.manifestId, tenantId, userId },
          expectedIdentity: createdIdentity,
          expectedWriteToken: admission.writeToken,
        });
      } catch {
        // The durable deleting manifest remains authoritative after cleanup failure.
      }
      admission.release();
    } else {
      try {
        const absenceProven = !queueFileExists(localPath);
        completeInvoiceArtifactWrite(admission, absenceProven ? 'deleted' : 'failed', db);
      } catch {
        admission.release();
      }
    }
    throw error;
  }
  logger.info(
    { queueId: Number(result.lastInsertRowid), type },
    'Invoice queued for durable filing retry',
  );
  pushEvent({
    ts: new Date().toISOString(),
    type: 'job',
    summary: 'Invoice queued for durable filing retry',
  });

  return Number(result.lastInsertRowid);
}

/**
 * Get count of pending invoices in the queue.
 */
export function getPendingCount(): number {
  try {
    const stmts = getStmts();
    return (stmts.pendingCount.get() as any).c;
  } catch {
    return 0;
  }
}

/**
 * Get all pending queue entries.
 */
export function getPendingInvoices(): QueuedInvoice[] {
  try {
    const stmts = getStmts();
    return stmts.pending.all() as QueuedInvoice[];
  } catch {
    return [];
  }
}

// ─── Queue Flush (Retry) ──────────────────────────────────────────────

const MAX_RETRIES = 20; // ~5 hours at 15min intervals

function stableQueueDocumentDate(item: QueuedInvoice, analysis: Record<string, any>): string {
  const analyzed = typeof analysis.documentDate === 'string' ? analysis.documentDate.trim() : '';
  const candidates = [analyzed.slice(0, 10), item.created_at.trim().slice(0, 10)];
  for (const candidate of candidates) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(candidate)) continue;
    const parsed = new Date(`${candidate}T00:00:00.000Z`);
    if (!Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === candidate) {
      return candidate;
    }
  }
  throw new Error('Invoice queue row has no stable filing date.');
}

function stableQueueFilingIdentity(item: QueuedInvoice, buffer: Buffer): {
  filingIdentity: string;
  writeIntent: { kind: 'invoice_queue'; id: string; sourceChecksum: string };
} {
  const sourceChecksum = crypto.createHash('sha256').update(buffer).digest('hex');
  return {
    filingIdentity: `queue-${item.id}-${sourceChecksum.slice(0, 16)}`,
    writeIntent: { kind: 'invoice_queue', id: String(item.id), sourceChecksum },
  };
}

function hasLiveQueueObjectIntent(item: Pick<QueuedInvoice, 'id' | 'tenant_id' | 'user_id'>): boolean {
  const row = getDb().prepare(`SELECT 1 AS present
    FROM invoice_artifact_manifests manifest
    JOIN invoice_queue queue
      ON queue.id = ? AND queue.tenant_id = manifest.tenant_id
        AND queue.user_id = manifest.user_id AND queue.status <> 'filed'
    WHERE manifest.artifact_kind = 'stored_object'
      AND manifest.tenant_id = ? AND manifest.user_id = ?
      AND manifest.write_intent_kind = 'invoice_queue' AND manifest.write_intent_id = ?
      AND manifest.deleted_at IS NULL LIMIT 1`)
    .get(item.id, item.tenant_id, item.user_id, String(item.id)) as {
      present: number;
    } | undefined;
  return row?.present === 1;
}

/**
 * Attempt to flush all pending invoices in the queue.
 * Called by the scheduler cron job every 15 minutes.
 *
 * Returns { flushed, failed, remaining } counts.
 */
export async function flushQueue(): Promise<{ flushed: number; failed: number; remaining: number }> {
  const {
    fileInvoice,
    filePdf,
    isInvoiceFilingConfigured,
  } = await import('./invoice-filer');
  // Terminal spool deletion is independent of object-storage readiness. A
  // previous unlink/proof failure must keep making progress even while new
  // invoice filing is unavailable.
  reconcileTerminalInvoiceQueueSpools();
  if (!isInvoiceFilingConfigured()) {
    return { flushed: 0, failed: 0, remaining: getPendingCount() };
  }

  // Bind the filesystem authority before taking durable queue ownership so a
  // platform/path failure cannot strand a fresh claim until lease expiry.
  ensureQueueDir();
  const claimed = claimPendingInvoices();
  if (claimed.items.length === 0) return { flushed: 0, failed: 0, remaining: getPendingCount() };

  logger.info(
    { pendingCount: claimed.items.length },
    'Invoice queue flush: processing claimed durable writes',
  );

  const stmts = getStmts();
  let flushed = 0;
  let failed = 0;

  try {
    for (const item of claimed.items) {
      if (!renewInvoiceQueueClaim(item.id, claimed.claimToken)) continue;

      try {
        assertQueueSpoolReadyForFiling(item);
      } catch (error) {
        if (hasLiveQueueObjectIntent(item)) {
          stmts.markRetry.run(
            'invoice_queue_object_reconciliation_required',
            item.id,
            claimed.claimToken,
          );
          continue;
        }
        const terminal = stmts.markFailed.run(
          'invoice_queue_manifest_validation_failed',
          item.id,
          claimed.claimToken,
        );
        logger.error(
          { queueId: item.id, errorName: safeErrorName(error) },
          'Invoice queue item failed stored-spool ownership validation',
        );
        if (terminal.changes === 1) failed++;
        continue;
      }

      // Check if local file still exists
      if (!queueFileExists(item.local_path)) {
        if (hasLiveQueueObjectIntent(item)) {
          stmts.markRetry.run(
            'invoice_queue_object_reconciliation_required',
            item.id,
            claimed.claimToken,
          );
          continue;
        }
        const terminal = stmts.markFailed.run(
          'invoice_queue_file_missing',
          item.id,
          claimed.claimToken,
        );
        if (terminal.changes === 1) {
          tryReconcileTerminalQueueSpool(item);
          failed++;
        }
        continue;
      }

      // Too many retries — give up
      if (item.retries >= MAX_RETRIES) {
        if (hasLiveQueueObjectIntent(item)) {
          stmts.markRetry.run(
            'invoice_queue_object_reconciliation_required',
            item.id,
            claimed.claimToken,
          );
          continue;
        }
        const terminal = stmts.markFailed.run(
          'invoice_queue_retry_limit_exceeded',
          item.id,
          claimed.claimToken,
        );
        if (terminal.changes === 1) {
          tryReconcileTerminalQueueSpool(item);
          failed++;
        }
        continue;
      }

      let buffer: Buffer;
      let analysis: Record<string, any>;
      try {
        buffer = readPrivateQueueFile(item.local_path);
        analysis = JSON.parse(item.analysis_json) as Record<string, any>;
      } catch (error) {
        if (hasLiveQueueObjectIntent(item)) {
          stmts.markRetry.run(
            'invoice_queue_object_reconciliation_required',
            item.id,
            claimed.claimToken,
          );
          continue;
        }
        const terminal = stmts.markFailed.run(
          'invoice_queue_security_validation_failed',
          item.id,
          claimed.claimToken,
        );
        logger.error(
          { queueId: item.id, errorName: safeErrorName(error) },
          'Invoice queue item failed private-file validation',
        );
        if (terminal.changes === 1) {
          tryReconcileTerminalQueueSpool(item);
          failed++;
        }
        continue;
      }

      try {
        const filingIdentity = stableQueueFilingIdentity(item, buffer);
        const filingDocumentDate = stableQueueDocumentDate(item, analysis);
        const result = await withInvoiceQueueClaimHeartbeat(
          item.id,
          claimed.claimToken,
          () => item.type === 'image'
            ? fileInvoice(
              buffer,
              item.media_type as 'image/jpeg' | 'image/png' | 'image/webp',
              { ...analysis, documentDate: filingDocumentDate } as InvoiceAnalysis,
              {
                tenantId: item.tenant_id,
                userId: item.user_id,
                filingIdentity: filingIdentity.filingIdentity,
                writeIntent: filingIdentity.writeIntent,
              },
            )
            : filePdf(
              buffer,
              analysis.vendor,
              filingDocumentDate,
              analysis.invoiceNumber,
              analysis.originalName,
              {
                tenantId: item.tenant_id,
                userId: item.user_id,
                filingIdentity: filingIdentity.filingIdentity,
                writeIntent: filingIdentity.writeIntent,
              },
            ),
        );

        if (result.success) {
          // Atomic: mark as filed + record in invoice_filings in a single transaction.
          // The conditional transition proves this worker still owns the claim.
          const db = getDb();
          db.transaction(() => {
            const marked = stmts.markFiled.run(item.id, claimed.claimToken);
            if (marked.changes !== 1) {
              throw new Error('Invoice queue flush claim is no longer owned.');
            }
            recordFiling({
              vendor: analysis.vendor || 'Unknown',
              amount: analysis.totalAmount || null,
              document_date: analysis.documentDate || null,
              invoice_number: analysis.invoiceNumber || null,
              source: item.source as 'photo' | 'email' | 'amazon' | 'uber',
              source_ref: `queue_${item.id}`,
              remote_path: result.filePath,
              folder_path: result.folderPath,
              filename: result.filename,
              file_size_bytes: result.originalSizeKB ? result.originalSizeKB * 1024 : null,
              compressed_size_bytes: result.compressedSizeKB ? result.compressedSizeKB * 1024 : null,
              object_key: result.objectKey ?? null,
              checksum: result.checksum ?? null,
              mime: result.mime ?? item.media_type ?? null,
              bytes: result.bytes ?? buffer.length,
              storage_backend: result.storageBackend ?? null,
              status: 'filed',
              user_id: item.user_id,
              tenant_id: item.tenant_id,
            });
          })();
          flushed++;
          tryReconcileTerminalQueueSpool(item);

          logger.info({ queueId: item.id }, 'Queued invoice filed successfully');
        } else {
          stmts.markRetry.run(
            'invoice_object_storage_write_failed',
            item.id,
            claimed.claimToken,
          );
        }
      } catch (error) {
        const connectivityFailure = isConnectivityFailure(error);
        stmts.markRetry.run(
          connectivityFailure ? 'invoice_object_storage_unavailable' : 'invoice_filing_failed',
          item.id,
          claimed.claimToken,
        );
        if (connectivityFailure) {
          logger.warn('Object storage connection failed mid-flush, stopping queue processing');
          break;
        }
      }
    }
  } finally {
    releaseInvoiceQueueClaims(claimed.claimToken);
  }

  const remaining = getPendingCount();

  if (flushed > 0) {
    pushEvent({
      ts: new Date().toISOString(),
      type: 'job',
      summary: `Invoice queue flushed: ${flushed} filed${failed > 0 ? `, ${failed} failed` : ''}${remaining > 0 ? `, ${remaining} remaining` : ''}`,
    });
  }

  return { flushed, failed, remaining };
}
