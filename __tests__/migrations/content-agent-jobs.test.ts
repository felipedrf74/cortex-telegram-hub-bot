// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createContentArtifact, createContentWorkspaceItem } from '../../src/services/content-workspace';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';

const DOWN = readFileSync(resolve(process.cwd(), 'migrations/down/242_content_agent_jobs.sql'), 'utf8');

describe('migration 242 canonical Content agent jobs', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createMigratedTestDatabase();
  });

  afterEach(() => db.close());

  it('installs one scoped job graph with immutable pinned inputs and proposal bytes', () => {
    const parent = seedParent(db, 501, 501, 'immutable');
    const job = insertJob(db, parent, 'immutable');
    const step = insertStep(db, job, 'writer', 2);
    const proposal = insertProposal(db, job, step, 'immutable');

    expect(() => db.prepare('UPDATE content_agent_jobs SET source_package_hash = ? WHERE id = ?')
      .run('f'.repeat(64), job.id)).toThrow('content agent job inputs are immutable');
    expect(() => db.prepare('UPDATE content_agent_job_steps SET dependency_group = 3 WHERE id = ?')
      .run(step.id)).toThrow('content agent job step identity is immutable');
    expect(() => db.prepare('UPDATE content_agent_proposals SET suggested_content_text = ? WHERE id = ?')
      .run('overwritten bytes', proposal.id)).toThrow('content agent proposal payload is immutable');

    db.prepare(`
      UPDATE content_agent_proposals
         SET status = 'rejected', decided_by = 501, decided_at = datetime('now')
       WHERE id = ?
    `).run(proposal.id);
    expect(() => db.prepare("UPDATE content_agent_proposals SET status = 'accepted' WHERE id = ?")
      .run(proposal.id)).toThrow('content agent proposal decision is terminal');
  });

  it('rejects cross-scope steps, revisions, and item/artifact stitching at the database boundary', () => {
    const owner = seedParent(db, 501, 501, 'owner');
    const other = seedParent(db, 777, 777, 'other');
    const ownerJob = insertJob(db, owner, 'owner');
    const otherJob = insertJob(db, other, 'other');
    const otherStep = insertStep(db, otherJob, 'writer', 2);

    expect(() => insertProposal(db, ownerJob, otherStep, 'cross-step')).toThrow(/FOREIGN KEY constraint failed/i);
    expect(() => db.prepare(`
      INSERT INTO content_agent_jobs (
        job_key, tenant_id, owner_user_id, item_id, artifact_id,
        source_package_id, source_package_hash, base_revision_id,
        base_revision_number, base_content_hash, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(
      'caj_cross_revision',
      owner.tenantId,
      owner.ownerUserId,
      owner.itemId,
      owner.artifactId,
      'package-cross',
      'a'.repeat(64),
      other.revisionId,
      owner.contentHash,
      owner.ownerUserId,
    )).toThrow(/FOREIGN KEY constraint failed/i);
    expect(() => db.prepare(`
      INSERT INTO content_agent_jobs (
        job_key, tenant_id, owner_user_id, item_id, artifact_id,
        source_package_id, source_package_hash, base_revision_id,
        base_revision_number, base_content_hash, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(
      'caj_cross_item',
      owner.tenantId,
      owner.ownerUserId,
      other.itemId,
      owner.artifactId,
      'package-cross-item',
      'b'.repeat(64),
      owner.revisionId,
      owner.contentHash,
      owner.ownerUserId,
    )).toThrow(/FOREIGN KEY constraint failed/i);

    const sameOwnerOtherArtifact = seedParent(db, 501, 501, 'same-owner-other-artifact');
    const ownerStep = insertStep(db, ownerJob, 'writer', 2);
    expect(() => db.prepare(`
      INSERT INTO content_agent_proposals (
        proposal_key, tenant_id, owner_user_id, job_id, step_id,
        proposal_role, artifact_id, base_revision_id, base_revision_number,
        base_content_hash, content_format, suggested_content_text,
        suggested_content_hash, title, summary, reason, created_by
      ) VALUES ('cap_cross_artifact', ?, ?, ?, ?, 'writer', ?, ?, 1, ?,
                'markdown', 'Cross artifact', ?, 'Draft', 'Summary', 'Reason', ?)
    `).run(
      owner.tenantId,
      owner.ownerUserId,
      ownerJob.id,
      ownerStep.id,
      sameOwnerOtherArtifact.artifactId,
      sameOwnerOtherArtifact.revisionId,
      sameOwnerOtherArtifact.contentHash,
      'c'.repeat(64),
      owner.ownerUserId,
    )).toThrow(/FOREIGN KEY constraint failed/i);
  });

  it('enforces legal execution and internally consistent terminal proposal decisions', () => {
    const parent = seedParent(db, 501, 501, 'decision-state');
    const job = insertJob(db, parent, 'decision-state');
    const step = insertStep(db, job, 'writer', 2);
    const proposal = insertProposal(db, job, step, 'decision-state');

    expect(() => db.prepare("UPDATE content_agent_jobs SET status = 'completed' WHERE id = ?")
      .run(job.id)).toThrow('invalid content agent job status transition');
    expect(() => db.prepare("UPDATE content_agent_job_steps SET status = 'completed' WHERE id = ?")
      .run(step.id)).toThrow('invalid content agent step status transition');
    expect(() => db.prepare(`
      UPDATE content_agent_proposals
         SET status = 'accepted', decided_by = ?, decided_at = datetime('now')
       WHERE id = ?
    `).run(parent.ownerUserId, proposal.id)).toThrow('content agent proposal decision is terminal');

    db.prepare(`
      UPDATE content_agent_proposals
         SET status = 'rejected', decided_by = ?, decided_at = datetime('now')
       WHERE id = ?
    `).run(parent.ownerUserId, proposal.id);
    expect(() => db.prepare("UPDATE content_agent_proposals SET decided_at = datetime('now', '+1 minute') WHERE id = ?")
      .run(proposal.id)).toThrow('content agent proposal decision metadata is immutable');
  });

  it('allows accepted-revision erasure but rejects a mismatched accepted revision pointer', () => {
    const parent = seedParent(db, 501, 501, 'erasure');
    const other = seedParent(db, 777, 777, 'erasure-other');
    const job = insertJob(db, parent, 'erasure');
    const step = insertStep(db, job, 'writer', 2);
    const proposal = insertProposal(db, job, step, 'erasure');
    const accepted = db.prepare(`
      INSERT INTO content_revisions (
        tenant_id, owner_user_id, artifact_id, revision_number,
        parent_revision_id, content_format, content_text, content_hash,
        actor_type, created_by
      ) VALUES (?, ?, ?, 2, ?, 'markdown', 'Accepted', ?, 'agent', ?)
    `).run(parent.tenantId, parent.ownerUserId, parent.artifactId, parent.revisionId, 'd'.repeat(64), parent.ownerUserId);

    expect(() => db.prepare(`
      UPDATE content_agent_proposals
         SET status = 'accepted', acceptance_kind = 'source_revision',
             accepted_artifact_id = ?, accepted_revision_id = ?,
             decided_by = ?, decided_at = datetime('now')
       WHERE id = ?
    `).run(parent.artifactId, other.revisionId, parent.ownerUserId, proposal.id))
      .toThrow('content agent accepted revision scope mismatch');

    db.prepare(`
      UPDATE content_agent_proposals
         SET status = 'accepted', acceptance_kind = 'source_revision',
             accepted_artifact_id = ?, accepted_revision_id = ?,
             decided_by = ?, decided_at = datetime('now')
       WHERE id = ?
    `).run(parent.artifactId, accepted.lastInsertRowid, parent.ownerUserId, proposal.id);

    expect(() => db.prepare('DELETE FROM content_revisions WHERE id = ?').run(accepted.lastInsertRowid))
      .toThrow(/immutable outside authorized erasure/i);
    db.prepare(`
      INSERT INTO training_revision_erasure_authorizations (
        erasure_id, subject_user_id, reason, expires_at
      ) VALUES ('content-agent-result-erasure', ?, 'ACCOUNT_DELETION', datetime('now', '+5 minutes'))
    `).run(parent.ownerUserId);
    db.prepare('DELETE FROM content_revisions WHERE id = ?').run(accepted.lastInsertRowid);
    expect(db.prepare('SELECT status, accepted_revision_id FROM content_agent_proposals WHERE id = ?').get(proposal.id))
      .toEqual({ status: 'accepted', accepted_revision_id: null });

    db.prepare('DELETE FROM content_domain_objects WHERE id = ?').run(parent.itemId);
    expect(db.prepare('SELECT COUNT(*) AS count FROM content_agent_jobs WHERE id = ?').get(job.id)).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM content_agent_proposals WHERE id = ?').get(proposal.id)).toEqual({ count: 0 });
  });

  it('refuses rollback without deleting agent decisions, proposals, or receipts', () => {
    const parent = seedParent(db, 501, 501, 'down-guard');
    const job = insertJob(db, parent, 'down-guard');
    const step = insertStep(db, job, 'writer', 2);
    const proposal = insertProposal(db, job, step, 'down-guard');
    db.prepare(`
      UPDATE content_agent_proposals
         SET status = 'rejected', decided_by = 501, decided_at = datetime('now')
       WHERE id = ?
    `).run(proposal.id);
    db.prepare(`
      INSERT INTO content_mutation_receipts (
        tenant_id, owner_user_id, operation, idempotency_key, request_hash,
        resource_type, resource_id, result_metadata_json
      ) VALUES
        (501, 501, 'create_content_agent_job', 'down-agent-job-001', ?, 'content_agent_job', ?, '{}'),
        (501, 501, 'reject_content_agent_proposal', 'down-agent-proposal-001', ?, 'content_agent_proposal', ?, '{}')
    `).run('a'.repeat(64), String(job.id), 'b'.repeat(64), String(proposal.id));

    expect(() => db.exec(DOWN)).toThrow(/content_agent_jobs_242_forward_only/);
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index','trigger')").all() as Array<{ name: string }>).map((row) => row.name);

    expect(names).toContain('content_agent_jobs');
    expect(names).toContain('content_agent_job_steps');
    expect(names).toContain('content_agent_proposals');
    expect(names).toContain('idx_content_revisions_agent_job_scope');
    expect(names).toContain('idx_content_artifacts_agent_job_scope');
    expect(names).toContain('content_revisions');
    expect(names).toContain('content_artifacts');
    expect(db.prepare('SELECT status, decided_by FROM content_agent_proposals WHERE id = ?').get(proposal.id))
      .toEqual({ status: 'rejected', decided_by: 501 });
    expect(db.prepare(`
      SELECT resource_type, resource_id
        FROM content_mutation_receipts
       WHERE idempotency_key LIKE 'down-agent-%'
       ORDER BY resource_type
    `).all()).toEqual([
      { resource_type: 'content_agent_job', resource_id: String(job.id) },
      { resource_type: 'content_agent_proposal', resource_id: String(proposal.id) },
    ]);
  });
});

interface ParentFixture {
  tenantId: number;
  ownerUserId: number;
  itemId: number;
  artifactId: number;
  revisionId: number;
  contentHash: string;
}

interface JobFixture extends ParentFixture { id: number }
interface StepFixture { id: number; jobId: number; tenantId: number; ownerUserId: number }

function seedParent(db: Database.Database, tenantId: number, ownerUserId: number, suffix: string): ParentFixture {
  const scope = { tenantId, userId: ownerUserId };
  const item = createContentWorkspaceItem({
    scope,
    itemType: 'content_item',
    title: `Migration parent ${suffix}`,
    idempotencyKey: `migration-item-${suffix}-001`,
  }, db).value;
  const artifact = createContentArtifact({
    scope,
    itemId: item.id,
    expectedWorkflowVersion: item.workflowVersion,
    artifactType: 'script',
    initialContent: { format: 'markdown', text: `Base ${suffix}` },
    idempotencyKey: `migration-artifact-${suffix}-001`,
  }, db).value;
  return {
    tenantId,
    ownerUserId,
    itemId: item.id,
    artifactId: artifact.id,
    revisionId: artifact.currentRevision!.id,
    contentHash: artifact.currentRevision!.contentHash,
  };
}

function insertJob(db: Database.Database, parent: ParentFixture, suffix: string): JobFixture {
  const result = db.prepare(`
    INSERT INTO content_agent_jobs (
      job_key, tenant_id, owner_user_id, item_id, artifact_id,
      source_package_id, source_package_hash, base_revision_id,
      base_revision_number, base_content_hash, created_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `).run(
    `caj_migration_${suffix}`,
    parent.tenantId,
    parent.ownerUserId,
    parent.itemId,
    parent.artifactId,
    `package-${suffix}`,
    'a'.repeat(64),
    parent.revisionId,
    parent.contentHash,
    parent.ownerUserId,
  );
  return { ...parent, id: Number(result.lastInsertRowid) };
}

function insertStep(
  db: Database.Database,
  job: JobFixture,
  role: 'writer',
  dependencyGroup: number,
): StepFixture {
  const result = db.prepare(`
    INSERT INTO content_agent_job_steps (
      tenant_id, owner_user_id, job_id, role, dependency_group
    ) VALUES (?, ?, ?, ?, ?)
  `).run(job.tenantId, job.ownerUserId, job.id, role, dependencyGroup);
  return {
    id: Number(result.lastInsertRowid),
    jobId: job.id,
    tenantId: job.tenantId,
    ownerUserId: job.ownerUserId,
  };
}

function insertProposal(
  db: Database.Database,
  job: JobFixture,
  step: StepFixture,
  suffix: string,
): { id: number } {
  const result = db.prepare(`
    INSERT INTO content_agent_proposals (
      proposal_key, tenant_id, owner_user_id, job_id, step_id,
      proposal_role, artifact_id, base_revision_id, base_revision_number,
      base_content_hash, content_format, suggested_content_text,
      suggested_content_hash, title, summary, reason, created_by
    ) VALUES (?, ?, ?, ?, ?, 'writer', ?, ?, 1, ?, 'markdown', ?, ?, ?, ?, ?, ?)
  `).run(
    `cap_migration_${suffix}`,
    job.tenantId,
    job.ownerUserId,
    job.id,
    step.id,
    job.artifactId,
    job.revisionId,
    job.contentHash,
    `Suggestion ${suffix}`,
    'c'.repeat(64),
    'Writer draft',
    'A safe alternative.',
    'Review before accepting.',
    job.ownerUserId,
  );
  return { id: Number(result.lastInsertRowid) };
}
