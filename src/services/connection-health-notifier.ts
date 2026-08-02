// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Tell the user when one of THEIR connections stops working.
 *
 * This was the highest blast-radius silent failure in the product: when a
 * user's Google or Outlook authorisation goes bad, calendar, email, tasks,
 * briefings and conflict detection all quietly degrade to stale data, and the
 * only signal was an `owner:'ops'` operator alert the user never sees. Garmin
 * was the sole provider with a user-facing bridge.
 *
 * Deliberately built on `getIntegrationSummary(userId)` — the per-user
 * connection state — and NOT on the `integration_health` probe. That probe
 * runs against the configured owner credentials with no user scope, so
 * bridging it would notify every tenant about a single-tenant ops event they
 * cannot act on. The boundary doc keeps the operator plane out of the user
 * center for exactly this reason.
 */

import { getIntegrationSummary, type IntegrationProvider, type ProviderIntegrationStatus } from './integration-status';
import {
  createNotificationIntent,
  getNotificationProfileIfExists,
  notificationDecisionReachedUser,
  notificationDeliveryFailed,
} from './notification-orchestrator';
import { logger } from '../utils/logger';

/**
 * Only states the user can actually resolve by reconnecting. `degraded` is
 * excluded on purpose: it usually means a transient probe failure, and
 * notifying on it would turn every provider hiccup into an interrupt.
 */
const ACTIONABLE_STATES = new Set(['revoked']);

/**
 * Providers whose loss materially degrades the product. Health/wearable
 * providers already have their own producers (Garmin reauth), and a dormant
 * task provider is not worth an interrupt.
 */
const NOTIFIABLE_PROVIDERS = new Set<IntegrationProvider>(['google', 'outlook']);

/**
 * Re-notification bucket. The dedupe unique index already prevents a second
 * live intent while the first is unresolved; this bounds how often a
 * *dismissed* one can come back, so a user who is not ready to reconnect is
 * reminded every three days rather than on every sweep.
 */
const RENOTIFY_BUCKET_DAYS = 3;

const PROVIDER_LABEL: Partial<Record<IntegrationProvider, string>> = {
  google: 'Google Calendar',
  outlook: 'Outlook',
};

export interface ConnectionHealthNotifySummary {
  usersChecked: number;
  notified: number;
  failed: number;
}

function renotifyBucket(now: Date): string {
  const days = Math.floor(now.getTime() / (24 * 60 * 60 * 1000));
  return String(Math.floor(days / RENOTIFY_BUCKET_DAYS));
}

/**
 * What the user loses while this provider is broken. Concrete and specific:
 * "a connection needs attention" does not tell anyone whether to care.
 */
function impactLine(provider: IntegrationProvider): string {
  if (provider === 'google') return 'Your agenda and conflict checks are running on old data.';
  if (provider === 'outlook') return 'Mail, calendar and tasks are running on old data.';
  return 'Some Nexus surfaces are running on old data.';
}

export async function notifyBrokenConnectionsForUser(
  userId: number,
  tenantId = userId,
  now = new Date(),
): Promise<{ notified: number; failed: number }> {
  // The only one of the six producers that did not pre-check the skill gate.
  // Without it, every sweep for an opted-out user counted a notification that
  // was never stored: the ladder returns `blocked_user_preferences` and writes
  // no Notification Center item at all.
  //
  // A MISSING profile is not an opt-out — unlike the lead-time producers, this
  // one must still reach a user who has never opened notification settings,
  // because a revoked authorisation does not resolve itself. The ladder creates
  // the default profile (system enabled) on the way through.
  const profile = getNotificationProfileIfExists(userId);
  if (profile && !profile.skillPreferences.system) return { notified: 0, failed: 0 };

  let notified = 0;
  let failed = 0;
  let statuses: ProviderIntegrationStatus[];
  try {
    statuses = getIntegrationSummary(userId).providers;
  } catch (err) {
    // Counted, not just logged. This early return reported `failed: 0`, and the
    // outer sweep's own catch cannot fire because nothing escapes this function
    // — so a provider-state read that failed for every user produced
    // {usersChecked: N, notified: 0, failed: 0} and the job went green.
    logger.warn({ err, userId }, 'connection health read failed');
    return { notified: 0, failed: 1 };
  }

  for (const status of statuses) {
    if (!NOTIFIABLE_PROVIDERS.has(status.provider)) continue;
    if (!ACTIONABLE_STATES.has(status.state)) continue;

    const label = PROVIDER_LABEL[status.provider] ?? status.provider;
    try {
      const result = await createNotificationIntent({
        userId,
        tenantId,
        sourceSkill: 'system',
        type: 'sync_failure',
        priority: 'active',
        relatedEntityId: status.provider,
        relatedEntityType: 'provider_connection',
        title: `${label} needs reconnecting`,
        body: impactLine(status.provider),
        // Explicit opt-in: sync_failure also represents non-connection jobs,
        // so only a real provider reconnect may select DECISION_RECONNECT.
        actionButtons: [{ id: 'reconnect', label: 'Reconnect', style: 'primary' }],
        deeplink: 'nexus://connections',
        dedupeKey: `system:connection_health:${status.provider}:${renotifyBucket(now)}`,
        requiresUserAction: true,
        privacyPolicy: 'standard',
        decisionContext: {
          providerName: label,
          sourceState: status.state,
          explicitNoRelatedEntityReason: 'connection health is scoped to provider state',
        },
      });
      // A duplicate resolves without throwing, so count only genuinely new
      // notices — otherwise every sweep would report the same broken
      // connection as freshly delivered.
      if (notificationDecisionReachedUser(result.decisionLog?.decision)) notified += 1;
      // A push that was attempted and rejected is an outage signal, not a
      // quiet tick. Counting only thrown exceptions here let a 100%-failing
      // sweep report failed: 0 and the scheduler mark the job green.
      if (notificationDeliveryFailed(result.deliveryAttempts)) failed += 1;
    } catch (err) {
      // Same reason as the read failure above: swallowing this made every
      // `failed` path in the module unreachable, which is why its own header
      // called this the highest blast-radius silent failure in the product.
      failed += 1;
      logger.warn({ err, userId, provider: status.provider }, 'connection health notification failed');
    }
  }
  return { notified, failed };
}

export async function runConnectionHealthNotifier(
  userIds: number[],
  now = new Date(),
): Promise<ConnectionHealthNotifySummary> {
  const summary: ConnectionHealthNotifySummary = { usersChecked: 0, notified: 0, failed: 0 };
  for (const userId of userIds) {
    summary.usersChecked += 1;
    try {
      const result = await notifyBrokenConnectionsForUser(userId, userId, now);
      summary.notified += result.notified;
      summary.failed += result.failed;
    } catch (err) {
      summary.failed += 1;
      logger.warn({ err, userId }, 'connection health sweep failed for user');
    }
  }
  return summary;
}
