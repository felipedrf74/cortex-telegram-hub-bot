// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { getDb } from './database';
import * as trainingPlans from './training-plans';
import {
  markCalendarOwnershipDeleted,
  recordCalendarOwnership,
  type RecordCalendarOwnershipResult,
} from './training-plan-lifecycle';
import { markSecretaryAgendaProviderCleanupRequired } from './secretary-scheduling-arbitrator';

/**
 * Commit the local half of an already-durable Secretary provider mapping.
 * Session linkage/state and exact ownership either become visible together or
 * roll back together; callers must never report success from a partial write.
 */
export function commitTrainingCalendarSessionMapping(input: {
  sessionId: number;
  eventId: string;
  source: 'google' | 'outlook';
  sessionPatch?: Parameters<typeof trainingPlans.updateSession>[1];
  ownership: Parameters<typeof recordCalendarOwnership>[0];
}): RecordCalendarOwnershipResult {
  if (input.ownership.sessionId !== input.sessionId
      || input.ownership.eventId !== input.eventId
      || input.ownership.source !== input.source) {
    throw new Error('TRAINING_CALENDAR_MAPPING_TUPLE_MISMATCH');
  }
  const db = getDb();
  return db.transaction(() => {
    const scope = db.prepare(`
      SELECT sessions.plan_id AS planId,
             sessions.tenant_id AS tenantId,
             plans.user_id AS userId
        FROM training_sessions AS sessions
        JOIN fitness_training_plans AS plans ON plans.id = sessions.plan_id
       WHERE sessions.id = ?
       LIMIT 1
    `).get(input.sessionId) as {
      planId: number;
      tenantId: number;
      userId: number;
    } | undefined;
    const sessionExistsWithoutScope = !scope && Boolean(db.prepare(`
      SELECT 1 FROM training_sessions WHERE id = ? LIMIT 1
    `).get(input.sessionId));
    if (sessionExistsWithoutScope) {
      throw new Error('TRAINING_CALENDAR_MAPPING_SCOPE_MISMATCH');
    }
    if (scope
        && (scope.planId !== input.ownership.planId
        || scope.tenantId !== input.ownership.tenantId
        || scope.userId !== input.ownership.userId)) {
      throw new Error('TRAINING_CALENDAR_MAPPING_SCOPE_MISMATCH');
    }
    const linked = trainingPlans.linkSessionToCalendar(input.sessionId, input.eventId, input.source);
    if (!linked) throw new Error('TRAINING_CALENDAR_SESSION_LINK_FAILED');
    if (input.sessionPatch && !trainingPlans.updateSession(input.sessionId, input.sessionPatch)) {
      throw new Error('TRAINING_CALENDAR_SESSION_STATE_UPDATE_FAILED');
    }
    const recorded = recordCalendarOwnership(input.ownership);
    if (!recorded.ok) throw new Error('TRAINING_CALENDAR_OWNERSHIP_RECORD_FAILED');
    const exactOwnership = recorded.ownershipId == null ? null : db.prepare(`
      SELECT session_id AS sessionId,
             tenant_id AS tenantId,
             user_id AS userId,
             calendar_event_id AS eventId,
             calendar_source AS source,
             status
        FROM training_agenda_event_ownership
       WHERE id = ?
       LIMIT 1
    `).get(recorded.ownershipId) as {
      sessionId: number | null;
      tenantId: number;
      userId: number;
      eventId: string;
      source: string;
      status: string;
    } | undefined;
    if (!exactOwnership
        || exactOwnership.sessionId !== input.sessionId
        || exactOwnership.tenantId !== input.ownership.tenantId
        || exactOwnership.userId !== input.ownership.userId
        || exactOwnership.eventId !== input.eventId
        || exactOwnership.source !== input.source
        || exactOwnership.status !== 'active') {
      throw new Error('TRAINING_CALENDAR_OWNERSHIP_EXACT_TUPLE_REQUIRED');
    }
    return recorded;
  })();
}

/**
 * Retire one exact provider mapping as a single local commit. A prior-version
 * reusable ownership may target a current session that is already unlinked;
 * every other link shape is a hard fence failure. When a Secretary deleted-id
 * tombstone is supplied, clearing it participates in the same transaction so
 * a crash cannot strand either half of the handoff.
 */
export function retireTrainingCalendarSessionMapping(input: {
  sessionId: number;
  eventId: string;
  source: 'google' | 'outlook';
  planId: number;
  tenantId: number;
  userId: number;
  ownershipId: number;
  reason: string;
  allowAlreadyUnlinked?: boolean;
  secretaryTombstone?: {
    agendaItemId: string;
    now?: string;
  };
}): { ownershipRowsAffected: 1; sessionUnlinked: boolean } {
  const db = getDb();
  return db.transaction(() => {
    const session = db.prepare(`
      SELECT sessions.plan_id AS planId,
             sessions.tenant_id AS tenantId,
             sessions.calendar_event_id AS eventId,
             sessions.calendar_source AS source,
             plans.user_id AS userId
        FROM training_sessions AS sessions
        JOIN fitness_training_plans AS plans ON plans.id = sessions.plan_id
       WHERE sessions.id = ?
       LIMIT 1
    `).get(input.sessionId) as {
      planId: number;
      tenantId: number;
      userId: number;
      eventId: string | null;
      source: string | null;
    } | undefined;
    if (!session
        || session.planId !== input.planId
        || session.tenantId !== input.tenantId
        || session.userId !== input.userId) {
      throw new Error('TRAINING_CALENDAR_RETIRE_SCOPE_MISMATCH');
    }

    const ownership = markCalendarOwnershipDeleted({
      eventId: input.eventId,
      source: input.source,
      reason: input.reason,
      tenantId: input.tenantId,
      userId: input.userId,
      planId: input.planId,
      ownershipId: input.ownershipId,
    });
    if (!ownership.ok || ownership.rowsAffected !== 1) {
      throw new Error('TRAINING_CALENDAR_OWNERSHIP_DELETE_FENCE_FAILED');
    }

    let sessionUnlinked = false;
    if (session.eventId === input.eventId && session.source === input.source) {
      const unlinked = db.prepare(`
        UPDATE training_sessions
           SET calendar_event_id = NULL, calendar_source = NULL, updated_at = datetime('now')
         WHERE id = ? AND plan_id = ? AND tenant_id = ?
           AND calendar_event_id = ? AND calendar_source = ?
      `).run(
        input.sessionId,
        input.planId,
        input.tenantId,
        input.eventId,
        input.source,
      );
      if (unlinked.changes !== 1) {
        throw new Error('TRAINING_CALENDAR_SESSION_UNLINK_FENCE_FAILED');
      }
      sessionUnlinked = true;
    } else if (!(input.allowAlreadyUnlinked && session.eventId == null && session.source == null)) {
      throw new Error('TRAINING_CALENDAR_SESSION_UNLINK_FENCE_FAILED');
    }

    if (input.secretaryTombstone) {
      const cleared = markSecretaryAgendaProviderCleanupRequired({
        agendaItemId: input.secretaryTombstone.agendaItemId,
        ownerUserId: input.userId,
        tenantId: input.tenantId,
        providerSyncState: 'deleted',
        lifecycleState: 'unscheduled',
        reason: input.reason,
        clearProviderMapping: true,
        now: input.secretaryTombstone.now,
      });
      if (!cleared
          || cleared.providerEventId !== null
          || cleared.providerSource !== null
          || cleared.providerSyncState !== 'deleted') {
        throw new Error('TRAINING_CALENDAR_SECRETARY_TOMBSTONE_CLEAR_FENCE_FAILED');
      }
    }
    return { ownershipRowsAffected: 1 as const, sessionUnlinked };
  })();
}
