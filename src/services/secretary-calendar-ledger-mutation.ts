// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHash } from 'node:crypto';
import { getDb } from './database';
import {
  cancelSecretaryAgendaItem,
  emitSecretaryAgendaMutationFeedback,
  getSecretaryAgendaItemById,
  markSecretaryAgendaProviderCleanupRequired,
  markSecretaryAgendaProviderSyncSatisfied,
  type SecretaryAgendaItem,
} from './secretary-scheduling-arbitrator';
import type { CalendarSource } from './unified-calendar';

export class SecretaryCalendarLedgerMutationError extends Error {
  constructor(
    readonly code:
      | 'AMBIGUOUS_MAPPING'
      | 'MUTATION_BUSY'
      | 'TITLE_NOT_OWNED'
      | 'DESCRIPTION_NOT_OWNED'
      | 'MAPPING_STALE',
    message: string,
  ) {
    super(message);
    this.name = 'SecretaryCalendarLedgerMutationError';
  }
}

export interface SecretaryCalendarLedgerMutationTarget {
  agendaItem: SecretaryAgendaItem;
}

export function findSecretaryCalendarLedgerMutationTarget(scope: {
  ownerUserId: number;
  tenantId: string | number;
  providerSource: CalendarSource;
  providerEventId: string;
}): SecretaryCalendarLedgerMutationTarget | null {
  const rows = getDb().prepare(`
    SELECT agenda_item_id
      FROM secretary_agenda_items
     WHERE owner_user_id = ?
       AND tenant_id = ?
       AND provider_source = ?
       AND provider_event_id = ?
     ORDER BY version DESC, agenda_item_id ASC
  `).all(
    scope.ownerUserId,
    String(scope.tenantId),
    scope.providerSource,
    scope.providerEventId,
  ) as Array<{ agenda_item_id: string }>;
  if (rows.length === 0) return null;
  if (rows.length !== 1) {
    throw new SecretaryCalendarLedgerMutationError(
      'AMBIGUOUS_MAPPING',
      'More than one Secretary agenda row owns this provider event.',
    );
  }
  const agendaItem = getSecretaryAgendaItemById({
    agendaItemId: rows[0].agenda_item_id,
    ownerUserId: scope.ownerUserId,
    tenantId: scope.tenantId,
  });
  if (!agendaItem) {
    throw new SecretaryCalendarLedgerMutationError('MAPPING_STALE', 'The Secretary agenda mapping changed.');
  }
  return { agendaItem };
}

export function stageSecretaryCalendarLedgerUpdate(input: {
  target: SecretaryCalendarLedgerMutationTarget;
  ownerUserId: number;
  tenantId: string | number;
  providerSource: CalendarSource;
  providerEventId: string;
  requestHash: string;
  title: string;
  start: string;
  end: string;
  description?: string;
  nowIso: string;
}): { agendaItem: SecretaryAgendaItem; changed: boolean } {
  const db = getDb();
  const tenantId = String(input.tenantId);
  const staged = db.transaction(() => {
    const current = exactTarget(input.target.agendaItem.agendaItemId, input.ownerUserId, tenantId);
    assertMapping(current, input.providerSource, input.providerEventId);
    assertMutationIdle(current, input.nowIso);
    if (['canceled', 'superseded', 'completed'].includes(current.lifecycleState)) {
      throw new SecretaryCalendarLedgerMutationError(
        'MAPPING_STALE',
        'The mapped Secretary agenda item is no longer active.',
      );
    }

    const titleChanged = current.title.trim() !== input.title.trim();
    if (titleChanged && current.sourceSkill !== 'secretary') {
      throw new SecretaryCalendarLedgerMutationError(
        'TITLE_NOT_OWNED',
        `The ${current.sourceSkill} skill owns this event title. Secretary may move its placement but cannot change its shape.`,
      );
    }
    const startChanged = Date.parse(current.startAt ?? '') !== Date.parse(input.start);
    const endChanged = Date.parse(current.endAt ?? '') !== Date.parse(input.end);
    const descriptionChanged = stageOwnedDescription({
      agendaItem: current,
      description: input.description,
      nowIso: input.nowIso,
    });
    const changed = titleChanged || startChanged || endChanged || descriptionChanged;
    if (!changed) return { agendaItem: current, changed: false };

    const durationMinutes = Math.max(1, Math.round((Date.parse(input.end) - Date.parse(input.start)) / 60_000));
    const sourceShapeHash = createHash('sha256')
      .update(`calendar-mutation:${current.agendaItemId}:${input.requestHash}`)
      .digest('hex')
      .slice(0, 32);
    const lifecycleState = startChanged || endChanged
      ? 'reflowed'
      : current.lifecycleState === 'failed_sync'
        ? 'scheduled'
        : current.lifecycleState;
    const write = db.prepare(`
      UPDATE secretary_agenda_items
         SET title = ?,
             start_at = ?,
             end_at = ?,
             duration_minutes = ?,
             lifecycle_state = ?,
             decision_action = CASE WHEN ? = 1 THEN 'reflowed' ELSE decision_action END,
             decision_reason_codes_json = CASE
               WHEN ? = 1 THEN '["reflowed_to_available_window"]'
               ELSE decision_reason_codes_json
             END,
             decision_explanation = CASE
               WHEN ? = 1 THEN 'User-confirmed calendar placement.'
               ELSE decision_explanation
             END,
             provider_sync_state = 'not_synced',
             provider_sync_failure_disposition = NULL,
             provider_sync_retry_after_at = NULL,
             source_shape_hash = ?,
             scheduled_segments_json = ?,
             last_synced_fingerprint = NULL,
             last_synced_verified_at = NULL,
             updated_at = ?
       WHERE agenda_item_id = ?
         AND owner_user_id = ?
         AND tenant_id = ?
         AND provider_source = ?
         AND provider_event_id = ?
    `).run(
      input.title.trim(),
      input.start,
      input.end,
      durationMinutes,
      lifecycleState,
      startChanged || endChanged ? 1 : 0,
      startChanged || endChanged ? 1 : 0,
      startChanged || endChanged ? 1 : 0,
      sourceShapeHash,
      JSON.stringify([{ start: input.start, end: input.end }]),
      input.nowIso,
      current.agendaItemId,
      input.ownerUserId,
      tenantId,
      input.providerSource,
      input.providerEventId,
    );
    if (write.changes !== 1) {
      throw new SecretaryCalendarLedgerMutationError('MAPPING_STALE', 'The Secretary agenda mapping changed.');
    }
    const agendaItem = exactTarget(current.agendaItemId, input.ownerUserId, tenantId);
    return { agendaItem, changed: true };
  })();
  return staged;
}

export function stageSecretaryCalendarLedgerDelete(input: {
  target: SecretaryCalendarLedgerMutationTarget;
  ownerUserId: number;
  tenantId: string | number;
  providerSource: CalendarSource;
  providerEventId: string;
  nowIso: string;
}): { agendaItem: SecretaryAgendaItem; changed: boolean } {
  const db = getDb();
  return db.transaction(() => {
    const current = exactTarget(
      input.target.agendaItem.agendaItemId,
      input.ownerUserId,
      String(input.tenantId),
    );
    assertMapping(current, input.providerSource, input.providerEventId);
    assertMutationIdle(current, input.nowIso);
    const changed = current.lifecycleState !== 'canceled' || current.cancellationReason == null;
    const agendaItem = cancelSecretaryAgendaItem({
      agendaItemId: current.agendaItemId,
      ownerUserId: input.ownerUserId,
      tenantId: input.tenantId,
      reason: 'user_confirmed_calendar_delete',
      now: input.nowIso,
    });
    if (!agendaItem) {
      throw new SecretaryCalendarLedgerMutationError('MAPPING_STALE', 'The Secretary agenda mapping changed.');
    }
    const withDecision = agendaItem.sourceSkill === 'secretary'
      ? agendaItem
      : updateCanceledSourceDecision(agendaItem, input.nowIso);
    return { agendaItem: withDecision, changed };
  })();
}

export function settleSecretaryCalendarLedgerUpdate(input: {
  agendaItemId: string;
  ownerUserId: number;
  tenantId: string | number;
  providerSource: CalendarSource;
  providerEventId: string;
  feedbackKey: string;
  nowIso: string;
}): SecretaryAgendaItem {
  const agendaItem = markSecretaryAgendaProviderSyncSatisfied({
    agendaItemId: input.agendaItemId,
    ownerUserId: input.ownerUserId,
    tenantId: input.tenantId,
    providerSource: input.providerSource,
    providerEventId: input.providerEventId,
    now: input.nowIso,
  });
  if (!agendaItem) {
    throw new SecretaryCalendarLedgerMutationError('MAPPING_STALE', 'The Secretary agenda mapping changed.');
  }
  emitSecretaryAgendaMutationFeedback({
    agendaItemId: agendaItem.agendaItemId,
    ownerUserId: agendaItem.ownerUserId,
    tenantId: agendaItem.tenantId,
    idempotencySuffix: input.feedbackKey,
  });
  return agendaItem;
}

export function settleSecretaryCalendarLedgerDelete(input: {
  agendaItemId: string;
  ownerUserId: number;
  tenantId: string | number;
  providerSource: CalendarSource;
  providerEventId: string;
  feedbackKey: string;
  nowIso: string;
}): SecretaryAgendaItem {
  const agendaItem = markSecretaryAgendaProviderCleanupRequired({
    agendaItemId: input.agendaItemId,
    ownerUserId: input.ownerUserId,
    tenantId: input.tenantId,
    providerSource: input.providerSource,
    providerEventId: input.providerEventId,
    providerSyncState: 'deleted',
    lifecycleState: 'canceled',
    reason: 'user_confirmed_calendar_delete',
    clearProviderMapping: true,
    now: input.nowIso,
  });
  if (!agendaItem) {
    throw new SecretaryCalendarLedgerMutationError('MAPPING_STALE', 'The Secretary agenda mapping changed.');
  }
  emitSecretaryAgendaMutationFeedback({
    agendaItemId: agendaItem.agendaItemId,
    ownerUserId: agendaItem.ownerUserId,
    tenantId: agendaItem.tenantId,
    idempotencySuffix: input.feedbackKey,
  });
  return agendaItem;
}

function updateCanceledSourceDecision(
  agendaItem: SecretaryAgendaItem,
  nowIso: string,
): SecretaryAgendaItem {
  const write = getDb().prepare(`
    UPDATE secretary_agenda_items
       SET decision_action = 'unscheduled',
           decision_reason_codes_json = '["removed_from_calendar_by_user"]',
           decision_explanation = 'User-confirmed removal from the provider calendar.',
           updated_at = ?
     WHERE agenda_item_id = ?
       AND owner_user_id = ?
       AND tenant_id = ?
       AND lifecycle_state = 'canceled'
  `).run(nowIso, agendaItem.agendaItemId, agendaItem.ownerUserId, agendaItem.tenantId);
  if (write.changes !== 1) {
    throw new SecretaryCalendarLedgerMutationError('MAPPING_STALE', 'The Secretary agenda mapping changed.');
  }
  return exactTarget(agendaItem.agendaItemId, agendaItem.ownerUserId, agendaItem.tenantId);
}

function exactTarget(agendaItemId: string, ownerUserId: number, tenantId: string): SecretaryAgendaItem {
  const item = getSecretaryAgendaItemById({ agendaItemId, ownerUserId, tenantId });
  if (!item) throw new SecretaryCalendarLedgerMutationError('MAPPING_STALE', 'The Secretary agenda mapping changed.');
  return item;
}

function assertMapping(
  agendaItem: SecretaryAgendaItem,
  providerSource: CalendarSource,
  providerEventId: string,
): void {
  if (agendaItem.providerSource !== providerSource || agendaItem.providerEventId !== providerEventId) {
    throw new SecretaryCalendarLedgerMutationError('MAPPING_STALE', 'The Secretary agenda mapping changed.');
  }
}

function assertMutationIdle(agendaItem: SecretaryAgendaItem, nowIso: string): void {
  const db = getDb();
  const busyChecks: Array<{ table: string; sql: string; args: unknown[] }> = [
    {
      table: 'secretary_agenda_provider_sync_claims',
      sql: `SELECT 1 FROM secretary_agenda_provider_sync_claims
             WHERE owner_user_id = ? AND tenant_id = ? AND agenda_item_id = ? AND agenda_version = ?
               AND datetime(lease_expires_at) > datetime(?) LIMIT 1`,
      args: [agendaItem.ownerUserId, agendaItem.tenantId, agendaItem.agendaItemId, agendaItem.version, nowIso],
    },
    {
      table: 'secretary_agenda_provider_effect_recovery',
      sql: `SELECT 1 FROM secretary_agenda_provider_effect_recovery
             WHERE owner_user_id = ? AND tenant_id = ? AND agenda_item_id = ? AND agenda_version = ?
               AND resolution_state = 'pending' LIMIT 1`,
      args: [agendaItem.ownerUserId, agendaItem.tenantId, agendaItem.agendaItemId, agendaItem.version],
    },
    {
      table: 'secretary_agenda_provider_create_reconciliation',
      sql: `SELECT 1 FROM secretary_agenda_provider_create_reconciliation
             WHERE owner_user_id = ? AND tenant_id = ? AND agenda_item_id = ? AND agenda_version = ?
               AND resolution_state IN ('in_flight', 'unknown', 'known') LIMIT 1`,
      args: [agendaItem.ownerUserId, agendaItem.tenantId, agendaItem.agendaItemId, agendaItem.version],
    },
  ];
  for (const check of busyChecks) {
    if (tableExists(check.table) && db.prepare(check.sql).get(...check.args)) {
      throw new SecretaryCalendarLedgerMutationError(
        'MUTATION_BUSY',
        'The Secretary agenda item is already being reconciled.',
      );
    }
  }
  if (tableExists('secretary_agenda_preemption_operations')) {
    const operation = db.prepare(`
      SELECT 1 FROM secretary_agenda_preemption_operations
       WHERE owner_user_id = ? AND tenant_id = ?
         AND (winner_agenda_item_id = ? OR prior_winner_agenda_item_id = ?)
         AND state NOT IN ('completed', 'canceled')
       LIMIT 1
    `).get(
      agendaItem.ownerUserId,
      agendaItem.tenantId,
      agendaItem.agendaItemId,
      agendaItem.agendaItemId,
    );
    if (operation) {
      throw new SecretaryCalendarLedgerMutationError(
        'MUTATION_BUSY',
        'The Secretary agenda item is part of an unfinished reflow.',
      );
    }
  }
}

function stageOwnedDescription(input: {
  agendaItem: SecretaryAgendaItem;
  description?: string;
  nowIso: string;
}): boolean {
  if (input.description === undefined) return false;
  if (input.agendaItem.sourceSkill !== 'secretary') {
    throw new SecretaryCalendarLedgerMutationError(
      'DESCRIPTION_NOT_OWNED',
      'The source skill owns this event description.',
    );
  }
  const db = getDb();
  if (!tableExists('secretary_calendar_command_payloads')) {
    throw new SecretaryCalendarLedgerMutationError(
      'DESCRIPTION_NOT_OWNED',
      'This legacy agenda item has no durable Secretary description payload.',
    );
  }
  const row = db.prepare(`
    SELECT command_json
      FROM secretary_calendar_command_payloads
     WHERE agenda_item_id = ? AND user_id = ? AND tenant_id = ?
  `).get(
    input.agendaItem.agendaItemId,
    input.agendaItem.ownerUserId,
    input.agendaItem.tenantId,
  ) as { command_json: string } | undefined;
  if (!row) {
    throw new SecretaryCalendarLedgerMutationError(
      'DESCRIPTION_NOT_OWNED',
      'This legacy agenda item has no durable Secretary description payload.',
    );
  }
  const command = JSON.parse(row.command_json) as Record<string, unknown>;
  const prior = typeof command.description === 'string' ? command.description : '';
  if (prior.trim() === input.description.trim()) return false;
  command.description = input.description;
  const write = db.prepare(`
    UPDATE secretary_calendar_command_payloads
       SET command_json = ?, updated_at = ?
     WHERE agenda_item_id = ? AND user_id = ? AND tenant_id = ?
  `).run(
    JSON.stringify(command),
    input.nowIso,
    input.agendaItem.agendaItemId,
    input.agendaItem.ownerUserId,
    input.agendaItem.tenantId,
  );
  if (write.changes !== 1) {
    throw new SecretaryCalendarLedgerMutationError('MAPPING_STALE', 'The Secretary command payload changed.');
  }
  return true;
}

function tableExists(tableName: string): boolean {
  return Boolean(getDb().prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1
  `).get(tableName));
}
