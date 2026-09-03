// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type Database from 'better-sqlite3';
import { getDb } from './database';
import {
  decideContentWorkspaceReview as decideContentApproval,
  getContentDecisionWorkspaceObject as getContentWorkflowObject,
  type ContentDecisionWorkspaceObject as ContentWorkflowObject,
} from './content-workspace-decision-adapter';
import type { DecisionApiItem } from './decision-center';
import { hashStable } from './chat-core-v2/deterministic-read/common';
import { invalidateContentDerivedCaches } from './cache-coherence-registry';

export const DECISION_COMMAND_EFFECTS_VERSION = 'decision_command_effects@1.0.0';

export type DecisionContentCommandAction = 'approve_script' | 'request_rewrite';

export interface DecisionCommandProjectionResult {
  decisionId: string;
  decisionStatus: 'actioned';
  recordVersion: number;
  actionResult: Record<string, unknown>;
}

export interface DecisionContentCommandResult extends DecisionCommandProjectionResult {
  contentObjectId: number;
  contentApprovalState: 'approved' | 'rewrite_requested';
}

/**
 * Command Bus content actions intentionally support only a direct private
 * workflow-object anchor owned by the authenticated actor. Older
 * content_notification indirection and tenant-shared objects keep using the
 * legacy executor until the product has an explicit tenant approver role.
 */
export function directOwnedContentObjectForDecision(
  item: Pick<DecisionApiItem, 'sourceSkill' | 'relatedEntities'>,
  userId: number,
  tenantId: number,
): ContentWorkflowObject | null {
  if (item.sourceSkill !== 'content') return null;
  const target = item.relatedEntities.find((entity) => entity.type === 'content_workflow_object');
  if (!target?.id) return null;
  const object = getContentWorkflowObject(userId, target.id, tenantId);
  if (!object) return null;
  if (object.ownerUserId !== userId || object.tenantId !== tenantId || object.visibilityScope !== 'user_private') {
    return null;
  }
  return object;
}

export function contentApprovalVersionForObject(object: ContentWorkflowObject): string {
  return hashStable({
    id: object.id,
    tenantId: object.tenantId,
    ownerUserId: object.ownerUserId,
    visibilityScope: object.visibilityScope,
    editorialState: object.editorialState,
    approvalState: object.approvalState,
    reviewRequired: object.reviewRequired,
    reviewReasonCodes: object.reviewReasonCodes,
    workflowVersion: object.workflowVersion,
    updatedAt: object.updatedAt,
  });
}

export function executeDecisionContentCommand(input: {
  item: DecisionApiItem;
  actionId: DecisionContentCommandAction;
  userId: number;
  tenantId: number;
  expectedContentVersion: string;
  db?: Database.Database;
}): DecisionContentCommandResult {
  const db = input.db ?? getDb();
  const committed = db.transaction(() => {
    const object = directOwnedContentObjectForDecision(input.item, input.userId, input.tenantId);
    if (!object) throw new Error('DECISION_CONTENT_TARGET_NOT_AUTHORIZED');
    if (contentApprovalVersionForObject(object) !== input.expectedContentVersion) {
      throw new Error('DECISION_CONTENT_TARGET_STALE');
    }

    const expectedContentState: 'approved' | 'rewrite_requested' = input.actionId === 'approve_script'
      ? 'approved'
      : 'rewrite_requested';
    const result = decideContentApproval({
      userId: input.userId,
      tenantId: input.tenantId,
      objectId: object.id,
      actorUserId: input.userId,
      approvalType: 'content_review',
      expectedWorkflowVersion: object.workflowVersion,
      idempotencyKey: `decision-content:${input.item.decisionId}:${input.actionId}`,
      decision: expectedContentState,
      reason: input.actionId === 'request_rewrite' ? 'Requested changes from Decision Center' : null,
      metadata: {
        source: 'decision_center_command_bus',
        decisionId: input.item.decisionId,
        actionId: input.actionId,
        effectsVersion: DECISION_COMMAND_EFFECTS_VERSION,
      },
    });
    const verifiedObject = getContentWorkflowObject(input.userId, object.id, input.tenantId);
    const sourceStateMatches = input.actionId === 'approve_script'
      ? verifiedObject?.productionState === 'approved' && verifiedObject.approvalState === 'approved'
      : verifiedObject?.productionState === 'active' && verifiedObject.approvalState === 'not_required';
    if (!result.ok || result.status !== expectedContentState || !verifiedObject || !sourceStateMatches) {
      throw new Error('DECISION_CONTENT_READBACK_MISMATCH');
    }

    const projection = markDecisionProjectionActioned({
      item: input.item,
      actionId: input.actionId,
      userId: input.userId,
      tenantId: input.tenantId,
      actionResult: {
        contentObjectId: object.id,
        approvalState: verifiedObject.approvalState,
        workflowState: verifiedObject.productionState,
        contentApprovalState: expectedContentState,
        providerActionExecuted: false,
      },
      db,
    });

    return {
      ...projection,
      contentObjectId: object.id,
      contentApprovalState: expectedContentState,
    };
  })();
  invalidateContentDerivedCaches(input.userId);
  return committed;
}

export function executeDecisionChatFixerProjection(input: {
  item: DecisionApiItem;
  userId: number;
  tenantId: number;
  db?: Database.Database;
}): DecisionCommandProjectionResult {
  const db = input.db ?? getDb();
  return db.transaction(() => {
    const anchor = db.prepare(`
      SELECT items.status, items.record_version AS recordVersion,
             intents.source_skill AS sourceSkill,
             intents.related_entity_id AS relatedEntityId,
             intents.related_entity_type AS relatedEntityType
        FROM notification_center_items items
        JOIN notification_intents intents ON intents.intent_id = items.intent_id
       WHERE items.item_id = ? AND items.user_id = ? AND items.tenant_id = ?
       LIMIT 1
    `).get(input.item.decisionId, input.userId, input.tenantId) as {
      status: string;
      recordVersion: number;
      sourceSkill: string;
      relatedEntityId: string | null;
      relatedEntityType: string | null;
    } | undefined;
    if (!anchor
        || anchor.sourceSkill !== 'chat'
        || anchor.relatedEntityType !== 'chat_action_fixer_review'
        || !anchor.relatedEntityId
        || anchor.recordVersion !== input.item.recordVersion
        || !isProjectionEligibleStatus(anchor.status)) {
      throw new Error('DECISION_CHAT_FIXER_NOT_ACTIONABLE');
    }

    return markDecisionProjectionActioned({
      item: input.item,
      actionId: 'accept_chat_action_fix',
      userId: input.userId,
      tenantId: input.tenantId,
      actionResult: {
        fixerReviewId: anchor.relatedEntityId,
        providerActionExecuted: false,
        freshConfirmationRequired: true,
      },
      db,
    });
  })();
}

function markDecisionProjectionActioned(input: {
  item: DecisionApiItem;
  actionId: string;
  userId: number;
  tenantId: number;
  actionResult: Record<string, unknown>;
  db: Database.Database;
}): DecisionCommandProjectionResult {
  const serializedResult = JSON.stringify({ actionId: input.actionId, ...input.actionResult });
  const update = input.db.prepare(`
    UPDATE notification_center_items
       SET status = 'actioned', actioned_at = datetime('now'), action_result_json = ?,
           record_version = record_version + 1, updated_at = datetime('now')
     WHERE item_id = ? AND user_id = ? AND tenant_id = ? AND record_version = ?
       AND status IN ('unread', 'read', 'failed', 'snoozed')
       AND EXISTS (
         SELECT 1 FROM decision_action_executions executions
          WHERE executions.decision_id = notification_center_items.item_id
            AND executions.user_id = notification_center_items.user_id
            AND executions.tenant_id = notification_center_items.tenant_id
            AND executions.action_id = ?
            AND executions.status = 'started'
       )
  `).run(
    serializedResult,
    input.item.decisionId,
    input.userId,
    input.tenantId,
    input.item.recordVersion,
    input.actionId,
  );
  if (update.changes !== 1) throw new Error('DECISION_PROJECTION_CAS_FAILED');

  const readBack = input.db.prepare(`
    SELECT status, record_version AS recordVersion, action_result_json AS actionResultJson
      FROM notification_center_items
     WHERE item_id = ? AND user_id = ? AND tenant_id = ?
     LIMIT 1
  `).get(input.item.decisionId, input.userId, input.tenantId) as {
    status: string;
    recordVersion: number;
    actionResultJson: string | null;
  } | undefined;
  const actionResult = parseRecord(readBack?.actionResultJson);
  if (!readBack
      || readBack.status !== 'actioned'
      || readBack.recordVersion !== input.item.recordVersion + 1
      || actionResult.actionId !== input.actionId) {
    throw new Error('DECISION_PROJECTION_READBACK_MISMATCH');
  }
  return {
    decisionId: input.item.decisionId,
    decisionStatus: 'actioned',
    recordVersion: readBack.recordVersion,
    actionResult,
  };
}

function isProjectionEligibleStatus(status: string): boolean {
  return status === 'unread' || status === 'read' || status === 'failed' || status === 'snoozed';
}

function parseRecord(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}
