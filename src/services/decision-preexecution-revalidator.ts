// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { getDb } from './database';
import { hasConnectedCalendarForUser, hasWritableCalendarForUser } from './unified-calendar';
import { loadDecisionConflictContext } from './decision-conflict-context';
import {
  evaluateDecisionConflicts,
  normalizeConflictComparisonAction,
  type ConflictComparisonAction,
  type ConflictEvaluation,
} from './decision-conflict-evaluator';
import type {
  DecisionActionPrecondition,
  NormalizedDecisionAction,
} from './decision-action-contract';
import {
  secretaryAgendaStateRevision,
  type SecretaryAgendaStateRevisionInput,
} from './secretary-agenda-state-revision';
import {
  contentWorkflowStateRevision,
  cookingMealSlotStateRevision,
  financeTaxEventStateRevision,
} from './decision-domain-state-revision';
import {
  getTrainingPlanRevisionV1Mode,
  isTrainingPlanRevisionV1ExplicitlyEnrolled,
} from './runtime-flags';
import {
  computeTrainingRevisionAuthoritativeContext,
  deriveTrainingRevisionCreationContextVersion,
} from './training-plan-revisions';

export interface DecisionRevalidationScope {
  userId: number;
  tenantId: number;
}

export interface DecisionPreconditionResult {
  type: string;
  ref: string;
  ok: boolean;
  reasonCode?: string;
  currentVersion?: string;
}

export interface DecisionPreconditionAdapter {
  type: string;
  validate(input: {
    scope: DecisionRevalidationScope;
    precondition: DecisionActionPrecondition;
  }): DecisionPreconditionResult;
}

export interface DecisionPreexecutionRevalidation {
  authorizationAllowed: boolean;
  missingPermissions: string[];
  preconditions: DecisionPreconditionResult[];
  conflictEvaluation: ConflictEvaluation;
  contextSourcesHealthy: boolean;
  canExecute: boolean;
}

const permissionValidators = new Map<string, (scope: DecisionRevalidationScope) => boolean>([
  ['decision_center:read', () => true],
  ['decision_center:write', () => true],
  ['calendar:read', (scope) => hasConnectedCalendarForUser(scope.userId)],
  ['calendar:write', (scope) => hasWritableCalendarForUser(scope.userId)],
  ['training:plan:write', (scope) => Number.isSafeInteger(scope.userId)
    && scope.userId > 0
    && Number.isSafeInteger(scope.tenantId)
    && scope.tenantId > 0
    && scope.userId === scope.tenantId
    && getTrainingPlanRevisionV1Mode(process.env, scope) === 'active'
    && isTrainingPlanRevisionV1ExplicitlyEnrolled(process.env, scope)],
]);

const preconditionAdapters = new Map<string, DecisionPreconditionAdapter>([
  ['agenda_version', {
    type: 'agenda_version',
    validate: ({ scope, precondition }) => {
      const row = getDb().prepare(`
        SELECT version FROM secretary_agenda_items
         WHERE agenda_item_id = ? AND owner_user_id = ? AND tenant_id = ?
         LIMIT 1
      `).get(precondition.ref, scope.userId, String(scope.tenantId)) as { version: number } | undefined;
      const currentVersion = row ? String(row.version) : undefined;
      return {
        type: precondition.type,
        ref: precondition.ref,
        ok: !!currentVersion && currentVersion === precondition.expectedVersion,
        ...(currentVersion ? { currentVersion } : {}),
        ...(!currentVersion || currentVersion !== precondition.expectedVersion
          ? { reasonCode: 'agenda_version_changed' }
          : {}),
      };
    },
  }],
  ['agenda_state', {
    type: 'agenda_state',
    validate: ({ scope, precondition }) => {
      const row = getDb().prepare(`
        SELECT version, updated_at AS updatedAt, source_shape_hash AS sourceShapeHash,
               start_at AS startAt, end_at AS endAt, lifecycle_state AS lifecycleState,
               provider_sync_state AS providerSyncState, provider_event_id AS providerEventId,
               provider_source AS providerSource, decision_action AS decisionAction,
               decision_reason_codes_json AS decisionReasonCodes,
               decision_explanation AS decisionExplanation,
               scheduled_segments_json AS scheduledSegments
          FROM secretary_agenda_items
         WHERE agenda_item_id = ? AND owner_user_id = ? AND tenant_id = ?
         LIMIT 1
      `).get(precondition.ref, scope.userId, String(scope.tenantId)) as SecretaryAgendaStateRevisionInput | undefined;
      const currentVersion = row ? secretaryAgendaStateRevision(row) : undefined;
      return {
        type: precondition.type,
        ref: precondition.ref,
        ok: !!currentVersion && currentVersion === precondition.expectedVersion,
        ...(currentVersion ? { currentVersion } : {}),
        ...(!currentVersion || currentVersion !== precondition.expectedVersion
          ? { reasonCode: 'agenda_state_changed' }
          : {}),
      };
    },
  }],
  ['finance_tax_state', {
    type: 'finance_tax_state',
    validate: ({ scope, precondition }) => compareDomainRevision(
      precondition,
      financeTaxEventStateRevision(scope, precondition.ref),
      'finance_tax_state_changed',
    ),
  }],
  ['content_workflow_state', {
    type: 'content_workflow_state',
    validate: ({ scope, precondition }) => compareDomainRevision(
      precondition,
      contentWorkflowStateRevision(scope, precondition.ref),
      'content_workflow_state_changed',
    ),
  }],
  ['meal_plan_slot_state', {
    type: 'meal_plan_slot_state',
    validate: ({ scope, precondition }) => compareDomainRevision(
      precondition,
      cookingMealSlotStateRevision(scope, precondition.ref),
      'meal_plan_slot_state_changed',
    ),
  }],
  ['training_revision_content', {
    type: 'training_revision_content',
    validate: ({ scope, precondition }) => {
      const row = getDb().prepare(`
        SELECT content_hash AS currentVersion
          FROM training_plan_revisions
         WHERE revision_id = ? AND user_id = ? AND tenant_id = ?
         LIMIT 1
      `).get(precondition.ref, scope.userId, scope.tenantId) as { currentVersion: string } | undefined;
      return compareDomainRevision(precondition, row?.currentVersion ?? null, 'training_revision_content_changed');
    },
  }],
  ['training_revision_context', {
    type: 'training_revision_context',
    validate: ({ scope, precondition }) => {
      const row = getDb().prepare(`
        SELECT contexts.current_revision_id AS currentRevisionId,
               contexts.base_context_version AS baseContextVersion
          FROM training_plan_revisions revisions
          JOIN training_plan_current_contexts contexts
            ON contexts.tenant_id = revisions.tenant_id
           AND contexts.user_id = revisions.user_id
           AND contexts.family_id = revisions.family_id
         WHERE revisions.revision_id = ?
           AND revisions.user_id = ? AND revisions.tenant_id = ?
         LIMIT 1
      `).get(precondition.ref, scope.userId, scope.tenantId) as {
        currentRevisionId: string;
        baseContextVersion: string;
      } | undefined;
      if (!row || row.currentRevisionId !== precondition.ref) {
        return compareDomainRevision(precondition, null, 'training_revision_context_changed');
      }
      const currentVersion = deriveTrainingRevisionCreationContextVersion(
        row.baseContextVersion,
        computeTrainingRevisionAuthoritativeContext(getDb(), scope),
      );
      return compareDomainRevision(precondition, currentVersion, 'training_revision_context_changed');
    },
  }],
  ['training_revision_policy', {
    type: 'training_revision_policy',
    validate: ({ scope, precondition }) => {
      const row = getDb().prepare(`
        SELECT policy_version AS currentVersion
          FROM training_plan_revisions
         WHERE revision_id = ? AND user_id = ? AND tenant_id = ?
         LIMIT 1
      `).get(precondition.ref, scope.userId, scope.tenantId) as { currentVersion: string } | undefined;
      return compareDomainRevision(precondition, row?.currentVersion ?? null, 'training_revision_policy_changed');
    },
  }],
  ['training_revision_catalog', {
    type: 'training_revision_catalog',
    validate: ({ scope, precondition }) => {
      const row = getDb().prepare(`
        SELECT catalog_version AS catalogVersion, catalog_source_hash AS catalogSourceHash
          FROM training_plan_revisions
         WHERE revision_id = ? AND user_id = ? AND tenant_id = ?
         LIMIT 1
      `).get(precondition.ref, scope.userId, scope.tenantId) as {
        catalogVersion: string;
        catalogSourceHash: string;
      } | undefined;
      const currentVersion = row ? `${row.catalogVersion}:${row.catalogSourceHash}` : null;
      return compareDomainRevision(precondition, currentVersion, 'training_revision_catalog_changed');
    },
  }],
  ['training_active_pointer', {
    type: 'training_active_pointer',
    validate: ({ scope, precondition }) => {
      const row = getDb().prepare(`
        SELECT active_revision_id AS activeRevisionId, pointer_version AS pointerVersion
          FROM training_active_plan_references
         WHERE family_id = ? AND user_id = ? AND tenant_id = ?
         LIMIT 1
      `).get(precondition.ref, scope.userId, scope.tenantId) as {
        activeRevisionId: string;
        pointerVersion: number;
      } | undefined;
      const currentVersion = row
        ? `pointer:${row.pointerVersion}:revision:${row.activeRevisionId}`
        : 'none';
      return compareDomainRevision(precondition, currentVersion, 'training_active_pointer_changed');
    },
  }],
  ['training_adaptation_option', {
    type: 'training_adaptation_option',
    validate: ({ scope, precondition }) => {
      const table = getDb().prepare(`
        SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'training_adaptation_proposals'
      `).get();
      if (!table) return compareDomainRevision(precondition, null, 'training_adaptation_option_changed');
      const row = getDb().prepare(`
        SELECT option_hash AS currentVersion
          FROM training_adaptation_proposals
         WHERE selected_option_id = ? AND user_id = ? AND tenant_id = ?
           AND status IN ('CANDIDATE', 'PENDING_REVIEW', 'DEFERRED')
         LIMIT 1
      `).get(precondition.ref, scope.userId, scope.tenantId) as { currentVersion: string } | undefined;
      return compareDomainRevision(precondition, row?.currentVersion ?? null, 'training_adaptation_option_changed');
    },
  }],
]);

function compareDomainRevision(
  precondition: DecisionActionPrecondition,
  currentVersion: string | null,
  reasonCode: string,
): DecisionPreconditionResult {
  const ok = currentVersion !== null && currentVersion === precondition.expectedVersion;
  return {
    type: precondition.type,
    ref: precondition.ref,
    ok,
    ...(currentVersion !== null ? { currentVersion } : {}),
    ...(!ok ? { reasonCode } : {}),
  };
}


export function registerDecisionPermissionValidator(
  scopeName: string,
  validator: (scope: DecisionRevalidationScope) => boolean,
): void {
  permissionValidators.set(scopeName, validator);
}

export function registerDecisionPreconditionAdapter(adapter: DecisionPreconditionAdapter): void {
  preconditionAdapters.set(adapter.type, adapter);
}

export function revalidateNormalizedDecisionAction(input: {
  scope: DecisionRevalidationScope;
  action: NormalizedDecisionAction;
  decisionId?: string;
  decisionApproved?: boolean;
  replacementApproved?: boolean;
  contextExpiresAt?: string;
  candidateCreatedAt?: string;
  confirmationApproved?: boolean;
  confidence?: 'low' | 'medium' | 'high';
  allowLowRiskAutoResolution?: boolean;
  /**
   * Validated, privacy-safe producer comparisons persisted with the proposal.
   * These preserve authoritative external commitments that cannot be recovered
   * from the local Decision Center/agenda read model during a later refresh.
   */
  additionalExisting?: ConflictComparisonAction[];
  now?: Date;
}): DecisionPreexecutionRevalidation {
  const now = input.now ?? new Date();
  const missingPermissions = input.action.authorizationScope.filter((required) => {
    const validator = permissionValidators.get(required);
    if (!validator) return true; // Unknown permission semantics fail closed.
    try { return !validator(input.scope); } catch { return true; }
  });
  const preconditions = input.action.preconditions
    .filter((precondition) => precondition.required)
    .map((precondition): DecisionPreconditionResult => {
      const adapter = preconditionAdapters.get(precondition.type);
      if (!adapter) {
        return { type: precondition.type, ref: precondition.ref, ok: false, reasonCode: 'unsupported_required_precondition' };
      }
      try { return adapter.validate({ scope: input.scope, precondition }); } catch {
        return { type: precondition.type, ref: precondition.ref, ok: false, reasonCode: 'precondition_source_unavailable' };
      }
    });
  const context = loadDecisionConflictContext({
    scope: input.scope,
    candidate: input.action,
    excludeDecisionId: input.decisionId,
    now,
  });
  const existingByIdentity = new Map<string, ConflictComparisonAction>();
  const suppliedAdditionalExisting = input.additionalExisting ?? [];
  const additionalExisting = suppliedAdditionalExisting.flatMap((value) => {
    const comparison = normalizeConflictComparisonAction(value);
    return comparison ? [comparison] : [];
  });
  // Persisted producer comparisons are fallback evidence. Fresh authoritative
  // context must win any identity collision during revalidation.
  for (const comparison of [...additionalExisting, ...context.existing]) {
    const identity = comparison.decisionId ?? comparison.action.logicalActionHash;
    if (input.decisionId !== undefined && comparison.decisionId === input.decisionId) continue;
    existingByIdentity.set(identity, comparison);
  }
  const contextSourcesHealthy = context.sourceHealth.every((source) => source.status === 'available');
  const missingRequiredPreconditions = preconditions
    .filter((precondition) => !precondition.ok)
    .map((precondition) => `${precondition.type}:${precondition.reasonCode ?? 'failed'}`);
  if (!contextSourcesHealthy) missingRequiredPreconditions.push('authoritative_conflict_context');
  if (additionalExisting.length !== suppliedAdditionalExisting.length) {
    missingRequiredPreconditions.push('persisted_conflict_comparison_invalid');
  }
  const conflictEvaluation = evaluateDecisionConflicts({
    candidate: input.action,
    existing: [...existingByIdentity.values()],
    now,
    authorizationAllowed: missingPermissions.length === 0,
    missingRequiredPreconditions,
    activeExecutionExclusivityKeys: context.activeExecutionExclusivityKeys,
    candidateAuthority: input.replacementApproved
      ? 'explicit_user_instruction'
      : input.decisionApproved ? 'approved_commitment' : 'optimization',
    candidateApproved: input.decisionApproved === true,
    candidateDecisionId: input.decisionId,
    candidateCreatedAt: input.candidateCreatedAt,
    confirmationApproved: input.confirmationApproved === true,
    contextExpiresAt: input.contextExpiresAt,
    entityVersionsMatch: preconditions.every((precondition) => precondition.ok),
    replacementApproved: input.replacementApproved === true,
    confidence: input.confidence,
    allowLowRiskAutoResolution: input.allowLowRiskAutoResolution === true,
  });
  return {
    authorizationAllowed: missingPermissions.length === 0,
    missingPermissions,
    preconditions,
    conflictEvaluation,
    contextSourcesHealthy,
    canExecute: conflictEvaluation.disposition === 'allow' || conflictEvaluation.disposition === 'auto_resolve',
  };
}

export function isLowRiskAutoReflowEligible(input: {
  action: NormalizedDecisionAction;
  conflictEvaluation: ConflictEvaluation;
  persistedUserOptIn: boolean;
  runtimeEnabled: boolean;
  undoAvailable: boolean;
}): boolean {
  return input.runtimeEnabled
    && input.persistedUserOptIn
    && input.undoAvailable
    && input.action.risk === 'low'
    && input.action.reversibility === 'reversible'
    && input.action.intent.includes('reflow')
    && input.conflictEvaluation.disposition === 'auto_resolve';
}
