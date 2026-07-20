import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import {
  ContentWorkspaceError,
  attachContentTag,
  createContentArtifact,
  createContentItemRelationship,
  createContentTag,
  createContentWorkspaceItem,
  detachContentTag,
  getContentWorkspaceItem,
  getContentWorkspaceItemDetail,
  listContentTags,
  listDeletedContentWorkspaceItems,
  queryContentWorkspaceItems,
  restoreDeletedContentWorkspaceItem,
  saveContentRevision,
  softDeleteContentWorkspaceItem,
  transitionContentWorkspaceItem,
  updateContentWorkspaceItem,
  type ContentWorkspaceScope,
} from '../../src/services/content-workspace';

const OWNER: ContentWorkspaceScope = { tenantId: 101, userId: 501 };
const OTHER_TENANT: ContentWorkspaceScope = { tenantId: 202, userId: 501 };
const OTHER_USER: ContentWorkspaceScope = { tenantId: 101, userId: 777 };

describe('content workspace library', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createMigratedTestDatabase();
  });

  afterEach(() => db.close());

  it('updates editable metadata with workflow CAS and stable idempotency', () => {
    const item = createItem(db, 'Original metadata', 'library-metadata-item-001');
    const deadlineAt = '2026-08-01T10:00:00.000Z';
    const updated = updateContentWorkspaceItem({
      scope: OWNER,
      itemId: item.id,
      expectedWorkflowVersion: item.workflowVersion,
      title: 'Edited metadata',
      summary: 'A useful, searchable summary.',
      priority: 1,
      deadlineAt,
      favorite: true,
      platformId: 'youtube',
      formatId: 'long_form_video',
      idempotencyKey: 'library-metadata-update-001',
    }, db);
    const replay = updateContentWorkspaceItem({
      scope: OWNER,
      itemId: item.id,
      expectedWorkflowVersion: item.workflowVersion,
      title: 'Edited metadata',
      summary: 'A useful, searchable summary.',
      priority: 1,
      deadlineAt,
      favorite: true,
      platformId: 'youtube',
      formatId: 'long_form_video',
      idempotencyKey: 'library-metadata-update-001',
    }, db);

    expect(updated).toMatchObject({ changed: true, replayed: false });
    expect(updated.value).toMatchObject({
      title: 'Edited metadata',
      summary: 'A useful, searchable summary.',
      priority: 1,
      deadlineAt,
      favorite: true,
      platformId: 'youtube',
      formatId: 'long_form_video',
      workflowVersion: item.workflowVersion + 1,
    });
    expect(replay).toMatchObject({ replayed: true, changed: true });
    expect(replay.value.id).toBe(item.id);

    const cleared = updateContentWorkspaceItem({
      scope: OWNER,
      itemId: item.id,
      expectedWorkflowVersion: updated.value.workflowVersion,
      summary: null,
      deadlineAt: null,
      platformId: null,
      formatId: null,
      idempotencyKey: 'library-metadata-clear-002',
    }, db);
    expect(cleared.value).toMatchObject({
      summary: null,
      deadlineAt: null,
      platformId: null,
      formatId: null,
      workflowVersion: updated.value.workflowVersion + 1,
    });

    expect(() => updateContentWorkspaceItem({
      scope: OWNER,
      itemId: item.id,
      expectedWorkflowVersion: item.workflowVersion,
      title: 'Different payload',
      idempotencyKey: 'library-metadata-update-001',
    }, db)).toThrowError(expect.objectContaining<Partial<ContentWorkspaceError>>({ code: 'CONTENT_IDEMPOTENCY_KEY_REUSED' }));

    expect(() => updateContentWorkspaceItem({
      scope: OWNER,
      itemId: item.id,
      expectedWorkflowVersion: item.workflowVersion,
      favorite: false,
      idempotencyKey: 'library-metadata-stale-002',
    }, db)).toThrowError(expect.objectContaining<Partial<ContentWorkspaceError>>({ code: 'CONTENT_WORKFLOW_VERSION_CONFLICT' }));

    const noChange = updateContentWorkspaceItem({
      scope: OWNER,
      itemId: item.id,
      expectedWorkflowVersion: cleared.value.workflowVersion,
      title: cleared.value.title,
      idempotencyKey: 'library-metadata-noop-003',
    }, db);
    expect(noChange).toMatchObject({ changed: false, replayed: false });
    expect(noChange.value.workflowVersion).toBe(cleared.value.workflowVersion);
  });

  it('normalizes tags per tenant/owner and attaches or detaches without duplicates', () => {
    const item = createItem(db, 'Tagged item', 'library-tagged-item-001');
    const tag = createContentTag({
      scope: OWNER,
      name: '  Launch   Week  ',
      idempotencyKey: 'library-tag-create-001',
    }, db);
    const duplicateName = createContentTag({
      scope: OWNER,
      name: 'LAUNCH WEEK',
      idempotencyKey: 'library-tag-create-002',
    }, db);
    const otherTenantTag = createContentTag({
      scope: OTHER_TENANT,
      name: 'Launch Week',
      idempotencyKey: 'library-tag-create-003',
    }, db).value;
    const otherUserTag = createContentTag({
      scope: OTHER_USER,
      name: 'Launch Week',
      idempotencyKey: 'library-tag-create-004',
    }, db).value;

    expect(tag.value).toMatchObject({ name: 'Launch Week', normalizedName: 'launch week' });
    expect(duplicateName).toMatchObject({ created: false, replayed: false });
    expect(duplicateName.value.id).toBe(tag.value.id);
    expect(otherTenantTag.id).not.toBe(tag.value.id);
    expect(otherUserTag.id).not.toBe(tag.value.id);
    expect(listContentTags(OWNER, db)).toEqual([expect.objectContaining({ id: tag.value.id })]);
    expect(listContentTags(OTHER_TENANT, db)).toEqual([expect.objectContaining({ id: otherTenantTag.id })]);

    const attached = attachContentTag({
      scope: OWNER,
      itemId: item.id,
      tagId: tag.value.id,
      expectedWorkflowVersion: item.workflowVersion,
      idempotencyKey: 'library-tag-attach-001',
    }, db);
    const replay = attachContentTag({
      scope: OWNER,
      itemId: item.id,
      tagId: tag.value.id,
      expectedWorkflowVersion: item.workflowVersion,
      idempotencyKey: 'library-tag-attach-001',
    }, db);
    expect(attached).toMatchObject({ changed: true, replayed: false });
    expect(attached.value.tags).toEqual([expect.objectContaining({ id: tag.value.id })]);
    expect(replay).toMatchObject({ changed: true, replayed: true });
    expect(db.prepare('SELECT COUNT(*) AS count FROM content_item_tags WHERE item_id = ?').get(item.id)).toEqual({ count: 1 });

    const attachNoop = attachContentTag({
      scope: OWNER,
      itemId: item.id,
      tagId: tag.value.id,
      expectedWorkflowVersion: attached.value.workflowVersion,
      idempotencyKey: 'library-tag-attach-noop-002',
    }, db);
    expect(attachNoop).toMatchObject({ changed: false, replayed: false });
    expect(attachNoop.value.workflowVersion).toBe(attached.value.workflowVersion);

    expect(() => attachContentTag({
      scope: OWNER,
      itemId: item.id,
      tagId: otherTenantTag.id,
      expectedWorkflowVersion: attached.value.workflowVersion,
      idempotencyKey: 'library-tag-cross-tenant-002',
    }, db)).toThrowError(expect.objectContaining<Partial<ContentWorkspaceError>>({ code: 'CONTENT_TAG_NOT_FOUND' }));

    const detached = detachContentTag({
      scope: OWNER,
      itemId: item.id,
      tagId: tag.value.id,
      expectedWorkflowVersion: attached.value.workflowVersion,
      idempotencyKey: 'library-tag-detach-003',
    }, db);
    const detachReplay = detachContentTag({
      scope: OWNER,
      itemId: item.id,
      tagId: tag.value.id,
      expectedWorkflowVersion: attached.value.workflowVersion,
      idempotencyKey: 'library-tag-detach-003',
    }, db);
    expect(detached).toMatchObject({ changed: true, replayed: false });
    expect(detached.value.tags).toEqual([]);
    expect(detachReplay).toMatchObject({ changed: true, replayed: true });
    expect(db.prepare('SELECT COUNT(*) AS count FROM content_item_tags WHERE item_id = ?').get(item.id)).toEqual({ count: 0 });
    const detachNoop = detachContentTag({
      scope: OWNER,
      itemId: item.id,
      tagId: tag.value.id,
      expectedWorkflowVersion: detached.value.workflowVersion,
      idempotencyKey: 'library-tag-detach-noop-004',
    }, db);
    expect(detachNoop).toMatchObject({ changed: false, replayed: false });
    expect(detachNoop.value.workflowVersion).toBe(detached.value.workflowVersion);
  });

  it('searches literal wildcard characters and composes safe filters, collection scope, sorting, and cursors', () => {
    const project = createContentWorkspaceItem({
      scope: OWNER,
      itemType: 'project',
      title: 'Launch collection',
      idempotencyKey: 'library-query-project-001',
    }, db).value;
    const literal = createContentWorkspaceItem({
      scope: OWNER,
      itemType: 'content_item',
      title: '100%_real launch',
      summary: 'A literal wildcard \\ example.',
      priority: 1,
      favorite: true,
      platformId: 'youtube',
      formatId: 'video',
      idempotencyKey: 'library-query-literal-001',
    }, db).value;
    const lookalike = createItem(db, '100XXreal launch', 'library-query-lookalike-002');
    const archivedCandidate = createItem(db, 'Zebra archive', 'library-query-archive-003');
    createContentItemRelationship({
      scope: OWNER,
      fromItemId: project.id,
      toItemId: literal.id,
      relationshipType: 'contains',
      idempotencyKey: 'library-query-contains-001',
    }, db);
    const tag = createContentTag({
      scope: OWNER,
      name: 'Launch',
      idempotencyKey: 'library-query-tag-001',
    }, db).value;
    attachContentTag({
      scope: OWNER,
      itemId: literal.id,
      tagId: tag.id,
      expectedWorkflowVersion: literal.workflowVersion,
      idempotencyKey: 'library-query-attach-001',
    }, db);

    expect(queryContentWorkspaceItems({ scope: OWNER, search: '%_' }, db).items.map((row) => row.id)).toEqual([literal.id]);
    expect(queryContentWorkspaceItems({ scope: OWNER, search: '\\' }, db).items.map((row) => row.id)).toEqual([literal.id]);
    expect(queryContentWorkspaceItems({
      scope: OWNER,
      itemType: 'content_item',
      priority: 1,
      favorite: true,
      platformId: 'youtube',
      formatId: 'video',
      tag: 'LAUNCH',
      projectId: project.id,
    }, db).items.map((row) => row.id)).toEqual([literal.id]);
    expect(queryContentWorkspaceItems({ scope: OTHER_TENANT, projectId: project.id }, db).items).toEqual([]);

    const deletedProject = softDeleteContentWorkspaceItem({
      scope: OWNER,
      itemId: project.id,
      expectedWorkflowVersion: project.workflowVersion,
      idempotencyKey: 'library-query-project-delete-001',
    }, db).value;
    expect(queryContentWorkspaceItems({ scope: OWNER, projectId: project.id }, db).items).toEqual([]);
    restoreDeletedContentWorkspaceItem({
      scope: OWNER,
      itemId: project.id,
      expectedWorkflowVersion: deletedProject.workflowVersion,
      idempotencyKey: 'library-query-project-restore-001',
    }, db);
    expect(queryContentWorkspaceItems({ scope: OWNER, projectId: project.id }, db).items.map((row) => row.id)).toEqual([literal.id]);

    const firstPage = queryContentWorkspaceItems({ scope: OWNER, itemType: 'content_item', sort: 'title_asc', limit: 2 }, db);
    const secondPage = queryContentWorkspaceItems({
      scope: OWNER,
      itemType: 'content_item',
      sort: 'title_asc',
      limit: 2,
      cursor: firstPage.nextCursor!,
    }, db);
    expect(firstPage).toMatchObject({ hasMore: true });
    expect(firstPage.items.map((row) => row.title)).toEqual(['100%_real launch', '100XXreal launch']);
    expect(secondPage).toMatchObject({ hasMore: false, nextCursor: null });
    expect(secondPage.items.map((row) => row.id)).toEqual([archivedCandidate.id]);
    expect(new Set([...firstPage.items, ...secondPage.items].map((row) => row.id)).size).toBe(3);
    expect(() => queryContentWorkspaceItems({
      scope: OWNER,
      itemType: 'content_item',
      search: 'different filter',
      sort: 'title_asc',
      limit: 2,
      cursor: firstPage.nextCursor!,
    }, db)).toThrowError(expect.objectContaining<Partial<ContentWorkspaceError>>({ code: 'CONTENT_CURSOR_INVALID' }));

    const archived = transitionContentWorkspaceItem({
      scope: OWNER,
      itemId: archivedCandidate.id,
      targetState: 'archived',
      expectedWorkflowVersion: archivedCandidate.workflowVersion,
      idempotencyKey: 'library-query-archive-transition-001',
    }, db).value;
    expect(queryContentWorkspaceItems({ scope: OWNER }, db).items.map((row) => row.id)).not.toContain(archived.id);
    expect(queryContentWorkspaceItems({ scope: OWNER, productionState: 'archived' }, db).items.map((row) => row.id)).toContain(archived.id);
    expect(queryContentWorkspaceItems({ scope: OWNER, includeArchived: true }, db).items.map((row) => row.id)).toContain(archived.id);
  });

  it('searches only the scoped current artifact revision without leaking superseded or cross-tenant content', () => {
    const item = createItem(db, 'Untitled workspace entry', 'library-body-search-item-001');
    const artifact = createContentArtifact({
      scope: OWNER,
      itemId: item.id,
      expectedWorkflowVersion: item.workflowVersion,
      artifactType: 'script',
      initialContent: { format: 'plain_text', text: 'The first draft mentions retired-only-phrase.' },
      idempotencyKey: 'library-body-search-artifact-001',
    }, db).value;
    const withArtifact = getContentWorkspaceItem(OWNER, item.id, db)!;
    saveContentRevision({
      scope: OWNER,
      artifactId: artifact.id,
      baseRevision: artifact.currentRevision!.revisionNumber,
      content: {
        format: 'structured_json',
        document: { hook: 'Current searchable nebula promise', sections: [{ body: 'Audience-specific proof' }] },
      },
      actorType: 'user',
      idempotencyKey: 'library-body-search-revision-002',
    }, db);

    const other = createContentWorkspaceItem({
      scope: OTHER_TENANT,
      itemType: 'content_item',
      title: 'Private other-tenant entry',
      idempotencyKey: 'library-body-search-other-item-001',
    }, db).value;
    createContentArtifact({
      scope: OTHER_TENANT,
      itemId: other.id,
      expectedWorkflowVersion: other.workflowVersion,
      artifactType: 'script',
      initialContent: { format: 'plain_text', text: 'Tenant-secret comet phrase' },
      idempotencyKey: 'library-body-search-other-artifact-001',
    }, db);

    expect(withArtifact.workflowVersion).toBeGreaterThan(item.workflowVersion);
    expect(queryContentWorkspaceItems({ scope: OWNER, search: 'nebula promise' }, db).items.map((row) => row.id))
      .toEqual([item.id]);
    expect(queryContentWorkspaceItems({ scope: OWNER, search: 'Audience-specific proof' }, db).items.map((row) => row.id))
      .toEqual([item.id]);
    expect(queryContentWorkspaceItems({ scope: OWNER, search: 'retired-only-phrase' }, db).items).toEqual([]);
    expect(queryContentWorkspaceItems({ scope: OWNER, search: 'Tenant-secret comet phrase' }, db).items).toEqual([]);
    expect(queryContentWorkspaceItems({ scope: OTHER_TENANT, search: 'Tenant-secret comet phrase' }, db).items.map((row) => row.id))
      .toEqual([other.id]);
  });

  it('uses a stable keyset snapshot so concurrent edits and inserts cannot duplicate or skip visible rows', () => {
    const alpha = createItem(db, 'Alpha', 'library-keyset-alpha-001');
    const beta = createItem(db, 'Beta', 'library-keyset-beta-002');
    const delta = createItem(db, 'Delta', 'library-keyset-delta-003');
    const gamma = createItem(db, 'Gamma', 'library-keyset-gamma-004');

    const first = queryContentWorkspaceItems({
      scope: OWNER,
      itemType: 'content_item',
      sort: 'title_asc',
      limit: 2,
    }, db);
    expect(first.items.map((item) => item.id)).toEqual([alpha.id, beta.id]);

    // Simulate another device moving one seen row behind the cursor and one
    // unseen row ahead of it. Both mutations happened after this page's
    // snapshot and must be deferred until a refresh, not duplicated/skipped
    // within the active traversal.
    db.prepare(`
      UPDATE content_domain_objects
         SET title = ?, updated_at = ?
       WHERE id = ? AND tenant_id = ? AND owner_user_id = ?
    `).run('Zulu', '2099-01-01T00:00:00.000Z', alpha.id, OWNER.tenantId, OWNER.userId);
    db.prepare(`
      UPDATE content_domain_objects
         SET title = ?, updated_at = ?
       WHERE id = ? AND tenant_id = ? AND owner_user_id = ?
    `).run('Aardvark', '2099-01-01T00:00:00.000Z', gamma.id, OWNER.tenantId, OWNER.userId);
    const inserted = createItem(db, 'Between pages', 'library-keyset-insert-005');

    const second = queryContentWorkspaceItems({
      scope: OWNER,
      itemType: 'content_item',
      sort: 'title_asc',
      limit: 2,
      cursor: first.nextCursor!,
    }, db);
    expect(second.items.map((item) => item.id)).toEqual([delta.id]);
    expect([...first.items, ...second.items].map((item) => item.id)).toEqual([
      alpha.id,
      beta.id,
      delta.id,
    ]);
    expect(second.items.map((item) => item.id)).not.toContain(inserted.id);
    expect(second).toMatchObject({ hasMore: false, nextCursor: null });
  });

  it('soft-deletes with a recoverable tombstone and restores the intact item graph', () => {
    const item = createItem(db, 'Recoverable script', 'library-delete-item-001');
    const artifact = createContentArtifact({
      scope: OWNER,
      itemId: item.id,
      expectedWorkflowVersion: item.workflowVersion,
      artifactType: 'script',
      initialContent: { format: 'plain_text', text: 'Never hard delete this revision.' },
      idempotencyKey: 'library-delete-artifact-001',
    }, db).value;
    const withArtifact = getContentWorkspaceItem(OWNER, item.id, db)!;
    const tag = createContentTag({
      scope: OWNER,
      name: 'Recoverable',
      idempotencyKey: 'library-delete-tag-001',
    }, db).value;
    const tagged = attachContentTag({
      scope: OWNER,
      itemId: item.id,
      tagId: tag.id,
      expectedWorkflowVersion: withArtifact.workflowVersion,
      idempotencyKey: 'library-delete-attach-001',
    }, db).value;

    const deleted = softDeleteContentWorkspaceItem({
      scope: OWNER,
      itemId: item.id,
      expectedWorkflowVersion: tagged.workflowVersion,
      idempotencyKey: 'library-delete-soft-001',
    }, db);
    const replay = softDeleteContentWorkspaceItem({
      scope: OWNER,
      itemId: item.id,
      expectedWorkflowVersion: tagged.workflowVersion,
      idempotencyKey: 'library-delete-soft-001',
    }, db);

    expect(deleted).toMatchObject({ changed: true, replayed: false, value: { itemId: item.id, recoverable: true } });
    expect(replay).toEqual({ ...deleted, replayed: true });
    expect(deleted).toMatchObject({ deletionCurrent: true, item: null });
    expect(getContentWorkspaceItem(OWNER, item.id, db)).toBeNull();
    expect(queryContentWorkspaceItems({ scope: OWNER, includeArchived: true }, db).items.map((row) => row.id)).not.toContain(item.id);
    expect(listDeletedContentWorkspaceItems({ scope: OWNER }, db).entries).toEqual([
      expect.objectContaining({
        item: expect.objectContaining({ id: item.id, workflowVersion: deleted.value.workflowVersion }),
        deletedAt: deleted.value.deletedAt,
        recoverable: true,
        nextAction: expect.objectContaining({ action: 'restore_to_inbox', label: 'Restore item' }),
      }),
    ]);
    expect(listDeletedContentWorkspaceItems({ scope: OTHER_TENANT }, db).entries).toEqual([]);
    expect(db.prepare('SELECT scope_status, deleted_at FROM content_domain_objects WHERE id = ?').get(item.id))
      .toEqual({ scope_status: 'deleted', deleted_at: deleted.value.deletedAt });
    expect(db.prepare('SELECT COUNT(*) AS count FROM content_artifacts WHERE id = ?').get(artifact.id)).toEqual({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM content_revisions WHERE artifact_id = ?').get(artifact.id)).toEqual({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM content_item_tags WHERE item_id = ?').get(item.id)).toEqual({ count: 1 });

    expect(() => restoreDeletedContentWorkspaceItem({
      scope: OTHER_TENANT,
      itemId: item.id,
      expectedWorkflowVersion: deleted.value.workflowVersion,
      idempotencyKey: 'library-delete-cross-tenant-001',
    }, db)).toThrowError(expect.objectContaining<Partial<ContentWorkspaceError>>({ code: 'CONTENT_DELETED_ITEM_NOT_FOUND' }));

    const restored = restoreDeletedContentWorkspaceItem({
      scope: OWNER,
      itemId: item.id,
      expectedWorkflowVersion: deleted.value.workflowVersion,
      idempotencyKey: 'library-delete-restore-001',
    }, db);
    const restoreReplay = restoreDeletedContentWorkspaceItem({
      scope: OWNER,
      itemId: item.id,
      expectedWorkflowVersion: deleted.value.workflowVersion,
      idempotencyKey: 'library-delete-restore-001',
    }, db);
    expect(restored).toMatchObject({ changed: true, replayed: false });
    expect(restored.value).toMatchObject({ id: item.id, workflowVersion: deleted.value.workflowVersion + 1 });
    expect(restored.value.tags).toEqual([expect.objectContaining({ id: tag.id })]);
    expect(listDeletedContentWorkspaceItems({ scope: OWNER }, db).entries).toEqual([]);
    expect(getContentWorkspaceItemDetail(OWNER, item.id, db)?.artifacts).toEqual([
      expect.objectContaining({ id: artifact.id, currentRevision: expect.objectContaining({ content: { format: 'plain_text', text: 'Never hard delete this revision.' } }) }),
    ]);
    expect(restoreReplay).toMatchObject({ changed: true, replayed: true, value: { id: item.id } });

    // Device A lost its successful delete response. Device B restored the
    // item, so A's exact retry must preserve the immutable receipt without
    // falsely presenting that historical deletion as the current truth.
    const deleteReplayAfterRestore = softDeleteContentWorkspaceItem({
      scope: OWNER,
      itemId: item.id,
      expectedWorkflowVersion: tagged.workflowVersion,
      idempotencyKey: 'library-delete-soft-001',
    }, db);
    expect(deleteReplayAfterRestore).toMatchObject({
      value: deleted.value,
      replayed: true,
      changed: true,
      deletionCurrent: false,
      item: {
        id: item.id,
        workflowVersion: restored.value.workflowVersion,
      },
    });
    expect(getContentWorkspaceItem(OWNER, item.id, db)).toEqual(deleteReplayAfterRestore.item);
    expect(getContentWorkspaceItem(OTHER_TENANT, item.id, db)).toBeNull();

    expect(() => softDeleteContentWorkspaceItem({
      scope: OWNER,
      itemId: item.id,
      expectedWorkflowVersion: restored.value.workflowVersion,
      idempotencyKey: 'library-delete-soft-001',
    }, db)).toThrowError(expect.objectContaining<Partial<ContentWorkspaceError>>({ code: 'CONTENT_IDEMPOTENCY_KEY_REUSED' }));
  });
});

function createItem(db: Database.Database, title: string, idempotencyKey: string) {
  return createContentWorkspaceItem({
    scope: OWNER,
    itemType: 'content_item',
    title,
    idempotencyKey,
  }, db).value;
}
