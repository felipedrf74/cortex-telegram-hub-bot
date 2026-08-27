import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

let testDb: Database.Database;

const testConfig = vi.hoisted(() => ({
  storageDir: '',
}));

vi.mock('../../src/config', () => ({
  config: {
    app: { timezone: 'Europe/Lisbon' },
    invoiceObjectStorage: {
      enabled: true,
      backend: 'filesystem',
      get filesystemDir() {
        return testConfig.storageDir;
      },
      maxObjectBytes: 1024 * 1024,
      minFreeBytes: 0,
      tenantMaxBytes: 0,
    },
  },
}));

vi.mock('../../src/services/invoice-filer', () => ({
  getPortugueseMonthFolder: (date: { month: number; year: number }) => {
    const months = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
    return `${months[date.month - 1]}-${date.year}`;
  },
}));

vi.mock('../../src/services/database', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/database')>('../../src/services/database')),
  getDb: () => testDb,
}));

import {
  buildInvoiceObjectKey,
  deleteInvoiceObject,
  getInvoiceObjectBuffer,
  putInvoiceObject,
  verifyInvoiceObjectChecksum,
} from '../../src/services/invoice-object-storage';
import { beginInvoiceArtifactWrite } from '../../src/services/invoice-artifact-admission';

(process.platform === 'linux' ? describe : describe.skip)(
  'invoice object storage filesystem backend',
  () => {
  beforeEach(() => {
    testConfig.storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-invoice-objects-'));
    testDb = new Database(':memory:');
    testDb.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, telegram_id INTEGER, status TEXT NOT NULL);
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
      INSERT INTO users (id, telegram_id, status) VALUES (9, 9009, 'active');
    `);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    testDb.close();
    if (testConfig.storageDir) {
      fs.rmSync(testConfig.storageDir, { recursive: true, force: true });
    }
    testConfig.storageDir = '';
  });

  it('pins the append-only identity-journal migration and its rollback', () => {
    const migration = fs.readFileSync(
      path.resolve(process.cwd(), 'migrations/298_invoice_artifact_identity_journal.sql'),
      'utf8',
    );
    const rollback = fs.readFileSync(
      path.resolve(process.cwd(), 'migrations/down/298_invoice_artifact_identity_journal.sql'),
      'utf8',
    );
    for (const column of [
      'write_intent_kind',
      'source_checksum',
      'payload_checksum',
      'deletion_device',
      'deletion_inode',
      'deletion_attempted_at',
    ]) {
      expect(migration).toContain(`ADD COLUMN ${column}`);
      expect(rollback).toContain(`DROP COLUMN ${column}`);
    }
    expect(migration).toContain('CREATE INDEX IF NOT EXISTS idx_invoice_artifact_manifest_write_intent');
    expect(migration).not.toContain('CREATE UNIQUE INDEX');
    expect(migration).not.toContain('CREATE TRIGGER');
    expect(rollback).toContain('DROP TRIGGER IF EXISTS invoice_artifact_manifest_deletion_proof_guard');
    expect(rollback).toContain('DROP INDEX IF EXISTS idx_invoice_artifact_manifest_write_intent');
  });

  it('round-trips a stored invoice and verifies its checksum', async () => {
    const buffer = Buffer.from('%PDF-1.7\ninvoice-bytes\n');
    const key = buildInvoiceObjectKey({
      tenantId: 7,
      userId: 9,
      documentDate: '2026-04-30',
      filename: 'Fatura Abril.pdf',
    });

    const stored = await putInvoiceObject(buffer, key, 'application/pdf');
    const roundTrip = await verifyInvoiceObjectChecksum(
      stored.objectKey,
      stored.checksum,
      stored.storageBackend,
    );
    const legacyRoundTrip = await verifyInvoiceObjectChecksum(
      stored.objectKey,
      stored.checksum,
      'legacy_scp',
    );

    expect(stored).toMatchObject({
      objectKey: 'invoices/7/9/2026/Abr-2026/Fatura_Abril.pdf',
      mime: 'application/pdf',
      bytes: buffer.length,
      storageBackend: 'filesystem',
    });
    expect(roundTrip).toEqual(buffer);
    expect(legacyRoundTrip).toEqual(buffer);
    expect(fs.existsSync(path.join(testConfig.storageDir, stored.objectKey))).toBe(true);
  });

  it('creates a missing configured root through its bound existing ancestor', async () => {
    const root = testConfig.storageDir;
    fs.rmSync(root, { recursive: true, force: true });
    const key = 'invoices/7/9/2026/Abr-2026/new-root.pdf';

    await expect(putInvoiceObject(Buffer.from('new-root'), key, 'application/pdf'))
      .resolves.toMatchObject({ objectKey: key });
    expect(fs.readFileSync(path.join(root, key), 'utf8')).toBe('new-root');
  });

  it('does not treat a missing configured root as deletion absence proof', async () => {
    fs.rmSync(testConfig.storageDir, { recursive: true, force: true });

    await expect(deleteInvoiceObject('invoices/7/9/2026/Abr-2026/missing-root.pdf'))
      .rejects.toThrow(/root absence cannot be proven safely/);
  });

  it('adopts an exact stored object after a caller crashes before filing metadata', async () => {
    const key = 'invoices/7/9/2026/Abr-2026/resumable.pdf';
    const bytes = Buffer.from('resumable invoice bytes');
    const first = await putInvoiceObject(bytes, key, 'application/pdf');

    await expect(putInvoiceObject(bytes, key, 'application/pdf')).resolves.toEqual(first);
    await expect(putInvoiceObject(Buffer.from('different'), key, 'application/pdf'))
      .rejects.toThrow(/does not match the idempotent write/);
    expect(testDb.prepare(`SELECT COUNT(*) AS count FROM invoice_artifact_manifests
      WHERE artifact_locator = ?`).get(key)).toEqual({ count: 1 });
  });

  it('adopts the first verified payload for one exact queue intent across changed retry bytes', async () => {
    const firstKey = 'invoices/7/9/2026/Abr-2026/queue-41-first.jpg';
    const retryKey = 'invoices/7/9/2026/Abr-2026/queue-41-renamed.jpg';
    const writeIntent = {
      kind: 'invoice_queue' as const,
      id: '41',
      sourceChecksum: 'a'.repeat(64),
    };
    const first = await putInvoiceObject(
      Buffer.from('first compressed payload'),
      firstKey,
      'image/jpeg',
      { writeIntent },
    );
    const adopted = await putInvoiceObject(
      Buffer.from('different bytes after compression settings changed'),
      retryKey,
      'image/webp',
      { writeIntent },
    );

    expect(adopted).toEqual(first);
    expect(await getInvoiceObjectBuffer(firstKey)).toEqual(Buffer.from('first compressed payload'));
    expect(fs.existsSync(path.join(testConfig.storageDir, retryKey))).toBe(false);
    expect(testDb.prepare(`SELECT COUNT(*) AS count FROM invoice_artifact_manifests
      WHERE write_intent_kind = 'invoice_queue' AND write_intent_id = '41'`).get())
      .toEqual({ count: 1 });
  });

  it('serializes live queue intents in the runtime while phase-A has no unique index', () => {
    const writeIntent = {
      kind: 'invoice_queue' as const,
      id: 'runtime-serialized-intent',
      sourceChecksum: 'b'.repeat(64),
    };
    const first = beginInvoiceArtifactWrite({
      tenantId: 7,
      userId: 9,
      artifactKind: 'stored_object',
      artifactLocator: 'invoices/7/9/2026/Abr-2026/first-intent.pdf',
      storageBackend: 'filesystem',
      writeIntent,
    }, testDb);

    expect(() => beginInvoiceArtifactWrite({
      tenantId: 7,
      userId: 9,
      artifactKind: 'stored_object',
      artifactLocator: 'invoices/7/9/2026/Abr-2026/second-intent.pdf',
      storageBackend: 'filesystem',
      writeIntent,
    }, testDb)).toThrow(/already has a live manifest/);
    first.release();
    expect(testDb.prepare(`SELECT COUNT(*) AS count FROM invoice_artifact_manifests
      WHERE write_intent_id = ?`).get(writeIntent.id)).toEqual({ count: 1 });
  });

  it('fails closed instead of adopting an ambiguous pre-existing live intent', async () => {
    const writeIntent = {
      kind: 'invoice_queue' as const,
      id: 'ambiguous-intent',
      sourceChecksum: 'c'.repeat(64),
    };
    const insert = testDb.prepare(`INSERT INTO invoice_artifact_manifests (
      tenant_id, user_id, artifact_kind, artifact_locator, storage_backend,
      state, write_token, write_lease_expires_at, created_at, updated_at, stored_at,
      write_intent_kind, write_intent_id, source_checksum,
      payload_checksum, payload_bytes, payload_mime
    ) VALUES (7, 9, 'stored_object', ?, 'filesystem', 'stored', ?, 0,
      '2026-08-26T00:00:00.000Z', '2026-08-26T00:00:00.000Z',
      '2026-08-26T00:00:00.000Z', 'invoice_queue', ?, ?, ?, 5, 'application/pdf')`);
    insert.run(
      'invoices/7/9/2026/Abr-2026/ambiguous-one.pdf',
      'ambiguous-one',
      writeIntent.id,
      writeIntent.sourceChecksum,
      'd'.repeat(64),
    );
    insert.run(
      'invoices/7/9/2026/Abr-2026/ambiguous-two.pdf',
      'ambiguous-two',
      writeIntent.id,
      writeIntent.sourceChecksum,
      'e'.repeat(64),
    );

    await expect(putInvoiceObject(
      Buffer.from('third'),
      'invoices/7/9/2026/Abr-2026/ambiguous-three.pdf',
      'application/pdf',
      { writeIntent },
    )).rejects.toThrow(/ambiguous live manifests/);
  });

  it('rejects unsafe object keys and checksum mismatches', async () => {
    await expect(
      putInvoiceObject(Buffer.from('x'), 'invoices/7/../escape.pdf', 'application/pdf'),
    ).rejects.toThrow(/Unsafe invoice object key/);

    const key = 'invoices/7/9/2026/Abr-2026/safe.pdf';
    const stored = await putInvoiceObject(Buffer.from('%PDF safe'), key, 'application/pdf');

    await expect(
      verifyInvoiceObjectChecksum(stored.objectKey, 'not-the-real-checksum', stored.storageBackend),
    ).rejects.toThrow(/checksum mismatch/);
  });

  it('rejects records that refer to the retired MinIO backend', async () => {
    await expect(
      verifyInvoiceObjectChecksum(
        'invoices/7/9/2026/Abr-2026/safe.pdf',
        null,
        'minio',
      ),
    ).rejects.toThrow('Unsupported invoice object storage backend: minio');
  });

  it('uses owner-only directories/files and tightens a legacy-readable object on access', async () => {
    const key = 'invoices/7/9/2026/Abr-2026/private.pdf';
    await putInvoiceObject(Buffer.from('private'), key, 'application/pdf');
    const target = path.join(testConfig.storageDir, key);
    expect(fs.statSync(testConfig.storageDir).mode & 0o077).toBe(0);
    expect(fs.statSync(path.dirname(target)).mode & 0o077).toBe(0);
    expect(fs.statSync(target).mode & 0o077).toBe(0);

    fs.chmodSync(target, 0o644);
    await getInvoiceObjectBuffer(key);
    expect(fs.statSync(target).mode & 0o077).toBe(0);
  });

  it('refuses symlink traversal and hard-linked invoice objects', async () => {
    const external = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-invoice-external-'));
    try {
      fs.mkdirSync(path.join(testConfig.storageDir, 'invoices'));
      fs.symlinkSync(external, path.join(testConfig.storageDir, 'invoices', '7'));
      await expect(
        putInvoiceObject(
          Buffer.from('no-follow'),
          'invoices/7/9/2026/Abr-2026/no-follow.pdf',
          'application/pdf',
        ),
      ).rejects.toThrow(/private directory|symbolic link/);
      expect(fs.readdirSync(external)).toEqual([]);
    } finally {
      fs.rmSync(external, { recursive: true, force: true });
    }

    fs.rmSync(testConfig.storageDir, { recursive: true, force: true });
    testConfig.storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-invoice-objects-'));
    const key = 'invoices/7/9/2026/Abr-2026/hardlink.pdf';
    await putInvoiceObject(Buffer.from('hardlink'), key, 'application/pdf');
    const target = path.join(testConfig.storageDir, key);
    fs.linkSync(target, `${target}.alias`);
    await expect(getInvoiceObjectBuffer(key)).rejects.toThrow(/private regular file/);
  });

  it('stays within its descriptor-bound parent through a namespace ABA swap', async () => {
    const external = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-invoice-race-external-'));
    const key = 'invoices/7/9/2026/Abr-2026/parent-race.pdf';
    const parent = path.join(testConfig.storageDir, 'invoices', '7', '9', '2026', 'Abr-2026');
    const displacedParent = `${parent}.displaced`;
    const originalOpen = fs.openSync.bind(fs);
    const originalWrite = fs.writeFileSync.bind(fs);
    let swapped = false;
    let wroteOutsideRoot = false;

    vi.spyOn(fs, 'openSync').mockImplementation(((candidate: fs.PathLike, ...args: unknown[]) => {
      if (!swapped && String(candidate).endsWith('/parent-race.pdf')) {
        fs.renameSync(parent, displacedParent);
        fs.symlinkSync(external, parent);
        swapped = true;
        try {
          return Reflect.apply(originalOpen, fs, [candidate, ...args]) as number;
        } finally {
          fs.unlinkSync(parent);
          fs.renameSync(displacedParent, parent);
        }
      }
      return Reflect.apply(originalOpen, fs, [candidate, ...args]) as number;
    }) as typeof fs.openSync);
    vi.spyOn(fs, 'writeFileSync').mockImplementation(((target: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      const resolved = typeof target === 'number'
        ? fs.realpathSync(`/proc/self/fd/${target}`)
        : path.resolve(String(target));
      const relativeToExternal = path.relative(external, resolved);
      if (relativeToExternal === '' || (!relativeToExternal.startsWith('..')
          && !path.isAbsolute(relativeToExternal))) {
        wroteOutsideRoot = true;
      }
      return Reflect.apply(originalWrite, fs, [target, ...args]);
    }) as typeof fs.writeFileSync);

    try {
      await expect(putInvoiceObject(Buffer.from('descriptor-bound'), key, 'application/pdf'))
        .resolves.toMatchObject({ objectKey: key });
      expect(swapped).toBe(true);
      expect(wroteOutsideRoot).toBe(false);
      expect(fs.readdirSync(external)).toEqual([]);
      expect(fs.existsSync(displacedParent)).toBe(false);
      expect(fs.readFileSync(path.join(testConfig.storageDir, key), 'utf8'))
        .toBe('descriptor-bound');
    } finally {
      fs.rmSync(external, { recursive: true, force: true });
    }
  });

  it('rejects configured-root replacement between descriptor-relative observation and open', async () => {
    const root = testConfig.storageDir;
    const displacedRoot = `${root}.displaced`;
    const rootName = path.basename(root);
    const originalLstat = fs.lstatSync.bind(fs);
    let swapped = false;

    vi.spyOn(fs, 'lstatSync').mockImplementation(((candidate: fs.PathLike) => {
      const stat = originalLstat(candidate);
      if (!swapped && String(candidate).startsWith('/proc/self/fd/')
          && String(candidate).endsWith(`/${rootName}`)) {
        fs.renameSync(root, displacedRoot);
        fs.mkdirSync(root, { mode: 0o700 });
        swapped = true;
      }
      return stat;
    }) as typeof fs.lstatSync);

    try {
      await expect(putInvoiceObject(
        Buffer.from('wrong-root'),
        'invoices/7/9/2026/Abr-2026/wrong-root.pdf',
        'application/pdf',
      )).rejects.toThrow(/path and descriptor disagree/);
      expect(swapped).toBe(true);
      expect(fs.readdirSync(root)).toEqual([]);
      expect(fs.readdirSync(displacedRoot)).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.renameSync(displacedRoot, root);
    }
  });

  it('proves deletion and treats an already-missing object as idempotent success', async () => {
    const key = 'invoices/7/9/2026/Abr-2026/delete.pdf';
    await putInvoiceObject(Buffer.from('delete'), key, 'application/pdf');
    await expect(deleteInvoiceObject(key)).resolves.toEqual({ deleted: true, alreadyMissing: false });
    await expect(deleteInvoiceObject(key)).resolves.toEqual({ deleted: false, alreadyMissing: true });
  });

  it('refuses to unlink an existing object that has no durable ownership manifest', async () => {
    const key = 'invoices/7/9/2026/Abr-2026/unmanifested.pdf';
    const target = path.join(testConfig.storageDir, key);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, 'private orphan bytes', { mode: 0o600 });

    await expect(deleteInvoiceObject(key)).rejects.toThrow(/durable ownership manifest/);
    expect(fs.existsSync(target)).toBe(true);
  });

  it('refuses an object write after the durable account-deletion fence is present', async () => {
    testDb.prepare(`INSERT INTO local_inference_account_deletion_fences (user_id, expires_at)
      VALUES (9, ?)`).run(Date.now() + 60_000);
    await expect(
      putInvoiceObject(
        Buffer.from('blocked'),
        'invoices/7/9/2026/Abr-2026/blocked.pdf',
        'application/pdf',
      ),
    ).rejects.toMatchObject({ code: 'ACCOUNT_DELETION_IN_PROGRESS' });
  });

  it('removes bytes when the post-write manifest transition loses its race', async () => {
    const key = 'invoices/7/9/2026/Abr-2026/transition-race.pdf';
    testDb.exec(`CREATE TRIGGER fail_stored_transition
      BEFORE UPDATE ON invoice_artifact_manifests
      WHEN NEW.state = 'stored'
      BEGIN SELECT RAISE(ABORT, 'simulated transition race'); END;`);

    await expect(putInvoiceObject(Buffer.from('race'), key, 'application/pdf'))
      .rejects.toThrow('simulated transition race');
    expect(fs.existsSync(path.join(testConfig.storageDir, key))).toBe(false);
    expect(testDb.prepare(`SELECT state, deleted_at FROM invoice_artifact_manifests
      WHERE artifact_locator = ?`).get(key)).toMatchObject({
      state: 'deleted',
      deleted_at: expect.any(String),
    });
  });

  it('does not treat an object access error as already-missing deletion proof', async () => {
    const key = 'invoices/7/9/2026/Abr-2026/access-error.pdf';
    await putInvoiceObject(Buffer.from('private'), key, 'application/pdf');
    const target = path.join(testConfig.storageDir, key);
    const originalLstat = fs.lstatSync.bind(fs);
    vi.spyOn(fs, 'lstatSync').mockImplementation(((candidate: fs.PathLike) => {
      if (String(candidate) === target) {
        throw Object.assign(new Error('access denied'), { code: 'EACCES' });
      }
      return originalLstat(candidate);
    }) as typeof fs.lstatSync);
    await expect(deleteInvoiceObject(key)).rejects.toThrow(/cannot be proven/);
    expect(testDb.prepare(`SELECT state, deleted_at FROM invoice_artifact_manifests
      WHERE artifact_locator = ?`).get(key)).toEqual({ state: 'deleting', deleted_at: null });
  });

  it('keeps the persisted object inode identity after unlink proof persistence fails', async () => {
    const key = 'invoices/7/9/2026/Abr-2026/proof-crash.pdf';
    await putInvoiceObject(Buffer.from('private proof bytes'), key, 'application/pdf');
    testDb.exec(`CREATE TRIGGER fail_object_deleted_proof
      BEFORE UPDATE ON invoice_artifact_manifests
      WHEN NEW.state = 'deleted'
      BEGIN SELECT RAISE(ABORT, 'simulated deletion proof crash'); END;`);

    await expect(deleteInvoiceObject(key)).rejects.toThrow('simulated deletion proof crash');
    expect(fs.existsSync(path.join(testConfig.storageDir, key))).toBe(false);
    expect(testDb.prepare(`SELECT state, deleted_at, deletion_device, deletion_inode
      FROM invoice_artifact_manifests WHERE artifact_locator = ?`).get(key)).toMatchObject({
      state: 'deleting',
      deleted_at: null,
      deletion_device: expect.any(String),
      deletion_inode: expect.any(String),
    });

    testDb.exec('DROP TRIGGER fail_object_deleted_proof');
    testDb.prepare(`UPDATE invoice_artifact_manifests
      SET write_lease_expires_at = 0 WHERE artifact_locator = ?`).run(key);
    await expect(deleteInvoiceObject(key)).rejects.toThrow(/cannot be proven/);
    expect(testDb.prepare(`SELECT state, deleted_at FROM invoice_artifact_manifests
      WHERE artifact_locator = ?`).get(key)).toEqual({ state: 'deleting', deleted_at: null });
  });

  it('keeps failed ownership proof when rollback cannot unlink written bytes', async () => {
    const key = 'invoices/7/9/2026/Abr-2026/unlink-failure.pdf';
    testDb.exec(`CREATE TRIGGER fail_stored_transition_for_unlink
      BEFORE UPDATE ON invoice_artifact_manifests
      WHEN NEW.state = 'stored'
      BEGIN SELECT RAISE(ABORT, 'simulated transition failure'); END;`);
    vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {
      throw Object.assign(new Error('unlink denied'), { code: 'EACCES' });
    });

    await expect(putInvoiceObject(Buffer.from('private'), key, 'application/pdf'))
      .rejects.toThrow('simulated transition failure');
    expect(testDb.prepare(`SELECT state, deleted_at FROM invoice_artifact_manifests
      WHERE artifact_locator = ?`).get(key)).toEqual({ state: 'deleting', deleted_at: null });
    expect(fs.statSync(path.join(testConfig.storageDir, key)).isFile()).toBe(true);
  });
  },
);
