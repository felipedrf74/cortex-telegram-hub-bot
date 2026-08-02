// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Tell the user what a trip is about to disrupt, across skills.
 *
 * `cross_skill_impact` has been a fully-formed contract since the notification
 * layer shipped — it resolves to the `coordinated_plan` iOS destination — and
 * nothing has ever produced one. Every decision recipe targets its own skill,
 * so the product has never told a user "this one thing moves several parts of
 * your week".
 *
 * A travel window is the natural first producer, and the only signal that
 * inherently spans domains: it moves training sessions, shifts meal prep, and
 * puts calendar commitments in a different timezone. The window is already
 * recorded (the coach asks for it) and already read by the training week
 * planner — but only ever within training.
 *
 * SCOPE, stated rather than implied: impact is counted from
 * `secretary_agenda_items`, the ledger every skill writes its scheduled
 * commitments into. That makes the count genuinely cross-skill, but it covers
 * only what Nexus itself scheduled. Provider-only calendar events are not
 * included, for the same reason the commitment reminder excludes them: nothing
 * caches them locally.
 *
 * SHAPE: this is an informational heads-up, not a decision. Two existing
 * constraints say so, and both are respected rather than worked around:
 *
 *   1. The `cross_skill_impact` contract resolves to
 *      `['in_app','inbox_history','digest']` — no push — so
 *      `deliveryPolicyForNotificationContract` returns `digest_only`. Whoever
 *      wrote that contract decided a cross-skill coordination item is a
 *      "here is your week" thing, not an interrupt. That is right: a trip three
 *      days out does not need to buzz a phone.
 *   2. The Notification Center list post-filters decision-shaped rows through a
 *      guidance quality gate. A `decision_required` item that cannot offer a
 *      concrete resolution is correctly hidden — and there is no single action
 *      that resolves "you are travelling".
 *
 * Copy carries counts, never titles — a trip's commitments are exactly the kind
 * of detail that should stay behind authenticated access.
 */

import { getDb } from './database';
import { createNotificationIntent, notificationDecisionReachedUser, notificationDeliveryFailed, getNotificationProfileIfExists } from './notification-orchestrator';
import { logger } from '../utils/logger';

/**
 * How far ahead a trip is announced. Far enough that moving things is still
 * possible, close enough that it is not abstract.
 */
const LEAD_DAYS = 3;

/** Lifecycle states where a commitment is still expected to happen. */
const ACTIVE_LIFECYCLE_STATES = ['scheduled', 'synced', 'reflowed', 'compressed'] as const;

export interface TravelWindowNoticeSummary {
  inspected: number;
  notified: number;
  failed: number;
}

interface TravelRow {
  id: number;
  userId: number;
  tenantId: number | null;
  startDate: string;
  endDate: string;
  timeZoneShiftHours: number | null;
}

interface SkillImpact {
  sourceSkill: string;
  count: number;
}

/** Human-facing label per skill. Kept here so copy stays out of the query. */
const SKILL_NOUN: Record<string, { one: string; many: string }> = {
  training: { one: 'training session', many: 'training sessions' },
  cooking: { one: 'meal', many: 'meals' },
  content: { one: 'content slot', many: 'content slots' },
  finance: { one: 'finance deadline', many: 'finance deadlines' },
  secretary: { one: 'commitment', many: 'commitments' },
};

function describeImpact(impacts: SkillImpact[]): string {
  const parts = impacts.map(({ sourceSkill, count }) => {
    const noun = SKILL_NOUN[sourceSkill] ?? { one: 'commitment', many: 'commitments' };
    return `${count} ${count === 1 ? noun.one : noun.many}`;
  });
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

export async function runTravelWindowNotices(
  userIds: number[],
  now = new Date(),
): Promise<TravelWindowNoticeSummary> {
  const summary: TravelWindowNoticeSummary = { inspected: 0, notified: 0, failed: 0 };
  const db = getDb();
  const windowOpens = new Date(now.getTime() + LEAD_DAYS * 86_400_000).toISOString().slice(0, 10);
  const today = now.toISOString().slice(0, 10);

  for (const userId of userIds) {
    const profile = getNotificationProfileIfExists(userId);
    if (!profile) continue;

    let trips: TravelRow[] = [];
    try {
      trips = db.prepare(`
        SELECT id, user_id AS userId, tenant_id AS tenantId,
               start_date AS startDate, end_date AS endDate,
               time_zone_shift_hours AS timeZoneShiftHours
          FROM travel_windows
         WHERE user_id = ?
           AND date(start_date) > date(?)
           AND date(start_date) <= date(?)
         ORDER BY date(start_date) ASC
         LIMIT 5
      `).all(userId, today, windowOpens) as TravelRow[];
    } catch (err) {
      logger.warn({ err, userId }, 'travel window read failed');
      summary.failed += 1;
      continue;
    }

    for (const trip of trips) {
      summary.inspected += 1;
      try {
        const tenantId = Number(trip.tenantId) || userId;
        const impacts = db.prepare(`
          SELECT source_skill AS sourceSkill, COUNT(*) AS count
            FROM secretary_agenda_items
           WHERE owner_user_id = ?
             -- Tenant-scoped like every neighbouring read. Latent while
             -- userId === tenantId, but this is a cross-tenant read waiting to
             -- happen the moment that stops holding.
             AND tenant_id = ?
             AND lifecycle_state IN (${ACTIVE_LIFECYCLE_STATES.map(() => '?').join(',')})
             AND start_at IS NOT NULL
             AND date(start_at) >= date(?)
             AND date(start_at) <= date(?)
           GROUP BY source_skill
           ORDER BY COUNT(*) DESC
        `).all(userId, String(tenantId), ...ACTIVE_LIFECYCLE_STATES, trip.startDate, trip.endDate) as SkillImpact[];

        // A trip that collides with nothing needs no notice. Silence here is
        // the correct outcome, not a missed notification.
        if (impacts.length === 0) continue;

        const shift = trip.timeZoneShiftHours ?? 0;
        const timezoneNote = shift !== 0 ? ` Times shift by ${shift > 0 ? '+' : ''}${shift}h.` : '';

        const result = await createNotificationIntent({
          userId,
          tenantId,
          // Secretary owns the schedule, so it owns the coordination decision —
          // but the impact spans skills, which is what the contract encodes.
          sourceSkill: 'secretary',
          // Informational: see the SHAPE note above. Not `decision_required`,
          // because nothing here is resolvable by tapping one button.
          type: 'schedule_changed',
          priority: 'passive',
          relatedEntityId: String(trip.id),
          // Resolves the notification contract to the coordinated_plan iOS
          // destination — the whole reason this producer exists.
          relatedEntityType: 'cross_skill_impact',
          title: 'Your trip affects your week',
          body: `${trip.startDate} to ${trip.endDate}: ${describeImpact(impacts)} fall in this window.${timezoneNote}`,
          actionButtons: [{ id: 'open_detail', label: 'Review', style: 'primary' }],
          deeplink: 'nexus://decision-center',
          dedupeKey: `secretary:travel_window:${trip.id}`,
          // Does not badge: a trip is not an outstanding decision, and badging
          // something the user cannot clear is how a badge starts lying.
          requiresUserAction: false,
          // Useless once the departure DAY has passed — not once it begins.
          // Expiring at 00:00 on the start date put the expiry roughly 7.5h
          // BEFORE the digest slot this notice is routed to (the sweep runs at
          // 08:40 and `nextDigestTime` lands the following morning), so the
          // release sweep filtered it out on `expires_at > now` and it was
          // never delivered — while `summary.notified` still counted it. The
          // closer the trip, the more reliably it was lost.
          expiresAt: new Date(`${trip.startDate}T23:59:59.999Z`).toISOString(),
          // Counts only — no commitment titles reach the lock screen.
          privacyPolicy: 'sensitive',
        });
        if (notificationDecisionReachedUser(result.decisionLog?.decision)) summary.notified += 1;
        // A push that was attempted and rejected is an outage signal, not a
        // quiet tick. Counting only thrown exceptions here let a 100%-failing
        // sweep report failed: 0 and the scheduler mark the job green.
        if (notificationDeliveryFailed(result.deliveryAttempts)) summary.failed += 1;
      } catch (err) {
        summary.failed += 1;
        logger.warn({ err, userId, tripId: trip.id }, 'travel window notice failed');
      }
    }
  }

  return summary;
}
