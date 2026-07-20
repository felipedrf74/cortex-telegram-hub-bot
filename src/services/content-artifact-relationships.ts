// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type Database from 'better-sqlite3';
import { getDb } from './database';
import { ContentWorkspaceError, type ContentWorkspaceScope } from './content-workspace';
import { assertContentWorkspaceWriteEnabled } from './content-workspace-capabilities';

export type ContentArtifactRelationshipType = 'variant_of' | 'derived_from' | 'remix_of';

export interface ContentArtifactRelationship {
  id: number;
  fromArtifactId: number;
  toArtifactId: number;
  relationshipType: ContentArtifactRelationshipType;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export function createContentArtifactRelationship(input: {
  scope: ContentWorkspaceScope;
  fromArtifactId: number;
  toArtifactId: number;
  relationshipType: ContentArtifactRelationshipType;
  metadata?: Record<string, unknown>;
}, db: Database.Database = getDb()): { value: ContentArtifactRelationship; created: boolean } {
  const scope = normalizeScope(input.scope);
  assertContentWorkspaceWriteEnabled(scope, 'core');
  const fromArtifactId = positiveInteger(input.fromArtifactId, 'fromArtifactId');
  const toArtifactId = positiveInteger(input.toArtifactId, 'toArtifactId');
  if (fromArtifactId === toArtifactId) {
    throw new ContentWorkspaceError('CONTENT_ARTIFACT_RELATIONSHIP_INVALID', 'An artifact cannot be related to itself.', 400);
  }
  if (!['variant_of', 'derived_from', 'remix_of'].includes(input.relationshipType)) {
    throw new ContentWorkspaceError('CONTENT_ARTIFACT_RELATIONSHIP_INVALID', 'Unsupported artifact relationship.', 400);
  }
  const metadata = normalizeMetadata(input.metadata);
  const createdAt = new Date().toISOString();
  const insert = db.prepare(`
    INSERT INTO content_artifact_relationships (
      tenant_id, owner_user_id, from_artifact_id, to_artifact_id,
      relationship_type, metadata_json, created_by, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(tenant_id, owner_user_id, from_artifact_id, to_artifact_id, relationship_type)
    DO NOTHING
  `).run(
    scope.tenantId,
    scope.userId,
    fromArtifactId,
    toArtifactId,
    input.relationshipType,
    stableJson(metadata),
    scope.userId,
    createdAt,
  );
  const row = db.prepare(`
    SELECT * FROM content_artifact_relationships
     WHERE tenant_id = ? AND owner_user_id = ?
       AND from_artifact_id = ? AND to_artifact_id = ? AND relationship_type = ?
     LIMIT 1
  `).get(scope.tenantId, scope.userId, fromArtifactId, toArtifactId, input.relationshipType) as RelationshipRow | undefined;
  if (!row) throw new ContentWorkspaceError('CONTENT_ARTIFACT_RELATIONSHIP_WRITE_FAILED', 'Artifact relationship could not be read after saving.', 500);
  return { value: mapRow(row), created: insert.changes === 1 };
}

export function listContentArtifactRelationships(
  scopeInput: ContentWorkspaceScope,
  artifactIds: readonly number[],
  db: Database.Database = getDb(),
): ContentArtifactRelationship[] {
  const scope = normalizeScope(scopeInput);
  const ids = Array.from(new Set(artifactIds.map((id) => positiveInteger(id, 'artifactId'))));
  if (ids.length === 0) return [];
  if (ids.length > 200) throw new ContentWorkspaceError('CONTENT_VALIDATION_FAILED', 'Too many artifacts requested.', 400);
  const placeholders = ids.map(() => '?').join(', ');
  return (db.prepare(`
    SELECT * FROM content_artifact_relationships
     WHERE tenant_id = ? AND owner_user_id = ?
       AND (from_artifact_id IN (${placeholders}) OR to_artifact_id IN (${placeholders}))
     ORDER BY id ASC
  `).all(scope.tenantId, scope.userId, ...ids, ...ids) as RelationshipRow[]).map(mapRow);
}

interface RelationshipRow {
  id: number;
  from_artifact_id: number;
  to_artifact_id: number;
  relationship_type: ContentArtifactRelationshipType;
  metadata_json: string;
  created_at: string;
}

function mapRow(row: RelationshipRow): ContentArtifactRelationship {
  let metadata: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.metadata_json);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) metadata = parsed;
  } catch { /* corrupted optional metadata is withheld */ }
  return {
    id: Number(row.id),
    fromArtifactId: Number(row.from_artifact_id),
    toArtifactId: Number(row.to_artifact_id),
    relationshipType: row.relationship_type,
    metadata,
    createdAt: row.created_at,
  };
}

function normalizeScope(scope: ContentWorkspaceScope): ContentWorkspaceScope {
  return {
    tenantId: positiveInteger(scope?.tenantId, 'tenantId'),
    userId: positiveInteger(scope?.userId, 'userId'),
  };
}

function positiveInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ContentWorkspaceError('CONTENT_VALIDATION_FAILED', `${field} must be a positive integer.`, 400, { field });
  }
  return parsed;
}

function normalizeMetadata(value: unknown): Record<string, unknown> {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ContentWorkspaceError('CONTENT_VALIDATION_FAILED', 'metadata must be an object.', 400, { field: 'metadata' });
  }
  const serialized = stableJson(value);
  if (serialized.length > 8_192) {
    throw new ContentWorkspaceError('CONTENT_VALIDATION_FAILED', 'metadata is too large.', 400, { field: 'metadata' });
  }
  return JSON.parse(serialized) as Record<string, unknown>;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  return encoded === undefined ? 'null' : encoded;
}
