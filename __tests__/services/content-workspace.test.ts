import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ContentWorkspaceError,
  createContentArtifact,
  createContentItemRelationship,
  createContentWorkspaceItem,
  duplicateContentWorkspaceItem,
  getContentWorkspaceItem,
  getContentWorkspaceItemDetail,
  listContentRevisions,
  listContentWorkspaceItems,
  queryContentRevisions,
  removeContentItemRelationship,
  reorderContentItemRelationship,
  restoreContentRevision,
  saveContentRevision,
  transitionContentWorkspaceItem,
  type ContentWorkspaceScope,
} from '../../src/services/content-workspace';
import { _resetContentWorkspaceObservabilityForTests } from '../../src/services/content-workspace-observability';

const MIGRATIONS = [
  readFileSync(resolve(process.cwd(), 'migrations/240_content_workspace_domain.sql'), 'utf8'),
  readFileSync(resolve(process.cwd(), 'migrations/241_content_workspace_library.sql'), 'utf8'),
  readFileSync(resolve(process.cwd(), 'migrations/243_content_artifact_relationships.sql'), 'utf8'),
];
const OWNER: ContentWorkspaceScope = { tenantId: 101, userId: 501 };
const OTHER_TENANT: ContentWorkspaceScope = { tenantId: 202, userId: 501 };
const OTHER_USER: ContentWorkspaceScope = { tenantId: 101, userId: 777 };

describe('content workspace canonical domain', () => {
  let db: Database.Database;

  beforeEach(() => {
    _resetContentWorkspaceObservabilityForTests();
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    seedSchema(db);
  });

  afterEach(() => db.close());

  it('idempotently creates one scoped root and rejects key reuse with changed input', () => {
    const first = createContentWorkspaceItem({
      scope: OWNER,
      itemType: 'content_item',
      title: 'Retention teardown',
      summary: 'Explain why intros lose viewers.',
      idempotencyKey: 'capture-retention-001',
    }, db);
    const replay = createContentWorkspaceItem({
      scope: OWNER,
      itemType: 'content_item',
      title: 'Retention teardown',
      summary: 'Explain why intros lose viewers.',
      idempotencyKey: 'capture-retention-001',
    }, db);

    expect(first).toMatchObject({ created: true, replayed: false });
    expect(replay).toMatchObject({ created: false, replayed: true });
    expect(replay.value.id).toBe(first.value.id);
    expect(db.prepare("SELECT COUNT(*) AS count FROM content_domain_objects WHERE object_type = 'content_item'").get())
      .toEqual({ count: 1 });

    expect(() => createContentWorkspaceItem({
      scope: OWNER,
      itemType: 'content_item',
      title: 'Changed title',
      idempotencyKey: 'capture-retention-001',
    }, db)).toThrowError(expect.objectContaining<Partial<ContentWorkspaceError>>({ code: 'CONTENT_IDEMPOTENCY_KEY_REUSED' }));
  });

  it('rejects unsafe scope identifiers and control-bearing workspace replay keys', () => {
    expect(() => createContentWorkspaceItem({
      scope: { tenantId: Number.MAX_SAFE_INTEGER + 1, userId: OWNER.userId },
      itemType: 'content_item',
      title: 'Unsafe scope',
      idempotencyKey: 'unsafe-scope-001',
    }, db)).toThrowError(expect.objectContaining<Partial<ContentWorkspaceError>>({
      code: 'CONTENT_SCOPE_REQUIRED',
      status: 401,
    }));

    expect(() => createContentWorkspaceItem({
      scope: OWNER,
      itemType: 'content_item',
      title: 'Control-bearing replay key',
      idempotencyKey: 'workspace-key\nsecond-line',
    }, db)).toThrowError(expect.objectContaining<Partial<ContentWorkspaceError>>({
      code: 'CONTENT_VALIDATION_FAILED',
      status: 400,
    }));
  });

  it('keeps every read and relationship inside the authenticated tenant and owner scope', () => {
    const item = createItem(db, 'Scoped idea', 'scoped-item-0001').value;
    expect(getContentWorkspaceItem(OTHER_TENANT, item.id, db)).toBeNull();
    expect(getContentWorkspaceItem(OTHER_USER, item.id, db)).toBeNull();
    expect(listContentWorkspaceItems({ scope: OTHER_TENANT }, db)).toEqual([]);

    const attackerProject = createContentWorkspaceItem({
      scope: OTHER_TENANT,
      itemType: 'project',
      title: 'Other tenant project',
      idempotencyKey: 'other-project-001',
    }, db).value;
    expect(() => createContentItemRelationship({
      scope: OWNER,
      fromItemId: attackerProject.id,
      toItemId: item.id,
      relationshipType: 'contains',
      idempotencyKey: 'cross-scope-rel-001',
    }, db)).toThrowError(expect.objectContaining<Partial<ContentWorkspaceError>>({ code: 'CONTENT_ITEM_NOT_FOUND' }));
  });

  it('creates typed artifacts, advances the item phase, and returns a user-facing next action', () => {
    const item = createItem(db, 'Teach the operator loop', 'artifact-item-001').value;
    const result = createContentArtifact({
      scope: OWNER,
      itemId: item.id,
      expectedWorkflowVersion: item.workflowVersion,
      artifactType: 'brief',
      title: 'Operator loop brief',
      initialContent: { format: 'structured_json', document: { objective: 'teach', audience: 'founders' } },
      changeSummary: 'Initial brief',
      idempotencyKey: 'artifact-brief-001',
    }, db);
    const replay = createContentArtifact({
      scope: OWNER,
      itemId: item.id,
      expectedWorkflowVersion: item.workflowVersion,
      artifactType: 'brief',
      title: 'Operator loop brief',
      initialContent: { format: 'structured_json', document: { audience: 'founders', objective: 'teach' } },
      changeSummary: 'Initial brief',
      idempotencyKey: 'artifact-brief-001',
    }, db);
    const updated = getContentWorkspaceItem(OWNER, item.id, db)!;

    expect(result.value).toMatchObject({ artifactType: 'brief', revisionCount: 1 });
    expect(result.value.currentRevision?.content).toEqual({
      format: 'structured_json',
      document: { audience: 'founders', objective: 'teach' },
    });
    expect(replay).toMatchObject({ replayed: true, created: false });
    expect(updated).toMatchObject({
      artifactPhase: 'brief',
      productionState: 'active',
      currentArtifactId: result.value.id,
      nextAction: { action: 'create_outline', label: 'Create an outline' },
    });

    const outline = createContentArtifact({
      scope: OWNER,
      itemId: item.id,
      expectedWorkflowVersion: updated.workflowVersion,
      artifactType: 'outline',
      sourceArtifactId: result.value.id,
      initialContent: { format: 'structured_json', document: { sections: ['Hook', 'Proof', 'CTA'] } },
      idempotencyKey: 'artifact-outline-derived-002',
    }, db).value;
    expect(getContentWorkspaceItemDetail(OWNER, item.id, db)?.artifactRelationships).toEqual([
      expect.objectContaining({
        fromArtifactId: outline.id,
        toArtifactId: result.value.id,
        relationshipType: 'derived_from',
        metadata: { source: 'progressive_content_development' },
      }),
    ]);
  });

  it('rejects a progressive artifact source outside the target item or tenant', () => {
    const target = createItem(db, 'Target item', 'artifact-source-target-001').value;
    const otherItemArtifact = createScriptArtifact(db);
    expect(() => createContentArtifact({
      scope: OWNER,
      itemId: target.id,
      expectedWorkflowVersion: target.workflowVersion,
      artifactType: 'outline',
      sourceArtifactId: otherItemArtifact.id,
      idempotencyKey: 'artifact-source-other-item-001',
    }, db)).toThrowError(expect.objectContaining<Partial<ContentWorkspaceError>>({
      code: 'CONTENT_SOURCE_ARTIFACT_INVALID',
    }));

    const foreignItem = createContentWorkspaceItem({
      scope: OTHER_TENANT,
      itemType: 'content_item',
      title: 'Foreign source',
      idempotencyKey: 'artifact-source-foreign-item-001',
    }, db).value;
    const foreignArtifact = createContentArtifact({
      scope: OTHER_TENANT,
      itemId: foreignItem.id,
      expectedWorkflowVersion: foreignItem.workflowVersion,
      artifactType: 'brief',
      idempotencyKey: 'artifact-source-foreign-artifact-001',
    }, db).value;
    expect(() => createContentArtifact({
      scope: OWNER,
      itemId: target.id,
      expectedWorkflowVersion: target.workflowVersion,
      artifactType: 'outline',
      sourceArtifactId: foreignArtifact.id,
      idempotencyKey: 'artifact-source-foreign-attempt-001',
    }, db)).toThrowError(expect.objectContaining<Partial<ContentWorkspaceError>>({
      code: 'CONTENT_SOURCE_ARTIFACT_NOT_FOUND',
    }));
  });

  it('uses baseRevision CAS, rejects stale saves, and does not create duplicate revisions', () => {
    const artifact = createScriptArtifact(db);
    const saved = saveContentRevision({
      scope: OWNER,
      artifactId: artifact.id,
      baseRevision: 1,
      content: { format: 'markdown', text: '# Better hook\nProof before explanation.' },
      changeSummary: 'Tightened hook',
      idempotencyKey: 'save-script-rev-002',
    }, db);

    expect(saved.value).toMatchObject({ revisionNumber: 2, parentRevisionId: artifact.currentRevisionId });
    expect(() => saveContentRevision({
      scope: OWNER,
      artifactId: artifact.id,
      baseRevision: 1,
      content: { format: 'markdown', text: '# Stale overwrite' },
      idempotencyKey: 'save-script-stale-003',
    }, db)).toThrowError(expect.objectContaining<Partial<ContentWorkspaceError>>({ code: 'CONTENT_REVISION_CONFLICT' }));

    const noChange = saveContentRevision({
      scope: OWNER,
      artifactId: artifact.id,
      baseRevision: 2,
      content: { format: 'markdown', text: '# Better hook\nProof before explanation.' },
      idempotencyKey: 'save-script-noop-004',
    }, db);
    expect(noChange).toMatchObject({ created: false, replayed: false });
    expect(listContentRevisions(OWNER, artifact.id, db)).toHaveLength(2);
    expect(db.prepare('SELECT COUNT(*) AS count FROM content_revisions WHERE artifact_id = ?').get(artifact.id))
      .toEqual({ count: 2 });
  });

  it('invalidates approval on saved edits and never selects an older artifact as a save side effect', () => {
    const primary = createScriptArtifact(db);
    const afterPrimary = getContentWorkspaceItem(OWNER, primary.itemId, db)!;
    const secondary = createContentArtifact({
      scope: OWNER,
      itemId: primary.itemId,
      expectedWorkflowVersion: afterPrimary.workflowVersion,
      artifactType: 'caption',
      title: 'Optional caption',
      initialContent: { format: 'plain_text', text: 'Caption v1' },
      makeCurrent: false,
      idempotencyKey: 'secondary-caption-artifact-001',
    }, db).value;
    const afterSecondary = getContentWorkspaceItem(OWNER, primary.itemId, db)!;
    expect(afterSecondary.currentArtifactId).toBe(primary.id);

    const inReview = transitionContentWorkspaceItem({
      scope: OWNER,
      itemId: primary.itemId,
      targetState: 'review',
      expectedWorkflowVersion: afterSecondary.workflowVersion,
      idempotencyKey: 'approval-invalidation-review-001',
    }, db).value;
    const approved = transitionContentWorkspaceItem({
      scope: OWNER,
      itemId: primary.itemId,
      targetState: 'approved',
      expectedWorkflowVersion: inReview.workflowVersion,
      idempotencyKey: 'approval-invalidation-approved-001',
    }, db).value;

    saveContentRevision({
      scope: OWNER,
      artifactId: secondary.id,
      baseRevision: 1,
      content: { format: 'plain_text', text: 'Caption v2 after approval' },
      idempotencyKey: 'approval-invalidation-save-001',
    }, db);

    const invalidated = getContentWorkspaceItem(OWNER, primary.itemId, db)!;
    expect(invalidated).toMatchObject({
      currentArtifactId: primary.id,
      productionState: 'review',
      workflowVersion: approved.workflowVersion + 1,
      nextAction: { action: 'review_content' },
    });
    expect(db.prepare(`
      SELECT approval_state, review_required, approved_by, approved_at,
             review_reason_codes_json
        FROM content_domain_objects WHERE id = ?
    `).get(primary.itemId)).toEqual({
      approval_state: 'required',
      review_required: 1,
      approved_by: null,
      approved_at: null,
      review_reason_codes_json: '["content_changed_after_approval"]',
    });
    expect(() => transitionContentWorkspaceItem({
      scope: OWNER,
      itemId: primary.itemId,
      targetState: 'approved',
      expectedWorkflowVersion: approved.workflowVersion,
      idempotencyKey: 'approval-invalidation-stale-review-001',
    }, db)).toThrowError(expect.objectContaining<Partial<ContentWorkspaceError>>({
      code: 'CONTENT_WORKFLOW_VERSION_CONFLICT',
    }));
  });

  it('paginates immutable revision history without replaying a newly appended head revision', () => {
    const artifact = createScriptArtifact(db);
    for (let revision = 2; revision <= 4; revision += 1) {
      saveContentRevision({
        scope: OWNER,
        artifactId: artifact.id,
        baseRevision: revision - 1,
        content: { format: 'markdown', text: `# Revision ${revision}` },
        idempotencyKey: `revision-page-save-${revision}-001`,
      }, db);
    }

    const first = queryContentRevisions(OWNER, artifact.id, { limit: 2 }, db);
    expect(first.revisions.map((revision) => revision.revisionNumber)).toEqual([4, 3]);
    expect(first).toMatchObject({ hasMore: true });

    saveContentRevision({
      scope: OWNER,
      artifactId: artifact.id,
      baseRevision: 4,
      content: { format: 'markdown', text: '# Revision 5 appended on another device' },
      idempotencyKey: 'revision-page-save-5-001',
    }, db);

    const second = queryContentRevisions(OWNER, artifact.id, {
      cursor: first.nextCursor!,
      limit: 2,
    }, db);
    expect(second.revisions.map((revision) => revision.revisionNumber)).toEqual([2, 1]);
    expect(second).toMatchObject({ hasMore: false, nextCursor: null });
    expect(new Set([...first.revisions, ...second.revisions].map((revision) => revision.id)).size).toBe(4);
  });

  it('requires item CAS before adding or selecting an artifact', () => {
    const item = createItem(db, 'Artifact CAS', 'artifact-cas-item-001').value;
    createContentArtifact({
      scope: OWNER,
      itemId: item.id,
      expectedWorkflowVersion: item.workflowVersion,
      artifactType: 'brief',
      initialContent: { format: 'plain_text', text: 'Current brief' },
      idempotencyKey: 'artifact-cas-first-001',
    }, db);

    expect(() => createContentArtifact({
      scope: OWNER,
      itemId: item.id,
      expectedWorkflowVersion: item.workflowVersion,
      artifactType: 'script',
      initialContent: { format: 'plain_text', text: 'Stale script' },
      idempotencyKey: 'artifact-cas-stale-001',
    }, db)).toThrowError(expect.objectContaining<Partial<ContentWorkspaceError>>({
      code: 'CONTENT_WORKFLOW_VERSION_CONFLICT',
    }));
    expect(getContentWorkspaceItem(OWNER, item.id, db)?.artifactCount).toBe(1);
  });

  it('restores an old revision by appending a new immutable revision', () => {
    const artifact = createScriptArtifact(db);
    const originalId = artifact.currentRevision!.id;
    saveContentRevision({
      scope: OWNER,
      artifactId: artifact.id,
      baseRevision: 1,
      content: { format: 'markdown', text: 'Second draft' },
      idempotencyKey: 'save-before-restore-001',
    }, db);
    const restored = restoreContentRevision({
      scope: OWNER,
      artifactId: artifact.id,
      sourceRevisionId: originalId,
      baseRevision: 2,
      idempotencyKey: 'restore-original-001',
    }, db);

    expect(restored.value).toMatchObject({
      revisionNumber: 3,
      restoredFromRevisionId: originalId,
      content: { format: 'markdown', text: '# Hook\nOriginal draft.' },
    });
    expect(listContentRevisions(OWNER, artifact.id, db).map((revision) => revision.revisionNumber)).toEqual([3, 2, 1]);
    expect(() => db.prepare('UPDATE content_revisions SET content_text = ? WHERE id = ?')
      .run('destructive overwrite', restored.value.id)).toThrow('content revisions are immutable');

    expect(() => db.prepare('DELETE FROM content_domain_objects WHERE id = ?').run(artifact.itemId)).not.toThrow();
    expect(db.prepare('SELECT COUNT(*) AS count FROM content_revisions WHERE artifact_id = ?').get(artifact.id))
      .toEqual({ count: 0 });
  });

  it('moves items through explicit states with workflow-version conflict protection', () => {
    const artifact = createScriptArtifact(db);
    const detail = getContentWorkspaceItemDetail(OWNER, artifact.itemId, db)!;
    const review = transitionContentWorkspaceItem({
      scope: OWNER,
      itemId: detail.id,
      targetState: 'review',
      expectedWorkflowVersion: detail.workflowVersion,
      idempotencyKey: 'transition-review-001',
    }, db);
    expect(review.value).toMatchObject({
      productionState: 'review',
      nextAction: { action: 'review_content', label: 'Review content' },
    });

    expect(() => transitionContentWorkspaceItem({
      scope: OWNER,
      itemId: detail.id,
      targetState: 'approved',
      expectedWorkflowVersion: detail.workflowVersion,
      idempotencyKey: 'transition-stale-002',
    }, db)).toThrowError(expect.objectContaining<Partial<ContentWorkspaceError>>({ code: 'CONTENT_WORKFLOW_VERSION_CONFLICT' }));

    const approved = transitionContentWorkspaceItem({
      scope: OWNER,
      itemId: detail.id,
      targetState: 'approved',
      expectedWorkflowVersion: review.value.workflowVersion,
      idempotencyKey: 'transition-approved-003',
    }, db);
    expect(approved.value).toMatchObject({
      productionState: 'approved',
      artifactPhase: 'final',
      nextAction: { action: 'schedule_work', label: 'Reserve work time' },
    });
  });

  it('labels imported scheduled and published states as internal and unverified', () => {
    const scheduled = createItem(db, 'Imported scheduled item', 'legacy-scheduled-item-001').value;
    const published = createItem(db, 'Imported published item', 'legacy-published-item-001').value;
    db.prepare('UPDATE content_domain_objects SET production_state = ? WHERE id = ?')
      .run('scheduled', scheduled.id);
    db.prepare('UPDATE content_domain_objects SET production_state = ? WHERE id = ?')
      .run('published', published.id);

    expect(getContentWorkspaceItem(OWNER, scheduled.id, db)?.nextAction).toEqual({
      action: 'prepare_publish',
      label: 'Review internal scheduled-state work',
      reason: 'This legacy internal state is not proof of a publication schedule or external post.',
    });
    expect(getContentWorkspaceItem(OWNER, published.id, db)?.nextAction).toEqual({
      action: 'repurpose_content',
      label: 'Review internally completed work',
      reason: 'This legacy internal state is not proof that the work was published externally.',
    });
  });

  it('blocks review without a saved revision and fails closed on revision integrity errors', () => {
    const item = createItem(db, 'Unsaved draft', 'unsaved-review-item-001').value;
    const artifact = createContentArtifact({
      scope: OWNER,
      itemId: item.id,
      expectedWorkflowVersion: item.workflowVersion,
      artifactType: 'script',
      idempotencyKey: 'unsaved-review-artifact-001',
    }, db).value;
    const active = getContentWorkspaceItem(OWNER, item.id, db)!;

    expect(() => transitionContentWorkspaceItem({
      scope: OWNER,
      itemId: item.id,
      targetState: 'review',
      expectedWorkflowVersion: active.workflowVersion,
      idempotencyKey: 'unsaved-review-transition-001',
    }, db)).toThrowError(expect.objectContaining<Partial<ContentWorkspaceError>>({ code: 'CONTENT_STATE_REQUIRES_SAVED_REVISION' }));

    const corrupt = db.prepare(`
      INSERT INTO content_revisions (
        tenant_id, owner_user_id, artifact_id, revision_number,
        content_format, content_text, content_hash, actor_type, created_by
      ) VALUES (?, ?, ?, 1, 'plain_text', 'Corrupted content', ?, 'user', ?)
    `).run(OWNER.tenantId, OWNER.userId, artifact.id, '0'.repeat(64), OWNER.userId);
    db.prepare('UPDATE content_artifacts SET current_revision_id = ?, revision_count = 1 WHERE id = ?')
      .run(corrupt.lastInsertRowid, artifact.id);

    expect(() => getContentWorkspaceItemDetail(OWNER, item.id, db))
      .toThrowError(expect.objectContaining<Partial<ContentWorkspaceError>>({ code: 'CONTENT_REVISION_INTEGRITY_FAILED' }));
  });

  it('models projects and derivation links without creating another root table', () => {
    const project = createContentWorkspaceItem({
      scope: OWNER,
      itemType: 'project',
      title: 'Creator systems campaign',
      idempotencyKey: 'project-campaign-001',
    }, db).value;
    expect(project.nextAction).toMatchObject({ action: 'add_content_item', label: 'Add content' });
    const item = createItem(db, 'Operator loop video', 'project-item-001').value;
    const contains = createContentItemRelationship({
      scope: OWNER,
      fromItemId: project.id,
      toItemId: item.id,
      relationshipType: 'contains',
      position: 0,
      idempotencyKey: 'project-contains-001',
    }, db);
    const replay = createContentItemRelationship({
      scope: OWNER,
      fromItemId: project.id,
      toItemId: item.id,
      relationshipType: 'contains',
      position: 0,
      idempotencyKey: 'project-contains-001',
    }, db);

    expect(contains).toMatchObject({ created: true, replayed: false });
    expect(replay).toMatchObject({ created: false, replayed: true });
    expect(getContentWorkspaceItemDetail(OWNER, project.id, db)?.relationships).toEqual([
      expect.objectContaining({ relationshipType: 'contains', toItemId: item.id }),
    ]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'content_items'").get()).toBeUndefined();

    expect(() => createContentItemRelationship({
      scope: OWNER,
      fromItemId: item.id,
      toItemId: project.id,
      relationshipType: 'contains',
      idempotencyKey: 'invalid-contains-001',
    }, db)).toThrowError(expect.objectContaining<Partial<ContentWorkspaceError>>({ code: 'CONTENT_RELATIONSHIP_INVALID' }));

    expect(() => createContentArtifact({
      scope: OWNER,
      itemId: project.id,
      expectedWorkflowVersion: project.workflowVersion,
      artifactType: 'script',
      idempotencyKey: 'invalid-project-artifact-001',
    }, db)).toThrowError(expect.objectContaining<Partial<ContentWorkspaceError>>({ code: 'CONTENT_ARTIFACT_PARENT_INVALID' }));
  });

  it('reorders and removes project relationships with CAS, scoped replay, and one version advance', () => {
    const project = createContentWorkspaceItem({
      scope: OWNER,
      itemType: 'project',
      title: 'Ordered campaign',
      idempotencyKey: 'ordered-project-001',
    }, db).value;
    const items = [
      createItem(db, 'First', 'ordered-item-first-001').value,
      createItem(db, 'Second', 'ordered-item-second-001').value,
      createItem(db, 'Third', 'ordered-item-third-001').value,
    ];
    const relationships = items.map((item, index) => createContentItemRelationship({
      scope: OWNER,
      fromItemId: project.id,
      toItemId: item.id,
      relationshipType: 'contains',
      position: index,
      idempotencyKey: `ordered-relationship-${index}-001`,
    }, db).value);

    const reorderInput = {
      scope: OWNER,
      relationshipId: relationships[2].id,
      expectedFromWorkflowVersion: project.workflowVersion,
      position: 0,
      idempotencyKey: 'ordered-reorder-third-001',
    } as const;
    const reordered = reorderContentItemRelationship(reorderInput, db);
    const replay = reorderContentItemRelationship(reorderInput, db);
    const afterReorder = getContentWorkspaceItemDetail(OWNER, project.id, db)!;

    expect(reordered).toMatchObject({ replayed: false, changed: true, value: { id: relationships[2].id, position: 0 } });
    expect(replay).toMatchObject({ replayed: true, changed: true, value: reordered.value });
    expect(afterReorder.workflowVersion).toBe(project.workflowVersion + 1);
    expect(afterReorder.relationships.map((relationship) => [relationship.toItemId, relationship.position])).toEqual([
      [items[2].id, 0],
      [items[0].id, 1],
      [items[1].id, 2],
    ]);

    expect(() => reorderContentItemRelationship({
      scope: OWNER,
      relationshipId: relationships[0].id,
      expectedFromWorkflowVersion: project.workflowVersion,
      position: 0,
      idempotencyKey: 'ordered-reorder-stale-001',
    }, db)).toThrowError(expect.objectContaining<Partial<ContentWorkspaceError>>({ code: 'CONTENT_WORKFLOW_VERSION_CONFLICT' }));

    const removalInput = {
      scope: OWNER,
      relationshipId: relationships[1].id,
      expectedFromWorkflowVersion: afterReorder.workflowVersion,
      idempotencyKey: 'ordered-remove-second-001',
    } as const;
    const removed = removeContentItemRelationship(removalInput, db);
    const removedReplay = removeContentItemRelationship(removalInput, db);
    expect(removed).toMatchObject({
      replayed: false,
      changed: true,
      value: { relationshipId: relationships[1].id, fromItemId: project.id, toItemId: items[1].id },
    });
    expect(removedReplay).toMatchObject({ replayed: true, changed: true, value: removed.value });
    expect(getContentWorkspaceItem(OWNER, project.id, db)?.workflowVersion).toBe(project.workflowVersion + 2);
    expect(db.prepare('SELECT COUNT(*) AS count FROM content_item_relationships WHERE id = ?').get(relationships[1].id))
      .toEqual({ count: 0 });
  });

  it('denies cross-tenant relationship and copy mutations without disclosing scoped content', () => {
    const sourceArtifact = createScriptArtifact(db);
    const source = getContentWorkspaceItem(OWNER, sourceArtifact.itemId, db)!;
    const project = createContentWorkspaceItem({
      scope: OWNER,
      itemType: 'project',
      title: 'Private project',
      idempotencyKey: 'private-project-001',
    }, db).value;
    const relationship = createContentItemRelationship({
      scope: OWNER,
      fromItemId: project.id,
      toItemId: source.id,
      relationshipType: 'contains',
      idempotencyKey: 'private-project-link-001',
    }, db).value;
    const before = db.prepare('SELECT COUNT(*) AS count FROM content_domain_objects').get();

    expect(() => removeContentItemRelationship({
      scope: OTHER_TENANT,
      relationshipId: relationship.id,
      expectedFromWorkflowVersion: project.workflowVersion,
      idempotencyKey: 'private-cross-remove-001',
    }, db)).toThrowError(expect.objectContaining<Partial<ContentWorkspaceError>>({ code: 'CONTENT_RELATIONSHIP_NOT_FOUND' }));
    expect(() => duplicateContentWorkspaceItem({
      scope: OTHER_TENANT,
      sourceItemId: source.id,
      expectedWorkflowVersion: source.workflowVersion,
      mode: 'duplicate',
      idempotencyKey: 'private-cross-copy-001',
    }, db)).toThrowError(expect.objectContaining<Partial<ContentWorkspaceError>>({ code: 'CONTENT_ITEM_NOT_FOUND' }));
    expect(db.prepare('SELECT COUNT(*) AS count FROM content_domain_objects').get()).toEqual(before);
    expect(db.prepare('SELECT COUNT(*) AS count FROM content_item_relationships WHERE id = ?').get(relationship.id))
      .toEqual({ count: 1 });
  });

  it('duplicates and remixes immutable current snapshots byte-for-byte without changing the source', () => {
    const primary = createScriptArtifact(db);
    const sourceBeforeSecond = getContentWorkspaceItem(OWNER, primary.itemId, db)!;
    const research = createContentArtifact({
      scope: OWNER,
      itemId: primary.itemId,
      expectedWorkflowVersion: sourceBeforeSecond.workflowVersion,
      artifactType: 'research_notes',
      title: 'Evidence map',
      initialContent: {
        format: 'structured_json',
        document: { claims: [{ evidence: 'first-party', id: 'claim-1' }], objective: 'retain exact bytes' },
      },
      makeCurrent: false,
      idempotencyKey: 'copy-research-artifact-001',
    }, db).value;
    saveContentRevision({
      scope: OWNER,
      artifactId: primary.id,
      baseRevision: 1,
      content: { format: 'markdown', text: '  # Exact snapshot\nKeep trailing whitespace.  \n' },
      changeSummary: 'Exact byte fixture',
      idempotencyKey: 'copy-primary-revision-002',
    }, db);
    const source = getContentWorkspaceItem(OWNER, primary.itemId, db)!;
    const sourceRowsBefore = db.prepare(`
      SELECT id, current_revision_id, revision_count
        FROM content_artifacts
       WHERE item_id = ?
       ORDER BY id
    `).all(source.id);
    const sourceRevisionCountBefore = db.prepare(`
      SELECT COUNT(*) AS count
        FROM content_revisions revision
        JOIN content_artifacts artifact ON artifact.id = revision.artifact_id
       WHERE artifact.item_id = ?
    `).get(source.id);

    const duplicateInput = {
      scope: OWNER,
      sourceItemId: source.id,
      expectedWorkflowVersion: source.workflowVersion,
      mode: 'duplicate',
      title: 'Safe working copy',
      idempotencyKey: 'copy-source-duplicate-001',
    } as const;
    const duplicated = duplicateContentWorkspaceItem(duplicateInput, db);
    const replay = duplicateContentWorkspaceItem(duplicateInput, db);

    expect(duplicated).toMatchObject({
      replayed: false,
      created: true,
      value: {
        mode: 'duplicate',
        sourceItemId: source.id,
        sourceWorkflowVersion: source.workflowVersion,
        item: {
          title: 'Safe working copy',
          productionState: 'active',
          artifactPhase: 'draft',
          deadlineAt: null,
          favorite: false,
        },
        relationship: { relationshipType: 'derived_from', toItemId: source.id },
      },
    });
    expect(replay).toMatchObject({ replayed: true, created: false });
    expect(replay.value.item.id).toBe(duplicated.value.item.id);
    expect(duplicated.value.item.id).not.toBe(source.id);
    expect(duplicated.value.artifactMappings).toHaveLength(2);
    expect(duplicated.value.artifactMappings.map((mapping) => mapping.sourceArtifactId).sort((a, b) => a - b))
      .toEqual([primary.id, research.id].sort((a, b) => a - b));

    for (const mapping of duplicated.value.artifactMappings) {
      expect(mapping.sourceRevisionId).not.toBeNull();
      expect(mapping.copiedRevisionId).not.toBeNull();
      const sourceBytes = db.prepare(`
        SELECT content_format, content_text, structured_content_json, content_hash
          FROM content_revisions WHERE id = ?
      `).get(mapping.sourceRevisionId!);
      const copiedBytes = db.prepare(`
        SELECT content_format, content_text, structured_content_json, content_hash
          FROM content_revisions WHERE id = ?
      `).get(mapping.copiedRevisionId!);
      expect(copiedBytes).toEqual(sourceBytes);
      expect(db.prepare('SELECT revision_number FROM content_revisions WHERE id = ?').get(mapping.copiedRevisionId!))
        .toEqual({ revision_number: 1 });
      expect(db.prepare(`
        SELECT relationship_type
          FROM content_artifact_relationships
         WHERE from_artifact_id = ? AND to_artifact_id = ?
      `).get(mapping.copiedArtifactId, mapping.sourceArtifactId)).toEqual({ relationship_type: 'derived_from' });
    }

    expect(getContentWorkspaceItem(OWNER, source.id, db)?.workflowVersion).toBe(source.workflowVersion);
    expect(db.prepare(`SELECT id, current_revision_id, revision_count FROM content_artifacts WHERE item_id = ? ORDER BY id`).all(source.id))
      .toEqual(sourceRowsBefore);
    expect(db.prepare(`
      SELECT COUNT(*) AS count
        FROM content_revisions revision
        JOIN content_artifacts artifact ON artifact.id = revision.artifact_id
       WHERE artifact.item_id = ?
    `).get(source.id)).toEqual(sourceRevisionCountBefore);
    expect(db.prepare('SELECT COUNT(*) AS count FROM content_domain_objects WHERE title = ?').get('Safe working copy'))
      .toEqual({ count: 1 });

    const remixed = duplicateContentWorkspaceItem({
      scope: OWNER,
      sourceItemId: source.id,
      expectedWorkflowVersion: source.workflowVersion,
      mode: 'remix',
      idempotencyKey: 'copy-source-remix-001',
    }, db);
    expect(remixed.value).toMatchObject({
      mode: 'remix',
      relationship: { relationshipType: 'remix_of', toItemId: source.id },
      item: { title: 'Script item (remix)' },
    });
    expect(remixed.value.artifactMappings).toHaveLength(2);
  });

  it('rolls back the entire copy when immutable lineage cannot be recorded', () => {
    const sourceArtifact = createScriptArtifact(db);
    const source = getContentWorkspaceItem(OWNER, sourceArtifact.itemId, db)!;
    const tables = [
      'content_domain_objects',
      'content_artifacts',
      'content_revisions',
      'content_item_relationships',
      'content_artifact_relationships',
      'content_mutation_receipts',
      'content_workflow_events',
    ];
    const countsBefore = Object.fromEntries(tables.map((table) => [
      table,
      (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count,
    ]));
    db.exec(`
      CREATE TRIGGER fail_content_copy_lineage
      BEFORE INSERT ON content_artifact_relationships
      BEGIN
        SELECT RAISE(ABORT, 'forced copy lineage failure');
      END;
    `);

    expect(() => duplicateContentWorkspaceItem({
      scope: OWNER,
      sourceItemId: source.id,
      expectedWorkflowVersion: source.workflowVersion,
      mode: 'duplicate',
      idempotencyKey: 'copy-failure-atomic-001',
    }, db)).toThrow('forced copy lineage failure');

    const countsAfter = Object.fromEntries(tables.map((table) => [
      table,
      (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count,
    ]));
    expect(countsAfter).toEqual(countsBefore);
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM content_mutation_receipts
       WHERE operation = ? AND idempotency_key = ?
    `).get(`copy_item:${source.id}`, 'copy-failure-atomic-001')).toEqual({ count: 0 });
  });
});

function createItem(db: Database.Database, title: string, idempotencyKey: string) {
  return createContentWorkspaceItem({
    scope: OWNER,
    itemType: 'content_item',
    title,
    idempotencyKey,
  }, db);
}

function createScriptArtifact(db: Database.Database) {
  const row = db.prepare("SELECT COUNT(*) AS count FROM content_domain_objects").get() as { count: number };
  const item = createItem(db, 'Script item', `script-item-${row.count + 1}-001`).value;
  return createContentArtifact({
    scope: OWNER,
    itemId: item.id,
    expectedWorkflowVersion: item.workflowVersion,
    artifactType: 'script',
    title: 'Main script',
    initialContent: { format: 'markdown', text: '# Hook\nOriginal draft.' },
    idempotencyKey: `script-artifact-${item.id}-001`,
  }, db).value;
}

function seedSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE content_domain_objects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      owner_user_id INTEGER NOT NULL,
      visibility_scope TEXT NOT NULL DEFAULT 'user_private',
      scope_status TEXT NOT NULL DEFAULT 'active',
      object_type TEXT NOT NULL,
      lifecycle_state TEXT NOT NULL DEFAULT 'captured',
      title TEXT NOT NULL,
      summary TEXT,
      platform_id TEXT,
      format_id TEXT,
      ontology_metadata_json TEXT NOT NULL DEFAULT '{}',
      ontology_schema_version TEXT NOT NULL DEFAULT 'content-ontology-v1',
      editorial_state TEXT DEFAULT 'idea',
      approval_state TEXT DEFAULT 'not_required',
      review_required INTEGER NOT NULL DEFAULT 0,
      review_reason_codes_json TEXT DEFAULT '[]',
      approved_by INTEGER,
      approved_at TEXT,
      archived_at TEXT,
      workflow_version INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER NOT NULL,
      updated_by INTEGER NOT NULL,
      audit_metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE content_workflow_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      owner_user_id INTEGER NOT NULL,
      visibility_scope TEXT NOT NULL,
      scope_status TEXT NOT NULL,
      object_type TEXT NOT NULL,
      object_id TEXT NOT NULL,
      action TEXT NOT NULL,
      from_state TEXT,
      to_state TEXT,
      approval_state TEXT NOT NULL,
      review_required INTEGER NOT NULL,
      reason_codes_json TEXT NOT NULL,
      actor_user_id INTEGER NOT NULL,
      metadata_json TEXT NOT NULL
    );

    CREATE TABLE content_output_provenance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      owner_user_id INTEGER NOT NULL,
      visibility_scope TEXT NOT NULL DEFAULT 'user_private',
      scope_status TEXT NOT NULL DEFAULT 'active',
      output_object_type TEXT NOT NULL,
      output_id TEXT NOT NULL,
      grounding_status TEXT NOT NULL DEFAULT 'ungrounded',
      references_used_json TEXT NOT NULL DEFAULT '[]',
      claims_json TEXT NOT NULL DEFAULT '[]',
      unsupported_claims_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(tenant_id, owner_user_id, output_object_type, output_id)
    );
  `);
  for (const migration of MIGRATIONS) db.exec(migration);
}
