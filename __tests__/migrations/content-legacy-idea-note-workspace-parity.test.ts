import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';

const UP = readFileSync(
  resolve(process.cwd(), 'migrations/253_content_legacy_idea_note_workspace_parity.sql'),
  'utf8',
);
const DOWN = readFileSync(
  resolve(process.cwd(), 'migrations/down/253_content_legacy_idea_note_workspace_parity.sql'),
  'utf8',
);
const STOP_BEFORE = '253_content_legacy_idea_note_workspace_parity.sql';

describe('migration 253 legacy Content-idea note workspace parity', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createMigratedTestDatabase({ stopBefore: STOP_BEFORE });
  });

  afterEach(() => db.close());

  it('preserves every eligible source byte, scope, tag, pointer, and event while quarantining exclusions', () => {
    const unicodeBody = '\u00a0\u2003\t\nLaunch a café series ☕\nKeep exact trailing bytes.  ';
    const plainBody = 'Second user idea\r\nwith Windows line endings.\t ';
    const jsonTags = '[" Launch ","Café","launch",""]';
    const firstId = seedNote(db, {
      userId: 501,
      body: unicodeBody,
      domain: ' \u00a0CONTENT_IDEA\u2003 ',
      tags: jsonTags,
    });
    const secondId = seedNote(db, {
      userId: 777,
      body: plainBody,
      domain: 'content_idea',
      tags: 'Planning, Launch, planning',
    });
    const thirdId = seedNote(db, {
      userId: 501,
      body: 'Another private idea',
      domain: '\tContent_Idea\n',
      tags: null,
    });
    const ownerlessId = seedNote(db, {
      userId: 0,
      body: 'Cannot safely infer an owner',
      domain: 'content_idea',
      tags: 'unassigned',
    });
    const blankId = seedNote(db, {
      userId: 501,
      body: '\u00a0\u2003\t\n',
      domain: 'content_idea',
      tags: 'blank',
    });
    const ownerlessBlankId = seedNote(db, {
      userId: 0,
      body: '   ',
      domain: ' CONTENT_IDEA ',
      tags: null,
    });
    const generalId = seedNote(db, {
      userId: 501,
      body: 'General note must remain only a note',
      domain: 'general',
      tags: 'general',
    });

    applyUp(db);

    const bindings = db.prepare(`
      SELECT source_note_id AS sourceNoteId,
             tenant_id AS tenantId,
             owner_user_id AS ownerUserId,
             source_hash AS sourceHash,
             item_id AS itemId,
             artifact_id AS artifactId,
             revision_id AS revisionId
        FROM content_legacy_idea_note_ingress_bindings
       ORDER BY source_note_id
    `).all() as Array<Record<string, unknown>>;
    expect(bindings).toHaveLength(3);
    expect(bindings.map((row) => row.sourceNoteId)).toEqual([firstId, secondId, thirdId]);
    expect(bindings.find((row) => row.sourceNoteId === firstId)).toMatchObject({
      tenantId: 501,
      ownerUserId: 501,
      sourceHash: sha256(unicodeBody),
    });
    expect(bindings.find((row) => row.sourceNoteId === secondId)).toMatchObject({
      tenantId: 777,
      ownerUserId: 777,
      sourceHash: sha256(plainBody),
    });

    const first = db.prepare(`
      SELECT item.title AS itemTitle,
             item.production_state AS productionState,
             item.artifact_phase AS artifactPhase,
             item.current_artifact_id AS itemCurrentArtifactId,
             item.source_ids_json AS sourceIdsJson,
             item.audit_metadata_json AS itemMetadataJson,
             artifact.artifact_type AS artifactType,
             artifact.title AS artifactTitle,
             artifact.current_revision_id AS artifactCurrentRevisionId,
             artifact.revision_count AS revisionCount,
             artifact.metadata_json AS artifactMetadataJson,
             revision.revision_number AS revisionNumber,
             revision.content_format AS contentFormat,
             revision.content_text AS contentText,
             revision.content_hash AS contentHash,
             revision.provenance_json AS provenanceJson
        FROM content_legacy_idea_note_ingress_bindings AS binding
        JOIN content_domain_objects AS item ON item.id = binding.item_id
        JOIN content_artifacts AS artifact ON artifact.id = binding.artifact_id
        JOIN content_revisions AS revision ON revision.id = binding.revision_id
       WHERE binding.source_note_id = ?
    `).get(firstId) as any;
    expect(first).toMatchObject({
      itemTitle: expect.stringContaining('Launch a café series ☕'),
      productionState: 'inbox',
      artifactPhase: 'idea',
      itemCurrentArtifactId: bindings[0].artifactId,
      artifactType: 'idea_note',
      artifactTitle: first.itemTitle,
      artifactCurrentRevisionId: bindings[0].revisionId,
      revisionCount: 1,
      revisionNumber: 1,
      contentFormat: 'plain_text',
      contentText: unicodeBody,
      contentHash: revisionHash(unicodeBody),
    });
    expect(JSON.parse(first.sourceIdsJson)).toEqual([`legacy_note:${firstId}`]);
    expect(JSON.parse(first.itemMetadataJson)).toMatchObject({
      migration: 'content_legacy_idea_note_253',
      legacyNoteId: firstId,
      legacyRawDomain: ' \u00a0CONTENT_IDEA\u2003 ',
      legacyRawTags: jsonTags,
      sourceHash: sha256(unicodeBody),
      contentParity: 'artifact_pinned',
    });
    expect(JSON.parse(first.artifactMetadataJson)).toMatchObject({
      legacyNoteId: firstId,
      legacyRawTags: jsonTags,
      sourceHash: sha256(unicodeBody),
    });
    expect(JSON.parse(first.provenanceJson)).toMatchObject({
      legacyNoteId: firstId,
      legacyRawTags: jsonTags,
      sourceHash: sha256(unicodeBody),
    });

    expect(db.prepare(`
      SELECT tag.normalized_name AS normalizedName
        FROM content_item_tags AS item_tag
        JOIN content_tags AS tag ON tag.id = item_tag.tag_id
       WHERE item_tag.item_id = ?
       ORDER BY tag.normalized_name
    `).all(bindings[0].itemId)).toEqual([
      { normalizedName: 'café' },
      { normalizedName: 'launch' },
    ]);
    const secondBinding = bindings.find((row) => row.sourceNoteId === secondId)!;
    expect(db.prepare(`
      SELECT tag.normalized_name AS normalizedName
        FROM content_item_tags AS item_tag
        JOIN content_tags AS tag ON tag.id = item_tag.tag_id
       WHERE item_tag.item_id = ?
       ORDER BY tag.normalized_name
    `).all(secondBinding.itemId)).toEqual([
      { normalizedName: 'launch' },
      { normalizedName: 'planning' },
    ]);

    expect(db.prepare(`
      SELECT source_note_id AS sourceNoteId, owner_user_id AS ownerUserId,
             reason_code AS reasonCode, source_hash AS sourceHash
        FROM content_legacy_idea_note_quarantine
       ORDER BY source_note_id
    `).all()).toEqual([
      {
        sourceNoteId: ownerlessId,
        ownerUserId: 0,
        reasonCode: 'ownerless_user',
        sourceHash: sha256('Cannot safely infer an owner'),
      },
      {
        sourceNoteId: blankId,
        ownerUserId: 501,
        reasonCode: 'blank_body',
        sourceHash: sha256('\u00a0\u2003\t\n'),
      },
      {
        sourceNoteId: ownerlessBlankId,
        ownerUserId: 0,
        reasonCode: 'ownerless_and_blank_body',
        sourceHash: sha256('   '),
      },
    ]);

    expect(db.prepare(`
      SELECT COUNT(*) AS count
        FROM notes
       WHERE id IN (?, ?, ?, ?, ?, ?, ?)
    `).get(firstId, secondId, thirdId, ownerlessId, blankId, ownerlessBlankId, generalId))
      .toEqual({ count: 7 });
    expect(db.prepare(`
      SELECT COUNT(*) AS count
        FROM content_workflow_events
       WHERE action = 'legacy_content_idea_note_migrated'
    `).get()).toEqual({ count: 3 });
    expect(readiness(db)).toEqual({
      nonblank_eligible_source_count: 3,
      bound_source_count: 3,
      unbound_eligible_source_count: 0,
      exact_byte_hash_mismatch_count: 0,
      orphan_or_changed_binding_count: 0,
      quarantinable_source_count: 3,
      quarantined_source_count: 3,
      user_id_zero_quarantine_count: 2,
      blank_body_quarantine_count: 2,
      unquarantined_ineligible_source_count: 0,
      writer_guard_count: 2,
      source_delete_guard_count: 1,
      binding_guard_count: 3,
      quarantine_guard_count: 1,
      readiness_status: 'ready',
    });
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('is idempotent and rejects cross-scope bindings, parallel writes, and provenance rewrites', () => {
    const firstId = seedNote(db, {
      userId: 501,
      body: 'Owner A idea with exact bytes.  ',
      domain: 'content_idea',
      tags: 'alpha',
    });
    const secondId = seedNote(db, {
      userId: 777,
      body: 'Owner B private idea',
      domain: 'content_idea',
      tags: 'beta',
    });
    const generalId = seedNote(db, {
      userId: 501,
      body: 'Ordinary note',
      domain: 'general',
      tags: null,
    });

    applyUp(db);
    const before = migrationCounts(db);
    applyUp(db);
    expect(migrationCounts(db)).toEqual(before);
    expect(before).toEqual({
      items: 2,
      artifacts: 2,
      revisions: 2,
      bindings: 2,
      events: 2,
    });

    const owner = db.prepare(`
      SELECT * FROM content_legacy_idea_note_ingress_bindings
       WHERE source_note_id = ?
    `).get(firstId) as any;
    const foreign = db.prepare(`
      SELECT * FROM content_legacy_idea_note_ingress_bindings
       WHERE source_note_id = ?
    `).get(secondId) as any;

    expect(() => db.prepare(`
      INSERT INTO content_legacy_idea_note_ingress_bindings (
        tenant_id, owner_user_id, source_note_id, source_hash,
        item_id, artifact_id, revision_id
      ) VALUES (777, 777, ?, ?, ?, ?, ?)
    `).run(firstId, sha256('Owner A idea with exact bytes.  '), foreign.item_id, foreign.artifact_id, foreign.revision_id))
      .toThrow(/source scope or hash mismatch/i);
    expect(() => db.prepare(`
      UPDATE content_legacy_idea_note_ingress_bindings
         SET source_hash = ?
       WHERE id = ?
    `).run('a'.repeat(64), owner.id)).toThrow(/immutable/i);
    expect(() => db.prepare(`
      DELETE FROM content_legacy_idea_note_ingress_bindings WHERE id = ?
    `).run(owner.id)).toThrow(/immutable/i);
    expect(() => db.prepare('DELETE FROM notes WHERE id = ?').run(firstId))
      .toThrow(/immutable outside account or legal erasure/i);

    expect(() => seedNote(db, {
      userId: 501,
      body: 'A parallel idea must not be created',
      domain: '  CONTENT_IDEA ',
      tags: null,
    })).toThrow(/notes content_idea ingress is read-only/i);
    expect(() => db.prepare('UPDATE notes SET content = ? WHERE id = ?')
      .run('Overwritten idea', firstId)).toThrow(/notes content_idea ingress is read-only/i);
    expect(() => db.prepare('UPDATE notes SET domain = ? WHERE id = ?')
      .run('content_idea', generalId)).toThrow(/notes content_idea ingress is read-only/i);
    expect(() => db.prepare(`
      INSERT INTO notes (user_id, content, domain, tags)
      VALUES (501, 'Still a normal note', 'general', NULL)
    `).run()).not.toThrow();

    expect(readiness(db)).toMatchObject({
      nonblank_eligible_source_count: 2,
      bound_source_count: 2,
      exact_byte_hash_mismatch_count: 0,
      readiness_status: 'ready',
    });
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('keeps account/legal erasure graph deletion open and guards destructive rollback', () => {
    const sourceId = seedNote(db, {
      userId: 501,
      body: 'Erase this private legacy idea with its account',
      domain: 'content_idea',
      tags: 'private',
    });
    const savedSourceId = seedSavedIdea(db, {
      title: 'Erase this legacy saved idea with its account',
      userId: 501,
      tenantId: 501,
      ownerUserId: 501,
    });
    const quarantinedSavedSourceId = seedSavedIdea(db, {
      title: '\u00a0\u2003',
      userId: 501,
      tenantId: 501,
      ownerUserId: 501,
    });
    applyUp(db);

    const binding = db.prepare(`
      SELECT id, item_id AS itemId
        FROM content_legacy_idea_note_ingress_bindings
       WHERE source_note_id = ?
    `).get(sourceId) as { id: number; itemId: number };
    const savedBinding = db.prepare(`
      SELECT item_id AS itemId
        FROM content_legacy_saved_idea_ingress_bindings
       WHERE source_saved_idea_id = ?
    `).get(savedSourceId) as { itemId: number };

    expect(DOWN).toMatch(/exact.*snapshot/i);
    expect(() => db.transaction(() => db.exec(DOWN))())
      .toThrow(/content_legacy_idea_note_253_rollback_requires_exact_snapshot/i);
    expect(triggerCount(db, 'trg_notes_content_idea_insert_blocked')).toBe(1);
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM content_legacy_idea_note_ingress_bindings
    `).get()).toEqual({ count: 1 });

    authorizeErasure(db, 501);
    expect(() => db.transaction(() => {
      db.prepare('DELETE FROM notes WHERE id = ? AND user_id = ?').run(sourceId, 501);
      db.prepare('DELETE FROM saved_ideas WHERE id IN (?, ?)')
        .run(savedSourceId, quarantinedSavedSourceId);
      db.prepare('DELETE FROM content_domain_objects WHERE id IN (?, ?)')
        .run(binding.itemId, savedBinding.itemId);
    })()).not.toThrow();
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM content_legacy_idea_note_ingress_bindings
    `).get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM notes WHERE id = ?').get(sourceId))
      .toEqual({ count: 0 });
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM content_legacy_saved_idea_ingress_bindings
    `).get()).toEqual({ count: 0 });
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM content_legacy_saved_idea_quarantine
    `).get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM saved_ideas WHERE id IN (?, ?)')
      .get(savedSourceId, quarantinedSavedSourceId)).toEqual({ count: 0 });
    expect(db.pragma('foreign_key_check')).toEqual([]);

    expect(() => db.transaction(() => db.exec(DOWN))()).not.toThrow();
    expect(triggerCount(db, 'trg_notes_content_idea_insert_blocked')).toBe(0);
  });

  it('fails a replayed readiness assertion when retained source bytes no longer match the immutable ledger', () => {
    const sourceId = seedNote(db, {
      userId: 501,
      body: 'Original retained bytes',
      domain: 'content_idea',
      tags: null,
    });
    applyUp(db);

    db.exec('DROP TRIGGER trg_notes_content_idea_update_blocked;');
    db.prepare('UPDATE notes SET content = ? WHERE id = ?').run('Tampered retained bytes', sourceId);
    expect(readiness(db)).toMatchObject({
      exact_byte_hash_mismatch_count: 1,
      readiness_status: 'blocked',
    });
    expect(() => applyUp(db)).toThrow(/content_legacy_idea_note_253_readiness_failed/i);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('preserves scoped saved ideas with exact metadata and quarantines every unsafe source honestly', () => {
    const exactTitle = '\u00a0\u2003Build a multilingual creator series ☕  ';
    const scopedId = seedSavedIdea(db, {
      title: exactTitle,
      userId: 501,
      tenantId: 501,
      ownerUserId: 501,
      status: 'published',
      sourceDate: '2031-04-05',
      source: 'discovery',
      score: 91.25,
      workflowEligible: 1,
      angleTag: 'contrarian',
      niche: 'creator education',
      hookIdea: 'The common advice is backwards',
      whyNow: 'A platform policy changed',
      platformId: 'youtube',
      formatId: 'long_form',
      sourceIdsJson: '["source-a","source-b"]',
      auditMetadataJson: '{"privateDecision":"keep exact"}',
    });
    const fallbackId = seedSavedIdea(db, {
      title: 'Legacy fallback scope idea',
      userId: 777,
      tenantId: null,
      ownerUserId: null,
      status: 'saved',
    });
    const canonicalOwnerId = seedSavedIdea(db, {
      title: 'Canonical owner wins over stale user id',
      userId: 1,
      tenantId: 2,
      ownerUserId: 2,
      status: 'used',
    });
    const ownerlessId = seedSavedIdea(db, {
      title: 'Ownerless source',
      userId: 0,
      tenantId: 0,
      ownerUserId: 0,
      visibilityScope: 'platform_internal',
      scopeStatus: 'quarantined',
    });
    const tenantMemberId = seedSavedIdea(db, {
      title: 'Independent tenant membership',
      userId: 501,
      tenantId: 999,
      ownerUserId: 501,
    });
    const nonprivateId = seedSavedIdea(db, {
      title: 'Shared source cannot become private silently',
      userId: 501,
      tenantId: 501,
      ownerUserId: 501,
      visibilityScope: 'platform_internal',
    });
    const inactiveId = seedSavedIdea(db, {
      title: 'Archived source',
      userId: 501,
      tenantId: 501,
      ownerUserId: 501,
      scopeStatus: 'archived',
    });
    const blankId = seedSavedIdea(db, {
      title: '\u00a0\u2003\t\n',
      userId: 501,
      tenantId: 501,
      ownerUserId: 501,
    });

    applyUp(db);

    const bindings = db.prepare(`
      SELECT source_saved_idea_id AS sourceSavedIdeaId,
             tenant_id AS tenantId,
             owner_user_id AS ownerUserId,
             source_hash AS sourceHash,
             source_snapshot_json AS sourceSnapshotJson,
             item_id AS itemId,
             artifact_id AS artifactId,
             revision_id AS revisionId
        FROM content_legacy_saved_idea_ingress_bindings
       ORDER BY source_saved_idea_id
    `).all() as any[];
    expect(bindings).toHaveLength(4);
    expect(bindings.map((row) => row.sourceSavedIdeaId)).toEqual([
      scopedId,
      fallbackId,
      canonicalOwnerId,
      tenantMemberId,
    ]);
    expect(bindings.find((row) => row.sourceSavedIdeaId === scopedId)).toMatchObject({
      tenantId: 501,
      ownerUserId: 501,
    });
    expect(bindings.find((row) => row.sourceSavedIdeaId === fallbackId)).toMatchObject({
      tenantId: 777,
      ownerUserId: 777,
    });
    expect(bindings.find((row) => row.sourceSavedIdeaId === canonicalOwnerId)).toMatchObject({
      tenantId: 2,
      ownerUserId: 2,
    });
    expect(bindings.find((row) => row.sourceSavedIdeaId === tenantMemberId)).toMatchObject({
      tenantId: 999,
      ownerUserId: 501,
    });

    const scopedBinding = bindings.find((row) => row.sourceSavedIdeaId === scopedId)!;
    const snapshot = JSON.parse(scopedBinding.sourceSnapshotJson);
    expect(snapshot).toMatchObject({
      id: scopedId,
      title: exactTitle,
      sourceDate: '2031-04-05',
      status: 'published',
      source: 'discovery',
      score: 91.25,
      workflowEligible: 1,
      angleTag: 'contrarian',
      niche: 'creator education',
      hookIdea: 'The common advice is backwards',
      whyNow: 'A platform policy changed',
      userId: 501,
      tenantId: 501,
      ownerUserId: 501,
      visibilityScope: 'user_private',
      scopeStatus: 'active',
      auditMetadataRaw: '{"privateDecision":"keep exact"}',
      platformId: 'youtube',
      formatId: 'long_form',
      sourceIdsRaw: '["source-a","source-b"]',
    });
    expect(scopedBinding.sourceHash).toBe(sha256(scopedBinding.sourceSnapshotJson));

    const chain = db.prepare(`
      SELECT item.title AS itemTitle,
             item.production_state AS productionState,
             item.approval_state AS approvalState,
             item.review_required AS reviewRequired,
             item.current_artifact_id AS itemCurrentArtifactId,
             item.audit_metadata_json AS itemMetadataJson,
             artifact.artifact_type AS artifactType,
             artifact.current_revision_id AS artifactCurrentRevisionId,
             artifact.revision_count AS revisionCount,
             revision.content_text AS contentText,
             revision.content_hash AS contentHash,
             revision.provenance_json AS provenanceJson
        FROM content_domain_objects AS item
        JOIN content_artifacts AS artifact ON artifact.id = item.current_artifact_id
        JOIN content_revisions AS revision ON revision.id = artifact.current_revision_id
       WHERE item.id = ?
    `).get(scopedBinding.itemId) as any;
    expect(chain).toMatchObject({
      itemTitle: 'Build a multilingual creator series ☕',
      productionState: 'review',
      approvalState: 'required',
      reviewRequired: 1,
      itemCurrentArtifactId: scopedBinding.artifactId,
      artifactType: 'idea_note',
      artifactCurrentRevisionId: scopedBinding.revisionId,
      revisionCount: 1,
      contentText: exactTitle,
      contentHash: revisionHash(exactTitle),
    });
    expect(JSON.parse(chain.itemMetadataJson)).toMatchObject({
      migration: 'content_legacy_saved_idea_253',
      legacySavedIdeaId: scopedId,
      legacyStatusClaim: 'published',
      sourceHash: scopedBinding.sourceHash,
      legacySnapshot: snapshot,
    });
    expect(JSON.parse(chain.provenanceJson)).toMatchObject({
      migration: 'content_legacy_saved_idea_253',
      legacySavedIdeaId: scopedId,
      sourceHash: scopedBinding.sourceHash,
      legacySnapshot: snapshot,
    });

    expect(db.prepare(`
      SELECT source_saved_idea_id AS sourceSavedIdeaId,
             reason_code AS reasonCode
        FROM content_legacy_saved_idea_quarantine
       ORDER BY source_saved_idea_id
    `).all()).toEqual([
      { sourceSavedIdeaId: ownerlessId, reasonCode: 'ownerless_scope' },
      { sourceSavedIdeaId: nonprivateId, reasonCode: 'nonprivate_visibility' },
      { sourceSavedIdeaId: inactiveId, reasonCode: 'inactive_scope' },
      { sourceSavedIdeaId: blankId, reasonCode: 'blank_title' },
    ]);
    expect(savedIdeaReadiness(db)).toEqual({
      eligible_source_count: 4,
      bound_source_count: 4,
      unbound_eligible_source_count: 0,
      exact_metadata_hash_mismatch_count: 0,
      orphan_or_changed_binding_count: 0,
      quarantinable_source_count: 4,
      quarantined_source_count: 4,
      unquarantined_ineligible_source_count: 0,
      writer_guard_count: 2,
      source_delete_guard_count: 1,
      binding_guard_count: 3,
      quarantine_guard_count: 1,
      readiness_status: 'ready',
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM saved_ideas').get()).toEqual({ count: 8 });
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM content_workflow_events
       WHERE action = 'legacy_saved_idea_migrated'
    `).get()).toEqual({ count: 4 });
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('makes saved-idea parity idempotent and freezes every positive-user legacy writer', () => {
    const ownerId = seedSavedIdea(db, {
      title: 'Owner idea bytes  ',
      userId: 501,
      tenantId: 501,
      ownerUserId: 501,
      source: 'command',
      status: 'saved',
    });
    const foreignId = seedSavedIdea(db, {
      title: 'Foreign idea',
      userId: 777,
      tenantId: 777,
      ownerUserId: 777,
    });
    applyUp(db);

    const before = savedIdeaMigrationCounts(db);
    applyUp(db);
    expect(savedIdeaMigrationCounts(db)).toEqual(before);
    expect(before).toEqual({ items: 2, artifacts: 2, revisions: 2, bindings: 2, events: 2 });

    const owner = db.prepare(`
      SELECT * FROM content_legacy_saved_idea_ingress_bindings
       WHERE source_saved_idea_id = ?
    `).get(ownerId) as any;
    const foreign = db.prepare(`
      SELECT * FROM content_legacy_saved_idea_ingress_bindings
       WHERE source_saved_idea_id = ?
    `).get(foreignId) as any;

    const developedText = 'User-developed revision after the legacy snapshot';
    const developedRevisionId = Number(db.prepare(`
      INSERT INTO content_revisions (
        tenant_id, owner_user_id, artifact_id, revision_number,
        parent_revision_id, content_format, content_text, content_hash,
        change_summary, change_reason, actor_type, actor_id,
        provenance_json, created_by
      ) VALUES (
        501, 501, ?, 2,
        ?, 'plain_text', ?, ?,
        'Developed after import', 'user_edit', 'user', '501',
        '{"source":"user"}', 501
      )
    `).run(
      owner.artifact_id,
      owner.revision_id,
      developedText,
      revisionHash(developedText),
    ).lastInsertRowid);
    db.prepare(`
      UPDATE content_artifacts
         SET current_revision_id = ?, revision_count = 2
       WHERE id = ?
    `).run(developedRevisionId, owner.artifact_id);
    applyUp(db);
    expect(db.prepare(`
      SELECT current_revision_id AS currentRevisionId, revision_count AS revisionCount
        FROM content_artifacts WHERE id = ?
    `).get(owner.artifact_id)).toEqual({
      currentRevisionId: developedRevisionId,
      revisionCount: 2,
    });
    expect(savedIdeaReadiness(db)).toMatchObject({
      exact_metadata_hash_mismatch_count: 0,
      readiness_status: 'ready',
    });

    expect(() => db.prepare(`
      INSERT INTO content_legacy_saved_idea_ingress_bindings (
        tenant_id, owner_user_id, source_saved_idea_id, source_hash,
        source_snapshot_json, item_id, artifact_id, revision_id
      ) VALUES (777, 777, ?, ?, ?, ?, ?, ?)
    `).run(
      ownerId,
      owner.source_hash,
      owner.source_snapshot_json,
      foreign.item_id,
      foreign.artifact_id,
      foreign.revision_id,
    )).toThrow(/source scope, snapshot, or hash mismatch/i);
    expect(() => db.prepare(`
      UPDATE content_legacy_saved_idea_ingress_bindings
         SET source_hash = ? WHERE id = ?
    `).run('b'.repeat(64), owner.id)).toThrow(/immutable/i);
    expect(() => db.prepare(`
      DELETE FROM content_legacy_saved_idea_ingress_bindings WHERE id = ?
    `).run(owner.id)).toThrow(/immutable/i);
    expect(() => db.prepare('DELETE FROM saved_ideas WHERE id = ?').run(ownerId))
      .toThrow(/immutable outside account or legal erasure/i);

    expect(() => seedSavedIdea(db, {
      title: 'Parallel user idea',
      userId: 501,
      tenantId: 501,
      ownerUserId: 501,
    })).toThrow(/saved_ideas is read-only/i);
    expect(() => db.prepare('UPDATE saved_ideas SET status = ? WHERE id = ?')
      .run('used', ownerId)).toThrow(/saved_ideas is read-only/i);
    expect(() => seedSavedIdea(db, {
      title: 'Ownerless system fixture remains isolated',
      userId: 0,
      tenantId: 0,
      ownerUserId: 0,
      visibilityScope: 'platform_internal',
      scopeStatus: 'quarantined',
    })).toThrow(/saved_ideas is read-only/i);
    expect(savedIdeaReadiness(db)).toMatchObject({
      eligible_source_count: 2,
      bound_source_count: 2,
      exact_metadata_hash_mismatch_count: 0,
      readiness_status: 'ready',
    });
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('detects any retained saved-idea metadata mutation and keeps rollback snapshot-coupled', () => {
    const sourceId = seedSavedIdea(db, {
      title: 'Original exact idea',
      userId: 501,
      tenantId: 501,
      ownerUserId: 501,
      score: 42,
      hookIdea: 'Original hook',
    });
    applyUp(db);

    expect(() => db.transaction(() => db.exec(DOWN))())
      .toThrow(/content_legacy_idea_note_253_rollback_requires_exact_snapshot/i);
    db.exec('DROP TRIGGER trg_saved_ideas_legacy_user_update_blocked;');
    db.prepare('UPDATE saved_ideas SET score = ?, hook_idea = ? WHERE id = ?')
      .run(99, 'Tampered hook', sourceId);
    expect(savedIdeaReadiness(db)).toMatchObject({
      exact_metadata_hash_mismatch_count: 1,
      orphan_or_changed_binding_count: 1,
      readiness_status: 'blocked',
    });
    expect(() => applyUp(db)).toThrow(/content_legacy_idea_note_253_readiness_failed/i);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });
});

function seedNote(
  db: Database.Database,
  input: { userId: number; body: string; domain: string; tags: string | null },
): number {
  return Number(db.prepare(`
    INSERT INTO notes (user_id, content, domain, tags)
    VALUES (?, ?, ?, ?)
  `).run(input.userId, input.body, input.domain, input.tags).lastInsertRowid);
}

interface SavedIdeaSeed {
  title: string;
  userId: number;
  tenantId: number | null;
  ownerUserId: number | null;
  sourceDate?: string;
  status?: string;
  source?: string;
  score?: number;
  workflowEligible?: number;
  angleTag?: string | null;
  niche?: string | null;
  hookIdea?: string | null;
  whyNow?: string | null;
  visibilityScope?: string | null;
  scopeStatus?: string | null;
  platformId?: string | null;
  formatId?: string | null;
  sourceIdsJson?: string;
  auditMetadataJson?: string;
}

function seedSavedIdea(db: Database.Database, input: SavedIdeaSeed): number {
  return Number(db.prepare(`
    INSERT INTO saved_ideas (
      title, source_date, status, created_at,
      source, score, workflow_eligible, angle_tag, niche, hook_idea, why_now,
      user_id, tenant_id, owner_user_id, visibility_scope, lifecycle_state,
      scope_status, created_by, updated_by, audit_metadata_json,
      content_object_type, platform_id, format_id, source_ids_json,
      ontology_metadata_json, ontology_schema_version
    ) VALUES (
      ?, ?, ?, '2031-04-06T10:11:12.000Z',
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      'idea', ?, ?, ?,
      '{"legacyOntology":"exact"}', 'content-ontology-v1'
    )
  `).run(
    input.title,
    input.sourceDate ?? '2031-04-05',
    input.status ?? 'saved',
    input.source ?? 'manual',
    input.score ?? 0,
    input.workflowEligible ?? 0,
    input.angleTag ?? null,
    input.niche ?? null,
    input.hookIdea ?? null,
    input.whyNow ?? null,
    input.userId,
    input.tenantId,
    input.ownerUserId,
    input.visibilityScope ?? (input.userId > 0 ? 'user_private' : 'platform_internal'),
    input.status ?? 'saved',
    input.scopeStatus ?? (input.userId > 0 ? 'active' : 'quarantined'),
    input.ownerUserId ?? input.userId,
    input.ownerUserId ?? input.userId,
    input.auditMetadataJson ?? '{}',
    input.platformId ?? null,
    input.formatId ?? null,
    input.sourceIdsJson ?? '[]',
  ).lastInsertRowid);
}

function applyUp(db: Database.Database): void {
  db.transaction(() => db.exec(UP))();
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function revisionHash(value: string): string {
  return createHash('sha256')
    .update(JSON.stringify({ format: 'plain_text', text: value }))
    .digest('hex');
}

function readiness(db: Database.Database): Record<string, unknown> {
  return db.prepare('SELECT * FROM content_legacy_idea_note_workspace_readiness').get() as Record<string, unknown>;
}

function savedIdeaReadiness(db: Database.Database): Record<string, unknown> {
  return db.prepare('SELECT * FROM content_legacy_saved_idea_workspace_readiness').get() as Record<string, unknown>;
}

function migrationCounts(db: Database.Database): Record<string, number> {
  const scalar = (sql: string): number => Number((db.prepare(sql).get() as { count: number }).count);
  return {
    items: scalar(`
      SELECT COUNT(*) AS count FROM content_domain_objects
       WHERE json_extract(audit_metadata_json, '$.migration') = 'content_legacy_idea_note_253'
    `),
    artifacts: scalar(`
      SELECT COUNT(*) AS count FROM content_artifacts
       WHERE json_extract(metadata_json, '$.migration') = 'content_legacy_idea_note_253'
    `),
    revisions: scalar(`
      SELECT COUNT(*) AS count FROM content_revisions
       WHERE json_extract(provenance_json, '$.migration') = 'content_legacy_idea_note_253'
    `),
    bindings: scalar('SELECT COUNT(*) AS count FROM content_legacy_idea_note_ingress_bindings'),
    events: scalar(`
      SELECT COUNT(*) AS count FROM content_workflow_events
       WHERE action = 'legacy_content_idea_note_migrated'
    `),
  };
}

function savedIdeaMigrationCounts(db: Database.Database): Record<string, number> {
  const scalar = (sql: string): number => Number((db.prepare(sql).get() as { count: number }).count);
  return {
    items: scalar(`
      SELECT COUNT(*) AS count FROM content_domain_objects
       WHERE json_extract(audit_metadata_json, '$.migration') = 'content_legacy_saved_idea_253'
    `),
    artifacts: scalar(`
      SELECT COUNT(*) AS count FROM content_artifacts
       WHERE json_extract(metadata_json, '$.migration') = 'content_legacy_saved_idea_253'
    `),
    revisions: scalar(`
      SELECT COUNT(*) AS count FROM content_revisions
       WHERE json_extract(provenance_json, '$.migration') = 'content_legacy_saved_idea_253'
    `),
    bindings: scalar('SELECT COUNT(*) AS count FROM content_legacy_saved_idea_ingress_bindings'),
    events: scalar(`
      SELECT COUNT(*) AS count FROM content_workflow_events
       WHERE action = 'legacy_saved_idea_migrated'
    `),
  };
}

function authorizeErasure(db: Database.Database, userId: number): void {
  db.prepare(`
    INSERT INTO training_revision_erasure_authorizations (
      erasure_id, subject_user_id, reason, expires_at
    ) VALUES (?, ?, 'ACCOUNT_DELETION', datetime('now', '+5 minutes'))
  `).run(`legacy-idea-erasure-${userId}`, userId);
}

function triggerCount(db: Database.Database, name: string): number {
  return Number((db.prepare(`
    SELECT COUNT(*) AS count
      FROM sqlite_master
     WHERE type = 'trigger' AND name = ?
  `).get(name) as { count: number }).count);
}
