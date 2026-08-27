import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';

const testConfig = vi.hoisted(() => ({ objectRoot: '' }));

vi.mock('../../src/config', () => ({
  config: {
    app: { databasePath: '/unused/bot.db' },
    invoices: { remotePath: '/unused/invoices' },
    invoiceObjectStorage: {
      enabled: true,
      get filesystemDir() {
        return testConfig.objectRoot;
      },
    },
  },
}));

import { reconcileArtifactManifests } from '../../src/tools/invoice-object-storage-backfill';

const linuxIt = it.runIf(process.platform === 'linux');

it('redacts raw filesystem details from top-level CLI failures', () => {
  const privatePathMarker = '/tmp/nexus-private-path-marker-7f31/missing.db';
  const result = spawnSync(process.execPath, [
    '--import',
    'tsx',
    'src/tools/invoice-object-storage-backfill.ts',
    '--db',
    privatePathMarker,
    '--json',
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test' },
  });

  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/^invoice object storage backfill failed: [A-Za-z]+\n$/);
  expect(result.stderr).not.toContain(privatePathMarker);
});

describe('invoice object storage manifest reconciliation', () => {
  let directory: string;
  let queueRoot: string;
  let dbPath: string;
  let db: Database.Database;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-invoice-manifest-'));
    fs.chmodSync(directory, 0o700);
    queueRoot = path.join(directory, 'invoice-queue');
    fs.mkdirSync(queueRoot, { mode: 0o700 });
    testConfig.objectRoot = path.join(directory, 'invoice-objects');
    fs.mkdirSync(testConfig.objectRoot, { mode: 0o700 });
    dbPath = path.join(directory, 'bot.db');
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, status TEXT NOT NULL);
      CREATE TABLE local_inference_account_deletion_fences (
        user_id INTEGER PRIMARY KEY, expires_at INTEGER NOT NULL
      );
      CREATE TABLE invoice_artifact_manifests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
        artifact_kind TEXT NOT NULL, artifact_locator TEXT NOT NULL,
        storage_backend TEXT NOT NULL, state TEXT NOT NULL,
        write_token TEXT NOT NULL, write_lease_expires_at INTEGER NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, stored_at TEXT,
        deleted_at TEXT,
        write_intent_kind TEXT, write_intent_id TEXT, source_checksum TEXT,
        payload_checksum TEXT, payload_bytes INTEGER, payload_mime TEXT,
        deletion_device TEXT, deletion_inode TEXT, deletion_attempted_at TEXT,
        UNIQUE(artifact_kind, artifact_locator)
      );
      CREATE TABLE invoice_queue (
        id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
        local_path TEXT, local_file_deleted_at TEXT
      );
      CREATE TABLE invoice_filings (
        id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
        object_key TEXT, storage_backend TEXT
      );
      INSERT INTO users (id, status) VALUES (9, 'active'), (10, 'active');
    `);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
    testConfig.objectRoot = '';
  });

  it('rejects invalid limits, missing schema, and unsafe mode-specific cursors', () => {
    for (const limit of [0, 1.5, Number.MAX_SAFE_INTEGER]) {
      expect(() => reconcileArtifactManifests({
        db, dbPath, apply: false, kind: 'filings', after: '', limit,
      })).toThrow(/limit must be between/);
    }

    const unmigrated = new Database(':memory:');
    try {
      expect(() => reconcileArtifactManifests({
        db: unmigrated, dbPath, apply: false, kind: 'filings', after: '', limit: 1,
      })).toThrow(/manifest migration is required/);
    } finally {
      unmigrated.close();
    }

    for (const after of ['-1', '1.5', 'not-a-filing']) {
      expect(() => reconcileArtifactManifests({
        db, dbPath, apply: false, kind: 'filings', after, limit: 1,
      })).toThrow(/nonnegative filing id/);
    }
    for (const after of ['/absolute', '../parent']) {
      expect(() => reconcileArtifactManifests({
        db, dbPath, apply: false, kind: 'objects', after, limit: 1,
      })).toThrow(/safe relative artifact cursor/);
    }
    for (const after of ['invalid', 'rows:999999999999999999999999']) {
      expect(() => reconcileArtifactManifests({
        db, dbPath, apply: false, kind: 'queue', after, limit: 1,
      })).toThrow();
    }
    fs.rmSync(queueRoot, { recursive: true });
    for (const after of ['files:/absolute', 'files:../parent']) {
      expect(() => reconcileArtifactManifests({
        db, dbPath, apply: false, kind: 'queue', after, limit: 1,
      })).toThrow(/safe relative path/);
    }
  });

  linuxIt('reconciles filing rows without adopting unsafe or cross-scope objects', () => {
    const makeSecureDirectory = (relative: string): string => {
      const target = path.join(testConfig.objectRoot, relative);
      fs.mkdirSync(target, { recursive: true, mode: 0o700 });
      let current = testConfig.objectRoot;
      for (const part of relative.split('/')) {
        current = path.join(current, part);
        fs.chmodSync(current, 0o700);
      }
      return target;
    };
    const ownerRoot = makeSecureDirectory('invoices/7/9');
    const zeroTenantRoot = makeSecureDirectory('invoices/0/9');
    const zeroUserRoot = makeSecureDirectory('invoices/7/0');
    const validKey = 'invoices/7/9/valid.pdf';
    const unsafeKey = 'invoices/7/9/unsafe.pdf';
    const directoryKey = 'invoices/7/9/not-a-file';
    fs.writeFileSync(path.join(ownerRoot, 'valid.pdf'), Buffer.from('valid'), { mode: 0o600 });
    fs.writeFileSync(path.join(ownerRoot, 'unsafe.pdf'), Buffer.from('unsafe'), { mode: 0o644 });
    fs.mkdirSync(path.join(ownerRoot, 'not-a-file'), { mode: 0o700 });
    fs.writeFileSync(path.join(zeroTenantRoot, 'invalid.pdf'), Buffer.from('invalid'), { mode: 0o600 });
    fs.writeFileSync(path.join(zeroUserRoot, 'invalid.pdf'), Buffer.from('invalid'), { mode: 0o600 });

    const insert = db.prepare(`INSERT INTO invoice_filings
      (id, tenant_id, user_id, object_key, storage_backend) VALUES (?, ?, ?, ?, ?)`);
    const rows: Array<[number, number, number, string, string]> = [
      [1, 7, 9, validKey, 'filesystem'],
      [2, 7, 9, 'other/7/9/not-in-root.pdf', 'filesystem'],
      [3, 7, 9, 'invoices/8/9/wrong-tenant.pdf', 'filesystem'],
      [4, 7, 9, 'invoices/7/10/wrong-user.pdf', 'filesystem'],
      [5, 7, 9, validKey, 'other'],
      [6, 7, 9, 'invoices/7/9/missing.pdf', 'filesystem'],
      [7, 7, 9, 'invoices/7/9/../../../../escape.pdf', 'filesystem'],
      [8, 7, 9, unsafeKey, 'filesystem'],
      [9, 7, 9, directoryKey, 'filesystem'],
      [10, 0, 9, 'invoices/0/9/invalid.pdf', 'filesystem'],
      [11, 7, 0, 'invoices/7/0/invalid.pdf', 'filesystem'],
    ];
    for (const row of rows) insert.run(...row);

    expect(reconcileArtifactManifests({
      db, dbPath, apply: false, kind: 'filings', after: '', limit: 20,
    })).toEqual({ scanned: 11, needed: 1, created: 0, unresolved: 10, nextAfter: null });
    expect(reconcileArtifactManifests({
      db, dbPath, apply: true, kind: 'filings', after: '', limit: 20,
    })).toEqual({ scanned: 11, needed: 1, created: 1, unresolved: 10, nextAfter: null });
    expect(reconcileArtifactManifests({
      db, dbPath, apply: true, kind: 'filings', after: '0', limit: 1,
    })).toEqual({ scanned: 1, needed: 0, created: 0, unresolved: 0, nextAfter: '1' });

    db.prepare(`UPDATE invoice_artifact_manifests SET state = 'failed'`).run();
    expect(reconcileArtifactManifests({
      db, dbPath, apply: true, kind: 'filings', after: '0', limit: 1,
    })).toMatchObject({ unresolved: 1 });
    db.prepare(`DELETE FROM invoice_artifact_manifests`).run();
    db.prepare(`UPDATE users SET status = 'disabled' WHERE id = 9`).run();
    expect(reconcileArtifactManifests({
      db, dbPath, apply: true, kind: 'filings', after: '0', limit: 1,
    })).toMatchObject({ needed: 0, unresolved: 1 });
    db.prepare(`UPDATE users SET status = 'active' WHERE id = 9`).run();
    db.prepare(`INSERT INTO local_inference_account_deletion_fences (user_id, expires_at)
      VALUES (9, ?)`).run(Date.now() + 60_000);
    expect(reconcileArtifactManifests({
      db, dbPath, apply: true, kind: 'filings', after: '0', limit: 1,
    })).toMatchObject({ needed: 0, unresolved: 1 });

    fs.rmSync(testConfig.objectRoot, { recursive: true });
    insert.run(12, 7, 9, 'invoices/7/9/root-missing.pdf', 'filesystem');
    expect(reconcileArtifactManifests({
      db, dbPath, apply: true, kind: 'filings', after: '11', limit: 1,
    })).toEqual({ scanned: 1, needed: 0, created: 0, unresolved: 1, nextAfter: null });
  });

  linuxIt('proves queue ownership in bounded row then filesystem phases', () => {
    const spool = path.join(queueRoot, 'queued_owned.pdf');
    fs.writeFileSync(spool, Buffer.from('private queue bytes'), { mode: 0o600 });
    db.prepare(`INSERT INTO invoice_queue (id, tenant_id, user_id, local_path)
      VALUES (1, 7, 9, ?)`).run(spool);

    const rows = reconcileArtifactManifests({
      db, dbPath, apply: true, kind: 'queue', after: '', limit: 10,
    });
    expect(rows).toMatchObject({
      scanned: 1,
      needed: 1,
      created: 1,
      unresolved: 0,
      nextAfter: 'files:',
    });

    const files = reconcileArtifactManifests({
      db, dbPath, apply: true, kind: 'queue', after: rows.nextAfter!, limit: 10,
    });
    expect(files).toMatchObject({
      scanned: 1,
      created: 0,
      unresolved: 0,
      nextAfter: null,
    });
    expect(db.prepare(`SELECT tenant_id, user_id, artifact_kind, artifact_locator, state
      FROM invoice_artifact_manifests`).get()).toEqual({
      tenant_id: 7,
      user_id: 9,
      artifact_kind: 'queue_spool',
      artifact_locator: spool,
      state: 'stored',
    });
  });

  linuxIt('blocks ownerless, missing, unsafe-mode, and deletion-fenced queue artifacts', () => {
    const missing = path.join(queueRoot, 'queued_missing.pdf');
    db.prepare(`INSERT INTO invoice_queue (id, tenant_id, user_id, local_path)
      VALUES (1, 7, 9, ?)`).run(missing);
    const missingRows = reconcileArtifactManifests({
      db, dbPath, apply: true, kind: 'queue', after: '', limit: 10,
    });
    expect(missingRows).toMatchObject({ unresolved: 1, created: 0, nextAfter: 'files:' });

    const ownerless = path.join(queueRoot, 'queued_ownerless.pdf');
    fs.writeFileSync(ownerless, Buffer.from('ownerless'), { mode: 0o600 });
    const ownerlessFiles = reconcileArtifactManifests({
      db, dbPath, apply: true, kind: 'queue', after: 'files:', limit: 10,
    });
    expect(ownerlessFiles).toMatchObject({ unresolved: 1, created: 0, nextAfter: null });

    fs.rmSync(ownerless);
    const unsafe = path.join(queueRoot, 'queued_unsafe.pdf');
    fs.writeFileSync(unsafe, Buffer.from('unsafe permissions'), { mode: 0o644 });
    db.prepare(`UPDATE invoice_queue SET local_path = ? WHERE id = 1`).run(unsafe);
    const unsafeFiles = reconcileArtifactManifests({
      db, dbPath, apply: true, kind: 'queue', after: 'files:', limit: 10,
    });
    expect(unsafeFiles).toMatchObject({ unresolved: 1, created: 0, nextAfter: null });

    fs.chmodSync(unsafe, 0o600);
    db.prepare(`INSERT INTO local_inference_account_deletion_fences (user_id, expires_at)
      VALUES (9, ?)`).run(Date.now() + 60_000);
    const fencedRows = reconcileArtifactManifests({
      db, dbPath, apply: true, kind: 'queue', after: '', limit: 10,
    });
    expect(fencedRows).toMatchObject({ unresolved: 1, created: 0, nextAfter: 'files:' });
  });

  linuxIt('refuses to adopt another user manifest for the same queue locator', () => {
    const spool = path.join(queueRoot, 'queued_cross_scope.pdf');
    fs.writeFileSync(spool, Buffer.from('scoped queue bytes'), { mode: 0o600 });
    db.prepare(`INSERT INTO invoice_queue (id, tenant_id, user_id, local_path)
      VALUES (1, 7, 9, ?)`).run(spool);
    const timestamp = new Date().toISOString();
    db.prepare(`INSERT INTO invoice_artifact_manifests (
      tenant_id, user_id, artifact_kind, artifact_locator, storage_backend,
      state, write_token, write_lease_expires_at, created_at, updated_at, stored_at
    ) VALUES (8, 10, 'queue_spool', ?, 'filesystem', 'stored', 'foreign', 0, ?, ?, ?)`)
      .run(spool, timestamp, timestamp, timestamp);

    const rows = reconcileArtifactManifests({
      db, dbPath, apply: true, kind: 'queue', after: '', limit: 10,
    });
    expect(rows).toMatchObject({ unresolved: 1, created: 0, nextAfter: 'files:' });
    expect(db.prepare(`SELECT tenant_id, user_id FROM invoice_artifact_manifests
      WHERE artifact_locator = ?`).get(spool)).toEqual({ tenant_id: 8, user_id: 10 });
  });

  linuxIt('preserves a relative queue locator through both reconciliation phases', () => {
    const spool = path.join(queueRoot, 'queued_relative.pdf');
    const relativeLocator = path.relative(process.cwd(), spool);
    fs.writeFileSync(spool, Buffer.from('relative private queue bytes'), { mode: 0o600 });
    db.prepare(`INSERT INTO invoice_queue (id, tenant_id, user_id, local_path)
      VALUES (1, 7, 9, ?)`).run(relativeLocator);

    const rows = reconcileArtifactManifests({
      db, dbPath, apply: true, kind: 'queue', after: '', limit: 10,
    });
    expect(rows).toMatchObject({ created: 1, unresolved: 0, nextAfter: 'files:' });
    const files = reconcileArtifactManifests({
      db, dbPath, apply: true, kind: 'queue', after: rows.nextAfter!, limit: 10,
    });
    expect(files).toMatchObject({ created: 0, unresolved: 0, nextAfter: null });
    expect(db.prepare(`SELECT artifact_locator FROM invoice_artifact_manifests
      WHERE artifact_kind = 'queue_spool'`).get()).toEqual({
      artifact_locator: relativeLocator,
    });
  });

  linuxIt('advances bounded cursors across directories, unsafe entries, and lexical siblings', () => {
    const ownerRoot = path.join(testConfig.objectRoot, 'invoices', '7', '9');
    const nested = path.join(ownerRoot, 'a');
    fs.mkdirSync(nested, { recursive: true, mode: 0o700 });
    for (const directoryPath of [
      path.join(testConfig.objectRoot, 'invoices'),
      path.join(testConfig.objectRoot, 'invoices', '7'),
      ownerRoot,
      nested,
    ]) fs.chmodSync(directoryPath, 0o700);
    const siblingKey = 'invoices/7/9/a.txt';
    const nestedKey = 'invoices/7/9/a/z.pdf';
    fs.writeFileSync(path.join(ownerRoot, 'a-unsafe.txt'), Buffer.from('unsafe'), { mode: 0o644 });
    fs.writeFileSync(path.join(ownerRoot, 'a.txt'), Buffer.from('sibling'), { mode: 0o600 });
    fs.writeFileSync(path.join(nested, 'z.pdf'), Buffer.from('nested'), { mode: 0o600 });
    db.prepare(`INSERT INTO invoice_filings (id, tenant_id, user_id, object_key, storage_backend)
      VALUES (1, 7, 9, ?, 'filesystem'), (2, 7, 9, ?, 'filesystem')`)
      .run(siblingKey, nestedKey);

    let cursor = '';
    let unresolved = 0;
    const observed = new Set<string>();
    for (let page = 0; page < 20; page += 1) {
      const result = reconcileArtifactManifests({
        db, dbPath, apply: true, kind: 'objects', after: cursor, limit: 3,
      });
      unresolved += result.unresolved;
      if (result.nextAfter === null) break;
      expect(result.nextAfter).not.toBe(cursor);
      expect(observed.has(result.nextAfter)).toBe(false);
      observed.add(result.nextAfter);
      cursor = result.nextAfter;
    }

    expect(unresolved).toBe(1);
    expect(db.prepare(`SELECT artifact_locator FROM invoice_artifact_manifests
      WHERE artifact_kind = 'stored_object' ORDER BY artifact_locator`).all()).toEqual([
      { artifact_locator: siblingKey },
      { artifact_locator: nestedKey },
    ]);
  });

  linuxIt('refuses a page whose nested enumeration exceeds its linear budget', () => {
    let directory = path.join(testConfig.objectRoot, 'invoices');
    fs.mkdirSync(directory, { mode: 0o700 });
    const cursorParts = ['invoices'];
    for (let depth = 0; depth < 5; depth += 1) {
      directory = path.join(directory, `nested-${depth}`);
      cursorParts.push(`nested-${depth}`);
      fs.mkdirSync(directory, { mode: 0o700 });
      fs.writeFileSync(
        path.join(directory, `sibling-${depth}.txt`),
        Buffer.from('x'),
        { mode: 0o600 },
      );
    }

    expect(() => reconcileArtifactManifests({
      db,
      dbPath,
      apply: false,
      kind: 'objects',
      after: `${cursorParts.join('/')}/zzzz`,
      limit: 2,
    })).toThrow(/enumeration budget/);
  });
});
