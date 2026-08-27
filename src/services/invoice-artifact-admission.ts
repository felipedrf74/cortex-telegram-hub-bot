// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { getDb } from './database';

export type InvoiceArtifactKind = 'queue_spool' | 'stored_object';

export class InvoiceArtifactAdmissionError extends Error {
  constructor(
    readonly code: 'ACCOUNT_DELETION_IN_PROGRESS' | 'INVOICE_ARTIFACT_MANIFEST_UNAVAILABLE',
    message: string,
  ) {
    super(message);
    this.name = 'InvoiceArtifactAdmissionError';
  }
}

export interface InvoiceArtifactWriteAdmission {
  manifestId: number;
  writeToken: string;
  release: () => void;
}

export interface InvoiceArtifactWriteIntent {
  kind: 'invoice_queue';
  id: string;
  sourceChecksum: string;
}

export interface InvoiceArtifactPayloadMetadata {
  checksum: string;
  bytes: number;
  mime: string;
}

export interface InvoiceArtifactManifestOwnership {
  manifestId: number;
  tenantId: number;
  userId: number;
}

export interface InvoiceArtifactDeletionIdentity {
  device: string;
  inode: string;
}

export interface InvoiceArtifactDeletionClaim extends InvoiceArtifactManifestOwnership {
  artifactKind: InvoiceArtifactKind;
  artifactLocator: string;
  storageBackend: string;
  claimToken: string;
  identity: InvoiceArtifactDeletionIdentity;
}

export class InvoiceArtifactDeletionUnprovenError extends Error {
  constructor() {
    super('Invoice artifact inode deletion cannot be proven.');
    this.name = 'InvoiceArtifactDeletionUnprovenError';
  }
}

const activeAdmissions = new Map<number, number>();
const INVOICE_ARTIFACT_WRITE_LEASE_MS = 60_000;
const INVOICE_ARTIFACT_DELETION_LEASE_MS = 5 * 60_000;
const ACCOUNT_DELETION_DRAIN_TIMEOUT_MS = 15_000;
const ACCOUNT_DELETION_DRAIN_POLL_MS = 25;

function assertPositiveId(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
}

function manifestTableAvailable(db: Database.Database): boolean {
  return Boolean(db.prepare(`SELECT 1 AS present FROM sqlite_master
    WHERE type = 'table' AND name = 'invoice_artifact_manifests'`).get());
}

function accountDeletionIsFenced(userId: number, db: Database.Database): boolean {
  const fenceTableExists = Boolean(db.prepare(`SELECT 1 AS present FROM sqlite_master
    WHERE type = 'table' AND name = 'local_inference_account_deletion_fences'`).get());
  if (!fenceTableExists) return false;
  const row = db.prepare(`SELECT 1 AS present
    FROM local_inference_account_deletion_fences
    WHERE user_id = ? AND expires_at > ?`).get(userId, Date.now()) as { present: number } | undefined;
  return row?.present === 1;
}

function accountIsActive(userId: number, db: Database.Database): boolean {
  const row = db.prepare(`SELECT status FROM users
    WHERE id = ? LIMIT 1`).get(userId) as { status: string } | undefined;
  return row?.status === 'active';
}

export function assertInvoiceAccountAvailable(
  userId: number,
  db: Database.Database = getDb(),
): void {
  assertPositiveId(userId, 'userId');
  if (!accountIsActive(userId, db) || accountDeletionIsFenced(userId, db)) {
    throw new InvoiceArtifactAdmissionError(
      'ACCOUNT_DELETION_IN_PROGRESS',
      'No invoice artifact can be written while this account is unavailable.',
    );
  }
}

/**
 * Persist ownership before bytes can be written. Account deletion acquires its
 * durable fence through the same SQLite writer lock, so it observes either no
 * admission or a manifest that cleanup must reconcile. The in-process count
 * closes the short interval between manifest insertion and the synchronous
 * filesystem write completing.
 */
export function beginInvoiceArtifactWrite(input: {
  tenantId: number;
  userId: number;
  artifactKind: InvoiceArtifactKind;
  artifactLocator: string;
  storageBackend: string;
  writeIntent?: InvoiceArtifactWriteIntent;
  payload?: InvoiceArtifactPayloadMetadata;
}, db: Database.Database = getDb()): InvoiceArtifactWriteAdmission {
  assertPositiveId(input.tenantId, 'tenantId');
  assertPositiveId(input.userId, 'userId');
  if (!input.artifactLocator.trim()) throw new Error('Invoice artifact locator is required');
  if (input.writeIntent) {
    if (input.artifactKind !== 'stored_object'
        || !input.writeIntent.id.trim()
        || !/^[a-f0-9]{64}$/.test(input.writeIntent.sourceChecksum)) {
      throw new Error('Invoice artifact write intent is invalid.');
    }
  }
  if (input.payload) {
    if (!/^[a-f0-9]{64}$/.test(input.payload.checksum)
        || !Number.isSafeInteger(input.payload.bytes) || input.payload.bytes < 0
        || !input.payload.mime.trim()) {
      throw new Error('Invoice artifact payload metadata is invalid.');
    }
  }
  if (!manifestTableAvailable(db)) {
    throw new InvoiceArtifactAdmissionError(
      'INVOICE_ARTIFACT_MANIFEST_UNAVAILABLE',
      'Invoice artifact writes require the ownership-manifest migration.',
    );
  }

  activeAdmissions.set(input.userId, (activeAdmissions.get(input.userId) ?? 0) + 1);
  const releaseCount = (): void => {
    const remaining = (activeAdmissions.get(input.userId) ?? 1) - 1;
    if (remaining <= 0) activeAdmissions.delete(input.userId);
    else activeAdmissions.set(input.userId, remaining);
  };
  const writeToken = crypto.randomUUID();
  let manifestId: number;
  try {
    manifestId = db.transaction(() => {
      assertInvoiceAccountAvailable(input.userId, db);
      if (input.writeIntent) {
        // Migration 298 is an expand-only phase. Serialize the live-intent
        // uniqueness check with insertion so concurrent processes cannot create
        // two stored objects for one durable queue/source identity while the
        // predecessor-compatible schema intentionally has no UNIQUE index.
        const existingIntent = db.prepare(`SELECT id FROM invoice_artifact_manifests
          WHERE artifact_kind = 'stored_object' AND tenant_id = ? AND user_id = ?
            AND write_intent_kind = ? AND write_intent_id = ? AND source_checksum = ?
            AND deleted_at IS NULL
          LIMIT 1`).get(
          input.tenantId,
          input.userId,
          input.writeIntent.kind,
          input.writeIntent.id,
          input.writeIntent.sourceChecksum,
        ) as { id: number } | undefined;
        if (existingIntent) {
          throw new Error('Invoice artifact write intent already has a live manifest.');
        }
      }
      const timestamp = new Date().toISOString();
      const result = db.prepare(`INSERT INTO invoice_artifact_manifests (
          tenant_id, user_id, artifact_kind, artifact_locator, storage_backend,
          state, write_token, write_lease_expires_at, created_at, updated_at,
          write_intent_kind, write_intent_id, source_checksum,
          payload_checksum, payload_bytes, payload_mime
        ) VALUES (?, ?, ?, ?, ?, 'writing', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          input.tenantId,
          input.userId,
          input.artifactKind,
          input.artifactLocator,
          input.storageBackend,
          writeToken,
          Date.now() + INVOICE_ARTIFACT_WRITE_LEASE_MS,
          timestamp,
          timestamp,
          input.writeIntent?.kind ?? null,
          input.writeIntent?.id ?? null,
          input.writeIntent?.sourceChecksum ?? null,
          input.payload?.checksum ?? null,
          input.payload?.bytes ?? null,
          input.payload?.mime ?? null,
        );
      return Number(result.lastInsertRowid);
    }).immediate();
  } catch (error) {
    releaseCount();
    throw error;
  }

  let released = false;
  return {
    manifestId,
    writeToken,
    release: () => {
      if (released) return;
      released = true;
      releaseCount();
    },
  };
}

export function claimInvoiceArtifactDeletion(input: {
  ownership: InvoiceArtifactManifestOwnership;
  artifactKind: InvoiceArtifactKind;
  artifactLocator: string;
  storageBackend: string;
  observedIdentity: InvoiceArtifactDeletionIdentity | null;
  expectedIdentity?: InvoiceArtifactDeletionIdentity;
  expectedWriteToken?: string;
}, db: Database.Database = getDb()): InvoiceArtifactDeletionClaim {
  const now = Date.now();
  const timestamp = new Date().toISOString();
  const claimToken = crypto.randomUUID();
  const result = db.transaction(() => {
    const row = db.prepare(`SELECT tenant_id, user_id, artifact_kind, artifact_locator,
        storage_backend, state, write_token, write_lease_expires_at, deleted_at,
        deletion_device, deletion_inode
      FROM invoice_artifact_manifests WHERE id = ?`).get(input.ownership.manifestId) as {
        tenant_id: number;
        user_id: number;
        artifact_kind: string;
        artifact_locator: string;
        storage_backend: string;
        state: string;
        write_token: string;
        write_lease_expires_at: number;
        deleted_at: string | null;
        deletion_device: string | null;
        deletion_inode: string | null;
      } | undefined;
    if (!row || row.tenant_id !== input.ownership.tenantId
        || row.user_id !== input.ownership.userId
        || row.artifact_kind !== input.artifactKind
        || row.artifact_locator !== input.artifactLocator
        || row.storage_backend !== input.storageBackend
        || row.deleted_at !== null || row.state === 'deleted') {
      throw new Error('Invoice artifact deletion ownership is invalid.');
    }
    if (row.state === 'writing'
        && row.write_lease_expires_at > now
        && row.write_token !== input.expectedWriteToken) {
      throw new Error('Invoice artifact writer is still live.');
    }
    if (row.state === 'deleting' && row.write_lease_expires_at > now) {
      throw new Error('Invoice artifact deletion is already claimed.');
    }

    const persistedIdentity = row.deletion_device && row.deletion_inode
      ? { device: row.deletion_device, inode: row.deletion_inode }
      : null;
    if (row.state === 'deleting' && !persistedIdentity) {
      throw new InvoiceArtifactDeletionUnprovenError();
    }
    const identity = row.state === 'deleting'
      ? persistedIdentity
      : input.expectedIdentity ?? input.observedIdentity;
    const claimed = db.prepare(`UPDATE invoice_artifact_manifests
      SET state = 'deleting', write_token = ?, write_lease_expires_at = ?,
          deletion_device = ?, deletion_inode = ?, deletion_attempted_at = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ? AND user_id = ?
        AND artifact_kind = ? AND artifact_locator = ? AND storage_backend = ?
        AND state = ? AND write_token = ? AND deleted_at IS NULL`)
      .run(
        claimToken,
        now + INVOICE_ARTIFACT_DELETION_LEASE_MS,
        identity?.device ?? null,
        identity?.inode ?? null,
        timestamp,
        timestamp,
        input.ownership.manifestId,
        input.ownership.tenantId,
        input.ownership.userId,
        input.artifactKind,
        input.artifactLocator,
        input.storageBackend,
        row.state,
        row.write_token,
      );
    if (claimed.changes !== 1) {
      throw new Error('Invoice artifact deletion claim could not be persisted.');
    }
    return {
      identity,
      canDelete: Boolean(identity && input.observedIdentity
        && identity.device === input.observedIdentity.device
        && identity.inode === input.observedIdentity.inode),
    };
  }).immediate();

  const claimedIdentity = result.identity;
  if (!claimedIdentity || !result.canDelete) {
    throw new InvoiceArtifactDeletionUnprovenError();
  }

  return {
    ...input.ownership,
    artifactKind: input.artifactKind,
    artifactLocator: input.artifactLocator,
    storageBackend: input.storageBackend,
    claimToken,
    identity: claimedIdentity,
  };
}

export function completeInvoiceArtifactDeletion(
  claim: InvoiceArtifactDeletionClaim,
  db: Database.Database = getDb(),
): void {
  const timestamp = new Date().toISOString();
  const proof = db.prepare(`UPDATE invoice_artifact_manifests
    SET state = 'deleted', deleted_at = ?, write_lease_expires_at = 0, updated_at = ?
    WHERE id = ? AND tenant_id = ? AND user_id = ?
      AND artifact_kind = ? AND artifact_locator = ? AND storage_backend = ?
      AND state = 'deleting' AND write_token = ? AND deleted_at IS NULL
      AND deletion_device = ? AND deletion_inode = ?`)
    .run(
      timestamp,
      timestamp,
      claim.manifestId,
      claim.tenantId,
      claim.userId,
      claim.artifactKind,
      claim.artifactLocator,
      claim.storageBackend,
      claim.claimToken,
      claim.identity.device,
      claim.identity.inode,
    );
  if (proof.changes !== 1) {
    throw new Error('Invoice artifact manifest deletion proof could not be persisted.');
  }
}

export function assertInvoiceArtifactWriteCanProceed(
  admission: InvoiceArtifactWriteAdmission,
  db: Database.Database = getDb(),
): void {
  const row = db.prepare(`SELECT user_id, state, write_token, write_lease_expires_at
    FROM invoice_artifact_manifests WHERE id = ?`).get(admission.manifestId) as {
      user_id: number;
      state: string;
      write_token: string;
      write_lease_expires_at: number;
    } | undefined;
  if (!row || row.state !== 'writing' || row.write_token !== admission.writeToken
      || row.write_lease_expires_at <= Date.now()) {
    throw new Error('Invoice artifact write admission is no longer valid.');
  }
  assertInvoiceAccountAvailable(row.user_id, db);
}

export function completeInvoiceArtifactWrite(
  admission: InvoiceArtifactWriteAdmission,
  outcome: 'stored' | 'failed' | 'deleted',
  db: Database.Database = getDb(),
): void {
  try {
    const timestamp = new Date().toISOString();
    const result = db.prepare(`UPDATE invoice_artifact_manifests
      SET state = ?, stored_at = CASE WHEN ? = 'stored' THEN ? ELSE stored_at END,
          deleted_at = CASE WHEN ? = 'deleted' THEN ? ELSE deleted_at END,
          updated_at = ?
      WHERE id = ? AND write_token = ? AND state = 'writing'`)
      .run(
        outcome,
        outcome,
        timestamp,
        outcome,
        timestamp,
        timestamp,
        admission.manifestId,
        admission.writeToken,
      );
    if (result.changes !== 1) {
      throw new Error('Invoice artifact manifest transition was not persisted.');
    }
  } finally {
    admission.release();
  }
}

export function hasActiveInvoiceArtifactAdmissions(userId: number): boolean {
  return (activeAdmissions.get(userId) ?? 0) > 0;
}

export async function waitForInvoiceArtifactAdmissionsToDrain(userId: number): Promise<void> {
  assertPositiveId(userId, 'userId');
  const deadline = Date.now() + ACCOUNT_DELETION_DRAIN_TIMEOUT_MS;
  while (hasActiveInvoiceArtifactAdmissions(userId)) {
    if (Date.now() >= deadline) {
      throw new Error('Active invoice artifact writes did not stop before account deletion.');
    }
    await new Promise<void>((resolve) => setTimeout(resolve, ACCOUNT_DELETION_DRAIN_POLL_MS));
  }
}
