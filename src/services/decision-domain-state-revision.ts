// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHash } from 'node:crypto';
import { getContentDecisionWorkspaceObject as getContentWorkflowObject } from './content-workspace-decision-adapter';
import { getDb } from './database';

export interface DecisionDomainStateScope {
  userId: number;
  tenantId: number;
}

/** Privacy-safe revision for one scoped monthly Finance tax event. */
export function financeTaxEventStateRevision(
  scope: DecisionDomainStateScope,
  month: string,
): string | null {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return null;
  try {
    const row = getDb().prepare(`
      SELECT id, status, updated_at AS updatedAt
        FROM finance_tax_events
       WHERE user_id = ? AND tenant_id = ? AND month = ?
       LIMIT 1
    `).get(scope.userId, scope.tenantId, month) as {
      id: number;
      status: string;
      updatedAt: string;
    } | undefined;
    return row ? stateRevision('finance_tax_event', { month, ...row }) : null;
  } catch {
    return null;
  }
}

/**
 * Privacy-safe revision for a scoped meal-plan slot. `absent` is an explicit
 * authoritative state so a proposal to add a meal is invalidated if another
 * actor fills the slot before execution.
 */
export function cookingMealSlotStateRevision(
  scope: DecisionDomainStateScope,
  slot: string,
): string | null {
  const match = slot.match(/^(\d{4}-\d{2}-\d{2}):([a-z][a-z0-9_-]{0,39})$/i);
  if (!match) return null;
  try {
    const row = getDb().prepare(`
      SELECT id, lifecycle_state AS lifecycleState, scope_status AS scopeStatus,
             recipe_id AS recipeId, title, notes, created_at AS createdAt
        FROM meal_plans
       WHERE user_id = ? AND owner_user_id = ? AND tenant_id = ?
         AND date = ? AND meal_type = ?
       LIMIT 1
    `).get(scope.userId, scope.userId, scope.tenantId, match[1], match[2]) as {
      id: number;
      lifecycleState: string;
      scopeStatus: string;
      recipeId: number | null;
      title: string;
      notes: string | null;
      createdAt: string;
    } | undefined;
    return row ? stateRevision('cooking_meal_slot', row) : 'absent';
  } catch {
    return null;
  }
}

/** Direct private-owner Content state only; tenant-shared role semantics fail closed. */
export function contentWorkflowStateRevision(
  scope: DecisionDomainStateScope,
  objectId: string,
): string | null {
  if (!/^(0|[1-9][0-9]{0,18})$/.test(objectId)) return null;
  try {
    const object = getContentWorkflowObject(scope.userId, objectId, scope.tenantId);
    if (!object
        || object.ownerUserId !== scope.userId
        || object.tenantId !== scope.tenantId
        || object.visibilityScope !== 'user_private') return null;
    return stateRevision('content_workflow_object', {
      id: object.id,
      workflowVersion: object.workflowVersion,
      approvalState: object.approvalState,
      editorialState: object.editorialState,
      reviewRequired: object.reviewRequired,
      reviewReasonCodes: object.reviewReasonCodes,
      updatedAt: object.updatedAt,
    });
  } catch {
    return null;
  }
}

function stateRevision(domain: string, value: Record<string, unknown>): string {
  return `${domain}_${createHash('sha256').update(stableJson(value)).digest('hex').slice(0, 32)}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}
