// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Secretary Notification Orchestrator.
 *
 * Skills emit NotificationIntent records. This service is the single place
 * that decides whether a user gets a push, local/in-app item, portal item,
 * digest entry, quiet-hours delay, or suppression. Lock-screen payloads are
 * deliberately privacy-safe; detailed bodies stay behind authenticated app
 * access.
 */

import { createHash, randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import { getDb } from './database';
import { getUserLanguageById, getUserTimezoneById } from './user-service';
import { getPushTokensForUser, isApnsConfigured, sendPushNotification } from './apns-sender';
import { config } from '../config';
import { t, type Lang } from '../utils/i18n';
import { logger } from '../utils/logger';
import { isValidTenantUserId, recordTenantScopeAnomaly } from './tenant-scope-observability';
import { emitDomainEvent, runOutboxTransaction } from './event-outbox';
import { enqueueJob } from './background-job-queue';
import { consumeResourceBudget } from './resource-budgets';
import {
  NON_BADGE_NOTIFICATION_TYPES,
  deliveryPolicyForNotificationContract,
  isNotificationActionMutating,
  resolveNotificationContract,
} from './notification-contracts';
import {
  buildDecisionLogicV2,
  rankDecision,
  type DecisionLogicContext,
  type DecisionLogicInput,
  type DecisionVisibilityScope,
} from './decision-center-logic-v2';
import {
  isDecisionCenterGuidanceSkillEnabled,
  isDecisionCenterGuidanceV1Enabled,
  isDecisionReconnectAffordanceEnabled,
  isDecisionTypeSuppressionEnabled,
  isNotificationPriorityShadowScoringEnabled,
} from './runtime-flags';
import { computeSharedNotificationActionEffectiveStatus } from './notification-action-state';
import { NEUTRAL_ENGAGEMENT, scoreNotification } from './notification-priority-model';
import { decisionRelationshipSemantics } from './decision-relationship-types';
import { getSecretaryAgendaItemById } from './secretary-scheduling-arbitrator';
import { normalizeDecisionAction } from './decision-action-contract';
import {
  normalizeConflictComparisonAction,
  normalizeConflictEvaluation,
} from './decision-conflict-evaluator';
// content-notification-store only imports this module lazily (await import),
// so this static edge does not create a require cycle.
import { listUnreadContentNotificationIdsByTypes } from './content-notification-store';
import {
  claimScheduledJobExecution,
  completeScheduledJobExecution,
  isScheduledJobExecutionLeaseActive,
  renewScheduledJobExecution,
} from './scheduled-job-execution-state';

export type NotificationSourceSkill =
  | 'secretary'
  | 'training'
  | 'content'
  | 'cooking'
  | 'finance'
  | 'chat'
  | 'system'
  | 'security';

export type NotificationIntentType =
  | 'decision_required'
  | 'conflict_detected'
  | 'schedule_changed'
  | 'reminder'
  | 'missed_item'
  | 'reflow_suggestion'
  | 'approval_required'
  | 'risk_warning'
  | 'daily_digest'
  | 'weekly_review'
  | 'security_account'
  | 'sync_failure'
  | 'insight';

export type NotificationPriority = 'critical' | 'time_sensitive' | 'active' | 'passive';
export type NotificationDecision =
  | 'sent_push'
  | 'in_app_only'
  | 'portal_only'
  | 'digest'
  | 'suppressed'
  | 'deduped'
  | 'quiet_hours_delayed'
  | 'blocked_missing_device_token'
  | 'blocked_user_preferences'
  | 'blocked_privacy_policy'
  | 'apns_delivery_failed';
/**
 * Did this decision surface a notification to the user at all?
 *
 * Producer sweeps report a `notified` count, and every one computed it as
 * `decision !== 'deduped'` — which also counts `suppressed`, where no item is
 * ever shown. A push that fails still leaves a durable Notification Center item
 * the user will see, so it DOES count here; what it must not do is go
 * unreported, which is what `notificationDeliveryFailed` below is for.
 */
export function notificationDecisionReachedUser(
  decision: NotificationDecision | null | undefined,
): boolean {
  if (!decision) return false;
  // These three store NO Notification Center item — `blocked_user_preferences`
  // writes its log with `notificationId: null` — so nothing was surfaced.
  // `blocked_missing_device_token` and `apns_delivery_failed` are decided
  // AFTER the item is persisted, so those genuinely did reach the inbox.
  return decision !== 'deduped'
    && decision !== 'suppressed'
    && decision !== 'blocked_user_preferences'
    && decision !== 'blocked_privacy_policy';
}

/**
 * Did an APNs delivery genuinely fail, as opposed to never being attempted?
 *
 * Producer summaries counted only thrown exceptions as `failed`, so a sweep in
 * which every single push failed reported `notified: 40, failed: 0` — and the
 * scheduler's `notified === 0 → 'skipped'` mapping meant even that left no
 * job_history row. Time-to-detect for a push outage was unbounded.
 *
 * `blocked_missing_credentials` and `blocked_missing_device_token` are
 * deliberately NOT failures: the first is an unconfigured environment (every
 * local dev run would otherwise page), the second is a user who has not granted
 * push. Only an attempted-and-rejected delivery is an outage signal.
 */
export function notificationDeliveryFailed(
  attempts: ReadonlyArray<{ status: string }> | null | undefined,
): boolean {
  return Boolean(attempts?.some((attempt) => attempt.status === 'failed'));
}

export type NotificationCenterStatus = 'unread' | 'read' | 'viewed' | 'snoozed' | 'actioned' | 'dismissed' | 'failed' | 'expired' | 'superseded';
export type NotificationPrivacyPolicy = 'public' | 'standard' | 'sensitive' | 'private_content' | 'financial' | 'health';
// 'push_allowed' pruned 2026-07-04: it was set by three producers but never
// evaluated anywhere — behaviorally identical to 'auto'. Historical intent
// rows carrying the string keep behaving as auto (unknown policies fall
// through to the default branch).
export type NotificationDeliveryPolicy = 'auto' | 'in_app_only' | 'digest_only' | 'portal_only';
export type QuietHoursPolicy = 'respect' | 'allow_time_sensitive' | 'send_now';

export interface NotificationActionButton {
  id: string;
  label: string;
  style?: 'primary' | 'secondary' | 'destructive';
  deeplink?: string;
  mutating?: boolean;
}

export type NotificationActionEffectiveState =
  | 'enabled'
  | 'disabled_unsupported'
  | 'disabled_not_implemented'
  | 'disabled_blocked_by_dependency'
  | 'disabled_requires_reconnect'
  | 'disabled_expired'
  | 'disabled_superseded'
  | 'disabled_already_actioned'
  | 'disabled_missing_details';

export interface NotificationActionEffectiveStatus {
  actionId: string;
  effective: NotificationActionEffectiveState;
  implemented: boolean;
  capabilityReason: string | null;
}

export interface NotificationIntentInput {
  intentId?: string;
  userId: number;
  tenantId?: number;
  sourceSkill: NotificationSourceSkill;
  type: NotificationIntentType;
  priority: NotificationPriority;
  relatedEntityId?: string | number | null;
  relatedEntityType?: string | null;
  title: string;
  body: string;
  sensitiveBody?: string | null;
  actionButtons?: NotificationActionButton[];
  deeplink?: string | null;
  expiresAt?: string | null;
  quietHoursPolicy?: QuietHoursPolicy;
  dedupeKey?: string | null;
  requiresUserAction?: boolean;
  decisionDeadline?: string | null;
  deliveryPolicy?: NotificationDeliveryPolicy;
  /**
   * Promotional / lifecycle notification (activation nudge, win-back, resume
   * onboarding). Gated on separate marketing consent per App Store 4.5.4 —
   * see `marketingPushEnabled`. Default false; operational notifications must
   * never set it, and promotional ones must never omit it.
   */
  promotional?: boolean;
  privacyPolicy?: NotificationPrivacyPolicy;
  decisionContext?: DecisionLogicContext | null;
  visibilityScope?: DecisionVisibilityScope | null;
}

export interface NotificationIntentRecord extends Required<Omit<NotificationIntentInput,
  'intentId' | 'relatedEntityId' | 'relatedEntityType' | 'sensitiveBody' | 'actionButtons' | 'deeplink' | 'expiresAt' |
  'quietHoursPolicy' | 'dedupeKey' | 'requiresUserAction' | 'decisionDeadline' | 'deliveryPolicy' | 'privacyPolicy' | 'promotional' | 'decisionContext' | 'visibilityScope'>> {
  intentId: string;
  tenantId: number;
  relatedEntityId: string | null;
  relatedEntityType: string | null;
  sensitiveBody: string | null;
  actionButtons: NotificationActionButton[];
  deeplink: string | null;
  expiresAt: string | null;
  quietHoursPolicy: QuietHoursPolicy;
  dedupeKey: string | null;
  requiresUserAction: boolean;
  decisionDeadline: string | null;
  deliveryPolicy: NotificationDeliveryPolicy;
  privacyPolicy: NotificationPrivacyPolicy;
  promotional: boolean;
  decisionContext: DecisionLogicContext | null;
  status: 'pending' | 'evaluated' | 'deduped' | 'suppressed' | 'expired';
  createdAt: string;
}

export interface NotificationProfile {
  userId: number;
  tenantId: number;
  quietHours: { start: string; end: string };
  timezone: string;
  pushEnabled: boolean;
  /** Separate consent for promotional/lifecycle pushes (App Store 4.5.4). */
  marketingPushEnabled: boolean;
  localEnabled: boolean;
  emailEnabled: boolean;
  portalEnabled: boolean;
  inAppEnabled: boolean;
  skillPreferences: Record<NotificationSourceSkill, boolean>;
  defaultReminderMinutes: number;
  workoutReminderMinutes: number;
  contentReminderMinutes: number;
  financeReminderDays: number;
  allowTimeSensitive: boolean;
  allowCritical: boolean;
  digestPassiveItems: boolean;
  dailyDigestTime: string;
  weeklyReviewDay: number;
  weeklyReviewTime: string;
  // Per-user report schedule (migration 225). NULL = global default; times
  // are HH:MM in the profile timezone; day uses cron convention 0=Sun..6=Sat.
  morningBriefingTime: string | null;
  coachBriefingTime: string | null;
  endOfDayTime: string | null;
  weeklyReviewReportDay: number | null;
  weeklyReviewReportTime: string | null;
  doNotNotifyRules: string[];
  updatedAt: string;
  createdAt: string;
}

export interface NotificationCenterItem {
  itemId: string;
  intentId: string;
  decisionLogId: string | null;
  userId: number;
  tenantId: number;
  title: string;
  body: string;
  safeBody: string;
  sensitiveBody: string | null;
  sourceSkill: NotificationSourceSkill;
  type: NotificationIntentType;
  priority: NotificationPriority;
  status: NotificationCenterStatus;
  /**
   * Whether this item is an outstanding ask. The badge counts only these, and
   * counts them off the LIST — so it has to travel with the item rather than be
   * re-derived from a second query.
   */
  requiresUserAction: boolean;
  /**
   * Marketing/lifecycle content. Never badges: a badge is an outstanding ask,
   * and a re-engagement nudge is not something the user can resolve.
   */
  promotional: boolean;
  deeplink: string | null;
  actions: NotificationActionButton[];
  actionEffectiveStatuses?: NotificationActionEffectiveStatus[];
  frontendActionState?: NotificationActionEffectiveState;
  dedupeKey: string | null;
  priorityScore?: number | null;
  createdAt: string;
  expiresAt: string | null;
  snoozedUntil?: string | null;
}

export interface NotificationDecisionLog {
  decisionLogId: string;
  notificationId: string | null;
  intentId: string | null;
  userId: number;
  tenantId: number;
  sourceSkill: NotificationSourceSkill;
  sourceEntityId: string | null;
  decision: NotificationDecision;
  priority: NotificationPriority;
  reason: string;
  dedupeKey: string | null;
  createdAt: string;
  scheduledFor: string | null;
  sentAt: string | null;
  openedAt: string | null;
  actionTaken: string | null;
  deliveryAttemptIds: string[];
}

export interface DeviceTokenRegistration {
  tokenId: string;
  userId: number;
  tenantId: number;
  platform: 'ios';
  tokenHash: string;
  tokenSuffix: string;
  environment: 'sandbox' | 'production';
  deviceId: string | null;
  appVersion: string | null;
  lastSeenAt: string;
  revokedAt: string | null;
  createdAt: string;
}

export interface DeliveryAttempt {
  attemptId: string;
  notificationId: string | null;
  intentId: string | null;
  userId: number;
  tenantId: number;
  channel: 'push' | 'local' | 'in_app' | 'portal' | 'email';
  provider: 'apns' | 'local' | 'portal' | 'mock';
  // 'mock_sent' retired 2026-07-04 with mock delivery mode; historical rows
  // in notification_delivery_attempts keep the string, writers cannot.
  status: 'sent' | 'blocked_missing_device_token' | 'blocked_missing_credentials' | 'failed';
  providerResponseCode: string | null;
  errorCode: string | null;
  createdAt: string;
  sentAt: string | null;
}

export interface NotificationEvaluationResult {
  intent: NotificationIntentRecord;
  item: NotificationCenterItem | null;
  decisionLog: NotificationDecisionLog;
  deliveryAttempts: DeliveryAttempt[];
  pushPayload: {
    title: string;
    body: string;
    deeplink: string | null;
    actions: NotificationActionButton[];
    interruptionLevel?: 'passive' | 'active' | 'time-sensitive';
  } | null;
}

/**
 * Optional durable proposal hook used by Decision Center. The callback runs
 * inside the same SQLite transaction that inserts the inbox item and before
 * any provider delivery can begin. Throwing rolls the item back.
 */
export interface NotificationIntentCreateOptions {
  /**
   * Persist the intent, outbox events, delivery job, center item, and durable
   * proposal metadata as one commit. Decision Center enables this so neither a
   * worker nor APNs can observe a partially-created proposal.
   */
  atomicItemProposal?: boolean;
  onItemPersistedInTransaction?: (context: {
    intent: NotificationIntentRecord;
    item: NotificationCenterItem;
    effectivePriority: NotificationPriority;
  }) => void | {
    /**
     * The proposal was atomically folded into an existing canonical item.
     * The new audit row remains durable, but it must never enqueue or attempt
     * provider delivery.
     */
    suppressDelivery: true;
    reason: string;
  };
}

export class NotificationProposalCommitError extends Error {
  readonly code = 'NOTIFICATION_PROPOSAL_COMMIT_FAILED';

  constructor(
    readonly intentId: string,
    options?: { cause?: unknown },
  ) {
    super('Notification proposal did not commit before delivery.', options);
    this.name = 'NotificationProposalCommitError';
  }
}

export interface NotificationDeliveryObservabilityMetrics {
  userId: number;
  tenantId: number;
  totalDecisions: number;
  pushAttemptCount: number;
  pushSentCount: number;
  pushBlockedCount: number;
  visibleDecisionPushAllowedCount: number;
  visibleDecisionPushBlockedCount: number;
  inAppOnlyCount: number;
  digestCount: number;
  blockedByReason: Record<string, number>;
}

export interface NotificationReliabilityDashboard {
  userId: number;
  tenantId: number;
  generatedAt: string;
  dedupe: {
    dedupedCount: number;
    activeDedupeKeyCount: number;
  };
  digest: {
    pendingCount: number;
    dueCount: number;
    releasedCount: number;
  };
  pushOutcome: {
    attemptCount: number;
    sentCount: number;
    blockedCount: number;
    blockedByReason: Record<string, number>;
  };
  badge: {
    expectedBadgeCount: number;
    canonicalUnreadCount: number;
    clientReportedBadgeCount: number | null;
    drift: number | null;
  };
  readState: {
    serverReadFailureCount: number;
    clientReportedReadFailureCount: number | null;
  };
  quality: {
    suppressedOrGatedCount: number;
    unsupportedActionBlockedCount: number;
    actionFailureCount: number;
    deadDeeplinkCount: number;
    genericMutatingActionSuccessCount: number;
    byTopic: NotificationReliabilityTopicBreakdown[];
  };
}

export interface NotificationReliabilityTopicBreakdown {
  sourceSkill: string;
  type: string | null;
  recipe: string | null;
  suppressedOrGatedCount: number;
  dedupedCount: number;
  supersededCount: number;
  actionFailedCount: number;
  unsupportedActionBlockedCount: number;
  deadDeeplinkCount: number;
  genericMutatingActionSuccessCount: number;
}

export type NotificationReliabilityEventType =
  | 'badge_reconciled'
  | 'read_state_failure'
  | 'server_read_failure'
  | 'action_failed'
  | 'unsupported_action_blocked'
  | 'dead_deeplink_detected'
  | 'quality_gate_blocked';

export interface NotificationReliabilityEventInput {
  userId: number;
  tenantId?: number;
  eventType: NotificationReliabilityEventType;
  badgeCount?: number | null;
  source?: string | null;
  errorCode?: string | null;
}

interface DecisionPushPlan {
  eligible: boolean;
  reason: string;
  priorityScore: number;
  interruptionLevel: 'passive' | 'active' | 'time-sensitive';
}

export interface NotificationProfilePatch {
  quietHours?: Partial<{ start: string; end: string }>;
  timezone?: string;
  pushEnabled?: boolean;
  marketingPushEnabled?: boolean;
  localEnabled?: boolean;
  emailEnabled?: boolean;
  portalEnabled?: boolean;
  inAppEnabled?: boolean;
  skillPreferences?: Partial<Record<NotificationSourceSkill, boolean>>;
  defaultReminderMinutes?: number;
  workoutReminderMinutes?: number;
  contentReminderMinutes?: number;
  financeReminderDays?: number;
  allowTimeSensitive?: boolean;
  allowCritical?: boolean;
  digestPassiveItems?: boolean;
  dailyDigestTime?: string;
  weeklyReviewDay?: number;
  weeklyReviewTime?: string;
  morningBriefingTime?: string | null;
  coachBriefingTime?: string | null;
  endOfDayTime?: string | null;
  weeklyReviewReportDay?: number | null;
  weeklyReviewReportTime?: string | null;
  doNotNotifyRules?: string[];
}

const SOURCE_SKILLS: NotificationSourceSkill[] = [
  'secretary', 'training', 'content', 'cooking', 'finance', 'chat', 'system', 'security',
];

const VALID_TYPES: NotificationIntentType[] = [
  'decision_required', 'conflict_detected', 'schedule_changed', 'reminder', 'missed_item',
  'reflow_suggestion', 'approval_required', 'risk_warning', 'daily_digest', 'weekly_review',
  'security_account', 'sync_failure', 'insight',
];

const VALID_PRIORITIES: NotificationPriority[] = ['critical', 'time_sensitive', 'active', 'passive'];
const DECISION_ACTION_TYPES = new Set<NotificationIntentType>([
  'decision_required',
  'conflict_detected',
  'reflow_suggestion',
  'approval_required',
  'sync_failure',
  'security_account',
]);
const TERMINAL_NOTIFICATION_STATUSES = new Set<NotificationCenterStatus>([
  'actioned',
  'dismissed',
  'expired',
  'superseded',
]);
const DEFAULT_TIMEZONE = 'Europe/Lisbon';

/**
 * Resolve a stored profile timezone to one Luxon can actually compute in.
 *
 * `notification_profiles.timezone` is seeded from client-reported data and has
 * never been validated on write, so values like `GMT-3` reach us. Luxon does
 * not throw on those — it returns an INVALID DateTime, and every downstream
 * expression then fails soft in whichever direction happens to be worst:
 *
 *   - `evaluateInterruptBudget` got `dayStart === null` and allowed every
 *     interrupt, disabling the daily cap entirely;
 *   - `isInQuietHours` compared NaN minutes, so quiet hours never matched and
 *     the user was woken up;
 *   - `nextQuietHoursEnd` / `nextDigestTime` produced an invalid DateTime whose
 *     `.toISO()` is null, so scheduled work lost its schedule.
 *
 * Falling back to the default zone can be off by a few hours; silently
 * disabling the cap and quiet hours cannot be recovered from at all.
 */
function resolveProfileZone(timezone: string | null | undefined): string {
  const candidate = (timezone ?? '').trim();
  if (candidate && DateTime.local().setZone(candidate).isValid) return candidate;
  return DEFAULT_TIMEZONE;
}

function appNowIso(): string {
  return new Date(Date.now()).toISOString();
}

export function ensureNotificationTables(): void {
  const db = getDb();
  db.exec(`
    -- Migration 275 owns this shared operational table in production. Keep
    -- the same additive definition here because this service's isolated test
    -- databases are intentionally bootstrapped through ensureNotificationTables.
    CREATE TABLE IF NOT EXISTS scheduled_job_execution_state (
      job_name TEXT NOT NULL CHECK (length(job_name) BETWEEN 1 AND 120),
      scope_key TEXT NOT NULL CHECK (length(scope_key) BETWEEN 1 AND 240),
      lease_owner TEXT,
      lease_token TEXT,
      lease_expires_at TEXT,
      last_started_at TEXT,
      last_completed_at TEXT,
      last_succeeded_at TEXT,
      last_result TEXT CHECK (last_result IS NULL OR last_result IN ('success', 'skipped', 'failed')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (job_name, scope_key),
      CHECK (
        (lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL)
        OR
        (lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
      )
    );
    CREATE INDEX IF NOT EXISTS idx_scheduled_job_execution_active_lease
      ON scheduled_job_execution_state(lease_expires_at)
      WHERE lease_token IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_scheduled_job_execution_checkpoint
      ON scheduled_job_execution_state(job_name, last_succeeded_at);
    CREATE TABLE IF NOT EXISTS notification_profiles (
      user_id INTEGER NOT NULL,
      tenant_id INTEGER NOT NULL,
      quiet_hours_start TEXT NOT NULL DEFAULT '22:00',
      quiet_hours_end TEXT NOT NULL DEFAULT '07:00',
      timezone TEXT NOT NULL DEFAULT '${DEFAULT_TIMEZONE}',
      push_enabled INTEGER NOT NULL DEFAULT 1,
      local_enabled INTEGER NOT NULL DEFAULT 1,
      email_enabled INTEGER NOT NULL DEFAULT 0,
      portal_enabled INTEGER NOT NULL DEFAULT 1,
      in_app_enabled INTEGER NOT NULL DEFAULT 1,
      secretary_enabled INTEGER NOT NULL DEFAULT 1,
      training_enabled INTEGER NOT NULL DEFAULT 1,
      content_enabled INTEGER NOT NULL DEFAULT 1,
      cooking_enabled INTEGER NOT NULL DEFAULT 1,
      finance_enabled INTEGER NOT NULL DEFAULT 1,
      chat_enabled INTEGER NOT NULL DEFAULT 1,
      system_enabled INTEGER NOT NULL DEFAULT 1,
      security_enabled INTEGER NOT NULL DEFAULT 1,
      default_reminder_minutes INTEGER NOT NULL DEFAULT 30,
      workout_reminder_minutes INTEGER NOT NULL DEFAULT 60,
      content_reminder_minutes INTEGER NOT NULL DEFAULT 120,
      finance_reminder_days INTEGER NOT NULL DEFAULT 1,
      allow_time_sensitive INTEGER NOT NULL DEFAULT 1,
      allow_critical INTEGER NOT NULL DEFAULT 0,
      digest_passive_items INTEGER NOT NULL DEFAULT 1,
      daily_digest_time TEXT NOT NULL DEFAULT '08:30',
      weekly_review_day INTEGER NOT NULL DEFAULT 1,
      weekly_review_time TEXT NOT NULL DEFAULT '09:00',
      morning_briefing_time TEXT,
      coach_briefing_time TEXT,
      end_of_day_time TEXT,
      weekly_review_report_day INTEGER,
      weekly_review_report_time TEXT,
      do_not_notify_rules_json TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, tenant_id)
    );
    CREATE TABLE IF NOT EXISTS notification_intents (
      intent_id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      tenant_id INTEGER NOT NULL,
      source_skill TEXT NOT NULL,
      type TEXT NOT NULL,
      priority TEXT NOT NULL,
      related_entity_id TEXT,
      related_entity_type TEXT,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      sensitive_body TEXT,
      action_buttons_json TEXT NOT NULL DEFAULT '[]',
      deeplink TEXT,
      expires_at TEXT,
      quiet_hours_policy TEXT NOT NULL DEFAULT 'respect',
      dedupe_key TEXT,
      requires_user_action INTEGER NOT NULL DEFAULT 0,
      decision_deadline TEXT,
      delivery_policy TEXT NOT NULL DEFAULT 'auto',
      privacy_policy TEXT NOT NULL DEFAULT 'standard',
      decision_context_json TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS notification_center_items (
      item_id TEXT PRIMARY KEY,
      intent_id TEXT NOT NULL,
      decision_log_id TEXT,
      user_id INTEGER NOT NULL,
      tenant_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      safe_body TEXT NOT NULL,
      sensitive_body TEXT,
      source_skill TEXT NOT NULL,
      type TEXT NOT NULL,
      priority TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'unread',
      deeplink TEXT,
      actions_json TEXT NOT NULL DEFAULT '[]',
      dedupe_key TEXT,
      requires_user_action INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT,
      read_at TEXT,
      dismissed_at TEXT,
      actioned_at TEXT,
      superseded_by_item_id TEXT
    );
    CREATE TABLE IF NOT EXISTS notification_decision_logs (
      decision_log_id TEXT PRIMARY KEY,
      notification_id TEXT,
      intent_id TEXT,
      user_id INTEGER NOT NULL,
      tenant_id INTEGER NOT NULL,
      source_skill TEXT NOT NULL,
      source_entity_id TEXT,
      decision TEXT NOT NULL,
      priority TEXT NOT NULL,
      reason TEXT NOT NULL,
      dedupe_key TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      scheduled_for TEXT,
      sent_at TEXT,
      opened_at TEXT,
      action_taken TEXT,
      delivery_attempt_ids_json TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE IF NOT EXISTS notification_delivery_attempts (
      attempt_id TEXT PRIMARY KEY,
      notification_id TEXT,
      intent_id TEXT,
      user_id INTEGER NOT NULL,
      tenant_id INTEGER NOT NULL,
      channel TEXT NOT NULL,
      provider TEXT NOT NULL,
      status TEXT NOT NULL,
      provider_response_code TEXT,
      error_code TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      sent_at TEXT
    );
    CREATE TABLE IF NOT EXISTS notification_reliability_events (
      event_id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      tenant_id INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      badge_count INTEGER,
      source TEXT,
      error_code TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS notification_device_tokens (
      token_id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      tenant_id INTEGER NOT NULL,
      platform TEXT NOT NULL DEFAULT 'ios',
      token_hash TEXT NOT NULL,
      token_suffix TEXT NOT NULL,
      environment TEXT NOT NULL DEFAULT 'sandbox',
      device_id TEXT,
      app_version TEXT,
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      revoked_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, tenant_id, platform, token_hash, environment)
    );
    CREATE TABLE IF NOT EXISTS ios_devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      device_id TEXT NOT NULL UNIQUE,
      device_name TEXT,
      push_token TEXT,
      refresh_token TEXT,
      refresh_token_hash TEXT,
      previous_refresh_token_hash TEXT,
      last_active_at TEXT DEFAULT (datetime('now')),
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_notification_center_scope_status_created
      ON notification_center_items(user_id, tenant_id, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_notification_center_dedupe
      ON notification_center_items(user_id, tenant_id, dedupe_key, status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_intents_dedupe_unique
      ON notification_intents(user_id, tenant_id, source_skill, dedupe_key)
      WHERE dedupe_key IS NOT NULL AND status != 'expired';
    DROP INDEX IF EXISTS idx_notification_center_items_dedupe_unique;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_center_items_dedupe_unique
      ON notification_center_items(user_id, tenant_id, source_skill, dedupe_key)
      WHERE dedupe_key IS NOT NULL AND status NOT IN ('expired','actioned','dismissed','superseded');
    CREATE INDEX IF NOT EXISTS idx_notification_decision_logs_scope_created
      ON notification_decision_logs(user_id, tenant_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_notification_delivery_attempts_notification
      ON notification_delivery_attempts(notification_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_notification_reliability_events_scope_type_created
      ON notification_reliability_events(user_id, tenant_id, event_type, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_notification_device_tokens_scope_active
      ON notification_device_tokens(user_id, tenant_id, platform, revoked_at);
    CREATE INDEX IF NOT EXISTS idx_ios_devices_user ON ios_devices(user_id);
    CREATE TABLE IF NOT EXISTS notification_priority_shadow (
      shadow_id TEXT PRIMARY KEY,
      intent_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      tenant_id INTEGER NOT NULL,
      source_skill TEXT NOT NULL,
      type TEXT NOT NULL,
      declared_priority TEXT NOT NULL,
      effective_priority TEXT NOT NULL,
      actual_decision TEXT NOT NULL,
      model_version INTEGER NOT NULL,
      score INTEGER NOT NULL,
      tier TEXT NOT NULL,
      reason_codes_json TEXT NOT NULL DEFAULT '[]',
      components_json TEXT NOT NULL DEFAULT '{}',
      features_complete INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    -- Mirrors migration 270. Every other notification table's indexes are
    -- mirrored here; this one was the sole omission, so a database built by
    -- ensureNotificationTables alone scanned the shadow table.
    CREATE INDEX IF NOT EXISTS idx_notification_priority_shadow_scope_created
      ON notification_priority_shadow(user_id, tenant_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_notification_priority_shadow_compare
      ON notification_priority_shadow(tier, actual_decision, created_at DESC);
    CREATE TABLE IF NOT EXISTS notification_engagement_events (
      event_id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      tenant_id INTEGER NOT NULL,
      notification_id TEXT,
      intent_id TEXT,
      source_skill TEXT NOT NULL,
      type TEXT NOT NULL,
      priority TEXT NOT NULL,
      event_type TEXT NOT NULL,
      action_id TEXT,
      latency_ms INTEGER,
      flag_vector_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    -- Migration 063 owns this legacy iOS preference table in production.
    -- Keep it in the explicit bootstrap helper as well so an isolated test or
    -- recovery database created through ensureNotificationTables has the same
    -- notification contract. Runtime request paths do not call this helper.
    CREATE TABLE IF NOT EXISTS push_preferences (
      user_id INTEGER NOT NULL,
      category TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, category)
    );
    CREATE INDEX IF NOT EXISTS idx_notification_engagement_scope_type_created
      ON notification_engagement_events(user_id, tenant_id, source_skill, type, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_notification_engagement_event_type_created
      ON notification_engagement_events(event_type, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_notification_engagement_notification
      ON notification_engagement_events(notification_id, created_at DESC);
  `);
  ensureColumn('notification_center_items', 'sensitive_body', 'TEXT');
  ensureColumn('notification_center_items', 'snoozed_until', 'TEXT');
  ensureColumn('notification_center_items', 'snooze_count', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('notification_center_items', 'last_pushed_at', 'TEXT');
  ensureColumn('notification_center_items', 'priority_score', 'INTEGER');
  ensureColumn('notification_center_items', 'requires_user_action', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('notification_intents', 'decision_context_json', 'TEXT');
  ensureColumn('notification_intents', 'promotional', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('notification_device_tokens', 'device_timezone', 'TEXT');
  ensureColumn('notification_device_tokens', 'device_timezone_reported_at', 'TEXT');
  ensureColumn('notification_device_tokens', 'authorization_tier', "TEXT NOT NULL DEFAULT 'authorized'");
  ensureColumn('notification_profiles', 'marketing_push_enabled', 'INTEGER NOT NULL DEFAULT 0');
  backfillNotificationCenterActionability();
  getDb().prepare(`
    CREATE INDEX IF NOT EXISTS idx_notification_center_badge_actionable
      ON notification_center_items(user_id, tenant_id, status, requires_user_action, expires_at)
  `).run();
  // Legacy explicit bootstrap compatibility. Production request paths never
  // call this helper; migrations own both the column and this index.
  getDb().prepare(`
    CREATE INDEX IF NOT EXISTS idx_notification_center_snoozed_due
      ON notification_center_items(user_id, tenant_id, status, snoozed_until)
  `).run();
}

/**
 * Read-only profile lookup: returns null when no row exists, never inserts.
 * The report-schedule dispatcher uses this on every 5-minute tick so idle
 * resolution costs zero writes (QA finding: the get-or-create variant was
 * attempting an INSERT per user/job/tick). Row creation stays with the
 * preferences API and other explicit getOrCreate callers.
 */
export function getNotificationProfileIfExists(userId: number, tenantId = userId): NotificationProfile | null {
  assertScope(userId, tenantId, 'get_notification_profile');
  const row = getDb().prepare(`
    SELECT * FROM notification_profiles
    WHERE user_id = ? AND tenant_id = ?
  `).get(userId, tenantId) as any;
  return row ? mapProfile(row) : null;
}

// New profile rows inherit the canonical user timezone (users.timezone via
// user-service) instead of the schema default — otherwise quiet hours and
// report schedules for a Sao Paulo user would silently run on Lisbon time
// until they opened notification settings. Explicit profile timezone
// preferences are untouched: seeding only happens at row creation.
function resolveInitialProfileTimezone(userId: number): string {
  try {
    return getUserTimezoneById(userId) || DEFAULT_TIMEZONE;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

export function getOrCreateNotificationProfile(userId: number, tenantId = userId): NotificationProfile {
  assertScope(userId, tenantId, 'get_notification_profile');
  const db = getDb();
  const existing = getNotificationProfileIfExists(userId, tenantId);
  if (existing) return existing;

  db.prepare(`
    INSERT INTO notification_profiles (user_id, tenant_id, timezone)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id, tenant_id) DO NOTHING
  `).run(userId, tenantId, resolveInitialProfileTimezone(userId));

  const row = db.prepare(`
    SELECT * FROM notification_profiles
    WHERE user_id = ? AND tenant_id = ?
  `).get(userId, tenantId) as any;
  return mapProfile(row);
}

export interface NotificationPreferenceRejection {
  field: string;
  reason: 'unknown_field' | 'invalid_value' | 'not_implemented';
  detail: string;
}

export interface NotificationProfilePatchResult {
  profile: NotificationProfile;
  /** Fields whose supplied value was accepted and persisted. */
  applied: string[];
  /** Fields the caller sent that did NOT take effect, and why. */
  rejected: NotificationPreferenceRejection[];
}

const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;

const NOTIFICATION_SOURCE_SKILLS: readonly NotificationSourceSkill[] = [
  'secretary', 'training', 'content', 'cooking', 'finance', 'chat', 'system', 'security',
];

/**
 * Preference keys a client may legitimately send. Anything else is reported
 * back as `unknown_field` rather than silently dropped.
 */
const KNOWN_PREFERENCE_FIELDS = new Set([
  'quietHours', 'timezone', 'pushEnabled', 'marketingPushEnabled', 'localEnabled', 'emailEnabled', 'portalEnabled',
  'inAppEnabled', 'skillPreferences', 'defaultReminderMinutes', 'workoutReminderMinutes',
  'contentReminderMinutes', 'financeReminderDays', 'allowTimeSensitive', 'allowCritical',
  'digestPassiveItems', 'dailyDigestTime', 'weeklyReviewDay', 'weeklyReviewTime',
  'morningBriefingTime', 'coachBriefingTime', 'endOfDayTime', 'weeklyReviewReportDay',
  'weeklyReviewReportTime', 'doNotNotifyRules',
]);

/**
 * Settings a client can send today that are read by NOTHING. They are reported
 * as `not_implemented` instead of `unknown_field` so the app can hide the
 * control rather than render a switch that changes nothing.
 *
 * `getDecisionPreferences` returns these five as hardcoded literals, so a
 * client sending `autoHideResolved: false` previously got HTTP 200 and `true`
 * back — a setting that reported success and did nothing.
 */
const NOT_IMPLEMENTED_PREFERENCE_FIELDS = new Map<string, string>([
  ['homePreviewMode', 'Decision home preview mode is not stored; the server always uses urgent_and_today.'],
  ['autoHideResolved', 'Resolved decisions are always hidden; this is not configurable.'],
  ['askBeforeScheduleChanges', 'Schedule confirmations are always required; this is not configurable.'],
  ['askBeforeContentPublishing', 'Content approvals are always required; this is not configurable.'],
  ['askBeforeTrainingReflow', 'Training reflow confirmations are always required; this is not configurable.'],
  ['localEnabled', 'No local-notification scheduling exists; this column gates nothing.'],
  ['emailEnabled', 'Email delivery is not implemented in the notification ladder.'],
  ['doNotNotifyRules', 'The do-not-notify rules engine is declared but has no evaluator.'],
  ['contentReminderMinutes', 'No content producer reads a lead time yet.'],
]);

const BOOLEAN_PREFERENCE_FIELDS = [
  'pushEnabled', 'marketingPushEnabled', 'localEnabled', 'emailEnabled', 'portalEnabled', 'inAppEnabled',
  'allowTimeSensitive', 'allowCritical', 'digestPassiveItems',
] as const;

const POSITIVE_INT_PREFERENCE_FIELDS = [
  'defaultReminderMinutes', 'workoutReminderMinutes', 'contentReminderMinutes', 'financeReminderDays',
] as const;

/**
 * Validate a preference patch and report exactly what took effect.
 *
 * Invalid values are still coerced back to the current value rather than
 * throwing — a hard 400 would break iOS builds already in the wild that send
 * fields this server does not honour. The difference is that the caller is now
 * TOLD, instead of receiving HTTP 200 and assuming the write landed.
 */
export function applyNotificationProfilePatch(
  userId: number,
  tenantId: number,
  patch: Record<string, unknown>,
): NotificationProfilePatchResult {
  const applied: string[] = [];
  const rejected: NotificationPreferenceRejection[] = [];
  const sanitized: Record<string, unknown> = {};
  const reject = (field: string, reason: NotificationPreferenceRejection['reason'], detail: string) =>
    rejected.push({ field, reason, detail });

  for (const [field, value] of Object.entries(patch ?? {})) {
    if (value === undefined) continue;

    const notImplemented = NOT_IMPLEMENTED_PREFERENCE_FIELDS.get(field);
    if (notImplemented) {
      // Persist it anyway when the column exists, so the value survives a
      // future wiring, but never claim it is in effect.
      if (KNOWN_PREFERENCE_FIELDS.has(field)) sanitized[field] = value;
      reject(field, 'not_implemented', notImplemented);
      continue;
    }
    if (!KNOWN_PREFERENCE_FIELDS.has(field)) {
      reject(field, 'unknown_field', `'${field}' is not a notification preference.`);
      continue;
    }

    if ((BOOLEAN_PREFERENCE_FIELDS as readonly string[]).includes(field)) {
      if (typeof value !== 'boolean') { reject(field, 'invalid_value', 'expected a boolean'); continue; }
      sanitized[field] = value; applied.push(field); continue;
    }
    if ((POSITIVE_INT_PREFERENCE_FIELDS as readonly string[]).includes(field)) {
      if (!Number.isInteger(value) || (value as number) <= 0) {
        reject(field, 'invalid_value', 'expected a positive whole number of minutes/days'); continue;
      }
      sanitized[field] = value; applied.push(field); continue;
    }
    if (field === 'dailyDigestTime' || field === 'weeklyReviewTime') {
      if (typeof value !== 'string' || !HH_MM.test(value)) {
        reject(field, 'invalid_value', 'expected HH:MM (24-hour)'); continue;
      }
      sanitized[field] = value; applied.push(field); continue;
    }
    if (field === 'weeklyReviewDay') {
      if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 6) {
        reject(field, 'invalid_value', 'expected 0 (Sunday) through 6 (Saturday)'); continue;
      }
      sanitized[field] = value; applied.push(field); continue;
    }
    if (field === 'timezone') {
      if (typeof value !== 'string' || !value.trim() || !DateTime.local().setZone(value).isValid) {
        reject(field, 'invalid_value', 'expected a valid IANA timezone, e.g. Europe/Lisbon'); continue;
      }
      sanitized[field] = value.trim(); applied.push(field); continue;
    }
    if (field === 'quietHours') {
      const qh = value as { start?: unknown; end?: unknown } | null;
      if (!qh || typeof qh !== 'object') { reject(field, 'invalid_value', 'expected { start, end }'); continue; }
      const start = qh.start === undefined ? undefined : String(qh.start);
      const end = qh.end === undefined ? undefined : String(qh.end);
      if ((start !== undefined && !HH_MM.test(start)) || (end !== undefined && !HH_MM.test(end))) {
        reject(field, 'invalid_value', 'quiet hours must be HH:MM (24-hour)'); continue;
      }
      const current = getOrCreateNotificationProfile(userId, tenantId).quietHours;
      if ((start ?? current.start) === (end ?? current.end)) {
        reject(field, 'invalid_value', 'quiet hours start and end must differ'); continue;
      }
      sanitized[field] = { ...(start !== undefined ? { start } : {}), ...(end !== undefined ? { end } : {}) };
      applied.push(field); continue;
    }
    if (field === 'skillPreferences') {
      const prefs = value as Record<string, unknown> | null;
      if (!prefs || typeof prefs !== 'object') { reject(field, 'invalid_value', 'expected an object of skill booleans'); continue; }
      const clean: Record<string, boolean> = {};
      let bad = false;
      for (const [skill, on] of Object.entries(prefs)) {
        if (!NOTIFICATION_SOURCE_SKILLS.includes(skill as NotificationSourceSkill)) {
          reject(`skillPreferences.${skill}`, 'unknown_field', `'${skill}' is not a skill.`); bad = true; continue;
        }
        if (typeof on !== 'boolean') {
          reject(`skillPreferences.${skill}`, 'invalid_value', 'expected a boolean'); bad = true; continue;
        }
        clean[skill] = on;
      }
      if (Object.keys(clean).length > 0) { sanitized[field] = clean; if (!bad) applied.push(field); }
      continue;
    }
    // Nullable schedule overrides — these already throw on bad input, so
    // validate here and report rather than letting the request 400 wholesale.
    if (field === 'weeklyReviewReportDay') {
      if (value !== null && (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 6)) {
        reject(field, 'invalid_value', 'expected 0-6 or null'); continue;
      }
      sanitized[field] = value; applied.push(field); continue;
    }
    if (typeof value === 'string' || value === null) {
      if (value !== null && !HH_MM.test(value)) { reject(field, 'invalid_value', 'expected HH:MM (24-hour) or null'); continue; }
      sanitized[field] = value; applied.push(field); continue;
    }
    reject(field, 'invalid_value', 'unsupported value type');
  }

  const profile = updateNotificationProfile(userId, tenantId, sanitized as NotificationProfilePatch);
  return { profile, applied, rejected };
}

export function updateNotificationProfile(userId: number, tenantId: number, patch: NotificationProfilePatch): NotificationProfile {
  const current = getOrCreateNotificationProfile(userId, tenantId);
  const skillPrefs = { ...current.skillPreferences, ...(patch.skillPreferences ?? {}) };
  const quietHours = { ...current.quietHours, ...(patch.quietHours ?? {}) };
  const quietHoursStart = normalizeTime(patch.quietHours?.start ?? quietHours.start, current.quietHours.start);
  const quietHoursEnd = normalizeTime(patch.quietHours?.end ?? quietHours.end, current.quietHours.end);
  if (quietHoursStart === quietHoursEnd) {
    throw new Error('quiet hours start and end must be different');
  }

  const db = getDb();
  db.prepare(`
    UPDATE notification_profiles SET
      quiet_hours_start = ?,
      quiet_hours_end = ?,
      timezone = ?,
      push_enabled = ?,
      marketing_push_enabled = ?,
      local_enabled = ?,
      email_enabled = ?,
      portal_enabled = ?,
      in_app_enabled = ?,
      secretary_enabled = ?,
      training_enabled = ?,
      content_enabled = ?,
      cooking_enabled = ?,
      finance_enabled = ?,
      chat_enabled = ?,
      system_enabled = ?,
      security_enabled = ?,
      default_reminder_minutes = ?,
      workout_reminder_minutes = ?,
      content_reminder_minutes = ?,
      finance_reminder_days = ?,
      allow_time_sensitive = ?,
      allow_critical = ?,
      digest_passive_items = ?,
      daily_digest_time = ?,
      weekly_review_day = ?,
      weekly_review_time = ?,
      morning_briefing_time = ?,
      coach_briefing_time = ?,
      end_of_day_time = ?,
      weekly_review_report_day = ?,
      weekly_review_report_time = ?,
      do_not_notify_rules_json = ?,
      updated_at = datetime('now')
    WHERE user_id = ? AND tenant_id = ?
  `).run(
    quietHoursStart,
    quietHoursEnd,
    stringOr(current.timezone, patch.timezone),
    boolInt(patch.pushEnabled ?? current.pushEnabled),
    boolInt(patch.marketingPushEnabled ?? current.marketingPushEnabled),
    boolInt(patch.localEnabled ?? current.localEnabled),
    boolInt(patch.emailEnabled ?? current.emailEnabled),
    boolInt(patch.portalEnabled ?? current.portalEnabled),
    boolInt(patch.inAppEnabled ?? current.inAppEnabled),
    boolInt(skillPrefs.secretary),
    boolInt(skillPrefs.training),
    boolInt(skillPrefs.content),
    boolInt(skillPrefs.cooking),
    boolInt(skillPrefs.finance),
    boolInt(skillPrefs.chat),
    boolInt(skillPrefs.system),
    boolInt(skillPrefs.security),
    positiveIntOr(patch.defaultReminderMinutes, current.defaultReminderMinutes),
    positiveIntOr(patch.workoutReminderMinutes, current.workoutReminderMinutes),
    positiveIntOr(patch.contentReminderMinutes, current.contentReminderMinutes),
    positiveIntOr(patch.financeReminderDays, current.financeReminderDays),
    boolInt(patch.allowTimeSensitive ?? current.allowTimeSensitive),
    boolInt(patch.allowCritical ?? current.allowCritical),
    boolInt(patch.digestPassiveItems ?? current.digestPassiveItems),
    normalizeTime(patch.dailyDigestTime ?? current.dailyDigestTime, current.dailyDigestTime),
    boundedIntOr(patch.weeklyReviewDay, current.weeklyReviewDay, 0, 6),
    normalizeTime(patch.weeklyReviewTime ?? current.weeklyReviewTime, current.weeklyReviewTime),
    normalizeNullableTime(patch.morningBriefingTime, current.morningBriefingTime),
    normalizeNullableTime(patch.coachBriefingTime, current.coachBriefingTime),
    normalizeNullableTime(patch.endOfDayTime, current.endOfDayTime),
    normalizeNullableDay(patch.weeklyReviewReportDay, current.weeklyReviewReportDay),
    normalizeNullableTime(patch.weeklyReviewReportTime, current.weeklyReviewReportTime),
    JSON.stringify(Array.isArray(patch.doNotNotifyRules) ? patch.doNotNotifyRules : current.doNotNotifyRules),
    userId,
    tenantId,
  );

  return getOrCreateNotificationProfile(userId, tenantId);
}

/**
 * Serializes notification evaluation per user.
 *
 * The interrupt budget is a check-then-act across an await:
 * `evaluateInterruptBudget` counts today's `sent_push` rows, the caller then
 * awaits an APNs round trip, and only afterwards writes its own row. Two
 * evaluations for the same user that interleave on that await BOTH read the
 * pre-push count, so both pass a cap that should have admitted one — and the
 * caps then bind at an arbitrary multiple of their configured value.
 *
 * This is not an exotic-load scenario. `training_session_reminder` and
 * `commitment_start_reminder` share a `*!/5 * * * *` schedule, and wrapJob's
 * in-flight guard is keyed by job NAME, so it does nothing to stop two
 * different jobs interleaving across their APNs awaits.
 *
 * better-sqlite3 being synchronous does not help: the yield is in the
 * orchestrator, not in the driver. Serializing per user is enough — the budget
 * is per user — and it keeps unrelated users fully concurrent.
 */
const evaluationChains = new Map<string, Promise<void>>();

async function withUserEvaluationLock<T>(
  userId: number,
  tenantId: number,
  fn: () => Promise<T>,
): Promise<T> {
  const key = `${tenantId}:${userId}`;
  const prior = evaluationChains.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  // Successors wait on `gate`, never on `fn` itself, so one failed evaluation
  // does not reject the whole chain behind it.
  const chain = prior.then(() => gate);
  evaluationChains.set(key, chain);
  await prior;
  try {
    return await fn();
  } finally {
    release();
    // Only the tail clears the entry, so the map does not grow per user forever
    // and a queued successor is never orphaned.
    if (evaluationChains.get(key) === chain) evaluationChains.delete(key);
  }
}

export function createNotificationIntent(
  input: NotificationIntentInput,
  options: NotificationIntentCreateOptions = {},
): Promise<NotificationEvaluationResult> {
  return withUserEvaluationLock(
    Number(input.userId),
    Number(input.tenantId ?? input.userId),
    () => runNotificationIntentEvaluation(input, options),
  );
}

async function runNotificationIntentEvaluation(
  input: NotificationIntentInput,
  options: NotificationIntentCreateOptions,
): Promise<NotificationEvaluationResult> {
  const normalized = normalizeIntent(input);
  expireStaleNotificationIntents();
  const budget = consumeResourceBudget({
    tenantId: normalized.tenantId,
    userId: normalized.userId,
    budgetKey: `notification_intent_create:${normalized.sourceSkill}`,
    limit: 60,
    windowSeconds: 60,
  });
  if (!budget.allowed) {
    throw new Error('notification intent rate limited');
  }
  const existingDuplicate = resolveActiveDuplicateEvaluation(normalized);
  if (existingDuplicate) return existingDuplicate;

  let intent: NotificationIntentRecord;
  let precommittedItem: NotificationCenterItem | undefined;
  let precommittedDecisionLog: NotificationDecisionLog | undefined;
  try {
    const profile = options.atomicItemProposal
      ? getOrCreateNotificationProfile(normalized.userId, normalized.tenantId)
      : null;
    const shouldPersistItemAtomically = profile !== null
      && profile.skillPreferences[normalized.sourceSkill]
      && (profile.inAppEnabled || profile.portalEnabled || profile.pushEnabled);
    const proposal = runOutboxTransaction((emitDomainEvent) => {
      const persisted = persistIntent(normalized);
      emitDomainEvent({
        tenantId: persisted.tenantId,
        userId: persisted.userId,
        sourceSkill: 'notification',
        eventType: 'notification.intent.created',
        entityType: 'notification_intent',
        entityId: persisted.intentId,
        payload: {
          summary: {
            sourceSkill: persisted.sourceSkill,
            type: persisted.type,
            priority: persisted.priority,
            requiresUserAction: persisted.requiresUserAction,
          },
          action: 'created',
        },
        privacyClassification: persisted.privacyPolicy === 'financial' ? 'financial' : persisted.privacyPolicy === 'health' ? 'health' : 'internal',
        idempotencyKey: `notification.intent.created:${persisted.tenantId}:${persisted.userId}:${persisted.intentId}`,
      });
      emitSourceSkillEventForIntent(persisted, emitDomainEvent);
      let item: NotificationCenterItem | undefined;
      let proposalDisposition: { suppressDelivery: true; reason: string } | undefined;
      if (shouldPersistItemAtomically) {
        const effectivePriority = normalizePriorityForPolicy(persisted.priority, profile);
        const safeBody = buildPrivacySafeBody(persisted, notificationCopyLanguage(persisted.userId));
        item = persistCenterItem(persisted, effectivePriority, safeBody);
        const callbackDisposition = options.onItemPersistedInTransaction?.({
          intent: persisted,
          item,
          effectivePriority,
        });
        if (callbackDisposition) proposalDisposition = callbackDisposition;
      }
      let decisionLog: NotificationDecisionLog | undefined;
      if (proposalDisposition?.suppressDelivery) {
        decisionLog = persistDecisionLog({
          intent: persisted,
          notificationId: item?.itemId ?? null,
          decision: 'deduped',
          priority: item?.priority ?? persisted.priority,
          reason: proposalDisposition.reason,
          scheduledFor: null,
          sentAt: null,
          deliveryAttemptIds: [],
        });
        if (item) attachDecisionLog(item.itemId, decisionLog.decisionLogId);
        markIntentStatus(persisted.intentId, 'deduped');
      } else {
        enqueueJob({
          tenantId: persisted.tenantId,
          userId: persisted.userId,
          jobType: 'deliver_notification',
          payload: { intentId: persisted.intentId },
          priority: persisted.priority === 'time_sensitive' || persisted.priority === 'critical' ? 10 : 50,
          idempotencyKey: `deliver_notification:${persisted.intentId}`,
        });
      }
      return { intent: persisted, item, decisionLog };
    });
    intent = proposal.intent;
    precommittedItem = proposal.item;
    precommittedDecisionLog = proposal.decisionLog;
  } catch (err) {
    if (isNotificationDedupeConstraintError(err)) {
      expireStaleNotificationIntents();
      const duplicate = resolveActiveDuplicateEvaluation(normalized);
      if (duplicate) return duplicate;
    }
    if (options.atomicItemProposal && options.onItemPersistedInTransaction) {
      throw new NotificationProposalCommitError(normalized.intentId, { cause: err });
    }
    throw err;
  }
  if (precommittedDecisionLog) {
    return {
      intent: { ...intent, status: 'deduped' },
      item: precommittedItem ?? null,
      decisionLog: precommittedDecisionLog,
      deliveryAttempts: [],
      pushPayload: null,
    };
  }
  return evaluateNotificationIntent(
    intent.intentId,
    intent.userId,
    intent.tenantId,
    options,
    precommittedItem,
  );
}

function emitSourceSkillEventForIntent(
  intent: NotificationIntentRecord,
  emit: typeof emitDomainEvent = emitDomainEvent,
): void {
  const mapped = sourceSkillEventForIntent(intent);
  if (!mapped) return;
  emit({
    tenantId: intent.tenantId,
    userId: intent.userId,
    sourceSkill: mapped.sourceSkill,
    eventType: mapped.eventType,
    entityType: intent.relatedEntityType || 'notification_intent',
    entityId: intent.relatedEntityId || intent.intentId,
    payload: {
      summary: {
        notificationType: intent.type,
        priority: intent.priority,
        requiresUserAction: intent.requiresUserAction,
      },
      action: 'updated',
    },
    privacyClassification: intent.privacyPolicy === 'financial' ? 'financial' : intent.privacyPolicy === 'health' ? 'health' : 'internal',
    idempotencyKey: `${mapped.eventType}:${intent.tenantId}:${intent.userId}:${intent.intentId}`,
  });
}

function sourceSkillEventForIntent(intent: NotificationIntentRecord): { sourceSkill: 'chat' | 'secretary' | 'training' | 'content' | 'cooking' | 'finance' | 'system'; eventType: string } | null {
  if (intent.sourceSkill === 'secretary') {
    if (intent.type === 'conflict_detected') return { sourceSkill: 'secretary', eventType: 'secretary.conflict.detected' };
    if (intent.type === 'reflow_suggestion') return { sourceSkill: 'secretary', eventType: 'secretary.reflow.suggested' };
    return { sourceSkill: 'secretary', eventType: 'secretary.agenda_item.updated' };
  }
  if (intent.sourceSkill === 'training') return { sourceSkill: 'training', eventType: 'training.session.updated' };
  if (intent.sourceSkill === 'content') return { sourceSkill: 'content', eventType: 'content.idea.updated' };
  if (intent.sourceSkill === 'cooking') return { sourceSkill: 'cooking', eventType: 'cooking.meal_plan.updated' };
  if (intent.sourceSkill === 'finance') return { sourceSkill: 'finance', eventType: 'finance.expense.created' };
  if (intent.sourceSkill === 'chat') return { sourceSkill: 'chat', eventType: 'chat.message.created' };
  if (intent.sourceSkill === 'system' || intent.sourceSkill === 'security') return { sourceSkill: 'system', eventType: 'notification.item.updated' };
  return null;
}

const NOTIFICATION_DELIVERY_JOB_NAME = 'notification:deliver_intent';
const NOTIFICATION_DELIVERY_LEASE_TTL_MS = 10 * 60_000;
const NOTIFICATION_DELIVERY_LEASE_HEARTBEAT_MS = Math.floor(
  NOTIFICATION_DELIVERY_LEASE_TTL_MS / 3,
);

export function notificationIntentDeliveryScopeKey(
  intentId: string,
  userId: number,
  tenantId = userId,
): string {
  assertScope(userId, tenantId, 'notification_intent_delivery_scope', { intentId });
  if (typeof intentId !== 'string' || intentId.trim() === '') {
    throw new Error('notification delivery intentId is required');
  }
  const intentHash = createHash('sha256').update(intentId).digest('hex').slice(0, 32);
  return `tenant:${tenantId}:user:${userId}:intent:${intentHash}`;
}

async function withNotificationIntentDeliveryLease<T>(
  intentId: string,
  userId: number,
  tenantId: number,
  work: () => Promise<T>,
): Promise<T> {
  ensureNotificationTables();
  const db = getDb();
  const claim = claimScheduledJobExecution({
    jobName: NOTIFICATION_DELIVERY_JOB_NAME,
    scopeKey: notificationIntentDeliveryScopeKey(intentId, userId, tenantId),
    leaseTtlMs: NOTIFICATION_DELIVERY_LEASE_TTL_MS,
  }, db);
  if (claim.kind !== 'claimed') {
    throw new Error(`notification delivery already in progress for ${intentId}`);
  }

  const heartbeatState = { leaseLost: false };
  const heartbeat = setInterval(() => {
    if (heartbeatState.leaseLost) return;
    try {
      heartbeatState.leaseLost = !renewScheduledJobExecution(
        claim,
        db,
        new Date(),
        NOTIFICATION_DELIVERY_LEASE_TTL_MS,
      );
    } catch {
      heartbeatState.leaseLost = true;
    }
  }, NOTIFICATION_DELIVERY_LEASE_HEARTBEAT_MS);
  heartbeat.unref();

  try {
    const result = await work();
    if (
      heartbeatState.leaseLost
      || !isScheduledJobExecutionLeaseActive(claim, db)
      || !completeScheduledJobExecution(claim, 'success', db)
    ) {
      throw new Error(`notification delivery lease lost for ${intentId}`);
    }
    return result;
  } catch (error) {
    try {
      if (!completeScheduledJobExecution(claim, 'failed', db)) {
        logger.warn({ intentId, userId, tenantId }, 'Notification delivery lease was replaced before failure checkpoint');
      }
    } catch (completionError) {
      logger.warn({ err: completionError, intentId, userId, tenantId }, 'Notification delivery lease failure checkpoint could not be written');
    }
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
}

export async function evaluateNotificationIntent(
  intentId: string,
  userId: number,
  tenantId = userId,
  options: NotificationIntentCreateOptions = {},
  precommittedItem?: NotificationCenterItem,
): Promise<NotificationEvaluationResult> {
  assertScope(userId, tenantId, 'evaluate_notification_intent', { intentId });
  const db = getDb();
  const intentRow = db.prepare(`
    SELECT * FROM notification_intents
    WHERE intent_id = ? AND user_id = ? AND tenant_id = ?
  `).get(intentId, userId, tenantId) as any;

  if (!intentRow) {
    throw new Error('notification intent not found for authenticated user');
  }

  const intent = mapIntent(intentRow);
  const profile = getOrCreateNotificationProfile(userId, tenantId);
  const effectivePriority = normalizePriorityForPolicy(intent.priority, profile);
  // Resolved ONCE per evaluation. Each helper resolving the language on its own
  // made this two indexed `users` lookups per notification — twice the cost the
  // localization design note documents, and two for `daily_digest` too, the one
  // branch that then discards the value.
  const copyLanguage = notificationCopyLanguage(intent.userId);
  const safeBody = buildPrivacySafeBody(intent, copyLanguage);
  const pushPayload = {
    title: safeNotificationTitle(intent, copyLanguage),
    body: safeBody,
    deeplink: intent.deeplink,
    actions: intent.actionButtons,
    interruptionLevel: interruptionLevelForPriority(effectivePriority),
  };
  const effectiveIntent = { ...intent, priority: effectivePriority };
  const decisionPushPlan = buildDecisionPushPlan(effectiveIntent, pushPayload);
  if (decisionPushPlan?.eligible) {
    pushPayload.interruptionLevel = decisionPushPlan.interruptionLevel;
  }

  if (!profile.skillPreferences[intent.sourceSkill] || (!profile.inAppEnabled && !profile.portalEnabled && !profile.pushEnabled)) {
    const log = persistDecisionLog({
      intent,
      notificationId: null,
      decision: 'blocked_user_preferences',
      priority: effectivePriority,
      reason: `notifications disabled for ${intent.sourceSkill}`,
      scheduledFor: null,
      sentAt: null,
      deliveryAttemptIds: [],
    });
    markIntentStatus(intent.intentId, 'suppressed');
    return { intent: { ...intent, priority: effectivePriority, status: 'suppressed' }, item: null, decisionLog: log, deliveryAttempts: [], pushPayload: null };
  }

  const duplicate = precommittedItem ? null : findActiveDuplicate(intent);
  if (duplicate) {
    const log = persistDecisionLog({
      intent,
      notificationId: duplicate.itemId,
      decision: 'deduped',
      priority: effectivePriority,
      reason: 'active unresolved notification with same dedupe key already exists',
      scheduledFor: null,
      sentAt: null,
      deliveryAttemptIds: [],
    });
    markIntentStatus(intent.intentId, 'deduped');
    return { intent: { ...intent, priority: effectivePriority, status: 'deduped' }, item: duplicate, decisionLog: log, deliveryAttempts: [], pushPayload };
  }

  let item: NotificationCenterItem;
  if (precommittedItem) {
    item = precommittedItem;
  } else {
    try {
      item = db.transaction(() => {
      const persisted = persistCenterItem(intent, effectivePriority, safeBody);
      options.onItemPersistedInTransaction?.({
        intent,
        item: persisted,
        effectivePriority,
      });
      return persisted;
      })();
    } catch (cause) {
      if (options.onItemPersistedInTransaction) {
        throw new NotificationProposalCommitError(intent.intentId, { cause });
      }
      throw cause;
    }
  }
  // Denominator for every engagement rate. Recorded once the durable item
  // exists, BEFORE the delivery branches, so "surfaced but never pushed"
  // stays distinguishable from "never surfaced at all".
  recordNotificationEngagementEvent({
    userId: intent.userId,
    tenantId: intent.tenantId,
    notificationId: item.itemId,
    intentId: intent.intentId,
    sourceSkill: intent.sourceSkill,
    type: intent.type,
    priority: effectivePriority,
    eventType: 'surfaced',
  });
  const quietHours = quietHoursDecision(profile, intent, effectivePriority);
  // Read once: the cause is needed both to branch and to explain the branch.
  const suppressionCause = notificationTypeSuppressionCause(intent);
  // Compatibility bridge for the Settings toggle shipped before notification
  // profiles existed. iOS still writes push_preferences/reminders; treating it
  // as a push-only gate preserves the durable inbox item while honoring the
  // user's explicit choice not to be interrupted.
  const categoryPreferenceCause = notificationCategoryPreferenceCause(intent);
  const deliveryAttempts: DeliveryAttempt[] = [];
  let decision: NotificationDecision = 'in_app_only';
  let reason = 'stored in authenticated notification center';
  let scheduledFor: string | null = null;
  let sentAt: string | null = null;

  if (intent.deliveryPolicy === 'portal_only') {
    decision = 'portal_only';
    reason = 'delivery policy is portal only';
  } else if (intent.promotional && !profile.marketingPushEnabled) {
    // App Store 4.5.4: push must be optional AND marketing needs its own
    // opt-in. Operational consent (`pushEnabled`) does not cover a win-back or
    // an activation nudge. Default is off, so a promotional producer that
    // forgets to ask simply never interrupts.
    // The Notification Center item still exists — the user loses the interrupt,
    // not the message.
    decision = 'in_app_only';
    reason = 'promotional notification without marketing consent';
  } else if (suppressionCause) {
    // "Don't show me this type" previously bound only on the read path, so the
    // list hid the row and the push fired anyway. The durable item above still
    // exists (the read filter hides it, and unmuting brings it back); only the
    // interrupt and the digest slot are withheld.
    decision = 'suppressed';
    reason = suppressionCause === 'user_muted'
      ? `user muted ${intent.sourceSkill}/${intent.type} notifications`
      : `suppression state unreadable for ${intent.sourceSkill}/${intent.type}; withheld fail-closed`;
  } else if (categoryPreferenceCause) {
    decision = 'in_app_only';
    reason = categoryPreferenceCause === 'user_disabled'
      ? 'push disabled by reminders category preference'
      : 'reminders category preference unreadable; push withheld fail-closed';
  } else if (intent.type === 'daily_digest' && hasUnreadDigestStreak(intent.userId, intent.tenantId, item.itemId)) {
    // Engagement gate (2026-07-04): prod showed 629 of 738 items were never
    // read — pushing the Nth identical digest at a user who ignored the
    // last N is pure notification fatigue. The center item above is still
    // created; only the push/digest release is suppressed.
    decision = 'suppressed';
    reason = `daily digest push suppressed: last ${digestUnreadStreakThreshold()} digests were never opened`;
  } else if (intent.deliveryPolicy === 'in_app_only') {
    // An explicit per-intent delivery contract outranks the user's global
    // "hold passive items for the digest" preference. Testing the digest branch
    // first routed `in_app_only` intents INTO the digest push channel — the
    // contract said never push, `digestPassiveItems` defaults true, and the
    // only thing between such an intent and APNs was the digest group's own
    // eligibility check. (`portal_only` is already returned above, at the top
    // of this function.)
    decision = 'in_app_only';
    reason = 'delivery policy is in-app only';
  } else if (intent.deliveryPolicy === 'digest_only' || (intent.priority === 'passive' && profile.digestPassiveItems)) {
    decision = 'digest';
    reason = 'passive notification held for digest';
    scheduledFor = nextDigestTime(profile, intent.type).toISO();
  } else if (quietHours.delayed) {
    decision = 'quiet_hours_delayed';
    reason = quietHours.reason;
    scheduledFor = quietHours.scheduledFor;
  } else if (!profile.pushEnabled) {
    decision = 'in_app_only';
    reason = 'push disabled by user preference';
  } else {
    const interruptBudget = evaluateInterruptBudget(intent, effectivePriority, profile);
    const reachability = notificationReachability(intent.userId, intent.tenantId);
    if (reachability.hasToken && !reachability.canInterrupt) {
      // Provisional/ephemeral: iOS delivers to Notification Center only and
      // IGNORES interruption-level. Claiming time-sensitive here would be a
      // promise the platform will not keep, so the payload is made honest —
      // silent and passive — rather than pretending it will ring.
      pushPayload.interruptionLevel = 'passive';
    }
    if (decisionPushPlan && !decisionPushPlan.eligible) {
      decision = 'in_app_only';
      reason = decisionPushPlan.reason;
    } else if (!interruptBudget.allowed) {
      // Demoted, never dropped: the item still reaches the user in the next
      // digest slot. Silently withholding it in-app would make a budget
      // indistinguishable from a bug.
      decision = 'digest';
      reason = `interrupt budget: ${interruptBudget.reason}`;
      scheduledFor = nextDigestTime(profile).toISO();
    } else {
      const attempt = await attemptPushDelivery(intent, item.itemId, pushPayload, profile);
      if (attempt.attemptId !== null) deliveryAttempts.push(attempt);
      // Same mapping as the release path: failed / credentials-blocked
      // attempts must not be recorded as 'sent_push' (they previously were,
      // hiding real APNs failures behind a success decision).
      decision = attempt.status === 'sent'
        ? 'sent_push'
        : attempt.status === 'blocked_expired'
          ? 'in_app_only'
        : attempt.status === 'blocked_missing_device_token'
          ? 'blocked_missing_device_token'
          : 'apns_delivery_failed';
      reason = attempt.status === 'sent'
          ? 'APNs accepted privacy-safe payload'
          : attempt.status === 'blocked_expired'
            ? 'notification push deadline expired before APNs dispatch'
          : attempt.status === 'blocked_missing_credentials'
            ? 'APNs credentials missing; durable in-app item created'
            : attempt.status === 'blocked_missing_device_token'
              ? 'no active device token; durable in-app item created'
              : 'APNs delivery failed; durable in-app item created';
      sentAt = attempt.sentAt;
    }
  }

  const log = persistDecisionLog({
    intent,
    notificationId: item.itemId,
    decision,
    priority: effectivePriority,
    reason,
    scheduledFor,
    sentAt,
    deliveryAttemptIds: deliveryAttempts.map((attempt) => attempt.attemptId),
  });
  attachDecisionLog(item.itemId, log.decisionLogId);
  markIntentStatus(intent.intentId, 'evaluated');
  // Shadow only: records what the priority model would have said next to what
  // the ladder above actually did. Never influences `decision`.
  recordPriorityShadowVerdict(intent, effectivePriority, decision);

  return {
    intent: { ...intent, priority: effectivePriority, status: 'evaluated' },
    item: { ...item, decisionLogId: log.decisionLogId },
    decisionLog: log,
    deliveryAttempts,
    pushPayload,
  };
}

export interface NotificationIntentDeliveryResumeResult {
  intentId: string;
  notificationId: string | null;
  decisionLogId: string;
  decision: NotificationDecision;
  replayed: boolean;
}

/**
 * Resume the exact intent named by a `deliver_notification` job.
 *
 * The proposal transaction commits the intent, canonical item, and this job
 * before provider work begins. If the request process exits after that commit,
 * the worker evaluates this exact row instead of merely sweeping previously
 * scheduled digest/quiet-hour logs. A completed decision log is the durable
 * replay receipt, so the request path and worker cannot evaluate the same
 * intent twice even when they race.
 */
export function resumeNotificationIntentDelivery(
  intentId: string,
  userId: number,
  tenantId = userId,
): Promise<NotificationIntentDeliveryResumeResult> {
  assertScope(userId, tenantId, 'resume_notification_intent_delivery', { intentId });
  if (!intentId.trim()) throw new Error('deliver_notification job requires an intentId');
  return withUserEvaluationLock(userId, tenantId, async () => {
    const db = getDb();
    const canonicalDecisionLogId = exactDecisionLogId({
      intentId,
      userId,
      tenantId,
    });
    const existing = db.prepare(`
      SELECT *
        FROM notification_decision_logs
       WHERE decision_log_id = ?
         AND intent_id = ? AND user_id = ? AND tenant_id = ?
       LIMIT 1
    `).get(canonicalDecisionLogId, intentId, userId, tenantId) as any;
    if (existing) {
      const log = mapDecisionLog(existing);
      if (log.notificationId) attachDecisionLog(log.notificationId, log.decisionLogId);
      const status = log.decision === 'blocked_user_preferences' || log.decision === 'suppressed'
        ? 'suppressed'
        : log.decision === 'deduped'
          ? 'deduped'
          : 'evaluated';
      markIntentStatus(intentId, status);
      return {
        intentId,
        notificationId: log.notificationId,
        decisionLogId: log.decisionLogId,
        decision: log.decision,
        replayed: true,
      };
    }

    const itemRow = db.prepare(`
      SELECT item_id AS itemId
        FROM notification_center_items
       WHERE intent_id = ? AND user_id = ? AND tenant_id = ?
       ORDER BY created_at ASC, rowid ASC
       LIMIT 1
    `).get(intentId, userId, tenantId) as { itemId: string } | undefined;
    const precommittedItem = itemRow
      ? getNotificationCenterItem(itemRow.itemId, userId, tenantId) ?? undefined
      : undefined;
    const evaluated = await evaluateNotificationIntent(
      intentId,
      userId,
      tenantId,
      {},
      precommittedItem,
    );
    return {
      intentId,
      notificationId: evaluated.decisionLog.notificationId,
      decisionLogId: evaluated.decisionLog.decisionLogId,
      decision: evaluated.decisionLog.decision,
      replayed: false,
    };
  });
}

export interface NotificationIntentDeliveryResult {
  intentId: string;
  status: 'evaluated' | 'already_processed' | 'deferred' | 'retry_succeeded' | 'terminal';
  centerItemCount: number;
  acceptedPushCount: number;
}

function isTransientNotificationAttempt(attempt: DeliveryAttempt | null): boolean {
  return attempt?.status === 'failed'
    && (attempt.errorCode === 'apns_delivery_transient' || attempt.errorCode === 'apns_delivery_exception');
}

/**
 * Process one durable delivery job without sweeping unrelated users or
 * intents. The first evaluation owns center-item creation; retries reuse that
 * exact item and only retry provider failures known to be transient.
 */
export function processNotificationIntentDelivery(
  intentId: string,
  userId: number,
  tenantId = userId,
): Promise<NotificationIntentDeliveryResult> {
  assertScope(userId, tenantId, 'process_notification_intent_delivery', { intentId });
  if (typeof intentId !== 'string' || intentId.trim() === '') {
    throw new Error('notification delivery intentId is required');
  }

  return withUserEvaluationLock(userId, tenantId, () => withNotificationIntentDeliveryLease(
    intentId,
    userId,
    tenantId,
    async () => {
      const db = getDb();
      const intentRow = db.prepare(`
        SELECT * FROM notification_intents
         WHERE intent_id = ? AND user_id = ? AND tenant_id = ?
      `).get(intentId, userId, tenantId) as any;
      if (!intentRow) throw new Error('notification intent not found for authenticated user');
      const intent = mapIntent(intentRow);

    const counts = (): { centerItemCount: number; acceptedPushCount: number } => {
      const center = db.prepare(`
        SELECT COUNT(*) AS count FROM notification_center_items
         WHERE intent_id = ? AND user_id = ? AND tenant_id = ?
      `).get(intentId, userId, tenantId) as { count: number };
      const accepted = db.prepare(`
        SELECT COUNT(*) AS count FROM notification_delivery_attempts
         WHERE intent_id = ? AND user_id = ? AND tenant_id = ? AND status = 'sent'
      `).get(intentId, userId, tenantId) as { count: number };
      return { centerItemCount: center.count, acceptedPushCount: accepted.count };
    };

    let currentCounts = counts();
    if (currentCounts.acceptedPushCount > 0) {
      return { intentId, status: 'already_processed', ...currentCounts };
    }

    const itemRow = db.prepare(`
      SELECT * FROM notification_center_items
       WHERE intent_id = ? AND user_id = ? AND tenant_id = ?
       ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get(intentId, userId, tenantId) as any;
    const logRow = db.prepare(`
      SELECT * FROM notification_decision_logs
       WHERE intent_id = ? AND user_id = ? AND tenant_id = ?
       ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get(intentId, userId, tenantId) as any;

    if (!logRow) {
      const precommittedItem = itemRow
        ? getNotificationCenterItem(itemRow.item_id, userId, tenantId) ?? undefined
        : undefined;
      const evaluated = await evaluateNotificationIntent(
        intentId,
        userId,
        tenantId,
        {},
        precommittedItem,
      );
      if (evaluated.deliveryAttempts.some((attempt) => isTransientNotificationAttempt(attempt))) {
        throw new Error(`notification delivery retryable provider failure for ${intentId}`);
      }
      currentCounts = counts();
      return { intentId, status: 'evaluated', ...currentCounts };
    }

    const log = mapDecisionLog(logRow);
    if (!itemRow || log.decision !== 'apns_delivery_failed') {
      return {
        intentId,
        status: log.decision === 'quiet_hours_delayed' || log.decision === 'digest'
          ? 'deferred'
          : 'terminal',
        ...currentCounts,
      };
    }

    const latestAttemptRow = db.prepare(`
      SELECT * FROM notification_delivery_attempts
       WHERE intent_id = ? AND user_id = ? AND tenant_id = ?
       ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get(intentId, userId, tenantId) as any;
    const latestAttempt = latestAttemptRow ? mapDeliveryAttempt(latestAttemptRow) : null;
    if (!isTransientNotificationAttempt(latestAttempt)) {
      return { intentId, status: 'terminal', ...currentCounts };
    }

    const item = mapCenterItem(itemRow);
    const profile = getOrCreateNotificationProfile(userId, tenantId);
    const blockCause = notificationPushBlockCause(intent, profile);
    if (isRetryablePushBlock(blockCause)) {
      throw new Error(`notification delivery retryable suppression-state failure for ${intentId}`);
    }

    const updateLog = (
      decision: NotificationDecision,
      reason: string,
      scheduledFor: string | null,
      sentAt: string | null,
      attemptIds: string[],
    ): void => {
      db.prepare(`
        UPDATE notification_decision_logs
           SET decision = ?, reason = ?, scheduled_for = ?, sent_at = ?, delivery_attempt_ids_json = ?
         WHERE decision_log_id = ? AND user_id = ? AND tenant_id = ? AND sent_at IS NULL
      `).run(
        decision,
        reason,
        scheduledFor,
        sentAt,
        JSON.stringify(attemptIds),
        log.decisionLogId,
        userId,
        tenantId,
      );
    };
    const priorAttemptIds = log.deliveryAttemptIds;

    if (!profile.pushEnabled || blockCause !== null) {
      updateLog(
        'in_app_only',
        !profile.pushEnabled
          ? 'delivery retry withheld: push disabled by user preference'
          : `delivery retry withheld: ${pushBlockReason(blockCause!, intent)}`,
        null,
        null,
        priorAttemptIds,
      );
      return { intentId, status: 'terminal', ...counts() };
    }

    const effectivePriority = normalizePriorityForPolicy(intent.priority, profile);
    const quietHours = quietHoursDecision(profile, intent, effectivePriority);
    if (quietHours.delayed) {
      updateLog('quiet_hours_delayed', quietHours.reason, quietHours.scheduledFor, null, priorAttemptIds);
      return { intentId, status: 'deferred', ...counts() };
    }

    const interruptBudget = evaluateInterruptBudget(intent, effectivePriority, profile);
    if (!interruptBudget.allowed) {
      updateLog(
        'digest',
        `delivery retry deferred: interrupt budget: ${interruptBudget.reason}`,
        nextDigestTime(profile, intent.type).toISO(),
        null,
        priorAttemptIds,
      );
      return { intentId, status: 'deferred', ...counts() };
    }

    const copyLanguage = notificationCopyLanguage(userId);
    const payload = {
      title: safeNotificationTitle(intent, copyLanguage),
      body: buildPrivacySafeBody(intent, copyLanguage),
      deeplink: intent.deeplink,
      actions: intent.actionButtons,
      interruptionLevel: interruptionLevelForPriority(effectivePriority),
    };
    const retryAttempt = await attemptPushDelivery(
      intent,
      item.itemId,
      payload,
      profile,
      `retry:${priorAttemptIds.length}`,
    );
    const attemptIds = retryAttempt.attemptId === null
      ? priorAttemptIds
      : [...priorAttemptIds, retryAttempt.attemptId];

    if (retryAttempt.status === 'sent') {
      updateLog('sent_push', 'APNs accepted privacy-safe payload on durable retry', null, retryAttempt.sentAt, attemptIds);
      return { intentId, status: 'retry_succeeded', ...counts() };
    }
    if (retryAttempt.status === 'failed' && isTransientNotificationAttempt(retryAttempt)) {
      updateLog('apns_delivery_failed', 'transient APNs delivery failure; durable retry retained', null, null, attemptIds);
      throw new Error(`notification delivery retryable provider failure for ${intentId}`);
    }

    updateLog(
      retryAttempt.status === 'blocked_missing_device_token'
        ? 'blocked_missing_device_token'
        : 'in_app_only',
      retryAttempt.status === 'blocked_missing_device_token'
        ? 'durable retry found no active device token'
        : 'durable retry could not reach APNs',
      null,
      null,
      attemptIds,
    );
      return { intentId, status: 'terminal', ...counts() };
    },
  ));
}

// Engagement gate config: suppress daily-digest pushes after this many
// consecutive unread digests (0 disables). Reading any digest resets the
// streak naturally.
function digestUnreadStreakThreshold(): number {
  const raw = process.env.NOTIFICATION_DIGEST_UNREAD_STREAK_SUPPRESS;
  const parsed = raw == null || raw.trim() === '' ? NaN : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 7;
}

function hasUnreadDigestStreak(userId: number, tenantId: number, excludeItemId: string): boolean {
  const threshold = digestUnreadStreakThreshold();
  if (threshold === 0) return false;
  try {
    const rows = getDb().prepare(`
      SELECT read_at, actioned_at, dismissed_at
        FROM notification_center_items
       WHERE user_id = ? AND tenant_id = ? AND type = 'daily_digest' AND item_id != ?
       ORDER BY created_at DESC, rowid DESC
       LIMIT ?
    `).all(userId, tenantId, excludeItemId, threshold) as Array<{
      read_at: string | null; actioned_at: string | null; dismissed_at: string | null;
    }>;
    if (rows.length < threshold) return false;
    return rows.every((row) => !row.read_at && !row.actioned_at && !row.dismissed_at);
  } catch (err) {
    logger.debug({ err, userId }, 'Digest unread streak check failed (not suppressing)');
    return false;
  }
}

export function expireStaleNotificationIntents(now = new Date()): number {
  const db = getDb();
  const nowIso = now.toISOString();
  // The intent and active center-item unique dedupe indexes are status-based, so active expired
  // rows must be flipped before a same-key replacement can be inserted after expiry. Terminal
  // center rows are excluded by the partial index and keep their lifecycle/rollback history.
  const intents = db.prepare(`
    UPDATE notification_intents
       SET status = 'expired'
     WHERE status != 'expired'
       AND expires_at IS NOT NULL
       AND datetime(expires_at) <= datetime(?)
  `).run(nowIso);
  const items = db.prepare(`
    UPDATE notification_center_items
       SET status = 'expired'
     WHERE status IN ('unread','read','failed','snoozed')
       AND expires_at IS NOT NULL
       AND datetime(expires_at) <= datetime(?)
  `).run(nowIso);
  return (intents.changes ?? 0) + (items.changes ?? 0);
}

export interface NotificationReleaseSweepSummary {
  inspected: number;
  released: number;
  blocked: number;
  /** Provider attempts and sweep operations that genuinely failed. */
  failed: number;
}

// Process-local single-flight latch for the periodic delayed/digest release
// sweep (NOTIF-RELEASE-CAS). Exact deliver_notification event jobs bypass this
// sweep and process only their durable intentId; the sweep still needs a latch
// because overlapping cron/manual invocations could otherwise SELECT the same
// due decision-log rows before either UPDATE lands.
let releaseSweepInFlight: Promise<NotificationReleaseSweepSummary> | null = null;

export async function releaseDueNotificationDeliveries(now = new Date()): Promise<NotificationReleaseSweepSummary> {
  if (releaseSweepInFlight) return releaseSweepInFlight;
  const sweep = runReleaseDueNotificationDeliveriesSweep(now).finally(() => {
    releaseSweepInFlight = null;
  });
  releaseSweepInFlight = sweep;
  return sweep;
}

async function runReleaseDueNotificationDeliveriesSweep(now: Date): Promise<NotificationReleaseSweepSummary> {
  expireStaleNotificationIntents(now);
  const db = getDb();
  const rows = db.prepare(`
    SELECT
      logs.decision_log_id,
      logs.notification_id,
      logs.decision AS pending_decision,
      logs.intent_id,
      logs.user_id,
      logs.tenant_id,
      items.item_id,
      intents.*
    FROM notification_decision_logs logs
    JOIN notification_center_items items ON items.item_id = logs.notification_id
    JOIN notification_intents intents ON intents.intent_id = logs.intent_id
    WHERE logs.decision IN ('quiet_hours_delayed', 'digest')
      AND logs.scheduled_for IS NOT NULL
      AND datetime(logs.scheduled_for) <= datetime(?)
      AND logs.sent_at IS NULL
      AND items.status IN ('unread', 'read')
      AND (items.expires_at IS NULL OR datetime(items.expires_at) > datetime(?))
    ORDER BY logs.scheduled_for ASC
    LIMIT 100
  `).all(now.toISOString(), now.toISOString()) as any[];

  let released = 0;
  let blocked = 0;
  let failed = 0;
  const digestGroups = new Map<string, any[]>();
  const regularRows: any[] = [];
  for (const row of rows) {
    if (row.pending_decision === 'digest') {
      const key = `${row.user_id}:${row.tenant_id}`;
      digestGroups.set(key, [...(digestGroups.get(key) ?? []), row]);
    } else {
      regularRows.push(row);
    }
  }
  // Belt-and-suspenders CAS (same idiom as revokePriorActiveDeviceTokenOwners):
  // only claim rows still in a releasable state, so a row already claimed by a
  // concurrent sweep is not re-counted as sent.
  const updateReleasedLogs = db.transaction((updates: Array<{
    row: any;
    decision: NotificationDecision;
    reason: string;
    sentAt: string | null;
    attemptIds: string[];
    scheduledFor?: string | null;
  }>): number => {
    const stmt = db.prepare(`
      UPDATE notification_decision_logs
      SET decision = ?,
          reason = ?,
          sent_at = ?,
          delivery_attempt_ids_json = ?,
          scheduled_for = CASE WHEN ? = 1 THEN ? ELSE scheduled_for END
      WHERE decision_log_id = ?
        AND user_id = ?
        AND tenant_id = ?
        AND sent_at IS NULL
        AND decision IN ('quiet_hours_delayed', 'digest')
    `);
    let claimed = 0;
    for (const update of updates) {
      const result = stmt.run(
        update.decision,
        update.reason,
        update.sentAt,
        JSON.stringify(update.attemptIds),
        update.scheduledFor !== undefined ? 1 : 0,
        update.scheduledFor ?? null,
        update.row.decision_log_id,
        update.row.user_id,
        update.row.tenant_id,
      );
      if ((result.changes ?? 0) === 0) {
        logger.warn({
          decisionLogId: update.row.decision_log_id,
          userId: update.row.user_id,
          tenantId: update.row.tenant_id,
        }, 'Notification release skipped: decision log already claimed by a concurrent sweep');
        continue;
      }
      claimed += 1;
    }
    return claimed;
  });

  for (const group of digestGroups.values()) {
    await withUserEvaluationLock(group[0].user_id, group[0].tenant_id, async () => {
      try {
      const first = group[0];
      const profile = getOrCreateNotificationProfile(first.user_id, first.tenant_id);
      // Push eligibility is a PER-INTENT property — skill gate, delivery
      // policy, marketing consent, per-type suppression. Judging the whole
      // group by `group[0]` let one arbitrary member decide for all the others,
      // and it failed in both directions: a cooking `in_app_only` item that
      // happened to sort first withheld an unrelated secretary reminder, and in
      // the opposite order the group pushed while carrying a member the user
      // had confined to the app. Partition, then push only what may be pushed.
      const pushable: typeof group = [];
      const withheld: Array<{ row: typeof group[number]; cause: NotificationPushBlockCause }> = [];
      // A row whose block is only "we could not read the suppression table" is
      // left ALONE — decision and scheduled_for untouched — so the next sweep
      // re-claims it once the table is readable. Rewriting it to a terminal
      // decision destroyed the push for good on a transient fault.
      let deferred = 0;
      for (const row of group) {
        const cause = notificationPushBlockCause(mapIntent(row), profile);
        if (cause === null) pushable.push(row);
        else if (isRetryablePushBlock(cause)) deferred += 1;
        else withheld.push({ row, cause });
      }
      if (deferred > 0) {
        blocked += deferred;
        failed += deferred;
        logger.warn({
          userId: first.user_id, tenantId: first.tenant_id, deferred,
        }, 'digest rows left queued: suppression state unreadable, retrying next sweep');
      }
      if (withheld.length > 0) {
        blocked += updateReleasedLogs(withheld.map(({ row, cause }) => ({
          row,
          decision: 'in_app_only' as NotificationDecision,
          reason: `digest withheld: ${pushBlockReason(cause, mapIntent(row))}`,
          sentAt: null,
          attemptIds: [],
        })));
      }
      if (pushable.length === 0) return;
      // A real morning brief / weekly review in the group carries its own
      // composed headline; prefer it over a generic type breakdown.
      const reportRow = pushable.find((row) => row.type === 'daily_digest' || row.type === 'weekly_review');
      // The push is carried by — and deeplinks into — the row whose content the
      // body actually leads with. Taking `pushable[0]` unconditionally meant
      // that when a brief supplied the body but sorted second, the wire
      // metadata (thread-id, apns category, iosDestination, collapse-id) all
      // described a DIFFERENT notification than the text the user read.
      const carrier = reportRow ?? pushable[0];
      const digestIntent = mapIntent(carrier);
      const payload = assembleDailyDigest(
        carrier.user_id, carrier.tenant_id, pushable.length, now,
        reportRow ? buildPrivacySafeBody(digestIntent) : null,
      );
      // The old sweep sent "N Nexus updates are ready" based on the number of
      // QUEUED LOG ROWS, so a user who cleared everything overnight still got
      // a digest announcing items they had already handled. Re-check against
      // live item state and skip the interrupt when nothing is left.
      if (!payload.hasContent) {
        const claimed = updateReleasedLogs(pushable.map((row) => ({
          row,
          decision: 'suppressed' as NotificationDecision,
          reason: 'digest skipped: nothing unresolved at release time',
          sentAt: null,
          attemptIds: [],
        })));
        blocked += claimed;
        return;
      }
      // Fatigue gate, applied to the digest PUSH rather than only to
      // `daily_digest` INTENTS at creation. Scoping it to one intent type meant
      // any `digest_only` producer bypassed it: a travel notice is
      // `schedule_changed`, forms its own digest group, and reached APNs with a
      // push indistinguishable from the digests the user has been ignoring —
      // and whose body advertised those very digests as its content.
      if (hasUnreadDigestStreak(carrier.user_id, carrier.tenant_id, carrier.item_id)) {
        blocked += updateReleasedLogs(pushable.map((row) => ({
          row,
          decision: 'suppressed' as NotificationDecision,
          reason: `digest push suppressed: last ${digestUnreadStreakThreshold()} digests were never opened`,
          sentAt: null,
          attemptIds: [],
        })));
        return;
      }
      // The budget can change while a digest waits for its release slot. Count
      // again at the last synchronous boundary before APNs, under the same
      // per-user lock used by immediate delivery. A digest is one interrupt,
      // so only its carrier is evaluated and, if sent, only that carrier is
      // charged below.
      const releasePriority = normalizePriorityForPolicy(digestIntent.priority, profile);
      const interruptBudget = evaluateInterruptBudget(digestIntent, releasePriority, profile, now);
      if (!interruptBudget.allowed) {
        // The items remain durable and visible in Notification Center. Make
        // this digest attempt terminal instead of leaving an already-due row
        // to wake every 15 minutes for the rest of the budget window.
        blocked += updateReleasedLogs(pushable.map((row) => ({
          row,
          decision: 'in_app_only' as NotificationDecision,
          reason: `digest withheld: interrupt budget: ${interruptBudget.reason}`,
          sentAt: null,
          attemptIds: [],
        })));
        return;
      }
      const attempt = await attemptPushDelivery(digestIntent, carrier.item_id, payload, profile);
      const decision: NotificationDecision = attempt.status === 'sent'
        ? 'sent_push'
        : attempt.status === 'blocked_expired'
          ? 'in_app_only'
        : attempt.status === 'blocked_missing_device_token'
          ? 'blocked_missing_device_token'
          : 'apns_delivery_failed';
      const reason = attempt.status === 'sent'
        ? 'digest notification released to APNs'
        : attempt.status === 'blocked_expired'
          ? 'digest notification expired before APNs dispatch'
        : attempt.status === 'blocked_missing_credentials'
            ? 'digest notification due but APNs credentials are missing'
            : attempt.status === 'blocked_missing_device_token'
              ? 'digest notification due but no active device token is available'
              : 'digest notification due but APNs delivery failed';
      const attemptIds = attempt.attemptId === null ? [] : [attempt.attemptId];
      // ONE push left the building, so exactly ONE row may be recorded as an
      // interrupt. Stamping every group member `sent_push` — the previous
      // behaviour — was not merely a cosmetic miscount: `evaluateInterruptBudget`
      // sums `sent_push` rows, so a nine-item digest consumed nine of the
      // user's eight daily interrupts and silently suppressed everything that
      // came after it, including time-sensitive items. The bigger the digest,
      // the longer the blackout.
      //
      // The covered rows keep the attempt id so the delivery is still
      // traceable from any member, but carry no `sent_at` and a decision that
      // says what actually happened to them: they were surfaced in the app, and
      // the digest interrupt was carried by another row.
      let claimed = updateReleasedLogs([{
        row: carrier, decision, reason, sentAt: attempt.sentAt, attemptIds,
      }]);
      claimed += updateReleasedLogs(pushable
        .filter((row) => row.decision_log_id !== carrier.decision_log_id)
        .map((row) => ({
          row,
          decision: attempt.status === 'sent' ? ('in_app_only' as NotificationDecision) : decision,
          reason: attempt.status === 'sent'
            ? `surfaced in the digest push carried by ${carrier.item_id}; not a separate interrupt`
            : reason,
          sentAt: null,
          attemptIds,
        })));
      if (attempt.status === 'sent') released += claimed;
      else blocked += claimed;
      if (attempt.status === 'failed') failed += 1;
      } catch (err) {
        blocked += group.length;
        failed += 1;
        logger.warn({ err, userId: group[0]?.user_id, tenantId: group[0]?.tenant_id }, 'Notification digest release failed');
      }
    });
  }

  for (const row of regularRows) {
    await withUserEvaluationLock(row.user_id, row.tenant_id, async () => {
      try {
      const intent = mapIntent(row);
      const profile = getOrCreateNotificationProfile(row.user_id, row.tenant_id);
      // Preferences are re-evaluated HERE, not just at first evaluation.
      // Previously the reloaded profile reached only effectiveSound, so a user
      // who turned push off during quiet hours still received everything queued
      // before the change. The item stays in the inbox; only the push is dropped.
      const blockCause = notificationPushBlockCause(intent, profile);
      if (isRetryablePushBlock(blockCause)) {
        // Left queued deliberately — see the digest branch above. Counted as
        // blocked so the sweep summary does not read as a silent no-op.
        blocked += 1;
        failed += 1;
        logger.warn({
          decisionLogId: row.decision_log_id, userId: row.user_id, tenantId: row.tenant_id,
        }, 'delayed notification left queued: suppression state unreadable, retrying next sweep');
        return;
      }
      if (blockCause !== null) {
        const claimed = updateReleasedLogs([{
          row,
          decision: 'in_app_only',
          reason: `delayed notification withheld: ${pushBlockReason(blockCause, intent)}`,
          sentAt: null,
          attemptIds: [],
        }]);
        blocked += claimed;
        return;
      }
      const releasePriority = normalizePriorityForPolicy(intent.priority, profile);
      // Resolved ONCE and threaded into both. Letting each helper resolve
      // independently cost two indexed `users` lookups per notification, not
      // the one the design note claims.
      const copyLanguage = notificationCopyLanguage(intent.userId);
      const payload = {
        title: safeNotificationTitle(intent, copyLanguage),
        body: buildPrivacySafeBody(intent, copyLanguage),
        deeplink: intent.deeplink,
        actions: intent.actionButtons,
        // Without this the release path fell back to apns-expiration '0'
        // (now-or-drop), so a time-sensitive item deferred by quiet hours was
        // discarded outright if the device happened to be offline.
        interruptionLevel: interruptionLevelForPriority(releasePriority),
      };
      // Quiet-hours delay is not pre-authorisation to spend attention later.
      // Re-check at release time, while serialized with immediate sends for
      // this user, so a push delivered during the wait is visible here.
      const interruptBudget = evaluateInterruptBudget(intent, releasePriority, profile, now);
      if (!interruptBudget.allowed) {
        // Demote once to the next digest slot. Advancing scheduled_for is
        // essential: retaining the already-due timestamp would retry this row
        // on every release sweep and eventually create an interrupt burst.
        const claimed = updateReleasedLogs([{
          row,
          decision: 'digest',
          reason: `delayed notification demoted: interrupt budget: ${interruptBudget.reason}`,
          sentAt: null,
          attemptIds: [],
          scheduledFor: nextDigestTime(profile, intent.type).toISO(),
        }]);
        blocked += claimed;
        return;
      }
      const attempt = await attemptPushDelivery(intent, row.item_id, payload, profile);
      // A real APNs failure ('failed'/'blocked_missing_credentials') is an
      // apns_delivery_failed outcome; only the genuine no-token case may be
      // recorded as blocked_missing_device_token.
      const decision: NotificationDecision = attempt.status === 'sent'
        ? 'sent_push'
        : attempt.status === 'blocked_expired'
          ? 'in_app_only'
        : attempt.status === 'blocked_missing_device_token'
          ? 'blocked_missing_device_token'
          : 'apns_delivery_failed';
      const reason = attempt.status === 'sent'
        ? 'delayed notification released to APNs'
        : attempt.status === 'blocked_expired'
          ? 'delayed notification expired before APNs dispatch'
        : attempt.status === 'blocked_missing_credentials'
            ? 'delayed notification released but APNs credentials are missing'
            : attempt.status === 'blocked_missing_device_token'
              ? 'delayed notification released but no active device token is available'
              : 'delayed notification released but APNs delivery failed';
      const claimed = updateReleasedLogs([{
        row,
        decision,
        reason,
        sentAt: attempt.sentAt,
        attemptIds: attempt.attemptId === null ? [] : [attempt.attemptId],
      }]);
      if (attempt.status === 'sent') released += claimed;
      else blocked += claimed;
      if (attempt.status === 'failed') failed += 1;
      } catch (err) {
        blocked += 1;
        failed += 1;
        logger.warn({ err, decisionLogId: row.decision_log_id }, 'Notification delayed/digest release failed');
      }
    });
  }

  // Due snoozes ride the same sweep as delayed/digest releases so snooze
  // re-delivery inherits the existing notification_release cron and the
  // single-flight latch rather than needing a second schedule.
  try {
    const snoozeSummary = await releaseDueSnoozedNotifications(now);
    released += snoozeSummary.released;
    blocked += snoozeSummary.blocked;
    failed += snoozeSummary.failed;
  } catch (err) {
    failed += 1;
    logger.warn({ err }, 'Snoozed notification sweep failed');
  }

  return { inspected: rows.length, released, blocked, failed };
}

export interface NotificationRetentionSummary {
  centerItems: number;
  intents: number;
  decisionLogs: number;
  deliveryAttempts: number;
  reliabilityEvents: number;
  engagementEvents: number;
  priorityShadow: number;
  deliveryExecutionStates: number;
}

export const NOTIFICATION_RETENTION_DAYS = {
  /** Terminal center items. Unresolved rows are kept regardless of age. */
  terminalItems: 90,
  decisionLogs: 90,
  deliveryAttempts: 30,
  reliabilityEvents: 30,
  /** Long enough to fit a seasonal cycle for the fatigue model, still bounded. */
  engagementEvents: 180,
  /**
   * Shadow scoring is a comparison sample, not an audit trail. It was in no
   * prune path anywhere in the repo — the one notification table that grew
   * without bound (~480 B/row including migration 270's two indexes).
   */
  priorityShadow: 90,
  deliveryExecutionStates: 30,
} as const;

/**
 * Age out notification history.
 *
 * Nothing deleted from these tables before: `midnight_cleanup` pruned
 * transcripts, job history and error logs but no notification table, so
 * `notification_center_items.body` and `.sensitive_body` retained event
 * titles, task names and invoice references indefinitely — on a single-file
 * SQLite database with four indexes on that table, fed by a per-minute cron.
 *
 * Retention is status-aware, not purely age-based: an unresolved decision must
 * survive no matter how old it is, because deleting it would silently drop
 * something still waiting on the user. Only terminal rows age out.
 */
export function pruneNotificationRetention(now = new Date()): NotificationRetentionSummary {
  const db = getDb();
  const cutoff = (days: number): string =>
    new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();

  const summary: NotificationRetentionSummary = {
    centerItems: 0, intents: 0, decisionLogs: 0,
    deliveryAttempts: 0, reliabilityEvents: 0, engagementEvents: 0,
    priorityShadow: 0, deliveryExecutionStates: 0,
  };

  const run = (label: keyof NotificationRetentionSummary, sql: string, ...params: unknown[]): void => {
    try {
      summary[label] = db.prepare(sql).run(...params).changes ?? 0;
    } catch (err) {
      logger.warn({ err, label }, 'notification retention prune failed');
    }
  };

  // Children first: attempts and logs reference items that are about to go.
  run('deliveryAttempts',
    `DELETE FROM notification_delivery_attempts WHERE created_at < ?`,
    cutoff(NOTIFICATION_RETENTION_DAYS.deliveryAttempts));
  run('reliabilityEvents',
    `DELETE FROM notification_reliability_events WHERE created_at < ?`,
    cutoff(NOTIFICATION_RETENTION_DAYS.reliabilityEvents));
  // Age alone is the WRONG rule here, because the item table does not use it:
  // `notification_center_items` is pruned only when a row reaches a terminal
  // status, so an unresolved item lives indefinitely. Deleting its engagement
  // history by age therefore splits one item's timeline in half — a `surfaced`
  // event aged out at 180 days while the item it denominates is still open, so
  // an `opened` on day 200 lands with no `surfaced` to divide by. Every rate
  // computed off this table would be inflated, and open-rate could exceed 1.
  //
  // Same shape as the decision-log prune below: history is retained for as long
  // as the thing it describes exists, and aged out once it does not.
  run('engagementEvents',
    `DELETE FROM notification_engagement_events
      WHERE created_at < ?
        AND (notification_id IS NULL
             OR notification_id NOT IN (SELECT item_id FROM notification_center_items))`,
    cutoff(NOTIFICATION_RETENTION_DAYS.engagementEvents));
  run('priorityShadow',
    `DELETE FROM notification_priority_shadow WHERE created_at < ?`,
    cutoff(NOTIFICATION_RETENTION_DAYS.priorityShadow));
  run('deliveryExecutionStates',
    `DELETE FROM scheduled_job_execution_state
      WHERE job_name = ?
        AND updated_at < ?
        AND (lease_token IS NULL OR lease_expires_at <= ?)`,
    NOTIFICATION_DELIVERY_JOB_NAME,
    cutoff(NOTIFICATION_RETENTION_DAYS.deliveryExecutionStates),
    now.toISOString());

  const itemCutoff = cutoff(NOTIFICATION_RETENTION_DAYS.terminalItems);
  run('centerItems',
    `DELETE FROM notification_center_items
      WHERE status IN ('dismissed','actioned','expired','superseded')
        AND created_at < ?`,
    itemCutoff);
  // `notification_id IS NOT NULL` made this unable to ever delete a log that
  // has no item — the `blocked_user_preferences` and dedupe paths write exactly
  // those, so they accumulated forever at any age. The intent was "keep logs
  // whose item still exists", which only needs the NOT IN clause; a NULL
  // notification_id has no item to protect.
  run('decisionLogs',
    `DELETE FROM notification_decision_logs
      WHERE created_at < ?
        AND (notification_id IS NULL
             OR notification_id NOT IN (SELECT item_id FROM notification_center_items))`,
    cutoff(NOTIFICATION_RETENTION_DAYS.decisionLogs));
  // Intents last, and only once nothing references them — an intent still
  // backing a live item carries the body the inbox renders.
  run('intents',
    `DELETE FROM notification_intents
      WHERE created_at < ?
        AND intent_id NOT IN (SELECT intent_id FROM notification_center_items)`,
    itemCutoff);

  return summary;
}

/**
 * An item pushed within this window does not earn its own digest slot — it
 * still contributes to the aggregate count, so the user learns the true queue
 * depth without being told the same sentence twice. Wide enough that something
 * pushed yesterday afternoon is eligible again the next morning (by then it is
 * stale-and-ignored, which is worth re-raising).
 */
export const DIGEST_SURFACED_WINDOW_HOURS = 20;
/** Hard cap. A sixth item appears on the digest screen, never in the push. */
export const DIGEST_MAX_SLOTS = 5;

/**
 * Rank for a digest slot. Deadlines before commitments before counts — never
 * alphabetical, never by skill.
 */
const DIGEST_TYPE_RANK: Partial<Record<NotificationIntentType, number>> = {
  security_account: 0,
  approval_required: 1,
  conflict_detected: 2,
  decision_required: 3,
  reflow_suggestion: 4,
  risk_warning: 5,
  sync_failure: 6,
  reminder: 7,
  missed_item: 8,
  schedule_changed: 9,
};

export interface DailyDigestComposition {
  title: string;
  body: string;
  deeplink: string;
  actions: NotificationActionButton[];
  interruptionLevel: 'passive';
  slots: string[];
  totalOpen: number;
  /**
   * False when the digest has nothing to report — no eligible slots and no
   * report headline. The caller skips the push entirely rather than
   * interrupting with "nothing needs you".
   */
  hasContent: boolean;
}

/**
 * Compose the digest push.
 *
 * This used to return "N Nexus updates are ready" — a count with no content,
 * which converts about as well as no digest at all, and which ~22 catalog
 * entries route through. It now reads the actual constituent items and states
 * what is waiting.
 *
 * Everything here is either a count or a privacy-safe title already rewritten
 * by the per-skill rules; no producer free-text, email subject, amount or task
 * title is interpolated. buildPrivacySafeBody trusts that invariant.
 */
export function assembleDailyDigest(
  userId: number,
  tenantId: number,
  itemCount: number,
  now = new Date(),
  /**
   * The morning brief / weekly review composes its own headline ("4 events,
   * 6 tasks · first: Standup 09:00"), which is strictly better copy than a
   * type breakdown. When a real report is in the group, its summary wins.
   */
  preferredBody?: string | null,
): DailyDigestComposition {
  assertScope(userId, tenantId, 'assemble_daily_digest', { itemCount });
  const digestLang = notificationCopyLanguage(userId);

  // A digest push may only ADVERTISE what it would be allowed to SEND.
  //
  // This query used to read `notification_center_items` alone, which carries
  // neither the delivery policy nor the promotional flag — both live on
  // `notification_intents`. So an item the ladder had already refused to push
  // was still counted in the body: one pushable reminder plus one
  // consent-blocked promotional item produced a push that announced "2
  // reminders". The interrupt itself was correctly withheld from the
  // promotional item, and then its existence was leaked by the digest anyway.
  let digestProfile: NotificationProfile;
  try {
    digestProfile = getOrCreateNotificationProfile(userId, tenantId);
  } catch (err) {
    // Without the profile we cannot know which skills the user has muted.
    // Abort composition so the release row remains queued for a later sweep;
    // emitting a partial digest would disclose content through an opt-out.
    logger.warn({ err, userId, tenantId }, 'digest profile read failed; withholding composition');
    throw new Error('notification profile unreadable during digest composition');
  }
  const marketingAllowed = digestProfile.marketingPushEnabled;

  let rows: Array<{
    type: NotificationIntentType;
    sourceSkill: NotificationSourceSkill;
    lastPushedAt: string | null;
    decisionContextJson: string | null;
  }> = [];
  try {
    rows = getDb().prepare(`
      SELECT items.type,
             items.source_skill AS sourceSkill,
             items.last_pushed_at AS lastPushedAt,
             intents.decision_context_json AS decisionContextJson
        FROM notification_center_items items
        LEFT JOIN notification_intents intents
          ON intents.intent_id = items.intent_id
         AND intents.user_id = items.user_id
         AND intents.tenant_id = items.tenant_id
       WHERE items.user_id = ? AND items.tenant_id = ?
         AND items.status IN ('unread', 'read')
         AND (items.expires_at IS NULL OR datetime(items.expires_at) > datetime(?))
         AND COALESCE(intents.delivery_policy, 'auto') NOT IN ('in_app_only', 'portal_only')
         AND (? = 1 OR COALESCE(intents.promotional, 0) = 0)
       ORDER BY items.created_at DESC
       LIMIT 50
    `).all(userId, tenantId, now.toISOString(), marketingAllowed ? 1 : 0) as typeof rows;
  } catch (err) {
    logger.warn({ err, userId, tenantId }, 'digest composition read failed; falling back to a count');
  }

  // Suppressed rows remain durable so unmuting can reveal them again. That
  // means the broad open-item scan above must repeat the same broad + recipe
  // suppression check as the delivery ladder; otherwise an unrelated digest
  // push advertises a muted item even though its own interrupt was withheld.
  // A read fault must abort composition: releaseDueNotificationDeliveries will
  // leave the queued rows claimable for the next sweep rather than leak copy.
  const advertisableRows = rows.filter((row) => {
    if (!digestProfile.skillPreferences[row.sourceSkill]) return false;
    const categoryPreference = notificationCategoryPreferenceCause({ userId, type: row.type });
    if (categoryPreference === 'read_failed') {
      throw new Error('notification category preference unreadable during digest composition');
    }
    if (categoryPreference === 'user_disabled') return false;
    const cause = notificationTypeSuppressionCause({
      userId,
      tenantId,
      sourceSkill: row.sourceSkill,
      type: row.type,
      decisionContext: normalizeDecisionContext(
        safeParseJSON<DecisionLogicContext | null>(row.decisionContextJson, null),
      ),
    });
    if (cause === 'read_failed') {
      throw new Error('notification suppression state unreadable during digest composition');
    }
    return cause === null;
  });

  const surfacedCutoff = now.getTime() - DIGEST_SURFACED_WINDOW_HOURS * 3_600_000;
  const eligible = advertisableRows.filter((row) => {
    if (!row.lastPushedAt) return true;
    const pushed = Date.parse(row.lastPushedAt);
    return !Number.isFinite(pushed) || pushed < surfacedCutoff;
  });

  const byType = new Map<NotificationIntentType, number>();
  for (const row of eligible) byType.set(row.type, (byType.get(row.type) ?? 0) + 1);

  const rankedTypes = [...byType.entries()]
    .sort((a, b) => (DIGEST_TYPE_RANK[a[0]] ?? 99) - (DIGEST_TYPE_RANK[b[0]] ?? 99));
  const slots = rankedTypes
    .slice(0, DIGEST_MAX_SLOTS)
    .map(([type, count]) => digestSlotLabel(type, count, digestLang));

  const totalOpen = advertisableRows.length || (rows.length === 0 ? Math.max(0, itemCount) : 0);
  const brief = typeof preferredBody === 'string' ? stripTitleEmoji(preferredBody) : '';
  // A report's own headline is better copy than a type breakdown — but it
  // describes only ITSELF. Returning it alone discarded every other slot, so
  // anything else sharing that digest slot (a travel notice, a conflict) rode
  // the push without appearing in it: silently dropped from the only interrupt
  // it will ever get, while its item sat unread in the inbox.
  //
  // The report's own type is excluded so the brief does not count itself twice.
  const companionSlots = rankedTypes
    .filter(([type]) => type !== 'daily_digest' && type !== 'weekly_review')
    .slice(0, DIGEST_MAX_SLOTS)
    .map(([type, count]) => digestSlotLabel(type, count, digestLang));
  const body = brief
    ? companionSlots.length > 0
      // The brief is capped first so at least one companion slot survives the
      // 120-char budget. Truncating the joined string as a whole would let a
      // long brief push the companions back off the end.
      ? truncate(`${truncate(brief, 80)} · ${companionSlots.join(' · ')}`, 120)
      : truncate(brief, 120)
    : slots.length > 0
      ? truncate(slots.join(' · '), 120)
      // Still worth sending: a brief that goes quiet is indistinguishable from
      // a brief that broke. The caller decides whether anything is queued.
      : t('notif.digest.empty', digestLang);

  return {
    title: t('notif.digest.title', digestLang),
    body,
    deeplink: 'nexus://notifications/digest',
    actions: [{ id: 'open_detail', label: 'Open', style: 'primary' }],
    interruptionLevel: 'passive',
    slots,
    totalOpen,
    hasContent: slots.length > 0 || brief.length > 0,
  };
}

/**
 * Slot labels carry their own singular and plural entries rather than being
 * assembled from a count plus a noun. Portuguese and Spanish inflect the noun
 * ("1 decisão pendente" / "3 decisões pendentes"), so the English trick of
 * concatenating a number onto a fixed word does not survive translation.
 *
 * Types with no slot key read as plain updates — calling a queued report a
 * "brief" inside a brief is circular.
 */
const DIGEST_SLOT_KEY_TYPES = new Set<NotificationIntentType>([
  'security_account', 'approval_required', 'conflict_detected', 'decision_required',
  'reflow_suggestion', 'risk_warning', 'sync_failure', 'reminder', 'missed_item',
  'schedule_changed',
]);

function digestSlotLabel(type: NotificationIntentType, count: number, lang: Lang): string {
  const base = DIGEST_SLOT_KEY_TYPES.has(type) ? `notif.digest.slot.${type}` : 'notif.digest.slot.default';
  return t(`${base}.${count === 1 ? 'one' : 'other'}`, lang, { count: String(count) });
}

export function listNotificationCenterItems(
  userId: number,
  tenantId = userId,
  opts: {
    status?: NotificationCenterStatus | 'all';
    sourceSkill?: NotificationSourceSkill;
    limit?: number;
    /**
     * Show items that are snoozed and not yet due. Off by default: a snoozed
     * item is deliberately out of the inbox until it comes back.
     *
     * This is an explicit flag rather than a meaning overloaded onto
     * `status:'all'`, because the primary inbox route passes `'all'` to mean
     * "every status" — so tying snooze-hiding to it silently un-hid snoozed
     * items on the one surface that matters most.
     *
     * NO PRODUCTION CALLER PASSES THIS TODAY; only tests do. It exists so the
     * hiding rule above cannot be re-derived from `status`, and so a future
     * "snoozed" surface has an honest way to ask. The corresponding product
     * gap is real and separate: nothing currently shows a user what they have
     * snoozed. `status:'snoozed'` already returns those rows when a surface
     * wants them.
     */
    includeSnoozed?: boolean;
  } = {},
): NotificationCenterItem[] {
  assertScope(userId, tenantId, 'list_notification_center_items', opts);
  // 200 is the API page ceiling. It is applied HERE rather than inside the
  // shared query, because the badge counts through the same code path and must
  // not inherit a paging limit as a counting limit.
  return queryUserFacingCenterItems(userId, tenantId, opts, Math.min(Math.max(opts.limit ?? 50, 1), 200));
}

/** Shared by the inbox list and the badge count, so the two cannot disagree. */
function queryUserFacingCenterItems(
  userId: number,
  tenantId: number,
  opts: {
    status?: NotificationCenterStatus | 'all';
    sourceSkill?: NotificationSourceSkill;
    includeSnoozed?: boolean;
  },
  limit: number,
): NotificationCenterItem[] {
  const clauses = ['items.user_id = ?', 'items.tenant_id = ?'];
  const params: unknown[] = [userId, tenantId];
  if (opts.status && opts.status !== 'all') {
    clauses.push('items.status = ?');
    params.push(opts.status);
  } else {
    clauses.push("items.status != 'expired'");
  }
  // A snoozed item is deliberately out of the inbox until it is due. Without
  // this it stayed visible the whole time it was "snoozed", which is why
  // snooze read as a no-op even before the missing re-delivery was found.
  // Items whose snooze has LAPSED stay visible, so a stalled release sweep
  // degrades to "shows early" rather than "disappears".
  //
  // Applied regardless of the status filter, because the primary inbox route
  // asks for `status:'all'` meaning "every status" — gating on that value
  // instead of an explicit flag left snoozed items visible on the one surface
  // where it matters. Asking for `status:'snoozed'` obviously still returns them.
  if (!opts.includeSnoozed && opts.status !== 'snoozed') {
    clauses.push("(items.status != 'snoozed' OR items.snoozed_until IS NULL OR datetime(items.snoozed_until) <= datetime(?))");
    params.push(appNowIso());
  }
  // A muted (sourceSkill, type) pair must disappear from the inbox, not just
  // from the badge. This clause lived ONLY on the badge count, so with the flag
  // on, muting a type zeroed the badge while the unread row stayed in the list
  // — the exact badge/list divergence the badge comment claims to prevent,
  // running in the opposite direction.
  if (isDecisionTypeSuppressionEnabled(process.env, { userId, tenantId })) {
    clauses.push(`(items.type = 'security_account' OR NOT EXISTS (
      SELECT 1 FROM decision_type_suppressions s
       WHERE s.user_id = items.user_id
         AND s.tenant_id = items.tenant_id
         AND s.source_skill = items.source_skill
         AND s.type = items.type
         AND (s.mode = 'dont_show_type'
              OR (s.mode = 'snooze_type' AND s.until IS NOT NULL AND datetime(s.until) > datetime(?)))
    ))`);
    params.push(appNowIso());
  }
  // A1: hide items past their hard deadline (unless the caller explicitly asks for expired).
  if (opts.status !== 'expired') {
    clauses.push('(items.expires_at IS NULL OR datetime(items.expires_at) > datetime(?))');
    params.push(appNowIso());
  }
  if (opts.sourceSkill) {
    clauses.push('items.source_skill = ?');
    params.push(opts.sourceSkill);
  }
  params.push(limit);

  const rows = getDb().prepare(`
    SELECT items.*, intents.intent_id AS intent_joined_intent_id,
           intents.related_entity_id AS intent_related_entity_id,
           intents.related_entity_type AS intent_related_entity_type,
           COALESCE(intents.requires_user_action, items.requires_user_action) AS intent_requires_user_action,
           intents.promotional AS intent_promotional,
           intents.decision_deadline AS intent_decision_deadline,
           intents.privacy_policy AS intent_privacy_policy,
           intents.decision_context_json AS intent_decision_context_json
      FROM notification_center_items items
      LEFT JOIN notification_intents intents
        ON intents.intent_id = items.intent_id
       AND intents.user_id = items.user_id
       AND intents.tenant_id = items.tenant_id
    WHERE ${clauses.join(' AND ')}
    ORDER BY items.created_at DESC
    LIMIT ?
  `).all(...params) as any[];
  return rows
    .filter(isUserFacingNotificationCenterRow)
    .map(mapCenterItem);
}

function isUserFacingNotificationCenterRow(row: any): boolean {
  if (!DECISION_ACTION_TYPES.has(row.type as NotificationIntentType)) return true;
  if (row.intent_joined_intent_id == null) return true;
  const context = decisionContextForNotificationCenterRow(
    row,
    normalizeDecisionContext(safeParseJSON(row.intent_decision_context_json, null)),
  );
  const visibilityScope = context?.visibilityScope ?? 'user_private';
  if (visibilityScope === 'system_admin' || visibilityScope === 'tenant_admin') return false;
  if (context?.internalOnly === true) return false;
  if (context?.smoke === true) return false;
  if (typeof row.dedupe_key === 'string' && row.dedupe_key.startsWith('smoke:')) return false;
  if (row.intent_related_entity_type === 'decision_center_smoke') return false;

  const actions = safeParseJSON<NotificationActionButton[]>(row.actions_json, []);
  const logic = buildDecisionLogicForNotificationCenterRow(row, actions, context, visibilityScope);
  if (!logic.quality.safeToShowUser) return false;
  if (!guidanceEnabledForNotificationCenterRow(row)) return true;

  const actionQueue = ['unread', 'read', 'failed', 'open'].includes(String(row.status));
  const requiresUserAction = Boolean(row.intent_requires_user_action);
  if (
    process.env.DECISION_CENTER_DEBUG_EVIDENCE !== '1'
    && actionQueue
    && requiresUserAction
    && sourceFreshnessForNotificationCenterRow(row, context) === 'stale'
  ) {
    return false;
  }
  if (actionQueue && requiresUserAction && !logic.quality.safeForFrontendAction) return false;
  if (actionQueue && !hasMinimumVisibleNotificationGuidance(row, logic, requiresUserAction)) return false;
  return true;
}

function guidanceEnabledForNotificationCenterRow(row: any): boolean {
  const scope = { userId: Number(row.user_id), tenantId: Number(row.tenant_id) };
  return isDecisionCenterGuidanceV1Enabled(process.env, scope)
    && isDecisionCenterGuidanceSkillEnabled(row.source_skill, process.env, scope);
}

function buildDecisionLogicForNotificationCenterRow(
  row: any,
  actions: NotificationActionButton[] = safeParseJSON<NotificationActionButton[]>(row.actions_json, []),
  context: DecisionLogicContext | null = normalizeDecisionContext(safeParseJSON(row.intent_decision_context_json, null)),
  visibilityScope: DecisionVisibilityScope = context?.visibilityScope ?? 'user_private',
) {
  return buildDecisionLogicV2({
    sourceSkill: row.source_skill,
    type: row.type,
    priority: row.priority,
    title: row.title,
    body: row.body,
    safeBody: row.safe_body,
    actions,
    relatedEntityType: row.intent_related_entity_type ?? null,
    relatedEntityId: row.intent_related_entity_id ?? null,
    deadlineAt: row.intent_decision_deadline ?? null,
    expiresAt: row.expires_at ?? null,
    privacyClassification: row.intent_privacy_policy ?? 'standard',
    visibilityScope,
    context,
  } as DecisionLogicInput);
}

function sourceFreshnessForNotificationCenterRow(row: any, context: DecisionLogicContext | null): 'live' | 'fresh' | 'stale' | 'unknown' {
  if (row.status === 'snoozed') return 'stale';
  const state = String(context?.providerSyncState ?? '').toLowerCase();
  if (state && state !== 'synced' && state !== 'deleted') {
    const updatedAt = Date.parse(String(context?.providerSyncUpdatedAt ?? ''));
    if (!Number.isFinite(updatedAt)) return 'unknown';
    return (Date.now() - updatedAt) / 60_000 > 15 ? 'stale' : 'fresh';
  }
  if (context?.providerSyncUpdatedAt) {
    const updatedAt = Date.parse(String(context.providerSyncUpdatedAt));
    if (!Number.isFinite(updatedAt)) return 'unknown';
    return (Date.now() - updatedAt) / 60_000 <= 15 ? 'fresh' : 'live';
  }
  return row.intent_related_entity_id ? 'live' : 'unknown';
}

function decisionContextForNotificationCenterRow(row: any, context: DecisionLogicContext | null): DecisionLogicContext | null {
  if (
    row.source_skill !== 'secretary'
    || row.intent_related_entity_type !== 'secretary_agenda_item'
    || !row.intent_related_entity_id
    || !tableExistsForNotificationRead('secretary_agenda_items')
  ) {
    return context;
  }

  const agenda = getSecretaryAgendaItemById({
    agendaItemId: String(row.intent_related_entity_id),
    ownerUserId: Number(row.user_id),
    tenantId: row.tenant_id,
  });
  if (!agenda) return context;
  return {
    ...(context ?? {}),
    entityTitle: agenda.title,
    currentStartAt: context?.currentStartAt ?? agenda.startAt ?? null,
    currentEndAt: context?.currentEndAt ?? agenda.endAt ?? null,
    sourceState: context?.sourceState ?? agenda.lifecycleState,
    providerSyncState: agenda.providerSyncState,
    providerSyncUpdatedAt: agenda.updatedAt,
  };
}

function hasMinimumVisibleNotificationGuidance(row: any, logic: ReturnType<typeof buildDecisionLogicV2>, requiresUserAction: boolean): boolean {
  const headline = firstNonEmptyString([logic.safePreviewTitle, logic.title, row.title]);
  const whatHappened = firstNonEmptyString([logic.problemStatement, logic.safePreviewBody, row.safe_body, row.body]);
  const userAction = firstNonEmptyString([logic.primaryActionLabel, logic.recommendation]);
  if (!headline || !whatHappened || !userAction) return false;
  if (requiresUserAction && row.type !== 'sync_failure' && !logic.primaryActionLabel) return false;
  return true;
}

function firstNonEmptyString(values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/**
 * Upper bound on rows scanned for the badge. Far above any realistic unread
 * count, and finite so a pathological account cannot turn a badge read into a
 * full-table scan.
 */
const BADGE_COUNT_CEILING = 5000;

export function countUnreadNotificationCenterItems(userId: number, tenantId = userId): number {
  assertScope(userId, tenantId, 'count_unread_notification_center_items');
  try {
    // Derived from the LIST, never from a parallel COUNT(*).
    //
    // `listNotificationCenterItems` post-filters rows through
    // `isUserFacingNotificationCenterRow` — visibility scope, internal/smoke
    // markers, and the guidance quality gate — none of which SQL can express.
    // Any independently-written count therefore drifts from what the user can
    // actually see, and it drifted in both directions: a badge counting rows
    // the inbox refuses to render cannot be cleared by the user, and a
    // suppression clause present only here zeroed the badge while the row
    // remained listed.
    //
    // Bounded by BADGE_COUNT_CEILING rather than the 200-row API page size:
    // paging the inbox and counting the badge are different jobs.
    return queryUserFacingCenterItems(userId, tenantId, { status: 'unread' }, BADGE_COUNT_CEILING)
      .filter((item) => item.requiresUserAction
        && !item.promotional
        && !NON_BADGE_NOTIFICATION_TYPES.includes(item.type))
      .length;
  } catch (err) {
    // Schema readiness or the scoped projection can fail closed during
    // startup/recovery. A zero badge is safer than surfacing another tenant's
    // or an unfiltered count.
    logger.warn({ err, userId, tenantId }, 'badge count failed');
    return 0;
  }
}

export function listNotificationBridgeEntityIds(
  userId: number,
  tenantId: number,
  bridgePrefix: 'content' | 'report',
): number[] {
  assertScope(userId, tenantId, 'list_notification_bridge_entity_ids', { bridgePrefix });
  const rows = getDb().prepare(`
    SELECT dedupe_key AS dedupeKey
      FROM notification_center_items
     WHERE user_id = ?
       AND tenant_id = ?
       AND dedupe_key LIKE ?
       AND status != 'expired'
       AND (expires_at IS NULL OR datetime(expires_at) > datetime(?))
  `).all(userId, tenantId, `${bridgePrefix}:%`, appNowIso()) as Array<{ dedupeKey: string | null }>;
  const ids = new Set<number>();
  // Two bridge key generations coexist in the DB:
  //   legacy:        `content:<type>:<legacyRowId>` / `report:<type>:<reportId>`
  //   entity-stable: `content:<type>:<userId>` (recurring events dedupe per user+type)
  // A content key whose trailing id equals the scoped userId is treated as
  // entity-stable and expanded to the unread legacy rows it covers, so badge
  // exclusion keeps working for both formats.
  const pattern = new RegExp(`^${bridgePrefix}:([^:]+):(\\d+)$`);
  const userScopedContentTypes = new Set<string>();
  for (const row of rows) {
    if (!row.dedupeKey) continue;
    const match = row.dedupeKey.match(pattern);
    if (!match) continue;
    const id = Number.parseInt(match[2], 10);
    if (!Number.isInteger(id) || id <= 0) continue;
    if (bridgePrefix === 'content' && id === userId) {
      userScopedContentTypes.add(match[1]);
      continue;
    }
    ids.add(id);
  }
  if (userScopedContentTypes.size > 0) {
    try {
      for (const legacyId of listUnreadContentNotificationIdsByTypes(userId, [...userScopedContentTypes], tenantId)) {
        if (Number.isInteger(legacyId) && legacyId > 0) ids.add(legacyId);
      }
    } catch (err) {
      logger.warn({ err, userId, tenantId }, 'Notification bridge legacy-id expansion degraded');
    }
  }
  return [...ids];
}

export interface PortalNotificationScope {
  userId: number;
  tenantId: number;
}

export function getAllNotificationCenterItemsForPortal(
  limit = 100,
  scope: PortalNotificationScope,
): NotificationCenterItem[] {
  assertScope(scope.userId, scope.tenantId, 'portal_list_notification_center_items');
  const params: unknown[] = [scope.userId, scope.tenantId];
  params.push(Math.min(Math.max(limit, 1), 250));
  const rows = getDb().prepare(`
    SELECT * FROM notification_center_items
    WHERE user_id = ? AND tenant_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(...params) as any[];
  return rows.map(mapCenterItem);
}

export function getNotificationProfileSummariesForPortal(
  limit = 100,
  scope: PortalNotificationScope,
): Array<{
  userId: number;
  tenantId: number;
  pushEnabled: boolean;
  inAppEnabled: boolean;
  portalEnabled: boolean;
  allowTimeSensitive: boolean;
  digestPassiveItems: boolean;
  updatedAt: string;
}> {
  assertScope(scope.userId, scope.tenantId, 'portal_list_notification_profiles');
  const params: unknown[] = [scope.userId, scope.tenantId];
  params.push(Math.min(Math.max(limit, 1), 250));
  const rows = getDb().prepare(`
    SELECT user_id, tenant_id, push_enabled, in_app_enabled, portal_enabled,
           allow_time_sensitive, digest_passive_items, updated_at
    FROM notification_profiles
    WHERE user_id = ? AND tenant_id = ?
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(...params) as any[];
  return rows.map((row) => ({
    userId: row.user_id,
    tenantId: row.tenant_id,
    pushEnabled: !!row.push_enabled,
    marketingPushEnabled: !!row.marketing_push_enabled,
    inAppEnabled: !!row.in_app_enabled,
    portalEnabled: !!row.portal_enabled,
    allowTimeSensitive: !!row.allow_time_sensitive,
    digestPassiveItems: !!row.digest_passive_items,
    updatedAt: row.updated_at,
  }));
}

export function getNotificationCenterItem(itemId: string, userId: number, tenantId = userId): NotificationCenterItem | null {
  assertScope(userId, tenantId, 'get_notification_center_item', { itemId });
  const row = getDb().prepare(`
    SELECT items.*, intents.intent_id AS intent_joined_intent_id,
           intents.related_entity_id AS intent_related_entity_id,
           intents.related_entity_type AS intent_related_entity_type,
           COALESCE(intents.requires_user_action, items.requires_user_action) AS intent_requires_user_action,
           intents.promotional AS intent_promotional,
           intents.decision_deadline AS intent_decision_deadline,
           intents.privacy_policy AS intent_privacy_policy,
           intents.decision_context_json AS intent_decision_context_json
      FROM notification_center_items items
      LEFT JOIN notification_intents intents
        ON intents.intent_id = items.intent_id
       AND intents.user_id = items.user_id
       AND intents.tenant_id = items.tenant_id
     WHERE items.item_id = ? AND items.user_id = ? AND items.tenant_id = ?
  `).get(itemId, userId, tenantId) as any;
  return row ? mapCenterItem(row) : null;
}

export function markNotificationCenterItemRead(itemId: string, userId: number, tenantId = userId): NotificationCenterItem | null {
  assertScope(userId, tenantId, 'mark_notification_center_item_read', { itemId });
  getDb().prepare(`
    UPDATE notification_center_items
    SET status = CASE WHEN status = 'unread' THEN 'read' ELSE status END,
        read_at = COALESCE(read_at, datetime('now'))
    WHERE item_id = ? AND user_id = ? AND tenant_id = ? AND status IN ('unread', 'read')
      AND (expires_at IS NULL OR datetime(expires_at) > datetime(?))
  `).run(itemId, userId, tenantId, appNowIso());
  const item = getNotificationCenterItem(itemId, userId, tenantId);
  // A1: a past-deadline item is not marked read (guard above) and is not surfaced on open —
  // parity with getDecisionItem. The action path keeps its own DECISION_EXPIRED rejection.
  if (item && item.expiresAt && Date.parse(item.expiresAt) <= Date.now()) return null;
  if (item) markDecisionOpened(item.decisionLogId);
  return item;
}

export function dismissNotificationCenterItem(itemId: string, userId: number, tenantId = userId): NotificationCenterItem | null {
  assertScope(userId, tenantId, 'dismiss_notification_center_item', { itemId });
  getDb().prepare(`
    UPDATE notification_center_items
    SET status = 'dismissed', dismissed_at = datetime('now')
    WHERE item_id = ? AND user_id = ? AND tenant_id = ? AND status IN ('unread', 'read', 'failed', 'snoozed')
  `).run(itemId, userId, tenantId);
  return getNotificationCenterItem(itemId, userId, tenantId);
}

export const SNOOZE_MIN_MINUTES = 5;
export const SNOOZE_MAX_DAYS = 7;
export const SNOOZE_DEFAULT_MINUTES = 60;
/**
 * After this many snoozes an item stops re-interrupting and is routed to the
 * digest instead. Deferring forever is the failure mode a working snooze
 * introduces, so it is bounded from the start.
 */
export const SNOOZE_MAX_COUNT = 3;

/**
 * Clamp a caller-supplied snooze target into [5 min, 7 days] from `now`.
 * Unparseable input falls back to the default hour. Returning a clamped value
 * rather than rejecting keeps the lock-screen button total: iOS cannot show a
 * validation error.
 */
export function resolveSnoozeUntil(snoozedUntil?: string | null, now = new Date()): string {
  const nowMs = now.getTime();
  const min = nowMs + SNOOZE_MIN_MINUTES * 60_000;
  const max = nowMs + SNOOZE_MAX_DAYS * 24 * 60 * 60_000;
  const parsed = typeof snoozedUntil === 'string' ? Date.parse(snoozedUntil) : NaN;
  const requested = Number.isFinite(parsed) ? parsed : nowMs + SNOOZE_DEFAULT_MINUTES * 60_000;
  return new Date(Math.min(Math.max(requested, min), max)).toISOString();
}

export function snoozeNotificationCenterItem(
  itemId: string,
  userId: number,
  tenantId = userId,
  snoozedUntil?: string | null,
  now = new Date(),
): NotificationCenterItem | null {
  assertScope(userId, tenantId, 'snooze_notification_center_item', { itemId });
  const until = resolveSnoozeUntil(snoozedUntil, now);
  const db = getDb();
  db.transaction(() => {
    const updated = db.prepare(`
      UPDATE notification_center_items
      SET status = 'snoozed',
          snoozed_until = ?,
          snooze_count = COALESCE(snooze_count, 0) + 1,
          read_at = COALESCE(read_at, datetime('now'))
      WHERE item_id = ? AND user_id = ? AND tenant_id = ? AND status IN ('unread', 'read')
    `).run(until, itemId, userId, tenantId);
    if ((updated.changes ?? 0) === 0) return;

    // A queued digest/quiet-hours push predates the user's explicit snooze and
    // is no longer a valid delivery instruction. Leaving it claimable means
    // the snooze release pushes once, then the original row pushes the same
    // item again on the next sweep. Terminalize every pending row for this
    // scoped item atomically with the snooze transition; a later quiet-hours
    // deferral creates one fresh row for the new requested release.
    db.prepare(`
      UPDATE notification_decision_logs
      SET decision = 'in_app_only',
          reason = 'pending push superseded by user snooze',
          scheduled_for = NULL
      WHERE notification_id = ?
        AND user_id = ?
        AND tenant_id = ?
        AND sent_at IS NULL
        AND decision IN ('quiet_hours_delayed', 'digest')
    `).run(itemId, userId, tenantId);
  })();
  return getNotificationCenterItem(itemId, userId, tenantId);
}

export interface SnoozeReleaseSummary {
  inspected: number;
  released: number;
  demotedToDigest: number;
  /**
   * Snoozes that came due inside quiet hours and were re-parked until quiet
   * hours end. Counted separately because it is the correct outcome, not a
   * failure — without its own counter a deferred item is indistinguishable
   * from one the sweep silently dropped.
   */
  deferredQuietHours: number;
  blocked: number;
  failed: number;
}

/**
 * Return due snoozed items to the inbox and re-interrupt for them.
 *
 * Nothing did this before: `snoozeNotificationCenterItem` parked the row and
 * the release sweep only ever claimed `quiet_hours_delayed`/`digest` decision
 * logs, so a snoozed item was functionally dismissed. Re-delivery restores the
 * item's ORIGINAL priority — a snoozed conflict is still a conflict — but is
 * deferred out of quiet hours and demoted to the digest once the item has been
 * snoozed SNOOZE_MAX_COUNT times.
 */
export async function releaseDueSnoozedNotifications(now = new Date()): Promise<SnoozeReleaseSummary> {
  const db = getDb();
  const nowIso = now.toISOString();
  const rows = db.prepare(`
    SELECT items.item_id, items.user_id, items.tenant_id, items.snooze_count, items.decision_log_id, intents.*
      FROM notification_center_items items
      JOIN notification_intents intents ON intents.intent_id = items.intent_id
       AND intents.user_id = items.user_id
       AND intents.tenant_id = items.tenant_id
     WHERE items.status = 'snoozed'
       AND items.snoozed_until IS NOT NULL
       AND datetime(items.snoozed_until) <= datetime(?)
       AND (items.expires_at IS NULL OR datetime(items.expires_at) > datetime(?))
     ORDER BY items.snoozed_until ASC
     LIMIT 100
  `).all(nowIso, nowIso) as any[];

  const restore = db.prepare(`
    UPDATE notification_center_items
    SET status = 'unread', snoozed_until = NULL
    WHERE item_id = ? AND user_id = ? AND tenant_id = ? AND status = 'snoozed'
  `);

  let released = 0;
  let demotedToDigest = 0;
  let deferredQuietHours = 0;
  let blocked = 0;
  let failed = 0;

  for (const row of rows) {
    await withUserEvaluationLock(row.user_id, row.tenant_id, async () => {
      try {
      // CAS: a concurrent sweep or a user action may already have moved it.
      if ((restore.run(row.item_id, row.user_id, row.tenant_id).changes ?? 0) === 0) return;

      const intent = mapIntent(row);
      const profile = getOrCreateNotificationProfile(row.user_id, row.tenant_id);
      recordNotificationEngagementEvent({
        userId: row.user_id,
        tenantId: row.tenant_id,
        notificationId: row.item_id,
        intentId: intent.intentId,
        sourceSkill: intent.sourceSkill,
        type: intent.type,
        priority: intent.priority,
        eventType: 'surfaced',
      });

      // Repeated snoozing is the user telling us this does not deserve an
      // interrupt. Honour that rather than re-ringing a fourth time.
      if ((row.snooze_count ?? 0) >= SNOOZE_MAX_COUNT) {
        demotedToDigest += 1;
        return;
      }
      // This must be the PUSHABLE gate, not the deliverable one. The weak gate
      // only asks "may this user receive this at all" — it ignores pushEnabled,
      // marketing consent, `in_app_only`/`portal_only` delivery policy and
      // per-type suppression. Snooze therefore routed around three separate
      // consent decisions: a user who had turned push off, or who had confined
      // a type to the app, got an APNs interrupt purely by having snoozed it.
      // The item is already restored to the inbox above, so failing this gate
      // withholds the interrupt only — the content is still there to read.
      const snoozeBlockCause = notificationPushBlockCause(intent, profile);
      if (isRetryablePushBlock(snoozeBlockCause)) {
        // The item is already back in the inbox (restored above), so only the
        // interrupt is at stake — and an unreadable suppression table is not a
        // reason to lose it permanently. Re-park briefly so the next sweep
        // re-evaluates, rather than dropping it.
        db.prepare(`
          UPDATE notification_center_items
          SET status = 'snoozed', snoozed_until = ?
          WHERE item_id = ? AND user_id = ? AND tenant_id = ?
        `).run(nowIso, row.item_id, row.user_id, row.tenant_id);
        blocked += 1;
        failed += 1;
        logger.warn({
          itemId: row.item_id, userId: row.user_id,
        }, 'snoozed notification re-queued: suppression state unreadable, retrying next sweep');
        return;
      }
      if (snoozeBlockCause !== null) {
        blocked += 1;
        return;
      }
      const effectivePriority = normalizePriorityForPolicy(intent.priority, profile);
      const quiet = quietHoursDecision(profile, intent, effectivePriority);
      if (quiet.delayed) {
        // The item STAYS visible — the user asked to be shown it again at this
        // time, and the inbox hides `snoozed` rows. Re-parking it (the old
        // behaviour) meant a reminder that came due at 22:00 vanished from the
        // inbox until quiet hours ended the next morning, which reads as lost
        // rather than deferred.
        //
        // Only the interrupt waits, and it waits on the regular release sweep
        // rather than on a second snooze: a `quiet_hours_delayed` log with a
        // `scheduled_for` is exactly what that sweep consumes, and it re-checks
        // preferences and quiet hours again at release time.
        persistDecisionLog({
          intent,
          evaluationId: `snooze:${row.snooze_count}`,
          notificationId: row.item_id,
          decision: 'quiet_hours_delayed',
          priority: effectivePriority,
          reason: 'snoozed notification came due during quiet hours; push deferred, item left visible',
          scheduledFor: quiet.scheduledFor ?? nowIso,
          sentAt: null,
          deliveryAttemptIds: [],
        });
        deferredQuietHours += 1;
        return;
      }

      // Resolved ONCE and threaded into both. Letting each helper resolve
      // independently cost two indexed `users` lookups per notification, not
      // the one the design note claims.
      const copyLanguage = notificationCopyLanguage(intent.userId);
      const payload = {
        title: safeNotificationTitle(intent, copyLanguage),
        body: buildPrivacySafeBody(intent, copyLanguage),
        deeplink: intent.deeplink,
        actions: intent.actionButtons,
        interruptionLevel: interruptionLevelForPriority(effectivePriority),
      };
      // Re-apply the decision quality/rank gate. Without this a decision the
      // gate refused to push at creation time would acquire a push simply by
      // being snoozed — snooze must not be a route around the gate.
      const plan = buildDecisionPushPlan({ ...intent, priority: effectivePriority }, payload);
      if (plan && !plan.eligible) {
        blocked += 1;
        return;
      }
      if (plan?.interruptionLevel) payload.interruptionLevel = plan.interruptionLevel;
      const attempt = await attemptPushDelivery(
        intent,
        row.item_id,
        payload,
        profile,
        `snooze:${row.snooze_count}`,
      );
      // Every other push in this service writes a decision log; this path did
      // not. That made snooze re-delivery invisible twice over: absent from the
      // audit trail, and uncounted by the interrupt budget, which sums
      // `sent_push` rows. Re-snoozing was therefore an unbounded source of
      // interrupts that no cap could see.
      //
      // The budget is CHARGED here but deliberately not CHECKED: the user
      // explicitly asked to be reminded at this moment, so the right behaviour
      // is to honour it and let it count against later, less-asked-for
      // interrupts. The surrounding per-user lock still matters: it makes this
      // sent_push row visible before any queued ambient delivery evaluates its
      // budget, closing the snooze-vs-ambient check/await/write race without
      // overriding the user's explicit request.
      persistDecisionLog({
        intent,
        evaluationId: `snooze:${row.snooze_count}`,
        notificationId: row.item_id,
        decision: attempt.status === 'sent'
          ? 'sent_push'
          : attempt.status === 'blocked_expired'
            ? 'in_app_only'
          : attempt.status === 'blocked_missing_device_token'
            ? 'blocked_missing_device_token'
            : 'apns_delivery_failed',
        priority: effectivePriority,
        reason: attempt.status === 'sent'
          ? 'snoozed notification returned to the user'
          : attempt.status === 'blocked_expired'
            ? 'snoozed notification expired before APNs dispatch'
          : `snoozed notification release failed: ${attempt.status}`,
        scheduledFor: null,
        sentAt: attempt.sentAt,
        deliveryAttemptIds: attempt.attemptId === null ? [] : [attempt.attemptId],
      });
      if (attempt.status === 'sent') released += 1;
      else blocked += 1;
      if (attempt.status === 'failed') failed += 1;
      } catch (err) {
        blocked += 1;
        failed += 1;
        logger.warn({ err, itemId: row.item_id }, 'Snoozed notification release failed');
      }
    });
  }

  return { inspected: rows.length, released, demotedToDigest, deferredQuietHours, blocked, failed };
}

export function performNotificationAction(
  itemId: string,
  actionId: string,
  userId: number,
  tenantId = userId,
  opts: { snoozedUntil?: string | null } = {},
): { item: NotificationCenterItem; actionId: string; idempotent: boolean } {
  assertScope(userId, tenantId, 'perform_notification_action', { itemId, actionId });
  const item = getNotificationCenterItem(itemId, userId, tenantId);
  if (!item) throw new Error('notification not found for authenticated user');
  if (item.expiresAt && Date.parse(item.expiresAt) <= Date.now()) {
    getDb().prepare(`
      UPDATE notification_center_items SET status = 'expired'
      WHERE item_id = ? AND user_id = ? AND tenant_id = ?
    `).run(itemId, userId, tenantId);
    throw new Error('notification expired');
  }
  if (item.status === 'superseded') throw new Error('notification superseded');
  if (item.status === 'dismissed') throw new Error('notification dismissed');
  if (item.status === 'actioned') throw new Error('notification already actioned');
  if (!item.actions.some((action) => action.id === actionId)) {
    recordNotificationReliabilityEvent({
      userId,
      tenantId,
      eventType: 'unsupported_action_blocked',
      source: notificationReliabilityTopicSource(item),
      errorCode: actionId,
    });
    throw new Error('action not allowed for notification');
  }

  const logEngagement = (
    updated: NotificationCenterItem,
    eventType: NotificationEngagementEventType,
  ): void => {
    recordNotificationEngagementEvent({
      userId,
      tenantId,
      notificationId: updated.itemId,
      intentId: updated.intentId,
      sourceSkill: updated.sourceSkill,
      type: updated.type,
      priority: updated.priority,
      eventType,
      actionId,
      latencyMs: Date.parse(updated.createdAt) ? Date.now() - Date.parse(updated.createdAt) : null,
    });
  };

  // `reconnect` behaves exactly like `open_detail` here: both are navigation.
  // The provider re-auth happens in the app under normal authentication, so
  // there is no domain mutation to execute or verify.
  if (actionId === 'open_detail' || actionId === 'reconnect') {
    const updated = markNotificationCenterItemRead(itemId, userId, tenantId);
    if (!updated) throw new Error('notification action failed');
    markDecisionActionTaken(updated.decisionLogId, actionId);
    logEngagement(updated, actionId === 'reconnect' ? 'actioned' : 'opened');
    return { item: updated, actionId, idempotent: false };
  }

  if (actionId === 'dismiss') {
    const updated = dismissNotificationCenterItem(itemId, userId, tenantId);
    if (!updated) throw new Error('notification action failed');
    markDecisionActionTaken(updated.decisionLogId, actionId);
    logEngagement(updated, 'dismissed');
    return { item: updated, actionId, idempotent: false };
  }

  if (actionId === 'snooze') {
    const updated = snoozeNotificationCenterItem(itemId, userId, tenantId, opts.snoozedUntil);
    if (!updated) throw new Error('notification action failed');
    markDecisionActionTaken(updated.decisionLogId, actionId);
    logEngagement(updated, 'snoozed');
    return { item: updated, actionId, idempotent: false };
  }

  recordNotificationReliabilityEvent({
    userId,
    tenantId,
    eventType: isNotificationActionMutating(actionId) ? 'unsupported_action_blocked' : 'action_failed',
    source: notificationReliabilityTopicSource(item),
    errorCode: actionId,
  });
  throw new Error('notification action requires a deterministic executor');
}

function notificationReliabilityTopicSource(item: NotificationCenterItem): string {
  let recipe = '';
  try {
    const row = getDb().prepare(`
      SELECT decision_context_json AS decisionContextJson
        FROM notification_intents
       WHERE intent_id = ?
         AND user_id = ?
         AND tenant_id = ?
       LIMIT 1
    `).get(item.intentId, item.userId, item.tenantId) as { decisionContextJson: string | null } | undefined;
    recipe = recipeFromDecisionContextJson(row?.decisionContextJson ?? null) ?? '';
  } catch {
    recipe = '';
  }
  return `topic:${item.sourceSkill}:${item.type}:${recipe}`;
}

function revokePriorActiveDeviceTokenOwners(
  db: ReturnType<typeof getDb>,
  deviceId: string,
  currentUserId: number,
): void {
  const priorRows = db.prepare(`
    SELECT DISTINCT user_id, tenant_id
    FROM notification_device_tokens
    WHERE device_id = ?
      AND user_id != ?
      AND revoked_at IS NULL
  `).all(deviceId, currentUserId) as Array<{ user_id: number; tenant_id: number }>;

  if (priorRows.length === 0) return;

  db.prepare(`
    UPDATE notification_device_tokens
    SET revoked_at = COALESCE(revoked_at, datetime('now'))
    WHERE device_id = ?
      AND user_id != ?
      AND revoked_at IS NULL
  `).run(deviceId, currentUserId);

  for (const row of priorRows) {
    const activeCount = (db.prepare(`
      SELECT COUNT(*) AS count
      FROM notification_device_tokens
      WHERE user_id = ?
        AND tenant_id = ?
        AND revoked_at IS NULL
    `).get(row.user_id, row.tenant_id) as { count: number }).count;
    if (activeCount > 0) continue;

    db.prepare(`
      UPDATE notification_decision_logs
      SET decision = 'blocked_missing_device_token',
          reason = 'device token re-associated to another authenticated user',
          sent_at = COALESCE(sent_at, datetime('now'))
      WHERE user_id = ?
        AND tenant_id = ?
        AND sent_at IS NULL
        AND decision IN ('quiet_hours_delayed', 'digest')
    `).run(row.user_id, row.tenant_id);
  }
}

export type NotificationAuthorizationTier = 'provisional' | 'authorized' | 'ephemeral' | 'denied';

const AUTHORIZATION_TIERS: readonly NotificationAuthorizationTier[] = ['provisional', 'authorized', 'ephemeral', 'denied'];

function normalizeAuthorizationTier(value: unknown): NotificationAuthorizationTier {
  return AUTHORIZATION_TIERS.includes(value as NotificationAuthorizationTier)
    ? value as NotificationAuthorizationTier
    // Every token minted before this existed came from a full authorization
    // request, so an unreported tier is 'authorized' rather than unknown.
    : 'authorized';
}

function normalizeIanaZone(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const zone = value.trim();
  if (!zone) return null;
  return DateTime.local().setZone(zone).isValid ? zone : null;
}

/**
 * What the server can actually promise about reaching this user.
 *
 * Under `.provisional` iOS delivers to Notification Center only: no banner, no
 * sound, no lock-screen alert, and `interruption-level` is IGNORED. A producer
 * that mints a time-sensitive intent for a provisional-only user is therefore
 * making a promise the platform will not keep — which matters most for exactly
 * the archetypes that must ring, MFA codes with a five-minute life.
 */
export function notificationReachability(userId: number, tenantId = userId): {
  hasToken: boolean;
  canInterrupt: boolean;
  tiers: NotificationAuthorizationTier[];
} {
  try {
    const rows = getDb().prepare(`
      SELECT DISTINCT authorization_tier AS tier
        FROM notification_device_tokens
       WHERE user_id = ? AND tenant_id = ? AND revoked_at IS NULL
    `).all(userId, tenantId) as Array<{ tier: string }>;
    const tiers = rows.map((row) => normalizeAuthorizationTier(row.tier));
    return {
      hasToken: tiers.length > 0,
      // Only a full grant can break through. Provisional and ephemeral deliver
      // quietly; denied does not deliver at all.
      canInterrupt: tiers.includes('authorized'),
      tiers,
    };
  } catch (err) {
    logger.warn({ err, userId }, 'reachability lookup failed; assuming interruptible');
    // Fail open: a producer that withholds on a transient read fault would
    // silently drop a legitimate alert.
    return { hasToken: true, canInterrupt: true, tiers: [] };
  }
}

/**
 * Device-reported timezone drift, for the client to offer in context.
 *
 * Deliberately NOT applied automatically. Auto-shifting would move every
 * scheduled notification — brief time, quiet hours, every lead time — without
 * the user asking, and would thrash for anyone who commutes across a border.
 */
export function notificationTimezoneDrift(userId: number, tenantId = userId): {
  profileTimezone: string;
  deviceTimezone: string | null;
  drifted: boolean;
  reportedAt: string | null;
} {
  const profile = getOrCreateNotificationProfile(userId, tenantId);
  try {
    const row = getDb().prepare(`
      SELECT device_timezone AS deviceTimezone, device_timezone_reported_at AS reportedAt
        FROM notification_device_tokens
       WHERE user_id = ? AND tenant_id = ? AND revoked_at IS NULL AND device_timezone IS NOT NULL
       ORDER BY datetime(device_timezone_reported_at) DESC
       LIMIT 1
    `).get(userId, tenantId) as { deviceTimezone: string | null; reportedAt: string | null } | undefined;
    const deviceTimezone = row?.deviceTimezone ?? null;
    return {
      profileTimezone: profile.timezone,
      deviceTimezone,
      drifted: Boolean(deviceTimezone && deviceTimezone !== profile.timezone),
      reportedAt: row?.reportedAt ?? null,
    };
  } catch (err) {
    logger.warn({ err, userId }, 'timezone drift lookup failed');
    return { profileTimezone: profile.timezone, deviceTimezone: null, drifted: false, reportedAt: null };
  }
}

export function registerNotificationDeviceToken(opts: {
  userId: number;
  tenantId?: number;
  token: string;
  platform?: 'ios';
  environment?: 'sandbox' | 'production';
  deviceId?: string | null;
  appVersion?: string | null;
  /**
   * IANA zone the DEVICE is currently in. Advisory only — see migration 271.
   * Invalid values are ignored rather than rejected: a bad zone from a client
   * must not stop it registering for push.
   */
  deviceTimezone?: string | null;
  /**
   * What iOS actually granted. Under `.provisional` notifications are delivered
   * quietly and interruption-level is ignored, so this changes what the server
   * can promise a producer.
   */
  authorizationTier?: NotificationAuthorizationTier | null;
}): DeviceTokenRegistration {
  const tenantId = opts.tenantId ?? opts.userId;
  assertScope(opts.userId, tenantId, 'register_notification_device_token');
  const token = opts.token.trim();
  if (!token) throw new Error('device token required');

  const tokenHash = hashToken(token);
  const tokenSuffix = token.slice(-8);
  const tokenId = `dt_${randomUUID()}`;
  const environment = opts.environment ?? 'sandbox';
  const deviceId = opts.deviceId?.trim() || `ios-${tokenHash.slice(0, 16)}`;
  // A malformed zone from a client must never stop it registering for push;
  // it is advisory data, so it is dropped rather than rejected.
  const deviceTimezone = normalizeIanaZone(opts.deviceTimezone);
  // "The client reported a tier" and "the client said nothing" are different
  // facts and must not collapse to the same value. Normalizing an absent tier
  // straight to 'authorized' let any caller that omits the field silently
  // PROMOTE an existing provisional grant to a full one — and one such caller
  // is still mounted (`POST /api/v1/settings/push-token` sends no tier). That
  // re-opens exactly the quiet-delivery blind spot migration 271 exists to
  // close. A first registration still defaults to 'authorized'; only the
  // overwrite of a known tier is suppressed.
  const reportedTier = opts.authorizationTier == null
    ? null
    : normalizeAuthorizationTier(opts.authorizationTier);
  const authorizationTier = reportedTier ?? 'authorized';
  const db = getDb();

  db.transaction(() => {
    db.prepare(`
      INSERT INTO ios_devices (user_id, device_id, device_name, push_token, refresh_token, last_active_at)
      VALUES (?, ?, NULL, ?, '', datetime('now'))
      ON CONFLICT(device_id) DO UPDATE SET
        user_id = excluded.user_id,
        push_token = excluded.push_token,
        last_active_at = datetime('now')
    `).run(opts.userId, deviceId, token);

    db.prepare(`
      INSERT INTO notification_device_tokens (
        token_id, user_id, tenant_id, platform, token_hash, token_suffix, environment,
        device_id, app_version, device_timezone, device_timezone_reported_at,
        authorization_tier, last_seen_at, revoked_at
      )
      VALUES (?, ?, ?, 'ios', ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), NULL)
      ON CONFLICT(user_id, tenant_id, platform, token_hash, environment) DO UPDATE SET
        device_id = excluded.device_id,
        app_version = excluded.app_version,
        device_timezone = COALESCE(excluded.device_timezone, notification_device_tokens.device_timezone),
        device_timezone_reported_at = COALESCE(excluded.device_timezone_reported_at, notification_device_tokens.device_timezone_reported_at),
        authorization_tier = COALESCE(?, notification_device_tokens.authorization_tier),
        token_suffix = excluded.token_suffix,
        last_seen_at = datetime('now'),
        revoked_at = NULL
    `).run(
      tokenId, opts.userId, tenantId, tokenHash, tokenSuffix, environment, deviceId,
      opts.appVersion ?? null, deviceTimezone, deviceTimezone ? new Date().toISOString() : null,
      authorizationTier,
      // Bound after the VALUES list because the DO UPDATE clause is textually last.
      reportedTier,
    );

    revokePriorActiveDeviceTokenOwners(db, deviceId, opts.userId);
  })();

  const row = db.prepare(`
    SELECT * FROM notification_device_tokens
    WHERE user_id = ? AND tenant_id = ? AND token_hash = ? AND environment = ? AND revoked_at IS NULL
    LIMIT 1
  `).get(opts.userId, tenantId, tokenHash, environment) as any;
  return mapDeviceToken(row);
}

/**
 * Revoke token rows the APNs sender reported as 410 Unregistered. The sender
 * already cleared ios_devices.push_token; without this the
 * notification_device_tokens rows stayed active forever (the stale May-08
 * token found in the 2026-07-04 audit) and failures were mislabeled.
 */
export function markDeviceTokensUnregistered(userId: number, tenantId: number, rawTokens: string[]): void {
  if (rawTokens.length === 0) return;
  try {
    const db = getDb();
    const stmt = db.prepare(`
      UPDATE notification_device_tokens
         SET revoked_at = datetime('now')
       WHERE user_id = ? AND tenant_id = ? AND token_hash = ? AND revoked_at IS NULL
    `);
    for (const token of rawTokens) {
      stmt.run(userId, tenantId, hashToken(token));
    }
  } catch (err) {
    logger.warn({ err, userId }, 'Failed to revoke unregistered device tokens');
  }
}

/**
 * Successful APNs delivery is proof the user's active tokens are alive —
 * refresh last_seen_at so the stale-token pruning job (90d) never reaps a
 * device that is actually receiving pushes. Registration was previously the
 * only writer, so long-lived installs looked stale.
 */
export function touchDeviceTokenActivity(userId: number, tenantId: number): void {
  try {
    getDb().prepare(`
      UPDATE notification_device_tokens
         SET last_seen_at = datetime('now')
       WHERE user_id = ? AND tenant_id = ? AND revoked_at IS NULL
    `).run(userId, tenantId);
  } catch (err) {
    logger.debug({ err, userId }, 'Failed to touch device token activity');
  }
}

/**
 * Daily stale-token pruning: revoke active tokens with no activity signal
 * (registration or successful delivery) in NOTIFICATION_TOKEN_STALE_DAYS
 * (default 90, 0 disables). Returns the number of tokens revoked.
 */
export function pruneStaleDeviceTokens(): number {
  const raw = process.env.NOTIFICATION_TOKEN_STALE_DAYS;
  const parsed = raw == null || raw.trim() === '' ? NaN : Number.parseInt(raw, 10);
  const staleDays = Number.isFinite(parsed) && parsed >= 0 ? parsed : 90;
  if (staleDays === 0) return 0;
  try {
    const result = getDb().prepare(`
      UPDATE notification_device_tokens
         SET revoked_at = datetime('now')
       WHERE revoked_at IS NULL
         AND last_seen_at < datetime('now', ?)
    `).run(`-${staleDays} days`);
    const revoked = Number(result.changes ?? 0);
    if (revoked > 0) {
      logger.info({ revoked, staleDays }, 'Pruned stale device tokens');
    }
    return revoked;
  } catch (err) {
    logger.warn({ err }, 'Stale device token pruning failed');
    return 0;
  }
}

export function revokeNotificationDeviceToken(tokenId: string, userId: number, tenantId = userId): boolean {
  assertScope(userId, tenantId, 'revoke_notification_device_token', { tokenId });
  const db = getDb();
  const row = db.prepare(`
    SELECT * FROM notification_device_tokens
    WHERE token_id = ? AND user_id = ? AND tenant_id = ? AND revoked_at IS NULL
  `).get(tokenId, userId, tenantId) as any;
  if (!row) return false;
  db.prepare(`
    UPDATE notification_device_tokens
    SET revoked_at = datetime('now')
    WHERE token_id = ? AND user_id = ? AND tenant_id = ?
  `).run(tokenId, userId, tenantId);
  if (row.device_id) {
    db.prepare(`
      UPDATE ios_devices SET push_token = NULL
      WHERE user_id = ? AND device_id = ?
    `).run(userId, row.device_id);
  }
  return true;
}

export function getNotificationDecisionLog(
  decisionLogId: string,
  userId: number,
  tenantId = userId,
): NotificationDecisionLog | null {
  assertScope(userId, tenantId, 'get_notification_decision_log', { decisionLogId });
  const row = getDb().prepare(`
    SELECT * FROM notification_decision_logs
    WHERE decision_log_id = ? AND user_id = ? AND tenant_id = ?
  `).get(decisionLogId, userId, tenantId) as any;
  return row ? mapDecisionLog(row) : null;
}

export function getNotificationDeliveryObservabilityMetrics(
  userId: number,
  tenantId = userId,
): NotificationDeliveryObservabilityMetrics {
  assertScope(userId, tenantId, 'get_notification_delivery_observability_metrics');
  const decisionRows = getDb().prepare(`
    SELECT decision, reason, source_skill AS sourceSkill
      FROM notification_decision_logs
     WHERE user_id = ? AND tenant_id = ?
  `).all(userId, tenantId) as Array<{ decision: NotificationDecision; reason: string; sourceSkill: string }>;
  const attemptRows = getDb().prepare(`
    SELECT status
      FROM notification_delivery_attempts
     WHERE user_id = ? AND tenant_id = ? AND channel = 'push'
  `).all(userId, tenantId) as Array<{ status: DeliveryAttempt['status'] }>;
  const blockedByReason: Record<string, number> = {};
  for (const row of decisionRows) {
    if (row.decision === 'sent_push') continue;
    const reason = normalizeBlockedReason(row.reason);
    blockedByReason[reason] = (blockedByReason[reason] ?? 0) + 1;
  }
  return {
    userId,
    tenantId,
    totalDecisions: decisionRows.length,
    pushAttemptCount: attemptRows.length,
    // Historical read: pre-2026-07-04 rows carry 'mock_sent'; keep counting
    // them so observability over old data stays truthful.
    pushSentCount: attemptRows.filter((row) => row.status === 'sent' || (row.status as string) === 'mock_sent').length,
    pushBlockedCount: attemptRows.filter((row) => row.status.startsWith('blocked_') || row.status === 'failed').length,
    visibleDecisionPushAllowedCount: decisionRows.filter((row) => row.decision === 'sent_push' && row.reason.includes('privacy-safe payload')).length,
    visibleDecisionPushBlockedCount: decisionRows.filter((row) => row.reason.startsWith('decision rank gate') || row.reason.startsWith('decision quality gate')).length,
    inAppOnlyCount: decisionRows.filter((row) => row.decision === 'in_app_only').length,
    digestCount: decisionRows.filter((row) => row.decision === 'digest').length,
    blockedByReason,
  };
}

export function recordNotificationReliabilityEvent(input: NotificationReliabilityEventInput): void {
  const tenantId = input.tenantId ?? input.userId;
  assertScope(input.userId, tenantId, 'record_notification_reliability_event', {
    eventType: input.eventType,
    source: input.source ?? null,
  });
  if (![
    'badge_reconciled',
    'read_state_failure',
    'server_read_failure',
    'action_failed',
    'unsupported_action_blocked',
    'dead_deeplink_detected',
    'quality_gate_blocked',
  ].includes(input.eventType)) {
    throw new Error('invalid notification reliability event type');
  }
  const badgeCount = Number.isInteger(input.badgeCount) && input.badgeCount! >= 0
    ? Math.min(input.badgeCount!, 99_999)
    : null;
  const source = sanitizeReliabilityScalar(input.source, 80);
  const errorCode = sanitizeReliabilityScalar(input.errorCode, 120);
  getDb().prepare(`
    INSERT INTO notification_reliability_events (
      event_id, user_id, tenant_id, event_type, badge_count, source, error_code, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(
    `nre_${randomUUID()}`,
    input.userId,
    tenantId,
    input.eventType,
    badgeCount,
    source,
    errorCode,
  );
}

export function getNotificationReliabilityDashboard(
  userId: number,
  tenantId = userId,
  opts: { expectedBadgeCount?: number; canonicalUnreadCount?: number } = {},
): NotificationReliabilityDashboard {
  assertScope(userId, tenantId, 'get_notification_reliability_dashboard');
  const db = getDb();
  const delivery = getNotificationDeliveryObservabilityMetrics(userId, tenantId);
  const dedupe = db.prepare(`
    SELECT
      SUM(CASE WHEN logs.decision = 'deduped' THEN 1 ELSE 0 END) AS dedupedCount,
      COUNT(DISTINCT CASE WHEN items.dedupe_key IS NOT NULL AND items.status != 'expired' THEN items.dedupe_key END) AS activeDedupeKeyCount
      FROM notification_decision_logs logs
      LEFT JOIN notification_center_items items
        ON items.item_id = logs.notification_id
       AND items.user_id = logs.user_id
       AND items.tenant_id = logs.tenant_id
     WHERE logs.user_id = ? AND logs.tenant_id = ?
  `).get(userId, tenantId) as { dedupedCount: number | null; activeDedupeKeyCount: number | null };
  const digest = db.prepare(`
    SELECT
      SUM(CASE WHEN decision = 'digest' AND sent_at IS NULL THEN 1 ELSE 0 END) AS pendingCount,
      SUM(CASE WHEN decision = 'digest' AND sent_at IS NULL AND scheduled_for IS NOT NULL AND datetime(scheduled_for) <= datetime(?) THEN 1 ELSE 0 END) AS dueCount,
      SUM(CASE WHEN reason LIKE 'digest notification released%' THEN 1 ELSE 0 END) AS releasedCount
      FROM notification_decision_logs
     WHERE user_id = ? AND tenant_id = ?
  `).get(appNowIso(), userId, tenantId) as { pendingCount: number | null; dueCount: number | null; releasedCount: number | null };
  const latestBadgeEvent = db.prepare(`
    SELECT badge_count AS badgeCount
      FROM notification_reliability_events
     WHERE user_id = ?
       AND tenant_id = ?
       AND event_type = 'badge_reconciled'
       AND badge_count IS NOT NULL
     ORDER BY datetime(created_at) DESC
     LIMIT 1
  `).get(userId, tenantId) as { badgeCount: number | null } | undefined;
  const readState = db.prepare(`
    SELECT COUNT(*) AS clientReportedReadFailureCount
      FROM notification_reliability_events
     WHERE user_id = ?
       AND tenant_id = ?
       AND event_type = 'read_state_failure'
       AND datetime(created_at) >= datetime('now', '-24 hours')
  `).get(userId, tenantId) as { clientReportedReadFailureCount: number | null };
  const qualityEvents = db.prepare(`
    SELECT event_type AS eventType, COUNT(*) AS count
      FROM notification_reliability_events
     WHERE user_id = ?
       AND tenant_id = ?
       AND event_type IN ('unsupported_action_blocked', 'action_failed', 'dead_deeplink_detected', 'quality_gate_blocked', 'server_read_failure')
       AND datetime(created_at) >= datetime('now', '-24 hours')
     GROUP BY event_type
  `).all(userId, tenantId) as Array<{ eventType: string; count: number }>;
  const qualityEventCounts = Object.fromEntries(qualityEvents.map((row) => [row.eventType, row.count]));
  const suppressedOrGatedCount = (db.prepare(`
    SELECT COUNT(*) AS count
      FROM notification_decision_logs
     WHERE user_id = ?
       AND tenant_id = ?
       AND (
         decision = 'suppressed'
         OR reason LIKE 'decision quality gate%'
         OR reason LIKE 'decision rank gate blocked%'
         OR reason LIKE 'notifications disabled%'
       )
  `).get(userId, tenantId) as { count: number }).count;
  const activeDeeplinkRows = db.prepare(`
    SELECT deeplink
      FROM notification_center_items
     WHERE user_id = ?
       AND tenant_id = ?
       AND status IN ('unread', 'read', 'failed', 'snoozed')
       AND (expires_at IS NULL OR datetime(expires_at) > datetime(?))
  `).all(userId, tenantId, appNowIso()) as Array<{ deeplink: string | null }>;
  const deadDeeplinkCount = activeDeeplinkRows
    .filter((row) => !row.deeplink || !isSupportedNotificationDeeplink(row.deeplink))
    .length;
  const genericMutatingActionSuccessCount = (db.prepare(`
    SELECT COUNT(*) AS count
      FROM notification_decision_logs logs
      JOIN notification_center_items items
        ON items.item_id = logs.notification_id
       AND items.user_id = logs.user_id
       AND items.tenant_id = logs.tenant_id
     WHERE logs.user_id = ?
       AND logs.tenant_id = ?
       AND logs.action_taken IN (
         'approve_script', 'request_rewrite', 'accept_reflow', 'choose_another_time',
         'retry', 'option_a', 'option_b', 'mark_paid', 'add_meal', 'undo_reflow',
         'accept_chat_action_fix'
       )
       AND items.type NOT IN (
         'decision_required', 'conflict_detected', 'reflow_suggestion',
         'approval_required', 'sync_failure', 'security_account'
       )
  `).get(userId, tenantId) as { count: number }).count;
  const defaultCanonicalUnreadCount = countUnreadNotificationCenterItems(userId, tenantId);
  const expectedBadgeCount = Number.isInteger(opts.expectedBadgeCount)
    ? Math.max(0, opts.expectedBadgeCount!)
    : defaultCanonicalUnreadCount;
  const canonicalUnreadCount = Number.isInteger(opts.canonicalUnreadCount)
    ? Math.max(0, opts.canonicalUnreadCount!)
    : defaultCanonicalUnreadCount;
  const clientReportedBadgeCount = latestBadgeEvent?.badgeCount ?? null;
  const badgeDrift = clientReportedBadgeCount == null ? null : clientReportedBadgeCount - expectedBadgeCount;
  const byTopic = buildNotificationReliabilityTopicBreakdown(db, userId, tenantId);
  return {
    userId,
    tenantId,
    generatedAt: new Date().toISOString(),
    dedupe: {
      dedupedCount: dedupe.dedupedCount ?? 0,
      activeDedupeKeyCount: dedupe.activeDedupeKeyCount ?? 0,
    },
    digest: {
      pendingCount: digest.pendingCount ?? 0,
      dueCount: digest.dueCount ?? 0,
      releasedCount: digest.releasedCount ?? 0,
    },
    pushOutcome: {
      attemptCount: delivery.pushAttemptCount,
      sentCount: delivery.pushSentCount,
      blockedCount: delivery.pushBlockedCount,
      blockedByReason: delivery.blockedByReason,
    },
    badge: {
      expectedBadgeCount,
      canonicalUnreadCount,
      clientReportedBadgeCount,
      drift: badgeDrift,
    },
    readState: {
      serverReadFailureCount: qualityEventCounts.server_read_failure ?? 0,
      clientReportedReadFailureCount: readState.clientReportedReadFailureCount ?? 0,
    },
    quality: {
      suppressedOrGatedCount: suppressedOrGatedCount + (qualityEventCounts.quality_gate_blocked ?? 0),
      unsupportedActionBlockedCount: qualityEventCounts.unsupported_action_blocked ?? 0,
      actionFailureCount: qualityEventCounts.action_failed ?? 0,
      deadDeeplinkCount: deadDeeplinkCount + (qualityEventCounts.dead_deeplink_detected ?? 0),
      genericMutatingActionSuccessCount,
      byTopic,
    },
  };
}

type TopicBreakdownAccumulator = NotificationReliabilityTopicBreakdown;

function buildNotificationReliabilityTopicBreakdown(
  db: ReturnType<typeof getDb>,
  userId: number,
  tenantId: number,
): NotificationReliabilityTopicBreakdown[] {
  const byKey = new Map<string, TopicBreakdownAccumulator>();
  const get = (sourceSkill: string | null | undefined, type: string | null | undefined, recipe: string | null | undefined): TopicBreakdownAccumulator => {
    const normalizedSource = sourceSkill || 'unknown';
    const normalizedType = type || null;
    const normalizedRecipe = recipe || null;
    const key = `${normalizedSource}\u0000${normalizedType ?? ''}\u0000${normalizedRecipe ?? ''}`;
    let entry = byKey.get(key);
    if (!entry) {
      entry = {
        sourceSkill: normalizedSource,
        type: normalizedType,
        recipe: normalizedRecipe,
        suppressedOrGatedCount: 0,
        dedupedCount: 0,
        supersededCount: 0,
        actionFailedCount: 0,
        unsupportedActionBlockedCount: 0,
        deadDeeplinkCount: 0,
        genericMutatingActionSuccessCount: 0,
      };
      byKey.set(key, entry);
    }
    return entry;
  };

  const logRows = db.prepare(`
    SELECT logs.decision AS decision,
           logs.reason AS reason,
           logs.action_taken AS actionTaken,
           COALESCE(intents.source_skill, items.source_skill, logs.source_skill) AS sourceSkill,
           COALESCE(intents.type, items.type) AS type,
           intents.decision_context_json AS decisionContextJson,
           items.type AS itemType
      FROM notification_decision_logs logs
      LEFT JOIN notification_intents intents
        ON intents.intent_id = logs.intent_id
       AND intents.user_id = logs.user_id
       AND intents.tenant_id = logs.tenant_id
      LEFT JOIN notification_center_items items
        ON items.item_id = logs.notification_id
       AND items.user_id = logs.user_id
       AND items.tenant_id = logs.tenant_id
     WHERE logs.user_id = ?
       AND logs.tenant_id = ?
  `).all(userId, tenantId) as Array<{
    decision: string;
    reason: string;
    actionTaken: string | null;
    sourceSkill: string | null;
    type: string | null;
    decisionContextJson: string | null;
    itemType: string | null;
  }>;
  for (const row of logRows) {
    const entry = get(row.sourceSkill, row.type, recipeFromDecisionContextJson(row.decisionContextJson));
    if (row.decision === 'deduped') entry.dedupedCount += 1;
    const reason = row.reason ?? '';
    if (
      row.decision === 'suppressed'
      || reason.startsWith('decision quality gate')
      || reason.startsWith('decision rank gate blocked')
      || reason.startsWith('notifications disabled')
    ) {
      entry.suppressedOrGatedCount += 1;
    }
    if (
      row.actionTaken
      && isNotificationActionMutating(row.actionTaken)
      && !DECISION_ACTION_TYPES.has(row.itemType as NotificationIntentType)
    ) {
      entry.genericMutatingActionSuccessCount += 1;
    }
  }

  const itemRows = db.prepare(`
    SELECT items.source_skill AS sourceSkill,
           items.type AS type,
           items.status AS status,
           items.deeplink AS deeplink,
           intents.decision_context_json AS decisionContextJson
      FROM notification_center_items items
      LEFT JOIN notification_intents intents
        ON intents.intent_id = items.intent_id
       AND intents.user_id = items.user_id
       AND intents.tenant_id = items.tenant_id
     WHERE items.user_id = ?
       AND items.tenant_id = ?
  `).all(userId, tenantId) as Array<{
    sourceSkill: string;
    type: string;
    status: string;
    deeplink: string | null;
    decisionContextJson: string | null;
  }>;
  for (const row of itemRows) {
    const entry = get(row.sourceSkill, row.type, recipeFromDecisionContextJson(row.decisionContextJson));
    if (row.status === 'superseded') entry.supersededCount += 1;
    if (['unread', 'read', 'failed', 'snoozed'].includes(row.status) && (!row.deeplink || !isSupportedNotificationDeeplink(row.deeplink))) {
      entry.deadDeeplinkCount += 1;
    }
  }

  const reliabilityRows = db.prepare(`
    SELECT event_type AS eventType, source
      FROM notification_reliability_events
     WHERE user_id = ?
       AND tenant_id = ?
       AND datetime(created_at) >= datetime('now', '-24 hours')
  `).all(userId, tenantId) as Array<{ eventType: string; source: string | null }>;
  for (const row of reliabilityRows) {
    const topic = topicFromReliabilitySource(row.source);
    if (!topic) continue;
    const entry = get(topic.sourceSkill, topic.type, topic.recipe);
    if (row.eventType === 'unsupported_action_blocked') entry.unsupportedActionBlockedCount += 1;
    if (row.eventType === 'action_failed') entry.actionFailedCount += 1;
    if (row.eventType === 'dead_deeplink_detected') entry.deadDeeplinkCount += 1;
    if (row.eventType === 'quality_gate_blocked') entry.suppressedOrGatedCount += 1;
  }

  return [...byKey.values()]
    .filter((entry) =>
      entry.suppressedOrGatedCount > 0
      || entry.dedupedCount > 0
      || entry.supersededCount > 0
      || entry.actionFailedCount > 0
      || entry.unsupportedActionBlockedCount > 0
      || entry.deadDeeplinkCount > 0
      || entry.genericMutatingActionSuccessCount > 0
    )
    .sort((left, right) =>
      left.sourceSkill.localeCompare(right.sourceSkill)
      || String(left.type ?? '').localeCompare(String(right.type ?? ''))
      || String(left.recipe ?? '').localeCompare(String(right.recipe ?? ''))
    )
    .slice(0, 200);
}

function recipeFromDecisionContextJson(value: string | null): string | null {
  const parsed = safeParseJSON<Record<string, unknown> | null>(value, null);
  return typeof parsed?.recipe === 'string' && parsed.recipe.trim() ? parsed.recipe.trim() : null;
}

function topicFromReliabilitySource(source: string | null): { sourceSkill: string; type: string | null; recipe: string | null } | null {
  if (!source?.startsWith('topic:')) return null;
  const [, sourceSkill, type = '', recipe = ''] = source.split(':');
  if (!sourceSkill) return null;
  return {
    sourceSkill,
    type: type || null,
    recipe: recipe || null,
  };
}

function sanitizeReliabilityScalar(value: string | null | undefined, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, maxLength);
}

function normalizeBlockedReason(reason: string): string {
  if (reason.startsWith('decision rank gate')) return reason.split(':')[0];
  if (reason.startsWith('decision quality gate')) return reason.split(':')[0];
  if (reason.includes('push disabled')) return 'push_disabled_by_user_preference';
  if (reason.includes('rate limit')) return 'push_rate_limit';
  if (reason.includes('quiet hours')) return 'quiet_hours';
  if (reason.includes('device token')) return 'missing_device_token';
  if (reason.includes('credentials')) return 'missing_apns_credentials';
  return reason || 'unknown';
}

export function buildSkillNotificationFixtureIntent(
  sourceSkill: NotificationSourceSkill,
  userId: number,
  overrides: Partial<NotificationIntentInput> = {},
): NotificationIntentInput {
  const base = fixtureBySkill(sourceSkill, userId);
  return { ...base, ...overrides, userId, tenantId: overrides.tenantId ?? base.tenantId };
}

function fixtureBySkill(sourceSkill: NotificationSourceSkill, userId: number): NotificationIntentInput {
  const tenantId = userId;
  switch (sourceSkill) {
    case 'secretary':
      return {
        userId, tenantId, sourceSkill, type: 'conflict_detected', priority: 'time_sensitive',
        relatedEntityId: 'conflict-demo', relatedEntityType: 'calendar_conflict',
        title: 'Schedule conflict needs review',
        body: 'A schedule conflict needs your decision.',
        sensitiveBody: 'Calendar details hidden until you open Nexus.',
        actionButtons: [
          { id: 'open_detail', label: 'Review', style: 'primary' },
        ],
        deeplink: 'nexus://secretary/conflict/conflict-demo',
        dedupeKey: `secretary:conflict:${userId}:demo`,
        requiresUserAction: true,
        decisionDeadline: new Date(Date.now() + 3_600_000).toISOString(),
        decisionContext: {
          entityTitle: 'Demo schedule conflict',
          sourceState: 'conflict_detected',
          deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
        },
        privacyPolicy: 'standard',
      };
    case 'training':
      return {
        userId, tenantId, sourceSkill, type: 'schedule_changed', priority: 'active',
        relatedEntityId: 'session-demo', relatedEntityType: 'training_session',
        title: 'Training session adjusted',
        body: 'Training check-in needed. Review today’s adjustment.',
        sensitiveBody: 'Fatigue and soreness details hidden until you open Nexus.',
        actionButtons: [{ id: 'open_detail', label: 'Review', style: 'primary' }],
        deeplink: 'nexus://training/session/session-demo',
        dedupeKey: `training:session:${userId}:demo`,
        privacyPolicy: 'health',
      };
    case 'content':
      return {
        userId, tenantId, sourceSkill, type: 'approval_required', priority: 'active',
        relatedEntityId: 'script-demo', relatedEntityType: 'content_script',
        title: 'Content approval needed',
        body: 'A content draft is ready for review.',
        sensitiveBody: 'Draft copy hidden until you open Nexus.',
        actionButtons: [
          { id: 'approve_script', label: 'Approve', style: 'primary' },
          { id: 'request_rewrite', label: 'Rewrite', style: 'secondary' },
        ],
        deeplink: 'nexus://content/script/script-demo',
        dedupeKey: `content:script:${userId}:demo`,
        requiresUserAction: true,
        decisionDeadline: new Date(Date.now() + 6 * 3_600_000).toISOString(),
        decisionContext: {
          entityTitle: 'Demo content draft',
          sourceState: 'awaiting_approval',
          deadlineAt: new Date(Date.now() + 6 * 3_600_000).toISOString(),
        },
        privacyPolicy: 'private_content',
      };
    case 'cooking':
      return {
        userId, tenantId, sourceSkill, type: 'reminder', priority: 'active',
        relatedEntityId: 'meal-demo', relatedEntityType: 'meal_plan',
        title: 'Fueling reminder',
        body: 'Meal prep reminder is ready.',
        actionButtons: [{ id: 'add_meal', label: 'Add meal', style: 'primary' }],
        deeplink: 'nexus://cooking/meal-plan/meal-demo',
        dedupeKey: `cooking:meal:${userId}:demo`,
        privacyPolicy: 'standard',
      };
    case 'finance':
      return {
        userId, tenantId, sourceSkill, type: 'decision_required', priority: 'time_sensitive',
        relatedEntityId: 'invoice-demo', relatedEntityType: 'invoice',
        title: 'Finance reminder',
        body: 'Finance reminder due tomorrow.',
        sensitiveBody: 'Invoice amount and vendor hidden until you open Nexus.',
        actionButtons: [{ id: 'mark_paid', label: 'Mark paid', style: 'primary' }],
        deeplink: 'nexus://finance/reminder/invoice-demo',
        dedupeKey: `finance:invoice:${userId}:demo`,
        requiresUserAction: true,
        decisionDeadline: new Date(Date.now() + 24 * 3_600_000).toISOString(),
        decisionContext: {
          entityTitle: 'Demo finance reminder',
          sourceState: 'payment_due',
          deadlineAt: new Date(Date.now() + 24 * 3_600_000).toISOString(),
        },
        privacyPolicy: 'financial',
      };
    case 'security':
      return {
        userId, tenantId, sourceSkill, type: 'security_account', priority: 'time_sensitive',
        relatedEntityId: 'login-demo', relatedEntityType: 'account_event',
        title: 'Account activity',
        body: 'New account activity detected.',
        actionButtons: [{ id: 'open_detail', label: 'Review', style: 'primary' }],
        deeplink: 'nexus://notifications/security-login-demo',
        dedupeKey: `security:login:${userId}:demo`,
        privacyPolicy: 'standard',
      };
    case 'chat':
      return {
        userId, tenantId, sourceSkill, type: 'decision_required', priority: 'active',
        relatedEntityId: 'chat-demo', relatedEntityType: 'chat_thread',
        title: 'Nexus needs your answer',
        body: 'A decision is waiting in chat.',
        actionButtons: [{ id: 'open_detail', label: 'Open', style: 'primary' }],
        deeplink: 'nexus://notifications/chat-demo',
        dedupeKey: `chat:decision:${userId}:demo`,
        privacyPolicy: 'standard',
      };
    case 'system':
    default:
      return {
        userId, tenantId, sourceSkill: 'system', type: 'daily_digest', priority: 'passive',
        relatedEntityId: 'digest-demo', relatedEntityType: 'digest',
        title: 'Daily digest ready',
        body: 'Your Nexus digest is ready.',
        actionButtons: [{ id: 'open_detail', label: 'Open', style: 'primary' }],
        deeplink: 'nexus://notifications/digest-demo',
        dedupeKey: `system:digest:${userId}:demo`,
        privacyPolicy: 'standard',
      };
  }
}

/**
 * Apple caps apns-collapse-id at 64 BYTES (not UTF-16 chars). Oversized ids
 * keep a byte-safe ASCII-window prefix plus a 16-hex digest of the FULL raw
 * id, so distinct long keys stay distinct and multibyte/emoji dedupe keys
 * can never leave a broken surrogate fragment at the cut point. Deterministic
 * by construction (pure function of the input).
 */
export function buildApnsCollapseId(raw: string): string {
  if (Buffer.byteLength(raw, 'utf8') <= 64) return raw;
  const digest = createHash('sha256').update(raw).digest('hex').slice(0, 16);
  const budget = 64 - digest.length - 1; // "-" separator
  let prefix = '';
  let bytes = 0;
  for (const codePoint of raw) { // for..of iterates full code points
    const size = Buffer.byteLength(codePoint, 'utf8');
    if (bytes + size > budget) break;
    prefix += codePoint;
    bytes += size;
  }
  return `${prefix}-${digest}`;
}

const NOTIFICATION_CENTER_FALLBACK_DEEPLINK = 'nexus://notifications';

function normalizeNotificationDeeplink(value: string | null | undefined): string {
  const candidate = typeof value === 'string' ? value.trim() : '';
  if (!candidate) return NOTIFICATION_CENTER_FALLBACK_DEEPLINK;
  if (isSupportedNotificationDeeplink(candidate)) return candidate;
  return NOTIFICATION_CENTER_FALLBACK_DEEPLINK;
}

function normalizeNotificationActionDeeplink(
  value: string | undefined,
  actionId: string,
  fallbackDeeplink: string | null,
): string | undefined {
  const fallback = fallbackDeeplink ?? NOTIFICATION_CENTER_FALLBACK_DEEPLINK;
  if (typeof value === 'string' && value.trim()) {
    return normalizeNotificationDeeplink(value);
  }
  return actionId === 'open_detail' ? fallback : undefined;
}

function resolveNotificationExpiry(input: NotificationIntentInput, priority: NotificationPriority): string {
  if (typeof input.expiresAt === 'string' && Number.isFinite(Date.parse(input.expiresAt))) {
    return input.expiresAt;
  }
  if (typeof input.decisionDeadline === 'string' && Number.isFinite(Date.parse(input.decisionDeadline))) {
    return input.decisionDeadline;
  }
  const hours = defaultNotificationExpiryHours(input.type, priority);
  return new Date(Date.now() + hours * 3_600_000).toISOString();
}

function defaultNotificationExpiryHours(type: NotificationIntentType, priority: NotificationPriority): number {
  if (type === 'security_account' || type === 'sync_failure') return 24;
  if (type === 'daily_digest') return 48;
  if (type === 'weekly_review') return 14 * 24;
  if (type === 'insight') return 14 * 24;
  if (priority === 'time_sensitive' || priority === 'critical') return 48;
  return 7 * 24;
}

function effectiveNotificationPrivacyPolicy(
  requested: NotificationPrivacyPolicy | undefined,
  contractPolicy: NotificationPrivacyPolicy,
  type?: NotificationIntentType,
): NotificationPrivacyPolicy {
  if (!requested) return contractPolicy;
  // A report producer may opt into public lock-screen copy only for the two
  // composed digest types. The body is still truncated by
  // buildPrivacySafeBody; every other standard contract continues to reject
  // a caller-requested privacy downgrade.
  if ((type === 'daily_digest' || type === 'weekly_review') && requested === 'public') {
    return 'public';
  }
  if (contractPolicy === 'public') return requested;
  if (contractPolicy === 'standard') return requested === 'public' ? 'standard' : requested;
  return requested === contractPolicy ? requested : contractPolicy;
}

function isSupportedNotificationDeeplink(value: string): boolean {
  try {
    const url = new URL(value);
    const scheme = url.protocol.toLowerCase();
    if (scheme !== 'nexus:') return false;
    const host = url.hostname.toLowerCase();
    const pathParts = url.pathname.split('/').filter(Boolean);
    switch (host) {
      case 'notifications':
      case 'decision-center':
      case 'tasks':
      case 'connections':
        return true;
      case 'chat':
        return pathParts[0] === 'turn';
      case 'training':
        return pathParts[0] === 'session' || pathParts[0] === 'plan' || pathParts[0] === 'revision';
      case 'secretary':
        return pathParts[0] === 'conflict';
      case 'content':
        return pathParts[0] === 'script';
      case 'cooking':
        return pathParts[0] === 'meal-plan';
      case 'finance':
        return pathParts[0] === 'reminder' || pathParts[0] === 'invoices';
      default:
        return false;
    }
  } catch {
    return false;
  }
}

function normalizeIntent(input: NotificationIntentInput): NotificationIntentRecord {
  const tenantId = input.tenantId ?? input.userId;
  assertScope(input.userId, tenantId, 'normalize_notification_intent', {
    sourceSkill: input.sourceSkill,
    type: input.type,
  });
  if (!SOURCE_SKILLS.includes(input.sourceSkill)) throw new Error('invalid notification sourceSkill');
  if (!VALID_TYPES.includes(input.type)) throw new Error('invalid notification type');
  if (!VALID_PRIORITIES.includes(input.priority)) throw new Error('invalid notification priority');
  // Validated AFTER emoji stripping: an emoji-only title carries no
  // information for a screen reader and must not reach the inbox.
  if (!stripTitleEmoji(input.title)) throw new Error('notification title required');
  if (!input.body.trim()) throw new Error('notification body required');
  const intentId = input.intentId ?? `ni_${randomUUID()}`;
  const relatedEntityId = input.relatedEntityId == null ? null : String(input.relatedEntityId);
  const relatedEntityType = input.relatedEntityType ?? null;
  const hasSourceScope = Boolean(relatedEntityType && relatedEntityId);
  const missingActionSourceScope = Boolean(input.requiresUserAction && !hasSourceScope);
  const priority = missingActionSourceScope ? 'passive' : input.priority;
  const requiresUserAction = Boolean(input.requiresUserAction && hasSourceScope);
  const deeplink = normalizeNotificationDeeplink(input.deeplink);
  const expiresAt = resolveNotificationExpiry(input, priority);
  const candidateActions = normalizeActions(input.actionButtons ?? defaultActionsForType(input.type));
  const decisionContext = normalizeDecisionContext({
    ...(input.decisionContext ?? {}),
    ...(input.visibilityScope ? { visibilityScope: input.visibilityScope } : {}),
  });
  const contract = resolveNotificationContract({
    sourceSkill: input.sourceSkill,
    type: input.type,
    actionId: candidateActions[0]?.id ?? null,
    entityType: relatedEntityType,
    entityId: relatedEntityId,
    recipe: typeof decisionContext?.recipe === 'string' ? decisionContext.recipe : null,
    deeplink,
  });
  const actionButtons = enforceNotificationActionContract(
    candidateActions,
    contract.supportedActions,
    deeplink,
  );

  return {
    intentId,
    userId: input.userId,
    tenantId,
    sourceSkill: input.sourceSkill,
    type: input.type,
    priority,
    relatedEntityId,
    relatedEntityType,
    title: stripTitleEmoji(input.title),
    body: input.body.trim(),
    sensitiveBody: input.sensitiveBody?.trim() || null,
    actionButtons,
    deeplink,
    expiresAt,
    quietHoursPolicy: input.quietHoursPolicy ?? 'respect',
    dedupeKey: input.dedupeKey ?? defaultDedupeKey(input),
    requiresUserAction,
    decisionDeadline: input.decisionDeadline ?? null,
    deliveryPolicy: missingActionSourceScope ? 'digest_only' : input.deliveryPolicy ?? deliveryPolicyForNotificationContract(contract),
    privacyPolicy: effectiveNotificationPrivacyPolicy(
      input.privacyPolicy,
      contract.privacySafeCopyPolicy,
      input.type,
    ),
    promotional: input.promotional === true,
    decisionContext,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
}

function persistIntent(intent: NotificationIntentRecord): NotificationIntentRecord {
  getDb().prepare(`
    INSERT INTO notification_intents (
      intent_id, user_id, tenant_id, source_skill, type, priority, related_entity_id, related_entity_type,
      title, body, sensitive_body, action_buttons_json, deeplink, expires_at, quiet_hours_policy,
      dedupe_key, requires_user_action, decision_deadline, delivery_policy, privacy_policy, promotional, decision_context_json, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `).run(
    intent.intentId,
    intent.userId,
    intent.tenantId,
    intent.sourceSkill,
    intent.type,
    intent.priority,
    intent.relatedEntityId,
    intent.relatedEntityType,
    intent.title,
    intent.body,
    intent.sensitiveBody,
    JSON.stringify(intent.actionButtons),
    intent.deeplink,
    intent.expiresAt,
    intent.quietHoursPolicy,
    intent.dedupeKey,
    intent.requiresUserAction ? 1 : 0,
    intent.decisionDeadline,
    intent.deliveryPolicy,
    intent.privacyPolicy,
    intent.promotional ? 1 : 0,
    intent.decisionContext ? JSON.stringify(intent.decisionContext) : null,
    intent.createdAt,
  );
  return intent;
}

function persistCenterItem(
  intent: NotificationIntentRecord,
  effectivePriority: NotificationPriority,
  safeBody: string,
): NotificationCenterItem {
  const itemId = `nc_${randomUUID()}`;
  getDb().prepare(`
    INSERT INTO notification_center_items (
      item_id, intent_id, user_id, tenant_id, title, body, safe_body, sensitive_body, source_skill,
      type, priority, status, deeplink, actions_json, dedupe_key, requires_user_action, expires_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unread', ?, ?, ?, ?, ?, datetime('now'))
  `).run(
    itemId,
    intent.intentId,
    intent.userId,
    intent.tenantId,
    intent.title,
    intent.body,
    safeBody,
    intent.sensitiveBody,
    intent.sourceSkill,
    intent.type,
    effectivePriority,
    intent.deeplink,
    JSON.stringify(intent.actionButtons),
    intent.dedupeKey,
    boolInt(intent.requiresUserAction),
    intent.expiresAt,
  );
  const row = getDb().prepare('SELECT * FROM notification_center_items WHERE item_id = ?').get(itemId) as any;
  return mapCenterItem(rowWithIntentJoinAliases(row, intent));
}

function rowWithIntentJoinAliases(row: any, intent: NotificationIntentRecord): any {
  return {
    ...row,
    intent_joined_intent_id: intent.intentId,
    intent_related_entity_id: intent.relatedEntityId,
    intent_related_entity_type: intent.relatedEntityType,
    intent_requires_user_action: intent.requiresUserAction ? 1 : 0,
    intent_decision_deadline: intent.decisionDeadline,
    intent_privacy_policy: intent.privacyPolicy,
    intent_decision_context_json: intent.decisionContext ? JSON.stringify(intent.decisionContext) : null,
  };
}

/**
 * True when the user has at least one push-capable device token. Uses the
 * same lookup as attemptPushDelivery's no-token branch. Producers must not
 * use this to suppress NotificationIntent creation: the orchestrator owns
 * push eligibility while the intent remains the canonical center item.
 * Fails open: on lookup errors the orchestrator keeps making the call.
 */
export function userHasActivePushDeviceToken(userId: number): boolean {
  try {
    return getPushTokensForUser(userId).length > 0;
  } catch (err) {
    logger.debug({ err, userId }, 'Notification device-token lookup failed; failing open');
    return true;
  }
}

/**
 * Outcome of a push evaluation that never reached a provider. No
 * notification_delivery_attempts row is fabricated for it — the attempt
 * never existed; the decision log alone records the blocked outcome.
 */
interface SkippedPushDelivery {
  attemptId: null;
  status: 'blocked_missing_device_token' | 'blocked_expired';
  sentAt: null;
}

type PushDeliveryOutcome = DeliveryAttempt | SkippedPushDelivery;

/** Earliest instant after which a push is no longer useful or actionable. */
function notificationPushExpirationAt(intent: NotificationIntentRecord): string | null {
  const candidates = [intent.expiresAt, intent.decisionDeadline]
    .filter((value): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)))
    .map((value) => ({ value, at: Date.parse(value) }));
  if (candidates.length === 0) return null;
  candidates.sort((left, right) => left.at - right.at);
  return candidates[0].value;
}

async function attemptPushDelivery(
  intent: NotificationIntentRecord,
  notificationId: string,
  payload: {
    title: string;
    body: string;
    deeplink: string | null;
    actions: NotificationActionButton[];
    interruptionLevel?: 'passive' | 'active' | 'time-sensitive';
  },
  profile: NotificationProfile,
  deliveryIdentity = 'initial',
): Promise<PushDeliveryOutcome> {
  const expirationAt = notificationPushExpirationAt(intent);
  if (expirationAt && Date.parse(expirationAt) <= Date.now()) {
    return { attemptId: null, status: 'blocked_expired', sentAt: null };
  }
  const tokens = getPushTokensForUser(intent.userId);
  if (tokens.length === 0) {
    return { attemptId: null, status: 'blocked_missing_device_token', sentAt: null };
  }

  // Mock delivery mode removed 2026-07-04 (dead-code sweep): APNs is the
  // only real push channel; tests stub sendPushNotification directly. A
  // non-'apns' NOTIFICATION_DELIVERY_MODE now behaves like missing
  // credentials rather than fabricating mock_sent rows.
  if (config.notificationDelivery.mode !== 'apns') {
    return persistDeliveryAttempt(intent, notificationId, 'push', 'apns', 'blocked_missing_credentials', null, 'apns_delivery_mode_disabled');
  }

  if (!isApnsConfigured()) {
    return persistDeliveryAttempt(intent, notificationId, 'push', 'apns', 'blocked_missing_credentials', null, 'apns_credentials_missing');
  }

  // Claim the canonical provider attempt BEFORE the network call. The
  // process-local evaluation lock protects one PM2 worker only; this durable
  // primary-key claim protects request and job workers running in separate
  // processes. A claimed-but-not-terminal row is deliberately not resent: its
  // provider outcome is uncertain and must be reconciled, never guessed by a
  // duplicate push.
  const deliveryClaim = claimCanonicalPushDeliveryAttempt(intent, notificationId, deliveryIdentity);
  if (deliveryClaim.replayed === true) return deliveryClaim.attempt;
  if (deliveryClaim.replayed === 'pending') {
    return waitForCanonicalPushDeliveryAttempt(intent, notificationId, deliveryClaim.attemptId);
  }

  try {
    const isDecisionPush = isDecisionIntentForPush(intent);
    const contract = notificationContractForIntent(intent);
    let decisionVersions: { recordVersion: number; contextVersion: string } | null = null;
    if (isDecisionPush) {
      try {
        const row = getDb().prepare(`
          SELECT items.record_version AS recordVersion,
                 intents.context_version AS contextVersion
            FROM notification_center_items items
            JOIN notification_intents intents
              ON intents.intent_id = items.intent_id
             AND intents.user_id = items.user_id
             AND intents.tenant_id = items.tenant_id
           WHERE items.item_id = ? AND items.user_id = ? AND items.tenant_id = ?
           LIMIT 1
        `).get(notificationId, intent.userId, intent.tenantId) as {
          recordVersion?: unknown;
          contextVersion?: unknown;
        } | undefined;
        if (Number.isSafeInteger(Number(row?.recordVersion))
            && Number(row?.recordVersion) > 0
            && typeof row?.contextVersion === 'string'
            && row.contextVersion.trim()) {
          decisionVersions = {
            recordVersion: Number(row.recordVersion),
            contextVersion: row.contextVersion,
          };
        }
      } catch (err) {
        logger.warn({ err, intentId: intent.intentId }, 'Decision APNs versions unavailable; action will open the app');
      }
    }
    let badge: number | undefined;
    if (isDecisionPush) {
      try {
        badge = countUnreadNotificationCenterItems(intent.userId, intent.tenantId);
      } catch (err) {
        logger.debug({ err, intentId: intent.intentId }, 'Notification orchestrator badge count lookup failed');
      }
    }
    const result = await sendPushNotification(intent.userId, {
      title: payload.title,
      body: payload.body,
      badge,
      data: {
        notificationId,
        decisionId: isDecisionPush ? notificationId : undefined,
        notificationUserId: intent.userId,
        userId: intent.userId,
        tenantId: intent.tenantId,
        intentId: intent.intentId,
        recordVersion: decisionVersions?.recordVersion,
        contextVersion: decisionVersions?.contextVersion,
        sourceSkill: intent.sourceSkill,
        type: intent.type,
        iosDestination: contract.iosDestination,
        deeplink: payload.deeplink,
      },
      threadId: isDecisionPush ? 'decision-center' : `${intent.sourceSkill}-${intent.type}`,
      category: contract.apnsCategory,
      sound: effectiveSound(intent.priority, profile),
      interruptionLevel: payload.interruptionLevel,
      // Collapse non-decision pushes per source+type+dedupe scope so a fresh
      // digest/insight replaces its stale predecessor on the lock screen
      // instead of stacking (2026-07-04 APNs round).
      collapseId: buildApnsCollapseId(
        isDecisionPush
          ? `decision:${notificationId}`
          : `${intent.sourceSkill}:${intent.type}:${intent.dedupeKey ?? notificationId ?? intent.intentId}`,
      ),
      expirationAt: expirationAt ?? undefined,
    });
    // APNs 410 responses delete the token inside the sender; surface that
    // here so decision logs explain WHY later attempts see no tokens
    // (previously result.unregistered was silently dropped — the audit's
    // top APNs finding).
    if (result.unregistered.length > 0) {
      logger.warn({
        intentId: intent.intentId,
        userId: intent.userId,
        unregisteredCount: result.unregistered.length,
        tokenSuffixes: result.unregistered.map((t) => t.slice(-8)),
      }, 'APNs reported device token(s) unregistered (410) — tokens revoked');
      markDeviceTokensUnregistered(intent.userId, intent.tenantId, result.unregistered);
    }
    if (result.sent > 0) {
      const completedAttempt = completeCanonicalPushDeliveryAttempt(
        deliveryClaim.attemptId,
        'sent',
        '2xx',
        null,
      );
      touchDeviceTokenActivity(intent.userId, intent.tenantId);
      // `last_pushed_at` is what lets a later digest tell "already interrupted
      // them about this" from "queued but never surfaced", so the brief can
      // count an item without re-stating it. Recorded on real delivery only.
      if (notificationId) {
        try {
          getDb().prepare(`
            UPDATE notification_center_items
               SET last_pushed_at = datetime('now')
             WHERE item_id = ? AND user_id = ? AND tenant_id = ?
          `).run(notificationId, intent.userId, intent.tenantId);
        } catch (err) {
          logger.debug({ err, notificationId }, 'last_pushed_at not stamped');
        }
      }
      recordNotificationEngagementEvent({
        userId: intent.userId,
        tenantId: intent.tenantId,
        notificationId,
        intentId: intent.intentId,
        sourceSkill: intent.sourceSkill,
        type: intent.type,
        priority: intent.priority,
        eventType: 'pushed',
      });
      return completedAttempt;
    }
    if (result.skipped > 0) {
      if (expirationAt && Date.parse(expirationAt) <= Date.now()) {
        return completeCanonicalPushDeliveryAttempt(
          deliveryClaim.attemptId,
          'failed',
          null,
          'apns_delivery_expired_after_claim',
        );
      }
      return completeCanonicalPushDeliveryAttempt(
        deliveryClaim.attemptId,
        'blocked_missing_credentials',
        null,
        'apns_credentials_missing',
      );
    }
    if (result.retriable > 0) {
      return completeCanonicalPushDeliveryAttempt(
        deliveryClaim.attemptId,
        'failed',
        'retryable',
        'apns_delivery_transient',
      );
    }
    // A fan-out can retire one device with 410 while another device fails
    // transiently. The 410 token has already been revoked above, so preserve
    // the durable retry for the still-active companion instead of making the
    // aggregate attempt terminal. On retry the sender loads active tokens
    // again, which excludes the revoked token and avoids re-addressing it.
    if (result.unregistered.length > 0) {
      return completeCanonicalPushDeliveryAttempt(
        deliveryClaim.attemptId,
        'failed',
        '410',
        'apns_token_unregistered',
      );
    }
    return completeCanonicalPushDeliveryAttempt(
      deliveryClaim.attemptId,
      'failed',
      'apns_rejected',
      'apns_delivery_failed',
    );
  } catch (err) {
    logger.debug({ err, intentId: intent.intentId }, 'Notification orchestrator APNs delivery failed');
    return completeCanonicalPushDeliveryAttempt(
      deliveryClaim.attemptId,
      'failed',
      null,
      'apns_delivery_exception',
    );
  }
}

type CanonicalPushDeliveryClaim =
  | { replayed: false; attemptId: string }
  | { replayed: 'pending'; attemptId: string }
  | { replayed: true; attempt: DeliveryAttempt };

function canonicalPushDeliveryAttemptId(
  intent: NotificationIntentRecord,
  notificationId: string,
  deliveryIdentity: string,
): string {
  return `nda_exact_${createHash('sha256').update(JSON.stringify({
    intentId: intent.intentId,
    notificationId,
    userId: intent.userId,
    tenantId: intent.tenantId,
    channel: 'push',
    provider: 'apns',
    deliveryIdentity,
  })).digest('hex')}`;
}

function claimCanonicalPushDeliveryAttempt(
  intent: NotificationIntentRecord,
  notificationId: string,
  deliveryIdentity: string,
): CanonicalPushDeliveryClaim {
  const attemptId = canonicalPushDeliveryAttemptId(intent, notificationId, deliveryIdentity);
  const inserted = getDb().prepare(`
    INSERT OR IGNORE INTO notification_delivery_attempts (
      attempt_id, notification_id, intent_id, user_id, tenant_id, channel, provider, status,
      provider_response_code, error_code, created_at, sent_at
    ) VALUES (?, ?, ?, ?, ?, 'push', 'apns', 'claimed', NULL, NULL, datetime('now'), NULL)
  `).run(
    attemptId,
    notificationId,
    intent.intentId,
    intent.userId,
    intent.tenantId,
  );
  if ((inserted.changes ?? 0) === 1) return { replayed: false, attemptId };

  const row = getDb().prepare(`
    SELECT * FROM notification_delivery_attempts
     WHERE attempt_id = ? AND notification_id = ? AND intent_id = ?
       AND user_id = ? AND tenant_id = ?
     LIMIT 1
  `).get(
    attemptId,
    notificationId,
    intent.intentId,
    intent.userId,
    intent.tenantId,
  ) as any;
  if (!row) throw new Error('canonical notification delivery claim could not be read back');
  if (row.status === 'claimed') {
    // A process that died after claiming but before recording APNs outcome
    // must never cause a resend. Once the bounded claim lease is stale,
    // terminalize it as outcome-unknown so health checks can observe and
    // reconcile it instead of leaving an immortal in-progress row.
    getDb().prepare(`
      UPDATE notification_delivery_attempts
         SET status = 'failed', error_code = 'apns_delivery_outcome_unknown'
       WHERE attempt_id = ? AND status = 'claimed'
         AND datetime(created_at) <= datetime('now', '-15 minutes')
    `).run(attemptId);
    const reconciled = getDb().prepare(`
      SELECT * FROM notification_delivery_attempts
       WHERE attempt_id = ? AND notification_id = ? AND intent_id = ?
         AND user_id = ? AND tenant_id = ?
       LIMIT 1
    `).get(
      attemptId,
      notificationId,
      intent.intentId,
      intent.userId,
      intent.tenantId,
    ) as any;
    if (!reconciled) throw new Error('canonical notification delivery reconciliation receipt is missing');
    if (reconciled.status === 'claimed') return { replayed: 'pending', attemptId };
    return { replayed: true, attempt: mapDeliveryAttempt(reconciled) };
  }
  return { replayed: true, attempt: mapDeliveryAttempt(row) };
}

async function waitForCanonicalPushDeliveryAttempt(
  intent: NotificationIntentRecord,
  notificationId: string,
  attemptId: string,
): Promise<DeliveryAttempt> {
  for (let poll = 0; poll < 30; poll += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    const row = getDb().prepare(`
      SELECT * FROM notification_delivery_attempts
       WHERE attempt_id = ? AND notification_id = ? AND intent_id = ?
         AND user_id = ? AND tenant_id = ?
       LIMIT 1
    `).get(
      attemptId,
      notificationId,
      intent.intentId,
      intent.userId,
      intent.tenantId,
    ) as any;
    if (!row) throw new Error('canonical notification delivery pending receipt is missing');
    if (row.status !== 'claimed') return mapDeliveryAttempt(row);
  }
  throw new Error('canonical notification delivery provider outcome is still pending');
}

function completeCanonicalPushDeliveryAttempt(
  attemptId: string,
  status: DeliveryAttempt['status'],
  providerResponseCode: string | null,
  errorCode: string | null,
): DeliveryAttempt {
  const safeErrorCode = sanitizeNotificationDeliveryErrorCode(errorCode);
  const sentAt = status === 'sent' ? new Date().toISOString() : null;
  const updated = getDb().prepare(`
    UPDATE notification_delivery_attempts
       SET status = ?, provider_response_code = ?, error_code = ?, sent_at = ?
     WHERE attempt_id = ? AND status = 'claimed'
  `).run(status, providerResponseCode, safeErrorCode, sentAt, attemptId);
  const row = getDb().prepare(`
    SELECT * FROM notification_delivery_attempts WHERE attempt_id = ? LIMIT 1
  `).get(attemptId) as any;
  if (!row) throw new Error('canonical notification delivery receipt is missing');
  if ((updated.changes ?? 0) === 0 && row.status === 'claimed') {
    throw new Error('canonical notification delivery receipt did not reach a terminal state');
  }
  return mapDeliveryAttempt(row);
}

function persistDeliveryAttempt(
  intent: NotificationIntentRecord,
  notificationId: string | null,
  channel: DeliveryAttempt['channel'],
  provider: DeliveryAttempt['provider'],
  status: DeliveryAttempt['status'],
  providerResponseCode: string | null,
  errorCode: string | null,
): DeliveryAttempt {
  const attemptId = `nda_${randomUUID()}`;
  const sentAt = status === 'sent' ? new Date().toISOString() : null;
  const safeErrorCode = sanitizeNotificationDeliveryErrorCode(errorCode);
  if (errorCode && safeErrorCode === 'opaque_error') {
    logger.warn({
      intentId: intent.intentId,
      provider,
      status,
    }, 'Notification delivery error code redacted from structured attempt record');
  }
  getDb().prepare(`
    INSERT INTO notification_delivery_attempts (
      attempt_id, notification_id, intent_id, user_id, tenant_id, channel, provider, status,
      provider_response_code, error_code, created_at, sent_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
  `).run(
    attemptId,
    notificationId,
    intent.intentId,
    intent.userId,
    intent.tenantId,
    channel,
    provider,
    status,
    providerResponseCode,
    safeErrorCode,
    sentAt,
  );
  const row = getDb().prepare('SELECT * FROM notification_delivery_attempts WHERE attempt_id = ?').get(attemptId) as any;
  return mapDeliveryAttempt(row);
}

export function sanitizeNotificationDeliveryErrorCode(errorCode: string | null | undefined): string | null {
  if (typeof errorCode !== 'string') return null;
  const trimmed = errorCode.trim();
  if (!trimmed) return null;
  return /^[A-Za-z0-9_-]{1,64}$/.test(trimmed) ? trimmed : 'opaque_error';
}

function persistDecisionLog(input: {
  intent: NotificationIntentRecord;
  /** Attempt identity may differ from the canonical deduped intent. */
  evaluationId?: string;
  notificationId: string | null;
  decision: NotificationDecision;
  priority: NotificationPriority;
  reason: string;
  scheduledFor: string | null;
  sentAt: string | null;
  deliveryAttemptIds: string[];
}): NotificationDecisionLog {
  // One evaluation attempt has one receipt. Ordinary request/job replays use
  // the canonical intent identity; a new deduped attempt supplies its own
  // identity so observability records the collapse without duplicating intent
  // or delivery state.
  const decisionLogId = exactDecisionLogId({
    intentId: input.intent.intentId,
    evaluationId: input.evaluationId,
    userId: input.intent.userId,
    tenantId: input.intent.tenantId,
  });
  getDb().prepare(`
    INSERT OR IGNORE INTO notification_decision_logs (
      decision_log_id, notification_id, intent_id, user_id, tenant_id, source_skill,
      source_entity_id, decision, priority, reason, dedupe_key, scheduled_for, sent_at,
      delivery_attempt_ids_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    decisionLogId,
    input.notificationId,
    input.intent.intentId,
    input.intent.userId,
    input.intent.tenantId,
    input.intent.sourceSkill,
    input.intent.relatedEntityId,
    input.decision,
    input.priority,
    input.reason,
    input.intent.dedupeKey,
    input.scheduledFor,
    input.sentAt,
    JSON.stringify(input.deliveryAttemptIds),
  );
  const row = getDb().prepare('SELECT * FROM notification_decision_logs WHERE decision_log_id = ?').get(decisionLogId) as any;
  return mapDecisionLog(row);
}

function exactDecisionLogId(input: {
  intentId: string;
  evaluationId?: string;
  userId: number;
  tenantId: number;
}): string {
  return `ndl_exact_${createHash('sha256').update(JSON.stringify({
    intentId: input.intentId,
    evaluationId: input.evaluationId ?? input.intentId,
    userId: input.userId,
    tenantId: input.tenantId,
  })).digest('hex')}`;
}

function attachDecisionLog(itemId: string, decisionLogId: string): void {
  getDb().prepare('UPDATE notification_center_items SET decision_log_id = ? WHERE item_id = ?').run(decisionLogId, itemId);
}

function markIntentStatus(intentId: string, status: NotificationIntentRecord['status']): void {
  getDb().prepare('UPDATE notification_intents SET status = ? WHERE intent_id = ?').run(status, intentId);
}

function markDecisionOpened(decisionLogId: string | null): void {
  if (!decisionLogId) return;
  getDb().prepare(`
    UPDATE notification_decision_logs
    SET opened_at = COALESCE(opened_at, datetime('now'))
    WHERE decision_log_id = ?
  `).run(decisionLogId);
}

function markDecisionActionTaken(decisionLogId: string | null, actionId: string): void {
  if (!decisionLogId) return;
  getDb().prepare(`
    UPDATE notification_decision_logs
    SET action_taken = ?, opened_at = COALESCE(opened_at, datetime('now'))
    WHERE decision_log_id = ?
  `).run(actionId, decisionLogId);
}

function resolveActiveDuplicateEvaluation(intent: NotificationIntentRecord): NotificationEvaluationResult | null {
  const duplicate = findActiveDuplicate(intent);
  const persistedIntent = duplicate
    ? getIntentById(duplicate.intentId, intent.userId, intent.tenantId) ?? {
        ...intent,
        intentId: duplicate.intentId,
      }
    : findActiveDuplicateIntent(intent);
  if (!persistedIntent) return null;

  const profile = getOrCreateNotificationProfile(intent.userId, intent.tenantId);
  const effectivePriority = normalizePriorityForPolicy(persistedIntent.priority, profile);
  const effectiveIntent = { ...persistedIntent, priority: effectivePriority };
  const pushPayload = {
    title: safeNotificationTitle(effectiveIntent),
    body: buildPrivacySafeBody(effectiveIntent),
    deeplink: effectiveIntent.deeplink,
    actions: effectiveIntent.actionButtons,
    interruptionLevel: interruptionLevelForPriority(effectivePriority),
  };
  const log = persistDecisionLog({
    intent: persistedIntent,
    evaluationId: intent.intentId,
    notificationId: duplicate?.itemId ?? null,
    decision: 'deduped',
    priority: effectivePriority,
    reason: duplicate
      ? 'active unresolved notification with same source and dedupe key already exists'
      : 'active notification intent with same source and dedupe key already exists',
    scheduledFor: null,
    sentAt: null,
    deliveryAttemptIds: [],
  });

  return {
    intent: { ...persistedIntent, priority: effectivePriority, status: 'deduped' },
    item: duplicate,
    decisionLog: log,
    deliveryAttempts: [],
    pushPayload: duplicate ? pushPayload : null,
  };
}

function getIntentById(intentId: string, userId: number, tenantId: number): NotificationIntentRecord | null {
  const row = getDb().prepare(`
    SELECT * FROM notification_intents
    WHERE intent_id = ? AND user_id = ? AND tenant_id = ?
    LIMIT 1
  `).get(intentId, userId, tenantId) as any;
  return row ? mapIntent(row) : null;
}

function isNotificationDedupeConstraintError(err: unknown): boolean {
  const candidate = err as { code?: unknown; message?: unknown };
  const code = typeof candidate?.code === 'string' ? candidate.code : '';
  const message = typeof candidate?.message === 'string' ? candidate.message : String(err);
  if (code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
    return /notification_(intents|center_items)|idx_notification_.*dedupe_unique/.test(message);
  }
  return /idx_notification_(intents|center_items)_dedupe_unique|UNIQUE constraint failed: notification_(intents|center_items)\./.test(message);
}

function findActiveDuplicate(intent: NotificationIntentRecord): NotificationCenterItem | null {
  if (!intent.dedupeKey) return null;
  const row = getDb().prepare(`
    SELECT items.*, intents.intent_id AS intent_joined_intent_id,
           intents.related_entity_id AS intent_related_entity_id,
           intents.related_entity_type AS intent_related_entity_type,
           COALESCE(intents.requires_user_action, items.requires_user_action) AS intent_requires_user_action,
           intents.promotional AS intent_promotional,
           intents.decision_deadline AS intent_decision_deadline,
           intents.privacy_policy AS intent_privacy_policy,
           intents.decision_context_json AS intent_decision_context_json
      FROM notification_center_items items
      LEFT JOIN notification_intents intents
        ON intents.intent_id = items.intent_id
       AND intents.user_id = items.user_id
       AND intents.tenant_id = items.tenant_id
     WHERE items.user_id = ?
       AND items.tenant_id = ?
       AND items.source_skill = ?
       AND items.dedupe_key = ?
       AND items.status IN ('unread', 'read')
       AND (items.expires_at IS NULL OR datetime(items.expires_at) > datetime(?))
    ORDER BY items.created_at DESC
    LIMIT 1
  `).get(intent.userId, intent.tenantId, intent.sourceSkill, intent.dedupeKey, appNowIso()) as any;
  return row ? mapCenterItem(row) : null;
}

function findActiveDuplicateIntent(intent: NotificationIntentRecord): NotificationIntentRecord | null {
  if (!intent.dedupeKey) return null;
  const row = getDb().prepare(`
    SELECT *
      FROM notification_intents
     WHERE user_id = ?
       AND tenant_id = ?
       AND source_skill = ?
       AND dedupe_key = ?
       AND status != 'expired'
       AND (expires_at IS NULL OR datetime(expires_at) > datetime(?))
     ORDER BY created_at DESC
     LIMIT 1
  `).get(intent.userId, intent.tenantId, intent.sourceSkill, intent.dedupeKey, appNowIso()) as any;
  return row ? mapIntent(row) : null;
}

function quietHoursDecision(
  profile: NotificationProfile,
  intent: NotificationIntentRecord,
  priority: NotificationPriority,
): { delayed: boolean; scheduledFor: string | null; reason: string } {
  if (intent.quietHoursPolicy === 'send_now' && canUseSendNowPolicy(intent, priority, profile)) {
    return { delayed: false, scheduledFor: null, reason: 'trusted send_now policy' };
  }
  if (!isInQuietHours(new Date(), profile.quietHours.start, profile.quietHours.end, profile.timezone)) {
    return { delayed: false, scheduledFor: null, reason: 'outside quiet hours' };
  }
  if (intent.quietHoursPolicy === 'send_now') {
    return {
      delayed: true,
      scheduledFor: nextQuietHoursEnd(profile.quietHours.end, profile.timezone).toISO(),
      reason: 'untrusted send_now policy delayed by quiet hours',
    };
  }
  if (priority === 'time_sensitive' && profile.allowTimeSensitive && deadlineSoon(intent.decisionDeadline)) {
    return { delayed: false, scheduledFor: null, reason: 'time-sensitive deadline allowed during quiet hours' };
  }
  if (priority === 'critical' && profile.allowCritical) {
    return { delayed: false, scheduledFor: null, reason: 'critical notification explicitly allowed' };
  }
  if (priority === 'passive' || priority === 'active' || priority === 'time_sensitive') {
    return {
      delayed: true,
      scheduledFor: nextQuietHoursEnd(profile.quietHours.end, profile.timezone).toISO(),
      reason: `${priority} notification delayed by quiet hours`,
    };
  }
  return { delayed: false, scheduledFor: null, reason: 'no quiet hours delay' };
}

function buildDecisionPushPlan(
  intent: NotificationIntentRecord,
  payload: { title: string; body: string },
): DecisionPushPlan | null {
  if (!isDecisionIntentForPush(intent)) return null;
  const input = decisionLogicInputForIntent(intent, payload);
  const logic = buildDecisionLogicV2(input);
  const rank = rankDecision(input, logic, logic.quality);
  const requiresConcreteReview = intent.requiresUserAction
    || intent.type === 'security_account'
    || intent.type === 'sync_failure';
  const hasConcreteUserAction = requiresConcreteReview && intent.actionButtons.length > 0;
  const hasSourceScope = hasDecisionSourceScope(intent);
  const nearDeadline = deadlineSoon(input.deadlineAt ?? input.expiresAt ?? input.context?.deadlineAt ?? null);
  const urgentEnough = rank.apnsEligible || (nearDeadline && intent.priority !== 'passive');
  const eligible = logic.quality.safeForAPNs
    && hasConcreteUserAction
    && hasSourceScope
    && urgentEnough;

  let reason = `decision rank gate allowed visible push: priorityScore=${rank.priorityScore}`;
  if (!logic.quality.safeForAPNs) {
    reason = `decision quality gate blocked visible push: ${logic.quality.reason}`;
  } else if (!hasConcreteUserAction) {
    reason = 'decision rank gate blocked visible push: no concrete user action required';
  } else if (!hasSourceScope) {
    reason = 'decision rank gate blocked visible push: missing source scope';
  } else if (!urgentEnough) {
    reason = `decision rank gate held visible push: priorityScore=${rank.priorityScore}; no near deadline`;
  }

  return {
    eligible,
    reason,
    priorityScore: rank.priorityScore,
    interruptionLevel: interruptionLevelForPriority(intent.priority),
  };
}

function decisionLogicInputForIntent(
  intent: NotificationIntentRecord,
  payload: { body: string },
): DecisionLogicInput {
  return {
    sourceSkill: intent.sourceSkill,
    type: intent.type,
    priority: intent.priority,
    title: intent.title,
    body: intent.body,
    safeBody: payload.body,
    actions: intent.actionButtons,
    relatedEntityType: intent.relatedEntityType,
    relatedEntityId: intent.relatedEntityId,
    deadlineAt: intent.decisionDeadline,
    expiresAt: intent.expiresAt,
    privacyClassification: intent.privacyPolicy,
    context: {
      ...(intent.decisionContext ?? {}),
      deadlineAt: intent.decisionDeadline ?? intent.expiresAt ?? null,
      explicitNoRelatedEntityReason: intent.decisionContext?.explicitNoRelatedEntityReason ?? (intent.type === 'sync_failure'
        ? 'sync failure can be scoped to provider state rather than one entity'
        : null),
    },
  };
}

function hasDecisionSourceScope(intent: NotificationIntentRecord): boolean {
  if (intent.relatedEntityId && intent.relatedEntityType) return true;
  if (intent.decisionContext?.explicitNoRelatedEntityReason) return true;
  return intent.type === 'sync_failure' || intent.type === 'security_account';
}

/**
 * Digest copy may bypass the ordinary skill redaction only when its producer
 * explicitly classifies it as public. Scheduled report summaries are private
 * authenticated-app content, so their intent uses `sensitive` and is rewritten
 * before both immediate and deferred APNs delivery.
 */
const DIGEST_BODY_TYPES = new Set<NotificationIntentType>(['daily_digest', 'weekly_review']);

function buildPrivacySafeBody(intent: NotificationIntentRecord, lang?: Lang): string {
  const language = lang ?? notificationCopyLanguage(intent.userId);
  if (DIGEST_BODY_TYPES.has(intent.type) && intent.privacyPolicy === 'public') {
    return truncate(intent.body, 120);
  }
  if (intent.privacyPolicy === 'financial' || intent.sourceSkill === 'finance') {
    return t('notif.body.finance', language);
  }
  if (intent.privacyPolicy === 'health' || intent.sourceSkill === 'training') {
    return t('notif.body.training', language);
  }
  if (intent.privacyPolicy === 'private_content' || intent.sourceSkill === 'content') {
    return t('notif.body.content', language);
  }
  if (intent.privacyPolicy === 'sensitive') {
    return t('notif.body.review', language, { title: safeNotificationTitle(intent, language) });
  }
  if (intent.privacyPolicy === 'public' && intent.sourceSkill === 'system') {
    return truncate(intent.body, 150);
  }
  return t('notif.body.review', language, { title: safeNotificationTitle(intent, language) });
}

/**
 * Emoji are banned from notification titles.
 *
 * VoiceOver reads them verbatim, so a report titled "☀️ Thursday" is announced
 * as "sun behind cloud, Thursday" — the decoration becomes the first thing a
 * screen-reader user hears. Report producers ship "☀️", "📊" and "🏋️" today.
 * Bodies are left alone: they are prose, and the lock-screen body is rewritten
 * by buildPrivacySafeBody anyway.
 *
 * `Extended_Pictographic` is the WRONG property to strip by: it also covers
 * © ® ™ ‼ ℹ ▶ ☀ ♀, which are punctuation and prose, not decoration. Matching on
 * it deleted them from the user's own text mid-word — "CrossFit® Open" became
 * "CrossFit Open". What actually predicts VoiceOver reading a character as an
 * emoji name is EMOJI PRESENTATION, which is either intrinsic
 * (`Emoji_Presentation`, e.g. 📊) or forced by a VS16 selector (☀ + U+FE0F).
 * Bare text-presentation symbols render as glyphs and are left alone.
 */
/**
 * One emoji unit: an intrinsically-emoji character, or a text symbol that VS16
 * forces into emoji presentation, plus an optional skin-tone modifier.
 */
const EMOJI_UNIT = String.raw`(?:\p{Emoji_Presentation}|\p{Extended_Pictographic}\u{FE0F})(?:[\u{1F3FB}-\u{1F3FF}])?`;
/** That unit, plus any ZWJ-joined continuations (family, flag, profession). */
const EMOJI_SEQUENCE = new RegExp(`${EMOJI_UNIT}(?:\\u{200D}${EMOJI_UNIT})*`, 'gu');

export function stripTitleEmoji(title: string): string {
  return title
    // Keycaps are three code points ("1" + VS16 + U+20E3). Removing only the
    // pictographic part left an orphan combining mark: "1️⃣" -> "1⃣".
    .replace(/[0-9#*]\u{FE0F}?\u{20E3}/gu, '')
    .replace(/[\u{E0020}-\u{E007F}]/gu, '')  // tag sequences (subdivision flags)
    // A whole emoji sequence — base, optional skin tone, and any ZWJ-joined
    // continuations — removed as ONE unit. Stripping U+200D unconditionally
    // (the previous approach) corrupted real text: ZWJ is a meaningful
    // letter-joiner in Devanagari and Persian, where "क्‍ष" is not "क्ष".
    // Consuming it only between emoji leaves prose untouched.
    .replace(EMOJI_SEQUENCE, '')
    // Leftover presentation selectors are formatting, safe to drop anywhere.
    .replace(/[\u{FE0F}\u{FE0E}]/gu, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Producer titles are often user-authored (a commitment or session name), and a
 * title made only of emoji strips to the empty string — which
 * `createNotificationIntent` rejects outright. The producer then counted a
 * failure and the user got NO notification for that item at all. Degrading to a
 * generic-but-accurate title is strictly better than silence.
 */
export function notificationTitleOrFallback(
  title: string | null | undefined,
  fallback: string,
): string {
  const trimmed = (title ?? '').trim();
  return stripTitleEmoji(trimmed) ? trimmed : fallback;
}

/**
 * Language for a user's lock-screen copy.
 *
 * This is the ACCOUNT language (`users.language`, default pt-BR), not the
 * device language. That distinction is the main reason `loc-key` is the better
 * end state: the app bundle would follow the phone. Until the client can carry
 * loc-keys, the account language is the best signal the server has, and it is
 * strictly better than the hardcoded English this replaces.
 *
 * Falls back rather than throwing: copy resolution must never fail a delivery.
 */
export function notificationCopyLanguage(userId: number): Lang {
  try {
    return getUserLanguageById(userId);
  } catch (err) {
    logger.debug({ err, userId }, 'notification copy language lookup failed; using default');
    return 'pt-BR';
  }
}

/**
 * Stable copy keys for the fixed lock-screen strings.
 *
 * Exported because these are the exact identifiers a future
 * `aps.alert.title-loc-key` / `loc-key` payload will send, and the iOS
 * Localizable.strings file must use the same names. Changing one is a
 * cross-repo contract change, not a copy tweak.
 */
export const NOTIFICATION_TITLE_KEYS: Record<NotificationSourceSkill, string> = {
  secretary: 'notif.title.secretary',
  training: 'notif.title.training',
  content: 'notif.title.content',
  cooking: 'notif.title.cooking',
  finance: 'notif.title.finance',
  chat: 'notif.title.chat',
  system: 'notif.title.system',
  security: 'notif.title.security',
};

/** The copy key a notification's title resolves from, before localization. */
export function notificationTitleKey(intent: NotificationIntentRecord): string | null {
  if (intent.sourceSkill === 'secretary') {
    return intent.type === 'conflict_detected' || intent.type === 'reflow_suggestion'
      ? 'notif.title.secretary.schedule'
      : 'notif.title.secretary';
  }
  return NOTIFICATION_TITLE_KEYS[intent.sourceSkill] ?? null;
}

function safeNotificationTitle(intent: NotificationIntentRecord, lang?: Lang): string {
  const key = notificationTitleKey(intent);
  // No key means an unknown skill: fall back to the producer title, truncated,
  // exactly as before. Producer text on an unknown skill is the pre-existing
  // behaviour and is not made worse by localization.
  if (!key) return truncate(intent.title, 60);
  return t(key, lang ?? notificationCopyLanguage(intent.userId));
}

function normalizePriorityForPolicy(priority: NotificationPriority, profile: NotificationProfile): NotificationPriority {
  if (priority === 'critical' && !profile.allowCritical) return profile.allowTimeSensitive ? 'time_sensitive' : 'active';
  if (priority === 'time_sensitive' && !profile.allowTimeSensitive) return 'active';
  return priority;
}

function canUseSendNowPolicy(
  intent: NotificationIntentRecord,
  priority: NotificationPriority,
  profile: NotificationProfile,
): boolean {
  // A quiet-hours breakthrough is pointless on a device that cannot ring.
  // MFA codes are the archetype: a five-minute TTL delivered silently is worse
  // than useless, because the producer believes the user was reached.
  const reach = notificationReachability(intent.userId, intent.tenantId);
  if (reach.hasToken && !reach.canInterrupt) return false;
  const trustedSource = intent.sourceSkill === 'security' || intent.sourceSkill === 'system';
  const trustedType = intent.type === 'security_account' || intent.type === 'sync_failure';
  const allowedPriority = priority === 'time_sensitive' || (priority === 'critical' && profile.allowCritical);
  return trustedSource && trustedType && allowedPriority && profile.allowTimeSensitive;
}

/**
 * Intent types a per-type mute may never silence. Mirrors the `floor_security`
 * invariant the Decision Center read filter enforces via
 * `isDecisionItemPolicyFloored`: an account-integrity alert is not a
 * preference. Deliberately narrow — the other policy floors (deadline, finance
 * risk, connection) are ordinary product signals a user is entitled to mute.
 */
const NON_SUPPRESSIBLE_NOTIFICATION_TYPES = new Set<NotificationIntentType>(['security_account']);

type NotificationCategoryPreferenceCause = 'user_disabled' | 'read_failed' | null;

/**
 * Bridge the legacy iOS push category contract into the central delivery
 * ladder. The Settings app writes `push_preferences.category = 'reminders'`;
 * notification profiles intentionally remain the richer per-skill policy.
 *
 * A missing table means the legacy preference was never available and retains
 * its documented default-enabled behavior. Other read failures fail closed:
 * an inbox item remains available, but Nexus does not risk violating an
 * explicit push opt-out. Queued deliveries treat that failure as retryable.
 */
function notificationCategoryPreferenceCause(
  intent: Pick<NotificationIntentRecord, 'userId' | 'type'>,
): NotificationCategoryPreferenceCause {
  if (intent.type !== 'reminder') return null;
  if (!isValidTenantUserId(intent.userId)) return 'read_failed';

  try {
    const row = getDb().prepare(`
      SELECT enabled
        FROM push_preferences
       WHERE user_id = ? AND category = 'reminders'
    `).get(intent.userId) as { enabled: number } | undefined;
    return row && row.enabled !== 1 ? 'user_disabled' : null;
  } catch (err) {
    // Migration 063 established this table. Keep default-enabled compatibility
    // for pre-migration/local databases; a different read failure is unsafe to
    // interpret as consent.
    if (err instanceof Error && /no such table:\s*push_preferences/i.test(err.message)) return null;
    logger.warn(
      { err, userId: intent.userId, category: 'reminders' },
      'notification category preference read failed; withholding push (fail-closed)',
    );
    return 'read_failed';
  }
}

/**
 * Whether the user has actively muted this (sourceSkill, type[, recipe]).
 *
 * `decision_type_suppressions` was previously consulted ONLY by the read-path
 * filter, so "don't show me this type" hid the row from the list and let the
 * push fire anyway — a setting that did not do what it said.
 *
 * The tables are read with raw SQL rather than through decision-center, which
 * imports this module; going the other way would close an import cycle.
 *
 * Failure direction is deliberate and OPPOSITE to the read path. The read
 * filter fails OPEN (show everything) because hiding a user's queue on a
 * transient fault is worse than showing a muted row. Here a fault fails
 * CLOSED (treat as muted, degrade to in-app) because the Notification Center
 * item still exists either way — only the interrupt is lost — and an unwanted
 * interrupt costs trust that cannot be won back.
 */
/**
 * Why a push is being withheld for this (sourceSkill, type).
 *
 * `null` means nothing is suppressing it. The two non-null values are NOT
 * interchangeable: `user_muted` is a choice the user made, `read_failed` is the
 * suppression table being unreadable and the ladder failing closed. Collapsing
 * both to `true` made the decision log record "user muted secretary/reminder"
 * for a row where no suppression record exists — an audit trail asserting a
 * user preference that was never expressed.
 */
type NotificationSuppressionCause = 'user_muted' | 'read_failed' | null;
type NotificationSuppressionSubject = Pick<
  NotificationIntentRecord,
  'userId' | 'tenantId' | 'sourceSkill' | 'type' | 'decisionContext'
>;

function notificationTypeSuppressionCause(
  intent: NotificationSuppressionSubject,
): NotificationSuppressionCause {
  if (NON_SUPPRESSIBLE_NOTIFICATION_TYPES.has(intent.type)) return null;
  if (!isDecisionTypeSuppressionEnabled(process.env, { userId: intent.userId, tenantId: intent.tenantId })) {
    return null;
  }
  try {
    const db = getDb();
    const nowIso = new Date().toISOString();
    const broad = db.prepare(`
      SELECT 1 FROM decision_type_suppressions
       WHERE user_id = ? AND tenant_id = ? AND source_skill = ? AND type = ?
         AND (mode = 'dont_show_type' OR (mode = 'snooze_type' AND until IS NOT NULL AND datetime(until) > datetime(?)))
       LIMIT 1
    `).get(intent.userId, intent.tenantId, intent.sourceSkill, intent.type, nowIso);
    if (broad) return 'user_muted';

    const recipe = normalizeRecipeForSuppression(intent);
    if (!recipe) return null;
    const scoped = db.prepare(`
      SELECT 1 FROM decision_recipe_suppressions
       WHERE user_id = ? AND tenant_id = ? AND source_skill = ? AND type = ? AND recipe = ?
         AND (mode = 'dont_show_type' OR (mode = 'snooze_type' AND until IS NOT NULL AND datetime(until) > datetime(?)))
       LIMIT 1
    `).get(intent.userId, intent.tenantId, intent.sourceSkill, intent.type, recipe, nowIso);
    return scoped ? 'user_muted' : null;
  } catch (err) {
    logger.warn(
      { err, userId: intent.userId, tenantId: intent.tenantId, sourceSkill: intent.sourceSkill, type: intent.type },
      'notification type-suppression read failed; withholding push (fail-closed)',
    );
    return 'read_failed';
  }
}

function normalizeRecipeForSuppression(intent: NotificationSuppressionSubject): string | null {
  try {
    const raw = intent.decisionContext as Record<string, unknown> | null | undefined;
    const recipe = raw && typeof raw.recipe === 'string' ? raw.recipe.trim() : '';
    if (!recipe) return null;
    const prefix = recipe.split(':', 1)[0] as NotificationSourceSkill;
    const normalized = SOURCE_SKILLS.includes(prefix) && recipe.startsWith(`${prefix}:`)
      ? recipe.slice(prefix.length + 1)
      : recipe;
    return normalized.slice(0, 160) || null;
  } catch {
    return null;
  }
}

/**
 * The preference/skill gate, re-usable outside the initial evaluation.
 *
 * Extracted so the release sweep and the snooze sweep apply the SAME rules the
 * first evaluation did. Previously the sweep reloaded the profile and passed it
 * only to `effectiveSound`, so turning push off — or muting a skill — did not
 * drain items already queued as quiet_hours_delayed/digest: they still sent.
 */
export function isNotificationDeliverableForProfile(
  intent: NotificationIntentRecord,
  profile: NotificationProfile,
): boolean {
  if (!profile.skillPreferences[intent.sourceSkill]) return false;
  if (!profile.inAppEnabled && !profile.portalEnabled && !profile.pushEnabled) return false;
  return true;
}

/** True when a queued delivery may still legitimately reach APNs. */
/**
 * Why a push may not be sent — or `null` when it may.
 *
 * `suppression_read_failed` is the one value callers must treat differently.
 * Every other cause is a DECISION: the user turned something off, and
 * withholding the push permanently is correct. That one is an ABSENCE of a
 * decision — the suppression table could not be read, so we fail closed
 * without knowing. Collapsing the two into a boolean made the release sweep
 * rewrite such a row to a terminal `in_app_only` that its own SELECT can never
 * re-claim, so one transient SQLITE_BUSY during a sweep permanently destroyed
 * the push for up to 100 queued items — and blamed it on a preference change
 * the user never made.
 */
export type NotificationPushBlockCause =
  | 'skill_or_channels_off'
  | 'push_disabled'
  | 'category_preference'
  | 'category_preference_read_failed'
  | 'marketing_consent'
  | 'delivery_policy'
  | 'user_muted'
  | 'suppression_read_failed';

export function notificationPushBlockCause(
  intent: NotificationIntentRecord,
  profile: NotificationProfile,
): NotificationPushBlockCause | null {
  if (!isNotificationDeliverableForProfile(intent, profile)) return 'skill_or_channels_off';
  if (!profile.pushEnabled) return 'push_disabled';
  const categoryPreference = notificationCategoryPreferenceCause(intent);
  if (categoryPreference === 'read_failed') return 'category_preference_read_failed';
  if (categoryPreference === 'user_disabled') return 'category_preference';
  // Consent can be withdrawn between queueing and release.
  if (intent.promotional && !profile.marketingPushEnabled) return 'marketing_consent';
  if (intent.deliveryPolicy === 'in_app_only' || intent.deliveryPolicy === 'portal_only') return 'delivery_policy';
  const suppression = notificationTypeSuppressionCause(intent);
  if (suppression === 'read_failed') return 'suppression_read_failed';
  if (suppression !== null) return 'user_muted';
  return null;
}

/** Thin wrapper so existing call sites are unaffected. */
export function isNotificationPushableForProfile(
  intent: NotificationIntentRecord,
  profile: NotificationProfile,
): boolean {
  return notificationPushBlockCause(intent, profile) === null;
}

/**
 * A blocked push that should be RETRIED rather than recorded as final.
 *
 * Terminal decisions are unrecoverable by design: the release sweep re-claims
 * only `quiet_hours_delayed` and `digest` rows. Writing one for a cause we are
 * not sure about forecloses a delivery on the strength of a transient fault.
 */
function isRetryablePushBlock(cause: NotificationPushBlockCause | null): boolean {
  return cause === 'suppression_read_failed' || cause === 'category_preference_read_failed';
}

/** Human-readable, and — unlike the previous wording — true. */
function pushBlockReason(cause: NotificationPushBlockCause, intent: NotificationIntentRecord): string {
  switch (cause) {
    case 'user_muted':
      return `user muted ${intent.sourceSkill}/${intent.type} notifications`;
    case 'marketing_consent':
      return 'promotional notification without marketing consent';
    case 'delivery_policy':
      return `delivery policy is ${intent.deliveryPolicy === 'portal_only' ? 'portal' : 'in-app'} only`;
    case 'push_disabled':
      return 'push disabled by user preference';
    case 'category_preference':
      return 'push disabled by reminders category preference';
    case 'category_preference_read_failed':
      return 'reminders category preference unreadable; push deferred to a later sweep';
    case 'suppression_read_failed':
      return 'suppression state unreadable; push deferred to a later sweep';
    default:
      return 'notifications disabled for this skill or every channel is off';
  }
}

export type NotificationEngagementEventType =
  | 'surfaced'
  | 'pushed'
  | 'opened'
  | 'actioned'
  | 'dismissed'
  | 'snoozed'
  | 'expired_unseen';

export interface NotificationEngagementEventInput {
  userId: number;
  tenantId: number;
  notificationId?: string | null;
  intentId?: string | null;
  sourceSkill: NotificationSourceSkill;
  type: NotificationIntentType;
  priority: NotificationPriority;
  eventType: NotificationEngagementEventType;
  actionId?: string | null;
  latencyMs?: number | null;
  flagVector?: Record<string, unknown>;
}

/**
 * Append-only engagement log. WRITE PATH ONLY — nothing scores off this yet.
 *
 * `opened_at` and `action_taken` were already stamped on the decision log and
 * read nowhere, and neither captured the surfaced/dismissed transitions a
 * per-type fatigue model needs. Recording starts now so the adaptive work in a
 * later phase has history to tune against instead of shipping blind.
 *
 * Never throws: instrumentation must not be able to fail a delivery.
 */
export function recordNotificationEngagementEvent(input: NotificationEngagementEventInput): void {
  try {
    getDb().prepare(`
      INSERT INTO notification_engagement_events (
        event_id, user_id, tenant_id, notification_id, intent_id,
        source_skill, type, priority, event_type, action_id, latency_ms, flag_vector_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `nee_${randomUUID()}`,
      input.userId,
      input.tenantId,
      input.notificationId ?? null,
      input.intentId ?? null,
      input.sourceSkill,
      input.type,
      input.priority,
      input.eventType,
      input.actionId ?? null,
      Number.isFinite(input.latencyMs as number) ? Math.max(0, Math.round(input.latencyMs as number)) : null,
      JSON.stringify(input.flagVector ?? {}),
    );
  } catch (err) {
    logger.debug({ err, eventType: input.eventType }, 'notification engagement event not recorded');
  }
}

/**
 * Score an evaluated intent with the candidate priority model and record the
 * verdict beside the decision the ladder actually took.
 *
 * SHADOW ONLY. The return value is discarded; delivery has already happened by
 * the time this runs. It exists so the model can be validated against real
 * traffic before it is allowed to decide anything — shipping a scoring change
 * blind, on a system with no engagement history, is how you teach users to
 * disable notifications.
 *
 * The feature set is deliberately PARTIAL: `riskIfIgnored`, `reversibility` and
 * `confidence` are not yet plumbed out of the decision quality gate, so they
 * take neutral defaults and every row is stamped `features_complete = 0`. Any
 * analysis that treats these scores as final ranking would be reading more
 * into them than they carry.
 *
 * Never throws: instrumentation must not be able to fail a delivery.
 */
function recordPriorityShadowVerdict(
  intent: NotificationIntentRecord,
  effectivePriority: NotificationPriority,
  actualDecision: NotificationDecision,
): void {
  if (!isNotificationPriorityShadowScoringEnabled(process.env, {
    userId: intent.userId,
    tenantId: intent.tenantId,
  })) return;

  try {
    const nowMs = Date.now();
    const verdict = scoreNotification({
      type: intent.type,
      sourceSkill: intent.sourceSkill,
      declaredPriority: intent.priority,
      nowMs,
      deadlineAtMs: intent.decisionDeadline ? Date.parse(intent.decisionDeadline) : null,
      // The intent carries no observation timestamp yet; creation time is the
      // closest honest proxy.
      sourceObservedAtMs: intent.createdAt ? Date.parse(intent.createdAt) : nowMs,
      requiresUserAction: intent.requiresUserAction,
      hasSourceScope: Boolean(intent.relatedEntityType && intent.relatedEntityId),
      actionCount: intent.actionButtons.length,
      riskIfIgnored: 'medium',
      reversibility: 'reversible',
      confidence: 0.85,
      engagement: NEUTRAL_ENGAGEMENT,
      dependencyBlocked: false,
      dependencySlack: 0,
      escalationGeneration: 0,
      snoozed: false,
      safeForAPNs: intent.deliveryPolicy === 'auto',
    });

    getDb().prepare(`
      INSERT INTO notification_priority_shadow (
        shadow_id, intent_id, user_id, tenant_id, source_skill, type,
        declared_priority, effective_priority, actual_decision,
        model_version, score, tier, reason_codes_json, components_json, features_complete
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(
      `nps_${randomUUID()}`,
      intent.intentId,
      intent.userId,
      intent.tenantId,
      intent.sourceSkill,
      intent.type,
      intent.priority,
      effectivePriority,
      actualDecision,
      verdict.modelVersion,
      verdict.score,
      verdict.tier,
      JSON.stringify(verdict.reasonCodes),
      JSON.stringify(verdict.components),
    );
  } catch (err) {
    logger.debug({ err, intentId: intent.intentId }, 'priority shadow verdict not recorded');
  }
}

function interruptionLevelForPriority(priority: NotificationPriority): 'passive' | 'active' | 'time-sensitive' {
  if (priority === 'passive') return 'passive';
  if (priority === 'time_sensitive' || priority === 'critical') return 'time-sensitive';
  return 'active';
}

/**
 * Parse a timestamp that may be written in either of the two formats this
 * schema produces: an ISO string from application code, or SQLite's
 * `datetime('now')` output, which is space-separated and therefore rejected by
 * `DateTime.fromISO`.
 *
 * Getting this wrong is silent: an unparseable date yields NaN, every
 * comparison against it is false, and the rule that depended on it simply never
 * fires. The new-user ramp did exactly that before this existed.
 */
function parseDbTimestamp(value: string | null | undefined): DateTime | null {
  if (!value) return null;
  const iso = DateTime.fromISO(value, { zone: 'utc' });
  if (iso.isValid) return iso;
  const sql = DateTime.fromSQL(value, { zone: 'utc' });
  return sql.isValid ? sql : null;
}

export type InterruptTier = 't0_security' | 't1_time_sensitive' | 't2_active' | 't4_promotional';

/**
 * Daily interrupt caps per tier. `null` means uncapped.
 *
 * T0 is uncapped because an account-integrity alert is not a volume decision —
 * but it should be ≈0/day in practice, and more than a couple in a day is
 * itself an incident worth alerting on rather than silently absorbing.
 */
export const INTERRUPT_TIER_DAILY_CAPS: Record<InterruptTier, number | null> = {
  t0_security: null,
  t1_time_sensitive: 4,
  t2_active: 3,
  t4_promotional: null, // bounded by its own 30-day rule instead
};

/**
 * Hard ceiling across every capped tier. Deliberately treated as the incident
 * threshold, not the target: the steady state this system is designed around is
 * two scheduled brief slots plus roughly one real interrupt.
 */
export const INTERRUPT_GLOBAL_DAILY_CAP = 8;

/** No single skill may spend more than this share of a day's attention. */
export const INTERRUPT_SKILL_DAILY_CAP = 2;

/** A new user's first week should feel like a well-timed assistant, not a launch. */
export const NEW_USER_RAMP_DAYS = 7;
export const NEW_USER_RAMP_DAILY_CAP = 1;

/** Minimum gap between promotional interrupts, per App Store 4.5.4 posture. */
export const PROMOTIONAL_MIN_DAYS_BETWEEN = 30;

export interface InterruptBudgetVerdict {
  allowed: boolean;
  tier: InterruptTier;
  reason: string;
}

export function interruptTierFor(
  intent: NotificationIntentRecord,
  priority: NotificationPriority,
): InterruptTier {
  if (intent.promotional) return 't4_promotional';
  if (intent.type === 'security_account') return 't0_security';
  if (priority === 'time_sensitive' || priority === 'critical') return 't1_time_sensitive';
  return 't2_active';
}

/**
 * Whether this notification may spend one of the user's interrupts today.
 *
 * Replaces a process-local `Map` that allowed 20/hour PER SKILL (eight skills →
 * a 160/hour ceiling), was lost on restart, was not shared across workers, and
 * returned true immediately for `time_sensitive` — so it did not bind on
 * exactly the traffic that most needs capping.
 *
 * Counted from `notification_decision_logs` rather than a parallel ledger: that
 * table already records every push actually sent, so the budget cannot drift
 * from reality, and being in the DB it survives restarts and is correct with
 * more than one worker.
 *
 * The window is the user's LOCAL day. A UTC window would reset mid-afternoon
 * for a user in UTC+13 and hand them a second full budget.
 *
 * NOT adaptive. Capacity that grows and shrinks with engagement needs history
 * to tune against; `notification_engagement_events` only started collecting
 * recently. These are fixed caps, and deliberately so until there is evidence.
 */
export function evaluateInterruptBudget(
  intent: NotificationIntentRecord,
  priority: NotificationPriority,
  profile: NotificationProfile,
  now = new Date(),
): InterruptBudgetVerdict {
  const tier = interruptTierFor(intent, priority);
  // Account integrity is never a volume decision.
  if (tier === 't0_security') return { allowed: true, tier, reason: 'security notifications are never budget-capped' };

  try {
    const zone = resolveProfileZone(profile.timezone);
    const dayStart = DateTime.fromJSDate(now).setZone(zone).startOf('day').toUTC().toISO();
    if (!dayStart) return { allowed: true, tier, reason: 'budget window unresolved; allowing' };
    const db = getDb();

    const countSince = (sinceIso: string, sourceSkill?: string): number => {
      const row = db.prepare(`
        SELECT COUNT(*) AS c
          FROM notification_decision_logs
         WHERE user_id = ? AND tenant_id = ?
           AND decision = 'sent_push'
           AND sent_at IS NOT NULL
           AND datetime(sent_at) >= datetime(?)
           ${sourceSkill ? 'AND source_skill = ?' : ''}
      `).get(...(sourceSkill
        ? [intent.userId, intent.tenantId, sinceIso, sourceSkill]
        : [intent.userId, intent.tenantId, sinceIso])) as { c: number } | undefined;
      return row?.c ?? 0;
    };

    if (tier === 't4_promotional') {
      // In the USER's zone, not the server's. Luxon's `minus({days})` is
      // calendar-aware, so without setZone the 30-day boundary shifted by an
      // hour across a server-side DST transition — a cadence gate that moves
      // with the deploy host is not a cadence gate.
      const since = DateTime.fromJSDate(now).setZone(zone).minus({ days: PROMOTIONAL_MIN_DAYS_BETWEEN }).toUTC().toISO()!;
      const recentPromotional = db.prepare(`
        SELECT COUNT(*) AS c
          FROM notification_decision_logs logs
          JOIN notification_intents intents ON intents.intent_id = logs.intent_id
         WHERE logs.user_id = ? AND logs.tenant_id = ?
           AND logs.decision = 'sent_push'
           AND logs.sent_at IS NOT NULL
           AND datetime(logs.sent_at) >= datetime(?)
           AND intents.promotional = 1
      `).get(intent.userId, intent.tenantId, since) as { c: number } | undefined;
      if ((recentPromotional?.c ?? 0) > 0) {
        return { allowed: false, tier, reason: `promotional interrupt already sent in the last ${PROMOTIONAL_MIN_DAYS_BETWEEN} days` };
      }
      return { allowed: true, tier, reason: 'within promotional cadence' };
    }

    const sentToday = countSince(dayStart);

    // A user's first week sets their expectation of what this product does to
    // their attention. Ramp regardless of tier.
    const profileCreatedAt = parseDbTimestamp(profile.createdAt);
    // An unparseable or missing creation time must NOT be read as "brand new"
    // — that would clamp an established user to one interrupt a day.
    const profileAgeDays = profileCreatedAt
      ? DateTime.fromJSDate(now).diff(profileCreatedAt, 'days').days
      : Number.POSITIVE_INFINITY;
    // A negative age means the profile claims to have been created in the
    // future — clock skew, or a restored backup. Throttling an established user
    // to one interrupt a day because of that is the worse failure, so only a
    // genuinely recent, non-negative age ramps.
    const withinRamp = profileAgeDays >= 0 && profileAgeDays < NEW_USER_RAMP_DAYS;
    if (withinRamp && sentToday >= NEW_USER_RAMP_DAILY_CAP) {
      return { allowed: false, tier, reason: `new-user ramp: ${NEW_USER_RAMP_DAILY_CAP} interrupt per day for the first ${NEW_USER_RAMP_DAYS} days` };
    }

    if (sentToday >= INTERRUPT_GLOBAL_DAILY_CAP) {
      return { allowed: false, tier, reason: `daily interrupt ceiling reached (${INTERRUPT_GLOBAL_DAILY_CAP})` };
    }

    const tierCap = INTERRUPT_TIER_DAILY_CAPS[tier];
    if (tierCap !== null) {
      const tierPriorities = tier === 't1_time_sensitive' ? ['time_sensitive', 'critical'] : ['active'];
      const tierRow = db.prepare(`
        SELECT COUNT(*) AS c
          FROM notification_decision_logs
         WHERE user_id = ? AND tenant_id = ?
           AND decision = 'sent_push'
           AND sent_at IS NOT NULL
           AND datetime(sent_at) >= datetime(?)
           AND priority IN (${tierPriorities.map(() => '?').join(',')})
      `).get(intent.userId, intent.tenantId, dayStart, ...tierPriorities) as { c: number } | undefined;
      if ((tierRow?.c ?? 0) >= tierCap) {
        return { allowed: false, tier, reason: `daily cap reached for ${tier} (${tierCap})` };
      }
    }

    if (countSince(dayStart, intent.sourceSkill) >= INTERRUPT_SKILL_DAILY_CAP) {
      return { allowed: false, tier, reason: `daily cap reached for ${intent.sourceSkill} (${INTERRUPT_SKILL_DAILY_CAP})` };
    }

    return { allowed: true, tier, reason: 'within interrupt budget' };
  } catch (err) {
    // Fail OPEN, unlike the per-type mute. A mute is an explicit user
    // instruction; a budget is a heuristic, and dropping every interrupt on a
    // transient read fault would be a worse failure than one extra push.
    logger.warn({ err, userId: intent.userId }, 'interrupt budget read failed; allowing');
    return { allowed: true, tier, reason: 'budget check unavailable; allowing' };
  }
}

function effectiveSound(priority: NotificationPriority, _profile: NotificationProfile): string | undefined {
  return priority === 'passive' ? undefined : 'default';
}

function isDecisionIntentForPush(intent: NotificationIntentRecord): boolean {
  if (intent.requiresUserAction) return true;
  return intent.type === 'decision_required'
    || intent.type === 'conflict_detected'
    || intent.type === 'reflow_suggestion'
    || intent.type === 'approval_required'
    || intent.type === 'sync_failure'
    || intent.type === 'security_account';
}

function notificationContractForIntent(intent: NotificationIntentRecord) {
  return resolveNotificationContract({
    sourceSkill: intent.sourceSkill,
    type: intent.type,
    entityType: intent.relatedEntityType,
    entityId: intent.relatedEntityId,
    recipe: typeof intent.decisionContext?.recipe === 'string' ? intent.decisionContext.recipe : null,
    actionId: intent.actionButtons.some((action) => action.id === 'reconnect')
      ? 'reconnect'
      : intent.actionButtons[0]?.id ?? null,
    deeplink: intent.deeplink,
  });
}

// Per-user report schedule normalizers: `undefined` keeps the current value,
// explicit `null` clears back to the global default, and invalid values are
// rejected loudly (the preferences PUT surfaces the error to the client).
function normalizeNullableTime(patchValue: string | null | undefined, currentValue: string | null): string | null {
  if (patchValue === undefined) return currentValue;
  if (patchValue === null) return null;
  const trimmed = String(patchValue).trim();
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(trimmed)) {
    throw new Error(`invalid schedule time '${patchValue}' — expected HH:MM`);
  }
  return trimmed;
}

function normalizeNullableDay(patchValue: number | null | undefined, currentValue: number | null): number | null {
  if (patchValue === undefined) return currentValue;
  if (patchValue === null) return null;
  const parsed = Number(patchValue);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 6) {
    throw new Error(`invalid schedule day '${patchValue}' — expected 0 (Sunday) through 6 (Saturday)`);
  }
  return parsed;
}

function mapProfile(row: any): NotificationProfile {
  return {
    userId: row.user_id,
    tenantId: row.tenant_id,
    quietHours: { start: row.quiet_hours_start, end: row.quiet_hours_end },
    timezone: row.timezone,
    pushEnabled: !!row.push_enabled,
    marketingPushEnabled: !!row.marketing_push_enabled,
    localEnabled: !!row.local_enabled,
    emailEnabled: !!row.email_enabled,
    portalEnabled: !!row.portal_enabled,
    inAppEnabled: !!row.in_app_enabled,
    skillPreferences: {
      secretary: !!row.secretary_enabled,
      training: !!row.training_enabled,
      content: !!row.content_enabled,
      cooking: !!row.cooking_enabled,
      finance: !!row.finance_enabled,
      chat: !!row.chat_enabled,
      system: !!row.system_enabled,
      security: !!row.security_enabled,
    },
    defaultReminderMinutes: row.default_reminder_minutes,
    workoutReminderMinutes: row.workout_reminder_minutes,
    contentReminderMinutes: row.content_reminder_minutes,
    financeReminderDays: row.finance_reminder_days,
    allowTimeSensitive: !!row.allow_time_sensitive,
    allowCritical: !!row.allow_critical,
    digestPassiveItems: !!row.digest_passive_items,
    dailyDigestTime: row.daily_digest_time,
    weeklyReviewDay: row.weekly_review_day,
    weeklyReviewTime: row.weekly_review_time,
    morningBriefingTime: row.morning_briefing_time ?? null,
    coachBriefingTime: row.coach_briefing_time ?? null,
    endOfDayTime: row.end_of_day_time ?? null,
    weeklyReviewReportDay: row.weekly_review_report_day ?? null,
    weeklyReviewReportTime: row.weekly_review_report_time ?? null,
    doNotNotifyRules: safeParseJSON(row.do_not_notify_rules_json, []),
    updatedAt: row.updated_at,
    createdAt: row.created_at,
  };
}

function mapIntent(row: any): NotificationIntentRecord {
  return {
    intentId: row.intent_id,
    userId: row.user_id,
    tenantId: row.tenant_id,
    sourceSkill: row.source_skill,
    type: row.type,
    priority: row.priority,
    relatedEntityId: row.related_entity_id,
    relatedEntityType: row.related_entity_type,
    title: row.title,
    body: row.body,
    sensitiveBody: row.sensitive_body,
    actionButtons: safeParseJSON(row.action_buttons_json, []),
    deeplink: row.deeplink,
    expiresAt: row.expires_at,
    quietHoursPolicy: row.quiet_hours_policy,
    dedupeKey: row.dedupe_key,
    requiresUserAction: !!row.requires_user_action,
    decisionDeadline: row.decision_deadline,
    deliveryPolicy: row.delivery_policy,
    privacyPolicy: row.privacy_policy,
    promotional: !!row.promotional,
    decisionContext: normalizeDecisionContext(safeParseJSON(row.decision_context_json, null)),
    status: row.status,
    createdAt: row.created_at,
  };
}

function normalizeDecisionContext(input: DecisionLogicContext | null | undefined): DecisionLogicContext | null {
  if (!input || typeof input !== 'object') return null;
  const context: DecisionLogicContext = {};
  assignContextString(context, 'entityTitle', input.entityTitle);
  assignContextString(context, 'currentStartAt', input.currentStartAt);
  assignContextString(context, 'currentEndAt', input.currentEndAt);
  assignContextString(context, 'recommendedStartAt', input.recommendedStartAt);
  assignContextString(context, 'recommendedEndAt', input.recommendedEndAt);
  assignContextString(context, 'sourceState', input.sourceState);
  assignContextString(context, 'explicitNoRelatedEntityReason', input.explicitNoRelatedEntityReason);
  assignContextString(context, 'providerName', input.providerName);
  assignContextString(context, 'providerSyncState', input.providerSyncState);
  assignContextString(context, 'providerSyncUpdatedAt', input.providerSyncUpdatedAt);
  assignContextString(context, 'contextObservedAt', input.contextObservedAt);
  assignContextString(context, 'contextExpiresAt', input.contextExpiresAt);
  if (input.candidateConfidence === 'low' || input.candidateConfidence === 'medium' || input.candidateConfidence === 'high') {
    context.candidateConfidence = input.candidateConfidence;
  }
  assignContextString(context, 'deadlineAt', input.deadlineAt);
  assignContextString(context, 'timezone', input.timezone);
  assignContextString(context, 'locale', input.locale);
  assignContextString(context, 'recipe', input.recipe);
  assignContextVisibilityScope(context, input.visibilityScope);
  assignContextBoolean(context, 'internalOnly', input.internalOnly);
  assignContextBoolean(context, 'smoke', input.smoke);
  assignContextSlots(context, input.candidateSlots);
  assignContextReasonCodes(context, input.reasonCodes);
  assignContextTaskCounts(context, input.taskCounts);
  assignContextEvidence(context, input.evidenceReferences, input.sourceHealthSnapshot, input.evidenceConfidence);
  const normalizedAction = normalizeDecisionAction(input.normalizedAction);
  if (normalizedAction) context.normalizedAction = normalizedAction;
  if (Array.isArray(input.conflictComparisons)) {
    const comparisons = input.conflictComparisons
      .slice(0, 24)
      .flatMap((value) => {
        const comparison = normalizeConflictComparisonAction(value);
        return comparison ? [comparison] : [];
      });
    if (comparisons.length > 0) context.conflictComparisons = comparisons;
  }
  const conflictEvaluation = normalizeConflictEvaluation(input.conflictEvaluation);
  if (conflictEvaluation && (!normalizedAction || conflictEvaluation.contextVersion === normalizedAction.contextVersion)) {
    context.conflictEvaluation = conflictEvaluation;
  }
  return Object.keys(context).length ? context : null;
}

function assignContextEvidence(
  context: DecisionLogicContext,
  evidence: DecisionLogicContext['evidenceReferences'] | null | undefined,
  sourceHealth: DecisionLogicContext['sourceHealthSnapshot'] | null | undefined,
  confidence: number | null | undefined,
): void {
  if (typeof confidence === 'number' && Number.isFinite(confidence) && confidence >= 0 && confidence <= 1) {
    context.evidenceConfidence = confidence;
  }
  if (Array.isArray(evidence)) {
    const normalized = evidence.slice(0, 24).flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      if (!/^hmac:evidence:[a-z][a-z0-9_-]{0,63}:[a-f0-9]{32}$/i.test(item.evidenceId)) return [];
      if (!/^[a-z][a-z0-9_:-]{0,63}$/i.test(item.source)) return [];
      if (!Number.isFinite(Date.parse(item.observedAt))) return [];
      if (!/^hmac:evidence:[a-z][a-z0-9_-]{0,63}:[a-f0-9]{32}$/i.test(item.entityVersion)) return [];
      const expiresAt = typeof item.expiresAt === 'string' && Number.isFinite(Date.parse(item.expiresAt))
        ? new Date(item.expiresAt).toISOString()
        : null;
      return [{
        evidenceId: item.evidenceId,
        source: item.source,
        observedAt: new Date(item.observedAt).toISOString(),
        freshness: truncate(String(item.freshness ?? 'unknown'), 32),
        reliability: truncate(String(item.reliability ?? 'unknown'), 32),
        entityVersion: item.entityVersion,
        ...(expiresAt ? { expiresAt } : {}),
      }];
    });
    if (normalized.length > 0) context.evidenceReferences = normalized;
  }
  if (Array.isArray(sourceHealth)) {
    const normalized = sourceHealth.slice(0, 24).flatMap((item) => {
      if (!item || typeof item !== 'object' || !/^[a-z][a-z0-9_:-]{0,63}$/i.test(item.source)) return [];
      if (!Number.isFinite(Date.parse(item.observedAt))) return [];
      return [{
        source: item.source,
        status: truncate(String(item.status ?? 'unknown'), 32),
        observedAt: new Date(item.observedAt).toISOString(),
        staleAfter: typeof item.staleAfter === 'string' && Number.isFinite(Date.parse(item.staleAfter))
          ? new Date(item.staleAfter).toISOString()
          : null,
        reasonCode: typeof item.reasonCode === 'string'
          ? truncate(item.reasonCode.replace(/[^a-z0-9_:-]+/gi, '_'), 120)
          : null,
      }];
    });
    if (normalized.length > 0) context.sourceHealthSnapshot = normalized;
  }
}

function assignContextTaskCounts(
  context: DecisionLogicContext,
  taskCounts: DecisionLogicContext['taskCounts'] | null | undefined,
): void {
  if (!taskCounts || typeof taskCounts !== 'object') return;
  const counts: NonNullable<DecisionLogicContext['taskCounts']> = {};
  for (const key of ['pending', 'overdue', 'dueToday', 'highPriority'] as const) {
    const value = taskCounts[key];
    if (Number.isInteger(value) && Number(value) >= 0 && Number(value) < 1000) {
      counts[key] = Number(value);
    }
  }
  if (Object.keys(counts).length > 0) {
    context.taskCounts = counts;
  }
}

function assignContextBoolean(
  context: DecisionLogicContext,
  key: 'internalOnly' | 'smoke',
  value: boolean | null | undefined,
): void {
  if (typeof value === 'boolean') {
    context[key] = value;
  }
}

function assignContextVisibilityScope(
  context: DecisionLogicContext,
  visibilityScope: DecisionLogicContext['visibilityScope'] | null | undefined,
): void {
  if (visibilityScope === 'user_private'
    || visibilityScope === 'tenant_shared'
    || visibilityScope === 'tenant_admin'
    || visibilityScope === 'system_admin') {
    context.visibilityScope = visibilityScope;
  }
}

function assignContextSlots(
  context: DecisionLogicContext,
  candidateSlots: DecisionLogicContext['candidateSlots'] | null | undefined,
): void {
  if (!Array.isArray(candidateSlots)) return;
  const slots = candidateSlots
    .map((slot) => ({
      startAt: typeof slot?.startAt === 'string' ? slot.startAt.trim() : '',
      endAt: typeof slot?.endAt === 'string' ? slot.endAt.trim() : '',
      label: typeof slot?.label === 'string' && slot.label.trim() ? truncate(slot.label.trim(), 80) : null,
    }))
    .filter((slot) => slot.startAt && slot.endAt && Number.isFinite(Date.parse(slot.startAt)) && Number.isFinite(Date.parse(slot.endAt)) && Date.parse(slot.startAt) < Date.parse(slot.endAt))
    .slice(0, 6);
  if (slots.length > 0) context.candidateSlots = slots;
}

function assignContextReasonCodes(
  context: DecisionLogicContext,
  reasonCodes: DecisionLogicContext['reasonCodes'] | null | undefined,
): void {
  if (!Array.isArray(reasonCodes)) return;
  const normalized = reasonCodes
    .filter((code): code is string => typeof code === 'string')
    .map((code) => code.trim())
    .filter(Boolean)
    .slice(0, 10);
  if (normalized.length > 0) context.reasonCodes = normalized;
}

function assignContextString<T extends keyof DecisionLogicContext>(
  context: DecisionLogicContext,
  key: T,
  value: DecisionLogicContext[T] | null | undefined,
): void {
  if (typeof value !== 'string') return;
  const trimmed = value.trim();
  if (!trimmed) return;
  context[key] = truncate(trimmed, 240) as DecisionLogicContext[T];
}

function mapCenterItem(row: any): NotificationCenterItem {
  const item: NotificationCenterItem = {
    itemId: row.item_id,
    intentId: row.intent_id,
    decisionLogId: row.decision_log_id,
    userId: row.user_id,
    tenantId: row.tenant_id,
    title: row.title,
    body: row.body,
    safeBody: row.safe_body,
    sensitiveBody: row.sensitive_body ?? null,
    sourceSkill: row.source_skill,
    type: row.type,
    priority: row.priority,
    status: row.status,
    // The joined intent value wins where present, matching the list query's
    // COALESCE; a bare item row falls back to its own column.
    requiresUserAction: Boolean(row.intent_requires_user_action ?? row.requires_user_action),
    promotional: Boolean(row.intent_promotional),
    deeplink: row.deeplink,
    actions: safeParseJSON(row.actions_json, []),
    dedupeKey: row.dedupe_key,
    priorityScore: row.priority_score ?? null,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    snoozedUntil: row.snoozed_until ?? null,
  };
  const actionEffectiveStatuses = buildNotificationActionEffectiveStatuses(item, notificationActionStateContextForRow(row));
  return {
    ...item,
    actionEffectiveStatuses,
    frontendActionState: frontendActionStateForActionStatuses(item, actionEffectiveStatuses),
  };
}

function notificationActionStateContextForRow(row: any): {
  entityType: string | null;
  entityId: string | null;
  safeForFrontendAction?: boolean;
  blockedByDependency?: boolean;
} {
  const entityType = row.intent_related_entity_type ?? null;
  const entityId = row.intent_related_entity_id ?? null;
  if (!DECISION_ACTION_TYPES.has(row.type as NotificationIntentType)) {
    return { entityType, entityId };
  }
  const blockedByDependency = hasBlockingDecisionDependency(row.item_id, row.user_id, row.tenant_id);
  if (row.intent_joined_intent_id == null) {
    return { entityType, entityId, safeForFrontendAction: false, blockedByDependency };
  }
  const actions = safeParseJSON<NotificationActionButton[]>(row.actions_json, []);
  const context = decisionContextForNotificationCenterRow(
    row,
    normalizeDecisionContext(safeParseJSON(row.intent_decision_context_json, null)),
  );
  if (!context) {
    return { entityType, entityId, safeForFrontendAction: false, blockedByDependency };
  }
  const logic = buildDecisionLogicForNotificationCenterRow(row, actions, context, context?.visibilityScope ?? 'user_private');
  return {
    entityType,
    entityId,
    safeForFrontendAction: logic.quality.safeForFrontendAction,
    blockedByDependency,
  };
}

function buildNotificationActionEffectiveStatuses(
  item: NotificationCenterItem,
  ctx: {
    entityType?: string | null;
    entityId?: string | null;
    safeForFrontendAction?: boolean;
    blockedByDependency?: boolean;
  } = {},
): NotificationActionEffectiveStatus[] {
  const contract = resolveNotificationContract({
    sourceSkill: item.sourceSkill,
    type: item.type,
    entityType: ctx.entityType ?? null,
    entityId: ctx.entityId ?? null,
  });
  const supportedActions = new Set(contract.supportedActions);
  return item.actions.map((action) => {
    const supported = supportedActions.has(action.id);
    return computeSharedNotificationActionEffectiveStatus({
      actionId: action.id,
      status: item.status,
      expiresAt: item.expiresAt,
      safeForFrontendAction: ctx.safeForFrontendAction,
      blockedByDependency: ctx.blockedByDependency,
      supported,
      unsupportedReason: supported ? null : `Action '${action.id}' is not supported for ${item.sourceSkill}/${item.type}`,
      reconnectRequired: isDecisionReconnectAffordanceEnabled(process.env, {
        userId: item.userId,
        tenantId: item.tenantId,
      }) && action.id === 'retry' && item.type === 'sync_failure',
    }) as NotificationActionEffectiveStatus;
  });
}

function hasBlockingDecisionDependency(itemId: string, userId: number, tenantId: number): boolean {
  if (!tableExistsForNotificationRead('decision_dependencies')) return false;
  const unresolved = new Set(['unread', 'read', 'failed', 'snoozed']);
  const rows = getDb().prepare(`
    SELECT deps.relationship AS relationship, blocker.status AS blockerStatus
      FROM decision_dependencies deps
      LEFT JOIN notification_center_items blocker
        ON blocker.item_id = deps.depends_on_decision_id
       AND blocker.user_id = deps.user_id
       AND blocker.tenant_id = deps.tenant_id
     WHERE deps.decision_id = ?
       AND deps.user_id = ?
       AND deps.tenant_id = ?
  `).all(itemId, userId, tenantId) as Array<{ relationship: string; blockerStatus: string | null }>;
  return rows.some((row) => (
    decisionRelationshipSemantics(row.relationship).blocksAction
    && row.blockerStatus != null
    && unresolved.has(row.blockerStatus)
  ));
}

function tableExistsForNotificationRead(name: string): boolean {
  const row = getDb().prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1").get(name);
  return Boolean(row);
}

function frontendActionStateForActionStatuses(
  item: NotificationCenterItem,
  statuses: NotificationActionEffectiveStatus[],
): NotificationActionEffectiveState {
  if (TERMINAL_NOTIFICATION_STATUSES.has(item.status)) {
    if (item.status === 'expired') return 'disabled_expired';
    if (item.status === 'actioned') return 'disabled_already_actioned';
    return 'disabled_superseded';
  }
  if (statuses.length === 0) return 'disabled_missing_details';
  if (statuses.some((status) => status.effective === 'enabled')) return 'enabled';
  return statuses[0]?.effective ?? 'disabled_missing_details';
}

function mapDecisionLog(row: any): NotificationDecisionLog {
  return {
    decisionLogId: row.decision_log_id,
    notificationId: row.notification_id,
    intentId: row.intent_id,
    userId: row.user_id,
    tenantId: row.tenant_id,
    sourceSkill: row.source_skill,
    sourceEntityId: row.source_entity_id,
    decision: row.decision,
    priority: row.priority,
    reason: row.reason,
    dedupeKey: row.dedupe_key,
    createdAt: row.created_at,
    scheduledFor: row.scheduled_for,
    sentAt: row.sent_at,
    openedAt: row.opened_at,
    actionTaken: row.action_taken,
    deliveryAttemptIds: safeParseJSON(row.delivery_attempt_ids_json, []),
  };
}

function mapDeliveryAttempt(row: any): DeliveryAttempt {
  return {
    attemptId: row.attempt_id,
    notificationId: row.notification_id,
    intentId: row.intent_id,
    userId: row.user_id,
    tenantId: row.tenant_id,
    channel: row.channel,
    provider: row.provider,
    status: row.status,
    providerResponseCode: row.provider_response_code,
    errorCode: row.error_code,
    createdAt: row.created_at,
    sentAt: row.sent_at,
  };
}

function mapDeviceToken(row: any): DeviceTokenRegistration {
  return {
    tokenId: row.token_id,
    userId: row.user_id,
    tenantId: row.tenant_id,
    platform: row.platform,
    tokenHash: row.token_hash,
    tokenSuffix: row.token_suffix,
    environment: row.environment,
    deviceId: row.device_id,
    appVersion: row.app_version,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  };
}

function assertScope(userId: number, tenantId: number, operation: string, details?: Record<string, unknown>): void {
  if (isValidTenantUserId(userId) && isValidTenantUserId(tenantId)) return;
  recordTenantScopeAnomaly({
    layer: 'delivery',
    operation,
    reason: 'invalid_user_scope',
    userId: isValidTenantUserId(userId) ? userId : null,
    details: {
      ...(details ?? {}),
      tenantId: isValidTenantUserId(tenantId) ? tenantId : null,
    },
  });
  throw new Error('userId required: must be a positive integer');
}

function defaultActionsForType(type: NotificationIntentType): NotificationActionButton[] {
  if (type === 'approval_required') {
    return [{ id: 'open_detail', label: 'Review', style: 'primary' }];
  }
  if (type === 'conflict_detected' || type === 'reflow_suggestion') {
    return [{ id: 'open_detail', label: 'Review', style: 'primary' }];
  }
  if (type === 'reminder' || type === 'missed_item') {
    return [
      { id: 'open_detail', label: 'Open', style: 'primary' },
      { id: 'snooze', label: 'Snooze', style: 'secondary' },
    ];
  }
  if (type === 'sync_failure') {
    // `sync_failure` also covers invoice and content jobs. Real connection
    // producers opt into `reconnect`; the broad type must default to details.
    return [{ id: 'open_detail', label: 'Open', style: 'primary' }];
  }
  return [{ id: 'open_detail', label: 'Open', style: 'primary' }];
}

function normalizeActions(actions: NotificationActionButton[]): NotificationActionButton[] {
  return actions
    .filter((action) => typeof action.id === 'string' && action.id.trim() && typeof action.label === 'string' && action.label.trim())
    .slice(0, 4)
    .map((action) => ({
      id: action.id.trim(),
      label: action.label.trim(),
      style: action.style ?? 'secondary',
      deeplink: action.deeplink ?? undefined,
      mutating: action.mutating === true ? true : undefined,
    }));
}

function enforceNotificationActionContract(
  actions: NotificationActionButton[],
  supportedActions: string[],
  fallbackDeeplink: string | null,
): NotificationActionButton[] {
  const supported = new Set(supportedActions);
  const accepted: NotificationActionButton[] = [];
  const seen = new Set<string>();

  for (const raw of actions) {
    // Legacy producers still ask for `retry`, whose executor never existed, so
    // the button rendered permanently greyed. Rewriting it here fixes every
    // sync_failure producer at the contract boundary instead of requiring an
    // edit in each one. `reconnect` is navigation, so it is always executable.
    const action = raw.id === 'retry' && supported.has('reconnect')
      ? { ...raw, id: 'reconnect', label: 'Reconnect', mutating: undefined }
      : raw;
    if (!supported.has(action.id) || seen.has(action.id)) continue;
    seen.add(action.id);
    const deeplink = normalizeNotificationActionDeeplink(action.deeplink, action.id, fallbackDeeplink);
    accepted.push({
      ...action,
      deeplink,
      mutating: action.mutating === true || isNotificationActionMutating(action.id) ? true : undefined,
    });
  }

  if (supported.has('open_detail') && !seen.has('open_detail')) {
    accepted.push({
      id: 'open_detail',
      label: accepted.length > 0 ? 'Open details' : 'Open',
      style: accepted.length > 0 ? 'secondary' : 'primary',
      deeplink: fallbackDeeplink ?? undefined,
    });
  }

  return accepted.slice(0, 4);
}

function defaultDedupeKey(input: NotificationIntentInput): string {
  const entity = input.relatedEntityId == null ? 'none' : String(input.relatedEntityId);
  return `${input.sourceSkill}:${input.type}:${input.relatedEntityType ?? 'entity'}:${entity}`;
}

function boolInt(value: boolean): number {
  return value ? 1 : 0;
}

function ensureColumn(table: string, column: string, definition: string): void {
  const db = getDb();
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some((entry) => entry.name === column)) return;
  db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
}

function backfillNotificationCenterActionability(): void {
  getDb().prepare(`
    UPDATE notification_center_items
       SET requires_user_action = COALESCE((
         SELECT intents.requires_user_action
           FROM notification_intents intents
          WHERE intents.intent_id = notification_center_items.intent_id
            AND intents.user_id = notification_center_items.user_id
            AND intents.tenant_id = notification_center_items.tenant_id
          LIMIT 1
       ), 0)
     WHERE EXISTS (
       SELECT 1
         FROM notification_intents intents
        WHERE intents.intent_id = notification_center_items.intent_id
          AND intents.user_id = notification_center_items.user_id
          AND intents.tenant_id = notification_center_items.tenant_id
          AND intents.requires_user_action != notification_center_items.requires_user_action
     )
  `).run();
}

function positiveIntOr(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value! > 0 ? value! : fallback;
}

function boundedIntOr(value: number | undefined, fallback: number, min: number, max: number): number {
  return Number.isInteger(value) && value! >= min && value! <= max ? value! : fallback;
}

function stringOr(fallback: string, value?: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function normalizeTime(value: string, fallback: string): string {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : fallback;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function isInQuietHours(now: Date, start: string, end: string, timezone = DEFAULT_TIMEZONE): boolean {
  const local = DateTime.fromJSDate(now).setZone(resolveProfileZone(timezone));
  const minute = local.hour * 60 + local.minute;
  const [startH, startM] = start.split(':').map(Number);
  const [endH, endM] = end.split(':').map(Number);
  const startMinute = startH * 60 + startM;
  const endMinute = endH * 60 + endM;
  if (startMinute === endMinute) return false;
  if (startMinute < endMinute) {
    return minute >= startMinute && minute < endMinute;
  }
  return minute >= startMinute || minute < endMinute;
}

function nextQuietHoursEnd(end: string, timezone = DEFAULT_TIMEZONE): DateTime {
  const now = DateTime.now().setZone(resolveProfileZone(timezone));
  const [endH, endM] = end.split(':').map(Number);
  let target = now.set({ hour: endH, minute: endM, second: 0, millisecond: 0 });
  if (target <= now) {
    target = target.plus({ days: 1 });
  }
  return target.toUTC();
}

/**
 * When a digest-routed intent should be released.
 *
 * `weekly_review` used to land here too and was therefore scheduled on the
 * DAILY clock — a retrospective delivered every morning. `weeklyReviewDay` and
 * `weeklyReviewTime` existed in the profile but were never read by anything.
 * They are now the schedule for weekly items.
 */
function nextDigestTime(profile: NotificationProfile, type?: NotificationIntentType): DateTime {
  const zone = resolveProfileZone(profile.timezone);
  const now = DateTime.now().setZone(zone);

  if (type === 'weekly_review') {
    const [hour, minute] = profile.weeklyReviewTime.split(':').map(Number);
    // `weekly_review_day` is stored in the JS convention (0=Sunday..6=Saturday,
    // bounded on write); Luxon uses 1=Monday..7=Sunday. Sunday is the only
    // value that differs.
    const storedDay = Math.min(6, Math.max(0, profile.weeklyReviewDay ?? 1));
    const targetWeekday = storedDay === 0 ? 7 : storedDay;
    let target = now.set({ hour, minute, second: 0, millisecond: 0 });
    const daysAhead = (targetWeekday - target.weekday + 7) % 7;
    target = target.plus({ days: daysAhead });
    if (target <= now) target = target.plus({ weeks: 1 });
    return target.toUTC();
  }

  const [hour, minute] = profile.dailyDigestTime.split(':').map(Number);
  let target = now.set({ hour, minute, second: 0, millisecond: 0 });
  if (target <= now) {
    target = target.plus({ days: 1 });
  }
  return target.toUTC();
}

function deadlineSoon(deadline: string | null): boolean {
  if (!deadline) return false;
  const ms = Date.parse(deadline) - Date.now();
  // An expired deadline has zero remaining value and must never buy a
  // quiet-hours bypass. The Decision Center's sibling check already enforces
  // the same lower bound; keep delivery policy aligned with it.
  return Number.isFinite(ms) && ms >= 0 && ms <= 24 * 3_600_000;
}

function skillLabel(sourceSkill: NotificationSourceSkill): string {
  return sourceSkill.slice(0, 1).toUpperCase() + sourceSkill.slice(1);
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
}

function safeParseJSON<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value !== 'string') return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
