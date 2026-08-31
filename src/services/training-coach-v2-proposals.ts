// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { buildNormalizedDecisionAction } from './decision-action-contract';
import { createDecisionIntent } from './decision-center';
import { getDb } from './database';
import { stableTrainingRevisionHash } from './training-plan-revision-candidate-builder';
import { withTrainingCalendarOperationLock } from './training-operation-locks';
import type { TrainingOperationLockLease } from './training-operation-locks';
import { requireTenantIdParam } from './tenant-scope';
import {
  bindCoachV2ImmutableRevisionDecision,
  getStagedCoachV2Revision,
  stageCoachV2ImmutableRevisionProposal,
} from './training-coach-v2-revision-proposals';
import {
  recordTrainingCoachV2AcceptedPlanWeek,
  recordTrainingCoachV2RuleFirings,
} from './training-coach-v2-soak-metrics';

export const TRAINING_COACH_V2_CONTRACT_VERSION = 'training-coach-v2.2' as const;
export type TrainingCoachV2ProposalKind = 'week_reflow' | 'coach_policy';
export type TrainingCoachV2ProposalState =
  | 'proposal_created'
  | 'approved'
  | 'activated'
  | 'rejected'
  | 'expired'
  | 'superseded'
  | 'activation_failed';

export interface TrainingCoachV2ProposalRow {
  proposal_id: string;
  tenant_id: number;
  user_id: number;
  kind: TrainingCoachV2ProposalKind;
  plan_id: number;
  week_id: number | null;
  expected_version: number;
  request_json: string;
  evidence_json: string;
  request_hash: string;
  client_request_hash: string;
  idempotency_key: string;
  preview_id: string | null;
  proposed_revision_id: string | null;
  decision_id: string | null;
  activation_result_json: string | null;
  state: TrainingCoachV2ProposalState;
  created_at: string;
  expires_at: string;
  activated_at: string | null;
}

export interface TrainingCoachV2ProposalResource {
  contractVersion: typeof TRAINING_COACH_V2_CONTRACT_VERSION;
  proposalId: string;
  decisionId: string | null;
  kind: TrainingCoachV2ProposalKind;
  state: TrainingCoachV2ProposalState;
  planId: number;
  weekId: number | null;
  expectedVersion: number;
  createdAt: string;
  expiresAt: string;
  previewId: string | null;
  proposedRevisionId: string | null;
}

export interface TrainingCoachV2ProposalActivationInput {
  proposal: TrainingCoachV2ProposalRow;
  request: Record<string, unknown>;
  evidence: Record<string, unknown>;
  lease: TrainingOperationLockLease;
}

export interface TrainingCoachV2ProposalActivationResult<T> {
  proposal: TrainingCoachV2ProposalResource;
  result: T;
  replayed: boolean;
}

export class TrainingCoachV2ProposalConflictError extends Error {
  readonly code = 'IDEMPOTENCY_CONFLICT';
}

export class TrainingCoachV2ProposalStateError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export function createTrainingCoachV2Proposal(input: {
  tenantId: number;
  userId: number;
  kind: TrainingCoachV2ProposalKind;
  planId: number;
  weekId?: number | null;
  expectedVersion: number;
  request: Record<string, unknown>;
  evidence: Record<string, unknown>;
  replayRequest?: Record<string, unknown>;
  previewId?: string | null;
  idempotencyKey: string;
  ttlMinutes?: number;
  db?: Database.Database;
}): { proposal: TrainingCoachV2ProposalResource; replayed: boolean } {
  const db = input.db ?? getDb();
  const tenantId = requireTenantIdParam(input.tenantId, 'createTrainingCoachV2Proposal');
  const idempotencyKey = input.idempotencyKey.trim();
  if (!idempotencyKey || idempotencyKey.length > 160) {
    throw new TrainingCoachV2ProposalStateError(
      'IDEMPOTENCY_REQUIRED',
      'A non-empty Idempotency-Key of at most 160 characters is required.',
    );
  }
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
    throw new TrainingCoachV2ProposalStateError('BAD_EXPECTED_VERSION', 'expectedVersion must be a non-negative integer.');
  }
  const ownedPlan = db.prepare(`
    SELECT id, COALESCE(plan_version, 1) AS planVersion,
           COALESCE(adaptation_revision, 0) AS adaptationRevision,
           COALESCE(coach_plan_policy_version, 1) AS policyVersion
      FROM fitness_training_plans
    WHERE id = ? AND tenant_id = ? AND user_id = ?
  `).get(input.planId, tenantId, input.userId) as {
    id: number;
    planVersion: number;
    adaptationRevision: number;
    policyVersion: number;
  } | undefined;
  if (!ownedPlan) {
    throw new TrainingCoachV2ProposalStateError('PLAN_NOT_FOUND', 'Training plan not found.');
  }
  const liveExpectedVersion = input.kind === 'coach_policy'
    ? ownedPlan.policyVersion
    : ownedPlan.adaptationRevision;
  if (liveExpectedVersion !== input.expectedVersion) {
    throw new TrainingCoachV2ProposalStateError(
      'VERSION_CONFLICT',
      'Training plan changed before the proposal could be recorded.',
    );
  }
  if (input.weekId != null) {
    const ownedWeek = db.prepare(`
      SELECT id FROM training_weeks WHERE id = ? AND plan_id = ?
    `).get(input.weekId, input.planId) as { id: number } | undefined;
    if (!ownedWeek) {
      throw new TrainingCoachV2ProposalStateError('WEEK_NOT_FOUND', 'Training week not found.');
    }
  }
  if (input.previewId != null) {
    if (input.kind !== 'week_reflow' || input.weekId == null) {
      throw new TrainingCoachV2ProposalStateError(
        'PREVIEW_KIND_MISMATCH',
        'A reflow preview can only bind a week_reflow proposal.',
      );
    }
    const preview = db.prepare(`
      SELECT expected_version, request_json, evidence_json, expires_at
        FROM training_coach_v2_reflow_previews
       WHERE preview_id = ? AND tenant_id = ? AND user_id = ?
         AND plan_id = ? AND week_id = ?
    `).get(
      input.previewId,
      tenantId,
      input.userId,
      input.planId,
      input.weekId,
    ) as {
      expected_version: number;
      request_json: string;
      evidence_json: string;
      expires_at: string;
    } | undefined;
    if (!preview || Date.parse(preview.expires_at) <= Date.now()) {
      throw new TrainingCoachV2ProposalStateError(
        'REFLOW_PREVIEW_UNAVAILABLE',
        'The reviewed reflow preview is missing or expired.',
      );
    }
    if (preview.expected_version !== input.expectedVersion
        || stableTrainingRevisionHash(parseStoredObject(preview.request_json, 'REFLOW_PREVIEW_INVALID'))
          !== stableTrainingRevisionHash(input.request)
        || stableTrainingRevisionHash(parseStoredObject(preview.evidence_json, 'REFLOW_PREVIEW_INVALID'))
          !== stableTrainingRevisionHash(input.evidence)) {
      throw new TrainingCoachV2ProposalStateError(
        'REFLOW_PREVIEW_MISMATCH',
        'The proposal does not match the reviewed reflow preview.',
      );
    }
    const alreadyBound = db.prepare(`
      SELECT proposal_id FROM training_coach_v2_proposals
       WHERE tenant_id = ? AND user_id = ? AND preview_id = ?
       LIMIT 1
    `).get(tenantId, input.userId, input.previewId) as { proposal_id: string } | undefined;
    if (alreadyBound) {
      throw new TrainingCoachV2ProposalConflictError(
        'The reviewed reflow preview already belongs to another proposal request.',
      );
    }
  }
  const planStateVersion = `plan:${ownedPlan.planVersion}:adaptation:${ownedPlan.adaptationRevision}`;
  const proposalEvidence = {
    ...input.evidence,
    coachV2PlanStateVersion: planStateVersion,
  };
  const requestHash = stableTrainingRevisionHash({
    contractVersion: TRAINING_COACH_V2_CONTRACT_VERSION,
    tenantId,
    userId: input.userId,
    kind: input.kind,
    planId: input.planId,
    weekId: input.weekId ?? null,
    expectedVersion: input.expectedVersion,
    previewId: input.previewId ?? null,
    request: input.request,
    evidence: proposalEvidence,
  });
  const clientRequestHash = trainingCoachV2ClientRequestHash({
    tenantId,
    userId: input.userId,
    kind: input.kind,
    planId: input.planId,
    weekId: input.weekId ?? null,
    request: input.replayRequest ?? input.request,
  });
  const replay = db.prepare(`
    SELECT * FROM training_coach_v2_proposals
    WHERE tenant_id = ? AND user_id = ? AND idempotency_key = ?
  `).get(tenantId, input.userId, idempotencyKey) as TrainingCoachV2ProposalRow | undefined;
  if (replay) {
    if (replay.client_request_hash !== clientRequestHash || replay.request_hash !== requestHash) {
      throw new TrainingCoachV2ProposalConflictError('Idempotency-Key belongs to a different Coach V2 proposal request.');
    }
    return { proposal: toResource(replay), replayed: true };
  }

  const proposalId = `tcv2_${randomUUID().replaceAll('-', '')}`;
  const ttlMinutes = Math.min(24 * 60, Math.max(5, Math.floor(input.ttlMinutes ?? 30)));
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.parse(createdAt) + ttlMinutes * 60_000).toISOString();
  db.transaction(() => {
    const staged = stageCoachV2ImmutableRevisionProposal({
      db,
      tenantId,
      userId: input.userId,
      proposalId,
      planId: input.planId,
      weekId: input.weekId ?? null,
      kind: input.kind,
      request: input.request,
      evidence: proposalEvidence,
      requestHash,
      expiresAt,
    });
    db.prepare(`
      INSERT INTO training_coach_v2_proposals (
        proposal_id, tenant_id, user_id, kind, plan_id, week_id,
        expected_version, request_json, evidence_json, request_hash, client_request_hash,
        idempotency_key, preview_id, proposed_revision_id, state, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposal_created', ?, ?)
    `).run(
      proposalId,
      tenantId,
      input.userId,
      input.kind,
      input.planId,
      input.weekId ?? null,
      input.expectedVersion,
      JSON.stringify(input.request),
      JSON.stringify(proposalEvidence),
      requestHash,
      clientRequestHash,
      idempotencyKey,
      input.previewId ?? null,
      staged?.revisionId ?? null,
      createdAt,
      expiresAt,
    );
    recordTrainingCoachV2RuleFirings({
      tenantId,
      userId: input.userId,
      proposalId,
      evidence: proposalEvidence,
      firedAt: createdAt,
      db,
    });
  })();
  return {
    proposal: toResource(requireProposalRow(db, tenantId, input.userId, proposalId)),
    replayed: false,
  };
}

export function getTrainingCoachV2Proposal(input: {
  tenantId: number;
  userId: number;
  proposalId: string;
  db?: Database.Database;
}): TrainingCoachV2ProposalResource | null {
  const db = input.db ?? getDb();
  const tenantId = requireTenantIdParam(input.tenantId, 'getTrainingCoachV2Proposal');
  const row = db.prepare(`
    SELECT * FROM training_coach_v2_proposals
    WHERE tenant_id = ? AND user_id = ? AND proposal_id = ?
  `).get(tenantId, input.userId, input.proposalId) as TrainingCoachV2ProposalRow | undefined;
  return row ? toResource(row) : null;
}

/** Replay preflight used before volatile classifier or CAS checks. */
export function findTrainingCoachV2ProposalByIdempotency(input: {
  tenantId: number;
  userId: number;
  kind: TrainingCoachV2ProposalKind;
  planId: number;
  weekId?: number | null;
  idempotencyKey: string;
  request: Record<string, unknown>;
  db?: Database.Database;
}): TrainingCoachV2ProposalResource | null {
  const db = input.db ?? getDb();
  const tenantId = requireTenantIdParam(input.tenantId, 'findTrainingCoachV2ProposalByIdempotency');
  const key = input.idempotencyKey.trim();
  if (!key) return null;
  const row = db.prepare(`
    SELECT * FROM training_coach_v2_proposals
     WHERE tenant_id = ? AND user_id = ? AND idempotency_key = ?
     LIMIT 1
  `).get(tenantId, input.userId, key) as TrainingCoachV2ProposalRow | undefined;
  if (!row) return null;
  const expectedHash = trainingCoachV2ClientRequestHash({
    tenantId,
    userId: input.userId,
    kind: input.kind,
    planId: input.planId,
    weekId: input.weekId ?? null,
    request: input.request,
  });
  if (row.kind !== input.kind || row.plan_id !== input.planId
      || row.week_id !== (input.weekId ?? null)
      || row.client_request_hash !== expectedHash) {
    throw new TrainingCoachV2ProposalConflictError(
      'Idempotency-Key belongs to a different Coach V2 proposal request.',
    );
  }
  return toResource(row);
}

/**
 * Create and bind the only user-visible approval authority for a Coach V2
 * proposal. The Decision Center payload contains hashes/reason codes only;
 * private health evidence and the proposed patch remain in the scoped store.
 */
export async function bindTrainingCoachV2ProposalDecision(input: {
  tenantId: number;
  userId: number;
  proposalId: string;
  db?: Database.Database;
}): Promise<TrainingCoachV2ProposalResource> {
  const db = input.db ?? getDb();
  const tenantId = requireTenantIdParam(input.tenantId, 'bindTrainingCoachV2ProposalDecision');
  const row = requireProposalRow(db, tenantId, input.userId, input.proposalId);
  if (row.decision_id) return toResource(row);
  if (row.state !== 'proposal_created' || Date.parse(row.expires_at) <= Date.now()) {
    throw new TrainingCoachV2ProposalStateError(
      'PROPOSAL_NOT_APPROVABLE',
      'The Coach V2 proposal is missing, expired, or no longer awaiting approval.',
    );
  }

  const stagedRevision = row.proposed_revision_id
    ? getStagedCoachV2Revision({
        db,
        tenantId,
        userId: input.userId,
        revisionId: row.proposed_revision_id,
      })
    : null;
  if (row.proposed_revision_id && !stagedRevision) {
    throw new TrainingCoachV2ProposalStateError(
      'PROPOSAL_REVISION_MISSING',
      'The immutable revision for this Coach V2 proposal is unavailable.',
    );
  }
  const normalizedAction = buildNormalizedDecisionAction({
    intent: 'training.activate_coach_v2_proposal',
    targetEntities: [
      {
        type: 'training_coach_v2_proposal',
        id: row.proposal_id,
        version: row.request_hash,
      },
      ...(stagedRevision ? [{
        type: 'training_plan_revision',
        id: stagedRevision.revisionId,
        version: stagedRevision.contentHash,
      }] : []),
    ],
    affectedResources: [{ type: 'training_plan', id: String(row.plan_id) }],
    preconditions: buildCoachV2DecisionPreconditions(db, row),
    expectedEffects: [{
      type: 'activate_training_coach_v2_proposal',
      targetRef: `training_coach_v2_proposal:${row.proposal_id}`,
    }],
    prohibitedEffects: [{
      type: 'provider_calendar_write',
      targetRef: `training_plan:${row.plan_id}`,
    }],
    dependencies: [],
    exclusivityKeys: [`training_plan:${tenantId}:${row.plan_id}`],
    authorizationScope: ['decision_center:write', 'training:plan:write'],
    risk: row.kind === 'coach_policy' ? 'medium' : 'high',
    reversibility: 'compensatable',
    contextVersion: stagedRevision?.contextVersion
      ?? `${TRAINING_COACH_V2_CONTRACT_VERSION}:${row.kind}:${row.expected_version}:${row.request_hash.slice(0, 16)}`,
  });
  const observedAt = new Date().toISOString();
  const created = await createDecisionIntent({
    userId: input.userId,
    tenantId,
    sourceSkill: 'training',
    type: 'approval_required',
    priority: 'active',
    relatedEntityId: row.proposal_id,
    relatedEntityType: 'training_coach_v2_proposal',
    title: row.kind === 'coach_policy'
      ? 'Review coaching preference change'
      : 'Review training week change',
    body: 'Nothing changes until you explicitly approve this proposal.',
    actionButtons: [
      { id: 'activate_training_coach_v2_proposal', label: 'Approve and apply', style: 'primary', mutating: true },
      { id: 'open_detail', label: 'Review details', style: 'secondary' },
    ],
    deeplink: `nexus://training/coach-v2/proposals/${row.proposal_id}`,
    expiresAt: row.expires_at,
    dedupeKey: `training-coach-v2:${row.proposal_id}`,
    requiresUserAction: true,
    decisionDeadline: row.expires_at,
    deliveryPolicy: 'in_app_only',
    privacyPolicy: 'health',
    visibilityScope: 'user_private',
    decisionContext: {
      entityTitle: row.kind === 'coach_policy' ? 'Coaching preference proposal' : 'Training week proposal',
      reasonCodes: [row.kind, 'proposal_first', 'explicit_approval_required'],
      sourceState: 'proposal_created',
      contextObservedAt: observedAt,
      contextExpiresAt: row.expires_at,
      evidenceConfidence: 1,
      candidateConfidence: 'high',
      evidenceReferences: [{
        evidenceId: `training-coach-v2:${row.request_hash}`,
        source: 'training_coach_v2_proposal_store',
        observedAt,
        freshness: 'current',
        reliability: 'authoritative',
        entityVersion: row.request_hash,
        expiresAt: row.expires_at,
      }],
      sourceHealthSnapshot: [{
        source: 'training_coach_v2_proposal_store',
        status: 'available',
        observedAt,
        staleAfter: row.expires_at,
      }],
      normalizedAction,
    },
  });
  const decisionId = created.item?.itemId ?? null;
  if (!decisionId) {
    db.prepare(`
      UPDATE training_coach_v2_proposals
      SET state = 'superseded'
      WHERE tenant_id = ? AND user_id = ? AND proposal_id = ?
        AND state = 'proposal_created' AND decision_id IS NULL
    `).run(tenantId, input.userId, row.proposal_id);
    throw new TrainingCoachV2ProposalStateError(
      'PROPOSAL_DECISION_SUPPRESSED',
      'Decision Center suppressed this proposal as a duplicate or recently rejected change.',
    );
  }
  const bound = db.transaction(() => {
    const update = db.prepare(`
      UPDATE training_coach_v2_proposals
      SET decision_id = ?
      WHERE tenant_id = ? AND user_id = ? AND proposal_id = ?
        AND state = 'proposal_created' AND decision_id IS NULL
    `).run(decisionId, tenantId, input.userId, row.proposal_id);
    if (update.changes === 1 && row.proposed_revision_id) {
      bindCoachV2ImmutableRevisionDecision({
        db,
        tenantId,
        userId: input.userId,
        revisionId: row.proposed_revision_id,
        decisionId,
      });
    }
    return update;
  })();
  const readback = requireProposalRow(db, tenantId, input.userId, row.proposal_id);
  if (bound.changes !== 1 && readback.decision_id !== decisionId) {
    throw new TrainingCoachV2ProposalStateError(
      'PROPOSAL_DECISION_BINDING_CONFLICT',
      'The Coach V2 proposal review state changed concurrently.',
    );
  }
  return toResource(readback);
}

function buildCoachV2DecisionPreconditions(
  db: Database.Database,
  row: TrainingCoachV2ProposalRow,
): Array<{ type: string; ref: string; expectedVersion: string; required: true }> {
  const plan = db.prepare(`
    SELECT COALESCE(plan_version, 1) AS planVersion,
           COALESCE(adaptation_revision, 0) AS adaptationRevision
      FROM fitness_training_plans
     WHERE id = ? AND tenant_id = ? AND user_id = ?
  `).get(row.plan_id, row.tenant_id, row.user_id) as {
    planVersion: number;
    adaptationRevision: number;
  } | undefined;
  if (!plan) {
    throw new TrainingCoachV2ProposalStateError('PLAN_NOT_FOUND', 'Training plan not found.');
  }
  const evidence = parseStoredObject(row.evidence_json, 'PROPOSAL_EVIDENCE_INVALID');
  const planStateVersion = typeof evidence.coachV2PlanStateVersion === 'string'
    ? evidence.coachV2PlanStateVersion
    : null;
  const currentPlanStateVersion = `plan:${plan.planVersion}:adaptation:${plan.adaptationRevision}`;
  if (!planStateVersion || planStateVersion !== currentPlanStateVersion) {
    throw new TrainingCoachV2ProposalStateError(
      'DECISION_CONTEXT_CHANGED',
      'Training plan changed before its Coach V2 review could be bound.',
    );
  }
  return [
    {
      type: 'training_plan_state',
      ref: String(row.plan_id),
      expectedVersion: planStateVersion,
      required: true,
    },
    {
      type: row.kind === 'coach_policy'
        ? 'training_coach_policy_version'
        : 'training_adaptation_revision',
      ref: String(row.plan_id),
      expectedVersion: String(row.expected_version),
      required: true,
    },
  ];
}

/**
 * The single Decision Center activation seam. It verifies the exact bound
 * decision, acquires the tenant-scoped Training `adapt` lock, executes the
 * caller's deterministic CAS mutation and readback in one SQLite transaction,
 * and stores that readback for idempotent Decision Center retries.
 *
 * The callback must not call providers. Calendar/provider reconciliation is
 * emitted as desired state and remains Secretary-owned.
 */
export async function executeApprovedTrainingCoachV2Proposal<T>(input: {
  tenantId: number;
  userId: number;
  proposalId: string;
  decisionId: string;
  expectedRequestHash?: string;
  apply: (db: Database.Database, activation: TrainingCoachV2ProposalActivationInput) => T;
  db?: Database.Database;
}): Promise<TrainingCoachV2ProposalActivationResult<T>> {
  const db = input.db ?? getDb();
  const tenantId = requireTenantIdParam(input.tenantId, 'executeApprovedTrainingCoachV2Proposal');
  if (!input.decisionId.trim()) {
    throw new TrainingCoachV2ProposalStateError('DECISION_ID_REQUIRED', 'A bound Decision Center approval is required.');
  }
  const initial = requireProposalRow(db, tenantId, input.userId, input.proposalId);
  if (initial.decision_id !== input.decisionId) {
    throw new TrainingCoachV2ProposalStateError('PROPOSAL_DECISION_MISMATCH', 'This Decision Center item is not bound to the proposal.');
  }
  if (input.expectedRequestHash !== undefined && initial.request_hash !== input.expectedRequestHash) {
    throw new TrainingCoachV2ProposalStateError('DECISION_CONTEXT_CHANGED', 'The approved Coach V2 proposal version no longer matches.');
  }

  return withTrainingCalendarOperationLock({
    userId: input.userId,
    tenantId,
    planId: initial.plan_id,
    operation: 'adapt',
    db,
  }, async (lease) => {
    lease.assertActive();
    let outcome: TrainingCoachV2ProposalActivationResult<T> | null = null;
    let expired = false;
    const txn = db.transaction(() => {
      const row = requireProposalRow(db, tenantId, input.userId, input.proposalId);
      if (row.decision_id !== input.decisionId) {
        throw new TrainingCoachV2ProposalStateError('PROPOSAL_DECISION_MISMATCH', 'This Decision Center item is not bound to the proposal.');
      }
      if (input.expectedRequestHash !== undefined && row.request_hash !== input.expectedRequestHash) {
        throw new TrainingCoachV2ProposalStateError('DECISION_CONTEXT_CHANGED', 'The approved Coach V2 proposal version no longer matches.');
      }
      if (row.state === 'activated') {
        if (!row.activation_result_json) {
          throw new TrainingCoachV2ProposalStateError('PROPOSAL_READBACK_MISSING', 'Activated proposal readback is unavailable.');
        }
        outcome = {
          proposal: toResource(row),
          result: parseStoredObject(row.activation_result_json, 'PROPOSAL_READBACK_INVALID') as T,
          replayed: true,
        };
        return;
      }
      if (row.state !== 'proposal_created') {
        throw new TrainingCoachV2ProposalStateError('PROPOSAL_NOT_APPROVABLE', 'The proposal is no longer awaiting approval.');
      }
      if (Date.parse(row.expires_at) <= Date.now()) {
        db.prepare(`
          UPDATE training_coach_v2_proposals SET state = 'expired'
          WHERE tenant_id = ? AND user_id = ? AND proposal_id = ? AND state = 'proposal_created'
        `).run(tenantId, input.userId, row.proposal_id);
        expired = true;
        return;
      }
      lease.assertActive();
      const request = parseStoredObject(row.request_json, 'PROPOSAL_REQUEST_INVALID');
      const evidence = parseStoredObject(row.evidence_json, 'PROPOSAL_EVIDENCE_INVALID');
      db.prepare(`
        UPDATE training_coach_v2_proposals SET state = 'approved'
        WHERE tenant_id = ? AND user_id = ? AND proposal_id = ?
          AND decision_id = ? AND state = 'proposal_created'
      `).run(tenantId, input.userId, row.proposal_id, input.decisionId);
      const result = input.apply(db, { proposal: row, request, evidence, lease });
      const activationResultJson = JSON.stringify(result);
      if (activationResultJson === undefined) {
        throw new TrainingCoachV2ProposalStateError('PROPOSAL_READBACK_REQUIRED', 'Activation must return a JSON readback.');
      }
      const acceptedAt = new Date().toISOString();
      const changed = db.prepare(`
        UPDATE training_coach_v2_proposals
        SET state = 'activated', activated_at = ?, activation_result_json = ?
        WHERE tenant_id = ? AND user_id = ? AND proposal_id = ?
          AND decision_id = ? AND state = 'approved'
      `).run(
        acceptedAt, activationResultJson,
        tenantId, input.userId, row.proposal_id, input.decisionId,
      );
      if (changed.changes !== 1) {
        throw new TrainingCoachV2ProposalStateError('PROPOSAL_ACTIVATION_RACE', 'Coach V2 proposal state changed during activation.');
      }
      if (row.kind === 'week_reflow') {
        recordTrainingCoachV2AcceptedPlanWeek({
          tenantId,
          userId: input.userId,
          proposalId: row.proposal_id,
          planId: row.plan_id,
          weekId: row.week_id,
          evidence,
          acceptedAt,
          db,
        });
      }
      outcome = {
        proposal: toResource(requireProposalRow(db, tenantId, input.userId, row.proposal_id)),
        result,
        replayed: false,
      };
    });
    txn();
    lease.assertActive();
    if (expired) {
      throw new TrainingCoachV2ProposalStateError('PROPOSAL_EXPIRED', 'The Coach V2 proposal expired before activation.');
    }
    if (!outcome) {
      throw new TrainingCoachV2ProposalStateError('PROPOSAL_ACTIVATION_FAILED', 'Coach V2 proposal activation produced no readback.');
    }
    return outcome;
  });
}

function requireProposalRow(
  db: Database.Database,
  tenantId: number,
  userId: number,
  proposalId: string,
): TrainingCoachV2ProposalRow {
  const row = db.prepare(`
    SELECT * FROM training_coach_v2_proposals
    WHERE tenant_id = ? AND user_id = ? AND proposal_id = ?
  `).get(tenantId, userId, proposalId) as TrainingCoachV2ProposalRow | undefined;
  if (!row) {
    throw new TrainingCoachV2ProposalStateError('PROPOSAL_NOT_FOUND', 'Coach V2 proposal not found.');
  }
  return row;
}

function toResource(row: TrainingCoachV2ProposalRow): TrainingCoachV2ProposalResource {
  return {
    contractVersion: TRAINING_COACH_V2_CONTRACT_VERSION,
    proposalId: row.proposal_id,
    decisionId: row.decision_id,
    kind: row.kind,
    state: row.state,
    planId: row.plan_id,
    weekId: row.week_id,
    expectedVersion: row.expected_version,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    previewId: row.preview_id,
    proposedRevisionId: row.proposed_revision_id,
  };
}

function parseStoredObject(value: string, errorCode: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Corrupt proposal material fails closed at the activation boundary.
  }
  throw new TrainingCoachV2ProposalStateError(errorCode, 'Stored Coach V2 proposal material is invalid.');
}

function trainingCoachV2ClientRequestHash(input: {
  tenantId: number;
  userId: number;
  kind: TrainingCoachV2ProposalKind;
  planId: number;
  weekId: number | null;
  request: Record<string, unknown>;
}): string {
  return stableTrainingRevisionHash({
    contractVersion: TRAINING_COACH_V2_CONTRACT_VERSION,
    operation: 'client_request',
    ...input,
  });
}
