// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Remind the user before a scheduled commitment starts.
 *
 * Being late is the highest-cost, least-recoverable failure a calendar
 * assistant can allow, and nothing in the product produced this notification:
 * `grep -riE "starting soon|leave now|travel time" src` returned nothing.
 * `notification_profiles.default_reminder_minutes` was stored and patchable
 * but, like the training lead time before it, read by no producer.
 *
 * SCOPE LIMITATION, stated deliberately rather than papered over:
 * this covers commitments in `secretary_agenda_items` — the items Nexus itself
 * scheduled. It does NOT cover events that live only in Google/Outlook, because
 * there is no local cache of provider events to query. Covering those from a
 * 5-minute cron would mean live provider calls per user per tick, which is a
 * rate-limit and cost problem, not a notification problem. A provider event
 * cache is the prerequisite, and it does not exist yet.
 *
 * Training sessions are excluded here: `training-session-reminder.ts` already
 * owns them and honours the separate `workout_reminder_minutes` lead time.
 * Without the exclusion a user would get two pushes for one session.
 */

import { getDb } from './database';
import { createNotificationIntent, notificationDecisionReachedUser, notificationTitleOrFallback, notificationDeliveryFailed, getNotificationProfileIfExists } from './notification-orchestrator';
import { logger } from '../utils/logger';

/** Lead-time match tolerance. The sweep runs every 5 minutes. */
const WINDOW_MINUTES = 5;

/** Lifecycle states where the commitment is still expected to happen. */
const ACTIVE_LIFECYCLE_STATES = ['scheduled', 'synced', 'reflowed', 'compressed'] as const;

/**
 * Per the catalog's T1 budget, a lead-time reminder is capped so a densely
 * booked morning cannot spend the whole day's interrupt allowance before 10am.
 */
const MAX_REMINDERS_PER_SWEEP = 4;

export interface CommitmentReminderSummary {
  inspected: number;
  notified: number;
  failed: number;
}

interface AgendaRow {
  agendaItemId: string;
  // `secretary_agenda_items.tenant_id` is TEXT in the ledger schema, so this
  // arrives as a string and must be coerced before it reaches assertScope.
  tenantId: string | number;
  title: string | null;
  startAt: string;
  sourceSkill: string;
}

export async function runCommitmentStartReminders(
  userIds: number[],
  now = new Date(),
): Promise<CommitmentReminderSummary> {
  const summary: CommitmentReminderSummary = { inspected: 0, notified: 0, failed: 0 };
  const db = getDb();

  for (const userId of userIds) {
    // Absent profile → the user has never opened notification settings, so
    // there is no stored lead time and no promise to honour.
    const profile = getNotificationProfileIfExists(userId);
    if (!profile) continue;
    if (!profile.skillPreferences.secretary) continue;

    const leadMinutes = profile.defaultReminderMinutes;
    if (!Number.isFinite(leadMinutes) || leadMinutes <= 0) continue;

    const windowStart = new Date(now.getTime() + leadMinutes * 60_000);
    const windowEnd = new Date(windowStart.getTime() + WINDOW_MINUTES * 60_000);

    let rows: AgendaRow[] = [];
    try {
      rows = db.prepare(`
        SELECT agenda_item_id AS agendaItemId, tenant_id AS tenantId,
               title, start_at AS startAt, source_skill AS sourceSkill
          FROM secretary_agenda_items
         WHERE owner_user_id = ?
           AND source_skill != 'training'
           AND lifecycle_state IN (${ACTIVE_LIFECYCLE_STATES.map(() => '?').join(',')})
           AND start_at IS NOT NULL
           AND datetime(start_at) >= datetime(?)
           AND datetime(start_at) <  datetime(?)
         ORDER BY datetime(start_at) ASC
         LIMIT ?
      `).all(
        userId,
        ...ACTIVE_LIFECYCLE_STATES,
        windowStart.toISOString(),
        windowEnd.toISOString(),
        MAX_REMINDERS_PER_SWEEP,
      ) as AgendaRow[];
    } catch (err) {
      logger.warn({ err, userId }, 'commitment start reminder read failed');
      summary.failed += 1;
      continue;
    }

    for (const row of rows) {
      summary.inspected += 1;
      try {
        const result = await createNotificationIntent({
          userId,
          tenantId: Number(row.tenantId) || userId,
          sourceSkill: 'secretary',
          type: 'reminder',
          priority: 'time_sensitive',
          relatedEntityId: row.agendaItemId,
          relatedEntityType: 'secretary_agenda_item',
          title: notificationTitleOrFallback(row.title, 'Upcoming commitment'),
          body: `Starts in ${leadMinutes} minutes.`,
          deeplink: 'nexus://notifications',
          // One reminder per commitment, ever. The 5-minute window and the
          // 5-minute sweep interval can overlap on a boundary tick.
          dedupeKey: `secretary:commitment_reminder:${row.agendaItemId}`,
          // Quiet-hours breakthrough for time-sensitive notifications is
          // deadline-gated. The commitment start is both the last useful
          // delivery instant and the deadline the policy must evaluate.
          decisionDeadline: row.startAt,
          // The value is entirely in the lead time — a reminder that arrives
          // after the thing started is noise, so it expires at the start.
          expiresAt: row.startAt,
          // The title is the user's own calendar text; keep it off the lock
          // screen and let the privacy-safe body carry the schedule fact.
          privacyPolicy: 'sensitive',
        });
        if (notificationDecisionReachedUser(result.decisionLog?.decision)) summary.notified += 1;
        // A push that was attempted and rejected is an outage signal, not a
        // quiet tick. Counting only thrown exceptions here let a 100%-failing
        // sweep report failed: 0 and the scheduler mark the job green.
        if (notificationDeliveryFailed(result.deliveryAttempts)) summary.failed += 1;
      } catch (err) {
        summary.failed += 1;
        logger.warn({ err, userId, agendaItemId: row.agendaItemId }, 'commitment start reminder failed');
      }
    }
  }

  return summary;
}
