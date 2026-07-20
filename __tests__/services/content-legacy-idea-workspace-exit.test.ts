import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { assertContentLegacyIdeaWorkspaceExitReady } from '../../src/services/content-legacy-idea-workspace-exit';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';

const UP = readFileSync(
  resolve(process.cwd(), 'migrations/253_content_legacy_idea_note_workspace_parity.sql'),
  'utf8',
);
const STOP_BEFORE = '253_content_legacy_idea_note_workspace_parity.sql';

describe('migration 253 legacy idea runtime readiness', () => {
  const databases: Database.Database[] = [];
  afterEach(() => databases.splice(0).forEach((db) => db.close()));

  it('accepts the reviewed empty schema and independent tenant/owner parity after import', () => {
    const empty = tracked(createMigratedTestDatabase());
    expect(() => assertContentLegacyIdeaWorkspaceExitReady(empty)).not.toThrow();

    const db = tracked(createMigratedTestDatabase({ stopBefore: STOP_BEFORE }));
    const body = '\u00a0Private note bytes.  ';
    const noteId = Number(db.prepare(`
      INSERT INTO notes (user_id, content, domain, tags)
      VALUES (501, ?, ' CONTENT_IDEA ', 'private, launch')
    `).run(body).lastInsertRowid);
    const savedIdeaId = seedSavedIdea(db, {
      title: 'Independent tenant idea  ',
      tenantId: 999,
      ownerUserId: 501,
      userId: 501,
      hookIdea: 'Exact hook',
      score: 88.5,
    });
    applyUp(db);

    expect(() => assertContentLegacyIdeaWorkspaceExitReady(db)).not.toThrow();
    expect(db.prepare(`
      SELECT tenant_id AS tenantId, owner_user_id AS ownerUserId
        FROM content_legacy_saved_idea_ingress_bindings
       WHERE source_saved_idea_id = ?
    `).get(savedIdeaId)).toEqual({ tenantId: 999, ownerUserId: 501 });
    expect(db.prepare(`
      SELECT revision.content_text AS contentText,
             binding.source_hash AS sourceHash
        FROM content_legacy_idea_note_ingress_bindings AS binding
        JOIN content_revisions AS revision ON revision.id = binding.revision_id
       WHERE binding.source_note_id = ?
    `).get(noteId)).toEqual({
      contentText: body,
      sourceHash: sha256(body),
    });
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('allows legitimate post-import revisions without rewriting source provenance', () => {
    const db = tracked(createMigratedTestDatabase({ stopBefore: STOP_BEFORE }));
    const savedIdeaId = seedSavedIdea(db, {
      title: 'Develop this imported idea',
      tenantId: 999,
      ownerUserId: 501,
      userId: 501,
    });
    applyUp(db);
    const binding = db.prepare(`
      SELECT artifact_id AS artifactId, revision_id AS revisionId,
             source_hash AS sourceHash
        FROM content_legacy_saved_idea_ingress_bindings
       WHERE source_saved_idea_id = ?
    `).get(savedIdeaId) as { artifactId: number; revisionId: number; sourceHash: string };
    const developed = 'A user-developed second revision';
    const developedId = Number(db.prepare(`
      INSERT INTO content_revisions (
        tenant_id, owner_user_id, artifact_id, revision_number,
        parent_revision_id, content_format, content_text, content_hash,
        change_summary, change_reason, actor_type, actor_id,
        provenance_json, created_by
      ) VALUES (
        999, 501, ?, 2,
        ?, 'plain_text', ?, ?,
        'Developed after import', 'user_edit', 'user', '501',
        '{"source":"user"}', 501
      )
    `).run(
      binding.artifactId,
      binding.revisionId,
      developed,
      revisionHash(developed),
    ).lastInsertRowid);
    db.prepare(`
      UPDATE content_artifacts
         SET current_revision_id = ?, revision_count = 2
       WHERE id = ?
    `).run(developedId, binding.artifactId);

    expect(() => assertContentLegacyIdeaWorkspaceExitReady(db)).not.toThrow();
    expect(db.prepare(`
      SELECT revision_id AS revisionId, source_hash AS sourceHash
        FROM content_legacy_saved_idea_ingress_bindings
       WHERE source_saved_idea_id = ?
    `).get(savedIdeaId)).toEqual({
      revisionId: binding.revisionId,
      sourceHash: binding.sourceHash,
    });
  });

  it.each([
    {
      label: 'required readiness view is missing',
      tamper: (db: Database.Database) => db.exec('DROP VIEW content_legacy_idea_note_workspace_readiness;'),
    },
    {
      label: 'writer guard is missing',
      tamper: (db: Database.Database) => db.exec('DROP TRIGGER trg_saved_ideas_legacy_user_insert_blocked;'),
    },
    {
      label: 'binding table is missing',
      tamper: (db: Database.Database) => db.exec('DROP TABLE content_legacy_idea_note_ingress_bindings;'),
    },
    {
      label: 'same-name readiness view is forged',
      tamper: (db: Database.Database) => db.exec(`
        DROP VIEW content_legacy_saved_idea_workspace_readiness;
        CREATE VIEW content_legacy_saved_idea_workspace_readiness AS
        SELECT 'ready' AS readiness_status;
      `),
    },
    {
      label: 'same-name writer guard is replaced by a no-op',
      tamper: (db: Database.Database) => db.exec(`
        DROP TRIGGER trg_notes_content_idea_insert_blocked;
        CREATE TRIGGER trg_notes_content_idea_insert_blocked
        BEFORE INSERT ON notes
        BEGIN
          SELECT 1;
        END;
      `),
    },
  ])('fails schema identity when $label', ({ tamper }) => {
    const db = tracked(createMigratedTestDatabase());
    tamper(db);
    expect(() => assertContentLegacyIdeaWorkspaceExitReady(db))
      .toThrow(/content_legacy_idea_workspace_exit_schema_not_ready/);
  });

  it('fails integrity when retained note bytes change behind a restored guard', () => {
    const db = tracked(createMigratedTestDatabase({ stopBefore: STOP_BEFORE }));
    const noteId = Number(db.prepare(`
      INSERT INTO notes (user_id, content, domain)
      VALUES (501, 'Original exact note', 'content_idea')
    `).run().lastInsertRowid);
    applyUp(db);
    bypassTrigger(db, 'trg_notes_content_idea_update_blocked', () => {
      db.prepare('UPDATE notes SET content = ? WHERE id = ?').run('Tampered note', noteId);
    });

    expect(() => assertContentLegacyIdeaWorkspaceExitReady(db))
      .toThrow(/content_legacy_idea_workspace_exit_integrity_failed/);
  });

  it('fails integrity when any saved-idea snapshot field changes behind a restored guard', () => {
    const db = tracked(createMigratedTestDatabase({ stopBefore: STOP_BEFORE }));
    const savedIdeaId = seedSavedIdea(db, {
      title: 'Exact saved idea',
      tenantId: 999,
      ownerUserId: 501,
      userId: 501,
      hookIdea: 'Original hook',
      score: 42,
    });
    applyUp(db);
    bypassTrigger(db, 'trg_saved_ideas_legacy_user_update_blocked', () => {
      db.prepare('UPDATE saved_ideas SET hook_idea = ?, score = ? WHERE id = ?')
        .run('Tampered hook', 99, savedIdeaId);
    });

    expect(() => assertContentLegacyIdeaWorkspaceExitReady(db))
      .toThrow(/content_legacy_idea_workspace_exit_integrity_failed/);
  });

  it('fails integrity for dishonest quarantine or an altered immutable binding', () => {
    const quarantineDb = tracked(createMigratedTestDatabase({ stopBefore: STOP_BEFORE }));
    quarantineDb.prepare(`
      INSERT INTO notes (user_id, content, domain)
      VALUES (501, ?, 'content_idea')
    `).run('\u00a0\u2003');
    applyUp(quarantineDb);
    bypassTrigger(quarantineDb, 'trg_content_legacy_idea_note_quarantine_immutable', () => {
      quarantineDb.prepare(`
        UPDATE content_legacy_idea_note_quarantine SET source_hash = ?
      `).run('a'.repeat(64));
    });
    expect(() => assertContentLegacyIdeaWorkspaceExitReady(quarantineDb))
      .toThrow(/content_legacy_idea_workspace_exit_integrity_failed/);

    const bindingDb = tracked(createMigratedTestDatabase({ stopBefore: STOP_BEFORE }));
    bindingDb.prepare(`
      INSERT INTO notes (user_id, content, domain)
      VALUES (501, 'Bound source', 'content_idea')
    `).run();
    applyUp(bindingDb);
    bypassTrigger(bindingDb, 'trg_content_legacy_idea_note_ingress_immutable_update', () => {
      bindingDb.prepare(`
        UPDATE content_legacy_idea_note_ingress_bindings SET source_hash = ?
      `).run('b'.repeat(64));
    });
    expect(() => assertContentLegacyIdeaWorkspaceExitReady(bindingDb))
      .toThrow(/content_legacy_idea_workspace_exit_integrity_failed/);
  });

  it('fails integrity for a foreign-key violation hidden from aggregate parity', () => {
    const db = tracked(createMigratedTestDatabase());
    db.pragma('foreign_keys = OFF');
    db.prepare(`
      INSERT INTO content_legacy_saved_idea_quarantine (
        source_saved_idea_id, observed_user_id, observed_tenant_id,
        observed_owner_user_id, source_hash, reason_code, metadata_json
      ) VALUES (999999, 0, 0, 0, ?, 'ownerless_scope', '{}')
    `).run('c'.repeat(64));
    db.pragma('foreign_keys = ON');

    expect(() => assertContentLegacyIdeaWorkspaceExitReady(db))
      .toThrow(/content_legacy_idea_workspace_exit_integrity_failed/);
  });

  function tracked(db: Database.Database): Database.Database {
    databases.push(db);
    return db;
  }
});

function applyUp(db: Database.Database): void {
  db.transaction(() => db.exec(UP))();
}

function seedSavedIdea(
  db: Database.Database,
  input: {
    title: string;
    tenantId: number;
    ownerUserId: number;
    userId: number;
    hookIdea?: string;
    score?: number;
  },
): number {
  return Number(db.prepare(`
    INSERT INTO saved_ideas (
      title, source_date, status, created_at,
      source, score, workflow_eligible, hook_idea,
      user_id, tenant_id, owner_user_id, visibility_scope,
      lifecycle_state, scope_status, created_by, updated_by,
      audit_metadata_json, content_object_type, source_ids_json,
      ontology_metadata_json, ontology_schema_version
    ) VALUES (
      ?, '2031-04-05', 'saved', '2031-04-06T10:11:12.000Z',
      'manual', ?, 1, ?,
      ?, ?, ?, 'user_private',
      'saved', 'active', ?, ?,
      '{}', 'idea', '[]', '{}', 'content-ontology-v1'
    )
  `).run(
    input.title,
    input.score ?? 0,
    input.hookIdea ?? null,
    input.userId,
    input.tenantId,
    input.ownerUserId,
    input.ownerUserId,
    input.ownerUserId,
  ).lastInsertRowid);
}

function bypassTrigger(
  db: Database.Database,
  triggerName: string,
  mutation: () => void,
): void {
  const row = db.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?
  `).get(triggerName) as { sql?: string } | undefined;
  if (!row?.sql) throw new Error(`missing trigger fixture: ${triggerName}`);
  db.exec(`DROP TRIGGER "${triggerName}";`);
  try {
    mutation();
  } finally {
    db.exec(row.sql);
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function revisionHash(value: string): string {
  return sha256(JSON.stringify({ format: 'plain_text', text: value }));
}
