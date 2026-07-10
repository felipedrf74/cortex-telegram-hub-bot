// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHash } from 'node:crypto';
import { getDb } from './database';
import {
  buildNormalizedDecisionAction,
  type DecisionActionEntityRef,
  type DecisionActionResourceRef,
  type NormalizedDecisionAction,
} from './decision-action-contract';
import type { ConflictComparisonAction } from './decision-conflict-evaluator';
import { financeTaxEventStateRevision } from './decision-domain-state-revision';

export interface DomainCommitmentScope {
  userId: number;
  tenantId: number;
}

export interface DomainCommitmentAdapter {
  id: string;
  loadComparisons(input: {
    scope: DomainCommitmentScope;
    candidate: NormalizedDecisionAction;
    excludeDecisionId?: string;
    now: Date;
  }): ConflictComparisonAction[];
}

const MAX_MATCHED_ENTITIES = 24;

/**
 * Built-in projections of authoritative local domain state. These adapters
 * deliberately use only lifecycle/version columns and opaque identifiers.
 * User-authored titles, notes, finance values, health data, and provider
 * payloads never enter normalized actions or conflict audit records.
 */
export const DOMAIN_COMMITMENT_ADAPTERS: readonly DomainCommitmentAdapter[] = [
  { id: 'training_active_commitments', loadComparisons: loadTrainingCommitments },
  { id: 'content_approved_commitments', loadComparisons: loadContentCommitments },
  { id: 'cooking_planned_commitments', loadComparisons: loadCookingCommitments },
  { id: 'finance_active_tax_state', loadComparisons: loadFinanceCommitments },
  { id: 'tasks_open_commitments', loadComparisons: loadTaskCommitments },
] as const;

function loadTrainingCommitments(input: {
  scope: DomainCommitmentScope;
  candidate: NormalizedDecisionAction;
}): ConflictComparisonAction[] {
  if (!touchesDomain(input.candidate, 'training')) return [];
  const planIds = numericEntityIds(input.candidate, ['training_plan', 'fitness_training_plan']);
  const sessionIds = numericEntityIds(input.candidate, ['training_session']);
  const broadTrainingState = input.candidate.affectedResources.some((resource) => resource.type === 'training_state')
    || input.candidate.exclusivityKeys.some((key) => key.startsWith('training_state:'));
  if (!broadTrainingState && planIds.length === 0 && sessionIds.length === 0) return [];

  const planRows = broadTrainingState || planIds.length > 0
    ? getDb().prepare(`
        SELECT id, plan_version AS planVersion, adaptation_revision AS adaptationRevision,
               status, created_at AS createdAt, updated_at AS updatedAt
          FROM fitness_training_plans
         WHERE user_id = ? AND tenant_id = ? AND status = 'active'
           ${planIds.length > 0 && !broadTrainingState ? `AND id IN (${placeholders(planIds)})` : ''}
         ORDER BY updated_at DESC, id ASC
         LIMIT 50
      `).all(input.scope.userId, input.scope.tenantId, ...(!broadTrainingState ? planIds : [])) as Array<{
        id: number;
        planVersion: number;
        adaptationRevision: number;
        status: string;
        createdAt: string;
        updatedAt: string;
      }>
    : [];

  const comparisons = planRows.map((row) => commitmentComparison({
    candidate: input.candidate,
    domain: 'training',
    target: {
      type: 'training_plan',
      id: String(row.id),
      version: `plan:${row.planVersion}:adaptation:${row.adaptationRevision}`,
    },
    fallbackResource: { type: 'training_plan', id: String(row.id) },
    fallbackExclusivityKey: `training_plan:${input.scope.tenantId}:${row.id}`,
    intent: 'preserve_active_training_plan',
    effectType: 'preserve_training_commitment',
    authority: 'approved_commitment',
    approved: true,
    risk: 'medium',
    stateVersion: stateVersion('training', {
      id: row.id,
      planVersion: row.planVersion,
      adaptationRevision: row.adaptationRevision,
      status: row.status,
      updatedAt: row.updatedAt,
    }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));

  if (sessionIds.length === 0) return comparisons;
  const sessionRows = getDb().prepare(`
    SELECT sessions.id, sessions.plan_id AS planId, sessions.status,
           sessions.session_shape_hash AS sessionShapeHash,
           sessions.created_at AS createdAt, sessions.updated_at AS updatedAt,
           plans.plan_version AS planVersion, plans.adaptation_revision AS adaptationRevision
      FROM training_sessions sessions
      JOIN fitness_training_plans plans ON plans.id = sessions.plan_id
     WHERE plans.user_id = ? AND plans.tenant_id = ? AND plans.status = 'active'
       AND sessions.status NOT IN (
         'rest', 'completed', 'skipped', 'unscheduled', 'deferred',
         'dropped', 'cancelled', 'superseded'
       )
       AND sessions.id IN (${placeholders(sessionIds)})
     ORDER BY sessions.updated_at DESC, sessions.id ASC
     LIMIT 24
  `).all(input.scope.userId, input.scope.tenantId, ...sessionIds) as Array<{
    id: number;
    planId: number;
    planVersion: number;
    adaptationRevision: number;
    status: string;
    sessionShapeHash: string | null;
    createdAt: string;
    updatedAt: string;
  }>;

  comparisons.push(...sessionRows.map((row) => {
    const version = stateVersion('training_session', {
      id: row.id,
      planId: row.planId,
      planVersion: row.planVersion,
      adaptationRevision: row.adaptationRevision,
      status: row.status,
      sessionShapeHash: row.sessionShapeHash,
      updatedAt: row.updatedAt,
    });
    return commitmentComparison({
      candidate: input.candidate,
      domain: 'training',
      target: { type: 'training_session', id: String(row.id), version },
      fallbackResource: { type: 'training_session', id: String(row.id) },
      fallbackExclusivityKey: `training_session:${input.scope.tenantId}:${row.id}`,
      intent: 'preserve_active_training_session',
      effectType: 'preserve_training_commitment',
      authority: 'approved_commitment',
      approved: true,
      risk: 'medium',
      stateVersion: version,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }));
  return comparisons;
}

function loadContentCommitments(input: {
  scope: DomainCommitmentScope;
  candidate: NormalizedDecisionAction;
}): ConflictComparisonAction[] {
  if (!touchesDomain(input.candidate, 'content')) return [];
  // A workspace-wide Content resource does not prove two objects are
  // mutually exclusive. Only compare an explicitly targeted object.
  const objectIds = numericEntityIds(input.candidate, [
    'content_object',
    'content_domain_object',
    'content_workflow_object',
  ]);
  if (objectIds.length === 0) return [];
  const rows = getDb().prepare(`
    SELECT id, editorial_state AS editorialState, approval_state AS approvalState,
           workflow_version AS workflowVersion, created_at AS createdAt, updated_at AS updatedAt
      FROM content_domain_objects
     WHERE tenant_id = ? AND owner_user_id = ? AND scope_status = 'active'
       AND editorial_state IN ('approved', 'scheduled')
       AND approval_state = 'approved'
       AND id IN (${placeholders(objectIds)})
     ORDER BY updated_at DESC, id ASC
     LIMIT 24
  `).all(input.scope.tenantId, input.scope.userId, ...objectIds) as Array<{
    id: number;
    editorialState: string;
    approvalState: string;
    workflowVersion: number;
    createdAt: string;
    updatedAt: string;
  }>;

  return rows.map((row) => {
    const requestedType = input.candidate.targetEntities.find((entity) =>
      entity.id === String(row.id) && domainToken('content', entity.type))?.type
      ?? input.candidate.affectedResources.find((resource) =>
        resource.id === String(row.id) && domainToken('content', resource.type))?.type
      ?? 'content_object';
    return commitmentComparison({
      candidate: input.candidate,
      domain: 'content',
      target: { type: requestedType, id: String(row.id), version: String(row.workflowVersion) },
      fallbackResource: { type: requestedType, id: String(row.id) },
      fallbackExclusivityKey: `${requestedType}:${input.scope.tenantId}:${row.id}`,
      intent: 'preserve_approved_content_object',
      effectType: 'preserve_content_commitment',
      authority: 'approved_commitment',
      approved: true,
      risk: 'medium',
      stateVersion: stateVersion('content', {
        id: row.id,
        editorialState: row.editorialState,
        approvalState: row.approvalState,
        workflowVersion: row.workflowVersion,
        updatedAt: row.updatedAt,
      }),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  });
}

function loadCookingCommitments(input: {
  scope: DomainCommitmentScope;
  candidate: NormalizedDecisionAction;
}): ConflictComparisonAction[] {
  if (!touchesDomain(input.candidate, 'cooking')) return [];
  // Meal-plan dates and titles are private. The stable local row ID is the
  // conflict identity; the state hash detects slot content changes without
  // persisting those values.
  const mealPlanTargets = entityIds(input.candidate, ['meal_plan', 'cooking_meal_plan']);
  const mealPlanIds = mealPlanTargets.filter(isCanonicalInteger);
  const mealPlanSlots = mealPlanTargets.filter(isCanonicalMealSlot);
  if (mealPlanIds.length === 0 && mealPlanSlots.length === 0) return [];
  const identityClauses: string[] = [];
  const identityParams: string[] = [];
  if (mealPlanIds.length > 0) {
    identityClauses.push(`id IN (${placeholders(mealPlanIds)})`);
    identityParams.push(...mealPlanIds);
  }
  if (mealPlanSlots.length > 0) {
    identityClauses.push(`(date || ':' || meal_type) IN (${placeholders(mealPlanSlots)})`);
    identityParams.push(...mealPlanSlots);
  }
  const rows = getDb().prepare(`
    SELECT id, lifecycle_state AS lifecycleState, scope_status AS scopeStatus,
           date, meal_type AS mealType, recipe_id AS recipeId, title, notes,
           created_at AS createdAt
      FROM meal_plans
     WHERE tenant_id = ? AND owner_user_id = ? AND user_id = ?
       AND scope_status = 'active' AND lifecycle_state = 'planned'
       AND (${identityClauses.join(' OR ')})
     ORDER BY created_at DESC, id ASC
     LIMIT 24
  `).all(input.scope.tenantId, input.scope.userId, input.scope.userId, ...identityParams) as Array<{
    id: number;
    lifecycleState: string;
    scopeStatus: string;
    date: string;
    mealType: string;
    recipeId: number | null;
    title: string;
    notes: string | null;
    createdAt: string;
  }>;

  return rows.map((row) => {
    const slotIdentity = `${row.date}:${row.mealType}`;
    const targetIdentity = mealPlanSlots.includes(slotIdentity) ? slotIdentity : String(row.id);
    const version = stateVersion('cooking', {
      id: row.id,
      lifecycleState: row.lifecycleState,
      scopeStatus: row.scopeStatus,
      date: row.date,
      mealType: row.mealType,
      recipeId: row.recipeId,
      // Included only as hash input so an in-place slot replacement is
      // material without copying private text to the normalized contract.
      title: row.title,
      notes: row.notes,
    });
    return commitmentComparison({
      candidate: input.candidate,
      domain: 'cooking',
      target: { type: 'meal_plan', id: targetIdentity, version },
      fallbackResource: { type: 'meal_plan', id: targetIdentity },
      fallbackExclusivityKey: `meal_plan:${input.scope.tenantId}:${targetIdentity}`,
      intent: 'preserve_planned_meal',
      effectType: 'preserve_cooking_commitment',
      authority: 'approved_commitment',
      approved: true,
      risk: 'medium',
      stateVersion: version,
      createdAt: row.createdAt,
      updatedAt: row.createdAt,
    });
  });
}

function loadFinanceCommitments(input: {
  scope: DomainCommitmentScope;
  candidate: NormalizedDecisionAction;
}): ConflictComparisonAction[] {
  if (!touchesDomain(input.candidate, 'finance')) return [];
  // Transactions are historical facts, not commitments. Pending/overdue tax
  // rows are authoritative state, but are not represented as user approval.
  const taxEventTargets = entityIds(input.candidate, ['finance_tax_event', 'tax_event']);
  const taxEventIds = taxEventTargets.filter(isCanonicalInteger);
  const taxEventMonths = taxEventTargets.filter(isCanonicalMonth);
  if (taxEventIds.length === 0 && taxEventMonths.length === 0) return [];
  const identityClauses: string[] = [];
  const identityParams: string[] = [];
  if (taxEventIds.length > 0) {
    identityClauses.push(`id IN (${placeholders(taxEventIds)})`);
    identityParams.push(...taxEventIds);
  }
  if (taxEventMonths.length > 0) {
    identityClauses.push(`month IN (${placeholders(taxEventMonths)})`);
    identityParams.push(...taxEventMonths);
  }
  const rows = getDb().prepare(`
    SELECT id, month, status, created_at AS createdAt, updated_at AS updatedAt
      FROM finance_tax_events
     WHERE tenant_id = ? AND user_id = ? AND status IN ('pending', 'overdue')
       AND (${identityClauses.join(' OR ')})
     ORDER BY updated_at DESC, id ASC
     LIMIT 24
  `).all(input.scope.tenantId, input.scope.userId, ...identityParams) as Array<{
    id: number;
    month: string;
    status: string;
    createdAt: string;
    updatedAt: string;
  }>;

  return rows.map((row) => {
    const targetIdentity = taxEventMonths.includes(row.month) ? row.month : String(row.id);
    const version = financeTaxEventStateRevision(input.scope, targetIdentity) ?? stateVersion('finance', {
      id: row.id,
      month: row.month,
      status: row.status,
      updatedAt: row.updatedAt,
    });
    return commitmentComparison({
      candidate: input.candidate,
      domain: 'finance',
      target: { type: 'finance_tax_event', id: targetIdentity, version },
      fallbackResource: { type: 'finance_tax_event', id: targetIdentity },
      fallbackExclusivityKey: `finance_tax_event:${input.scope.tenantId}:${targetIdentity}`,
      intent: 'preserve_active_tax_state',
      effectType: 'preserve_finance_tax_state',
      authority: 'data_integrity',
      approved: false,
      risk: 'high',
      stateVersion: version,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  });
}

function loadTaskCommitments(input: {
  scope: DomainCommitmentScope;
  candidate: NormalizedDecisionAction;
}): ConflictComparisonAction[] {
  if (!touchesDomain(input.candidate, 'tasks')) return [];
  // Creating a new task does not conflict with every open task. Only an
  // explicitly targeted canonical/local task identity is compared.
  const taskIds = entityIds(input.candidate, ['task', 'nexus_task', 'unified_task']);
  if (taskIds.length === 0) return [];
  const localIds = taskIds.filter(isCanonicalInteger);
  const canonicalIds = taskIds.filter((id) => !isCanonicalInteger(id));
  const identityClauses: string[] = [];
  const identityParams: string[] = [];
  if (localIds.length > 0) {
    identityClauses.push(`id IN (${placeholders(localIds)})`);
    identityParams.push(...localIds);
  }
  if (canonicalIds.length > 0) {
    identityClauses.push(`nexus_task_id IN (${placeholders(canonicalIds)})`);
    identityParams.push(...canonicalIds);
  }
  if (identityClauses.length === 0) return [];

  const rows = getDb().prepare(`
    SELECT id, nexus_task_id AS nexusTaskId, local_version AS localVersion,
           status, created_at AS createdAt, updated_at AS updatedAt
      FROM unified_tasks
     WHERE user_id = ? AND COALESCE(tenant_id, user_id) = ?
       AND is_deleted = 0 AND status IN ('pending', 'in_progress')
       AND (${identityClauses.join(' OR ')})
     ORDER BY updated_at DESC, id ASC
     LIMIT 24
  `).all(input.scope.userId, input.scope.tenantId, ...identityParams) as Array<{
    id: number;
    nexusTaskId: string | null;
    localVersion: number;
    status: string;
    createdAt: string;
    updatedAt: string;
  }>;

  const requestedIds = new Set(taskIds);
  return rows.map((row) => {
    const identity = row.nexusTaskId && requestedIds.has(row.nexusTaskId)
      ? row.nexusTaskId
      : String(row.id);
    return commitmentComparison({
      candidate: input.candidate,
      domain: 'tasks',
      target: { type: 'task', id: identity, version: String(row.localVersion) },
      fallbackResource: { type: 'task', id: identity },
      fallbackExclusivityKey: `task:${input.scope.tenantId}:${identity}`,
      intent: 'preserve_open_task_commitment',
      effectType: 'preserve_task_commitment',
      authority: 'approved_commitment',
      approved: true,
      risk: 'medium',
      stateVersion: stateVersion('tasks', {
        id: row.id,
        nexusTaskId: row.nexusTaskId,
        localVersion: row.localVersion,
        status: row.status,
        updatedAt: row.updatedAt,
      }),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  });
}

function commitmentComparison(input: {
  candidate: NormalizedDecisionAction;
  domain: string;
  target: DecisionActionEntityRef;
  fallbackResource: DecisionActionResourceRef;
  fallbackExclusivityKey: string;
  intent: string;
  effectType: string;
  authority: ConflictComparisonAction['authority'];
  approved: boolean;
  risk: 'low' | 'medium' | 'high' | 'critical';
  stateVersion: string;
  createdAt: string;
  updatedAt: string;
}): ConflictComparisonAction {
  const action = buildNormalizedDecisionAction({
    intent: input.intent,
    targetEntities: [input.target],
    affectedResources: mergeResources(
      input.candidate.affectedResources.filter((resource) => domainToken(input.domain, resource.type)),
      input.fallbackResource,
    ),
    preconditions: [],
    expectedEffects: [{ type: input.effectType, targetRef: `${input.target.type}:${input.target.id}` }],
    prohibitedEffects: [],
    dependencies: [],
    exclusivityKeys: mergeTokens(
      input.candidate.exclusivityKeys.filter((key) => domainToken(input.domain, key.split(':')[0])),
      input.fallbackExclusivityKey,
    ),
    authorizationScope: [`${input.domain}:read`],
    risk: input.risk,
    // None of these domains currently exposes a generic compensating command
    // for replacing its persisted commitment.
    reversibility: 'irreversible',
    contextVersion: `${input.domain}:${input.stateVersion}`,
  });
  return {
    action,
    decisionId: opaqueDecisionId(input.domain, input.target.type, input.target.id),
    authority: input.authority,
    approved: input.approved,
    createdAt: canonicalTimestamp(input.createdAt),
    updatedAt: canonicalTimestamp(input.updatedAt),
  };
}

function touchesDomain(action: NormalizedDecisionAction, domain: string): boolean {
  const prefix = `${domain}.`;
  if (action.intent.toLowerCase().startsWith(prefix)) return true;
  const tokens = [
    ...action.targetEntities.map((entity) => entity.type),
    ...action.affectedResources.map((resource) => resource.type),
    ...action.exclusivityKeys.map((key) => key.split(':')[0]),
  ].map((value) => value.toLowerCase());
  return tokens.some((value) => domainToken(domain, value));
}

function domainToken(domain: string, value: string): boolean {
  const token = value.toLowerCase();
  if (domain === 'tasks') return token === 'task' || token === 'tasks' || token === 'task_store' || token === 'nexus_task' || token === 'unified_task';
  if (domain === 'training') return token === 'training' || token === 'training_state' || token === 'training_plan' || token === 'fitness_training_plan' || token === 'training_session';
  if (domain === 'content') return token === 'content' || token === 'content_object' || token === 'content_domain_object' || token === 'content_workflow_object' || token === 'content_pipeline';
  if (domain === 'cooking') return token === 'cooking' || token === 'meal_plan' || token === 'cooking_meal_plan' || token === 'shopping_list';
  if (domain === 'finance') return token === 'finance' || token === 'finance_tax_event' || token === 'tax_event' || token === 'finance_state';
  return false;
}

function numericEntityIds(action: NormalizedDecisionAction, types: string[]): string[] {
  return entityIds(action, types).filter(isCanonicalInteger);
}

function entityIds(action: NormalizedDecisionAction, types: string[]): string[] {
  const accepted = new Set(types);
  const ids = [
    ...action.targetEntities.filter((entity) => accepted.has(entity.type)).map((entity) => entity.id),
    ...action.affectedResources.filter((resource) => accepted.has(resource.type)).map((resource) => resource.id),
  ];
  return [...new Set(ids)].slice(0, MAX_MATCHED_ENTITIES);
}

function isCanonicalInteger(value: string): boolean {
  return /^(0|[1-9][0-9]{0,18})$/.test(value);
}

function isCanonicalMealSlot(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}:[a-z][a-z0-9_-]{0,39}$/i.test(value);
}

function isCanonicalMonth(value: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

function placeholders(values: readonly unknown[]): string {
  return values.map(() => '?').join(', ');
}

function mergeResources(
  candidateResources: DecisionActionResourceRef[],
  fallback: DecisionActionResourceRef,
): DecisionActionResourceRef[] {
  const unique = new Map<string, DecisionActionResourceRef>();
  for (const resource of [...candidateResources, fallback]) {
    unique.set(`${resource.type}:${resource.id}`, resource);
  }
  return [...unique.values()].slice(0, MAX_MATCHED_ENTITIES);
}

function mergeTokens(candidate: string[], fallback: string): string[] {
  return [...new Set([...candidate, fallback])].slice(0, MAX_MATCHED_ENTITIES);
}

function stateVersion(domain: string, value: Record<string, unknown>): string {
  return `${domain}_${createHash('sha256').update(stableJson(value)).digest('hex').slice(0, 32)}`;
}

function opaqueDecisionId(domain: string, type: string, id: string): string {
  const digest = createHash('sha256').update(`${domain}:${type}:${id}`).digest('hex').slice(0, 32);
  return `${domain}:${type}:${digest}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function canonicalTimestamp(value: string): string {
  // SQLite's datetime('now') is UTC but omits a zone marker. Normalize that
  // exact storage form explicitly so host-local timezone never changes
  // conflict precedence.
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) throw new Error('AUTHORITATIVE_COMMITMENT_TIMESTAMP_INVALID');
  return new Date(parsed).toISOString();
}
