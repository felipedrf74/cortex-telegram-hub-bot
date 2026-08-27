// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let testDb: Database.Database;
const deleteQueueFile = vi.fn();
const deleteStoredObject = vi.fn();

vi.mock('../../src/services/database', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/database')>('../../src/services/database')),
  getDb: () => testDb,
}));
vi.mock('../../src/services/invoice-queue', () => ({
  deleteInvoiceQueueSpoolFileForAccountDeletion: (...args: unknown[]) => {
    const outcome = deleteQueueFile(...args);
    persistMockDeletionProof(args[1]);
    return outcome;
  },
}));
vi.mock('../../src/services/invoice-object-storage', () => ({
  deleteInvoiceObject: async (...args: unknown[]) => {
    const outcome = await deleteStoredObject(...args);
    persistMockDeletionProof(args[2]);
    return outcome;
  },
}));

function persistMockDeletionProof(rawOptions: unknown): void {
  const options = rawOptions as {
    ownership?: { manifestId: number; tenantId: number; userId: number };
  } | undefined;
  if (!options?.ownership) return;
  const timestamp = new Date().toISOString();
  const proof = testDb.prepare(`UPDATE invoice_artifact_manifests
    SET state = 'deleted', deleted_at = ?, updated_at = ?,
        deletion_device = 'test-device', deletion_inode = 'test-inode',
        deletion_attempted_at = ?
    WHERE id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL`)
    .run(
      timestamp,
      timestamp,
      timestamp,
      options.ownership.manifestId,
      options.ownership.tenantId,
      options.ownership.userId,
    );
  if (proof.changes !== 1) throw new Error('simulated manifest proof failure');
}

import {
  assertInvoiceArtifactsDeletedForAccount,
  cleanupInvoiceArtifactsForAccountDeletion,
} from '../../src/services/invoice-account-lifecycle';
import { recordFiling } from '../../src/state/invoice-filings';

function insertManifest(input: {
  kind: 'queue_spool' | 'stored_object';
  locator: string;
  state?: 'writing' | 'stored' | 'failed' | 'deleting';
  backend?: string;
}): number {
  return Number(testDb.prepare(`INSERT INTO invoice_artifact_manifests (
      tenant_id, user_id, artifact_kind, artifact_locator, storage_backend,
      state, write_token, write_lease_expires_at, created_at, updated_at
    ) VALUES (9, 9, ?, ?, ?, ?, 'token', ?, '2026-08-26T00:00:00.000Z', '2026-08-26T00:00:00.000Z')`)
    .run(
      input.kind,
      input.locator,
      input.backend ?? 'filesystem',
      input.state ?? 'stored',
      (input.state ?? 'stored') === 'writing' ? Date.now() + 60_000 : 0,
    ).lastInsertRowid);
}

describe('invoice artifact account lifecycle', () => {
  beforeEach(() => {
    deleteQueueFile.mockReset();
    deleteStoredObject.mockReset();
    testDb = new Database(':memory:');
    testDb.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, telegram_id INTEGER, status TEXT NOT NULL);
      INSERT INTO users (id, telegram_id, status) VALUES (9, 9009, 'active');
      CREATE TABLE local_inference_account_deletion_fences (
        user_id INTEGER PRIMARY KEY, expires_at INTEGER NOT NULL
      );
      CREATE TABLE invoice_artifact_manifests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
        artifact_kind TEXT NOT NULL, artifact_locator TEXT NOT NULL,
        storage_backend TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('writing', 'stored', 'failed', 'deleting', 'deleted')),
        write_token TEXT NOT NULL,
        write_lease_expires_at INTEGER NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        stored_at TEXT, deleted_at TEXT,
        write_intent_kind TEXT, write_intent_id TEXT, source_checksum TEXT,
        payload_checksum TEXT, payload_bytes INTEGER, payload_mime TEXT,
        deletion_device TEXT, deletion_inode TEXT, deletion_attempted_at TEXT
      );
      CREATE TABLE invoice_queue (
        id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL, user_id INTEGER NOT NULL, local_path TEXT,
        local_file_deleted_at TEXT
      );
      CREATE TABLE invoice_filings (
        id INTEGER PRIMARY KEY, tenant_id INTEGER, user_id INTEGER NOT NULL,
        vendor TEXT, amount TEXT, document_date TEXT, invoice_number TEXT,
        source TEXT, source_ref TEXT, remote_path TEXT, folder_path TEXT,
        filename TEXT, file_size_bytes INTEGER, compressed_size_bytes INTEGER,
        object_key TEXT, checksum TEXT, mime TEXT, bytes INTEGER,
        storage_backend TEXT, status TEXT, error_message TEXT, object_deleted_at TEXT,
        legacy_remote_deleted_at TEXT
      );
    `);
  });

  it('reconciles manifest-owned existing and already-missing artifacts without filing rows', async () => {
    insertManifest({ kind: 'queue_spool', locator: '/private/queue-one' });
    insertManifest({ kind: 'stored_object', locator: 'invoices/9/9/object-one.pdf' });
    insertManifest({ kind: 'stored_object', locator: 'invoices/9/9/already-missing.pdf', state: 'failed' });
    deleteQueueFile.mockReturnValue({ deleted: true, alreadyMissing: false });
    deleteStoredObject
      .mockResolvedValueOnce({ deleted: true, alreadyMissing: false })
      .mockResolvedValueOnce({ deleted: false, alreadyMissing: true });

    await expect(cleanupInvoiceArtifactsForAccountDeletion(9, testDb)).resolves.toEqual({
      queueFilesDeleted: 1,
      storedObjectsDeleted: 1,
    });
    expect(testDb.prepare(`SELECT COUNT(*) AS count FROM invoice_artifact_manifests
      WHERE user_id = 9 AND deleted_at IS NULL`).get()).toEqual({ count: 0 });
    expect(() => assertInvoiceArtifactsDeletedForAccount(9, testDb)).not.toThrow();
  });

  it('fails closed for an active write or unsupported storage backend', async () => {
    insertManifest({ kind: 'stored_object', locator: 'invoices/9/9/writing.pdf', state: 'writing' });
    await expect(cleanupInvoiceArtifactsForAccountDeletion(9, testDb))
      .rejects.toThrow(/still active/);
    expect(deleteStoredObject).not.toHaveBeenCalled();

    testDb.prepare('DELETE FROM invoice_artifact_manifests').run();
    insertManifest({ kind: 'stored_object', locator: 'invoices/9/9/unsupported.pdf', backend: 'minio' });
    deleteStoredObject.mockRejectedValue(new Error('unsupported backend'));
    await expect(cleanupInvoiceArtifactsForAccountDeletion(9, testDb))
      .rejects.toThrow('unsupported backend');
    expect(() => assertInvoiceArtifactsDeletedForAccount(9, testDb))
      .toThrow(/deletion proof/);
  });

  it('keeps an expired writer with no persisted inode identity fail-closed', async () => {
    const id = insertManifest({
      kind: 'stored_object',
      locator: 'invoices/9/9/crashed-before-transition.pdf',
      state: 'writing',
    });
    testDb.prepare(`UPDATE invoice_artifact_manifests
      SET write_lease_expires_at = ? WHERE id = ?`).run(Date.now() - 1, id);
    deleteStoredObject.mockRejectedValue(new Error('Invoice artifact inode deletion cannot be proven.'));

    await expect(cleanupInvoiceArtifactsForAccountDeletion(9, testDb))
      .rejects.toThrow(/cannot be proven/);
    expect(() => assertInvoiceArtifactsDeletedForAccount(9, testDb)).toThrow(/deletion proof/);
  });

  it('rejects filing metadata in the same writer transaction once deletion is fenced', () => {
    testDb.prepare(`INSERT INTO local_inference_account_deletion_fences (user_id, expires_at)
      VALUES (9, ?)`).run(Date.now() + 60_000);
    expect(() => recordFiling({
      tenant_id: 9,
      user_id: 9,
      vendor: 'private-vendor',
      source: 'photo',
    })).toThrowError(expect.objectContaining({ code: 'ACCOUNT_DELETION_IN_PROGRESS' }));
    expect(testDb.prepare('SELECT COUNT(*) AS count FROM invoice_filings').get())
      .toEqual({ count: 0 });
  });

  it('keeps account erasure blocked after bytes were removed but proof persistence crashed', async () => {
    insertManifest({ kind: 'stored_object', locator: 'invoices/9/9/crash-window.pdf' });
    deleteStoredObject.mockResolvedValueOnce({ deleted: true, alreadyMissing: false });
    testDb.exec(`CREATE TRIGGER fail_manifest_proof BEFORE UPDATE ON invoice_artifact_manifests
      WHEN NEW.state = 'deleted'
      BEGIN SELECT RAISE(ABORT, 'simulated proof crash'); END;`);

    await expect(cleanupInvoiceArtifactsForAccountDeletion(9, testDb))
      .rejects.toThrow('simulated proof crash');
    expect(() => assertInvoiceArtifactsDeletedForAccount(9, testDb))
      .toThrow(/deletion proof/);

    testDb.exec('DROP TRIGGER fail_manifest_proof');
    deleteStoredObject.mockRejectedValueOnce(
      new Error('Invoice artifact inode deletion cannot be proven.'),
    );
    await expect(cleanupInvoiceArtifactsForAccountDeletion(9, testDb))
      .rejects.toThrow(/cannot be proven/);
    expect(deleteStoredObject).toHaveBeenCalledTimes(2);
  });

  it('does not guess absence for an identity-less deleting claim after a crash', async () => {
    insertManifest({
      kind: 'stored_object',
      locator: 'invoices/9/9/crashed-delete-claim.pdf',
      state: 'deleting',
    });
    deleteStoredObject.mockRejectedValue(new Error('Invoice artifact inode deletion cannot be proven.'));

    await expect(cleanupInvoiceArtifactsForAccountDeletion(9, testDb))
      .rejects.toThrow(/cannot be proven/);
    expect(() => assertInvoiceArtifactsDeletedForAccount(9, testDb)).toThrow(/deletion proof/);
  });

  it('requires mounted-root proof for a distinct legacy SCP copy', async () => {
    testDb.prepare(`INSERT INTO invoice_filings (
        id, tenant_id, user_id, object_key, remote_path, storage_backend
      ) VALUES (8, 9, 9, 'invoices/9/9/backfilled.pdf',
        '/legacy/invoices/2026/backfilled.pdf', 'filesystem')`).run();
    deleteStoredObject.mockResolvedValue({ deleted: false, alreadyMissing: true });

    await expect(cleanupInvoiceArtifactsForAccountDeletion(9, testDb))
      .rejects.toThrow(/mounted-root deletion proof/);
    expect(() => assertInvoiceArtifactsDeletedForAccount(9, testDb))
      .toThrow(/deletion proof/);

    testDb.prepare(`UPDATE invoice_filings
      SET legacy_remote_deleted_at = '2026-08-26T00:00:00.000Z' WHERE id = 8`).run();
    await expect(cleanupInvoiceArtifactsForAccountDeletion(9, testDb)).resolves.toEqual({
      queueFilesDeleted: 0,
      storedObjectsDeleted: 0,
    });
    expect(deleteStoredObject).toHaveBeenCalledWith(
      'invoices/9/9/backfilled.pdf',
      'filesystem',
      expect.any(Object),
    );
  });

  it('creates exact ownership manifests before deleting legacy queue and filing rows', async () => {
    testDb.prepare(`INSERT INTO invoice_queue (id, tenant_id, user_id, local_path)
      VALUES (1, 9, 9, '/private/legacy-queue')`).run();
    testDb.prepare(`INSERT INTO invoice_filings (
        id, tenant_id, user_id, object_key, storage_backend
      ) VALUES (1, 9, 9, 'invoices/9/9/legacy.pdf', 'filesystem')`).run();
    deleteQueueFile.mockReturnValue({ deleted: true, alreadyMissing: false });
    deleteStoredObject.mockResolvedValue({ deleted: true, alreadyMissing: false });

    await cleanupInvoiceArtifactsForAccountDeletion(9, testDb);
    expect(deleteQueueFile.mock.calls[0]?.[1]).toMatchObject({
      ownership: { tenantId: 9, userId: 9 },
    });
    expect(deleteStoredObject.mock.calls[0]?.[2]).toMatchObject({
      ownership: { tenantId: 9, userId: 9 },
    });
    expect(testDb.prepare('SELECT local_file_deleted_at FROM invoice_queue WHERE id = 1').get())
      .toMatchObject({ local_file_deleted_at: expect.any(String) });
    expect(testDb.prepare('SELECT object_deleted_at FROM invoice_filings WHERE id = 1').get())
      .toMatchObject({ object_deleted_at: expect.any(String) });
  });

  it('refuses a filing whose object key belongs to another tenant and user', async () => {
    testDb.prepare(`INSERT INTO invoice_filings (
        id, tenant_id, user_id, object_key, storage_backend
      ) VALUES (2, 9, 9, 'invoices/10/10/cross-tenant.pdf', 'filesystem')`).run();

    await expect(cleanupInvoiceArtifactsForAccountDeletion(9, testDb))
      .rejects.toThrow(/does not match its filing ownership/);
    expect(deleteStoredObject).not.toHaveBeenCalled();
    expect(testDb.prepare(`SELECT COUNT(*) AS count FROM invoice_artifact_manifests`).get())
      .toEqual({ count: 0 });
  });

  it('rechecks canonical absence before reusing a deleted manifest proof', async () => {
    testDb.prepare(`INSERT INTO invoice_queue (id, tenant_id, user_id, local_path)
      VALUES (3, 9, 9, '/private/recreated-queue')`).run();
    testDb.prepare(`INSERT INTO invoice_artifact_manifests (
        tenant_id, user_id, artifact_kind, artifact_locator, storage_backend,
        state, write_token, write_lease_expires_at, created_at, updated_at, deleted_at,
        deletion_device, deletion_inode, deletion_attempted_at
      ) VALUES (9, 9, 'queue_spool', '/private/recreated-queue', 'filesystem',
        'deleted', 'proof-token', 0, ?, ?, ?, 'device', 'inode', ?)`)
      .run(...Array(4).fill('2026-08-26T00:00:00.000Z'));
    deleteQueueFile.mockImplementation(() => {
      throw new Error('Invoice queue deletion requires a durable ownership manifest.');
    });

    await expect(cleanupInvoiceArtifactsForAccountDeletion(9, testDb))
      .rejects.toThrow(/durable ownership manifest/);
    expect(testDb.prepare(`SELECT local_file_deleted_at FROM invoice_queue WHERE id = 3`).get())
      .toEqual({ local_file_deleted_at: null });
    expect(deleteQueueFile.mock.calls[0]?.[1]).toMatchObject({ db: testDb });
    expect((deleteQueueFile.mock.calls[0]?.[1] as { ownership?: unknown }).ownership)
      .toBeUndefined();
  });
});
