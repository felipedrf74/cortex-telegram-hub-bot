// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { getDb } from './database';
import { emitDomainEvent } from './event-outbox';

export const SECRETARY_ARBITRATION_COMMITTED_EVENT_TYPE = 'secretary.arbitration.committed.v1';
export const SECRETARY_ARBITRATION_COMMITTED_SCHEMA_VERSION = 'secretary-arbitration-committed-v1';

const ACTIVE_OPERATION_STATES = [
  'cleanup_pending',
  'cleanup_blocked',
  'winner_ready',
  'winner_reconcile',
] as const;
const LOCKED_OPERATION_STATES = [...ACTIVE_OPERATION_STATES, 'terminal_failure'] as const;

const ACTIVE_LOSER_LIFECYCLES = new Set([
  'scheduled',
  'synced',
  'reflowed',
  'compressed',
  'failed_sync',
]);

export interface SecretaryPreemptionRankSnapshot {
  score: number;
  deadlineAt: string | null;
  flexibility: 'fixed' | 'flexible' | 'compressible' | 'splittable';
  policyVersion: string;
  tieBreakerIntentId: string;
}

export interface SecretaryPreemptionWinnerDraft {
  ownerUserId: number;
  tenantId: string;
  sourceSkill: 'secretary' | 'training' | 'cooking' | 'finance' | 'content';
  sourceIntentId: string;
  sourceAction: string | null;
  intentAction: string;
  sourceEntityId: string | null;
  sourceEntityType: string | null;
  providerTarget: 'google' | 'outlook';
  title: string;
  startAt: string;
  endAt: string;
  durationMinutes: number;
  decisionAction: 'scheduled' | 'reflowed' | 'compressed';
  decisionReasonCodes: string[];
  decisionExplanation: string;
  sourceShapeHash: string;
  scheduledSegments: Array<{ start: string; end: string; label?: string; hard?: boolean }>;
  sourceCreatedAt: string | null;
  sourceUpdatedAt: string | null;
  reasoningTrail: unknown[];
  rank: SecretaryPreemptionRankSnapshot;
}

export interface SecretaryPreemptionLoserEvidence {
  agendaItemId: string;
  providerSource: 'google' | 'outlook';
  providerEventId: string;
}

export interface PersistSecretaryPreemptionGraphInput {
  winner: SecretaryPreemptionWinnerDraft;
  losers: SecretaryPreemptionLoserEvidence[];
  nowIso: string;
}

export interface PersistSecretaryPreemptionGraphResult {
  operationId: string;
  winnerAgendaItemId: string;
  winnerAgendaVersion: number;
  preemptedCount: number;
  replayed: boolean;
}

export interface SecretaryPreemptionWinnerReplay {
  operationId: string;
  agendaItemId: string;
  agendaVersion: number;
  state: string;
}

interface AgendaRow {
  agenda_item_id: string;
  source_intent_id: string;
  source_skill: SecretaryPreemptionWinnerDraft['sourceSkill'];
  source_action: string | null;
  intent_action: string;
  source_entity_id: string | null;
  source_entity_type: string | null;
  owner_user_id: number;
  tenant_id: string;
  lifecycle_state: string;
  provider_sync_state: string;
  provider_event_id: string | null;
  provider_source: string | null;
  provider_target: string | null;
  version: number;
  title: string;
  start_at: string | null;
  end_at: string | null;
  duration_minutes: number | null;
  decision_action: string;
  decision_reason_codes_json: string;
  decision_explanation: string | null;
  source_shape_hash: string;
  scheduled_segments_json: string;
  source_created_at: string | null;
  source_updated_at: string | null;
  reasoning_trail_json: string | null;
  arbitration_score: number | null;
  arbitration_deadline_at: string | null;
  arbitration_flexibility: string | null;
  arbitration_policy_version: string | null;
}

interface ExistingOperationRow {
  operation_id: string;
  winner_agenda_item_id: string;
  winner_agenda_version: number;
  winner_source_shape_hash: string;
  request_hash: string;
  state: string;
}

export class SecretaryPreemptionConflictError extends Error {
  readonly code = 'SECRETARY_PREEMPTION_IDEMPOTENCY_CONFLICT';

  constructor() {
    super('SECRETARY_PREEMPTION_IDEMPOTENCY_CONFLICT');
    this.name = 'SecretaryPreemptionConflictError';
  }
}

export class SecretaryPreemptionStaleError extends Error {
  readonly code = 'SECRETARY_PREEMPTION_STALE';

  constructor(reason: string) {
    super(`SECRETARY_PREEMPTION_STALE:${reason}`);
    this.name = 'SecretaryPreemptionStaleError';
  }
}

export function secretaryAgendaPreemptionSchemaReady(
  db: Database.Database = getDb(),
): boolean {
  const rows = db.prepare(`
    SELECT name FROM sqlite_master
     WHERE type = 'table'
       AND name IN (
         'secretary_agenda_preemption_operations',
         'secretary_agenda_preemption_dependencies'
       )
  `).all() as Array<{ name: string }>;
  return rows.length === 2;
}

/**
 * Returns the durable winner on replay and blocks a changed request while its
 * two-phase graph is unresolved. Loser intents are mutation-locked separately
 * so a source update cannot invalidate the exact provider cleanup edge.
 */
export function findSecretaryPreemptionWinnerReplay(input: {
  ownerUserId: number;
  tenantId: string;
  sourceSkill: SecretaryPreemptionWinnerDraft['sourceSkill'];
  sourceIntentId: string;
  sourceShapeHash: string;
}, db: Database.Database = getDb()): SecretaryPreemptionWinnerReplay | null {
  if (!secretaryAgendaPreemptionSchemaReady(db)) return null;
  const terminal = db.prepare(`
    SELECT 1
      FROM secretary_agenda_preemption_operations
     WHERE owner_user_id = ? AND tenant_id = ?
       AND winner_source_skill = ? AND winner_source_intent_id = ?
       AND state = 'terminal_failure'
     LIMIT 1
  `).get(input.ownerUserId, input.tenantId, input.sourceSkill, input.sourceIntentId);
  if (terminal) throw new SecretaryPreemptionConflictError();
  const operation = db.prepare(`
    SELECT operation_id, winner_agenda_item_id, winner_agenda_version,
           winner_source_shape_hash, state
      FROM secretary_agenda_preemption_operations
     WHERE owner_user_id = ?
       AND tenant_id = ?
       AND winner_source_skill = ?
       AND winner_source_intent_id = ?
       AND state IN (${ACTIVE_OPERATION_STATES.map(() => '?').join(', ')})
     ORDER BY datetime(created_at) DESC, operation_id DESC
     LIMIT 1
  `).get(
    input.ownerUserId,
    input.tenantId,
    input.sourceSkill,
    input.sourceIntentId,
    ...ACTIVE_OPERATION_STATES,
  ) as Omit<ExistingOperationRow, 'request_hash'> | undefined;
  if (operation) {
    if (operation.winner_source_shape_hash !== input.sourceShapeHash) {
      throw new SecretaryPreemptionConflictError();
    }
    return {
      operationId: operation.operation_id,
      agendaItemId: operation.winner_agenda_item_id,
      agendaVersion: Number(operation.winner_agenda_version),
      state: operation.state,
    };
  }

  const loserLock = db.prepare(`
    SELECT 1
      FROM secretary_agenda_preemption_dependencies AS dependency
      JOIN secretary_agenda_preemption_operations AS operation
        ON operation.operation_id = dependency.operation_id
       AND operation.owner_user_id = dependency.owner_user_id
       AND operation.tenant_id = dependency.tenant_id
     WHERE dependency.owner_user_id = ?
       AND dependency.tenant_id = ?
       AND dependency.loser_source_skill = ?
       AND dependency.loser_source_intent_id = ?
       AND operation.state IN (${LOCKED_OPERATION_STATES.map(() => '?').join(', ')})
     LIMIT 1
  `).get(
    input.ownerUserId,
    input.tenantId,
    input.sourceSkill,
    input.sourceIntentId,
    ...LOCKED_OPERATION_STATES,
  );
  if (loserLock) throw new SecretaryPreemptionConflictError();
  return null;
}

export function persistSecretaryPreemptionGraph(
  input: PersistSecretaryPreemptionGraphInput,
  db: Database.Database = getDb(),
): PersistSecretaryPreemptionGraphResult {
  if (!secretaryAgendaPreemptionSchemaReady(db)) {
    throw new SecretaryPreemptionStaleError('schema_missing');
  }
  const persist = db.transaction(() => persistSecretaryPreemptionGraphInTransaction(input, db));
  return persist.immediate();
}

function persistSecretaryPreemptionGraphInTransaction(
  input: PersistSecretaryPreemptionGraphInput,
  db: Database.Database,
): PersistSecretaryPreemptionGraphResult {
  const winner = input.winner;
  const tenantId = normalizeTenantId(winner.tenantId);
  if (!Number.isSafeInteger(winner.ownerUserId) || winner.ownerUserId <= 0 || !tenantId) {
    throw new SecretaryPreemptionStaleError('invalid_scope');
  }
  if (!isValidSlot(winner.startAt, winner.endAt) || !Number.isSafeInteger(winner.durationMinutes)) {
    throw new SecretaryPreemptionStaleError('invalid_winner_slot');
  }
  if (!isCompleteRank(winner.rank)) throw new SecretaryPreemptionStaleError('invalid_winner_rank');
  if (input.losers.length === 0) throw new SecretaryPreemptionStaleError('missing_loser');

  const existingOperation = findExistingOperationForWinner(winner, db);
  if (existingOperation) {
    if (existingOperation.state === 'terminal_failure'
        || existingOperation.winner_source_shape_hash !== winner.sourceShapeHash) {
      throw new SecretaryPreemptionConflictError();
    }
    return {
      operationId: existingOperation.operation_id,
      winnerAgendaItemId: existingOperation.winner_agenda_item_id,
      winnerAgendaVersion: Number(existingOperation.winner_agenda_version),
      preemptedCount: countOperationDependencies(existingOperation.operation_id, db),
      replayed: true,
    };
  }

  const latestWinner = readLatestAgendaRow(
    winner.ownerUserId,
    tenantId,
    winner.sourceSkill,
    winner.sourceIntentId,
    db,
  );
  if (latestWinner?.provider_target && latestWinner.provider_target !== winner.providerTarget) {
    throw new SecretaryPreemptionStaleError('winner_provider_target_changed');
  }
  const priorActiveWinner = latestWinner && ACTIVE_LOSER_LIFECYCLES.has(latestWinner.lifecycle_state)
    ? latestWinner
    : null;
  const winnerAgendaVersion = latestWinner ? Number(latestWinner.version) + 1 : 1;
  const winnerAgendaItemId = buildAgendaItemId({
    ownerUserId: winner.ownerUserId,
    tenantId,
    sourceSkill: winner.sourceSkill,
    sourceIntentId: winner.sourceIntentId,
    version: winnerAgendaVersion,
  });

  const observed = new Map<string, SecretaryPreemptionLoserEvidence>();
  for (const candidate of input.losers) {
    const key = `${candidate.providerSource}:${candidate.providerEventId.trim()}`;
    if (observed.has(key)) throw new SecretaryPreemptionStaleError('duplicate_provider_evidence');
    observed.set(key, candidate);
  }
  const losers = [...input.losers]
    .sort((left, right) => left.agendaItemId.localeCompare(right.agendaItemId))
    .map((candidate) => revalidateLoser(candidate, winner, tenantId, db));
  if (losers.some((loser) => !windowsOverlap(
    winner.startAt,
    winner.endAt,
    loser.start_at!,
    loser.end_at!,
  ))) {
    throw new SecretaryPreemptionStaleError('loser_no_longer_overlaps');
  }

  const requestHash = sha256(stableStringify({
    policyVersion: winner.rank.policyVersion,
    ownerUserId: winner.ownerUserId,
    tenantId,
    winner: {
      sourceSkill: winner.sourceSkill,
      sourceIntentId: winner.sourceIntentId,
      sourceShapeHash: winner.sourceShapeHash,
      providerTarget: winner.providerTarget,
      agendaVersion: winnerAgendaVersion,
      startAt: winner.startAt,
      endAt: winner.endAt,
    },
    priorWinnerProviderIdentity: priorActiveWinner?.provider_event_id
      && priorActiveWinner.provider_source
      ? {
          providerSource: priorActiveWinner.provider_source,
          providerEventId: priorActiveWinner.provider_event_id,
        }
      : null,
    losers: losers.map((loser) => ({
      agendaItemId: loser.agenda_item_id,
      version: loser.version,
      providerSource: loser.provider_source,
      providerEventId: loser.provider_event_id,
    })),
  }));
  const operationId = `sec_preempt_${requestHash.slice(0, 32)}`;
  const idempotencyKey = `secretary.preemption:${winner.sourceSkill}:${winner.sourceIntentId}:${winnerAgendaVersion}`;

  insertWinnerAgendaRow({
    ...winner,
    tenantId,
    agendaItemId: winnerAgendaItemId,
    version: winnerAgendaVersion,
  }, input.nowIso, db);

  db.prepare(`
    INSERT INTO secretary_agenda_preemption_operations (
      operation_id, owner_user_id, tenant_id,
      winner_agenda_item_id, winner_agenda_version,
      prior_winner_agenda_item_id, prior_winner_agenda_version,
      prior_winner_provider_source, prior_winner_provider_event_id,
      winner_source_skill, winner_source_intent_id, winner_source_shape_hash,
      winner_provider_target, winner_final_lifecycle_state,
      arbitration_policy_version, idempotency_key, request_hash,
      state, failure_disposition, failure_code, retry_after_at,
      cancel_requested_at, created_at, updated_at, completed_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      'cleanup_pending', NULL, NULL, NULL, NULL, ?, ?, NULL
    )
  `).run(
    operationId,
    winner.ownerUserId,
    tenantId,
    winnerAgendaItemId,
    winnerAgendaVersion,
    priorActiveWinner?.agenda_item_id ?? null,
    priorActiveWinner?.version ?? null,
    priorActiveWinner?.provider_source ?? null,
    priorActiveWinner?.provider_event_id ?? null,
    winner.sourceSkill,
    winner.sourceIntentId,
    winner.sourceShapeHash,
    winner.providerTarget,
    winner.decisionAction,
    winner.rank.policyVersion,
    idempotencyKey,
    requestHash,
    input.nowIso,
    input.nowIso,
  );

  for (const loser of losers) {
    const replacementVersion = Number(loser.version) + 1;
    const replacementId = buildAgendaItemId({
      ownerUserId: loser.owner_user_id,
      tenantId: loser.tenant_id,
      sourceSkill: loser.source_skill,
      sourceIntentId: loser.source_intent_id,
      version: replacementVersion,
    });
    insertProposedLoserReplacement(loser, replacementId, replacementVersion, input.nowIso, db);
    const providerIdentityHash = sha256(stableStringify({
      ownerUserId: loser.owner_user_id,
      tenantId: loser.tenant_id,
      agendaItemId: loser.agenda_item_id,
      agendaVersion: loser.version,
      providerSource: loser.provider_source,
      providerEventId: loser.provider_event_id,
    }));
    const dependencyHash = sha256(stableStringify({
      operationId,
      providerIdentityHash,
    }));
    db.prepare(`
      INSERT INTO secretary_agenda_preemption_dependencies (
        dependency_id, operation_id, owner_user_id, tenant_id,
        loser_agenda_item_id, loser_agenda_version,
        loser_replacement_agenda_item_id, loser_replacement_version,
        loser_source_skill, loser_source_intent_id, loser_source_shape_hash,
        loser_arbitration_score, loser_arbitration_deadline_at,
        loser_arbitration_flexibility, loser_arbitration_policy_version,
        loser_provider_target, loser_provider_source, loser_provider_event_id,
        provider_identity_hash, state, lease_token, lease_expires_at, heartbeat_at,
        attempt_count, failure_disposition, failure_code, retry_after_at,
        provider_deleted_at, satisfied_at, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        'pending', NULL, NULL, NULL, 0, NULL, NULL, NULL, NULL, NULL, ?, ?
      )
    `).run(
      `sec_preempt_dep_${dependencyHash.slice(0, 32)}`,
      operationId,
      loser.owner_user_id,
      loser.tenant_id,
      loser.agenda_item_id,
      loser.version,
      replacementId,
      replacementVersion,
      loser.source_skill,
      loser.source_intent_id,
      loser.source_shape_hash,
      loser.arbitration_score,
      loser.arbitration_deadline_at,
      loser.arbitration_flexibility,
      loser.arbitration_policy_version,
      loser.provider_target,
      loser.provider_source,
      loser.provider_event_id,
      providerIdentityHash,
      input.nowIso,
      input.nowIso,
    );
  }

  emitDomainEvent({
    tenantId: winner.ownerUserId,
    userId: winner.ownerUserId,
    sourceSkill: 'secretary',
    eventType: SECRETARY_ARBITRATION_COMMITTED_EVENT_TYPE,
    entityType: 'secretary_agenda_preemption',
    entityId: operationId,
    entityVersion: 1,
    schemaVersion: SECRETARY_ARBITRATION_COMMITTED_SCHEMA_VERSION,
    payload: { agendaTenantId: tenantId, preemptedCount: losers.length },
    privacyClassification: losers.some((loser) => loser.source_skill === 'training')
      || winner.sourceSkill === 'training'
      ? 'health'
      : 'internal',
    idempotencyKey: `secretary.arbitration.committed:${operationId}:1`,
  }, db);

  return {
    operationId,
    winnerAgendaItemId,
    winnerAgendaVersion,
    preemptedCount: losers.length,
    replayed: false,
  };
}

function findExistingOperationForWinner(
  winner: SecretaryPreemptionWinnerDraft,
  db: Database.Database,
): ExistingOperationRow | null {
  return (db.prepare(`
    SELECT operation_id, winner_agenda_item_id, winner_agenda_version,
           winner_source_shape_hash, request_hash, state
      FROM secretary_agenda_preemption_operations
     WHERE owner_user_id = ? AND tenant_id = ?
       AND winner_source_skill = ? AND winner_source_intent_id = ?
       AND state IN (${LOCKED_OPERATION_STATES.map(() => '?').join(', ')})
     ORDER BY datetime(created_at) DESC, operation_id DESC
     LIMIT 1
  `).get(
    winner.ownerUserId,
    normalizeTenantId(winner.tenantId),
    winner.sourceSkill,
    winner.sourceIntentId,
    ...LOCKED_OPERATION_STATES,
  ) as ExistingOperationRow | undefined) ?? null;
}

function countOperationDependencies(operationId: string, db: Database.Database): number {
  const row = db.prepare(`
    SELECT COUNT(*) AS count
      FROM secretary_agenda_preemption_dependencies
     WHERE operation_id = ?
  `).get(operationId) as { count: number };
  return Number(row.count);
}

function revalidateLoser(
  evidence: SecretaryPreemptionLoserEvidence,
  winner: SecretaryPreemptionWinnerDraft,
  tenantId: string,
  db: Database.Database,
): AgendaRow {
  const row = db.prepare(`
    SELECT * FROM secretary_agenda_items
     WHERE agenda_item_id = ? AND owner_user_id = ? AND tenant_id = ?
  `).get(evidence.agendaItemId, winner.ownerUserId, tenantId) as AgendaRow | undefined;
  if (!row) throw new SecretaryPreemptionStaleError('loser_missing');
  if (row.source_skill === winner.sourceSkill) throw new SecretaryPreemptionStaleError('same_skill_loser');
  if (!ACTIVE_LOSER_LIFECYCLES.has(row.lifecycle_state)) {
    throw new SecretaryPreemptionStaleError('loser_not_active');
  }
  if (row.provider_sync_state !== 'synced'
      || row.provider_target !== evidence.providerSource
      || row.provider_source !== evidence.providerSource
      || row.provider_event_id !== evidence.providerEventId) {
    throw new SecretaryPreemptionStaleError('loser_provider_mapping_changed');
  }
  if (!isCompletePersistedRank(row) || !winnerOutranksLoser(winner.rank, row)) {
    throw new SecretaryPreemptionStaleError('loser_rank_changed');
  }
  const latest = readLatestAgendaRow(
    row.owner_user_id,
    row.tenant_id,
    row.source_skill,
    row.source_intent_id,
    db,
  );
  if (!latest || latest.agenda_item_id !== row.agenda_item_id || latest.version !== row.version) {
    throw new SecretaryPreemptionStaleError('loser_version_changed');
  }
  const mappedCount = db.prepare(`
    SELECT COUNT(*) AS count FROM secretary_agenda_items
     WHERE owner_user_id = ? AND tenant_id = ?
       AND provider_source = ? AND provider_event_id = ?
       AND provider_sync_state <> 'deleted'
  `).get(
    row.owner_user_id,
    row.tenant_id,
    evidence.providerSource,
    evidence.providerEventId,
  ) as { count: number };
  if (Number(mappedCount.count) !== 1) throw new SecretaryPreemptionStaleError('ambiguous_provider_mapping');
  const unresolvedEffect = db.prepare(`
    SELECT 1
      FROM secretary_agenda_provider_create_reconciliation
     WHERE owner_user_id = ? AND tenant_id = ? AND provider_source = ?
       AND source_skill = ? AND source_intent_id = ?
       AND resolution_state IN ('in_flight', 'unknown', 'known')
    UNION ALL
    SELECT 1
      FROM secretary_agenda_provider_effect_recovery
     WHERE owner_user_id = ? AND tenant_id = ? AND provider_source = ?
       AND source_skill = ? AND source_intent_id = ?
       AND resolution_state = 'pending'
     LIMIT 1
  `).get(
    row.owner_user_id,
    row.tenant_id,
    evidence.providerSource,
    row.source_skill,
    row.source_intent_id,
    row.owner_user_id,
    row.tenant_id,
    evidence.providerSource,
    row.source_skill,
    row.source_intent_id,
  );
  if (unresolvedEffect) throw new SecretaryPreemptionStaleError('loser_provider_effect_unresolved');
  return row;
}

function insertWinnerAgendaRow(
  winner: SecretaryPreemptionWinnerDraft & {
    agendaItemId: string;
    version: number;
  },
  nowIso: string,
  db: Database.Database,
): void {
  db.prepare(`
    INSERT INTO secretary_agenda_items (
      agenda_item_id, source_intent_id, source_skill, source_action, intent_action,
      source_entity_id, source_entity_type, owner_user_id, tenant_id,
      lifecycle_state, provider_sync_state, provider_event_id, provider_source,
      version, title, start_at, end_at, duration_minutes, decision_action,
      decision_reason_codes_json, decision_explanation, source_shape_hash,
      scheduled_segments_json, cancellation_reason, superseded_by_agenda_item_id,
      created_at, updated_at, completed_at, source_created_at, source_updated_at,
      reasoning_trail_json, provider_sync_failure_count, last_synced_fingerprint,
      last_synced_verified_at, arbitration_score, arbitration_deadline_at,
      arbitration_flexibility, arbitration_policy_version, provider_target,
      provider_sync_failure_disposition, provider_sync_retry_after_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', 'not_synced', NULL, NULL,
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL, ?, ?, ?,
      0, NULL, NULL, ?, ?, ?, ?, ?, NULL, NULL
    )
  `).run(
    winner.agendaItemId,
    winner.sourceIntentId,
    winner.sourceSkill,
    winner.sourceAction,
    winner.intentAction,
    winner.sourceEntityId,
    winner.sourceEntityType,
    winner.ownerUserId,
    winner.tenantId,
    winner.version,
    winner.title,
    winner.startAt,
    winner.endAt,
    winner.durationMinutes,
    winner.decisionAction,
    JSON.stringify(winner.decisionReasonCodes),
    winner.decisionExplanation,
    winner.sourceShapeHash,
    JSON.stringify(winner.scheduledSegments),
    nowIso,
    nowIso,
    winner.sourceCreatedAt,
    winner.sourceUpdatedAt,
    winner.reasoningTrail.length > 0 ? JSON.stringify(winner.reasoningTrail) : null,
    winner.rank.score,
    winner.rank.deadlineAt,
    winner.rank.flexibility,
    winner.rank.policyVersion,
    winner.providerTarget,
  );
}

function insertProposedLoserReplacement(
  loser: AgendaRow,
  replacementId: string,
  replacementVersion: number,
  nowIso: string,
  db: Database.Database,
): void {
  db.prepare(`
    INSERT INTO secretary_agenda_items (
      agenda_item_id, source_intent_id, source_skill, source_action, intent_action,
      source_entity_id, source_entity_type, owner_user_id, tenant_id,
      lifecycle_state, provider_sync_state, provider_event_id, provider_source,
      version, title, start_at, end_at, duration_minutes, decision_action,
      decision_reason_codes_json, decision_explanation, source_shape_hash,
      scheduled_segments_json, cancellation_reason, superseded_by_agenda_item_id,
      created_at, updated_at, completed_at, source_created_at, source_updated_at,
      reasoning_trail_json, provider_sync_failure_count, last_synced_fingerprint,
      last_synced_verified_at, arbitration_score, arbitration_deadline_at,
      arbitration_flexibility, arbitration_policy_version, provider_target,
      provider_sync_failure_disposition, provider_sync_retry_after_at
    )
    SELECT ?, source_intent_id, source_skill, source_action, intent_action,
           source_entity_id, source_entity_type, owner_user_id, tenant_id,
           'proposed', 'not_synced', NULL, NULL,
           ?, title, start_at, end_at, duration_minutes, 'unscheduled',
           ?, 'A higher-ranked cross-skill intent is waiting for exact provider cleanup.',
           source_shape_hash, scheduled_segments_json, 'priority_preemption_pending', NULL,
           ?, ?, NULL, source_created_at, source_updated_at, reasoning_trail_json,
           0, NULL, NULL, arbitration_score, arbitration_deadline_at,
           arbitration_flexibility, arbitration_policy_version, provider_target,
           NULL, NULL
      FROM secretary_agenda_items
     WHERE agenda_item_id = ? AND owner_user_id = ? AND tenant_id = ? AND version = ?
  `).run(
    replacementId,
    replacementVersion,
    JSON.stringify(['priority_preempted_by_higher_rank']),
    nowIso,
    nowIso,
    loser.agenda_item_id,
    loser.owner_user_id,
    loser.tenant_id,
    loser.version,
  );
}

function readLatestAgendaRow(
  ownerUserId: number,
  tenantId: string,
  sourceSkill: string,
  sourceIntentId: string,
  db: Database.Database,
): AgendaRow | null {
  return (db.prepare(`
    SELECT * FROM secretary_agenda_items
     WHERE owner_user_id = ? AND tenant_id = ?
       AND source_skill = ? AND source_intent_id = ?
     ORDER BY version DESC LIMIT 1
  `).get(ownerUserId, tenantId, sourceSkill, sourceIntentId) as AgendaRow | undefined) ?? null;
}

function isCompletePersistedRank(row: AgendaRow): boolean {
  return row.arbitration_score != null
    && Number.isFinite(Number(row.arbitration_score))
    && row.arbitration_flexibility != null
    && row.arbitration_flexibility !== 'fixed'
    && ['flexible', 'compressible', 'splittable'].includes(row.arbitration_flexibility)
    && row.arbitration_policy_version === 'secretary-arbitration-rank-policy.v1'
    && isValidOptionalNormalizedIso(row.arbitration_deadline_at);
}

function isCompleteRank(rank: SecretaryPreemptionRankSnapshot): boolean {
  return Number.isFinite(rank.score)
    && ['fixed', 'flexible', 'compressible', 'splittable'].includes(rank.flexibility)
    && rank.policyVersion === 'secretary-arbitration-rank-policy.v1'
    && Boolean(rank.tieBreakerIntentId.trim())
    && isValidOptionalNormalizedIso(rank.deadlineAt);
}

function winnerOutranksLoser(rank: SecretaryPreemptionRankSnapshot, loser: AgendaRow): boolean {
  const loserScore = Number(loser.arbitration_score);
  if (rank.score !== loserScore) return rank.score > loserScore;
  const winnerDeadline = rank.deadlineAt ? Date.parse(rank.deadlineAt) : Number.POSITIVE_INFINITY;
  const loserDeadline = loser.arbitration_deadline_at
    ? Date.parse(loser.arbitration_deadline_at)
    : Number.POSITIVE_INFINITY;
  if (winnerDeadline !== loserDeadline) return winnerDeadline < loserDeadline;
  return rank.tieBreakerIntentId.localeCompare(loser.source_intent_id) < 0;
}

function isValidOptionalNormalizedIso(value: string | null): boolean {
  if (value == null) return true;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isValidSlot(start: string, end: string): boolean {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  return Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs;
}

function windowsOverlap(leftStart: string, leftEnd: string, rightStart: string, rightEnd: string): boolean {
  return Date.parse(leftStart) < Date.parse(rightEnd) && Date.parse(rightStart) < Date.parse(leftEnd);
}

function buildAgendaItemId(input: {
  ownerUserId: number;
  tenantId: string;
  sourceSkill: string;
  sourceIntentId: string;
  version: number;
}): string {
  return `sec_agenda_${sha256(`${input.ownerUserId}:${input.tenantId}:${input.sourceSkill}:${input.sourceIntentId}:${input.version}`).slice(0, 24)}`;
}

function normalizeTenantId(value: string): string {
  return String(value ?? '').trim();
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`).join(',')}}`;
}
