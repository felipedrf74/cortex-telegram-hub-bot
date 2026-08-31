// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Remind the user before a training session starts.
 *
 * `notification_profiles.workout_reminder_minutes` has existed since the
 * orchestrator shipped: it is stored, patchable through the preferences API,
 * mapped into the API response — and read by nothing. The user sets a lead
 * time and no notification has ever used it. That makes it the
 * highest-confidence unmet promise in the schema.
 *
 * Start times come from `secretary_agenda_items` rather than
 * `training_sessions`, because the sessions table has no timestamp — only
 * `day_of_week` and a calendar event id. The agenda ledger is where the
 * training→calendar sync writes the resolved `start_at`, so it is the only
 * source that knows when a session actually begins.
 */

import { getDb } from './database';
import { createNotificationIntent, notificationDecisionReachedUser, notificationTitleOrFallback, notificationDeliveryFailed, getNotificationProfileIfExists } from './notification-orchestrator';
import { logger } from '../utils/logger';

/** Lead-time match tolerance. The sweep runs every 5 minutes. */
const WINDOW_MINUTES = 5;

/** States where the session is still expected to happen. */
const ACTIVE_LIFECYCLE_STATES = ['scheduled', 'synced', 'reflowed', 'compressed'] as const;

/**
 * A session already past its start is not worth a "starts soon" push — the
 * value is entirely in the lead time, and a late one is just noise.
 */
export interface TrainingReminderSummary {
  inspected: number;
  notified: number;
  failed: number;
}

export interface TrainingReminderScope {
  userId: number;
  tenantId: number;
}

interface AgendaRow {
  agendaItemId: string;
  ownerUserId: number;
  // `secretary_agenda_items.tenant_id` is TEXT in the ledger schema, so this
  // arrives as a string and must be coerced before it reaches assertScope.
  tenantId: string | number;
  title: string | null;
  startAt: string;
}

export async function runTrainingSessionReminders(
  targets: TrainingReminderScope[],
  now = new Date(),
  pageSize = 50,
): Promise<TrainingReminderSummary> {
  const summary: TrainingReminderSummary = { inspected: 0, notified: 0, failed: 0 };
  const db = getDb();
  const scopes = normalizeScopes(targets);
  const boundedPageSize = Number.isSafeInteger(pageSize) && pageSize > 0
    ? Math.min(pageSize, 100)
    : 50;

  for (const { userId, tenantId } of scopes) {
    // Per-user lead time. Absent profile → the user has never opened
    // notification settings, so there is no promise to honour yet.
    const profile = getNotificationProfileIfExists(userId, tenantId);
    if (!profile) continue;
    if (!profile.skillPreferences.training) continue;

    const leadMinutes = profile.workoutReminderMinutes;
    if (!Number.isFinite(leadMinutes) || leadMinutes <= 0) continue;

    const windowStart = new Date(now.getTime() + leadMinutes * 60_000);
    const windowEnd = new Date(windowStart.getTime() + WINDOW_MINUTES * 60_000);

    let afterStartAt: string | null = null;
    let afterAgendaItemId: string | null = null;
    while (true) {
      let rows: AgendaRow[] = [];
      try {
        rows = db.prepare(`
        SELECT agenda_item_id AS agendaItemId, owner_user_id AS ownerUserId,
               tenant_id AS tenantId, title, start_at AS startAt
          FROM secretary_agenda_items
         WHERE owner_user_id = ?
           AND tenant_id = ?
           AND source_skill = 'training'
           AND lifecycle_state IN (${ACTIVE_LIFECYCLE_STATES.map(() => '?').join(',')})
           AND start_at IS NOT NULL
           AND datetime(start_at) >= datetime(?)
           AND datetime(start_at) <  datetime(?)
           AND (
             ? IS NULL
             OR datetime(start_at) > datetime(?)
             OR (datetime(start_at) = datetime(?) AND agenda_item_id > ?)
           )
         ORDER BY datetime(start_at) ASC, agenda_item_id ASC
         LIMIT ?
      `).all(
          userId,
          String(tenantId),
          ...ACTIVE_LIFECYCLE_STATES,
          windowStart.toISOString(),
          windowEnd.toISOString(),
          afterStartAt,
          afterStartAt,
          afterStartAt,
          afterAgendaItemId,
          boundedPageSize,
        ) as AgendaRow[];
      } catch (err) {
        logger.warn({ err, userId, tenantId }, 'training session reminder read failed');
        summary.failed += 1;
        break;
      }

      if (rows.length === 0) break;

      for (const row of rows) {
        summary.inspected += 1;
        try {
          const result = await createNotificationIntent({
            userId,
            tenantId,
            sourceSkill: 'training',
            type: 'reminder',
            priority: 'active',
            relatedEntityId: row.agendaItemId,
            relatedEntityType: 'training_session',
            title: notificationTitleOrFallback(row.title, 'Training session'),
            body: `Starts in ${leadMinutes} minutes.`,
            deeplink: `nexus://training/session/${encodeURIComponent(row.agendaItemId)}`,
            // Scope is part of the durable dedupe identity. This keeps a
            // same-user agenda item in one tenant from suppressing another.
            dedupeKey: `training:session_reminder:${tenantId}:${row.agendaItemId}`,
            // The reminder stops being useful the moment the session starts.
            expiresAt: row.startAt,
            privacyPolicy: 'health',
          });
          // A duplicate resolves without throwing. The 5-minute window and the
          // 5-minute sweep interval can overlap on a boundary tick, so count
          // only genuinely new reminders.
          if (notificationDecisionReachedUser(result.decisionLog?.decision)) summary.notified += 1;
          // A push that was attempted and rejected is an outage signal, not a
          // quiet tick. Counting only thrown exceptions here let a 100%-failing
          // sweep report failed: 0 and the scheduler mark the job green.
          if (notificationDeliveryFailed(result.deliveryAttempts)) summary.failed += 1;
        } catch (err) {
          summary.failed += 1;
          logger.warn({ err, userId, tenantId, agendaItemId: row.agendaItemId }, 'training session reminder failed');
        }
      }

      const last = rows[rows.length - 1];
      afterStartAt = last.startAt;
      afterAgendaItemId = last.agendaItemId;
      if (rows.length < boundedPageSize) break;
    }
  }

  return summary;
}

function normalizeScopes(targets: TrainingReminderScope[]): TrainingReminderScope[] {
  const unique = new Map<string, TrainingReminderScope>();
  for (const target of targets) {
    if (!Number.isSafeInteger(target.userId) || target.userId <= 0) continue;
    if (!Number.isSafeInteger(target.tenantId) || target.tenantId <= 0) continue;
    unique.set(`${target.tenantId}:${target.userId}`, target);
  }
  return [...unique.values()].sort((left, right) =>
    left.tenantId - right.tenantId || left.userId - right.userId);
}
