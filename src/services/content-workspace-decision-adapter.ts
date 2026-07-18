// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/** Canonical Content workspace boundary used by Decision Center. */

import type Database from 'better-sqlite3';
import { getDb } from './database';
import {
  ContentWorkspaceError,
  getContentArtifact,
  getContentWorkspaceItem,
  transitionContentWorkspaceItem,
  type ContentArtifact,
  type ContentProductionState,
} from './content-workspace';

export interface ContentDecisionWorkspaceObject {
  id: number;
  tenantId: number;
  ownerUserId: number;
  visibilityScope: 'user_private';
  objectType: string;
  title: string;
  editorialState: string;
  productionState: ContentProductionState;
  approvalState: 'not_required' | 'required' | 'approved' | 'rejected';
  reviewRequired: boolean;
  reviewReasonCodes: string[];
  workflowVersion: number;
  updatedAt: string;
}

export interface ContentDecisionReviewResult {
  ok: boolean;
  status: 'approved' | 'rejected' | 'rewrite_requested' | 'not_found' | 'version_conflict' | 'invalid_transition';
  object: ContentDecisionWorkspaceObject | null;
  reasonCodes: string[];
}

export function getContentDecisionWorkspaceObject(
  userId: number,
  objectId: number | string,
  tenantId?: number,
  db: Database.Database = getDb(),
): ContentDecisionWorkspaceObject | null {
  const id = positiveInteger(objectId);
  const tenant = positiveInteger(tenantId ?? userId);
  if (id == null || tenant == null || positiveInteger(userId) == null) return null;
  const scope = { tenantId: tenant, userId };
  const item = getContentWorkspaceItem(scope, id, db);
  if (!item || item.itemType !== 'content_item') return null;
  const artifact = item.currentArtifactId == null ? null : getContentArtifact(scope, item.currentArtifactId, db);
  const row = db.prepare(`
    SELECT review_reason_codes_json
      FROM content_domain_objects
     WHERE id = ? AND tenant_id = ? AND owner_user_id = ?
       AND object_type = 'content_item'
       AND visibility_scope = 'user_private' AND scope_status = 'active'
     LIMIT 1
  `).get(item.id, tenant, userId) as { review_reason_codes_json: string | null } | undefined;
  if (!row) return null;
  const approvalState = approvalStateFor(item.productionState);
  return {
    id: item.id,
    tenantId: tenant,
    ownerUserId: userId,
    visibilityScope: 'user_private',
    objectType: decisionObjectType(artifact),
    title: item.title,
    editorialState: editorialStateFor(item.productionState, item.artifactPhase),
    productionState: item.productionState,
    approvalState,
    reviewRequired: item.productionState === 'review',
    reviewReasonCodes: item.productionState === 'review' ? parseStringArray(row.review_reason_codes_json) : [],
    workflowVersion: item.workflowVersion,
    updatedAt: item.updatedAt,
  };
}

export function decideContentWorkspaceReview(input: {
  userId: number;
  tenantId?: number;
  objectId: number | string;
  decision: 'approved' | 'rejected' | 'rewrite_requested';
  actorUserId?: number;
  expectedWorkflowVersion?: number;
  idempotencyKey?: string;
  approvalType?: string;
  reason?: string | null;
  metadata?: Record<string, unknown>;
}, db: Database.Database = getDb()): ContentDecisionReviewResult {
  const object = getContentDecisionWorkspaceObject(input.userId, input.objectId, input.tenantId, db);
  if (!object || (input.actorUserId != null && input.actorUserId !== input.userId)) {
    return { ok: false, status: 'not_found', object: null, reasonCodes: ['content_item_not_found_or_unauthorized'] };
  }
  if (input.approvalType !== 'content_review') {
    return { ok: false, status: 'invalid_transition', object, reasonCodes: ['explicit_content_review_approval_required'] };
  }
  if (!Number.isInteger(input.expectedWorkflowVersion) || Number(input.expectedWorkflowVersion) <= 0) {
    return { ok: false, status: 'version_conflict', object, reasonCodes: ['workflow_version_conflict'] };
  }
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.trim().length < 8) {
    return { ok: false, status: 'invalid_transition', object, reasonCodes: ['idempotency_key_required'] };
  }
  if (input.decision === 'approved' && object.productionState === 'approved') {
    return { ok: true, status: 'approved', object, reasonCodes: ['canonical_approval_already_applied'] };
  }
  if (input.decision === 'rewrite_requested' && object.productionState !== 'review') {
    const replayKey = childIdempotencyKey(input.idempotencyKey, 'rewrite_requested');
    const replay = db.prepare(`
      SELECT 1
        FROM content_mutation_receipts
       WHERE tenant_id = ? AND owner_user_id = ?
         AND operation = ? AND idempotency_key = ?
       LIMIT 1
    `).get(object.tenantId, object.ownerUserId, `transition_item:${object.id}`, replayKey);
    if (replay && object.productionState === 'active') {
      return { ok: true, status: 'rewrite_requested', object, reasonCodes: ['canonical_rewrite_request_already_applied'] };
    }
    return { ok: false, status: 'invalid_transition', object, reasonCodes: ['content_item_not_in_review'] };
  }
  try {
    const scope = { tenantId: object.tenantId, userId: object.ownerUserId };
    db.transaction(() => {
      let expectedVersion = input.expectedWorkflowVersion!;
      if (input.decision === 'approved' && object.productionState === 'active') {
        // An explicit Decision approval may submit the exact saved candidate for
        // review and approve it atomically. The first canonical transition still
        // enforces a saved revision; the second enforces current lineage/claims.
        const reviewed = transitionContentWorkspaceItem({
          scope,
          itemId: object.id,
          targetState: 'review',
          expectedWorkflowVersion: expectedVersion,
          idempotencyKey: childIdempotencyKey(input.idempotencyKey!, 'review'),
        }, db).value;
        expectedVersion = reviewed.workflowVersion;
      }
      transitionContentWorkspaceItem({
        scope,
        itemId: object.id,
        targetState: input.decision === 'approved'
          ? 'approved'
          : input.decision === 'rewrite_requested' ? 'active' : 'rejected',
        expectedWorkflowVersion: expectedVersion,
        idempotencyKey: childIdempotencyKey(input.idempotencyKey!, input.decision),
        ...(input.decision === 'rewrite_requested'
          ? {
              reasonCode: 'changes_requested' as const,
              auditContext: rewriteAuditContext(input.metadata),
            }
          : {}),
      }, db);
    }).immediate();
    return {
      ok: true,
      status: input.decision,
      object: getContentDecisionWorkspaceObject(input.userId, object.id, input.tenantId, db),
      reasonCodes: [],
    };
  } catch (error) {
    if (error instanceof ContentWorkspaceError) {
      return {
        ok: false,
        status: error.code === 'CONTENT_WORKFLOW_VERSION_CONFLICT' ? 'version_conflict' : 'invalid_transition',
        object: getContentDecisionWorkspaceObject(input.userId, object.id, input.tenantId, db),
        reasonCodes: [error.code, ...stringArray(error.details?.reasonCodes)],
      };
    }
    throw error;
  }
}

function rewriteAuditContext(metadata: Record<string, unknown> | undefined): {
  source: 'decision_center' | 'decision_center_command_bus';
  action: 'request_rewrite';
  decisionId?: string;
} {
  const source = metadata?.source === 'decision_center_command_bus'
    ? 'decision_center_command_bus'
    : 'decision_center';
  const decisionId = typeof metadata?.decisionId === 'string'
    && metadata.decisionId.trim().length > 0
    && metadata.decisionId.trim().length <= 200
    ? metadata.decisionId.trim()
    : undefined;
  return {
    source,
    action: 'request_rewrite',
    ...(decisionId ? { decisionId } : {}),
  };
}

function childIdempotencyKey(parent: string, step: string): string {
  const compact = `${parent}:${step}`;
  if (compact.length <= 200) return compact;
  // Parent was already validated and the deterministic suffix preserves the
  // two distinct canonical receipts without leaking content.
  return `${parent.slice(0, 180)}:${step}`;
}

function positiveInteger(value: unknown): number | null {
  const number = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function approvalStateFor(state: ContentProductionState): ContentDecisionWorkspaceObject['approvalState'] {
  if (state === 'review') return 'required';
  if (state === 'approved') return 'approved';
  if (state === 'rejected') return 'rejected';
  return 'not_required';
}

function editorialStateFor(state: ContentProductionState, phase: string): string {
  if (state === 'review') return 'reviewed';
  if (['approved', 'scheduled', 'published', 'archived', 'rejected'].includes(state)) return state;
  if (phase === 'outline') return 'outlined';
  if (phase === 'draft' || phase === 'final') return 'drafted';
  return 'idea';
}

function decisionObjectType(artifact: ContentArtifact | null): string {
  if (typeof artifact?.metadata?.legacyObjectType === 'string') return artifact.metadata.legacyObjectType;
  return artifact?.artifactType ?? 'content_item';
}

function parseStringArray(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  try {
    return stringArray(JSON.parse(value));
  } catch {
    return [];
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}
