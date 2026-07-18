// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';

const UP = readFileSync(resolve(process.cwd(), 'migrations/251_content_workspace_integrity.sql'), 'utf8');
const DOWN = readFileSync(resolve(process.cwd(), 'migrations/down/251_content_workspace_integrity.sql'), 'utf8');
const EXCLUDE_251 = ['251_content_workspace_integrity.sql'];

describe('migration 251 canonical Content workspace integrity', () => {
  const databases: Database.Database[] = [];
  afterEach(() => databases.splice(0).forEach((db) => db.close()));

  it('enforces scoped, sequential revision lineage and coherent current pointers', () => {
    const db = tracked(createMigratedTestDatabase());
    const owner = seedItemWithArtifact(db, 101, 501, 'owner');
    const sameOwnerOtherItem = seedItemWithArtifact(db, 101, 501, 'same-owner-other-item');
    const foreign = seedItemWithArtifact(db, 202, 777, 'foreign');

    expect(() => insertRevision(db, owner, 2, foreign.revisionId, null, 'cross-scope parent'))
      .toThrow(/parent scope or sequence mismatch/i);

    const secondRevisionId = insertRevision(db, owner, 2, owner.revisionId, null, 'second');
    selectRevision(db, owner.artifactId, secondRevisionId, 2);

    expect(() => insertRevision(db, owner, 3, secondRevisionId, foreign.revisionId, 'cross-scope restore'))
      .toThrow(/restore source scope or sequence mismatch/i);

    const restoredRevisionId = insertRevision(db, owner, 3, secondRevisionId, owner.revisionId, 'restored');
    selectRevision(db, owner.artifactId, restoredRevisionId, 3);

    expect(() => db.prepare('UPDATE content_revisions SET parent_revision_id = NULL WHERE id = ?')
      .run(secondRevisionId)).toThrow(/immutable outside authorized erasure/i);
    expect(() => db.prepare('UPDATE content_domain_objects SET current_artifact_id = ? WHERE id = ?')
      .run(foreign.artifactId, owner.itemId)).toThrow(/current artifact scope mismatch/i);
    expect(() => db.prepare('UPDATE content_artifacts SET item_id = ? WHERE id = ?')
      .run(sameOwnerOtherItem.itemId, owner.artifactId)).toThrow(/scoped identity is immutable/i);
    expect(() => db.prepare(`
      UPDATE content_artifacts
         SET current_revision_id = ?, revision_count = 3
       WHERE id = ?
    `).run(foreign.revisionId, owner.artifactId)).toThrow(/current revision or count mismatch/i);
    expect(() => db.prepare(`
      UPDATE content_artifacts
         SET current_revision_id = ?, revision_count = 2
       WHERE id = ?
    `).run(restoredRevisionId, owner.artifactId)).toThrow(/current revision or count mismatch/i);
    expect(() => db.prepare('DELETE FROM content_revisions WHERE id = ?')
      .run(restoredRevisionId)).toThrow(/current content revision cannot be deleted/i);
    expect(() => db.prepare('DELETE FROM content_artifacts WHERE id = ?')
      .run(owner.artifactId)).toThrow(/must be unselected before deletion/i);

    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(() => db.exec(UP)).not.toThrow();
    expect(() => insertRevision(db, owner, 4, foreign.revisionId, null, 'still cross-scope'))
      .toThrow(/parent scope or sequence mismatch/i);
  });

  it('allows lineage nulling only through live account/legal erasure authorization', () => {
    const db = tracked(createMigratedTestDatabase());
    const owner = seedItemWithArtifact(db, 101, 501, 'lineage-erasure');
    const secondRevisionId = insertRevision(db, owner, 2, owner.revisionId, null, 'second');
    selectRevision(db, owner.artifactId, secondRevisionId, 2);
    const thirdRevisionId = insertRevision(db, owner, 3, secondRevisionId, owner.revisionId, 'restore');
    selectRevision(db, owner.artifactId, thirdRevisionId, 3);

    expect(() => db.prepare('DELETE FROM content_revisions WHERE id = ?').run(owner.revisionId))
      .toThrow(/immutable outside authorized erasure/i);
    expect(db.prepare(`
      SELECT parent_revision_id AS parentRevisionId
        FROM content_revisions WHERE id = ?
    `).get(secondRevisionId)).toEqual({ parentRevisionId: owner.revisionId });

    authorizeErasure(db, owner.ownerUserId, 'lineage-account-erasure', 'ACCOUNT_DELETION');
    expect(() => db.prepare('DELETE FROM content_revisions WHERE id = ?').run(owner.revisionId)).not.toThrow();
    expect(db.prepare(`
      SELECT parent_revision_id AS parentRevisionId
        FROM content_revisions WHERE id = ?
    `).get(secondRevisionId)).toEqual({ parentRevisionId: null });
    expect(db.prepare(`
      SELECT restored_from_revision_id AS restoredFromRevisionId
        FROM content_revisions WHERE id = ?
    `).get(thirdRevisionId)).toEqual({ restoredFromRevisionId: null });

    // Erasure is graph deletion, not a supported partially-rewritten steady
    // state. Deleting the owning item proves its real CASCADE path remains open.
    expect(() => db.prepare('DELETE FROM content_domain_objects WHERE id = ?').run(owner.itemId)).not.toThrow();
    expect(db.prepare('SELECT COUNT(*) AS count FROM content_revisions WHERE artifact_id = ?')
      .get(owner.artifactId)).toEqual({ count: 0 });
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('keeps accepted agent results scoped and permits FK nulling only during authorized erasure', () => {
    const db = tracked(createMigratedTestDatabase());
    const source = seedItemWithArtifact(db, 101, 501, 'proposal-source');
    const accepted = seedArtifactOnItem(db, source, 'platform_variant', 'proposal-accepted');
    const foreign = seedItemWithArtifact(db, 202, 777, 'proposal-foreign');
    const proposalId = seedAgentProposal(db, source, 'proposal-erasure');

    expect(() => acceptProposal(db, proposalId, foreign.artifactId, foreign.revisionId, source.ownerUserId))
      .toThrow(/accepted artifact scope mismatch|accepted revision scope mismatch/i);
    acceptProposal(db, proposalId, accepted.artifactId, accepted.revisionId, source.ownerUserId);

    expect(() => db.prepare(`
      UPDATE content_agent_proposals SET accepted_revision_id = NULL WHERE id = ?
    `).run(proposalId)).toThrow(/immutable outside authorized erasure/i);
    expect(() => db.prepare('DELETE FROM content_artifacts WHERE id = ?').run(accepted.artifactId))
      .toThrow(/immutable outside authorized erasure/i);

    db.prepare(`
      INSERT INTO training_revision_erasure_authorizations (
        erasure_id, subject_user_id, reason, expires_at
      ) VALUES ('expired-content-erasure', ?, 'LEGAL_ERASURE', datetime('now', '-1 minute'))
    `).run(source.ownerUserId);
    expect(() => db.prepare('DELETE FROM content_artifacts WHERE id = ?').run(accepted.artifactId))
      .toThrow(/immutable outside authorized erasure/i);

    authorizeErasure(db, source.ownerUserId, 'live-content-erasure', 'LEGAL_ERASURE');
    expect(() => db.prepare('DELETE FROM content_artifacts WHERE id = ?').run(accepted.artifactId)).not.toThrow();
    expect(db.prepare(`
      SELECT status, accepted_artifact_id AS acceptedArtifactId,
             accepted_revision_id AS acceptedRevisionId
        FROM content_agent_proposals WHERE id = ?
    `).get(proposalId)).toEqual({
      status: 'accepted',
      acceptedArtifactId: null,
      acceptedRevisionId: null,
    });
    expect(() => db.prepare(`
      UPDATE content_agent_proposals SET accepted_artifact_id = ? WHERE id = ?
    `).run(source.artifactId, proposalId)).toThrow(/immutable outside authorized erasure/i);

    expect(() => db.exec(UP)).not.toThrow();
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('preflights predecessor lineage and pointers before replacing any guard', () => {
    const db = tracked(createMigratedTestDatabase({ excludeFiles: EXCLUDE_251 }));
    const owner = seedItemWithArtifact(db, 101, 501, 'preflight-owner');
    const foreign = seedItemWithArtifact(db, 202, 777, 'preflight-foreign');
    const invalidRevisionId = insertRevision(db, owner, 2, foreign.revisionId, null, 'invalid predecessor');
    selectRevision(db, owner.artifactId, invalidRevisionId, 2);

    expect(() => db.exec(UP)).toThrow(/content_workspace_251_invalid_parent_lineage/i);
    expect(triggerCount(db, 'trg_content_revisions_lineage_scope_insert')).toBe(0);

    selectRevision(db, owner.artifactId, owner.revisionId, 1);
    db.prepare('DELETE FROM content_revisions WHERE id = ?').run(invalidRevisionId);
    db.prepare('UPDATE content_domain_objects SET current_artifact_id = ? WHERE id = ?')
      .run(foreign.artifactId, owner.itemId);
    expect(() => db.exec(UP)).toThrow(/content_workspace_251_invalid_current_artifact/i);

    db.prepare('UPDATE content_domain_objects SET current_artifact_id = ? WHERE id = ?')
      .run(owner.artifactId, owner.itemId);
    db.prepare('UPDATE content_artifacts SET current_revision_id = ? WHERE id = ?')
      .run(foreign.revisionId, owner.artifactId);
    expect(() => db.exec(UP)).toThrow(/content_workspace_251_invalid_current_revision/i);

    db.prepare('UPDATE content_artifacts SET current_revision_id = ? WHERE id = ?')
      .run(owner.revisionId, owner.artifactId);
    const proposalId = seedAgentProposal(db, owner, 'preflight-agent');
    acceptProposal(db, proposalId, owner.artifactId, owner.revisionId, owner.ownerUserId);
    db.exec(`
      DROP TRIGGER trg_content_agent_proposals_accepted_revision_scope_update;
      DROP TRIGGER trg_content_agent_proposals_revision_pointer;
      DROP TRIGGER trg_content_agent_proposals_artifact_pointer;
    `);
    db.prepare(`
      UPDATE content_agent_proposals
         SET accepted_artifact_id = ?, accepted_revision_id = ?
       WHERE id = ?
    `).run(foreign.artifactId, foreign.revisionId, proposalId);
    expect(() => db.exec(UP)).toThrow(/content_workspace_251_invalid_agent_result/i);

    db.prepare(`
      UPDATE content_agent_proposals
         SET accepted_artifact_id = ?, accepted_revision_id = ?
       WHERE id = ?
    `).run(owner.artifactId, owner.revisionId, proposalId);
    expect(() => db.exec(UP)).not.toThrow();
    expect(triggerCount(db, 'trg_content_revisions_lineage_scope_insert')).toBe(1);
    expect(triggerCount(db, 'trg_content_agent_proposals_accepted_result_scope_update')).toBe(1);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('blocks in-place rollback before removing any integrity guard', () => {
    const db = tracked(createMigratedTestDatabase());
    expect(DOWN).toMatch(/exact.*snapshot/i);
    expect(() => db.exec(DOWN)).toThrow(/content_workspace_251_rollback_requires_exact_snapshot/i);
    expect(triggerCount(db, 'trg_content_revisions_lineage_scope_insert')).toBe(1);
    expect(triggerCount(db, 'trg_content_agent_proposals_revision_pointer')).toBe(1);
  });

  function tracked(db: Database.Database): Database.Database {
    databases.push(db);
    return db;
  }
});

interface ArtifactFixture {
  tenantId: number;
  ownerUserId: number;
  itemId: number;
  artifactId: number;
  revisionId: number;
  contentHash: string;
}

function seedItemWithArtifact(
  db: Database.Database,
  tenantId: number,
  ownerUserId: number,
  suffix: string,
): ArtifactFixture {
  const itemId = Number(db.prepare(`
    INSERT INTO content_domain_objects (
      tenant_id, owner_user_id, visibility_scope, scope_status, object_type,
      lifecycle_state, title, created_by, updated_by
    ) VALUES (?, ?, 'user_private', 'active', 'content_item', 'active', ?, ?, ?)
  `).run(tenantId, ownerUserId, `Integrity ${suffix}`, ownerUserId, ownerUserId).lastInsertRowid);
  const fixture = seedArtifactOnItem(db, {
    tenantId,
    ownerUserId,
    itemId,
  }, 'script', suffix);
  db.prepare('UPDATE content_domain_objects SET current_artifact_id = ? WHERE id = ?')
    .run(fixture.artifactId, itemId);
  return fixture;
}

function seedArtifactOnItem(
  db: Database.Database,
  parent: Pick<ArtifactFixture, 'tenantId' | 'ownerUserId' | 'itemId'>,
  artifactType: 'script' | 'platform_variant',
  suffix: string,
): ArtifactFixture {
  const artifactId = Number(db.prepare(`
    INSERT INTO content_artifacts (
      tenant_id, owner_user_id, item_id, artifact_type, created_by, updated_by
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    parent.tenantId,
    parent.ownerUserId,
    parent.itemId,
    artifactType,
    parent.ownerUserId,
    parent.ownerUserId,
  ).lastInsertRowid);
  const contentHash = hashFor(suffix, 1);
  const revisionId = Number(db.prepare(`
    INSERT INTO content_revisions (
      tenant_id, owner_user_id, artifact_id, revision_number,
      content_format, content_text, content_hash, created_by
    ) VALUES (?, ?, ?, 1, 'markdown', ?, ?, ?)
  `).run(
    parent.tenantId,
    parent.ownerUserId,
    artifactId,
    `Revision ${suffix}`,
    contentHash,
    parent.ownerUserId,
  ).lastInsertRowid);
  selectRevision(db, artifactId, revisionId, 1);
  return { ...parent, artifactId, revisionId, contentHash };
}

function insertRevision(
  db: Database.Database,
  artifact: ArtifactFixture,
  revisionNumber: number,
  parentRevisionId: number | null,
  restoredFromRevisionId: number | null,
  suffix: string,
): number {
  return Number(db.prepare(`
    INSERT INTO content_revisions (
      tenant_id, owner_user_id, artifact_id, revision_number,
      parent_revision_id, restored_from_revision_id, content_format,
      content_text, content_hash, created_by
    ) VALUES (?, ?, ?, ?, ?, ?, 'markdown', ?, ?, ?)
  `).run(
    artifact.tenantId,
    artifact.ownerUserId,
    artifact.artifactId,
    revisionNumber,
    parentRevisionId,
    restoredFromRevisionId,
    `Revision ${suffix}`,
    hashFor(suffix, revisionNumber),
    artifact.ownerUserId,
  ).lastInsertRowid);
}

function selectRevision(
  db: Database.Database,
  artifactId: number,
  revisionId: number,
  revisionCount: number,
): void {
  db.prepare(`
    UPDATE content_artifacts
       SET current_revision_id = ?, revision_count = ?, updated_at = datetime('now')
     WHERE id = ?
  `).run(revisionId, revisionCount, artifactId);
}

function seedAgentProposal(db: Database.Database, source: ArtifactFixture, suffix: string): number {
  const jobId = Number(db.prepare(`
    INSERT INTO content_agent_jobs (
      job_key, tenant_id, owner_user_id, item_id, artifact_id,
      source_package_id, source_package_hash, base_revision_id,
      base_revision_number, base_content_hash, created_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `).run(
    `integrity-job-${suffix}`,
    source.tenantId,
    source.ownerUserId,
    source.itemId,
    source.artifactId,
    `integrity-package-${suffix}`,
    hashFor(`package-${suffix}`, 1),
    source.revisionId,
    source.contentHash,
    source.ownerUserId,
  ).lastInsertRowid);
  const stepId = Number(db.prepare(`
    INSERT INTO content_agent_job_steps (
      tenant_id, owner_user_id, job_id, role, dependency_group
    ) VALUES (?, ?, ?, 'platform_adapter', 3)
  `).run(source.tenantId, source.ownerUserId, jobId).lastInsertRowid);
  return Number(db.prepare(`
    INSERT INTO content_agent_proposals (
      proposal_key, tenant_id, owner_user_id, job_id, step_id,
      proposal_role, artifact_id, base_revision_id, base_revision_number,
      base_content_hash, content_format, suggested_content_text,
      suggested_content_hash, title, summary, reason, created_by
    ) VALUES (?, ?, ?, ?, ?, 'platform_adapter', ?, ?, 1, ?, 'markdown', ?, ?, ?, ?, ?, ?)
  `).run(
    `integrity-proposal-${suffix}`,
    source.tenantId,
    source.ownerUserId,
    jobId,
    stepId,
    source.artifactId,
    source.revisionId,
    source.contentHash,
    `Adapted ${suffix}`,
    hashFor(`proposal-${suffix}`, 1),
    'Adapted draft',
    'Platform-specific adaptation.',
    'Review before accepting.',
    source.ownerUserId,
  ).lastInsertRowid);
}

function acceptProposal(
  db: Database.Database,
  proposalId: number,
  artifactId: number,
  revisionId: number,
  actorUserId: number,
): void {
  db.prepare(`
    UPDATE content_agent_proposals
       SET status = 'accepted', acceptance_kind = 'platform_variant',
           accepted_artifact_id = ?, accepted_revision_id = ?,
           decided_by = ?, decided_at = datetime('now')
     WHERE id = ?
  `).run(artifactId, revisionId, actorUserId, proposalId);
}

function authorizeErasure(
  db: Database.Database,
  userId: number,
  erasureId: string,
  reason: 'ACCOUNT_DELETION' | 'LEGAL_ERASURE',
): void {
  db.prepare(`
    INSERT INTO training_revision_erasure_authorizations (
      erasure_id, subject_user_id, reason, expires_at
    ) VALUES (?, ?, ?, datetime('now', '+5 minutes'))
  `).run(erasureId, userId, reason);
}

function hashFor(suffix: string, ordinal: number): string {
  return `${suffix}-${ordinal}`.replace(/[^a-zA-Z0-9]/g, 'a').padEnd(64, '0').slice(0, 64);
}

function triggerCount(db: Database.Database, name: string): number {
  return Number((db.prepare(`
    SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name = ?
  `).get(name) as { count: number }).count);
}
