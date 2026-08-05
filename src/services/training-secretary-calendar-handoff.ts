// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import {
  syncSecretaryAgendaItemsToProvider,
  type SecretaryAgendaProviderSyncResult,
  type SecretaryCalendarProviderSource,
} from './secretary-agenda-provider-sync';
import {
  getSecretaryAgendaItemById,
  listSecretaryAgendaItems,
  markSecretaryAgendaProviderCleanupRequired,
  type SecretaryAgendaItem,
} from './secretary-scheduling-arbitrator';
import { createUnifiedCalendarSecretaryProviderAdapter } from './secretary-unified-calendar-provider-adapter';

export type TrainingSecretaryCalendarHandoffOutcome =
  | 'ready'
  | 'cleanup_complete'
  | 'pending'
  | 'terminal';

export interface TrainingSecretaryCalendarHandoffResult {
  outcome: TrainingSecretaryCalendarHandoffOutcome;
  agendaItemId: string;
  providerEventId: string | null;
  providerSource: SecretaryCalendarProviderSource | null;
  startAt: string | null;
  endAt: string | null;
  reasonCode: string;
  retryable: boolean;
  agendaItem: SecretaryAgendaItem | null;
  syncResults: SecretaryAgendaProviderSyncResult[];
}

export async function cleanupTrainingSecretaryCalendarHandoff(input: {
  sourceIntentId: string;
  ownerUserId: number;
  tenantId: string | number;
  providerEventId: string;
  providerSource: SecretaryCalendarProviderSource;
  reason: string;
  nowIso?: string;
}): Promise<TrainingSecretaryCalendarHandoffResult> {
  const exactAgenda = listSecretaryAgendaItems({
    ownerUserId: input.ownerUserId,
    tenantId: input.tenantId,
    includeInactive: true,
  })
    .filter((item) => item.sourceSkill === 'training')
    .filter((item) => item.sourceIntentId === input.sourceIntentId)
    .filter((item) => item.providerEventId === input.providerEventId)
    .filter((item) => item.providerSource === input.providerSource)
    .sort((left, right) => right.version - left.version)[0] ?? null;
  if (!exactAgenda) {
    return {
      outcome: 'pending',
      agendaItemId: '',
      providerEventId: input.providerEventId,
      providerSource: input.providerSource,
      startAt: null,
      endAt: null,
      reasonCode: 'secretary_stale_provider_mapping_authority_missing',
      retryable: true,
      agendaItem: null,
      syncResults: [],
    };
  }
  if (
    exactAgenda.providerSyncState === 'deleted'
    && exactAgenda.providerEventId === input.providerEventId
    && exactAgenda.providerSource === input.providerSource
    && ['canceled', 'superseded', 'unscheduled', 'deferred'].includes(exactAgenda.lifecycleState)
  ) {
    return handoffResult(
      exactAgenda,
      [],
      'cleanup_complete',
      'secretary_provider_cleanup_tombstone_ready',
      false,
    );
  }
  markSecretaryAgendaProviderCleanupRequired({
    agendaItemId: exactAgenda.agendaItemId,
    ownerUserId: input.ownerUserId,
    tenantId: input.tenantId,
    providerEventId: input.providerEventId,
    providerSource: input.providerSource,
    providerSyncState: 'delete_failed',
    lifecycleState: 'superseded',
    reason: input.reason,
    clearProviderMapping: false,
    now: input.nowIso,
  });
  const cleanup = await syncTrainingSecretaryCalendarHandoff({
    agendaItemId: exactAgenda.agendaItemId,
    ownerUserId: input.ownerUserId,
    tenantId: input.tenantId,
    providerSource: input.providerSource,
  });
  if (cleanup.outcome !== 'cleanup_complete') return cleanup;
  const tombstone = markSecretaryAgendaProviderCleanupRequired({
    agendaItemId: exactAgenda.agendaItemId,
    ownerUserId: input.ownerUserId,
    tenantId: input.tenantId,
    providerEventId: input.providerEventId,
    providerSource: input.providerSource,
    providerSyncState: 'deleted',
    lifecycleState: 'superseded',
    reason: `${input.reason}_provider_deleted_local_pending`,
    clearProviderMapping: false,
    now: input.nowIso,
  });
  if (!tombstone
      || tombstone.providerEventId !== input.providerEventId
      || tombstone.providerSource !== input.providerSource
      || tombstone.providerSyncState !== 'deleted') {
    return handoffResult(
      tombstone,
      cleanup.syncResults,
      'terminal',
      'secretary_provider_cleanup_tombstone_fence_failed',
      false,
    );
  }
  return {
    ...cleanup,
    providerEventId: input.providerEventId,
    providerSource: input.providerSource,
    reasonCode: 'secretary_provider_cleanup_tombstone_ready',
    agendaItem: tombstone,
  };
}

/**
 * Cross the calendar-provider boundary for one exact Training-backed agenda
 * item through Secretary's durable dependency, claim, and recovery engine.
 *
 * Training callers may persist an intent and consume the resulting durable
 * mapping, but they must never perform a parallel provider write after this
 * handoff. `agendaItemId` keeps synchronous callers from draining unrelated
 * Secretary work while preserving the same fencing as the scheduled worker.
 */
export async function syncTrainingSecretaryCalendarHandoff(input: {
  agendaItemId: string;
  ownerUserId: number;
  tenantId: string | number;
  providerSource?: SecretaryCalendarProviderSource | null;
  maxProviderCalls?: number;
  /**
   * Read-only correlation evidence from the Training caller. Secretary still
   * rehydrates and authors the provider payload from its durable agenda row;
   * this projection is never provider authority.
   */
  trainingProjection?: {
    title: string;
    startAt: string;
    endAt: string;
    description?: string;
    existingProviderEventId?: string | null;
  };
}): Promise<TrainingSecretaryCalendarHandoffResult> {
  const scope = {
    agendaItemId: input.agendaItemId,
    ownerUserId: input.ownerUserId,
    tenantId: input.tenantId,
  };
  const before = getSecretaryAgendaItemById(scope);
  if (!before) {
    return handoffResult(null, [], 'terminal', 'secretary_agenda_item_missing', false);
  }

  const target = input.providerSource ?? before.providerTarget;
  if (!target) {
    return handoffResult(before, [], 'terminal', 'provider_target_not_pinned', false);
  }
  if (before.providerTarget !== target) {
    return handoffResult(before, [], 'terminal', 'provider_target_mismatch', false);
  }
  const projectedStart = input.trainingProjection?.startAt;
  const projectedEnd = input.trainingProjection?.endAt;
  if (
    projectedStart
    && projectedEnd
    && before.startAt
    && before.endAt
    && (Date.parse(before.startAt) !== Date.parse(projectedStart)
      || Date.parse(before.endAt) !== Date.parse(projectedEnd))
  ) {
    return handoffResult(
      before,
      [],
      'terminal',
      'secretary_provider_mapping_window_mismatch',
      false,
    );
  }
  const expectedExistingProviderEventId = input.trainingProjection?.existingProviderEventId ?? null;
  if (expectedExistingProviderEventId
      && (before.providerEventId !== expectedExistingProviderEventId
        || before.providerSource !== target)) {
    return handoffResult(
      before,
      [],
      'terminal',
      'secretary_existing_provider_identity_mismatch',
      false,
    );
  }

  // A preemption edge needs one exact read plus at most one delete. Values
  // below two would make a durable graph stall forever across retries.
  const totalCallBudget = Math.max(2, Math.min(50, Math.floor(input.maxProviderCalls ?? 50)));
  const syncResults: SecretaryAgendaProviderSyncResult[] = [];
  const adapter = createUnifiedCalendarSecretaryProviderAdapter(target);
  try {
    // `maxProviderCalls` is the TOTAL synchronous effect budget. A large
    // preemption graph therefore makes bounded progress and returns pending;
    // subsequent worker/invocation passes continue from durable edge state.
    syncResults.push(...await syncSecretaryAgendaItemsToProvider(
      {
        ownerUserId: input.ownerUserId,
        tenantId: input.tenantId,
        includeInactive: true,
      },
      adapter,
      {
        agendaItemId: input.agendaItemId,
        retryBudget: 0,
        maxItems: totalCallBudget,
      },
    ));
  } catch (error) {
    const afterFailure = getSecretaryAgendaItemById(scope) ?? before;
    if (afterFailure.providerSyncFailureDisposition === 'terminal') {
      return handoffResult(
        afterFailure,
        syncResults,
        'terminal',
        lastReasonCode(syncResults) ?? 'secretary_provider_sync_terminal_failure',
        false,
      );
    }
    return handoffResult(
      afterFailure,
      syncResults,
      'pending',
      error instanceof Error && error.message
        ? error.message
        : 'secretary_provider_sync_failed',
      true,
    );
  }

  const after = getSecretaryAgendaItemById(scope) ?? before;
  if (expectedExistingProviderEventId
      && after.providerEventId
      && after.providerEventId !== expectedExistingProviderEventId) {
    // Exact-id reflow/adoption may not silently fall back to a fresh create.
    // Hand the unexpected known id back to the same cleanup claim before
    // returning so a caller rejection cannot strand a second live event.
    markSecretaryAgendaProviderCleanupRequired({
      agendaItemId: after.agendaItemId,
      ownerUserId: after.ownerUserId,
      tenantId: after.tenantId,
      providerEventId: after.providerEventId,
      providerSource: target,
      providerSyncState: 'delete_failed',
      lifecycleState: 'unscheduled',
      reason: 'training_existing_provider_identity_changed',
      clearProviderMapping: false,
    });
    return handoffResult(
      after,
      syncResults,
      'pending',
      'secretary_existing_provider_identity_changed',
      true,
    );
  }
  if (
    projectedStart
    && projectedEnd
    && after.startAt
    && after.endAt
    && (Date.parse(after.startAt) !== Date.parse(projectedStart)
      || Date.parse(after.endAt) !== Date.parse(projectedEnd))
  ) {
    if (after.providerEventId && after.providerSource === target) {
      markSecretaryAgendaProviderCleanupRequired({
        agendaItemId: after.agendaItemId,
        ownerUserId: after.ownerUserId,
        tenantId: after.tenantId,
        providerEventId: after.providerEventId,
        providerSource: target,
        providerSyncState: 'delete_failed',
        lifecycleState: 'unscheduled',
        reason: 'training_provider_mapping_window_changed',
        clearProviderMapping: false,
      });
      return handoffResult(
        getSecretaryAgendaItemById(scope) ?? after,
        syncResults,
        'pending',
        'secretary_provider_mapping_window_changed',
        true,
      );
    }
    return handoffResult(
      after,
      syncResults,
      'terminal',
      'secretary_provider_mapping_window_mismatch',
      false,
    );
  }
  if (isReadyAgendaMapping(after, target)) {
    return handoffResult(
      after,
      syncResults,
      'ready',
      lastReasonCode(syncResults) ?? 'secretary_provider_mapping_ready',
      false,
    );
  }

  if (isCompletedAgendaCleanup(after)) {
    return handoffResult(
      after,
      syncResults,
      'cleanup_complete',
      lastReasonCode(syncResults) ?? 'secretary_provider_cleanup_complete',
      false,
    );
  }

  if (after.providerSyncFailureDisposition === 'terminal') {
    return handoffResult(
      after,
      syncResults,
      'terminal',
      lastReasonCode(syncResults) ?? 'secretary_provider_sync_terminal_failure',
      false,
    );
  }

  return handoffResult(
    after,
    syncResults,
    'pending',
    lastReasonCode(syncResults) ?? 'secretary_provider_sync_pending',
    true,
  );
}

function isReadyAgendaMapping(
  agendaItem: SecretaryAgendaItem,
  target: SecretaryCalendarProviderSource,
): boolean {
  return agendaItem.providerSyncState === 'synced'
    && Boolean(agendaItem.providerEventId)
    && agendaItem.providerSource === target
    && !agendaItem.cancellationReason
    && !['canceled', 'superseded', 'unscheduled', 'deferred', 'completed'].includes(agendaItem.lifecycleState);
}

function isCompletedAgendaCleanup(agendaItem: SecretaryAgendaItem): boolean {
  return ['canceled', 'superseded', 'unscheduled', 'deferred', 'completed'].includes(agendaItem.lifecycleState)
    && agendaItem.providerEventId == null
    && agendaItem.providerSyncState === 'deleted';
}

function lastReasonCode(results: SecretaryAgendaProviderSyncResult[]): string | null {
  return results.length > 0 ? results[results.length - 1].reasonCode : null;
}

function handoffResult(
  agendaItem: SecretaryAgendaItem | null,
  syncResults: SecretaryAgendaProviderSyncResult[],
  outcome: TrainingSecretaryCalendarHandoffOutcome,
  reasonCode: string,
  retryable: boolean,
): TrainingSecretaryCalendarHandoffResult {
  return {
    outcome,
    agendaItemId: agendaItem?.agendaItemId ?? '',
    providerEventId: agendaItem?.providerEventId ?? null,
    providerSource: agendaItem?.providerSource === 'google' || agendaItem?.providerSource === 'outlook'
      ? agendaItem.providerSource
      : null,
    startAt: agendaItem?.startAt ?? null,
    endAt: agendaItem?.endAt ?? null,
    reasonCode,
    retryable,
    agendaItem,
    syncResults,
  };
}
