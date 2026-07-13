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
import { getUserTimezoneById } from './user-service';
import { getPushTokensForUser, isApnsConfigured, sendPushNotification } from './apns-sender';
import { config } from '../config';
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
} from './runtime-flags';
import { computeSharedNotificationActionEffectiveStatus } from './notification-action-state';
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
  privacyPolicy?: NotificationPrivacyPolicy;
  decisionContext?: DecisionLogicContext | null;
  visibilityScope?: DecisionVisibilityScope | null;
}

export interface NotificationIntentRecord extends Required<Omit<NotificationIntentInput,
  'intentId' | 'relatedEntityId' | 'relatedEntityType' | 'sensitiveBody' | 'actionButtons' | 'deeplink' | 'expiresAt' |
  'quietHoursPolicy' | 'dedupeKey' | 'requiresUserAction' | 'decisionDeadline' | 'deliveryPolicy' | 'privacyPolicy' | 'decisionContext' | 'visibilityScope'>> {
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
const PUSH_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const PUSH_RATE_LIMIT_MAX_PER_SOURCE = 20;
const pushRateLimitByScope = new Map<string, number[]>();

function appNowIso(): string {
  return new Date(Date.now()).toISOString();
}

export function ensureNotificationTables(): void {
  const db = getDb();
  db.exec(`
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
  `);
  ensureColumn('notification_center_items', 'sensitive_body', 'TEXT');
  ensureColumn('notification_center_items', 'snoozed_until', 'TEXT');
  ensureColumn('notification_center_items', 'priority_score', 'INTEGER');
  ensureColumn('notification_center_items', 'requires_user_action', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('notification_intents', 'decision_context_json', 'TEXT');
  backfillNotificationCenterActionability();
  getDb().prepare(`
    CREATE INDEX IF NOT EXISTS idx_notification_center_badge_actionable
      ON notification_center_items(user_id, tenant_id, status, requires_user_action, expires_at)
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
  ensureNotificationTables();
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
  ensureNotificationTables();
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

export async function createNotificationIntent(input: NotificationIntentInput): Promise<NotificationEvaluationResult> {
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
  try {
    intent = runOutboxTransaction((emitDomainEvent) => {
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
      enqueueJob({
        tenantId: persisted.tenantId,
        userId: persisted.userId,
        jobType: 'deliver_notification',
        payload: { intentId: persisted.intentId },
        priority: persisted.priority === 'time_sensitive' || persisted.priority === 'critical' ? 10 : 50,
        idempotencyKey: `deliver_notification:${persisted.intentId}`,
      });
      return persisted;
    });
  } catch (err) {
    if (isNotificationDedupeConstraintError(err)) {
      expireStaleNotificationIntents();
      const duplicate = resolveActiveDuplicateEvaluation(normalized);
      if (duplicate) return duplicate;
    }
    throw err;
  }
  return evaluateNotificationIntent(intent.intentId, intent.userId, intent.tenantId);
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

export async function evaluateNotificationIntent(
  intentId: string,
  userId: number,
  tenantId = userId,
): Promise<NotificationEvaluationResult> {
  assertScope(userId, tenantId, 'evaluate_notification_intent', { intentId });
  ensureNotificationTables();
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
  const safeBody = buildPrivacySafeBody(intent);
  const pushPayload = {
    title: safeNotificationTitle(intent),
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

  const duplicate = findActiveDuplicate(intent);
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

  const item = persistCenterItem(intent, effectivePriority, safeBody);
  const quietHours = quietHoursDecision(profile, intent, effectivePriority);
  const deliveryAttempts: DeliveryAttempt[] = [];
  let decision: NotificationDecision = 'in_app_only';
  let reason = 'stored in authenticated notification center';
  let scheduledFor: string | null = null;
  let sentAt: string | null = null;

  if (intent.deliveryPolicy === 'portal_only') {
    decision = 'portal_only';
    reason = 'delivery policy is portal only';
  } else if (intent.type === 'daily_digest' && hasUnreadDigestStreak(intent.userId, intent.tenantId, item.itemId)) {
    // Engagement gate (2026-07-04): prod showed 629 of 738 items were never
    // read — pushing the Nth identical digest at a user who ignored the
    // last N is pure notification fatigue. The center item above is still
    // created; only the push/digest release is suppressed.
    decision = 'suppressed';
    reason = `daily digest push suppressed: last ${digestUnreadStreakThreshold()} digests were never opened`;
  } else if (intent.deliveryPolicy === 'digest_only' || (intent.priority === 'passive' && profile.digestPassiveItems)) {
    decision = 'digest';
    reason = 'passive notification held for digest';
    scheduledFor = nextDigestTime(profile).toISO();
  } else if (quietHours.delayed) {
    decision = 'quiet_hours_delayed';
    reason = quietHours.reason;
    scheduledFor = quietHours.scheduledFor;
  } else if (intent.deliveryPolicy === 'in_app_only' || !profile.pushEnabled) {
    decision = 'in_app_only';
    reason = intent.deliveryPolicy === 'in_app_only' ? 'delivery policy is in-app only' : 'push disabled by user preference';
  } else {
    if (decisionPushPlan && !decisionPushPlan.eligible) {
      decision = 'in_app_only';
      reason = decisionPushPlan.reason;
    } else if (!consumePushRateLimit(intent, effectivePriority)) {
      decision = 'in_app_only';
      reason = 'push rate limit reached for notification source; stored in-app only';
    } else {
      const attempt = await attemptPushDelivery(intent, item.itemId, pushPayload, profile);
      if (attempt.attemptId !== null) deliveryAttempts.push(attempt);
      // Same mapping as the release path: failed / credentials-blocked
      // attempts must not be recorded as 'sent_push' (they previously were,
      // hiding real APNs failures behind a success decision).
      decision = attempt.status === 'sent'
        ? 'sent_push'
        : attempt.status === 'blocked_missing_device_token'
          ? 'blocked_missing_device_token'
          : 'apns_delivery_failed';
      reason = attempt.status === 'sent'
          ? 'APNs accepted privacy-safe payload'
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

  return {
    intent: { ...intent, priority: effectivePriority, status: 'evaluated' },
    item: { ...item, decisionLogId: log.decisionLogId },
    decisionLog: log,
    deliveryAttempts,
    pushPayload,
  };
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
  ensureNotificationTables();
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
}

// Single-flight latch for the release sweep (NOTIF-RELEASE-CAS). Both the
// */15 cron and every deliver_notification event job call
// releaseDueNotificationDeliveries() in the same PM2 process; without the
// latch two overlapping sweeps can SELECT the same due decision-log rows and
// double-push them before either UPDATE lands.
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
  ensureNotificationTables();
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
  }>): number => {
    const stmt = db.prepare(`
      UPDATE notification_decision_logs
      SET decision = ?,
          reason = ?,
          sent_at = ?,
          delivery_attempt_ids_json = ?
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
    try {
      const first = group[0];
      const profile = getOrCreateNotificationProfile(first.user_id, first.tenant_id);
      const digestIntent = mapIntent(first);
      const payload = assembleDailyDigest(first.user_id, first.tenant_id, group.length);
      const attempt = await attemptPushDelivery(digestIntent, first.item_id, payload, profile);
      const decision: NotificationDecision = attempt.status === 'sent'
        ? 'sent_push'
        : attempt.status === 'blocked_missing_device_token'
          ? 'blocked_missing_device_token'
          : 'apns_delivery_failed';
      const reason = attempt.status === 'sent'
        ? 'digest notification released to APNs'
        : attempt.status === 'blocked_missing_credentials'
            ? 'digest notification due but APNs credentials are missing'
            : attempt.status === 'blocked_missing_device_token'
              ? 'digest notification due but no active device token is available'
              : 'digest notification due but APNs delivery failed';
      const claimed = updateReleasedLogs(group.map((row) => ({
        row,
        decision,
        reason,
        sentAt: attempt.sentAt,
        attemptIds: attempt.attemptId === null ? [] : [attempt.attemptId],
      })));
      if (attempt.status === 'sent') released += claimed;
      else blocked += claimed;
    } catch (err) {
      blocked += group.length;
      logger.warn({ err, userId: group[0]?.user_id, tenantId: group[0]?.tenant_id }, 'Notification digest release failed');
    }
  }

  for (const row of regularRows) {
    try {
      const intent = mapIntent(row);
      const profile = getOrCreateNotificationProfile(row.user_id, row.tenant_id);
      const payload = {
        title: safeNotificationTitle(intent),
        body: buildPrivacySafeBody(intent),
        deeplink: intent.deeplink,
        actions: intent.actionButtons,
      };
      const attempt = await attemptPushDelivery(intent, row.item_id, payload, profile);
      // A real APNs failure ('failed'/'blocked_missing_credentials') is an
      // apns_delivery_failed outcome; only the genuine no-token case may be
      // recorded as blocked_missing_device_token.
      const decision: NotificationDecision = attempt.status === 'sent'
        ? 'sent_push'
        : attempt.status === 'blocked_missing_device_token'
          ? 'blocked_missing_device_token'
          : 'apns_delivery_failed';
      const reason = attempt.status === 'sent'
        ? 'delayed notification released to APNs'
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
    } catch (err) {
      blocked += 1;
      logger.warn({ err, decisionLogId: row.decision_log_id }, 'Notification delayed/digest release failed');
    }
  }

  return { inspected: rows.length, released, blocked };
}

export function assembleDailyDigest(
  userId: number,
  tenantId: number,
  itemCount: number,
): {
  title: string;
  body: string;
  deeplink: string;
  actions: NotificationActionButton[];
  interruptionLevel: 'passive';
} {
  assertScope(userId, tenantId, 'assemble_daily_digest', { itemCount });
  const count = Math.max(1, itemCount);
  return {
    title: 'Daily digest',
    body: count === 1 ? '1 Nexus update is ready.' : `${count} Nexus updates are ready.`,
    deeplink: 'nexus://notifications/digest',
    actions: [{ id: 'open_detail', label: 'Open', style: 'primary' }],
    interruptionLevel: 'passive',
  };
}

export function listNotificationCenterItems(
  userId: number,
  tenantId = userId,
  opts: { status?: NotificationCenterStatus | 'all'; sourceSkill?: NotificationSourceSkill; limit?: number } = {},
): NotificationCenterItem[] {
  assertScope(userId, tenantId, 'list_notification_center_items', opts);
  ensureNotificationTables();
  const clauses = ['items.user_id = ?', 'items.tenant_id = ?'];
  const params: unknown[] = [userId, tenantId];
  if (opts.status && opts.status !== 'all') {
    clauses.push('items.status = ?');
    params.push(opts.status);
  } else {
    clauses.push("items.status != 'expired'");
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
  params.push(Math.min(Math.max(opts.limit ?? 50, 1), 200));

  const rows = getDb().prepare(`
    SELECT items.*, intents.intent_id AS intent_joined_intent_id,
           intents.related_entity_id AS intent_related_entity_id,
           intents.related_entity_type AS intent_related_entity_type,
           COALESCE(intents.requires_user_action, items.requires_user_action) AS intent_requires_user_action,
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

export function countUnreadNotificationCenterItems(userId: number, tenantId = userId): number {
  assertScope(userId, tenantId, 'count_unread_notification_center_items');
  ensureNotificationTables();
  const nonBadgePlaceholders = NON_BADGE_NOTIFICATION_TYPES.map(() => '?').join(',');
  const row = getDb().prepare(`
    SELECT COUNT(*) AS count
      FROM notification_center_items
     WHERE user_id = ?
       AND tenant_id = ?
       AND status = 'unread'
       AND type NOT IN (${nonBadgePlaceholders})
       AND requires_user_action = 1
       AND (expires_at IS NULL OR datetime(expires_at) > datetime(?))
  `).get(userId, tenantId, ...NON_BADGE_NOTIFICATION_TYPES, appNowIso()) as { count: number } | undefined;
  return row?.count ?? 0;
}

export function listNotificationBridgeEntityIds(
  userId: number,
  tenantId: number,
  bridgePrefix: 'content' | 'report',
): number[] {
  assertScope(userId, tenantId, 'list_notification_bridge_entity_ids', { bridgePrefix });
  ensureNotificationTables();
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
      for (const legacyId of listUnreadContentNotificationIdsByTypes(userId, [...userScopedContentTypes])) {
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
  ensureNotificationTables();
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
  ensureNotificationTables();
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
    inAppEnabled: !!row.in_app_enabled,
    portalEnabled: !!row.portal_enabled,
    allowTimeSensitive: !!row.allow_time_sensitive,
    digestPassiveItems: !!row.digest_passive_items,
    updatedAt: row.updated_at,
  }));
}

export function getNotificationCenterItem(itemId: string, userId: number, tenantId = userId): NotificationCenterItem | null {
  assertScope(userId, tenantId, 'get_notification_center_item', { itemId });
  ensureNotificationTables();
  const row = getDb().prepare(`
    SELECT items.*, intents.intent_id AS intent_joined_intent_id,
           intents.related_entity_id AS intent_related_entity_id,
           intents.related_entity_type AS intent_related_entity_type,
           COALESCE(intents.requires_user_action, items.requires_user_action) AS intent_requires_user_action,
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
  ensureNotificationTables();
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
  ensureNotificationTables();
  getDb().prepare(`
    UPDATE notification_center_items
    SET status = 'dismissed', dismissed_at = datetime('now')
    WHERE item_id = ? AND user_id = ? AND tenant_id = ? AND status IN ('unread', 'read', 'failed', 'snoozed')
  `).run(itemId, userId, tenantId);
  return getNotificationCenterItem(itemId, userId, tenantId);
}

export function snoozeNotificationCenterItem(
  itemId: string,
  userId: number,
  tenantId = userId,
  snoozedUntil?: string | null,
): NotificationCenterItem | null {
  assertScope(userId, tenantId, 'snooze_notification_center_item', { itemId });
  ensureNotificationTables();
  const parsedUntil = typeof snoozedUntil === 'string' ? Date.parse(snoozedUntil) : NaN;
  const until = Number.isFinite(parsedUntil)
    ? new Date(parsedUntil).toISOString()
    : DateTime.utc().plus({ minutes: 60 }).toISO() ?? DateTime.utc().toISO();
  getDb().prepare(`
    UPDATE notification_center_items
    SET status = 'snoozed',
        snoozed_until = ?,
        read_at = COALESCE(read_at, datetime('now'))
    WHERE item_id = ? AND user_id = ? AND tenant_id = ? AND status IN ('unread', 'read')
  `).run(until, itemId, userId, tenantId);
  return getNotificationCenterItem(itemId, userId, tenantId);
}

export function performNotificationAction(
  itemId: string,
  actionId: string,
  userId: number,
  tenantId = userId,
): { item: NotificationCenterItem; actionId: string; idempotent: boolean } {
  assertScope(userId, tenantId, 'perform_notification_action', { itemId, actionId });
  ensureNotificationTables();
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

  if (actionId === 'open_detail') {
    const updated = markNotificationCenterItemRead(itemId, userId, tenantId);
    if (!updated) throw new Error('notification action failed');
    markDecisionActionTaken(updated.decisionLogId, actionId);
    return { item: updated, actionId, idempotent: false };
  }

  if (actionId === 'dismiss') {
    const updated = dismissNotificationCenterItem(itemId, userId, tenantId);
    if (!updated) throw new Error('notification action failed');
    markDecisionActionTaken(updated.decisionLogId, actionId);
    return { item: updated, actionId, idempotent: false };
  }

  if (actionId === 'snooze') {
    const updated = snoozeNotificationCenterItem(itemId, userId, tenantId);
    if (!updated) throw new Error('notification action failed');
    markDecisionActionTaken(updated.decisionLogId, actionId);
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

export function registerNotificationDeviceToken(opts: {
  userId: number;
  tenantId?: number;
  token: string;
  platform?: 'ios';
  environment?: 'sandbox' | 'production';
  deviceId?: string | null;
  appVersion?: string | null;
}): DeviceTokenRegistration {
  const tenantId = opts.tenantId ?? opts.userId;
  assertScope(opts.userId, tenantId, 'register_notification_device_token');
  const token = opts.token.trim();
  if (!token) throw new Error('device token required');
  ensureNotificationTables();

  const tokenHash = hashToken(token);
  const tokenSuffix = token.slice(-8);
  const tokenId = `dt_${randomUUID()}`;
  const environment = opts.environment ?? 'sandbox';
  const deviceId = opts.deviceId?.trim() || `ios-${tokenHash.slice(0, 16)}`;
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
        device_id, app_version, last_seen_at, revoked_at
      )
      VALUES (?, ?, ?, 'ios', ?, ?, ?, ?, ?, datetime('now'), NULL)
      ON CONFLICT(user_id, tenant_id, platform, token_hash, environment) DO UPDATE SET
        device_id = excluded.device_id,
        app_version = excluded.app_version,
        token_suffix = excluded.token_suffix,
        last_seen_at = datetime('now'),
        revoked_at = NULL
    `).run(tokenId, opts.userId, tenantId, tokenHash, tokenSuffix, environment, deviceId, opts.appVersion ?? null);

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
    ensureNotificationTables();
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
  ensureNotificationTables();
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
  ensureNotificationTables();
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
  ensureNotificationTables();
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
  ensureNotificationTables();
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
  ensureNotificationTables();
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
): NotificationPrivacyPolicy {
  if (!requested) return contractPolicy;
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
        return pathParts[0] === 'session' || pathParts[0] === 'plan';
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
  if (!input.title.trim()) throw new Error('notification title required');
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
    title: input.title.trim(),
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
    privacyPolicy: effectiveNotificationPrivacyPolicy(input.privacyPolicy, contract.privacySafeCopyPolicy),
    decisionContext,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
}

function persistIntent(intent: NotificationIntentRecord): NotificationIntentRecord {
  ensureNotificationTables();
  getDb().prepare(`
    INSERT INTO notification_intents (
      intent_id, user_id, tenant_id, source_skill, type, priority, related_entity_id, related_entity_type,
      title, body, sensitive_body, action_buttons_json, deeplink, expires_at, quiet_hours_policy,
      dedupe_key, requires_user_action, decision_deadline, delivery_policy, privacy_policy, decision_context_json, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
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
 * same lookup as attemptPushDelivery's no-token branch so producer-side
 * gates (e.g. report-document-store behind
 * NOTIFICATION_DIGEST_REQUIRE_DEVICE_TOKEN) agree with the orchestrator.
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
  status: 'blocked_missing_device_token';
  sentAt: null;
}

type PushDeliveryOutcome = DeliveryAttempt | SkippedPushDelivery;

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
): Promise<PushDeliveryOutcome> {
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

  try {
    const isDecisionPush = isDecisionIntentForPush(intent);
    const contract = notificationContractForIntent(intent);
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
      touchDeviceTokenActivity(intent.userId, intent.tenantId);
      return persistDeliveryAttempt(intent, notificationId, 'push', 'apns', 'sent', '2xx', null);
    }
    if (result.unregistered.length > 0) {
      return persistDeliveryAttempt(intent, notificationId, 'push', 'apns', 'failed', '410', 'apns_token_unregistered');
    }
    if (result.skipped > 0) {
      return persistDeliveryAttempt(intent, notificationId, 'push', 'apns', 'blocked_missing_credentials', null, 'apns_credentials_missing');
    }
    return persistDeliveryAttempt(intent, notificationId, 'push', 'apns', 'failed', 'apns_rejected', 'apns_delivery_failed');
  } catch (err) {
    logger.debug({ err, intentId: intent.intentId }, 'Notification orchestrator APNs delivery failed');
    return persistDeliveryAttempt(intent, notificationId, 'push', 'apns', 'failed', null, 'apns_delivery_exception');
  }
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
  notificationId: string | null;
  decision: NotificationDecision;
  priority: NotificationPriority;
  reason: string;
  scheduledFor: string | null;
  sentAt: string | null;
  deliveryAttemptIds: string[];
}): NotificationDecisionLog {
  const decisionLogId = `ndl_${randomUUID()}`;
  getDb().prepare(`
    INSERT INTO notification_decision_logs (
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
  ensureNotificationTables();
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

function buildPrivacySafeBody(intent: NotificationIntentRecord): string {
  if (intent.privacyPolicy === 'financial' || intent.sourceSkill === 'finance') {
    return 'Finance reminder needs review.';
  }
  if (intent.privacyPolicy === 'health' || intent.sourceSkill === 'training') {
    return 'Training check-in needed. Review today’s adjustment.';
  }
  if (intent.privacyPolicy === 'private_content' || intent.sourceSkill === 'content') {
    return 'Content item is ready for review.';
  }
  if (intent.privacyPolicy === 'sensitive') {
    return `${safeNotificationTitle(intent)} — open Nexus to review the recommendation.`;
  }
  if (intent.privacyPolicy === 'public' && intent.sourceSkill === 'system') {
    return truncate(intent.body, 150);
  }
  return `${safeNotificationTitle(intent)} — open Nexus to review the recommendation.`;
}

function safeNotificationTitle(intent: NotificationIntentRecord): string {
  switch (intent.sourceSkill) {
    case 'secretary': return intent.type === 'conflict_detected' || intent.type === 'reflow_suggestion' ? 'Schedule decision' : 'Secretary decision';
    case 'training': return 'Training update';
    case 'content': return 'Content review';
    case 'cooking': return 'Cooking reminder';
    case 'finance': return 'Finance reminder';
    case 'chat': return 'Nexus needs your choice';
    case 'system': return 'System notification';
    case 'security': return 'Account activity';
    default: return truncate(intent.title, 60);
  }
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
  const trustedSource = intent.sourceSkill === 'security' || intent.sourceSkill === 'system';
  const trustedType = intent.type === 'security_account' || intent.type === 'sync_failure';
  const allowedPriority = priority === 'time_sensitive' || (priority === 'critical' && profile.allowCritical);
  return trustedSource && trustedType && allowedPriority && profile.allowTimeSensitive;
}

function interruptionLevelForPriority(priority: NotificationPriority): 'passive' | 'active' | 'time-sensitive' {
  if (priority === 'passive') return 'passive';
  if (priority === 'time_sensitive' || priority === 'critical') return 'time-sensitive';
  return 'active';
}

function consumePushRateLimit(intent: NotificationIntentRecord, priority: NotificationPriority): boolean {
  if (priority === 'time_sensitive' || priority === 'critical') return true;
  const now = Date.now();
  const key = `${intent.userId}:${intent.tenantId}:${intent.sourceSkill}`;
  const retained = (pushRateLimitByScope.get(key) ?? []).filter((timestamp) => now - timestamp < PUSH_RATE_LIMIT_WINDOW_MS);
  if (retained.length >= PUSH_RATE_LIMIT_MAX_PER_SOURCE) {
    pushRateLimitByScope.set(key, retained);
    return false;
  }
  retained.push(now);
  pushRateLimitByScope.set(key, retained);
  return true;
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

  for (const action of actions) {
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
  const local = DateTime.fromJSDate(now).setZone(timezone);
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
  const now = DateTime.now().setZone(timezone);
  const [endH, endM] = end.split(':').map(Number);
  let target = now.set({ hour: endH, minute: endM, second: 0, millisecond: 0 });
  if (target <= now) {
    target = target.plus({ days: 1 });
  }
  return target.toUTC();
}

function nextDigestTime(profile: NotificationProfile): DateTime {
  const zone = profile.timezone || DEFAULT_TIMEZONE;
  const now = DateTime.now().setZone(zone);
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
  return Number.isFinite(ms) && ms <= 24 * 3_600_000;
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
