// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let testDb: Database.Database;
const testConfig = vi.hoisted(() => ({ databasePath: '' }));
const filingMocks = vi.hoisted(() => ({
  fileInvoice: vi.fn(),
  filePdf: vi.fn(),
  recordFiling: vi.fn(),
}));

vi.mock('../../src/config', () => ({
  config: {
    app: { get databasePath() { return testConfig.databasePath; } },
  },
}));
vi.mock('../../src/services/database', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/database')>('../../src/services/database')),
  getDb: () => testDb,
}));
vi.mock('../../src/services/invoice-filer', () => ({
  PT_MONTHS: [],
  analyzeInvoiceImage: vi.fn(),
  buildFilename: vi.fn(),
  buildPdfFilename: vi.fn(),
  fileInvoice: filingMocks.fileInvoice,
  filePdf: filingMocks.filePdf,
  getPortugueseMonthFolder: vi.fn(),
  isInvoiceFilingConfigured: () => true,
  resolveTargetDirectory: vi.fn(),
}));
vi.mock('../../src/state/invoice-filings', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/state/invoice-filings')>(),
  recordFiling: filingMocks.recordFiling,
}));
vi.mock('../../src/portal/telemetry', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/portal/telemetry')>(),
  pushEvent: vi.fn(),
}));
vi.mock('../../src/utils/logger', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/utils/logger')>(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  deleteInvoiceQueueSpoolFileForAccountDeletion,
  enqueueInvoice,
  flushQueue,
  reconcileTerminalInvoiceQueueSpools,
} from '../../src/services/invoice-queue';

(process.platform === 'linux' ? describe : describe.skip)('invoice queue private artifact safety', () => {
  let tempDir: string;

  beforeEach(() => {
    filingMocks.fileInvoice.mockReset();
    filingMocks.filePdf.mockReset();
    filingMocks.recordFiling.mockReset();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-invoice-queue-'));
    testConfig.databasePath = path.join(tempDir, 'database.sqlite');
    testDb = new Database(':memory:');
    testDb.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, status TEXT NOT NULL);
      INSERT INTO users (id, status) VALUES (9, 'active');
      CREATE TABLE local_inference_account_deletion_fences (
        user_id INTEGER PRIMARY KEY, expires_at INTEGER NOT NULL
      );
      CREATE TABLE invoice_artifact_manifests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
        artifact_kind TEXT NOT NULL, artifact_locator TEXT NOT NULL,
        storage_backend TEXT NOT NULL, state TEXT NOT NULL, write_token TEXT NOT NULL,
        write_lease_expires_at INTEGER NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        stored_at TEXT, deleted_at TEXT,
        write_intent_kind TEXT, write_intent_id TEXT, source_checksum TEXT,
        payload_checksum TEXT, payload_bytes INTEGER, payload_mime TEXT,
        deletion_device TEXT, deletion_inode TEXT, deletion_attempted_at TEXT,
        UNIQUE(artifact_kind, artifact_locator)
      );
      CREATE TABLE invoice_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL, local_path TEXT NOT NULL, media_type TEXT,
        analysis_json TEXT NOT NULL, source TEXT NOT NULL,
        tenant_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
        status TEXT NOT NULL, retries INTEGER NOT NULL DEFAULT 0,
        last_retry_at TEXT, error_message TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        filed_at TEXT, local_file_deleted_at TEXT,
        flush_claim_token TEXT, flush_claim_expires_at INTEGER
      );
    `);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    testDb.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('distinguishes a genuinely missing spool from an access error', () => {
    const missing = path.join(tempDir, 'invoice-queue', 'missing.pdf');
    expect(deleteInvoiceQueueSpoolFileForAccountDeletion(missing))
      .toEqual({ deleted: false, alreadyMissing: true });

    fs.mkdirSync(path.dirname(missing), { mode: 0o700 });
    fs.writeFileSync(missing, 'private', { mode: 0o600 });
    const originalLstat = fs.lstatSync.bind(fs);
    vi.spyOn(fs, 'lstatSync').mockImplementation(((target: fs.PathLike) => {
      if (String(target) === missing) {
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      }
      return originalLstat(target);
    }) as typeof fs.lstatSync);
    expect(() => deleteInvoiceQueueSpoolFileForAccountDeletion(missing))
      .toThrow('denied');
  });

  it('refuses to unlink an existing spool that has no durable ownership manifest', () => {
    const localPath = path.join(tempDir, 'invoice-queue', 'unmanifested.pdf');
    fs.mkdirSync(path.dirname(localPath), { mode: 0o700 });
    fs.writeFileSync(localPath, 'private orphan bytes', { mode: 0o600 });

    expect(() => deleteInvoiceQueueSpoolFileForAccountDeletion(localPath))
      .toThrow(/durable ownership manifest/);
    expect(fs.existsSync(localPath)).toBe(true);
  });

  it('rejects a symbolic-link parent before creating a spool outside the configured directory', () => {
    const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-invoice-queue-external-'));
    const linkedParent = path.join(tempDir, 'linked-database-dir');
    fs.symlinkSync(externalDir, linkedParent, 'dir');
    testConfig.databasePath = path.join(linkedParent, 'database.sqlite');

    try {
      expect(() => enqueueInvoice(
        Buffer.from('private queue bytes'),
        'pdf',
        null,
        JSON.stringify({ vendor: 'private' }),
        'email',
        9,
        9,
      )).toThrow();
      expect(fs.existsSync(path.join(externalDir, 'invoice-queue'))).toBe(false);
      expect(testDb.prepare('SELECT COUNT(*) AS count FROM invoice_artifact_manifests').get())
        .toEqual({ count: 0 });
    } finally {
      fs.rmSync(externalDir, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === 'linux')(
    'does not follow a queue directory swapped after its descriptor is bound',
    () => {
      const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-invoice-queue-race-'));
      const queueDir = path.join(tempDir, 'invoice-queue');
      const displacedQueueDir = `${queueDir}.displaced`;
      const originalOpen = fs.openSync.bind(fs);
      let swapped = false;

      vi.spyOn(fs, 'openSync').mockImplementation(((candidate: fs.PathLike, ...args: unknown[]) => {
        const candidatePath = String(candidate);
        if (!swapped && candidatePath.includes('/proc/self/fd/')
            && candidatePath.includes('/queued_')) {
          fs.renameSync(queueDir, displacedQueueDir);
          fs.symlinkSync(externalDir, queueDir);
          swapped = true;
        }
        return Reflect.apply(originalOpen, fs, [candidate, ...args]) as number;
      }) as typeof fs.openSync);

      try {
        expect(() => enqueueInvoice(
          Buffer.from('descriptor-bound private bytes'),
          'pdf',
          null,
          JSON.stringify({ vendor: 'private' }),
          'email',
          9,
          9,
        )).toThrow();
        expect(swapped).toBe(true);
        expect(fs.readdirSync(externalDir)).toEqual([]);
      } finally {
        fs.rmSync(externalDir, { recursive: true, force: true });
      }
    },
  );

  it('keeps a failed manifest when rollback cannot prove spool deletion', () => {
    testDb.exec(`CREATE TRIGGER fail_queue_stored_transition
      BEFORE UPDATE ON invoice_artifact_manifests
      WHEN NEW.state = 'stored'
      BEGIN SELECT RAISE(ABORT, 'simulated transition race'); END;`);
    vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {
      throw Object.assign(new Error('unlink denied'), { code: 'EACCES' });
    });

    expect(() => enqueueInvoice(
      Buffer.from('private queue bytes'),
      'pdf',
      null,
      JSON.stringify({ vendor: 'private' }),
      'email',
      9,
      9,
    )).toThrow('simulated transition race');
    const manifest = testDb.prepare(`SELECT state, deleted_at, artifact_locator
      FROM invoice_artifact_manifests`).get() as {
      state: string;
      deleted_at: string | null;
      artifact_locator: string;
    };
    expect(manifest).toMatchObject({ state: 'deleting', deleted_at: null });
    expect(fs.statSync(manifest.artifact_locator).isFile()).toBe(true);
  });

  it.each([
    ['tenant ownership', "tenant_id = 10"],
    ['user ownership', "user_id = 10"],
    ['storage backend', "storage_backend = 'other'"],
    ['stored state', "state = 'failed'"],
    ['live deletion state', "deleted_at = '2026-08-26T00:00:00.000Z'"],
  ])('refuses to read a spool with invalid %s proof', async (_label, mutation) => {
    const queueId = enqueueInvoice(
      Buffer.from('private queue bytes'),
      'pdf',
      null,
      JSON.stringify({ vendor: 'Private Vendor' }),
      'email',
      9,
      9,
    );
    const row = testDb.prepare(`SELECT local_path FROM invoice_queue WHERE id = ?`)
      .get(queueId) as { local_path: string };
    testDb.exec(`UPDATE invoice_artifact_manifests SET ${mutation}`);

    await expect(flushQueue()).resolves.toEqual({ flushed: 0, failed: 1, remaining: 0 });
    expect(filingMocks.filePdf).not.toHaveBeenCalled();
    expect(fs.existsSync(row.local_path)).toBe(true);
    expect(testDb.prepare(`SELECT status, local_file_deleted_at FROM invoice_queue WHERE id = ?`)
      .get(queueId)).toEqual({ status: 'failed', local_file_deleted_at: null });
  });

  it('claims pending rows before filing so overlapping flushes cannot duplicate a write', async () => {
    enqueueInvoice(
      Buffer.from('private queue bytes'),
      'pdf',
      null,
      JSON.stringify({
        vendor: 'Private Vendor',
        documentDate: '2026-08-26',
        invoiceNumber: 'private-number',
        originalName: 'private.pdf',
      }),
      'email',
      9,
      9,
    );

    let releaseWrite!: () => void;
    const writeBlocked = new Promise<void>((resolve) => { releaseWrite = resolve; });
    let signalWriteStarted!: () => void;
    const writeStarted = new Promise<void>((resolve) => { signalWriteStarted = resolve; });
    filingMocks.filePdf.mockImplementation(async () => {
      signalWriteStarted();
      await writeBlocked;
      return {
        success: true,
        filePath: 'invoices/9/private.pdf',
        folderPath: '2026/08',
        filename: 'private.pdf',
        objectKey: 'invoices/9/private.pdf',
        checksum: 'private-checksum',
        mime: 'application/pdf',
        bytes: 19,
        storageBackend: 'filesystem',
      };
    });
    let runHeartbeat: (() => void) | undefined;
    const heartbeatHandle = { unref: vi.fn() } as unknown as ReturnType<typeof setInterval>;
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void) => {
      runHeartbeat = callback;
      return heartbeatHandle;
    }) as typeof setInterval);
    vi.spyOn(globalThis, 'clearInterval').mockImplementation((() => undefined) as typeof clearInterval);

    const firstFlush = flushQueue();
    await writeStarted;
    const initialClaim = testDb.prepare(`SELECT flush_claim_expires_at FROM invoice_queue`)
      .get() as { flush_claim_expires_at: number };
    vi.spyOn(Date, 'now').mockReturnValue(initialClaim.flush_claim_expires_at);
    expect(runHeartbeat).toBeTypeOf('function');
    runHeartbeat?.();
    const renewedClaim = testDb.prepare(`SELECT flush_claim_expires_at FROM invoice_queue`)
      .get() as { flush_claim_expires_at: number };
    expect(renewedClaim.flush_claim_expires_at).toBeGreaterThan(initialClaim.flush_claim_expires_at);
    const overlappingFlush = await flushQueue();

    expect(overlappingFlush).toEqual({ flushed: 0, failed: 0, remaining: 1 });
    expect(filingMocks.filePdf).toHaveBeenCalledTimes(1);

    releaseWrite();
    await expect(firstFlush).resolves.toEqual({ flushed: 1, failed: 0, remaining: 0 });
    expect(filingMocks.filePdf).toHaveBeenCalledTimes(1);
    expect(testDb.prepare(`SELECT status, flush_claim_token, flush_claim_expires_at,
      local_file_deleted_at FROM invoice_queue`).get()).toMatchObject({
      status: 'filed',
      flush_claim_token: null,
      flush_claim_expires_at: null,
      local_file_deleted_at: expect.any(String),
    });
  });

  it('reuses one queue-derived filing identity after claim loss', async () => {
    const queueId = enqueueInvoice(
      Buffer.from('private queue bytes'),
      'pdf',
      null,
      JSON.stringify({ vendor: 'Private Vendor', documentDate: null }),
      'email',
      9,
      9,
    );
    const success = {
      success: true,
      filePath: 'invoices/9/private.pdf',
      folderPath: '2026/08',
      filename: 'private.pdf',
      objectKey: 'invoices/9/private.pdf',
      checksum: 'private-checksum',
      mime: 'application/pdf',
      bytes: 19,
      storageBackend: 'filesystem',
    };
    filingMocks.filePdf
      .mockImplementationOnce(async () => {
        testDb.prepare(`UPDATE invoice_queue
          SET flush_claim_token = 'replacement-claim', flush_claim_expires_at = ?
          WHERE id = ?`).run(Date.now() + 60_000, queueId);
        return success;
      })
      .mockResolvedValueOnce(success);

    await expect(flushQueue()).resolves.toEqual({ flushed: 0, failed: 0, remaining: 1 });
    testDb.prepare(`UPDATE invoice_queue SET flush_claim_expires_at = 0 WHERE id = ?`).run(queueId);
    await expect(flushQueue()).resolves.toEqual({ flushed: 1, failed: 0, remaining: 0 });

    const firstOptions = filingMocks.filePdf.mock.calls[0]?.[5] as {
      filingIdentity?: string;
    };
    const secondOptions = filingMocks.filePdf.mock.calls[1]?.[5] as {
      filingIdentity?: string;
    };
    expect(firstOptions.filingIdentity).toMatch(/^queue-\d+-[a-f0-9]{16}$/);
    expect(secondOptions.filingIdentity).toBe(firstOptions.filingIdentity);
    expect(filingMocks.filePdf.mock.calls[0]?.[5]).toMatchObject({
      writeIntent: {
        kind: 'invoice_queue',
        id: String(queueId),
        sourceChecksum: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(filingMocks.filePdf.mock.calls[1]?.[5]).toMatchObject({
      writeIntent: (filingMocks.filePdf.mock.calls[0]?.[5] as { writeIntent: unknown }).writeIntent,
    });
    expect(filingMocks.filePdf.mock.calls[1]?.[2]).toBe(filingMocks.filePdf.mock.calls[0]?.[2]);
  });

  it('retries terminal spool deletion through flush even when no pending rows remain', async () => {
    const queueId = enqueueInvoice(
      Buffer.from('private queue bytes'),
      'pdf',
      null,
      JSON.stringify({ vendor: 'Private Vendor' }),
      'email',
      9,
      9,
    );
    testDb.prepare(`UPDATE invoice_queue SET status = 'failed' WHERE id = ?`).run(queueId);
    const row = testDb.prepare(`SELECT local_path FROM invoice_queue WHERE id = ?`)
      .get(queueId) as { local_path: string };
    const originalUnlink = fs.unlinkSync.bind(fs);
    vi.spyOn(fs, 'unlinkSync')
      .mockImplementationOnce(() => {
        throw Object.assign(new Error('unlink denied'), { code: 'EACCES' });
      })
      .mockImplementation(originalUnlink);

    expect(reconcileTerminalInvoiceQueueSpools()).toEqual({ proven: 0, deleted: 0, failed: 1 });
    expect(fs.existsSync(row.local_path)).toBe(true);
    expect(testDb.prepare(`SELECT local_file_deleted_at FROM invoice_queue WHERE id = ?`)
      .get(queueId)).toEqual({ local_file_deleted_at: null });
    expect(testDb.prepare(`SELECT state, deleted_at FROM invoice_artifact_manifests`)
      .get()).toEqual({ state: 'deleting', deleted_at: null });

    testDb.prepare(`UPDATE invoice_artifact_manifests
      SET write_lease_expires_at = 0`).run();

    await expect(flushQueue()).resolves.toEqual({ flushed: 0, failed: 0, remaining: 0 });
    expect(fs.existsSync(row.local_path)).toBe(false);
    expect(testDb.prepare(`SELECT local_file_deleted_at FROM invoice_queue WHERE id = ?`)
      .get(queueId)).toMatchObject({ local_file_deleted_at: expect.any(String) });
    expect(testDb.prepare(`SELECT state, deleted_at FROM invoice_artifact_manifests`)
      .get()).toMatchObject({ state: 'deleted', deleted_at: expect.any(String) });
  });

  it('does not delete a failed spool while its queue-bound object intent is unresolved', () => {
    const queueId = enqueueInvoice(
      Buffer.from('private queue bytes'),
      'pdf',
      null,
      JSON.stringify({ vendor: 'Private Vendor' }),
      'email',
      9,
      9,
    );
    const row = testDb.prepare(`SELECT local_path FROM invoice_queue WHERE id = ?`)
      .get(queueId) as { local_path: string };
    testDb.prepare(`UPDATE invoice_queue SET status = 'failed' WHERE id = ?`).run(queueId);
    testDb.prepare(`INSERT INTO invoice_artifact_manifests (
        tenant_id, user_id, artifact_kind, artifact_locator, storage_backend,
        state, write_token, write_lease_expires_at, created_at, updated_at, stored_at,
        write_intent_kind, write_intent_id, source_checksum,
        payload_checksum, payload_bytes, payload_mime
      ) VALUES (9, 9, 'stored_object', ?, 'filesystem', 'stored', 'object-token', 0,
        ?, ?, ?, 'invoice_queue', ?, ?, ?, 7, 'application/pdf')`)
      .run(
        `invoices/9/9/2026/Ago-2026/queue-${queueId}.pdf`,
        new Date().toISOString(),
        new Date().toISOString(),
        new Date().toISOString(),
        String(queueId),
        'a'.repeat(64),
        'b'.repeat(64),
      );

    expect(reconcileTerminalInvoiceQueueSpools()).toEqual({ proven: 0, deleted: 0, failed: 1 });
    expect(fs.existsSync(row.local_path)).toBe(true);
    expect(testDb.prepare(`SELECT state, deleted_at FROM invoice_artifact_manifests
      WHERE artifact_kind = 'queue_spool'`).get()).toEqual({ state: 'stored', deleted_at: null });
  });

  it('does not prove deletion when the validated inode is renamed before unlink', () => {
    const queueId = enqueueInvoice(
      Buffer.from('private queue bytes'),
      'pdf',
      null,
      JSON.stringify({ vendor: 'Private Vendor' }),
      'email',
      9,
      9,
    );
    testDb.prepare(`UPDATE invoice_queue SET status = 'failed' WHERE id = ?`).run(queueId);
    const row = testDb.prepare(`SELECT local_path FROM invoice_queue WHERE id = ?`)
      .get(queueId) as { local_path: string };
    const originalUnlink = fs.unlinkSync.bind(fs);
    let swapped = false;
    vi.spyOn(fs, 'unlinkSync').mockImplementation(((target: fs.PathLike) => {
      if (!swapped && String(target).includes('/proc/self/fd/')) {
        fs.renameSync(target, `${String(target)}.moved`);
        fs.writeFileSync(target, 'replacement', { mode: 0o600 });
        swapped = true;
      }
      return originalUnlink(target);
    }) as typeof fs.unlinkSync);

    expect(reconcileTerminalInvoiceQueueSpools()).toEqual({ proven: 0, deleted: 0, failed: 1 });
    expect(swapped).toBe(true);
    expect(fs.existsSync(`${row.local_path}.moved`)).toBe(true);
    expect(testDb.prepare(`SELECT local_file_deleted_at FROM invoice_queue WHERE id = ?`)
      .get(queueId)).toEqual({ local_file_deleted_at: null });
    expect(testDb.prepare(`SELECT error_message FROM invoice_queue WHERE id = ?`)
      .get(queueId)).toEqual({ error_message: 'invoice_queue_inode_deletion_unproven' });
    expect(testDb.prepare(`SELECT state, deleted_at, deletion_device, deletion_inode
      FROM invoice_artifact_manifests`).get()).toMatchObject({
      state: 'deleting',
      deleted_at: null,
      deletion_device: expect.any(String),
      deletion_inode: expect.any(String),
    });
    expect(reconcileTerminalInvoiceQueueSpools()).toEqual({ proven: 0, deleted: 0, failed: 1 });
  });

  it('journals a manifest-only spool identity before an ABA deletion attempt', () => {
    const queueDir = path.join(tempDir, 'invoice-queue');
    fs.mkdirSync(queueDir, { mode: 0o700 });
    const localPath = path.join(queueDir, 'manifest-only.pdf');
    fs.writeFileSync(localPath, 'private manifest-only bytes', { mode: 0o600 });
    const inserted = testDb.prepare(`INSERT INTO invoice_artifact_manifests (
        tenant_id, user_id, artifact_kind, artifact_locator, storage_backend,
        state, write_token, write_lease_expires_at, created_at, updated_at
      ) VALUES (9, 9, 'queue_spool', ?, 'filesystem', 'stored', 'stored-token', 0, ?, ?)`)
      .run(localPath, new Date().toISOString(), new Date().toISOString());
    const manifestId = Number(inserted.lastInsertRowid);
    const originalUnlink = fs.unlinkSync.bind(fs);
    let swapped = false;
    vi.spyOn(fs, 'unlinkSync').mockImplementation(((target: fs.PathLike) => {
      if (!swapped && String(target).includes('/proc/self/fd/')) {
        fs.renameSync(target, `${String(target)}.moved`);
        fs.writeFileSync(target, 'replacement', { mode: 0o600 });
        swapped = true;
      }
      return originalUnlink(target);
    }) as typeof fs.unlinkSync);

    expect(() => deleteInvoiceQueueSpoolFileForAccountDeletion(localPath, {
      ownership: { manifestId, tenantId: 9, userId: 9 },
    })).toThrow(/cannot be proven/);
    expect(fs.existsSync(`${localPath}.moved`)).toBe(true);
    expect(testDb.prepare(`SELECT state, deleted_at, deletion_device, deletion_inode
      FROM invoice_artifact_manifests WHERE id = ?`).get(manifestId)).toMatchObject({
      state: 'deleting',
      deleted_at: null,
      deletion_device: expect.any(String),
      deletion_inode: expect.any(String),
    });
  });
});

it.runIf(process.platform !== 'linux')(
  'fails closed when descriptor-relative queue operations are unavailable',
  () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-invoice-queue-platform-'));
    testConfig.databasePath = path.join(tempDir, 'database.sqlite');
    try {
      expect(() => deleteInvoiceQueueSpoolFileForAccountDeletion(
        path.join(tempDir, 'invoice-queue', 'missing.pdf'),
      )).toThrow('requires Linux descriptor-relative operations');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  },
);
