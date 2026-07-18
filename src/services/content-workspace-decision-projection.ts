// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Outbound Content workspace projection into Decision Center.
 *
 * Content remains the source of truth for revisions and workflow state.
 * Decision Center receives only a scoped, idempotent review request whose
 * actions re-enter Content through the existing CAS/idempotency adapter.
 */

import type Database from 'better-sqlite3';
import { createDecisionIntent } from './decision-center';
import { getDb } from './database';
import {
  getContentArtifact,
  getContentWorkspaceItem,
  type ContentWorkspaceScope,
} from './content-workspace';

export const CONTENT_REVIEW_DECISION_PROJECTION_VERSION =
  'content-review-decision-projection-v1' as const;

export interface ContentReviewDecisionProjection {
  schemaVersion: typeof CONTENT_REVIEW_DECISION_PROJECTION_VERSION;
  status: 'projected' | 'already_projected' | 'not_in_review' | 'source_unavailable' | 'filtered' | 'unavailable';
  itemId: number;
  workflowVersion: number | null;
  decisionId: string | null;
  retryable: boolean;
  explanation: string;
}

/** Truthful fallback returned after Content is safely saved but Decision Center is unavailable. */
export function unavailableContentWorkspaceReviewDecision(
  itemId: number,
  workflowVersion: number | null,
): ContentReviewDecisionProjection {
  return projection('unavailable', itemId, workflowVersion, null, true,
    'The content item is safely in review, but Decision Center could not be updated. Retry from this item.');
}

export async function ensureContentWorkspaceReviewDecision(
  scopeInput: ContentWorkspaceScope,
  itemIdInput: number,
  db: Database.Database = getDb(),
): Promise<ContentReviewDecisionProjection> {
  const scope = normalizeScope(scopeInput);
  const itemId = positiveInteger(itemIdInput, 'itemId');
  const item = getContentWorkspaceItem(scope, itemId, db);
  if (!item || item.itemType !== 'content_item') {
    return projection('source_unavailable', itemId, null, null, true,
      'The scoped content item is unavailable. Reload the workspace before retrying review.');
  }
  if (item.productionState !== 'review') {
    return projection('not_in_review', item.id, item.workflowVersion, null, false,
      'Decision Center is only used after a saved content version enters review.');
  }
  const artifact = item.currentArtifactId == null
    ? null
    : getContentArtifact(scope, item.currentArtifactId, db);
  if (!artifact?.currentRevision) {
    return projection('source_unavailable', item.id, item.workflowVersion, null, true,
      'The review request has no readable current revision. No decision was created.');
  }

  const dedupeKey = [
    'content',
    'workspace_review',
    scope.tenantId,
    scope.userId,
    item.id,
    item.workflowVersion,
  ].join(':');
  const existing = findProjectedDecision(db, scope, dedupeKey);
  if (existing) {
    return projection('already_projected', item.id, item.workflowVersion, existing, false,
      'The current saved version is already waiting in Decision Center.');
  }

  const result = await createDecisionIntent({
    userId: scope.userId,
    tenantId: scope.tenantId,
    sourceSkill: 'content',
    type: 'approval_required',
    priority: item.deadlineAt ? 'time_sensitive' : 'active',
    relatedEntityId: item.id,
    relatedEntityType: 'content_workflow_object',
    title: 'Content review needed',
    body: 'A saved content version is ready for your approval or change request.',
    sensitiveBody: `${item.title} · version ${artifact.currentRevision.revisionNumber}`,
    actionButtons: [
      {
        id: 'approve_script',
        label: 'Approve',
        style: 'primary',
        deeplink: `nexus://content/item/${item.id}?action=trust`,
        mutating: true,
      },
      {
        id: 'request_rewrite',
        label: 'Request changes',
        style: 'secondary',
        deeplink: `nexus://content/item/${item.id}?action=edit`,
        mutating: true,
      },
    ],
    deeplink: `nexus://content/item/${item.id}?action=trust`,
    dedupeKey,
    requiresUserAction: true,
    decisionDeadline: item.deadlineAt,
    deliveryPolicy: 'in_app_only',
    privacyPolicy: 'private_content',
    visibilityScope: 'user_private',
    decisionContext: {
      entityTitle: item.title,
      sourceState: 'review',
      deadlineAt: item.deadlineAt ?? undefined,
      reasonCodes: ['content_saved_revision_ready_for_review'],
    },
  });

  if (!result.item) {
    return projection('filtered', item.id, item.workflowVersion, null, true,
      'Decision Center did not accept the review request. The Content item remains safely in review and can be retried.');
  }
  return projection('projected', item.id, item.workflowVersion, result.item.decisionId, false,
    'The current saved version is waiting for your decision.');
}

function findProjectedDecision(
  db: Database.Database,
  scope: ContentWorkspaceScope,
  dedupeKey: string,
): string | null {
  const row = db.prepare(`
    SELECT item_id
      FROM notification_center_items
     WHERE tenant_id = ? AND user_id = ?
       AND source_skill = 'content'
       AND dedupe_key = ?
       AND status IN ('unread', 'read', 'viewed', 'snoozed', 'open')
     ORDER BY created_at DESC, item_id DESC
     LIMIT 1
  `).get(scope.tenantId, scope.userId, dedupeKey) as { item_id: string } | undefined;
  return row?.item_id ?? null;
}

function projection(
  status: ContentReviewDecisionProjection['status'],
  itemId: number,
  workflowVersion: number | null,
  decisionId: string | null,
  retryable: boolean,
  explanation: string,
): ContentReviewDecisionProjection {
  return {
    schemaVersion: CONTENT_REVIEW_DECISION_PROJECTION_VERSION,
    status,
    itemId,
    workflowVersion,
    decisionId,
    retryable,
    explanation,
  };
}

function normalizeScope(scope: ContentWorkspaceScope): ContentWorkspaceScope {
  return {
    tenantId: positiveInteger(scope?.tenantId, 'tenantId'),
    userId: positiveInteger(scope?.userId, 'userId'),
  };
}

function positiveInteger(value: unknown, field: string): number {
  const number = typeof value === 'number' ? value : NaN;
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return number;
}
