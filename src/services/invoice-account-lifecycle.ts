// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { getDb } from './database';
import { deleteInvoiceObject } from './invoice-object-storage';
import { deleteInvoiceQueueSpoolFileForAccountDeletion } from './invoice-queue';
import { hasActiveInvoiceArtifactAdmissions } from './invoice-artifact-admission';

export { waitForInvoiceArtifactAdmissionsToDrain } from './invoice-artifact-admission';

type QueueArtifactRow = {
  id: number;
  tenant_id: number;
  user_id: number;
  local_path: string;
};

type FiledArtifactRow = {
  id: number;
  tenant_id: number | null;
  user_id: number;
  object_key: string | null;
  remote_path: string | null;
  storage_backend: string | null;
  legacy_remote_deleted_at: string | null;
};

type DeletionManifest = {
  id: number;
  tenant_id: number;
  user_id: number;
  storage_backend: string;
  state: string;
  deleted_at: string | null;
  deletion_device: string | null;
  deletion_inode: string | null;
  deletion_attempted_at: string | null;
};

type ManifestArtifactRow = {
  id: number;
  tenant_id: number;
  user_id: number;
  artifact_kind: 'queue_spool' | 'stored_object';
  artifact_locator: string;
  storage_backend: string;
  state: 'writing' | 'stored' | 'failed' | 'deleting';
  write_token: string;
  write_lease_expires_at: number;
};

function assertPositiveUserId(userId: number): void {
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    throw new Error('A positive account owner id is required for invoice artifact cleanup.');
  }
}

function tableExists(db: Database.Database, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function tableHasColumn(db: Database.Database, table: string, column: string): boolean {
  if (!tableExists(db, table)) return false;
  return (db.prepare(`PRAGMA table_info("${table.replace(/"/g, '""')}")`).all() as Array<{ name: string }>)
    .some((row) => row.name === column);
}

function pendingQueueArtifactCount(db: Database.Database, userId: number): number {
  if (!tableExists(db, 'invoice_queue')) return 0;
  const hasProofColumn = tableHasColumn(db, 'invoice_queue', 'local_file_deleted_at');
  const proofPredicate = hasProofColumn ? 'AND local_file_deleted_at IS NULL' : '';
  return (db.prepare(`SELECT COUNT(*) AS count FROM invoice_queue
    WHERE user_id = ? AND local_path IS NOT NULL AND TRIM(local_path) <> '' ${proofPredicate}`)
    .get(userId) as { count: number }).count;
}

function pendingFiledArtifactCount(db: Database.Database, userId: number): number {
  if (!tableExists(db, 'invoice_filings')) return 0;
  const hasProofColumn = tableHasColumn(db, 'invoice_filings', 'object_deleted_at');
  const proofPredicate = hasProofColumn ? 'AND object_deleted_at IS NULL' : '';
  return (db.prepare(`SELECT COUNT(*) AS count FROM invoice_filings
    WHERE user_id = ?
      AND COALESCE(NULLIF(TRIM(object_key), ''), NULLIF(TRIM(remote_path), '')) IS NOT NULL
      ${proofPredicate}`)
    .get(userId) as { count: number }).count;
}

function pendingManifestArtifactCount(db: Database.Database, userId: number): number {
  if (!tableExists(db, 'invoice_artifact_manifests')) return 0;
  return (db.prepare(`SELECT COUNT(*) AS count FROM invoice_artifact_manifests
    WHERE user_id = ? AND deleted_at IS NULL`).get(userId) as { count: number }).count;
}

function requireOrCreateAccountDeletionManifest(input: {
  db: Database.Database;
  tenantId: number;
  userId: number;
  kind: 'queue_spool' | 'stored_object';
  locator: string;
  storageBackend: string;
}): DeletionManifest {
  if (!Number.isSafeInteger(input.tenantId) || input.tenantId <= 0
      || !Number.isSafeInteger(input.userId) || input.userId <= 0
      || !input.locator.trim() || input.storageBackend !== 'filesystem') {
    throw new Error('Legacy invoice artifact ownership is not safely attributable.');
  }
  return input.db.transaction(() => {
    const existing = input.db.prepare(`SELECT id, tenant_id, user_id, storage_backend,
        state, deleted_at, deletion_device, deletion_inode, deletion_attempted_at
      FROM invoice_artifact_manifests
      WHERE artifact_kind = ? AND artifact_locator = ?`)
      .get(input.kind, input.locator) as DeletionManifest | undefined;
    if (!existing) {
      const timestamp = new Date().toISOString();
      input.db.prepare(`INSERT INTO invoice_artifact_manifests (
          tenant_id, user_id, artifact_kind, artifact_locator, storage_backend,
          state, write_token, write_lease_expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'filesystem', 'failed', ?, 0, ?, ?)`)
        .run(
          input.tenantId,
          input.userId,
          input.kind,
          input.locator,
          crypto.randomUUID(),
          timestamp,
          timestamp,
        );
    }
    const owned = input.db.prepare(`SELECT id, tenant_id, user_id, storage_backend,
        state, deleted_at, deletion_device, deletion_inode, deletion_attempted_at
      FROM invoice_artifact_manifests
      WHERE artifact_kind = ? AND artifact_locator = ?`)
      .get(input.kind, input.locator) as DeletionManifest | undefined;
    if (!owned || owned.tenant_id !== input.tenantId || owned.user_id !== input.userId
        || owned.storage_backend !== input.storageBackend
        || (owned.state === 'deleted' && owned.deleted_at === null)
        || (owned.state !== 'deleted' && owned.deleted_at !== null)) {
      throw new Error('Legacy invoice artifact manifest ownership does not match its row.');
    }
    return owned;
  }).immediate();
}

function assertDurableFilesystemDeletionProof(manifest: DeletionManifest): void {
  if (manifest.state !== 'deleted' || manifest.deleted_at === null
      || !manifest.deletion_device || !manifest.deletion_inode
      || !manifest.deletion_attempted_at) {
    throw new Error('Invoice artifact manifest lacks durable inode-deletion proof.');
  }
}

function assertStoredObjectKeyOwnership(
  objectKey: string,
  tenantId: number,
  userId: number,
): void {
  const parts = objectKey.split('/');
  if (parts[0] !== 'invoices' || Number(parts[1]) !== tenantId || Number(parts[2]) !== userId) {
    throw new Error('Stored invoice object key does not match its filing ownership.');
  }
}

export function assertInvoiceArtifactsDeletedForAccount(
  userId: number,
  db: Database.Database = getDb(),
): void {
  assertPositiveUserId(userId);
  const pendingQueueArtifacts = pendingQueueArtifactCount(db, userId);
  const pendingFiledArtifacts = pendingFiledArtifactCount(db, userId);
  const pendingManifestArtifacts = pendingManifestArtifactCount(db, userId);
  if (pendingQueueArtifacts !== 0 || pendingFiledArtifacts !== 0 || pendingManifestArtifacts !== 0) {
    throw new Error('Account deletion requires invoice artifact-deletion proof.');
  }
}

export async function cleanupInvoiceArtifactsForAccountDeletion(
  userId: number,
  db: Database.Database = getDb(),
): Promise<{ queueFilesDeleted: number; storedObjectsDeleted: number }> {
  assertPositiveUserId(userId);
  let queueFilesDeleted = 0;
  let storedObjectsDeleted = 0;

  if (!tableExists(db, 'invoice_artifact_manifests')) {
    if (pendingQueueArtifactCount(db, userId) !== 0 || pendingFiledArtifactCount(db, userId) !== 0) {
      throw new Error('Invoice artifact cleanup requires the ownership-manifest migration.');
    }
  } else {
    if (hasActiveInvoiceArtifactAdmissions(userId)) {
      throw new Error('Invoice artifact writes are still active during account deletion.');
    }
    const activeWrites = (db.prepare(`SELECT COUNT(*) AS count FROM invoice_artifact_manifests
      WHERE user_id = ? AND deleted_at IS NULL AND state = 'writing'
        AND write_lease_expires_at > ?`)
      .get(userId, Date.now()) as { count: number }).count;
    if (activeWrites !== 0) {
      throw new Error('Invoice artifact writes are still active during account deletion.');
    }
    const manifestRows = db.prepare(`SELECT id, tenant_id, user_id, artifact_kind,
        artifact_locator, storage_backend,
        state, write_token, write_lease_expires_at
      FROM invoice_artifact_manifests
      WHERE user_id = ? AND deleted_at IS NULL
      ORDER BY id ASC`).all(userId) as ManifestArtifactRow[];
    for (const row of manifestRows) {
      const outcome = row.artifact_kind === 'queue_spool'
        ? deleteInvoiceQueueSpoolFileForAccountDeletion(row.artifact_locator, {
          db,
          ownership: { manifestId: row.id, tenantId: row.tenant_id, userId: row.user_id },
        })
        : await deleteInvoiceObject(row.artifact_locator, row.storage_backend, {
          db,
          ownership: { manifestId: row.id, tenantId: row.tenant_id, userId: row.user_id },
        });
      if (outcome.deleted) {
        if (row.artifact_kind === 'queue_spool') queueFilesDeleted++;
        else storedObjectsDeleted++;
      }
    }
  }

  if (tableExists(db, 'invoice_queue')) {
    if (!tableHasColumn(db, 'invoice_queue', 'local_file_deleted_at')) {
      if (pendingQueueArtifactCount(db, userId) !== 0) {
        throw new Error('Invoice queue artifact cleanup requires its deletion-proof migration.');
      }
    } else {
      const queueRows = db.prepare(`SELECT id, tenant_id, user_id, local_path FROM invoice_queue
        WHERE user_id = ? AND local_path IS NOT NULL AND TRIM(local_path) <> ''
          AND local_file_deleted_at IS NULL
        ORDER BY id ASC`).all(userId) as QueueArtifactRow[];
      for (const row of queueRows) {
        const manifest = requireOrCreateAccountDeletionManifest({
          db,
          tenantId: row.tenant_id,
          userId: row.user_id,
          kind: 'queue_spool',
          locator: row.local_path,
          storageBackend: 'filesystem',
        });
        if (manifest.state === 'deleted') assertDurableFilesystemDeletionProof(manifest);
        const outcome = manifest.state === 'deleted'
          ? deleteInvoiceQueueSpoolFileForAccountDeletion(row.local_path, { db })
          : deleteInvoiceQueueSpoolFileForAccountDeletion(row.local_path, {
            db,
            ownership: {
              manifestId: manifest.id,
              tenantId: row.tenant_id,
              userId: row.user_id,
            },
          });
        const proof = db.prepare(`UPDATE invoice_queue
          SET local_file_deleted_at = ?
          WHERE id = ? AND tenant_id = ? AND user_id = ? AND local_path = ?
            AND local_file_deleted_at IS NULL`)
          .run(new Date().toISOString(), row.id, row.tenant_id, userId, row.local_path);
        if (proof.changes !== 1) {
          throw new Error('Invoice queue artifact deletion proof could not be persisted.');
        }
        if (outcome.deleted) queueFilesDeleted++;
      }
    }
  }

  if (tableExists(db, 'invoice_filings')) {
    if (!tableHasColumn(db, 'invoice_filings', 'object_deleted_at')) {
      if (pendingFiledArtifactCount(db, userId) !== 0) {
        throw new Error('Stored invoice cleanup requires its deletion-proof migration.');
      }
    } else {
      const filedRows = db.prepare(`SELECT id, tenant_id, user_id, object_key, remote_path, storage_backend,
          legacy_remote_deleted_at
        FROM invoice_filings
        WHERE user_id = ?
          AND COALESCE(NULLIF(TRIM(object_key), ''), NULLIF(TRIM(remote_path), '')) IS NOT NULL
          AND object_deleted_at IS NULL
        ORDER BY id ASC`).all(userId) as FiledArtifactRow[];
      for (const row of filedRows) {
        let deleted = false;
        const objectKey = row.object_key?.trim() || null;
        const remotePath = row.remote_path?.trim() || null;
        if (objectKey) {
          if (!row.tenant_id) {
            throw new Error('Stored invoice object is missing exact tenant ownership.');
          }
          assertStoredObjectKeyOwnership(objectKey, row.tenant_id, row.user_id);
          const storageBackend = row.storage_backend ?? 'filesystem';
          const manifest = requireOrCreateAccountDeletionManifest({
            db,
            tenantId: row.tenant_id,
            userId: row.user_id,
            kind: 'stored_object',
            locator: objectKey,
            storageBackend,
          });
          if (manifest.state === 'deleted') assertDurableFilesystemDeletionProof(manifest);
          const outcome = manifest.state === 'deleted'
            ? await deleteInvoiceObject(objectKey, storageBackend, { db })
            : await deleteInvoiceObject(objectKey, storageBackend, {
              db,
              ownership: {
                manifestId: manifest.id,
                tenantId: row.tenant_id,
                userId: row.user_id,
              },
            });
          deleted ||= outcome.deleted;
        }
        // New filings retain remote_path as a compatibility alias for the same
        // object key. A distinct legacy path is a second SCP copy and must be
        // independently removed (or proved absent) before metadata is erased.
        if (remotePath && remotePath !== objectKey && !row.legacy_remote_deleted_at) {
          throw new Error('Legacy invoice copy requires mounted-root deletion proof.');
        }
        const proof = db.prepare(`UPDATE invoice_filings
          SET object_deleted_at = ?
          WHERE id = ? AND tenant_id IS ? AND user_id = ? AND object_deleted_at IS NULL
            AND object_key IS ? AND remote_path IS ?`)
          .run(
            new Date().toISOString(),
            row.id,
            row.tenant_id,
            userId,
            row.object_key,
            row.remote_path,
          );
        if (proof.changes !== 1) {
          throw new Error('Stored invoice deletion proof could not be persisted.');
        }
        if (deleted) storedObjectsDeleted++;
      }
    }
  }

  assertInvoiceArtifactsDeletedForAccount(userId, db);
  return { queueFilesDeleted, storedObjectsDeleted };
}
