// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertContentWorkspaceIntegrityReady,
  CONTENT_WORKSPACE_INTEGRITY_READINESS,
} from '../../src/services/content-workspace-integrity-readiness';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';

describe('migration 251 runtime integrity readiness', () => {
  const databases: Database.Database[] = [];

  afterEach(() => databases.splice(0).forEach((db) => db.close()));

  it('accepts the fully migrated production schema and data preflight', () => {
    const db = tracked(createMigratedTestDatabase());

    expect(() => assertContentWorkspaceIntegrityReady(db)).not.toThrow();
  });

  it('blocks the real database-open path when a migrated DB loses a migration-251 guard', () => {
    const template = tracked(createMigratedTestDatabase());
    template.exec('DROP TRIGGER trg_content_revisions_lineage_scope_insert');
    const directory = mkdtempSync(join(tmpdir(), 'nexus-content-integrity-startup-'));
    const databasePath = join(directory, 'tampered.db');
    writeFileSync(databasePath, template.serialize());

    try {
      const probe = spawnSync(process.execPath, [
        '--import',
        'tsx',
        '--eval',
        `
          import { closeDatabase } from './src/services/database.ts';
          import { initDatabase } from './src/services/database-bootstrap.ts';
          let exitCode = 2;
          try {
            initDatabase();
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            process.stdout.write(message);
            exitCode = message === 'content_workspace_integrity_schema_not_ready' ? 0 : 3;
          } finally {
            closeDatabase();
          }
          process.exitCode = exitCode;
        `,
      ], {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: { ...process.env, DATABASE_PATH: databasePath, NODE_ENV: 'test' },
        timeout: 30_000,
      });

      expect(probe.status, probe.stderr).toBe(0);
      expect(probe.stdout).toContain('content_workspace_integrity_schema_not_ready');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('fails closed when any reviewed migration-251 trigger is absent', () => {
    const db = tracked(createMigratedTestDatabase());

    for (const name of CONTENT_WORKSPACE_INTEGRITY_READINESS.requiredTriggers) {
      const row = db.prepare(`
        SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?
      `).get(name) as { sql: string } | undefined;
      expect(row?.sql).toBeTypeOf('string');
      if (!row) throw new Error(`missing reviewed trigger fixture: ${name}`);

      db.exec(`DROP TRIGGER ${name}`);
      expect(() => assertContentWorkspaceIntegrityReady(db))
        .toThrow('content_workspace_integrity_schema_not_ready');
      db.exec(row.sql);
    }

    expect(() => assertContentWorkspaceIntegrityReady(db)).not.toThrow();
  });

  it('rejects a same-name no-op replacement instead of trusting object names', () => {
    const db = tracked(createMigratedTestDatabase());
    db.exec(`
      DROP TRIGGER trg_content_revisions_lineage_scope_insert;
      CREATE TRIGGER trg_content_revisions_lineage_scope_insert
      BEFORE INSERT ON content_revisions
      BEGIN
        SELECT 1;
      END;
    `);

    expect(() => assertContentWorkspaceIntegrityReady(db))
      .toThrow('content_workspace_integrity_schema_not_ready');
  });

  it('repeats migration 251 preflight and rejects a restored cross-item selection', () => {
    const db = tracked(createMigratedTestDatabase());
    const firstItemId = insertItem(db, 'first');
    const secondItemId = insertItem(db, 'second');
    const foreignArtifactId = Number(db.prepare(`
      INSERT INTO content_artifacts (
        tenant_id, owner_user_id, item_id, artifact_type, created_by, updated_by
      ) VALUES (101, 501, ?, 'script', 501, 501)
    `).run(secondItemId).lastInsertRowid);
    const trigger = db.prepare(`
      SELECT sql FROM sqlite_master
       WHERE type = 'trigger'
         AND name = 'trg_content_domain_objects_current_artifact_update'
    `).get() as { sql: string };

    db.exec('DROP TRIGGER trg_content_domain_objects_current_artifact_update');
    db.prepare('UPDATE content_domain_objects SET current_artifact_id = ? WHERE id = ?')
      .run(foreignArtifactId, firstItemId);
    db.exec(trigger.sql);

    expect(() => assertContentWorkspaceIntegrityReady(db))
      .toThrow('content_workspace_integrity_failed:current_artifact');
  });

  function tracked(db: Database.Database): Database.Database {
    databases.push(db);
    return db;
  }
});

function insertItem(db: Database.Database, suffix: string): number {
  return Number(db.prepare(`
    INSERT INTO content_domain_objects (
      tenant_id, owner_user_id, visibility_scope, scope_status, object_type,
      lifecycle_state, title, created_by, updated_by
    ) VALUES (101, 501, 'user_private', 'active', 'content_item', 'active', ?, 501, 501)
  `).run(`Integrity readiness ${suffix}`).lastInsertRowid);
}
