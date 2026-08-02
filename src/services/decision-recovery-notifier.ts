// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Tell the user when an action they approved did not finish cleanly.
 *
 * `DecisionLifecycleEvent` has defined `action_partially_failed`,
 * `rolled_back`, `execution_reconciled` and `unblocked` since the decision flow
 * shipped, and every one of them writes to an audit table nobody reads. These
 * are the states where the world is half-changed and the product says nothing:
 *
 *   - `action_partially_failed` is the worst state the system can produce. The
 *     user tapped Accept, one leg landed, one did not, and the UI is silent.
 *     Read-back verification exists precisely to detect this and its output was
 *     being discarded.
 *   - `rolled_back` means Nexus undid something the user approved. A silent undo
 *     costs more trust than the original failure.
 *   - `execution_reconciled` resolves a crash mid-execution: the change either
 *     did or did not go through, and only now is that knowable.
 *   - `unblocked` means a decision the user deferred because it was blocked is
 *     live again. Nothing told them.
 *
 * These are correctness notifications, not features — which is why they are
 * `active` rather than passive, and why none of them is suppressible by the
 * usual "this type is noisy" path: a user who muted schedule conflicts still
 * needs to know a conflict fix half-applied.
 *
 * Swept rather than emitted inline. `emitDecisionLifecycleEvent` is called from
 * a dozen places inside a 10k-line module, several of them mid-transaction;
 * minting a notification there would put APNs work inside a DB transaction and
 * spread notification policy across every call site. Exactly-once is handled by
 * the orchestrator's dedupe on the event id, so a re-swept event resolves as
 * `deduped` rather than notifying twice.
 */

import { getDb } from './database';
import { createNotificationIntent, notificationDecisionReachedUser, notificationDeliveryFailed, getNotificationProfileIfExists } from './notification-orchestrator';
import { logger } from '../utils/logger';

/**
 * How far back a sweep looks. Wider than the cron interval so a missed tick
 * recovers, but bounded so a backlog cannot produce a burst of stale alarms
 * about executions the user has long since moved past.
 */
const LOOKBACK_MINUTES = 60;

/** Cap per sweep so a storm of failures cannot spend the whole interrupt budget. */
const MAX_PER_SWEEP = 20;

type RecoveryEvent = 'action_partially_failed' | 'rolled_back' | 'execution_reconciled' | 'unblocked';

const RECOVERY_EVENTS: readonly RecoveryEvent[] = [
  'action_partially_failed',
  'rolled_back',
  'execution_reconciled',
  'unblocked',
];

interface RecoveryCopy {
  title: string;
  body: string;
  /** `unblocked` is good news; the rest report a partial or reversed change. */
  reassuring: boolean;
}

/**
 * Copy is templated per event, never generated, and never quotes the decision's
 * own text — the notification points at the decision rather than restating it,
 * so nothing user-authored or third-party-authored reaches a lock screen.
 */
const RECOVERY_COPY: Record<RecoveryEvent, RecoveryCopy> = {
  action_partially_failed: {
    title: 'Only part of that change went through',
    body: 'Open Nexus to see what landed and what did not.',
    reassuring: false,
  },
  rolled_back: {
    title: 'Nexus undid a change',
    body: 'The change was reversed. Open Nexus for the detail.',
    reassuring: false,
  },
  execution_reconciled: {
    title: 'A change was reconciled',
    body: 'Nexus confirmed the final state after an interruption.',
    reassuring: false,
  },
  unblocked: {
    title: 'A decision is ready again',
    body: 'What was blocking it has cleared.',
    reassuring: true,
  },
};

export interface DecisionRecoverySummary {
  inspected: number;
  notified: number;
  failed: number;
}

interface LifecycleRow {
  eventId: string;
  decisionId: string;
  userId: number;
  tenantId: number;
  event: RecoveryEvent;
  actionId: string | null;
}

export async function runDecisionRecoveryNotices(now = new Date()): Promise<DecisionRecoverySummary> {
  const summary: DecisionRecoverySummary = { inspected: 0, notified: 0, failed: 0 };
  const since = new Date(now.getTime() - LOOKBACK_MINUTES * 60_000).toISOString();

  let rows: LifecycleRow[] = [];
  try {
    rows = getDb().prepare(`
      SELECT events.event_id AS eventId, events.decision_id AS decisionId,
             events.user_id AS userId, events.tenant_id AS tenantId,
             events.event, events.action_id AS actionId
        FROM decision_lifecycle_events events
       WHERE events.event IN (${RECOVERY_EVENTS.map(() => '?').join(',')})
         AND datetime(events.created_at) >= datetime(?)
         -- Users without a notification profile are intentionally ineligible,
         -- but must not occupy the global LIMIT and starve eligible users.
         AND EXISTS (
           SELECT 1 FROM notification_profiles profiles
            WHERE profiles.user_id = events.user_id
              AND profiles.tenant_id = events.tenant_id
         )
         -- A swept event used to remain in the oldest-first LIMIT forever.
         -- Once 20 rows existed, event 21 could age out without ever being
         -- inspected. The intent's durable event-scoped key is the cursor.
         AND NOT EXISTS (
           SELECT 1 FROM notification_intents intents
            WHERE intents.user_id = events.user_id
              AND intents.tenant_id = events.tenant_id
              AND intents.dedupe_key = 'system:decision_recovery:' || events.event_id
         )
       ORDER BY datetime(events.created_at) ASC, events.event_id ASC
       LIMIT ?
    `).all(...RECOVERY_EVENTS, since, MAX_PER_SWEEP) as LifecycleRow[];
  } catch (err) {
    // The table is owned by decision-center and may not have self-healed yet.
    logger.warn({ err }, 'decision recovery sweep read failed');
    summary.failed += 1;
    return summary;
  }

  for (const row of rows) {
    summary.inspected += 1;
    const copy = RECOVERY_COPY[row.event];
    if (!copy) continue;

    try {
      // Absent profile → the user has never opened notification settings.
      const profile = getNotificationProfileIfExists(row.userId, row.tenantId);
      if (!profile) continue;

      const result = await createNotificationIntent({
        userId: row.userId,
        tenantId: row.tenantId,
        sourceSkill: 'system',
        // Not `sync_failure`: nothing is disconnected, and that type is floored
        // to the top of the Decision Center for connection problems.
        type: copy.reassuring ? 'schedule_changed' : 'decision_required',
        priority: 'active',
        relatedEntityId: row.decisionId,
        relatedEntityType: 'decision',
        title: copy.title,
        body: copy.body,
        actionButtons: [{ id: 'open_detail', label: 'Open', style: 'primary' }],
        deeplink: 'nexus://decision-center',
        // Keyed on the lifecycle event, so a re-swept row dedupes instead of
        // re-notifying, and two different failures on one decision both land.
        dedupeKey: `system:decision_recovery:${row.eventId}`,
        // Only the half-applied and reversed cases need a decision from the
        // user; "ready again" is information.
        requiresUserAction: !copy.reassuring,
        privacyPolicy: 'standard',
      });
      if (notificationDecisionReachedUser(result.decisionLog?.decision)) summary.notified += 1;
        // A push that was attempted and rejected is an outage signal, not a
        // quiet tick. Counting only thrown exceptions here let a 100%-failing
        // sweep report failed: 0 and the scheduler mark the job green.
        if (notificationDeliveryFailed(result.deliveryAttempts)) summary.failed += 1;
    } catch (err) {
      summary.failed += 1;
      logger.warn({ err, eventId: row.eventId, event: row.event }, 'decision recovery notice failed');
    }
  }

  return summary;
}
