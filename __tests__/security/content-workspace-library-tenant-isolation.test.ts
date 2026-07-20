import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import {
  ContentWorkspaceError,
  attachContentTag,
  createContentTag,
  createContentWorkspaceItem,
  listContentTags,
  listDeletedContentWorkspaceItems,
  queryContentWorkspaceItems,
  softDeleteContentWorkspaceItem,
  updateContentWorkspaceItem,
  type ContentWorkspaceScope,
} from '../../src/services/content-workspace';

const USER_A: ContentWorkspaceScope = { tenantId: 101, userId: 501 };
const USER_B: ContentWorkspaceScope = { tenantId: 101, userId: 777 };
const USER_A_OTHER_TENANT: ContentWorkspaceScope = { tenantId: 202, userId: 501 };

describe('content workspace library tenant isolation', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createMigratedTestDatabase();
  });

  afterEach(() => db.close());

  it('keeps items, tags, mutations, and trash inside the exact tenant/owner pair', () => {
    const itemA = createItem(USER_A, 'USER_A_PRIVATE_LIBRARY_ITEM', 'tenant-matrix-a-item-001');
    const itemB = createItem(USER_B, 'USER_B_PRIVATE_LIBRARY_ITEM', 'tenant-matrix-b-item-001');
    const otherTenantItem = createItem(USER_A_OTHER_TENANT, 'OTHER_TENANT_PRIVATE_LIBRARY_ITEM', 'tenant-matrix-c-item-001');
    const tagA = createContentTag({
      scope: USER_A,
      name: 'USER_A_PRIVATE_TAG',
      idempotencyKey: 'tenant-matrix-a-tag-001',
    }, db).value;
    const tagB = createContentTag({
      scope: USER_B,
      name: 'USER_B_PRIVATE_TAG',
      idempotencyKey: 'tenant-matrix-b-tag-001',
    }, db).value;

    expect(queryContentWorkspaceItems({ scope: USER_A, includeArchived: true }, db).items.map((item) => item.title))
      .toEqual(['USER_A_PRIVATE_LIBRARY_ITEM']);
    expect(queryContentWorkspaceItems({ scope: USER_B, includeArchived: true }, db).items.map((item) => item.title))
      .toEqual(['USER_B_PRIVATE_LIBRARY_ITEM']);
    expect(queryContentWorkspaceItems({ scope: USER_A_OTHER_TENANT, includeArchived: true }, db).items.map((item) => item.title))
      .toEqual(['OTHER_TENANT_PRIVATE_LIBRARY_ITEM']);
    expect(listContentTags(USER_A, db).map((tag) => tag.name)).toEqual(['USER_A_PRIVATE_TAG']);
    expect(listContentTags(USER_B, db).map((tag) => tag.name)).toEqual(['USER_B_PRIVATE_TAG']);

    expect(() => attachContentTag({
      scope: USER_A,
      itemId: itemA.id,
      tagId: tagB.id,
      expectedWorkflowVersion: itemA.workflowVersion,
      idempotencyKey: 'tenant-matrix-cross-tag-001',
    }, db)).toThrowError(expect.objectContaining<Partial<ContentWorkspaceError>>({ code: 'CONTENT_TAG_NOT_FOUND' }));
    expect(() => updateContentWorkspaceItem({
      scope: USER_A,
      itemId: itemB.id,
      expectedWorkflowVersion: itemB.workflowVersion,
      title: 'ATTACKER_OVERWRITE',
      idempotencyKey: 'tenant-matrix-cross-write-001',
    }, db)).toThrowError(expect.objectContaining<Partial<ContentWorkspaceError>>({ code: 'CONTENT_ITEM_NOT_FOUND' }));
    expect(() => updateContentWorkspaceItem({
      scope: USER_A,
      itemId: otherTenantItem.id,
      expectedWorkflowVersion: otherTenantItem.workflowVersion,
      title: 'ATTACKER_OTHER_TENANT_OVERWRITE',
      idempotencyKey: 'tenant-matrix-cross-write-002',
    }, db)).toThrowError(expect.objectContaining<Partial<ContentWorkspaceError>>({ code: 'CONTENT_ITEM_NOT_FOUND' }));

    softDeleteContentWorkspaceItem({
      scope: USER_B,
      itemId: itemB.id,
      expectedWorkflowVersion: itemB.workflowVersion,
      idempotencyKey: 'tenant-matrix-b-delete-001',
    }, db);
    expect(listDeletedContentWorkspaceItems({ scope: USER_A }, db).entries).toEqual([]);
    expect(listDeletedContentWorkspaceItems({ scope: USER_B }, db).entries.map((entry) => entry.item.title))
      .toEqual(['USER_B_PRIVATE_LIBRARY_ITEM']);
    expect(tagA.id).not.toBe(tagB.id);
  });

  function createItem(scope: ContentWorkspaceScope, title: string, idempotencyKey: string) {
    return createContentWorkspaceItem({ scope, itemType: 'content_item', title, idempotencyKey }, db).value;
  }
});
