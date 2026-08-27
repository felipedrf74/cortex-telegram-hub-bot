// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import fs from 'fs';
import path from 'path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { config } from '../config';
import {
  buildInvoiceObjectKey,
  deleteInvoiceObject,
  isInvoiceObjectStorageConfigured,
  putInvoiceObject,
  type StoredInvoiceObject,
  verifyInvoiceObjectChecksum,
} from '../services/invoice-object-storage';

interface LegacyFilingRow {
  id: number;
  tenant_id: number;
  user_id: number;
  vendor: string;
  document_date: string | null;
  filename: string | null;
  remote_path: string | null;
  object_key?: string | null;
  checksum?: string | null;
  storage_backend?: string | null;
}

const MAX_BACKFILL_PAGE_LIMIT = 5_000;

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function printHelp(): void {
  console.log(`
Invoice object storage backfill

Usage:
  node dist/tools/invoice-object-storage-backfill.js [--db ./data/bot.db] [--legacy-root /mounted/legacy/root] [--legacy-root-marker-sha256 <hex>] [--limit 100] [--reconcile-manifests --manifest-kind filings|objects|queue --manifest-after <cursor>] [--apply] [--delete-legacy] [--json]

Defaults to dry-run mode. Without --apply, no rows are changed and no objects are written.

The tool never opens SSH/SCP itself. Mount the legacy invoice root at a real, non-symlink path,
then pass --legacy-root or INVOICE_LEGACY_REMOTE_MOUNT. --delete-legacy requires --apply; it verifies
the backfilled object checksum, removes the owned single-link legacy file through a no-follow
descriptor, fsyncs the parent, proves absence, and only then stores legacy_remote_deleted_at.
Absence proof also requires an owner-pinned SHA-256 for the mode-private
.nexus-invoice-root-id marker created on the quiesced original root. The root,
traversed parents, marker, and invoice files must all be owner-only mode-private.
  --reconcile-manifests processes one bounded inventory phase. Re-run the same --manifest-kind with
  the reported next cursor until it is null, then continue filings -> objects -> queue. Queue first
  scans ownership rows and then filesystem entries under opaque rows:/files: cursors. Canonical
  object keys and exact queue rows receive ownership manifests with --apply; unsafe, ownerless, or
cross-scope files keep readiness blocked. Directories and unsafe entries consume the same --limit
budget as files, so a cursor may name any of those work items.
`);
}

function resolveDbPath(): string {
  return argValue('--db') || config.app.databasePath;
}

function resolveLegacyRoot(): string | null {
  const explicit = argValue('--legacy-root') || process.env.INVOICE_LEGACY_REMOTE_MOUNT;
  return explicit ? path.resolve(explicit) : null;
}

function parseLimit(): number {
  const raw = argValue('--limit');
  if (!raw) return 500;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_BACKFILL_PAGE_LIMIT) {
    throw new Error(`--limit must be between 1 and ${MAX_BACKFILL_PAGE_LIMIT}`);
  }
  return parsed;
}

function verifyLegacyRootMarker(
  root: string,
  expectedSha256: string,
  rootIdentity: fs.Stats,
): void {
  if (!/^[0-9a-f]{64}$/.test(expectedSha256)) {
    throw new Error('--legacy-root-marker-sha256 must be an exact SHA-256 digest');
  }
  const markerPath = path.join(root, '.nexus-invoice-root-id');
  const marker = readLegacyMountedFile(markerPath, root, rootIdentity, true);
  const actual = crypto.createHash('sha256').update(marker).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expectedSha256, 'hex'))) {
    throw new Error('Legacy invoice mount identity marker does not match');
  }
}

function guessMime(filename: string): string {
  const ext = filename.toLowerCase().split('.').pop() || '';
  if (ext === 'pdf') return 'application/pdf';
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'xml') return 'application/xml';
  if (ext === 'p7m') return 'application/pkcs7-mime';
  if (ext === 'zip') return 'application/zip';
  return 'application/octet-stream';
}

function legacyFilePath(row: LegacyFilingRow, legacyRoot: string | null): string | null {
  if (!row.remote_path || !legacyRoot) return null;
  const configuredRemoteRoot = path.posix.normalize(config.invoices.remotePath.trim());
  const remotePath = path.posix.normalize(row.remote_path.trim());
  if (!configuredRemoteRoot.startsWith('/') || remotePath === configuredRemoteRoot
      || !remotePath.startsWith(`${configuredRemoteRoot}/`)) return null;
  const relative = remotePath.slice(configuredRemoteRoot.length).replace(/^\/+/, '');
  const candidate = path.resolve(legacyRoot, ...relative.split('/'));
  return candidate.startsWith(`${legacyRoot}${path.sep}`) ? candidate : null;
}

function safeErrorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (typeof code === 'string' && /^[A-Z0-9_]+$/.test(code)) return code;
  return error instanceof Error ? error.name : typeof error;
}

function secureLegacyRoot(root: string): string {
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Legacy invoice mount must be a real directory');
  }
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
  if ((currentUid !== null && stat.uid !== currentUid) || (stat.mode & 0o077) !== 0) {
    throw new Error('Legacy invoice mount ownership or privacy permissions are unsafe');
  }
  const canonical = fs.realpathSync(root);
  if (canonical !== path.resolve(root)) {
    throw new Error('Legacy invoice mount cannot traverse symbolic links');
  }
  return canonical;
}

interface PlannedLegacyDirectory {
  namespacePath: string;
  identity: fs.Stats;
}

function secureLegacyParent(
  candidate: string,
  canonicalRoot: string,
  expectedRootIdentity?: fs.Stats,
): { parent: string; directories: PlannedLegacyDirectory[] } {
  const parent = path.dirname(candidate);
  if ((parent !== canonicalRoot && !parent.startsWith(`${canonicalRoot}${path.sep}`))
      || fs.realpathSync(parent) !== parent) {
    throw new Error('Legacy invoice parent is outside the canonical mount');
  }
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
  const directories: PlannedLegacyDirectory[] = [];
  let current = canonicalRoot;
  for (const part of ['', ...path.relative(canonicalRoot, parent).split(path.sep).filter(Boolean)]) {
    if (part) current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()
        || (currentUid !== null && stat.uid !== currentUid)
        || (stat.mode & 0o077) !== 0) {
      throw new Error('Legacy invoice parent ownership or privacy permissions are unsafe');
    }
    if (current === canonicalRoot && expectedRootIdentity
        && (stat.dev !== expectedRootIdentity.dev || stat.ino !== expectedRootIdentity.ino)) {
      throw new Error('Legacy invoice mount identity changed');
    }
    directories.push({ namespacePath: current, identity: stat });
  }
  return { parent, directories };
}

interface BoundLegacyDirectory extends PlannedLegacyDirectory {
  descriptor: number;
}

interface BoundLegacyParent {
  directories: BoundLegacyDirectory[];
  parentDescriptor: number;
  operationPath: string;
}

function assertBoundLegacyDirectory(binding: BoundLegacyDirectory): void {
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
  const opened = fs.fstatSync(binding.descriptor);
  const named = fs.lstatSync(binding.namespacePath);
  if (!opened.isDirectory() || !named.isDirectory() || named.isSymbolicLink()
      || opened.dev !== binding.identity.dev || opened.ino !== binding.identity.ino
      || named.dev !== binding.identity.dev || named.ino !== binding.identity.ino
      || (currentUid !== null && (opened.uid !== currentUid || named.uid !== currentUid))
      || (opened.mode & 0o077) !== 0 || (named.mode & 0o077) !== 0) {
    throw new Error('Legacy invoice directory authority changed');
  }
  const descriptorStat = fs.statSync(`/proc/self/fd/${binding.descriptor}`);
  if (descriptorStat.dev !== binding.identity.dev || descriptorStat.ino !== binding.identity.ino) {
    throw new Error('Legacy invoice descriptor path disagrees');
  }
}

function assertBoundLegacyParent(binding: BoundLegacyParent): void {
  for (const directory of binding.directories) assertBoundLegacyDirectory(directory);
}

function openBoundLegacyParent(
  candidate: string,
  canonicalRoot: string,
  expectedRootIdentity?: fs.Stats,
): BoundLegacyParent {
  if (process.platform !== 'linux') {
    throw new Error('Legacy invoice maintenance requires Linux descriptor-relative filesystem support');
  }
  const plan = secureLegacyParent(candidate, canonicalRoot, expectedRootIdentity);
  const noFollow = fs.constants.O_NOFOLLOW;
  const directory = fs.constants.O_DIRECTORY;
  if (typeof noFollow !== 'number' || typeof directory !== 'number') {
    throw new Error('Legacy invoice maintenance requires no-follow directory support');
  }
  const flags = fs.constants.O_RDONLY | noFollow | directory;
  const directories: BoundLegacyDirectory[] = [];
  try {
    let descriptor: number | null = null;
    for (const planned of plan.directories) {
      const operationPath = descriptor === null
        ? planned.namespacePath
        : `/proc/self/fd/${descriptor}/${path.basename(planned.namespacePath)}`;
      const childDescriptor = fs.openSync(operationPath, flags);
      const child = { ...planned, descriptor: childDescriptor };
      directories.push(child);
      if (directories.length > 1) {
        assertBoundLegacyDirectory(directories[directories.length - 2]);
      }
      assertBoundLegacyDirectory(child);
      descriptor = childDescriptor;
    }
    const parentDirectory = directories[directories.length - 1];
    if (!parentDirectory || parentDirectory.namespacePath !== plan.parent) {
      throw new Error('Legacy invoice parent descriptor is unavailable');
    }
    assertBoundLegacyParent({
      directories,
      parentDescriptor: parentDirectory.descriptor,
      operationPath: '',
    });
    return {
      directories,
      parentDescriptor: parentDirectory.descriptor,
      operationPath: `/proc/self/fd/${parentDirectory.descriptor}/${path.basename(candidate)}`,
    };
  } catch (error) {
    for (const directory of [...directories].reverse()) fs.closeSync(directory.descriptor);
    throw error;
  }
}

function closeBoundLegacyParent(binding: BoundLegacyParent): void {
  for (const directory of [...binding.directories].reverse()) fs.closeSync(directory.descriptor);
}

function readLegacyMountedFile(
  candidate: string,
  canonicalRoot: string,
  expectedRootIdentity?: fs.Stats,
  requirePrivateMode = true,
): Buffer {
  const binding = openBoundLegacyParent(candidate, canonicalRoot, expectedRootIdentity);
  const noFollow = fs.constants.O_NOFOLLOW;
  let descriptor: number | null = null;
  try {
    if (typeof noFollow !== 'number') throw new Error('Legacy backfill requires no-follow support');
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(binding.operationPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        assertBoundLegacyParent(binding);
        throw Object.assign(new Error('Legacy invoice artifact is absent'), {
          code: 'LEGACY_TARGET_MISSING',
        });
      }
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      throw new Error('Legacy invoice artifact is not a single-link regular file');
    }
    if (requirePrivateMode && (stat.mode & 0o077) !== 0) {
      throw new Error('Legacy invoice artifact permissions are not private');
    }
    const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (currentUid !== null && stat.uid !== currentUid) {
      throw new Error('Legacy invoice artifact is not owned by the maintenance user');
    }
    descriptor = fs.openSync(binding.operationPath, fs.constants.O_RDONLY | noFollow);
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.nlink !== 1
        || (requirePrivateMode && (opened.mode & 0o077) !== 0)
        || opened.dev !== stat.dev || opened.ino !== stat.ino) {
      throw new Error('Legacy invoice artifact changed during backfill read');
    }
    const buffer = fs.readFileSync(descriptor);
    assertBoundLegacyParent(binding);
    return buffer;
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
    closeBoundLegacyParent(binding);
  }
}

function deleteLegacyMountedFile(
  candidate: string,
  canonicalRoot: string,
  expectedChecksum: string,
  expectedRootIdentity?: fs.Stats,
): { deleted: boolean; alreadyMissing: boolean } {
  const binding = openBoundLegacyParent(candidate, canonicalRoot, expectedRootIdentity);
  let descriptor: number | null = null;
  try {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(binding.operationPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        assertBoundLegacyParent(binding);
        return { deleted: false, alreadyMissing: true };
      }
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      throw new Error('Legacy invoice artifact is not a single-link regular file');
    }
    if ((stat.mode & 0o077) !== 0) {
      throw new Error('Legacy invoice artifact permissions are not private');
    }
    const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (currentUid !== null && stat.uid !== currentUid) {
      throw new Error('Legacy invoice artifact is not owned by the maintenance user');
    }
    const noFollow = fs.constants.O_NOFOLLOW;
    if (typeof noFollow !== 'number') throw new Error('Legacy cleanup requires no-follow support');
    descriptor = fs.openSync(binding.operationPath, fs.constants.O_RDONLY | noFollow);
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.nlink !== 1 || (opened.mode & 0o077) !== 0
        || opened.dev !== stat.dev || opened.ino !== stat.ino) {
      throw new Error('Legacy invoice artifact changed during verification');
    }
    const digest = crypto.createHash('sha256').update(fs.readFileSync(descriptor)).digest('hex');
    if (digest !== expectedChecksum) throw new Error('Legacy invoice checksum does not match its backfill');
    const current = fs.lstatSync(binding.operationPath);
    if (current.dev !== opened.dev || current.ino !== opened.ino || current.nlink !== 1) {
      throw new Error('Legacy invoice artifact changed before deletion');
    }
    fs.unlinkSync(binding.operationPath);
    fs.fsyncSync(binding.parentDescriptor);
    assertBoundLegacyParent(binding);
    if (pathExists(binding.operationPath)) {
      throw new Error('Legacy invoice absence could not be proven');
    }
    assertBoundLegacyParent(binding);
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
    closeBoundLegacyParent(binding);
  }
  return { deleted: true, alreadyMissing: false };
}

function pathExists(targetPath: string): boolean {
  try {
    fs.lstatSync(targetPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function resolveQueueSpoolPath(localPath: string, queueRoot: string): string | null {
  if (!localPath || localPath !== localPath.trim() || localPath.includes('\0')
      || localPath.includes('\\')) return null;
  // Match the runtime's path authority exactly: legacy relative locators are
  // resolved from the service working directory, then constrained to the one
  // canonical queue parent before any descriptor-relative read.
  const candidate = path.resolve(localPath);
  if (path.dirname(candidate) !== queueRoot) return null;
  return candidate;
}

function markLegacyFilingMissing(db: Database.Database, row: LegacyFilingRow): boolean {
  return db.transaction(() => {
    const user = db.prepare('SELECT status FROM users WHERE id = ?').get(row.user_id) as {
      status: string;
    } | undefined;
    const fenced = db.prepare(`SELECT 1 AS present
      FROM local_inference_account_deletion_fences
      WHERE user_id = ? AND expires_at > ?`).get(row.user_id, Date.now());
    if (user?.status !== 'active' || fenced) {
      throw new Error('Legacy filing absence update is blocked by account deletion');
    }
    return db.prepare(`UPDATE invoice_filings
      SET status = 'orphaned',
          error_message = COALESCE(error_message, 'Legacy remote invoice file missing during object storage backfill')
      WHERE id = ? AND tenant_id = ? AND user_id = ?
        AND remote_path IS ? AND object_key IS NULL AND status = 'filed'`)
      .run(row.id, row.tenant_id, row.user_id, row.remote_path).changes === 1;
  }).immediate();
}

function deleteLegacyFilingAndStoreProof(input: {
  db: Database.Database;
  row: LegacyFilingRow;
  candidate: string;
  canonicalLegacyRoot: string;
  canonicalLegacyRootIdentity: fs.Stats;
  expectedChecksum: string;
  timestamp: string;
}): { deleted: boolean; alreadyMissing: boolean } {
  return input.db.transaction(() => {
    const user = input.db.prepare('SELECT status FROM users WHERE id = ?')
      .get(input.row.user_id) as { status: string } | undefined;
    const fenced = input.db.prepare(`SELECT 1 AS present
      FROM local_inference_account_deletion_fences
      WHERE user_id = ? AND expires_at > ?`).get(input.row.user_id, Date.now());
    if (user?.status !== 'active' || fenced) {
      throw new Error('Legacy filing deletion is blocked by account deletion');
    }
    const current = input.db.prepare(`SELECT 1 AS present FROM invoice_filings
      WHERE id = ? AND user_id = ? AND tenant_id = ?
        AND remote_path IS ? AND object_key IS ? AND checksum IS ?
        AND storage_backend IS ? AND legacy_remote_deleted_at IS NULL`)
      .get(
        input.row.id,
        input.row.user_id,
        input.row.tenant_id,
        input.row.remote_path,
        input.row.object_key,
        input.row.checksum,
        input.row.storage_backend,
      ) as { present: number } | undefined;
    if (current?.present !== 1) {
      throw new Error('Legacy deletion proof row identity changed');
    }
    const outcome = deleteLegacyMountedFile(
      input.candidate,
      input.canonicalLegacyRoot,
      input.expectedChecksum,
      input.canonicalLegacyRootIdentity,
    );
    const proof = input.db.prepare(`UPDATE invoice_filings
      SET legacy_remote_deleted_at = ?
      WHERE id = ? AND user_id = ? AND tenant_id = ?
        AND remote_path IS ? AND object_key IS ? AND checksum IS ?
        AND storage_backend IS ? AND legacy_remote_deleted_at IS NULL`)
      .run(
        input.timestamp,
        input.row.id,
        input.row.user_id,
        input.row.tenant_id,
        input.row.remote_path,
        input.row.object_key,
        input.row.checksum,
        input.row.storage_backend,
      );
    if (proof.changes !== 1) throw new Error('Legacy deletion proof row identity changed');
    return outcome;
  }).immediate();
}

const BACKFILL_ENUMERATION_BUDGET_MULTIPLIER = 4;
const BACKFILL_MAX_DIRECTORY_DEPTH = 128;

function readBoundedDirectoryEntries(
  directory: string,
  limit: number,
  enumeration: { remaining: number },
): fs.Dirent[] {
  const handle = fs.opendirSync(directory);
  const entries: fs.Dirent[] = [];
  try {
    while (entries.length <= limit) {
      const entry = handle.readSync();
      if (!entry) return entries;
      if (enumeration.remaining < 1) {
        throw Object.assign(
          new Error('Invoice artifact page exceeds the admitted enumeration budget'),
          { code: 'BACKFILL_PAGE_ENUMERATION_BUDGET_EXCEEDED' },
        );
      }
      enumeration.remaining -= 1;
      entries.push(entry);
    }
    throw Object.assign(
      new Error('Invoice artifact directory exceeds the admitted bounded fanout'),
      { code: 'BACKFILL_DIRECTORY_FANOUT_EXCEEDED' },
    );
  } finally {
    try {
      handle.closeSync();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ERR_DIR_CLOSED') throw error;
    }
  }
}

function walkArtifactFiles(
  root: string,
  after: string,
  limit: number,
): { files: string[]; unsafeEntries: number; hasMore: boolean; nextAfter: string | null } {
  if (!pathExists(root)) {
    return { files: [], unsafeEntries: 0, hasMore: false, nextAfter: null };
  }
  const canonicalRoot = secureLegacyRoot(root);
  const files: string[] = [];
  let unsafeEntries = 0;
  let hasMore = false;
  let workItems = 0;
  let nextAfter: string | null = null;
  const enumeration = { remaining: limit * BACKFILL_ENUMERATION_BUDGET_MULTIPLIER };
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
  const visit = (directory: string, depth: number): void => {
    if (hasMore) return;
    if (depth > BACKFILL_MAX_DIRECTORY_DEPTH) {
      throw Object.assign(
        new Error('Invoice artifact directory exceeds the admitted traversal depth'),
        { code: 'BACKFILL_DIRECTORY_DEPTH_EXCEEDED' },
      );
    }
    const directoryStat = fs.lstatSync(directory);
    if (fs.realpathSync(directory) !== directory
        || !directoryStat.isDirectory() || directoryStat.isSymbolicLink()
        || (currentUid !== null && directoryStat.uid !== currentUid)) {
      unsafeEntries += 1;
      return;
    }
    if ((directoryStat.mode & 0o077) !== 0) {
      unsafeEntries += 1;
      return;
    }
    const entries = readBoundedDirectoryEntries(directory, limit, enumeration)
      .map((entry) => ({
        entry,
        // A directory's slash is part of its traversal key. Sorting this key
        // before descent makes recursive visitation match full relative-path
        // lexical order (for example, `a.txt` precedes `a/z.pdf`).
        orderKey: `${entry.name}${entry.isDirectory() ? '/' : ''}`,
      }))
      .sort((left, right) => (
        left.orderKey < right.orderKey ? -1 : left.orderKey > right.orderKey ? 1 : 0
      ));
    for (const { entry } of entries) {
      if (hasMore) return;
      const candidate = path.join(directory, entry.name);
      const relativeBase = path.relative(canonicalRoot, candidate).split(path.sep).join('/');
      const directoryKey = `${relativeBase}/`;
      const hintedKey = entry.isDirectory() ? directoryKey : relativeBase;

      if (hintedKey <= after) {
        // Only the ancestor containing the cursor can still contain later
        // descendants. Entire earlier directory subtrees are safely pruned.
        if (entry.isDirectory() && after.startsWith(directoryKey)) visit(candidate, depth + 1);
        continue;
      }
      if (workItems >= limit) {
        hasMore = true;
        return;
      }

      const stat = fs.lstatSync(candidate);
      const relative = stat.isDirectory() ? directoryKey : relativeBase;
      workItems += 1;
      nextAfter = relative;
      if ((stat.isDirectory() !== entry.isDirectory()) || relative <= after) {
        unsafeEntries += 1;
        continue;
      }
      if (stat.isSymbolicLink()) {
        unsafeEntries += 1;
      } else if (stat.isDirectory()) {
        visit(candidate, depth + 1);
      } else if (stat.isFile() && stat.nlink === 1
          && (currentUid === null || stat.uid === currentUid)) {
        if ((stat.mode & 0o077) !== 0) {
          unsafeEntries += 1;
          continue;
        }
        files.push(candidate);
      } else {
        unsafeEntries += 1;
      }
    }
  };
  visit(canonicalRoot, 0);
  return { files, unsafeEntries, hasMore, nextAfter };
}

export function reconcileArtifactManifests(input: {
  db: Database.Database;
  dbPath: string;
  apply: boolean;
  kind: 'filings' | 'objects' | 'queue';
  after: string;
  limit: number;
}): {
  scanned: number;
  needed: number;
  created: number;
  unresolved: number;
  nextAfter: string | null;
} {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1
      || input.limit > MAX_BACKFILL_PAGE_LIMIT) {
    throw new Error(`manifest reconciliation limit must be between 1 and ${MAX_BACKFILL_PAGE_LIMIT}`);
  }
  const manifestAvailable = input.db.prepare(`SELECT 1 FROM sqlite_master
    WHERE type = 'table' AND name = 'invoice_artifact_manifests'`).get();
  if (!manifestAvailable) throw new Error('Invoice artifact manifest migration is required');
  const objectRoot = path.resolve(process.cwd(), config.invoiceObjectStorage.filesystemDir);
  const queueRoot = path.resolve(path.dirname(input.dbPath), 'invoice-queue');
  let needed = 0;
  let created = 0;
  let unresolved = 0;
  let scanned = 0;
  let nextAfter: string | null = null;
  const userState = input.db.prepare('SELECT status FROM users WHERE id = ?');
  const activeDeletionFence = input.db.prepare(`SELECT 1 AS present
    FROM local_inference_account_deletion_fences WHERE user_id = ? AND expires_at > ?`);
  const existingManifest = input.db.prepare(`SELECT tenant_id, user_id, artifact_kind, state,
      deleted_at
    FROM invoice_artifact_manifests WHERE artifact_locator = ?`);
  const insertManifest = input.db.prepare(`INSERT INTO invoice_artifact_manifests (
      tenant_id, user_id, artifact_kind, artifact_locator, storage_backend,
      state, write_token, write_lease_expires_at, created_at, updated_at, stored_at
    ) VALUES (?, ?, ?, ?, 'filesystem', 'stored', ?, 0, ?, ?, ?)`);
  const reconcile = (
    tenantId: number,
    userId: number,
    kind: 'queue_spool' | 'stored_object',
    locator: string,
  ): void => {
    const user = Number.isSafeInteger(userId) && userId > 0
      ? userState.get(userId) as { status: string } | undefined
      : undefined;
    if (!Number.isSafeInteger(tenantId) || tenantId <= 0
        || !Number.isSafeInteger(userId) || userId <= 0
        || user?.status !== 'active'
        || activeDeletionFence.get(userId, Date.now())) {
      unresolved += 1;
      return;
    }
    const existing = existingManifest.get(locator) as {
      tenant_id: number; user_id: number; artifact_kind: string;
      state: string; deleted_at: string | null;
    } | undefined;
    if (existing) {
      if (existing.tenant_id !== tenantId || existing.user_id !== userId
          || existing.artifact_kind !== kind || existing.state !== 'stored'
          || existing.deleted_at !== null) unresolved += 1;
      return;
    }
    needed += 1;
    if (!input.apply) return;
    try {
      const inserted = input.db.transaction(() => {
        const lockedUser = userState.get(userId) as { status: string } | undefined;
        if (lockedUser?.status !== 'active'
            || activeDeletionFence.get(userId, Date.now())) {
          throw new Error('Manifest reconciliation is blocked by account deletion');
        }
        const current = existingManifest.get(locator) as {
          tenant_id: number; user_id: number; artifact_kind: string;
          state: string; deleted_at: string | null;
        } | undefined;
        if (current) {
          if (current.tenant_id !== tenantId || current.user_id !== userId
              || current.artifact_kind !== kind || current.state !== 'stored'
              || current.deleted_at !== null) {
            throw new Error('Manifest reconciliation ownership changed');
          }
          return false;
        }
        const timestamp = new Date().toISOString();
        insertManifest.run(
          tenantId,
          userId,
          kind,
          locator,
          crypto.randomUUID(),
          timestamp,
          timestamp,
          timestamp,
        );
        return true;
      }).immediate();
      if (inserted) created += 1;
    } catch {
      unresolved += 1;
    }
  };

  if (input.kind === 'filings') {
    const afterId = input.after ? Number(input.after) : 0;
    if (!Number.isSafeInteger(afterId) || afterId < 0) {
      throw new Error('--manifest-after must be a nonnegative filing id');
    }
    const rows = input.db.prepare(`SELECT id, tenant_id, user_id, object_key, storage_backend
      FROM invoice_filings
      WHERE id > ? AND object_key IS NOT NULL AND TRIM(object_key) <> ''
      ORDER BY id ASC LIMIT ?`).all(afterId, input.limit + 1) as Array<{
        id: number; tenant_id: number; user_id: number;
        object_key: string; storage_backend: string | null;
      }>;
    const batch = rows.slice(0, input.limit);
    scanned = batch.length;
    const canonicalObjectRoot = pathExists(objectRoot) ? secureLegacyRoot(objectRoot) : null;
    const objectRootIdentity = canonicalObjectRoot ? fs.lstatSync(canonicalObjectRoot) : null;
    for (const row of batch) {
      const parts = row.object_key.split('/');
      const candidate = path.resolve(objectRoot, row.object_key);
      if (parts[0] !== 'invoices' || Number(parts[1]) !== row.tenant_id
          || Number(parts[2]) !== row.user_id || row.storage_backend !== 'filesystem'
          || !canonicalObjectRoot || !objectRootIdentity
          || !candidate.startsWith(`${objectRoot}${path.sep}`) || !pathExists(candidate)) {
        unresolved += 1;
        continue;
      }
      try {
        readLegacyMountedFile(candidate, canonicalObjectRoot, objectRootIdentity);
      } catch {
        unresolved += 1;
        continue;
      }
      reconcile(row.tenant_id, row.user_id, 'stored_object', row.object_key);
    }
    if (rows.length > input.limit) nextAfter = String(batch[batch.length - 1].id);
  } else if (input.kind === 'objects') {
    const root = objectRoot;
    if (input.after && (path.isAbsolute(input.after)
        || input.after.split('/').some((part) => part === '..'))) {
      throw new Error('--manifest-after must be a safe relative artifact cursor');
    }
    const inventory = walkArtifactFiles(root, input.after, input.limit);
    unresolved += inventory.unsafeEntries;
    scanned = inventory.files.length;
    const canonicalRoot = pathExists(root) ? secureLegacyRoot(root) : null;
    const rootIdentity = canonicalRoot ? fs.lstatSync(canonicalRoot) : null;
    for (const filename of inventory.files) {
      const relative = path.relative(root, filename).split(path.sep).join('/');
      const parts = relative.split('/');
      const owners = input.db.prepare(`SELECT tenant_id, user_id, storage_backend
        FROM invoice_filings WHERE object_key = ?`).all(relative) as Array<{
          tenant_id: number; user_id: number; storage_backend: string | null;
        }>;
      if (!canonicalRoot || !rootIdentity || parts[0] !== 'invoices' || owners.length !== 1
          || Number(parts[1]) !== owners[0].tenant_id
          || Number(parts[2]) !== owners[0].user_id
          || owners[0].storage_backend !== 'filesystem') {
        unresolved += 1;
        continue;
      }
      try {
        readLegacyMountedFile(filename, canonicalRoot, rootIdentity);
      } catch {
        unresolved += 1;
        continue;
      }
      reconcile(owners[0].tenant_id, owners[0].user_id, 'stored_object', relative);
    }
    if (inventory.hasMore) nextAfter = inventory.nextAfter;
  } else {
    const rowCursorMatch = input.after === '' || /^rows:[0-9]+$/.test(input.after);
    const fileCursorMatch = /^files:(.*)$/.exec(input.after);
    if (!rowCursorMatch && !fileCursorMatch) {
      throw new Error('--manifest-after must be a queue rows:<id> or files:<path> cursor');
    }
    const canonicalRoot = pathExists(queueRoot) ? secureLegacyRoot(queueRoot) : null;
    const rootIdentity = canonicalRoot ? fs.lstatSync(canonicalRoot) : null;
    if (rowCursorMatch) {
      const afterId = input.after ? Number(input.after.slice('rows:'.length)) : 0;
      if (!Number.isSafeInteger(afterId) || afterId < 0) {
        throw new Error('--manifest-after queue row id must be nonnegative');
      }
      const rows = input.db.prepare(`SELECT id, tenant_id, user_id, local_path
        FROM invoice_queue
        WHERE id > ? AND local_path IS NOT NULL AND TRIM(local_path) <> ''
          AND local_file_deleted_at IS NULL
        ORDER BY id ASC LIMIT ?`).all(afterId, input.limit + 1) as Array<{
          id: number; tenant_id: number; user_id: number; local_path: string;
        }>;
      const batch = rows.slice(0, input.limit);
      scanned = batch.length;
      for (const row of batch) {
        const candidate = resolveQueueSpoolPath(row.local_path, queueRoot);
        if (!candidate || !canonicalRoot || !rootIdentity || path.dirname(candidate) !== canonicalRoot) {
          unresolved += 1;
          continue;
        }
        try {
          readLegacyMountedFile(candidate, canonicalRoot, rootIdentity);
        } catch {
          unresolved += 1;
          continue;
        }
        reconcile(row.tenant_id, row.user_id, 'queue_spool', row.local_path);
      }
      nextAfter = rows.length > input.limit
        ? `rows:${batch[batch.length - 1].id}`
        : 'files:';
    } else {
      const fileAfter = fileCursorMatch?.[1] ?? '';
      if (path.isAbsolute(fileAfter) || fileAfter.split('/').some((part) => part === '..')) {
        throw new Error('--manifest-after queue file cursor must be a safe relative path');
      }
      const inventory = walkArtifactFiles(queueRoot, fileAfter, input.limit);
      unresolved += inventory.unsafeEntries;
      scanned = inventory.files.length;
      for (const filename of inventory.files) {
        if (!canonicalRoot || !rootIdentity) {
          unresolved += 1;
          continue;
        }
        try {
          readLegacyMountedFile(filename, canonicalRoot, rootIdentity);
        } catch {
          unresolved += 1;
          continue;
        }
        const basename = path.basename(filename);
        const suffix = `/${basename}`;
        const rows = input.db.prepare(`SELECT tenant_id, user_id, local_path, local_file_deleted_at
          FROM invoice_queue
          WHERE local_path = ? OR substr(local_path, -?) = ?`)
          .all(filename, suffix.length, suffix) as Array<{
            tenant_id: number; user_id: number; local_path: string;
            local_file_deleted_at: string | null;
          }>;
        const exactRows = rows.filter((row) => resolveQueueSpoolPath(row.local_path, queueRoot) === filename);
        if (exactRows.length !== 1 || exactRows[0].local_file_deleted_at !== null) {
          unresolved += 1;
          continue;
        }
        reconcile(
          exactRows[0].tenant_id,
          exactRows[0].user_id,
          'queue_spool',
          exactRows[0].local_path,
        );
      }
      if (inventory.hasMore && inventory.nextAfter !== null) {
        nextAfter = `files:${inventory.nextAfter}`;
      }
    }
  }
  return {
    scanned,
    needed,
    created,
    unresolved,
    nextAfter,
  };
}

async function putOrAdoptBackfilledObject(input: {
  db: Database.Database;
  buffer: Buffer;
  objectKey: string;
  mime: string;
  tenantId: number;
  userId: number;
}): Promise<StoredInvoiceObject> {
  const checksum = crypto.createHash('sha256').update(input.buffer).digest('hex');
  const existing = input.db.prepare(`SELECT id, tenant_id, user_id, artifact_kind,
      storage_backend, state, write_token, write_lease_expires_at, deleted_at
    FROM invoice_artifact_manifests
    WHERE artifact_kind = 'stored_object' AND artifact_locator = ?`).get(input.objectKey) as {
      id: number;
      tenant_id: number;
      user_id: number;
      artifact_kind: string;
      storage_backend: string;
      state: string;
      write_token: string;
      write_lease_expires_at: number;
      deleted_at: string | null;
    } | undefined;
  if (!existing) {
    return putInvoiceObject(input.buffer, input.objectKey, input.mime, { db: input.db });
  }
  if (existing.tenant_id !== input.tenantId || existing.user_id !== input.userId
      || existing.artifact_kind !== 'stored_object' || existing.storage_backend !== 'filesystem') {
    throw new Error('Existing backfill manifest ownership does not match');
  }
  try {
    const storedBuffer = await verifyInvoiceObjectChecksum(input.objectKey, checksum, 'filesystem');
    if (existing.state === 'stored' && existing.deleted_at === null) {
      return {
        objectKey: input.objectKey,
        checksum,
        mime: input.mime,
        bytes: storedBuffer.length,
        storageBackend: 'filesystem',
      };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  if (existing.state === 'deleting'
      || (existing.state === 'writing' && existing.write_lease_expires_at > Date.now())) {
    throw new Error('Existing backfill manifest is actively owned');
  }
  const replacementToken = crypto.randomUUID();
  const replacementLease = Date.now() + 5 * 60_000;
  const claimed = input.db.transaction(() => {
    const user = input.db.prepare(`SELECT status FROM users WHERE id = ?`).get(input.userId) as {
      status: string;
    } | undefined;
    const fenced = input.db.prepare(`SELECT 1 AS present
      FROM local_inference_account_deletion_fences
      WHERE user_id = ? AND expires_at > ?`).get(input.userId, Date.now());
    if (user?.status !== 'active' || fenced) {
      throw new Error('Backfill replacement is blocked by account deletion');
    }
    return input.db.prepare(`UPDATE invoice_artifact_manifests
      SET state = 'writing', write_token = ?, write_lease_expires_at = ?,
          deleted_at = NULL, updated_at = ?
      WHERE id = ? AND tenant_id = ? AND user_id = ?
        AND artifact_kind = 'stored_object' AND artifact_locator = ?
        AND state <> 'deleting'
        AND (state <> 'writing' OR write_lease_expires_at <= ?)`)
      .run(
        replacementToken,
        replacementLease,
        new Date().toISOString(),
        existing.id,
        input.tenantId,
        input.userId,
        input.objectKey,
        Date.now(),
      ).changes;
  }).immediate();
  if (claimed !== 1) throw new Error('Existing backfill manifest replacement claim failed');

  // A verified matching file in a non-stored crash state is rebuilt from the
  // still-mounted legacy source. Deletion uses descriptor/inode checks and
  // fsyncs the parent; a mismatch or unsafe file has already failed above.
  await deleteInvoiceObject(input.objectKey, 'filesystem', {
    db: input.db,
    ownership: {
      manifestId: existing.id,
      tenantId: input.tenantId,
      userId: input.userId,
    },
    expectedWriteToken: replacementToken,
  });
  const removed = input.db.transaction(() => input.db.prepare(`DELETE FROM invoice_artifact_manifests
    WHERE id = ? AND state = 'deleted' AND deleted_at IS NOT NULL`).run(
    existing.id,
  ).changes).immediate();
  if (removed !== 1) throw new Error('Stale backfill manifest could not be retired');
  return putInvoiceObject(input.buffer, input.objectKey, input.mime, { db: input.db });
}

async function main(): Promise<void> {
  if (hasFlag('--help') || hasFlag('-h')) {
    printHelp();
    return;
  }
  if (!isInvoiceObjectStorageConfigured()) {
    throw new Error('Invoice object storage is not configured.');
  }

  const dbPath = resolveDbPath();
  const legacyRoot = resolveLegacyRoot();
  const apply = hasFlag('--apply');
  const deleteLegacy = hasFlag('--delete-legacy');
  const reconcileManifests = hasFlag('--reconcile-manifests');
  const manifestKindValue = argValue('--manifest-kind');
  const manifestKind = manifestKindValue === 'filings' || manifestKindValue === 'objects'
      || manifestKindValue === 'queue'
    ? manifestKindValue
    : null;
  const manifestAfter = argValue('--manifest-after') ?? '';
  const legacyRootMarkerSha256 = argValue('--legacy-root-marker-sha256');
  const asJson = hasFlag('--json');
  const limit = parseLimit();
  if (deleteLegacy && !apply) {
    throw new Error('--delete-legacy requires --apply');
  }
  if (deleteLegacy && !legacyRoot) {
    throw new Error('--delete-legacy requires an explicit mounted legacy root');
  }
  if (apply && legacyRoot && process.platform !== 'linux') {
    throw new Error('Legacy invoice apply mode requires Linux descriptor-relative filesystem support');
  }
  if (apply && legacyRoot && !legacyRootMarkerSha256) {
    throw new Error('legacy-root apply mode requires --legacy-root-marker-sha256');
  }
  if (reconcileManifests && !manifestKind) {
    throw new Error('--reconcile-manifests requires --manifest-kind filings, objects, or queue');
  }
  const canonicalLegacyRoot = legacyRoot ? secureLegacyRoot(legacyRoot) : null;
  const canonicalLegacyRootIdentity = canonicalLegacyRoot
    ? fs.lstatSync(canonicalLegacyRoot)
    : null;
  if (apply && canonicalLegacyRoot) {
    verifyLegacyRootMarker(
      canonicalLegacyRoot,
      legacyRootMarkerSha256!,
      canonicalLegacyRootIdentity!,
    );
  }
  const db = new Database(dbPath);

  const report = {
    database: dbPath,
    legacyRoot,
    apply,
    legacyRootVerified: apply && canonicalLegacyRoot !== null,
    scanned: 0,
    backfillRemaining: 0,
    migratable: 0,
    migrated: 0,
    missing: 0,
    orphaned: 0,
    legacyDeletionScanned: 0,
    legacyDeleted: 0,
    legacyAlreadyMissing: 0,
    legacyProofsStored: 0,
    legacyUnresolved: 0,
    legacyRemaining: 0,
    manifestFilesScanned: 0,
    manifestsNeeded: 0,
    manifestsCreated: 0,
    manifestUnresolved: 0,
    manifestKind,
    manifestNextAfter: null as string | null,
    errors: [] as Array<{ stage: string; code: string }>,
  };

  try {
    const rows = db.prepare(`
      SELECT id, tenant_id, user_id, vendor, document_date, filename, remote_path
        FROM invoice_filings
       WHERE status = 'filed'
         AND object_key IS NULL
         AND remote_path IS NOT NULL
         AND remote_path <> ''
       ORDER BY id ASC
       LIMIT ?
    `).all(limit) as LegacyFilingRow[];
    report.scanned = rows.length;

    for (const row of rows) {
      const filePath = legacyFilePath(row, canonicalLegacyRoot);
      if (!filePath) {
        report.missing += 1;
        report.errors.push({ stage: 'backfill-path', code: 'UNSAFE_LEGACY_MAPPING' });
        continue;
      }
      if (!apply && !pathExists(filePath)) {
        report.missing += 1;
        continue;
      }

      if (!apply) {
        report.migratable += 1;
        continue;
      }

      try {
        const filename = row.filename || path.basename(filePath);
        const buffer = readLegacyMountedFile(
          filePath,
          canonicalLegacyRoot!,
          canonicalLegacyRootIdentity!,
        );
        report.migratable += 1;
        const objectKey = buildInvoiceObjectKey({
          tenantId: row.tenant_id || row.user_id,
          userId: row.user_id,
          documentDate: row.document_date,
          filename,
        });
        const stored = await putOrAdoptBackfilledObject({
          db,
          buffer,
          objectKey,
          mime: guessMime(filename),
          tenantId: row.tenant_id || row.user_id,
          userId: row.user_id,
        });
        const updated = db.transaction(() => {
          const user = db.prepare('SELECT status FROM users WHERE id = ?').get(row.user_id) as {
            status: string;
          } | undefined;
          const fenced = db.prepare(`SELECT 1 AS present
            FROM local_inference_account_deletion_fences
            WHERE user_id = ? AND expires_at > ?`).get(row.user_id, Date.now());
          if (user?.status !== 'active' || fenced) {
            throw new Error('Legacy filing adoption is blocked by account deletion');
          }
          return db.prepare(`
            UPDATE invoice_filings
               SET object_key = ?,
                   checksum = ?,
                   mime = ?,
                   bytes = ?,
                   storage_backend = ?,
                   filename = COALESCE(filename, ?),
                   error_message = NULL
             WHERE id = ? AND tenant_id = ? AND user_id = ?
               AND remote_path IS ? AND object_key IS NULL
          `).run(
            stored.objectKey,
            stored.checksum,
            stored.mime,
            stored.bytes,
            stored.storageBackend,
            filename,
            row.id,
            row.tenant_id,
            row.user_id,
            row.remote_path,
          );
        }).immediate();
        if (updated.changes !== 1) {
          throw new Error('Legacy filing changed before exact backfill adoption');
        }
        report.migrated += 1;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'LEGACY_TARGET_MISSING') {
          report.missing += 1;
          try {
            if (markLegacyFilingMissing(db, row)) report.orphaned += 1;
            else report.errors.push({
              stage: 'backfill-missing-proof',
              code: 'ROW_IDENTITY_CHANGED',
            });
          } catch (proofError) {
            report.errors.push({
              stage: 'backfill-missing-proof',
              code: safeErrorCode(proofError),
            });
          }
          continue;
        }
        report.errors.push({
          stage: 'backfill',
          code: safeErrorCode(err),
        });
      }
    }

    if (deleteLegacy && canonicalLegacyRoot) {
      const legacyRows = db.prepare(`
        SELECT id, tenant_id, user_id, vendor, document_date, filename, remote_path,
               object_key, checksum, storage_backend
          FROM invoice_filings
         WHERE remote_path IS NOT NULL AND TRIM(remote_path) <> ''
           AND (object_key IS NULL OR TRIM(object_key) = '' OR remote_path <> object_key)
           AND legacy_remote_deleted_at IS NULL
         ORDER BY id ASC
         LIMIT ?
      `).all(limit) as LegacyFilingRow[];
      report.legacyDeletionScanned = legacyRows.length;
      for (const row of legacyRows) {
        try {
          const candidate = legacyFilePath(row, canonicalLegacyRoot);
          if (!candidate) {
            report.legacyUnresolved += 1;
            continue;
          }
          let expectedChecksum = '';
          if (row.object_key && row.storage_backend) {
            const objectBuffer = await verifyInvoiceObjectChecksum(
              row.object_key,
              row.checksum,
              row.storage_backend,
            );
            expectedChecksum = crypto.createHash('sha256').update(objectBuffer).digest('hex');
          }
          // With no adopted object, an empty checksum can only prove an
          // already-missing canonical target. A present legacy artifact can
          // never match and therefore cannot be deleted by this branch.
          const outcome = deleteLegacyFilingAndStoreProof({
            db,
            row,
            candidate,
            canonicalLegacyRoot,
            canonicalLegacyRootIdentity: canonicalLegacyRootIdentity!,
            expectedChecksum,
            timestamp: new Date().toISOString(),
          });
          report.legacyProofsStored += 1;
          if (outcome.deleted) report.legacyDeleted += 1;
          if (outcome.alreadyMissing) report.legacyAlreadyMissing += 1;
        } catch (err) {
          report.legacyUnresolved += 1;
          report.errors.push({ stage: 'legacy-delete', code: safeErrorCode(err) });
        }
      }
    }

    report.backfillRemaining = Number((db.prepare(`SELECT COUNT(*) AS count
      FROM invoice_filings
      WHERE status = 'filed' AND object_key IS NULL
        AND remote_path IS NOT NULL AND TRIM(remote_path) <> ''`).get() as { count: number }).count);
    if (deleteLegacy) {
      report.legacyRemaining = Number((db.prepare(`SELECT COUNT(*) AS count
        FROM invoice_filings
        WHERE remote_path IS NOT NULL AND TRIM(remote_path) <> ''
          AND (object_key IS NULL OR TRIM(object_key) = '' OR remote_path <> object_key)
          AND legacy_remote_deleted_at IS NULL`).get() as { count: number }).count);
    }

    if (reconcileManifests) {
      const manifestReport = reconcileArtifactManifests({
        db,
        dbPath,
        apply,
        kind: manifestKind!,
        after: manifestAfter,
        limit,
      });
      report.manifestFilesScanned = manifestReport.scanned;
      report.manifestsNeeded = manifestReport.needed;
      report.manifestsCreated = manifestReport.created;
      report.manifestUnresolved = manifestReport.unresolved;
      report.manifestNextAfter = manifestReport.nextAfter;
    }
  } finally {
    db.close();
  }

  if (report.backfillRemaining !== 0 || report.errors.some((row) => row.stage === 'backfill')) {
    process.exitCode = 2;
  }
  if (deleteLegacy && (report.legacyUnresolved !== 0 || report.legacyRemaining !== 0
      || report.errors.length !== 0)) {
    process.exitCode = 2;
  }
  if (reconcileManifests && (report.manifestUnresolved !== 0
      || report.manifestNextAfter !== null || (!apply && report.manifestsNeeded !== 0))) {
    process.exitCode = 2;
  }

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`Invoice object storage backfill ${apply ? 'APPLY' : 'DRY-RUN'}`);
  console.log(`- database: ${report.database}`);
  console.log(`- legacy root: ${report.legacyRoot || '(remote paths only)'}`);
  console.log(`- scanned: ${report.scanned}`);
  console.log(`- backfill remaining: ${report.backfillRemaining}`);
  console.log(`- migratable: ${report.migratable}`);
  console.log(`- migrated: ${report.migrated}`);
  console.log(`- missing legacy files: ${report.missing}`);
  console.log(`- marked orphaned: ${report.orphaned}`);
  console.log(`- legacy deletion scanned: ${report.legacyDeletionScanned}`);
  console.log(`- legacy deleted: ${report.legacyDeleted}`);
  console.log(`- legacy already missing: ${report.legacyAlreadyMissing}`);
  console.log(`- legacy proofs stored: ${report.legacyProofsStored}`);
  console.log(`- legacy unresolved: ${report.legacyUnresolved}`);
  console.log(`- legacy remaining: ${report.legacyRemaining}`);
  console.log(`- artifact files scanned: ${report.manifestFilesScanned}`);
  console.log(`- manifest phase: ${report.manifestKind || '(not requested)'}`);
  console.log(`- manifest next cursor: ${report.manifestNextAfter ?? '(complete)'}`);
  console.log(`- manifests needed: ${report.manifestsNeeded}`);
  console.log(`- manifests created: ${report.manifestsCreated}`);
  console.log(`- manifest unresolved: ${report.manifestUnresolved}`);
  console.log(`- errors: ${report.errors.length}`);
  if (!apply) {
    console.log('');
    console.log('Dry-run only. Re-run with --apply after reviewing output and taking a DB backup.');
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`invoice object storage backfill failed: ${safeErrorCode(err)}`);
    process.exitCode = 1;
  });
}
