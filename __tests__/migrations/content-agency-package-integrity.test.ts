import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('migration 239 content agency package integrity', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE content_pipeline (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        tenant_id INTEGER NOT NULL,
        owner_user_id INTEGER NOT NULL,
        source_agency_package_id TEXT,
        scope_status TEXT NOT NULL DEFAULT 'active'
      );
      CREATE INDEX idx_content_pipeline_agency_package
        ON content_pipeline(tenant_id, user_id, source_agency_package_id, scope_status);
    `);
  });

  afterEach(() => db.close());

  it('adds package hashing and enforces one active handoff per scoped package', () => {
    const up = readFileSync(
      resolve(process.cwd(), 'migrations/239_content_agency_package_integrity.sql'),
      'utf8',
    );
    db.exec(up);

    const columns = db.prepare('PRAGMA table_info(content_pipeline)').all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain('source_agency_package_hash');

    const indexColumns = db.prepare('PRAGMA index_info(idx_content_pipeline_agency_package)').all() as Array<{ name: string }>;
    expect(indexColumns.map((column) => column.name)).toEqual([
      'tenant_id',
      'user_id',
      'source_agency_package_id',
      'source_agency_package_hash',
      'scope_status',
    ]);
    const indexes = db.prepare('PRAGMA index_list(content_pipeline)').all() as Array<{ name: string; unique: number }>;
    expect(indexes).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'uniq_content_pipeline_active_agency_package', unique: 1 }),
    ]));
    const uniqueColumns = db.prepare('PRAGMA index_info(uniq_content_pipeline_active_agency_package)').all() as Array<{ name: string }>;
    expect(uniqueColumns.map((column) => column.name)).toEqual([
      'tenant_id',
      'owner_user_id',
      'source_agency_package_id',
    ]);

    db.prepare(`
      INSERT INTO content_pipeline (user_id, tenant_id, owner_user_id, source_agency_package_id, source_agency_package_hash)
      VALUES (501, 101, 501, 'package_1', 'hash_1')
    `).run();
    expect(() => db.prepare(`
      INSERT INTO content_pipeline (user_id, tenant_id, owner_user_id, source_agency_package_id, source_agency_package_hash)
      VALUES (501, 101, 501, 'package_1', 'hash_2')
    `).run()).toThrow(/UNIQUE/i);
    expect(() => db.prepare(`
      INSERT INTO content_pipeline (
        user_id, tenant_id, owner_user_id, source_agency_package_id, source_agency_package_hash, scope_status
      ) VALUES (501, 101, 501, 'package_1', 'hash_1', 'superseded_duplicate')
    `).run()).not.toThrow();
  });

  it('reconciles pre-existing duplicate active handoffs without deleting audit rows', () => {
    db.prepare(`
      INSERT INTO content_pipeline (user_id, tenant_id, owner_user_id, source_agency_package_id, scope_status)
      VALUES
        (501, 101, 501, 'package_duplicate', 'active'),
        (501, 101, 501, 'package_duplicate', 'active')
    `).run();

    db.exec(readFileSync(
      resolve(process.cwd(), 'migrations/239_content_agency_package_integrity.sql'),
      'utf8',
    ));

    expect(db.prepare(`
      SELECT id, scope_status
        FROM content_pipeline
       WHERE source_agency_package_id = 'package_duplicate'
       ORDER BY id
    `).all()).toEqual([
      { id: 1, scope_status: 'superseded_duplicate' },
      { id: 2, scope_status: 'active' },
    ]);
  });

  it('fails a forward-only rollback before changing schema or stored data', () => {
    db.exec(readFileSync(
      resolve(process.cwd(), 'migrations/239_content_agency_package_integrity.sql'),
      'utf8',
    ));
    db.prepare(`
      INSERT INTO content_pipeline (
        user_id,
        tenant_id,
        owner_user_id,
        source_agency_package_id,
        source_agency_package_hash
      ) VALUES (?, ?, ?, ?, ?)
    `).run(501, 101, 501, 'package_1', 'hash_1');

    const down = readFileSync(
      resolve(process.cwd(), 'migrations/down/239_content_agency_package_integrity.sql'),
      'utf8',
    );
    expect(down).toMatch(/FORWARD-ONLY/i);
    expect(() => db.exec(down)).toThrow(/forward_only|cannot_reverse/i);

    expect(db.prepare('SELECT COUNT(*) AS count FROM content_pipeline').get()).toEqual({ count: 1 });
    const columns = db.prepare('PRAGMA table_info(content_pipeline)').all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain('source_agency_package_hash');
    const indexes = db.prepare('PRAGMA index_list(content_pipeline)').all() as Array<{ name: string }>;
    expect(indexes.map((index) => index.name)).toContain('uniq_content_pipeline_active_agency_package');
  });
});
