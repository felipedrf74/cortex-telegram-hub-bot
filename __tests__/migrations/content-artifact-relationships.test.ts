// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createContentArtifactRelationship,
  listContentArtifactRelationships,
} from '../../src/services/content-artifact-relationships';
import { createContentArtifact, createContentWorkspaceItem, getContentWorkspaceItem } from '../../src/services/content-workspace';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';

const DOWN = readFileSync(resolve(process.cwd(), 'migrations/down/243_content_artifact_relationships.sql'), 'utf8');
const SCOPE = { tenantId: 501, userId: 501 };

describe('migration 243 content artifact relationships', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createMigratedTestDatabase();
  });

  afterEach(() => db.close());

  it('links one same-item platform variant idempotently and keeps the relation immutable', () => {
    const pair = seedPair(db, 'same-item');
    const created = createContentArtifactRelationship({
      scope: SCOPE,
      fromArtifactId: pair.variantId,
      toArtifactId: pair.sourceId,
      relationshipType: 'variant_of',
      metadata: { platformId: 'youtube' },
    }, db);
    const replay = createContentArtifactRelationship({
      scope: SCOPE,
      fromArtifactId: pair.variantId,
      toArtifactId: pair.sourceId,
      relationshipType: 'variant_of',
      metadata: { platformId: 'youtube' },
    }, db);

    expect(created.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(replay.value.id).toBe(created.value.id);
    expect(listContentArtifactRelationships(SCOPE, [pair.sourceId], db)).toEqual([
      expect.objectContaining({
        fromArtifactId: pair.variantId,
        toArtifactId: pair.sourceId,
        relationshipType: 'variant_of',
      }),
    ]);
    expect(() => db.prepare("UPDATE content_artifact_relationships SET metadata_json = '{}' WHERE id = ?")
      .run(created.value.id)).toThrow('content artifact relationships are immutable');
  });

  it('rejects cross-item variants and cross-tenant relationship stitching', () => {
    const pair = seedPair(db, 'owner');
    const otherItem = createContentWorkspaceItem({
      scope: SCOPE,
      itemType: 'content_item',
      title: 'Other content item',
      idempotencyKey: 'artifact-relation-other-item-001',
    }, db).value;
    const otherVariant = createContentArtifact({
      scope: SCOPE,
      itemId: otherItem.id,
      expectedWorkflowVersion: otherItem.workflowVersion,
      artifactType: 'platform_variant',
      initialContent: { format: 'plain_text', text: 'Other variant' },
      idempotencyKey: 'artifact-relation-other-variant-001',
    }, db).value;

    expect(() => createContentArtifactRelationship({
      scope: SCOPE,
      fromArtifactId: otherVariant.id,
      toArtifactId: pair.sourceId,
      relationshipType: 'variant_of',
    }, db)).toThrow('platform variants must remain with their source content item');
    expect(listContentArtifactRelationships({ tenantId: 777, userId: 777 }, [pair.sourceId], db)).toEqual([]);
  });

  it('refuses rollback without deleting platform-variant lineage', () => {
    const pair = seedPair(db, 'down-guard');
    const relationship = createContentArtifactRelationship({
      scope: SCOPE,
      fromArtifactId: pair.variantId,
      toArtifactId: pair.sourceId,
      relationshipType: 'variant_of',
      metadata: { platformId: 'youtube' },
    }, db).value;

    expect(() => db.exec(DOWN)).toThrow(/content_artifact_relationships_243_forward_only/);
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index','trigger')").all() as Array<{ name: string }>).map((row) => row.name);
    expect(names).toContain('content_artifact_relationships');
    expect(names).toContain('trg_content_artifact_relationships_immutable');
    expect(names).toContain('content_artifacts');
    expect(db.prepare('SELECT relationship_type FROM content_artifact_relationships WHERE id = ?').get(relationship.id))
      .toEqual({ relationship_type: 'variant_of' });
  });
});

function seedPair(db: Database.Database, suffix: string): { sourceId: number; variantId: number } {
  const item = createContentWorkspaceItem({
    scope: SCOPE,
    itemType: 'content_item',
    title: `Artifact relationship ${suffix}`,
    idempotencyKey: `artifact-relation-item-${suffix}-001`,
  }, db).value;
  const source = createContentArtifact({
    scope: SCOPE,
    itemId: item.id,
    expectedWorkflowVersion: item.workflowVersion,
    artifactType: 'script',
    initialContent: { format: 'plain_text', text: 'Source script' },
    idempotencyKey: `artifact-relation-source-${suffix}-001`,
  }, db).value;
  const variant = createContentArtifact({
    scope: SCOPE,
    itemId: item.id,
    expectedWorkflowVersion: getContentWorkspaceItem(SCOPE, item.id, db)!.workflowVersion,
    artifactType: 'platform_variant',
    platformId: 'youtube',
    initialContent: { format: 'plain_text', text: 'Platform variant' },
    makeCurrent: false,
    idempotencyKey: `artifact-relation-variant-${suffix}-001`,
  }, db).value;
  return { sourceId: source.id, variantId: variant.id };
}
