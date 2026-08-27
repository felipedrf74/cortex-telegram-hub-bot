// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DateTime } from 'luxon';
import type Database from 'better-sqlite3';
import { config } from '../config';
import { getPortugueseMonthFolder } from './invoice-paths';
import { getDb } from './database';
import {
  assertInvoiceAccountAvailable,
  beginInvoiceArtifactWrite,
  assertInvoiceArtifactWriteCanProceed,
  claimInvoiceArtifactDeletion,
  completeInvoiceArtifactDeletion,
  completeInvoiceArtifactWrite,
  InvoiceArtifactDeletionIdentity,
  InvoiceArtifactManifestOwnership,
  InvoiceArtifactWriteIntent,
} from './invoice-artifact-admission';

export type InvoiceStorageBackend = 'filesystem';

export interface StoredInvoiceObject {
  objectKey: string;
  checksum: string;
  mime: string;
  bytes: number;
  storageBackend: InvoiceStorageBackend;
}

export interface DeletedInvoiceObject {
  deleted: boolean;
  alreadyMissing: boolean;
}

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export function isInvoiceObjectStorageConfigured(): boolean {
  return config.invoiceObjectStorage.enabled;
}

function safeKeyPart(value: string, fallback: string): string {
  const cleaned = value
    .trim()
    .replace(/[/\\]/g, '_')
    .replace(/[^a-zA-Z0-9€.,\-_àáãâéêíóôõúçÀÁÃÂÉÊÍÓÔÕÚÇ]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 160);
  return cleaned || fallback;
}

function assertPositiveId(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
}

function assertSafeObjectKey(objectKey: string): void {
  if (
    objectKey.startsWith('/') ||
    objectKey.includes('\\') ||
    objectKey.split('/').some((part) => part === '.' || part === '..' || part === '')
  ) {
    throw new Error('Unsafe invoice object key');
  }
}

function assertOwnedByCurrentUser(stat: fs.Stats, label: string): void {
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (currentUid !== null && stat.uid !== currentUid) {
    throw new Error(`${label} is not owned by the current process user`);
  }
}

interface BoundDirectory {
  descriptor: number;
  identity: fs.Stats;
  namespacePath: string;
  privateDirectory: boolean;
}

interface PrivateObjectLocation {
  bindings: BoundDirectory[];
  parent: BoundDirectory;
  root: BoundDirectory;
  rootPath: string;
  targetName: string;
  targetPath: string;
}

function sameFileIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function directoryOpenFlags(): number {
  const noFollow = fs.constants.O_NOFOLLOW;
  const directory = fs.constants.O_DIRECTORY;
  if (typeof noFollow !== 'number' || typeof directory !== 'number') {
    throw new Error('Invoice object storage requires no-follow directory descriptors');
  }
  return fs.constants.O_RDONLY | noFollow | directory;
}

function assertDirectoryMetadata(
  stat: fs.Stats,
  label: string,
  privateDirectory: boolean,
): void {
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} is not a directory`);
  }
  if (privateDirectory) {
    assertOwnedByCurrentUser(stat, label);
    if ((stat.mode & 0o077) !== 0) {
      throw new Error(`${label} permissions are not private`);
    }
  }
}

function assertBoundDirectory(binding: BoundDirectory): void {
  const opened = fs.fstatSync(binding.descriptor);
  const named = fs.lstatSync(binding.namespacePath);
  assertDirectoryMetadata(opened, 'Invoice object directory descriptor', binding.privateDirectory);
  assertDirectoryMetadata(named, 'Invoice object directory', binding.privateDirectory);
  if (!sameFileIdentity(opened, binding.identity) || !sameFileIdentity(named, binding.identity)) {
    throw new Error('Invoice object directory authority changed');
  }
}

function openBoundDirectory(
  namespacePath: string,
  operationPath: string,
  privateDirectory: boolean,
  expectedIdentity?: fs.Stats,
): BoundDirectory {
  const descriptor = fs.openSync(operationPath, directoryOpenFlags());
  try {
    const opened = fs.fstatSync(descriptor);
    assertDirectoryMetadata(opened, 'Invoice object directory descriptor', false);
    if (privateDirectory) {
      assertOwnedByCurrentUser(opened, 'Invoice object directory descriptor');
      fs.fchmodSync(descriptor, PRIVATE_DIRECTORY_MODE);
    }
    const secured = fs.fstatSync(descriptor);
    const named = fs.lstatSync(namespacePath);
    assertDirectoryMetadata(secured, 'Invoice object directory descriptor', privateDirectory);
    assertDirectoryMetadata(named, 'Invoice object directory', privateDirectory);
    if (!sameFileIdentity(secured, named)
        || (expectedIdentity && !sameFileIdentity(secured, expectedIdentity))) {
      throw new Error('Invoice object directory path and descriptor disagree');
    }
    return {
      descriptor,
      identity: secured,
      namespacePath,
      privateDirectory,
    };
  } catch (error) {
    fs.closeSync(descriptor);
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('Invoice object directory authority could not be proven');
    }
    throw error;
  }
}

function descriptorDirectoryPath(directory: BoundDirectory): string {
  assertBoundDirectory(directory);
  const descriptorPath = `/proc/self/fd/${directory.descriptor}`;
  let descriptorStat: fs.Stats;
  try {
    descriptorStat = fs.statSync(descriptorPath);
  } catch {
    throw new Error('Invoice object storage requires procfs descriptor-relative operations');
  }
  if (!sameFileIdentity(descriptorStat, directory.identity)) {
    throw new Error('Invoice object directory descriptor path disagrees');
  }
  return descriptorPath;
}

function descriptorRelativePath(directory: BoundDirectory, childName: string): string {
  if (childName === '.' || childName === '..' || childName.includes('/') || childName.includes('\\')) {
    throw new Error('Unsafe invoice object path component');
  }
  return path.join(descriptorDirectoryPath(directory), childName);
}

function closeBoundDirectories(bindings: BoundDirectory[]): void {
  for (const binding of [...bindings].reverse()) fs.closeSync(binding.descriptor);
}

function openChildDirectory(
  parent: BoundDirectory,
  childName: string,
  create: boolean,
  privateDirectory: boolean,
): BoundDirectory | null {
  if (create && !privateDirectory) {
    throw new Error('Invoice object storage cannot create a non-private directory');
  }
  const namespacePath = path.join(parent.namespacePath, childName);
  const operationPath = descriptorRelativePath(parent, childName);
  if (create) {
    try {
      fs.mkdirSync(operationPath, { recursive: false, mode: PRIVATE_DIRECTORY_MODE });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  let observed: fs.Stats;
  try {
    observed = fs.lstatSync(operationPath);
  } catch (error) {
    if (!create && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      assertBoundDirectory(parent);
      return null;
    }
    throw error;
  }
  let child: BoundDirectory | null = null;
  try {
    child = openBoundDirectory(namespacePath, operationPath, privateDirectory, observed);
    assertBoundDirectory(parent);
    return child;
  } catch (error) {
    if (child) fs.closeSync(child.descriptor);
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || code === 'ENOTDIR') {
      throw new Error('Invoice object directory is not a private directory');
    }
    throw error;
  }
}

function openFilesystemRoot(create: boolean): {
  bindings: BoundDirectory[];
  root: BoundDirectory;
  rootPath: string;
} {
  if (process.platform !== 'linux') {
    throw new Error('Invoice object storage requires Linux descriptor-relative operations');
  }
  const rootPath = path.resolve(process.cwd(), config.invoiceObjectStorage.filesystemDir);
  const filesystemAnchor = path.parse(rootPath).root;
  if (rootPath === filesystemAnchor) {
    throw new Error('Invoice object storage root cannot be the filesystem root');
  }
  const parts = path.relative(filesystemAnchor, rootPath).split(path.sep).filter(Boolean);
  const bindings: BoundDirectory[] = [];
  try {
    let current = openBoundDirectory(filesystemAnchor, filesystemAnchor, false);
    bindings.push(current);
    let creatingPrivateChain = false;
    for (const [index, part] of parts.entries()) {
      const isRoot = index === parts.length - 1;
      let child = openChildDirectory(
        current,
        part,
        false,
        creatingPrivateChain || isRoot,
      );
      if (!child) {
        if (!create) {
          throw new Error('Invoice object storage root absence cannot be proven safely');
        }
        creatingPrivateChain = true;
        child = openChildDirectory(current, part, true, true);
      }
      if (!child) throw new Error('Invoice object storage root could not be created');
      bindings.push(child);
      current = child;
    }
    assertBoundDirectory(current);
    return { bindings, root: current, rootPath };
  } catch (error) {
    closeBoundDirectories(bindings);
    throw error;
  }
}

function openPrivateObjectLocation(objectKey: string, create: boolean): PrivateObjectLocation | null {
  assertSafeObjectKey(objectKey);
  const root = openFilesystemRoot(create);
  const bindings = root.bindings;
  try {
    const parts = objectKey.split('/');
    const targetName = parts.pop();
    if (!targetName) throw new Error('Unsafe invoice object key');
    let parent = root.root;
    for (const part of parts) {
      const child = openChildDirectory(parent, part, create, true);
      if (!child) {
        closeBoundDirectories(bindings);
        return null;
      }
      bindings.push(child);
      parent = child;
    }
    const targetPath = path.join(root.rootPath, ...parts, targetName);
    const relative = path.relative(root.rootPath, targetPath);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('Invoice object key escapes storage root');
    }
    return {
      bindings,
      parent,
      root: root.root,
      rootPath: root.rootPath,
      targetName,
      targetPath,
    };
  } catch (error) {
    closeBoundDirectories(bindings);
    throw error;
  }
}

function assertPrivateFileMetadata(stat: fs.Stats, label: string): void {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error(`${label} is not a private regular file`);
  }
  assertOwnedByCurrentUser(stat, label);
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`${label} permissions are not private`);
  }
}

function openPrivateObjectForRead(location: PrivateObjectLocation): {
  descriptor: number;
  stat: fs.Stats;
} {
  const noFollow = fs.constants.O_NOFOLLOW;
  if (typeof noFollow !== 'number') {
    throw new Error('Invoice object storage requires no-follow file reads');
  }
  const operationPath = descriptorRelativePath(location.parent, location.targetName);
  const descriptor = fs.openSync(operationPath, fs.constants.O_RDONLY | noFollow);
  try {
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.isSymbolicLink() || opened.nlink !== 1) {
      throw new Error('Invoice object read descriptor is not a private regular file');
    }
    assertOwnedByCurrentUser(opened, 'Invoice object read descriptor');
    fs.fchmodSync(descriptor, PRIVATE_FILE_MODE);
    const secured = fs.fstatSync(descriptor);
    const named = fs.lstatSync(location.targetPath);
    assertPrivateFileMetadata(secured, 'Invoice object read descriptor');
    assertPrivateFileMetadata(named, 'Invoice object');
    if (!sameFileIdentity(secured, named)) {
      throw new Error('Invoice object path and read descriptor disagree');
    }
    assertBoundDirectory(location.parent);
    return { descriptor, stat: secured };
  } catch (error) {
    fs.closeSync(descriptor);
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('Invoice object path authority could not be proven');
    }
    throw error;
  }
}

function privateObjectEntryExists(location: PrivateObjectLocation): boolean {
  const operationPath = descriptorRelativePath(location.parent, location.targetName);
  try {
    fs.lstatSync(operationPath);
    assertBoundDirectory(location.parent);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    assertBoundDirectory(location.parent);
    return false;
  }
}

function removePrivateObjectFile(
  location: PrivateObjectLocation,
  opened?: { descriptor: number; stat: fs.Stats },
): boolean {
  const ownedDescriptor = !opened;
  if (!opened) {
    if (!privateObjectEntryExists(location)) return false;
    opened = openPrivateObjectForRead(location);
  }
  try {
    const operationPath = descriptorRelativePath(location.parent, location.targetName);
    const current = fs.lstatSync(operationPath);
    if (current.dev !== opened.stat.dev || current.ino !== opened.stat.ino || current.nlink !== 1) {
      throw new Error('Invoice object changed during deletion validation');
    }
    fs.unlinkSync(operationPath);
    fs.fsyncSync(location.parent.descriptor);
    if (fs.fstatSync(opened.descriptor).nlink !== 0) {
      throw new Error('Invoice object validated inode survived deletion');
    }
    if (privateObjectEntryExists(location)) {
      throw new Error('Invoice object deletion could not be proven');
    }
    return true;
  } finally {
    if (ownedDescriptor) fs.closeSync(opened.descriptor);
  }
}

function writePrivateObject(
  location: PrivateObjectLocation,
  buffer: Buffer,
  onCreated: (identity: InvoiceArtifactDeletionIdentity) => void,
): void {
  const noFollow = fs.constants.O_NOFOLLOW;
  if (typeof noFollow !== 'number') {
    throw new Error('Invoice object storage requires no-follow file creation support');
  }
  const operationPath = descriptorRelativePath(location.parent, location.targetName);
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow;
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(operationPath, flags, PRIVATE_FILE_MODE);
    const opened = fs.fstatSync(descriptor);
    onCreated({ device: String(opened.dev), inode: String(opened.ino) });
    if (!opened.isFile() || opened.nlink !== 1) {
      throw new Error('Invoice object descriptor is not an exclusive regular file');
    }
    assertOwnedByCurrentUser(opened, 'Invoice object descriptor');
    fs.fchmodSync(descriptor, PRIVATE_FILE_MODE);
    fs.writeFileSync(descriptor, buffer);
    fs.fsyncSync(descriptor);
    const secured = fs.fstatSync(descriptor);
    const named = fs.lstatSync(location.targetPath);
    assertPrivateFileMetadata(secured, 'Invoice object descriptor');
    assertPrivateFileMetadata(named, 'Invoice object');
    if (!sameFileIdentity(secured, named)) {
      throw new Error('Invoice object path and descriptor disagree');
    }
    assertBoundDirectory(location.parent);
    fs.fsyncSync(location.parent.descriptor);
    assertBoundDirectory(location.parent);
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

function tenantPrefixForKey(objectKey: string): string | null {
  const parts = objectKey.split('/');
  if (parts.length < 3 || parts[0] !== 'invoices') return null;
  return path.join('invoices', parts[1]);
}

function ownershipScopeForObjectKey(objectKey: string): { tenantId: number; userId: number } {
  const parts = objectKey.split('/');
  const tenantId = Number(parts[1]);
  const userId = Number(parts[2]);
  if (parts[0] !== 'invoices' || !Number.isSafeInteger(tenantId) || tenantId <= 0
      || !Number.isSafeInteger(userId) || userId <= 0) {
    throw new Error('Invoice object key does not carry a valid ownership scope');
  }
  return { tenantId, userId };
}

function directorySizeBytes(directory: BoundDirectory): number {
  assertBoundDirectory(directory);
  let total = 0;
  const operationPath = descriptorDirectoryPath(directory);
  for (const entry of fs.readdirSync(operationPath, { withFileTypes: true })) {
    const childOperationPath = descriptorRelativePath(directory, entry.name);
    const childNamespacePath = path.join(directory.namespacePath, entry.name);
    const stat = fs.lstatSync(childOperationPath);
    if (stat.isSymbolicLink()) {
      throw new Error('Invoice object tenant directory cannot contain symbolic links');
    }
    if (stat.isDirectory()) {
      const child = openBoundDirectory(childNamespacePath, childOperationPath, true, stat);
      try {
        total += directorySizeBytes(child);
      } finally {
        fs.closeSync(child.descriptor);
      }
    } else if (stat.isFile()) {
      total += stat.size;
    } else {
      throw new Error('Invoice object tenant directory contains an unsafe entry');
    }
  }
  assertBoundDirectory(directory);
  return total;
}

function assertFilesystemGuardrails(
  location: PrivateObjectLocation,
  objectKey: string,
  bytesToWrite: number,
): void {
  const root = location.rootPath;
  assertBoundDirectory(location.root);

  if (config.invoiceObjectStorage.minFreeBytes > 0) {
    const stats = fs.statfsSync(descriptorDirectoryPath(location.root));
    const availableBytes = Number(stats.bavail) * Number(stats.bsize);
    if ((availableBytes - bytesToWrite) < config.invoiceObjectStorage.minFreeBytes) {
      throw new Error('Invoice object storage free-space guardrail would be violated.');
    }
  }

  if (config.invoiceObjectStorage.tenantMaxBytes > 0) {
    const tenantPrefix = tenantPrefixForKey(objectKey);
    if (tenantPrefix) {
      const tenantDir = path.resolve(root, tenantPrefix);
      const tenant = location.bindings.find((binding) => binding.namespacePath === tenantDir);
      if (!tenant) throw new Error('Invoice object tenant directory is not descriptor-bound');
      const tenantBytes = directorySizeBytes(tenant);
      if ((tenantBytes + bytesToWrite) > config.invoiceObjectStorage.tenantMaxBytes) {
        throw new Error('Invoice object storage tenant byte cap would be exceeded.');
      }
    }
  }
  assertBoundDirectory(location.root);
}

export function buildInvoiceObjectKey(input: {
  tenantId: number;
  userId: number;
  documentDate: string | null | undefined;
  filename: string;
}): string {
  assertPositiveId(input.tenantId, 'tenantId');
  assertPositiveId(input.userId, 'userId');
  const parsed = input.documentDate
    ? DateTime.fromISO(input.documentDate, { zone: config.app.timezone })
    : null;
  const effectiveDate = parsed?.isValid ? parsed : DateTime.now().setZone(config.app.timezone);
  const monthFolder = getPortugueseMonthFolder(effectiveDate);
  return [
    'invoices',
    String(input.tenantId),
    String(input.userId),
    String(effectiveDate.year),
    monthFolder,
    safeKeyPart(input.filename, `invoice-${Date.now()}`),
  ].join('/');
}

export function sha256Hex(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export async function putInvoiceObject(
  buffer: Buffer,
  objectKey: string,
  mime: string,
  options: { db?: Database.Database; writeIntent?: InvoiceArtifactWriteIntent } = {},
): Promise<StoredInvoiceObject> {
  if (!isInvoiceObjectStorageConfigured()) {
    throw new Error('Invoice object storage is not configured.');
  }
  if (buffer.length > config.invoiceObjectStorage.maxObjectBytes) {
    throw new Error(`Invoice object exceeds ${config.invoiceObjectStorage.maxObjectBytes} bytes.`);
  }
  assertSafeObjectKey(objectKey);

  const db = options.db ?? getDb();
  const ownership = ownershipScopeForObjectKey(objectKey);
  const checksum = sha256Hex(buffer);
  const existingByIntentRows = options.writeIntent
    ? db.prepare(`SELECT artifact_locator, tenant_id, user_id, storage_backend, state, deleted_at,
          write_intent_kind, write_intent_id, source_checksum,
          payload_checksum, payload_bytes, payload_mime
        FROM invoice_artifact_manifests
        WHERE artifact_kind = 'stored_object' AND tenant_id = ? AND user_id = ?
          AND write_intent_kind = ? AND write_intent_id = ? AND source_checksum = ?
          AND deleted_at IS NULL
        ORDER BY id ASC LIMIT 2`)
      .all(
        ownership.tenantId,
        ownership.userId,
        options.writeIntent.kind,
        options.writeIntent.id,
        options.writeIntent.sourceChecksum,
      ) as Array<{
        artifact_locator: string;
        tenant_id: number;
        user_id: number;
        storage_backend: string;
        state: string;
        deleted_at: string | null;
        write_intent_kind: string | null;
        write_intent_id: string | null;
        source_checksum: string | null;
        payload_checksum: string | null;
        payload_bytes: number | null;
        payload_mime: string | null;
      }>
    : [];
  if (existingByIntentRows.length > 1) {
    throw new Error('Invoice queue object intent has ambiguous live manifests.');
  }
  const existingByIntent = existingByIntentRows[0];
  if (existingByIntent) {
    assertInvoiceAccountAvailable(ownership.userId, db);
    const payloadChecksum = existingByIntent.payload_checksum;
    const payloadBytes = existingByIntent.payload_bytes;
    const payloadMime = existingByIntent.payload_mime;
    if (existingByIntent.storage_backend !== 'filesystem'
        || existingByIntent.state !== 'stored' || existingByIntent.deleted_at !== null
        || !payloadChecksum
        || typeof payloadBytes !== 'number'
        || !Number.isSafeInteger(payloadBytes)
        || !payloadMime) {
      throw new Error('Existing invoice queue object intent is not safely adoptable.');
    }
    const existingBuffer = await getInvoiceObjectBuffer(existingByIntent.artifact_locator, 'filesystem');
    if (existingBuffer.length !== payloadBytes
        || sha256Hex(existingBuffer) !== payloadChecksum) {
      throw new Error('Existing invoice queue object payload proof is invalid.');
    }
    return {
      objectKey: existingByIntent.artifact_locator,
      checksum: payloadChecksum,
      mime: payloadMime,
      bytes: payloadBytes,
      storageBackend: 'filesystem',
    };
  }

  const existing = db.prepare(`SELECT tenant_id, user_id, storage_backend, state, deleted_at,
      write_intent_kind, write_intent_id, source_checksum
    FROM invoice_artifact_manifests
    WHERE artifact_kind = 'stored_object' AND artifact_locator = ?`).get(objectKey) as {
      tenant_id: number;
      user_id: number;
      storage_backend: string;
      state: string;
      deleted_at: string | null;
      write_intent_kind: string | null;
      write_intent_id: string | null;
      source_checksum: string | null;
    } | undefined;
  if (existing) {
    assertInvoiceAccountAvailable(ownership.userId, db);
    if (existing.tenant_id !== ownership.tenantId || existing.user_id !== ownership.userId
        || existing.storage_backend !== 'filesystem' || existing.state !== 'stored'
        || existing.deleted_at !== null) {
      throw new Error('Existing invoice object manifest is not safely adoptable.');
    }
    if (options.writeIntent || existing.write_intent_kind
        || existing.write_intent_id || existing.source_checksum) {
      throw new Error('Existing invoice object has a different durable write intent.');
    }
    const existingBuffer = await getInvoiceObjectBuffer(objectKey, 'filesystem');
    if (existingBuffer.length !== buffer.length || sha256Hex(existingBuffer) !== checksum) {
      throw new Error('Existing invoice object does not match the idempotent write.');
    }
    return {
      objectKey,
      checksum,
      mime,
      bytes: buffer.length,
      storageBackend: 'filesystem',
    };
  }
  const admission = beginInvoiceArtifactWrite({
    ...ownership,
    artifactKind: 'stored_object',
    artifactLocator: objectKey,
    storageBackend: 'filesystem',
    ...(options.writeIntent ? { writeIntent: options.writeIntent } : {}),
    payload: { checksum, bytes: buffer.length, mime },
  }, db);
  let location: PrivateObjectLocation | null = null;
  let createdIdentity: InvoiceArtifactDeletionIdentity | null = null;

  try {
    location = openPrivateObjectLocation(objectKey, true);
    if (!location) throw new Error('Invoice object storage directory could not be created');
    assertFilesystemGuardrails(location, objectKey, buffer.length);
    db.transaction(() => {
      // The immediate writer lock spans the final fence/lease check, synchronous
      // byte creation, and manifest transition. Account cleanup must first claim
      // the same row as `deleting`, so a suspended writer can never resume after
      // cleanup has proved absence.
      assertInvoiceArtifactWriteCanProceed(admission, db);
      writePrivateObject(location!, buffer, (identity) => { createdIdentity = identity; });
      completeInvoiceArtifactWrite(admission, 'stored', db);
    }).immediate();

    return {
      objectKey,
      checksum,
      mime,
      bytes: buffer.length,
      storageBackend: 'filesystem',
    };
  } catch (error) {
    if (createdIdentity && location) {
      try {
        await deleteInvoiceObject(objectKey, 'filesystem', {
          db,
          ownership: {
            manifestId: admission.manifestId,
            tenantId: ownership.tenantId,
            userId: ownership.userId,
          },
          expectedIdentity: createdIdentity,
          expectedWriteToken: admission.writeToken,
        });
      } catch {
        // The durable deleting manifest remains authoritative after cleanup failure.
      }
      admission.release();
    } else {
      try {
        const absenceProven = !location || !privateObjectEntryExists(location);
        completeInvoiceArtifactWrite(admission, absenceProven ? 'deleted' : 'failed', db);
      } catch {
        admission.release();
      }
    }
    throw error;
  } finally {
    if (location) closeBoundDirectories(location.bindings);
  }
}

export async function getInvoiceObjectBuffer(
  objectKey: string,
  storageBackend: string | null | undefined = 'filesystem',
): Promise<Buffer> {
  assertSafeObjectKey(objectKey);
  // Historical `legacy_scp` rows were always resolved through the local
  // filesystem fallback. Preserve that read compatibility while retiring only
  // the unused MinIO/S3 implementation.
  if (storageBackend != null
      && storageBackend !== 'filesystem'
      && storageBackend !== 'legacy_scp') {
    throw new Error(`Unsupported invoice object storage backend: ${storageBackend}`);
  }
  const location = openPrivateObjectLocation(objectKey, false);
  if (!location) {
    throw Object.assign(new Error('Invoice object does not exist'), { code: 'ENOENT' });
  }
  let opened: { descriptor: number; stat: fs.Stats } | null = null;
  try {
    opened = openPrivateObjectForRead(location);
    return fs.readFileSync(opened.descriptor);
  } finally {
    if (opened) fs.closeSync(opened.descriptor);
    closeBoundDirectories(location.bindings);
  }
}

export async function deleteInvoiceObject(
  objectKey: string,
  storageBackend: string | null | undefined = 'filesystem',
  options: {
    db?: Database.Database;
    ownership?: InvoiceArtifactManifestOwnership;
    expectedIdentity?: InvoiceArtifactDeletionIdentity;
    expectedWriteToken?: string;
  } = {},
): Promise<DeletedInvoiceObject> {
  if (storageBackend === 'legacy_scp') {
    throw new Error('Legacy invoice deletion requires verified mounted-root maintenance proof');
  }
  assertSafeObjectKey(objectKey);
  if (storageBackend != null
      && storageBackend !== 'filesystem') {
    throw new Error('Unsupported invoice object storage backend for deletion');
  }
  const db = options.db ?? getDb();
  const liveManifest = db.prepare(`SELECT id, tenant_id, user_id FROM invoice_artifact_manifests
    WHERE artifact_kind = 'stored_object' AND artifact_locator = ? AND deleted_at IS NULL`)
    .get(objectKey) as { id: number; tenant_id: number; user_id: number } | undefined;
  const keyOwnership = ownershipScopeForObjectKey(objectKey);
  if (options.ownership && (options.ownership.tenantId !== keyOwnership.tenantId
      || options.ownership.userId !== keyOwnership.userId)) {
    throw new Error('Invoice object deletion ownership does not match its object key.');
  }
  const effectiveOwnership = options.ownership ?? (liveManifest ? {
    manifestId: liveManifest.id,
    tenantId: liveManifest.tenant_id,
    userId: liveManifest.user_id,
  } : undefined);
  if (liveManifest && (!effectiveOwnership
      || liveManifest.tenant_id !== keyOwnership.tenantId
      || liveManifest.user_id !== keyOwnership.userId
      || effectiveOwnership.manifestId !== liveManifest.id
      || effectiveOwnership.tenantId !== liveManifest.tenant_id
      || effectiveOwnership.userId !== liveManifest.user_id)) {
    throw new Error('Invoice object deletion requires its exact live manifest ownership.');
  }
  let location: PrivateObjectLocation | null = null;
  let opened: { descriptor: number; stat: fs.Stats } | null = null;
  try {
    try {
      location = openPrivateObjectLocation(objectKey, false);
      if (location && privateObjectEntryExists(location)) {
        opened = openPrivateObjectForRead(location);
      }
    } catch (error) {
      if (!effectiveOwnership) throw error;
    }
    if (effectiveOwnership) {
      const claim = claimInvoiceArtifactDeletion({
        ownership: effectiveOwnership,
        artifactKind: 'stored_object',
        artifactLocator: objectKey,
        storageBackend: 'filesystem',
        observedIdentity: opened
          ? { device: String(opened.stat.dev), inode: String(opened.stat.ino) }
          : null,
        expectedIdentity: options.expectedIdentity,
        expectedWriteToken: options.expectedWriteToken,
      }, db);
      if (!location || !opened) {
        throw new Error('Invoice object deletion descriptor is unavailable.');
      }
      const deleted = removePrivateObjectFile(location, opened);
      if (!deleted) throw new Error('Invoice object deletion could not be proven.');
      completeInvoiceArtifactDeletion(claim, db);
      return { deleted: true, alreadyMissing: false };
    }
    if (!location) return { deleted: false, alreadyMissing: true };
    if (opened) {
      throw new Error('Invoice object deletion requires a durable ownership manifest.');
    }
    return { deleted: false, alreadyMissing: true };
  } finally {
    if (opened) fs.closeSync(opened.descriptor);
    if (location) closeBoundDirectories(location.bindings);
  }
}

export async function verifyInvoiceObjectChecksum(
  objectKey: string,
  expectedChecksum: string | null | undefined,
  storageBackend?: string | null,
): Promise<Buffer> {
  const buffer = await getInvoiceObjectBuffer(objectKey, storageBackend);
  // Legacy filings may not have a checksum; new stored objects always should.
  if (expectedChecksum && sha256Hex(buffer) !== expectedChecksum) {
    throw new Error('Invoice object checksum mismatch');
  }
  return buffer;
}
