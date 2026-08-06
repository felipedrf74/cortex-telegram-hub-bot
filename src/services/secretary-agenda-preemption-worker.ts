// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getDb } from './database';
import { emitDomainEvent } from './event-outbox';
import { isProviderEventNotFoundError } from './training-calendar-errors';
import { secretaryAgendaPreemptionSchemaReady } from './secretary-agenda-preemption';
import {
  SECRETARY_SOURCE_SKILL_FEEDBACK_EVENT_TYPE,
  SECRETARY_SOURCE_SKILL_FEEDBACK_EVENT_VERSION,
  SECRETARY_SOURCE_SKILL_FEEDBACK_SCHEMA_VERSION,
} from './secretary-source-skill-feedback-consumers';
import {
  TRAINING_SECRETARY_FEEDBACK_EVENT_TYPE,
  TRAINING_SECRETARY_FEEDBACK_SCHEMA_VERSION,
} from './training-secretary-feedback-consumer';
import type {
  SecretaryAgendaProviderAdapter,
  SecretaryAgendaProviderSyncResult,
  SecretaryCalendarProviderSource,
  SecretaryProviderEventInput,
} from './secretary-agenda-provider-sync';
import {
  assertTrainingCalendarSourceWritesEnabled,
  TrainingOperationDisabledError,
} from './training-operational-switches';

const DEFAULT_EDGE_LEASE_MS = 15 * 60_000;
const DEFAULT_EDGE_HEARTBEAT_MS = 60_000;
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 30 * 60_000;

type SourceSkill = 'secretary' | 'training' | 'cooking' | 'finance' | 'content';
type FailureDisposition = 'terminal' | 'retryable' | 'reconcile';

interface DependencyClaim {
  dependencyId: string;
  operationId: string;
  ownerUserId: number;
  tenantId: string;
  loserAgendaItemId: string;
  loserAgendaVersion: number;
  loserReplacementAgendaItemId: string;
  loserReplacementVersion: number;
  loserSourceSkill: SourceSkill;
  loserSourceIntentId: string;
  loserProviderTarget: SecretaryCalendarProviderSource;
  loserProviderSource: SecretaryCalendarProviderSource;
  loserProviderEventId: string;
  attemptCount: number;
  leaseToken: string;
  leaseDurationMs: number;
  lost: boolean;
}

interface DependencyAgendaRow {
  agenda_item_id: string;
  source_intent_id: string;
  source_skill: SourceSkill;
  source_entity_id: string | null;
  source_entity_type: string | null;
  owner_user_id: number;
  tenant_id: string;
  version: number;
  title: string;
  start_at: string | null;
  end_at: string | null;
  duration_minutes: number | null;
  lifecycle_state: string;
  decision_reason_codes_json: string;
  source_shape_hash: string;
  provider_target: SecretaryCalendarProviderSource | null;
  provider_source: SecretaryCalendarProviderSource | null;
  provider_event_id: string | null;
  provider_sync_state: string;
}

interface TerminalDependencyRow {
  dependencyId: string;
  state: 'pending' | 'in_progress' | 'retryable' | 'reconcile' | 'terminal' | 'satisfied';
  leaseToken: string | null;
  leaseActive: number;
  replacementAgendaItemId: string;
  replacementVersion: number;
  sourceSkill: SourceSkill;
  sourceIntentId: string;
}

export interface SecretaryPreemptionDependencyBatchResult {
  results: SecretaryAgendaProviderSyncResult[];
  callsUsed: number;
}

export function hasUnresolvedSecretaryPreemptionDependencies(input: {
  agendaItemId: string;
  agendaVersion: number;
  ownerUserId: number;
  tenantId: string | number;
}, db: Database.Database = getDb()): boolean {
  if (!secretaryAgendaPreemptionSchemaReady(db)) return false;
  return Boolean(db.prepare(`
    SELECT 1
      FROM secretary_agenda_preemption_operations AS operation
     WHERE operation.owner_user_id = ?
       AND operation.tenant_id = ?
       AND operation.winner_agenda_item_id = ?
       AND operation.winner_agenda_version = ?
       AND (
         operation.state NOT IN ('winner_ready', 'winner_reconcile', 'completed')
         OR EXISTS (
           SELECT 1
             FROM secretary_agenda_preemption_dependencies AS dependency
            WHERE dependency.operation_id = operation.operation_id
              AND dependency.state <> 'satisfied'
         )
       )
     LIMIT 1
  `).get(
    input.ownerUserId,
    String(input.tenantId),
    input.agendaItemId,
    input.agendaVersion,
  ));
}

/**
 * Drains exact provider-delete dependencies before ordinary agenda sync. Each
 * edge is marker-read before deletion; a missing exact id is a confirmed
 * idempotent success, while an ambiguous delete outcome enters readback-only
 * reconciliation instead of blindly deleting again.
 */
export async function processSecretaryPreemptionDependencies(input: {
  ownerUserId: number;
  tenantId: string | number;
  providerSource: SecretaryCalendarProviderSource;
  adapter: SecretaryAgendaProviderAdapter;
  maxCalls: number;
  winnerAgendaItemId?: string;
  leaseDurationMs?: number;
  heartbeatIntervalMs?: number;
}): Promise<SecretaryPreemptionDependencyBatchResult> {
  const db = getDb();
  if (!secretaryAgendaPreemptionSchemaReady(db) || input.maxCalls < 2) {
    return { results: [], callsUsed: 0 };
  }
  const limit = Math.max(0, Math.floor(input.maxCalls));
  let callsUsed = 0;
  const results: SecretaryAgendaProviderSyncResult[] = [];

  while (callsUsed + 2 <= limit) {
    const claim = claimNextDependency({
      ownerUserId: input.ownerUserId,
      tenantId: String(input.tenantId),
      providerSource: input.providerSource,
      winnerAgendaItemId: input.winnerAgendaItemId,
      leaseDurationMs: input.leaseDurationMs,
    }, db);
    if (!claim) break;
    const stopHeartbeat = startDependencyHeartbeat(claim, input.heartbeatIntervalMs, db);
    try {
      const loser = readClaimedLoser(claim, db);
      if (!loser || !isExactClaimedLoser(claim, loser)) {
        markDependencyFailure(claim, 'terminal', 'LOCAL_PROVIDER_MAPPING_CHANGED', null, db);
        results.push(failedResult(claim, 'priority_preemption_local_identity_mismatch'));
        continue;
      }
      const providerInput = toProviderInput(loser);
      if (!input.adapter.getEvent) {
        markDependencyFailure(claim, 'terminal', 'PROVIDER_READBACK_UNSUPPORTED', null, db);
        results.push(failedResult(claim, 'priority_preemption_provider_readback_unsupported'));
        continue;
      }

      assertDependencyClaimActive(claim, db);
      callsUsed += 1;
      const exactRead = await input.adapter.getEvent(claim.loserProviderEventId, providerInput);
      assertDependencyClaimActive(claim, db);
      if (exactRead.status === 'unknown') {
        markDependencyFailure(
          claim,
          'retryable',
          'PROVIDER_EXACT_READ_UNKNOWN',
          new Date(Date.now() + retryDelayMs(claim.attemptCount)).toISOString(),
          db,
        );
        results.push(failedResult(claim, 'priority_preemption_provider_read_retryable'));
        continue;
      }
      if (exactRead.status === 'not_found') {
        finalizeSatisfiedDependency(claim, db);
        results.push(satisfiedResult(claim));
        continue;
      }
      const observed = exactRead.event;
      if (observed.eventId !== claim.loserProviderEventId
          || observed.source !== claim.loserProviderSource
          || observed.agendaItemId !== claim.loserAgendaItemId
          || (observed.version != null && observed.version !== claim.loserAgendaVersion)) {
        markDependencyFailure(claim, 'terminal', 'PROVIDER_IDENTITY_MISMATCH', null, db);
        results.push(failedResult(claim, 'priority_preemption_provider_identity_mismatch'));
        continue;
      }

      assertDependencyClaimActive(claim, db);
      callsUsed += 1;
      try {
        if (claim.loserSourceSkill === 'training') {
          assertTrainingCalendarSourceWritesEnabled(claim.loserProviderSource);
        }
        await input.adapter.deleteEvent(claim.loserProviderEventId, providerInput);
      } catch (error) {
        if (!isProviderEventNotFoundError(error)) {
          const disposition = classifyDeleteFailure(error);
          const retryAfter = disposition === 'retryable'
            ? new Date(Date.now() + retryDelayMs(claim.attemptCount)).toISOString()
            : null;
          markDependencyFailure(claim, disposition, deleteFailureCode(error), retryAfter, db);
          results.push(failedResult(
            claim,
            disposition === 'reconcile'
              ? 'priority_preemption_delete_reconciliation_required'
              : disposition === 'retryable'
                ? 'priority_preemption_delete_retryable'
                : 'priority_preemption_delete_terminal',
          ));
          continue;
        }
      }
      assertDependencyClaimActive(claim, db);
      finalizeSatisfiedDependency(claim, db);
      results.push(satisfiedResult(claim));
    } catch (error) {
      if (isDependencyLeaseLost(error)) throw error;
      try {
        markDependencyFailure(claim, 'retryable', 'PREEMPTION_WORKER_ERROR', new Date(Date.now() + RETRY_BASE_MS).toISOString(), db);
      } catch (markError) {
        if (isDependencyLeaseLost(markError)) throw markError;
      }
      results.push(failedResult(claim, 'priority_preemption_worker_failed'));
    } finally {
      stopHeartbeat();
    }
  }
  return { results, callsUsed };
}

export function requestSecretaryPreemptionCancellation(input: {
  agendaItemId: string;
  agendaVersion: number;
  ownerUserId: number;
  tenantId: string | number;
  nowIso: string;
}, db: Database.Database = getDb()): void {
  if (!secretaryAgendaPreemptionSchemaReady(db)) return;
  db.prepare(`
    UPDATE secretary_agenda_preemption_operations
       SET cancel_requested_at = COALESCE(cancel_requested_at, ?),
           updated_at = ?
     WHERE owner_user_id = ? AND tenant_id = ?
       AND winner_agenda_item_id = ? AND winner_agenda_version = ?
       AND state IN ('cleanup_pending', 'cleanup_blocked', 'winner_ready', 'winner_reconcile')
  `).run(
    input.nowIso,
    input.nowIso,
    input.ownerUserId,
    String(input.tenantId),
    input.agendaItemId,
    input.agendaVersion,
  );
  finalizeSecretaryPreemptionCancellationIfSafe(input, db);
}

export function finalizeSecretaryPreemptionCancellationIfSafe(input: {
  agendaItemId: string;
  agendaVersion: number;
  ownerUserId: number;
  tenantId: string | number;
  nowIso?: string;
}, db: Database.Database = getDb()): boolean {
  if (!secretaryAgendaPreemptionSchemaReady(db)) return false;
  const nowIso = input.nowIso ?? new Date().toISOString();
  const persist = db.transaction(() => {
    const operation = db.prepare(`
      SELECT winner_source_skill AS source_skill
        FROM secretary_agenda_preemption_operations
       WHERE owner_user_id = ? AND tenant_id = ?
         AND winner_agenda_item_id = ? AND winner_agenda_version = ?
    `).get(
      input.ownerUserId,
      String(input.tenantId),
      input.agendaItemId,
      input.agendaVersion,
    ) as { source_skill: SourceSkill } | undefined;
    if (!operation) return false;
    const result = db.prepare(`
      UPDATE secretary_agenda_preemption_operations
         SET state = 'canceled', failure_disposition = NULL, failure_code = NULL,
             retry_after_at = NULL, updated_at = ?
       WHERE owner_user_id = ? AND tenant_id = ?
         AND winner_agenda_item_id = ? AND winner_agenda_version = ?
         AND state IN ('cleanup_pending', 'cleanup_blocked', 'winner_ready', 'winner_reconcile')
         AND cancel_requested_at IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM secretary_agenda_preemption_dependencies AS dependency
          WHERE dependency.operation_id = secretary_agenda_preemption_operations.operation_id
            AND dependency.state <> 'satisfied'
       )
       AND EXISTS (
         SELECT 1 FROM secretary_agenda_items AS winner
          WHERE winner.agenda_item_id = secretary_agenda_preemption_operations.winner_agenda_item_id
            AND winner.version = secretary_agenda_preemption_operations.winner_agenda_version
            AND winner.owner_user_id = secretary_agenda_preemption_operations.owner_user_id
            AND winner.tenant_id = secretary_agenda_preemption_operations.tenant_id
            AND winner.lifecycle_state = 'canceled'
            AND winner.provider_event_id IS NULL
            AND winner.provider_source IS NULL
       )
       AND NOT EXISTS (
         SELECT 1 FROM secretary_agenda_provider_sync_claims AS claim
          WHERE claim.owner_user_id = secretary_agenda_preemption_operations.owner_user_id
            AND claim.tenant_id = secretary_agenda_preemption_operations.tenant_id
            AND claim.agenda_item_id = secretary_agenda_preemption_operations.winner_agenda_item_id
            AND claim.agenda_version = secretary_agenda_preemption_operations.winner_agenda_version
            AND datetime(claim.lease_expires_at) > datetime(?)
       )
       AND NOT EXISTS (
         SELECT 1 FROM secretary_agenda_provider_create_reconciliation AS attempt
          WHERE attempt.owner_user_id = secretary_agenda_preemption_operations.owner_user_id
            AND attempt.tenant_id = secretary_agenda_preemption_operations.tenant_id
            AND attempt.agenda_item_id = secretary_agenda_preemption_operations.winner_agenda_item_id
            AND attempt.agenda_version = secretary_agenda_preemption_operations.winner_agenda_version
            AND attempt.resolution_state IN ('in_flight', 'unknown', 'known')
       )
       AND NOT EXISTS (
         SELECT 1 FROM secretary_agenda_provider_effect_recovery AS recovery
          WHERE recovery.owner_user_id = secretary_agenda_preemption_operations.owner_user_id
            AND recovery.tenant_id = secretary_agenda_preemption_operations.tenant_id
            AND recovery.agenda_item_id = secretary_agenda_preemption_operations.winner_agenda_item_id
            AND recovery.agenda_version = secretary_agenda_preemption_operations.winner_agenda_version
            AND recovery.resolution_state = 'pending'
       )
       AND (
         prior_winner_provider_event_id IS NULL
         OR EXISTS (
           SELECT 1 FROM secretary_agenda_items AS prior
            WHERE prior.agenda_item_id = secretary_agenda_preemption_operations.prior_winner_agenda_item_id
              AND prior.version = secretary_agenda_preemption_operations.prior_winner_agenda_version
              AND prior.owner_user_id = secretary_agenda_preemption_operations.owner_user_id
              AND prior.tenant_id = secretary_agenda_preemption_operations.tenant_id
              AND prior.provider_event_id IS NULL
              AND prior.provider_source IS NULL
              AND prior.provider_sync_state = 'deleted'
         )
       )
       AND NOT EXISTS (
         SELECT 1 FROM secretary_agenda_provider_sync_claims AS claim
          WHERE claim.owner_user_id = secretary_agenda_preemption_operations.owner_user_id
            AND claim.tenant_id = secretary_agenda_preemption_operations.tenant_id
            AND claim.agenda_item_id = secretary_agenda_preemption_operations.prior_winner_agenda_item_id
            AND claim.agenda_version = secretary_agenda_preemption_operations.prior_winner_agenda_version
            AND datetime(claim.lease_expires_at) > datetime(?)
       )
       AND NOT EXISTS (
         SELECT 1 FROM secretary_agenda_provider_effect_recovery AS recovery
          WHERE recovery.owner_user_id = secretary_agenda_preemption_operations.owner_user_id
            AND recovery.tenant_id = secretary_agenda_preemption_operations.tenant_id
            AND recovery.agenda_item_id = secretary_agenda_preemption_operations.prior_winner_agenda_item_id
            AND recovery.agenda_version = secretary_agenda_preemption_operations.prior_winner_agenda_version
            AND recovery.resolution_state = 'pending'
       )
    `).run(
      nowIso,
      input.ownerUserId,
      String(input.tenantId),
      input.agendaItemId,
      input.agendaVersion,
      nowIso,
      nowIso,
    );
    if (result.changes !== 1) return false;
    const winnerTruth = db.prepare(`
      UPDATE secretary_agenda_items
         SET decision_action = 'unscheduled',
             decision_reason_codes_json = '["preemption_canceled_before_provider_sync"]',
             decision_explanation = 'The preemptive calendar placement was canceled before provider confirmation.',
             updated_at = ?
       WHERE agenda_item_id = ? AND version = ?
         AND owner_user_id = ? AND tenant_id = ?
         AND lifecycle_state = 'canceled'
         AND provider_event_id IS NULL AND provider_source IS NULL
    `).run(
      nowIso,
      input.agendaItemId,
      input.agendaVersion,
      input.ownerUserId,
      String(input.tenantId),
    );
    if (winnerTruth.changes !== 1) {
      throw new Error('SECRETARY_PREEMPTION_CANCELED_WINNER_TRUTH_MISSED');
    }
    emitFeedbackRequest({
      agendaItemId: input.agendaItemId,
      agendaVersion: input.agendaVersion,
      ownerUserId: input.ownerUserId,
      tenantId: String(input.tenantId),
      sourceSkill: operation.source_skill,
    }, db);
    return true;
  });
  return persist();
}

export function finalizeSecretaryPreemptionCancellationsAfterAgendaCleanup(input: {
  agendaItemId: string;
  agendaVersion: number;
  ownerUserId: number;
  tenantId: string | number;
}, db: Database.Database = getDb()): void {
  if (!secretaryAgendaPreemptionSchemaReady(db)) return;
  const operations = db.prepare(`
    SELECT winner_agenda_item_id AS agenda_item_id,
           winner_agenda_version AS agenda_version
      FROM secretary_agenda_preemption_operations
     WHERE owner_user_id = ? AND tenant_id = ?
       AND cancel_requested_at IS NOT NULL
       AND state IN ('cleanup_pending', 'cleanup_blocked', 'winner_ready', 'winner_reconcile')
       AND (
         (winner_agenda_item_id = ? AND winner_agenda_version = ?)
         OR (prior_winner_agenda_item_id = ? AND prior_winner_agenda_version = ?)
       )
  `).all(
    input.ownerUserId,
    String(input.tenantId),
    input.agendaItemId,
    input.agendaVersion,
    input.agendaItemId,
    input.agendaVersion,
  ) as Array<{ agenda_item_id: string; agenda_version: number }>;
  for (const operation of operations) {
    finalizeSecretaryPreemptionCancellationIfSafe({
      agendaItemId: operation.agenda_item_id,
      agendaVersion: Number(operation.agenda_version),
      ownerUserId: input.ownerUserId,
      tenantId: input.tenantId,
    }, db);
  }
}

export function markSecretaryPreemptionWinnerProviderSucceeded(input: {
  agendaItemId: string;
  agendaVersion: number;
  ownerUserId: number;
  tenantId: string | number;
  nowIso: string;
}, db: Database.Database = getDb()): void {
  if (!secretaryAgendaPreemptionSchemaReady(db)) return;
  const persist = db.transaction(() => {
    const write = db.prepare(`
      UPDATE secretary_agenda_preemption_operations
         SET state = 'completed', failure_disposition = NULL, failure_code = NULL,
             retry_after_at = NULL, completed_at = ?, updated_at = ?
       WHERE owner_user_id = ? AND tenant_id = ?
         AND winner_agenda_item_id = ? AND winner_agenda_version = ?
         AND state IN ('winner_ready', 'winner_reconcile')
         AND cancel_requested_at IS NULL
    `).run(
      input.nowIso,
      input.nowIso,
      input.ownerUserId,
      String(input.tenantId),
      input.agendaItemId,
      input.agendaVersion,
    );
    if (write.changes !== 1) return;
    const operation = db.prepare(`
      SELECT winner_source_skill AS source_skill
        FROM secretary_agenda_preemption_operations
       WHERE owner_user_id = ? AND tenant_id = ?
         AND winner_agenda_item_id = ? AND winner_agenda_version = ?
    `).get(
      input.ownerUserId,
      String(input.tenantId),
      input.agendaItemId,
      input.agendaVersion,
    ) as { source_skill: SourceSkill };
    emitFeedbackRequest({
      agendaItemId: input.agendaItemId,
      agendaVersion: input.agendaVersion,
      ownerUserId: input.ownerUserId,
      tenantId: String(input.tenantId),
      sourceSkill: operation.source_skill,
    }, db);
  });
  persist();
}

export function expireUnsyncedSecretaryPreemptionWinners(
  now: Date = new Date(),
  db: Database.Database = getDb(),
): number {
  if (!secretaryAgendaPreemptionSchemaReady(db)) return 0;
  const nowIso = now.toISOString();
  const candidates = db.prepare(`
    SELECT operation.operation_id, operation.winner_agenda_item_id,
           operation.winner_agenda_version, operation.owner_user_id,
           operation.tenant_id, operation.winner_source_skill
      FROM secretary_agenda_preemption_operations AS operation
      JOIN secretary_agenda_items AS winner
        ON winner.agenda_item_id = operation.winner_agenda_item_id
       AND winner.version = operation.winner_agenda_version
       AND winner.owner_user_id = operation.owner_user_id
       AND winner.tenant_id = operation.tenant_id
     WHERE operation.state IN ('winner_ready', 'winner_reconcile')
       AND operation.cancel_requested_at IS NULL
       AND winner.lifecycle_state IN ('scheduled', 'reflowed', 'compressed', 'failed_sync')
       AND winner.end_at IS NOT NULL
       AND datetime(winner.end_at) < datetime(?)
       AND winner.provider_event_id IS NULL
       AND winner.provider_source IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM secretary_agenda_preemption_dependencies AS dependency
          WHERE dependency.operation_id = operation.operation_id
            AND dependency.state <> 'satisfied'
       )
       AND NOT EXISTS (
         SELECT 1 FROM secretary_agenda_provider_sync_claims AS claim
          WHERE claim.owner_user_id = operation.owner_user_id
            AND claim.tenant_id = operation.tenant_id
            AND claim.agenda_item_id = operation.winner_agenda_item_id
            AND claim.agenda_version = operation.winner_agenda_version
            AND datetime(claim.lease_expires_at) > datetime(?)
       )
       AND NOT EXISTS (
         SELECT 1 FROM secretary_agenda_provider_create_reconciliation AS attempt
          WHERE attempt.owner_user_id = operation.owner_user_id
            AND attempt.tenant_id = operation.tenant_id
            AND attempt.agenda_item_id = operation.winner_agenda_item_id
            AND attempt.agenda_version = operation.winner_agenda_version
            AND attempt.resolution_state IN ('in_flight', 'unknown', 'known')
       )
       AND NOT EXISTS (
         SELECT 1 FROM secretary_agenda_provider_effect_recovery AS recovery
          WHERE recovery.owner_user_id = operation.owner_user_id
            AND recovery.tenant_id = operation.tenant_id
            AND recovery.agenda_item_id = operation.winner_agenda_item_id
            AND recovery.agenda_version = operation.winner_agenda_version
            AND recovery.resolution_state = 'pending'
       )
     ORDER BY operation.created_at, operation.operation_id
  `).all(nowIso, nowIso) as Array<{
    operation_id: string;
    winner_agenda_item_id: string;
    winner_agenda_version: number;
    owner_user_id: number;
    tenant_id: string;
    winner_source_skill: SourceSkill;
  }>;
  let expired = 0;
  const persist = db.transaction(() => {
    for (const candidate of candidates) {
      const winnerWrite = db.prepare(`
        UPDATE secretary_agenda_items
           SET lifecycle_state = 'canceled',
               cancellation_reason = 'preemption_winner_expired_before_provider_sync',
               decision_action = 'unscheduled',
               decision_reason_codes_json = '["preemption_winner_expired_before_provider_sync"]',
               decision_explanation = 'The reserved preemptive slot expired before provider confirmation.',
               updated_at = ?
         WHERE agenda_item_id = ? AND version = ?
           AND owner_user_id = ? AND tenant_id = ?
           AND lifecycle_state IN ('scheduled', 'reflowed', 'compressed', 'failed_sync')
           AND provider_event_id IS NULL AND provider_source IS NULL
      `).run(
        nowIso,
        candidate.winner_agenda_item_id,
        candidate.winner_agenda_version,
        candidate.owner_user_id,
        candidate.tenant_id,
      );
      if (winnerWrite.changes !== 1) continue;
      const operationWrite = db.prepare(`
        UPDATE secretary_agenda_preemption_operations
           SET state = 'canceled', cancel_requested_at = ?,
               failure_disposition = NULL, failure_code = NULL,
               retry_after_at = NULL, updated_at = ?
         WHERE operation_id = ? AND state IN ('winner_ready', 'winner_reconcile')
           AND cancel_requested_at IS NULL
      `).run(nowIso, nowIso, candidate.operation_id);
      if (operationWrite.changes !== 1) throw new Error('SECRETARY_PREEMPTION_EXPIRY_STATE_MISSED');
      emitFeedbackRequest({
        agendaItemId: candidate.winner_agenda_item_id,
        agendaVersion: candidate.winner_agenda_version,
        ownerUserId: candidate.owner_user_id,
        tenantId: candidate.tenant_id,
        sourceSkill: candidate.winner_source_skill,
      }, db);
      expired += 1;
    }
  });
  persist.immediate();
  return expired;
}

export function markSecretaryPreemptionWinnerProviderFailed(input: {
  agendaItemId: string;
  agendaVersion: number;
  ownerUserId: number;
  tenantId: string | number;
  disposition: FailureDisposition;
  failureCode: string;
  retryAfterAt: string | null;
  nowIso: string;
}, db: Database.Database = getDb()): void {
  if (!secretaryAgendaPreemptionSchemaReady(db)) return;
  const nextState = input.disposition === 'terminal'
    ? 'terminal_failure'
    : input.disposition === 'reconcile'
      ? 'winner_reconcile'
      : 'winner_ready';
  const persist = db.transaction(() => {
    const operation = db.prepare(`
      SELECT winner_source_skill AS sourceSkill
        FROM secretary_agenda_preemption_operations
       WHERE owner_user_id = ? AND tenant_id = ?
         AND winner_agenda_item_id = ? AND winner_agenda_version = ?
         AND state IN ('winner_ready', 'winner_reconcile')
    `).get(
      input.ownerUserId,
      String(input.tenantId),
      input.agendaItemId,
      input.agendaVersion,
    ) as { sourceSkill: SourceSkill } | undefined;
    if (!operation) return;
    const write = db.prepare(`
      UPDATE secretary_agenda_preemption_operations
         SET state = ?, failure_disposition = ?, failure_code = ?,
             retry_after_at = ?, updated_at = ?
       WHERE owner_user_id = ? AND tenant_id = ?
         AND winner_agenda_item_id = ? AND winner_agenda_version = ?
         AND state IN ('winner_ready', 'winner_reconcile')
    `).run(
      nextState,
      input.disposition,
      input.failureCode,
      input.disposition === 'retryable' ? input.retryAfterAt : null,
      input.nowIso,
      input.ownerUserId,
      String(input.tenantId),
      input.agendaItemId,
      input.agendaVersion,
    );
    if (write.changes !== 1 || input.disposition !== 'terminal') return;
    const winnerWrite = db.prepare(`
      UPDATE secretary_agenda_items
         SET lifecycle_state = 'unscheduled',
             decision_action = 'unscheduled',
             decision_reason_codes_json = '["preemption_winner_provider_terminal_failure"]',
             decision_explanation = 'The provider permanently refused the preemptive calendar placement.',
             cancellation_reason = 'preemption_winner_provider_terminal_failure',
             updated_at = ?
       WHERE agenda_item_id = ? AND version = ?
         AND owner_user_id = ? AND tenant_id = ?
         AND lifecycle_state IN ('scheduled', 'reflowed', 'compressed', 'failed_sync')
         AND provider_event_id IS NULL AND provider_source IS NULL
    `).run(
      input.nowIso,
      input.agendaItemId,
      input.agendaVersion,
      input.ownerUserId,
      String(input.tenantId),
    );
    if (winnerWrite.changes !== 1) {
      throw new Error('SECRETARY_PREEMPTION_TERMINAL_WINNER_TRUTH_MISSED');
    }
    emitFeedbackRequest({
      agendaItemId: input.agendaItemId,
      agendaVersion: input.agendaVersion,
      ownerUserId: input.ownerUserId,
      tenantId: String(input.tenantId),
      sourceSkill: operation.sourceSkill,
    }, db);
  });
  persist();
}

function claimNextDependency(input: {
  ownerUserId: number;
  tenantId: string;
  providerSource: SecretaryCalendarProviderSource;
  winnerAgendaItemId?: string;
  leaseDurationMs?: number;
}, db: Database.Database): DependencyClaim | null {
  const leaseDurationMs = normalizeLeaseMs(input.leaseDurationMs);
  const claim = db.transaction(() => {
    const now = new Date();
    const nowIso = now.toISOString();
    const row = db.prepare(`
      SELECT dependency.dependency_id, dependency.operation_id,
             dependency.owner_user_id, dependency.tenant_id,
             dependency.loser_agenda_item_id, dependency.loser_agenda_version,
             dependency.loser_replacement_agenda_item_id,
             dependency.loser_replacement_version,
             dependency.loser_source_skill, dependency.loser_source_intent_id,
             dependency.loser_provider_target, dependency.loser_provider_source,
             dependency.loser_provider_event_id, dependency.attempt_count
        FROM secretary_agenda_preemption_dependencies AS dependency
        JOIN secretary_agenda_preemption_operations AS operation
          ON operation.operation_id = dependency.operation_id
         AND operation.owner_user_id = dependency.owner_user_id
         AND operation.tenant_id = dependency.tenant_id
       WHERE dependency.owner_user_id = ? AND dependency.tenant_id = ?
         AND dependency.loser_provider_source = ?
         AND (? IS NULL OR operation.winner_agenda_item_id = ?)
         AND operation.state IN ('cleanup_pending', 'cleanup_blocked')
         AND (
           dependency.state IN ('pending', 'reconcile')
           OR (
             dependency.state = 'retryable'
             AND (dependency.retry_after_at IS NULL OR datetime(dependency.retry_after_at) <= datetime(?))
           )
           OR (
             dependency.state = 'in_progress'
             AND datetime(dependency.lease_expires_at) <= datetime(?)
           )
         )
       ORDER BY datetime(dependency.created_at), dependency.dependency_id
       LIMIT 1
    `).get(
      input.ownerUserId,
      input.tenantId,
      input.providerSource,
      input.winnerAgendaItemId?.trim() || null,
      input.winnerAgendaItemId?.trim() || null,
      nowIso,
      nowIso,
    ) as Record<string, unknown> | undefined;
    if (!row) return null;
    const leaseToken = randomUUID();
    const leaseExpiresAt = new Date(now.getTime() + leaseDurationMs).toISOString();
    const write = db.prepare(`
      UPDATE secretary_agenda_preemption_dependencies
         SET state = 'in_progress', lease_token = ?, lease_expires_at = ?,
             heartbeat_at = ?, attempt_count = attempt_count + 1,
             failure_disposition = NULL, failure_code = NULL,
             retry_after_at = NULL, last_checked_at = ?, updated_at = ?
       WHERE dependency_id = ?
         AND (
           state IN ('pending', 'retryable', 'reconcile')
           OR (state = 'in_progress' AND datetime(lease_expires_at) <= datetime(?))
         )
    `).run(
      leaseToken,
      leaseExpiresAt,
      nowIso,
      nowIso,
      nowIso,
      row.dependency_id,
      nowIso,
    );
    if (write.changes !== 1) return null;
    db.prepare(`
      UPDATE secretary_agenda_preemption_operations
         SET state = 'cleanup_pending', failure_disposition = NULL,
             failure_code = NULL, retry_after_at = NULL, updated_at = ?
       WHERE operation_id = ? AND state = 'cleanup_blocked'
    `).run(nowIso, row.operation_id);
    return mapClaim(row, leaseToken, leaseDurationMs);
  });
  return claim.immediate();
}

function mapClaim(row: Record<string, unknown>, leaseToken: string, leaseDurationMs: number): DependencyClaim {
  return {
    dependencyId: String(row.dependency_id),
    operationId: String(row.operation_id),
    ownerUserId: Number(row.owner_user_id),
    tenantId: String(row.tenant_id),
    loserAgendaItemId: String(row.loser_agenda_item_id),
    loserAgendaVersion: Number(row.loser_agenda_version),
    loserReplacementAgendaItemId: String(row.loser_replacement_agenda_item_id),
    loserReplacementVersion: Number(row.loser_replacement_version),
    loserSourceSkill: String(row.loser_source_skill) as SourceSkill,
    loserSourceIntentId: String(row.loser_source_intent_id),
    loserProviderTarget: String(row.loser_provider_target) as SecretaryCalendarProviderSource,
    loserProviderSource: String(row.loser_provider_source) as SecretaryCalendarProviderSource,
    loserProviderEventId: String(row.loser_provider_event_id),
    attemptCount: Number(row.attempt_count) + 1,
    leaseToken,
    leaseDurationMs,
    lost: false,
  };
}

function readClaimedLoser(claim: DependencyClaim, db: Database.Database): DependencyAgendaRow | null {
  return (db.prepare(`
    SELECT * FROM secretary_agenda_items
     WHERE agenda_item_id = ? AND version = ?
       AND owner_user_id = ? AND tenant_id = ?
  `).get(
    claim.loserAgendaItemId,
    claim.loserAgendaVersion,
    claim.ownerUserId,
    claim.tenantId,
  ) as DependencyAgendaRow | undefined) ?? null;
}

function isExactClaimedLoser(claim: DependencyClaim, row: DependencyAgendaRow): boolean {
  return row.source_skill === claim.loserSourceSkill
    && row.source_intent_id === claim.loserSourceIntentId
    && row.provider_target === claim.loserProviderTarget
    && row.provider_source === claim.loserProviderSource
    && row.provider_event_id === claim.loserProviderEventId
    && row.provider_sync_state === 'synced'
    && ['scheduled', 'synced', 'reflowed', 'compressed', 'failed_sync'].includes(row.lifecycle_state);
}

function toProviderInput(row: DependencyAgendaRow): SecretaryProviderEventInput {
  if (!row.start_at || !row.end_at) throw new Error('SECRETARY_PREEMPTION_LOSER_SLOT_MISSING');
  return {
    agendaItemId: row.agenda_item_id,
    sourceIntentId: row.source_intent_id,
    sourceSkill: row.source_skill,
    sourceEntityId: row.source_entity_id,
    sourceEntityType: row.source_entity_type,
    ownerUserId: row.owner_user_id,
    tenantId: row.tenant_id,
    version: row.version,
    title: row.title,
    startAt: row.start_at,
    endAt: row.end_at,
    durationMinutes: row.duration_minutes,
    lifecycleState: row.lifecycle_state,
    decisionReasonCodes: parseStringArray(row.decision_reason_codes_json),
    sourceShapeHash: row.source_shape_hash,
  };
}

function finalizeSatisfiedDependency(claim: DependencyClaim, db: Database.Database): void {
  const persist = db.transaction(() => {
    assertDependencyClaimActive(claim, db);
    const nowIso = new Date().toISOString();
    const loserWrite = db.prepare(`
      UPDATE secretary_agenda_items
         SET lifecycle_state = 'superseded', provider_sync_state = 'deleted',
             provider_event_id = NULL, provider_source = NULL,
             cancellation_reason = 'priority_preempted',
             superseded_by_agenda_item_id = ?, updated_at = ?
       WHERE agenda_item_id = ? AND version = ?
         AND owner_user_id = ? AND tenant_id = ?
         AND source_skill = ? AND source_intent_id = ?
         AND provider_target = ? AND provider_source = ? AND provider_event_id = ?
         AND provider_sync_state = 'synced'
         AND lifecycle_state IN ('scheduled', 'synced', 'reflowed', 'compressed', 'failed_sync')
    `).run(
      claim.loserReplacementAgendaItemId,
      nowIso,
      claim.loserAgendaItemId,
      claim.loserAgendaVersion,
      claim.ownerUserId,
      claim.tenantId,
      claim.loserSourceSkill,
      claim.loserSourceIntentId,
      claim.loserProviderTarget,
      claim.loserProviderSource,
      claim.loserProviderEventId,
    );
    if (loserWrite.changes !== 1) throw dependencyLeaseLostError();
    const replacementWrite = db.prepare(`
      UPDATE secretary_agenda_items
         SET lifecycle_state = 'unscheduled', provider_sync_state = 'deleted',
             decision_action = 'unscheduled',
             decision_reason_codes_json = '["priority_preempted_by_higher_rank"]',
             decision_explanation = 'A higher-ranked cross-skill intent replaced this calendar slot.',
             cancellation_reason = 'priority_preempted', updated_at = ?
       WHERE agenda_item_id = ? AND version = ?
         AND owner_user_id = ? AND tenant_id = ?
         AND source_skill = ? AND source_intent_id = ?
         AND lifecycle_state = 'proposed' AND provider_sync_state = 'not_synced'
         AND provider_event_id IS NULL AND provider_source IS NULL
    `).run(
      nowIso,
      claim.loserReplacementAgendaItemId,
      claim.loserReplacementVersion,
      claim.ownerUserId,
      claim.tenantId,
      claim.loserSourceSkill,
      claim.loserSourceIntentId,
    );
    if (replacementWrite.changes !== 1) throw dependencyLeaseLostError();
    const dependencyWrite = db.prepare(`
      UPDATE secretary_agenda_preemption_dependencies
         SET state = 'satisfied', lease_token = NULL, lease_expires_at = NULL,
             heartbeat_at = NULL, failure_disposition = NULL, failure_code = NULL,
             retry_after_at = NULL, provider_deleted_at = ?, satisfied_at = ?,
             last_checked_at = ?, updated_at = ?
       WHERE dependency_id = ? AND operation_id = ?
         AND state = 'in_progress' AND lease_token = ?
         AND datetime(lease_expires_at) > datetime(?)
    `).run(
      nowIso,
      nowIso,
      nowIso,
      nowIso,
      claim.dependencyId,
      claim.operationId,
      claim.leaseToken,
      nowIso,
    );
    if (dependencyWrite.changes !== 1) throw dependencyLeaseLostError();

    emitFeedbackRequest({
      agendaItemId: claim.loserReplacementAgendaItemId,
      agendaVersion: claim.loserReplacementVersion,
      ownerUserId: claim.ownerUserId,
      tenantId: claim.tenantId,
      sourceSkill: claim.loserSourceSkill,
    }, db);

    const unresolved = db.prepare(`
      SELECT COUNT(*) AS count
        FROM secretary_agenda_preemption_dependencies
       WHERE operation_id = ? AND state <> 'satisfied'
    `).get(claim.operationId) as { count: number };
    if (Number(unresolved.count) === 0) finalizeWinner(claim.operationId, nowIso, db);
  });
  persist.immediate();
}

function finalizeWinner(operationId: string, nowIso: string, db: Database.Database): void {
  const operation = db.prepare(`
    SELECT * FROM secretary_agenda_preemption_operations WHERE operation_id = ?
  `).get(operationId) as Record<string, unknown> | undefined;
  if (!operation) throw new Error('SECRETARY_PREEMPTION_OPERATION_MISSING');
  const winnerId = String(operation.winner_agenda_item_id);
  const winnerVersion = Number(operation.winner_agenda_version);
  const ownerUserId = Number(operation.owner_user_id);
  const tenantId = String(operation.tenant_id);
  const winner = db.prepare(`
    SELECT lifecycle_state FROM secretary_agenda_items
     WHERE agenda_item_id = ? AND version = ? AND owner_user_id = ? AND tenant_id = ?
  `).get(winnerId, winnerVersion, ownerUserId, tenantId) as { lifecycle_state: string } | undefined;
  if (!winner) throw new Error('SECRETARY_PREEMPTION_WINNER_MISSING');
  const canceled = operation.cancel_requested_at != null || winner.lifecycle_state === 'canceled';
    if (canceled) {
    db.prepare(`
      UPDATE secretary_agenda_items
         SET lifecycle_state = 'canceled',
             cancellation_reason = COALESCE(cancellation_reason, 'preemption_canceled'),
             decision_action = 'unscheduled',
             decision_reason_codes_json = '["preemption_canceled_before_provider_sync"]',
             decision_explanation = 'The preemptive calendar placement was canceled before provider confirmation.',
             updated_at = ?
       WHERE agenda_item_id = ? AND version = ?
         AND owner_user_id = ? AND tenant_id = ?
         AND lifecycle_state IN ('proposed', 'canceled')
    `).run(nowIso, winnerId, winnerVersion, ownerUserId, tenantId);
    if (operation.prior_winner_provider_event_id != null) {
      const priorWrite = db.prepare(`
        UPDATE secretary_agenda_items
           SET lifecycle_state = 'superseded', superseded_by_agenda_item_id = ?, updated_at = ?
         WHERE agenda_item_id = ? AND version = ?
           AND owner_user_id = ? AND tenant_id = ?
           AND provider_source = ? AND provider_event_id = ?
           AND lifecycle_state IN ('scheduled', 'synced', 'reflowed', 'compressed', 'failed_sync', 'superseded')
      `).run(
        winnerId,
        nowIso,
        operation.prior_winner_agenda_item_id,
        operation.prior_winner_agenda_version,
        ownerUserId,
        tenantId,
        operation.prior_winner_provider_source,
        operation.prior_winner_provider_event_id,
      );
      if (priorWrite.changes !== 1) throw new Error('SECRETARY_PREEMPTION_PRIOR_WINNER_STALE');
      // The exact prior provider id is now cleanup-only work. Keep the
      // operation non-terminal so the older row can acquire the dedicated
      // provider claim even though the canceled winner is a newer version.
      db.prepare(`
        UPDATE secretary_agenda_preemption_operations
           SET updated_at = ?
         WHERE operation_id = ? AND state IN ('cleanup_pending', 'cleanup_blocked')
      `).run(nowIso, operationId);
      return;
    }
    const canceledWrite = db.prepare(`
      UPDATE secretary_agenda_preemption_operations
         SET state = 'canceled', cancel_requested_at = COALESCE(cancel_requested_at, ?),
             failure_disposition = NULL, failure_code = NULL,
             retry_after_at = NULL, updated_at = ?
       WHERE operation_id = ? AND state IN ('cleanup_pending', 'cleanup_blocked')
    `).run(nowIso, nowIso, operationId);
    if (canceledWrite.changes !== 1) throw new Error('SECRETARY_PREEMPTION_CANCEL_FINALIZE_MISSED');
    emitFeedbackRequest({
      agendaItemId: winnerId,
      agendaVersion: winnerVersion,
      ownerUserId,
      tenantId,
      sourceSkill: String(operation.winner_source_skill) as SourceSkill,
    }, db);
    return;
  }

  if (operation.prior_winner_agenda_item_id != null) {
    const priorWrite = db.prepare(`
      UPDATE secretary_agenda_items
         SET lifecycle_state = 'superseded', superseded_by_agenda_item_id = ?, updated_at = ?
       WHERE agenda_item_id = ? AND version = ?
         AND owner_user_id = ? AND tenant_id = ?
         AND lifecycle_state IN ('scheduled', 'synced', 'reflowed', 'compressed', 'failed_sync')
    `).run(
      winnerId,
      nowIso,
      operation.prior_winner_agenda_item_id,
      operation.prior_winner_agenda_version,
      ownerUserId,
      tenantId,
    );
    if (priorWrite.changes !== 1) throw new Error('SECRETARY_PREEMPTION_PRIOR_WINNER_STALE');
  }
  const winnerWrite = db.prepare(`
    UPDATE secretary_agenda_items
       SET lifecycle_state = ?, updated_at = ?
     WHERE agenda_item_id = ? AND version = ?
       AND owner_user_id = ? AND tenant_id = ?
       AND lifecycle_state = 'proposed' AND provider_sync_state = 'not_synced'
       AND provider_event_id IS NULL AND provider_source IS NULL
  `).run(
    operation.winner_final_lifecycle_state,
    nowIso,
    winnerId,
    winnerVersion,
    ownerUserId,
    tenantId,
  );
  if (winnerWrite.changes !== 1) throw new Error('SECRETARY_PREEMPTION_WINNER_STALE');
  const readyWrite = db.prepare(`
    UPDATE secretary_agenda_preemption_operations
       SET state = 'winner_ready', failure_disposition = NULL, failure_code = NULL,
           retry_after_at = NULL, updated_at = ?
     WHERE operation_id = ? AND state IN ('cleanup_pending', 'cleanup_blocked')
  `).run(nowIso, operationId);
  if (readyWrite.changes !== 1) throw new Error('SECRETARY_PREEMPTION_WINNER_READY_MISSED');
  // Event policy: winner_ready only grants provider eligibility. Winner
  // feedback is deliberately delayed until provider success, safe
  // cancellation, or explicit expiry, so source skills never refresh from a
  // merely reserved row that may still fail externally.
}

function emitFeedbackRequest(input: {
  agendaItemId: string;
  agendaVersion: number;
  ownerUserId: number;
  tenantId: string;
  sourceSkill: SourceSkill;
}, db: Database.Database): void {
  if (input.sourceSkill === 'secretary') return;
  if (input.sourceSkill === 'training') {
    emitDomainEvent({
      tenantId: input.ownerUserId,
      userId: input.ownerUserId,
      sourceSkill: 'secretary',
      eventType: TRAINING_SECRETARY_FEEDBACK_EVENT_TYPE,
      entityType: 'secretary_agenda_item',
      entityId: input.agendaItemId,
      entityVersion: input.agendaVersion,
      schemaVersion: TRAINING_SECRETARY_FEEDBACK_SCHEMA_VERSION,
      payload: { agendaTenantId: input.tenantId },
      privacyClassification: 'health',
      idempotencyKey: `secretary.training_feedback.requested:${input.agendaItemId}:${input.agendaVersion}`,
    }, db);
    return;
  }
  emitDomainEvent({
    tenantId: input.ownerUserId,
    userId: input.ownerUserId,
    sourceSkill: 'secretary',
    eventType: SECRETARY_SOURCE_SKILL_FEEDBACK_EVENT_TYPE,
    entityType: 'secretary_agenda_item',
    entityId: input.agendaItemId,
    entityVersion: input.agendaVersion,
    eventVersion: SECRETARY_SOURCE_SKILL_FEEDBACK_EVENT_VERSION,
    schemaVersion: SECRETARY_SOURCE_SKILL_FEEDBACK_SCHEMA_VERSION,
    payload: { agendaTenantId: input.tenantId },
    privacyClassification: input.sourceSkill === 'finance'
      ? 'financial'
      : input.sourceSkill === 'content'
        ? 'private_content'
        : 'internal',
    idempotencyKey: `secretary.source_feedback.requested:${input.agendaItemId}:${input.agendaVersion}`,
  }, db);
}

function markDependencyFailure(
  claim: DependencyClaim,
  disposition: FailureDisposition,
  failureCode: string,
  retryAfterAt: string | null,
  db: Database.Database,
): void {
  const persist = db.transaction(() => {
    const now = new Date();
    const nowIso = now.toISOString();
    if (disposition === 'terminal') {
      terminalizePreemptionOperation(claim, failureCode, now, db);
      return;
    }
    const write = db.prepare(`
      UPDATE secretary_agenda_preemption_dependencies
         SET state = ?, lease_token = NULL, lease_expires_at = NULL,
             heartbeat_at = NULL, failure_disposition = ?, failure_code = ?,
             retry_after_at = ?, last_checked_at = ?, updated_at = ?
       WHERE dependency_id = ? AND operation_id = ?
         AND state = 'in_progress' AND lease_token = ?
         AND datetime(lease_expires_at) > datetime(?)
    `).run(
      disposition,
      disposition,
      failureCode,
      disposition === 'retryable' ? retryAfterAt : null,
      nowIso,
      nowIso,
      claim.dependencyId,
      claim.operationId,
      claim.leaseToken,
      nowIso,
    );
    if (write.changes !== 1) throw dependencyLeaseLostError();
    const operationWrite = db.prepare(`
      UPDATE secretary_agenda_preemption_operations
         SET state = ?, failure_disposition = ?, failure_code = ?,
             retry_after_at = ?, updated_at = ?
       WHERE operation_id = ? AND state = 'cleanup_pending'
    `).run(
      'cleanup_blocked',
      disposition,
      failureCode,
      disposition === 'retryable' ? retryAfterAt : null,
      nowIso,
      claim.operationId,
    );
    if (operationWrite.changes !== 1) throw dependencyLeaseLostError();
  });
  persist.immediate();
}

function terminalizePreemptionOperation(
  claim: DependencyClaim,
  failureCode: string,
  now: Date,
  db: Database.Database,
): void {
  const nowIso = now.toISOString();
  const winner = db.prepare(`
    SELECT winner_agenda_item_id AS agendaItemId,
           winner_agenda_version AS agendaVersion,
           winner_source_skill AS sourceSkill
      FROM secretary_agenda_preemption_operations
     WHERE operation_id = ? AND owner_user_id = ? AND tenant_id = ?
       AND state = 'cleanup_pending'
  `).get(
    claim.operationId,
    claim.ownerUserId,
    claim.tenantId,
  ) as {
    agendaItemId: string;
    agendaVersion: number;
    sourceSkill: SourceSkill;
  } | undefined;
  if (!winner) throw dependencyLeaseLostError();

  const dependencies = db.prepare(`
    SELECT dependency_id AS dependencyId, state, lease_token AS leaseToken,
           CASE
             WHEN state = 'in_progress'
              AND datetime(lease_expires_at) > datetime(?) THEN 1
             ELSE 0
           END AS leaseActive,
           loser_replacement_agenda_item_id AS replacementAgendaItemId,
           loser_replacement_version AS replacementVersion,
           loser_source_skill AS sourceSkill,
           loser_source_intent_id AS sourceIntentId
      FROM secretary_agenda_preemption_dependencies
     WHERE operation_id = ? AND owner_user_id = ? AND tenant_id = ?
     ORDER BY datetime(created_at), dependency_id
  `).all(
    nowIso,
    claim.operationId,
    claim.ownerUserId,
    claim.tenantId,
  ) as TerminalDependencyRow[];
  const claimedDependency = dependencies.find((dependency) => (
    dependency.dependencyId === claim.dependencyId
  ));
  if (!claimedDependency
      || claimedDependency.state !== 'in_progress'
      || claimedDependency.leaseToken !== claim.leaseToken
      || claimedDependency.leaseActive !== 1) {
    throw dependencyLeaseLostError();
  }
  if (dependencies.some((dependency) => (
    dependency.dependencyId !== claim.dependencyId
    && dependency.state === 'in_progress'
    && dependency.leaseActive === 1
  ))) {
    throw new Error('SECRETARY_PREEMPTION_SIBLING_DEPENDENCY_LEASE_ACTIVE');
  }

  const terminalDependencies = dependencies.filter((dependency) => dependency.state !== 'satisfied');
  for (const dependency of terminalDependencies) {
    if (dependency.state === 'terminal') continue;
    let leaseToken = dependency.leaseToken;
    if (dependency.dependencyId !== claim.dependencyId) {
      leaseToken = randomUUID();
      const leaseExpiresAt = new Date(now.getTime() + claim.leaseDurationMs).toISOString();
      const claimWrite = db.prepare(`
        UPDATE secretary_agenda_preemption_dependencies
           SET state = 'in_progress', lease_token = ?, lease_expires_at = ?,
               heartbeat_at = ?, attempt_count = attempt_count + 1,
               failure_disposition = NULL, failure_code = NULL,
               retry_after_at = NULL, last_checked_at = ?, updated_at = ?
         WHERE dependency_id = ? AND operation_id = ?
           AND owner_user_id = ? AND tenant_id = ?
           AND (
             state IN ('pending', 'retryable', 'reconcile')
             OR (state = 'in_progress' AND datetime(lease_expires_at) <= datetime(?))
           )
      `).run(
        leaseToken,
        leaseExpiresAt,
        nowIso,
        nowIso,
        nowIso,
        dependency.dependencyId,
        claim.operationId,
        claim.ownerUserId,
        claim.tenantId,
        nowIso,
      );
      if (claimWrite.changes !== 1) throw dependencyLeaseLostError();
    }
    const dependencyWrite = db.prepare(`
      UPDATE secretary_agenda_preemption_dependencies
         SET state = 'terminal', lease_token = NULL, lease_expires_at = NULL,
             heartbeat_at = NULL, failure_disposition = 'terminal', failure_code = ?,
             retry_after_at = NULL, last_checked_at = ?, updated_at = ?
       WHERE dependency_id = ? AND operation_id = ?
         AND owner_user_id = ? AND tenant_id = ?
         AND state = 'in_progress' AND lease_token = ?
         AND datetime(lease_expires_at) > datetime(?)
    `).run(
      failureCode,
      nowIso,
      nowIso,
      dependency.dependencyId,
      claim.operationId,
      claim.ownerUserId,
      claim.tenantId,
      leaseToken,
      nowIso,
    );
    if (dependencyWrite.changes !== 1) throw dependencyLeaseLostError();
  }

  for (const dependency of terminalDependencies) {
    const replacementWrite = db.prepare(`
      UPDATE secretary_agenda_items
         SET lifecycle_state = 'unscheduled', provider_sync_state = 'deleted',
             decision_action = 'unscheduled',
             decision_reason_codes_json = '["priority_preemption_dependency_terminal_failure"]',
             decision_explanation = 'The original calendar event remains authoritative because exact cleanup failed.',
             cancellation_reason = 'priority_preemption_dependency_terminal_failure',
             updated_at = ?
       WHERE agenda_item_id = ? AND version = ?
         AND owner_user_id = ? AND tenant_id = ?
         AND source_skill = ? AND source_intent_id = ?
         AND lifecycle_state = 'proposed' AND provider_sync_state = 'not_synced'
         AND provider_event_id IS NULL AND provider_source IS NULL
    `).run(
      nowIso,
      dependency.replacementAgendaItemId,
      dependency.replacementVersion,
      claim.ownerUserId,
      claim.tenantId,
      dependency.sourceSkill,
      dependency.sourceIntentId,
    );
    if (replacementWrite.changes !== 1 && !hasTerminalReplacementTruth(
      dependency,
      claim.ownerUserId,
      claim.tenantId,
      db,
    )) {
      throw new Error('SECRETARY_PREEMPTION_TERMINAL_REPLACEMENT_TRUTH_MISSED');
    }
    emitFeedbackRequest({
      agendaItemId: dependency.replacementAgendaItemId,
      agendaVersion: dependency.replacementVersion,
      ownerUserId: claim.ownerUserId,
      tenantId: claim.tenantId,
      sourceSkill: dependency.sourceSkill,
    }, db);
  }

  const winnerWrite = db.prepare(`
    UPDATE secretary_agenda_items
       SET lifecycle_state = 'unscheduled',
           decision_action = 'unscheduled',
           decision_reason_codes_json = '["priority_preemption_dependency_terminal_failure"]',
           decision_explanation = 'The exact provider cleanup required for this placement failed permanently.',
           cancellation_reason = 'priority_preemption_dependency_terminal_failure',
           updated_at = ?
     WHERE agenda_item_id = ? AND version = ?
       AND owner_user_id = ? AND tenant_id = ?
       AND lifecycle_state = 'proposed' AND provider_sync_state = 'not_synced'
       AND provider_event_id IS NULL AND provider_source IS NULL
  `).run(
    nowIso,
    winner.agendaItemId,
    winner.agendaVersion,
    claim.ownerUserId,
    claim.tenantId,
  );
  if (winnerWrite.changes !== 1) {
    throw new Error('SECRETARY_PREEMPTION_TERMINAL_WINNER_TRUTH_MISSED');
  }
  emitFeedbackRequest({
    agendaItemId: winner.agendaItemId,
    agendaVersion: winner.agendaVersion,
    ownerUserId: claim.ownerUserId,
    tenantId: claim.tenantId,
    sourceSkill: winner.sourceSkill,
  }, db);

  const operationWrite = db.prepare(`
    UPDATE secretary_agenda_preemption_operations
       SET state = 'terminal_failure', failure_disposition = 'terminal', failure_code = ?,
           retry_after_at = NULL, updated_at = ?
     WHERE operation_id = ? AND owner_user_id = ? AND tenant_id = ?
       AND state = 'cleanup_pending'
  `).run(
    failureCode,
    nowIso,
    claim.operationId,
    claim.ownerUserId,
    claim.tenantId,
  );
  if (operationWrite.changes !== 1) throw dependencyLeaseLostError();
}

function hasTerminalReplacementTruth(
  dependency: TerminalDependencyRow,
  ownerUserId: number,
  tenantId: string,
  db: Database.Database,
): boolean {
  return Boolean(db.prepare(`
    SELECT 1
      FROM secretary_agenda_items
     WHERE agenda_item_id = ? AND version = ?
       AND owner_user_id = ? AND tenant_id = ?
       AND source_skill = ? AND source_intent_id = ?
       AND lifecycle_state = 'unscheduled' AND provider_sync_state = 'deleted'
       AND decision_action = 'unscheduled'
       AND decision_reason_codes_json = '["priority_preemption_dependency_terminal_failure"]'
       AND cancellation_reason = 'priority_preemption_dependency_terminal_failure'
       AND provider_event_id IS NULL AND provider_source IS NULL
  `).get(
    dependency.replacementAgendaItemId,
    dependency.replacementVersion,
    ownerUserId,
    tenantId,
    dependency.sourceSkill,
    dependency.sourceIntentId,
  ));
}

function startDependencyHeartbeat(
  claim: DependencyClaim,
  configuredMs: number | undefined,
  db: Database.Database,
): () => void {
  const intervalMs = normalizeHeartbeatMs(configuredMs, claim.leaseDurationMs);
  const timer = setInterval(() => {
    try {
      const now = new Date();
      const nowIso = now.toISOString();
      const renewed = db.prepare(`
        UPDATE secretary_agenda_preemption_dependencies
           SET lease_expires_at = ?, heartbeat_at = ?, updated_at = ?
         WHERE dependency_id = ? AND state = 'in_progress' AND lease_token = ?
           AND datetime(lease_expires_at) > datetime(?)
      `).run(
        new Date(now.getTime() + claim.leaseDurationMs).toISOString(),
        nowIso,
        nowIso,
        claim.dependencyId,
        claim.leaseToken,
        nowIso,
      );
      if (renewed.changes !== 1) claim.lost = true;
    } catch {
      claim.lost = true;
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

function assertDependencyClaimActive(claim: DependencyClaim, db: Database.Database): void {
  if (claim.lost) throw dependencyLeaseLostError();
  const row = db.prepare(`
    SELECT 1 FROM secretary_agenda_preemption_dependencies
     WHERE dependency_id = ? AND operation_id = ?
       AND state = 'in_progress' AND lease_token = ?
       AND datetime(lease_expires_at) > datetime(?)
  `).get(claim.dependencyId, claim.operationId, claim.leaseToken, new Date().toISOString());
  if (!row) {
    claim.lost = true;
    throw dependencyLeaseLostError();
  }
}

function classifyDeleteFailure(error: unknown): FailureDisposition {
  if (error instanceof TrainingOperationDisabledError) return 'retryable';
  const code = String((error as { code?: unknown } | null)?.code ?? '').toUpperCase();
  const status = Number(
    (error as { response?: { status?: unknown }; status?: unknown; statusCode?: unknown } | null)?.response?.status
    ?? (error as { status?: unknown } | null)?.status
    ?? (error as { statusCode?: unknown } | null)?.statusCode,
  );
  if (code === 'RATE_LIMITED' || status === 429) return 'retryable';
  if (status === 425) return 'retryable';
  if ([400, 401, 403, 405, 422].includes(status)) return 'terminal';
  // A delete may already have crossed the provider boundary. Unknown
  // transport failures require exact readback before any second delete.
  return 'reconcile';
}

function deleteFailureCode(error: unknown): string {
  if (error instanceof TrainingOperationDisabledError) return 'TRAINING_CALENDAR_WRITES_DISABLED';
  const code = String((error as { code?: unknown } | null)?.code ?? '').trim();
  if (code) return `DELETE_${code.toUpperCase()}`.slice(0, 120);
  const status = Number((error as { status?: unknown; statusCode?: unknown } | null)?.statusCode
    ?? (error as { status?: unknown } | null)?.status);
  return Number.isFinite(status) ? `DELETE_HTTP_${status}` : 'DELETE_PROVIDER_ERROR';
}

function retryDelayMs(attemptCount: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * (2 ** Math.max(0, Math.min(6, attemptCount - 1))));
}

function satisfiedResult(claim: DependencyClaim): SecretaryAgendaProviderSyncResult {
  return {
    agendaItemId: claim.loserAgendaItemId,
    action: 'deleted',
    providerEventId: null,
    providerSource: claim.loserProviderSource,
    providerSyncState: 'deleted',
    deletedDuplicateEventIds: [],
    reasonCode: 'priority_preemption_dependency_satisfied',
  };
}

function failedResult(claim: DependencyClaim, reasonCode: string): SecretaryAgendaProviderSyncResult {
  return {
    agendaItemId: claim.loserAgendaItemId,
    action: 'failed',
    providerEventId: claim.loserProviderEventId,
    providerSource: claim.loserProviderSource,
    providerSyncState: 'synced',
    deletedDuplicateEventIds: [],
    reasonCode,
  };
}

function normalizeLeaseMs(value: number | undefined): number {
  if (value == null || !Number.isFinite(value)) return DEFAULT_EDGE_LEASE_MS;
  return Math.max(100, Math.min(60 * 60_000, Math.floor(value)));
}

function normalizeHeartbeatMs(value: number | undefined, leaseMs: number): number {
  const fallback = Math.min(DEFAULT_EDGE_HEARTBEAT_MS, Math.max(25, Math.floor(leaseMs / 3)));
  if (value == null || !Number.isFinite(value)) return fallback;
  return Math.max(25, Math.min(Math.max(25, leaseMs - 25), Math.floor(value)));
}

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function dependencyLeaseLostError(): Error {
  return Object.assign(new Error('SECRETARY_PREEMPTION_DEPENDENCY_LEASE_LOST'), {
    code: 'SECRETARY_PREEMPTION_DEPENDENCY_LEASE_LOST',
  });
}

function isDependencyLeaseLost(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'SECRETARY_PREEMPTION_DEPENDENCY_LEASE_LOST';
}
