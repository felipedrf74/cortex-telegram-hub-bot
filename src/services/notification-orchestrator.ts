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
  resolveNotificationContract,
} from './notification-contracts';
import {
  buildDecisionLogicV2,
  rankDecision,
  type DecisionLogicContext,
  type DecisionLogicInput,
  type DecisionVisibilityScope,
} from './decision-center-logic-v2';

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
  | 'sent_local'
  | 'in_app_only'
  | 'portal_only'
  | 'digest'
  | 'suppressed'
  | 'deduped'
  | 'quiet_hours_delayed'
  | 'blocked_missing_device_token'
  | 'blocked_user_preferences'
  | 'blocked_privacy_policy';
export type NotificationCenterStatus = 'unread' | 'read' | 'viewed' | 'snoozed' | 'actioned' | 'dismissed' | 'failed' | 'expired' | 'superseded';
export type NotificationPrivacyPolicy = 'public' | 'standard' | 'sensitive' | 'private_content' | 'financial' | 'health';
export type NotificationDeliveryPolicy = 'auto' | 'in_app_only' | 'push_allowed' | 'digest_only' | 'portal_only';
export type QuietHoursPolicy = 'respect' | 'allow_time_sensitive' | 'send_now';

export interface NotificationActionButton {
  id: string;
  label: string;
  style?: 'primary' | 'secondary' | 'destructive';
  deeplink?: string;
  mutating?: boolean;
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
  status: 'sent' | 'mock_sent' | 'blocked_missing_device_token' | 'blocked_missing_credentials' | 'failed';
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
}

export type NotificationReliabilityEventType = 'badge_reconciled' | 'read_state_failure';

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
const DEFAULT_TIMEZONE = 'Europe/Lisbon';
const PUSH_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const PUSH_RATE_LIMIT_MAX_PER_SOURCE = 20;
const pushRateLimitByScope = new Map<string, number[]>();

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
  ensureColumn('notification_intents', 'decision_context_json', 'TEXT');
}

export function getOrCreateNotificationProfile(userId: number, tenantId = userId): NotificationProfile {
  assertScope(userId, tenantId, 'get_notification_profile');
  ensureNotificationTables();
  const db = getDb();
  db.prepare(`
    INSERT INTO notification_profiles (user_id, tenant_id)
    VALUES (?, ?)
    ON CONFLICT(user_id, tenant_id) DO NOTHING
  `).run(userId, tenantId);

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
      deliveryAttempts.push(attempt);
      decision = attempt.status === 'blocked_missing_device_token'
        ? 'blocked_missing_device_token'
        : 'sent_push';
      reason = attempt.status === 'mock_sent'
        ? 'mock push provider accepted privacy-safe payload'
        : attempt.status === 'sent'
          ? 'APNs accepted privacy-safe payload'
          : attempt.status === 'blocked_missing_credentials'
            ? 'APNs credentials missing; durable in-app item created'
            : 'no active device token; durable in-app item created';
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

export async function releaseDueNotificationDeliveries(now = new Date()): Promise<{
  inspected: number;
  released: number;
  blocked: number;
}> {
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
      AND (items.expires_at IS NULL OR datetime(items.expires_at) > datetime('now'))
    ORDER BY logs.scheduled_for ASC
    LIMIT 100
  `).all(now.toISOString()) as any[];

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
  const updateReleasedLogs = db.transaction((updates: Array<{
    row: any;
    decision: NotificationDecision;
    reason: string;
    sentAt: string | null;
    attemptIds: string[];
  }>) => {
    const stmt = db.prepare(`
      UPDATE notification_decision_logs
      SET decision = ?,
          reason = ?,
          sent_at = ?,
          delivery_attempt_ids_json = ?
      WHERE decision_log_id = ?
        AND user_id = ?
        AND tenant_id = ?
    `);
    for (const update of updates) {
      stmt.run(
        update.decision,
        update.reason,
        update.sentAt,
        JSON.stringify(update.attemptIds),
        update.row.decision_log_id,
        update.row.user_id,
        update.row.tenant_id,
      );
    }
  });

  for (const group of digestGroups.values()) {
    try {
      const first = group[0];
      const profile = getOrCreateNotificationProfile(first.user_id, first.tenant_id);
      const digestIntent = mapIntent(first);
      const payload = assembleDailyDigest(first.user_id, first.tenant_id, group.length);
      const attempt = await attemptPushDelivery(digestIntent, first.item_id, payload, profile);
      const decision: NotificationDecision = attempt.status === 'sent' || attempt.status === 'mock_sent'
        ? 'sent_push'
        : 'blocked_missing_device_token';
      const reason = attempt.status === 'sent'
        ? 'digest notification released to APNs'
        : attempt.status === 'mock_sent'
          ? 'digest notification released to mock push provider'
          : attempt.status === 'blocked_missing_credentials'
            ? 'digest notification due but APNs credentials are missing'
            : 'digest notification due but no active device token is available';
      updateReleasedLogs(group.map((row) => ({
        row,
        decision,
        reason,
        sentAt: attempt.sentAt,
        attemptIds: [attempt.attemptId],
      })));
      if (attempt.status === 'sent' || attempt.status === 'mock_sent') released += group.length;
      else blocked += group.length;
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
      const decision: NotificationDecision = attempt.status === 'sent' || attempt.status === 'mock_sent'
        ? 'sent_push'
        : attempt.status === 'blocked_missing_credentials'
          ? 'blocked_missing_device_token'
          : 'blocked_missing_device_token';
      const reason = attempt.status === 'sent'
        ? 'delayed notification released to APNs'
        : attempt.status === 'mock_sent'
          ? 'delayed notification released to mock push provider'
          : attempt.status === 'blocked_missing_credentials'
            ? 'delayed notification released but APNs credentials are missing'
            : 'delayed notification released but no active device token is available';
      updateReleasedLogs([{
        row,
        decision,
        reason,
        sentAt: attempt.sentAt,
        attemptIds: [attempt.attemptId],
      }]);
      if (attempt.status === 'sent' || attempt.status === 'mock_sent') released += 1;
      else blocked += 1;
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
  const clauses = ['user_id = ?', 'tenant_id = ?'];
  const params: unknown[] = [userId, tenantId];
  if (opts.status && opts.status !== 'all') {
    clauses.push('status = ?');
    params.push(opts.status);
  } else {
    clauses.push("status != 'expired'");
  }
  // A1: hide items past their hard deadline (unless the caller explicitly asks for expired).
  if (opts.status !== 'expired') {
    clauses.push("(expires_at IS NULL OR datetime(expires_at) > datetime('now'))");
  }
  if (opts.sourceSkill) {
    clauses.push('source_skill = ?');
    params.push(opts.sourceSkill);
  }
  params.push(Math.min(Math.max(opts.limit ?? 50, 1), 200));

  const rows = getDb().prepare(`
    SELECT * FROM notification_center_items
    WHERE ${clauses.join(' AND ')}
    ORDER BY created_at DESC
    LIMIT ?
  `).all(...params) as any[];
  return rows.map(mapCenterItem);
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
       AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))
  `).get(userId, tenantId, ...NON_BADGE_NOTIFICATION_TYPES) as { count: number } | undefined;
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
       AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))
  `).all(userId, tenantId, `${bridgePrefix}:%`) as Array<{ dedupeKey: string | null }>;
  const ids = new Set<number>();
  const pattern = new RegExp(`^${bridgePrefix}:[^:]+:(\\d+)$`);
  for (const row of rows) {
    if (!row.dedupeKey) continue;
    const match = row.dedupeKey.match(pattern);
    if (!match) continue;
    const id = Number.parseInt(match[1], 10);
    if (Number.isInteger(id) && id > 0) ids.add(id);
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
    SELECT * FROM notification_center_items
    WHERE item_id = ? AND user_id = ? AND tenant_id = ?
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
      AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))
  `).run(itemId, userId, tenantId);
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
    WHERE item_id = ? AND user_id = ? AND tenant_id = ? AND status IN ('unread', 'read')
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
    throw new Error('action not allowed for notification');
  }
  getDb().prepare(`
    UPDATE notification_center_items
    SET status = 'actioned', actioned_at = datetime('now')
    WHERE item_id = ? AND user_id = ? AND tenant_id = ?
  `).run(itemId, userId, tenantId);
  const updated = getNotificationCenterItem(itemId, userId, tenantId);
  if (!updated) throw new Error('notification action failed');
  markDecisionActionTaken(updated.decisionLogId, actionId);
  return { item: updated, actionId, idempotent: false };
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
    pushSentCount: attemptRows.filter((row) => row.status === 'sent' || row.status === 'mock_sent').length,
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
  if (!['badge_reconciled', 'read_state_failure'].includes(input.eventType)) {
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
      SUM(CASE WHEN decision = 'digest' AND sent_at IS NULL AND scheduled_for IS NOT NULL AND datetime(scheduled_for) <= datetime('now') THEN 1 ELSE 0 END) AS dueCount,
      SUM(CASE WHEN reason LIKE 'digest notification released%' THEN 1 ELSE 0 END) AS releasedCount
      FROM notification_decision_logs
     WHERE user_id = ? AND tenant_id = ?
  `).get(userId, tenantId) as { pendingCount: number | null; dueCount: number | null; releasedCount: number | null };
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
  const defaultCanonicalUnreadCount = countUnreadNotificationCenterItems(userId, tenantId);
  const expectedBadgeCount = Number.isInteger(opts.expectedBadgeCount)
    ? Math.max(0, opts.expectedBadgeCount!)
    : defaultCanonicalUnreadCount;
  const canonicalUnreadCount = Number.isInteger(opts.canonicalUnreadCount)
    ? Math.max(0, opts.canonicalUnreadCount!)
    : defaultCanonicalUnreadCount;
  const clientReportedBadgeCount = latestBadgeEvent?.badgeCount ?? null;
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
      drift: clientReportedBadgeCount == null ? null : clientReportedBadgeCount - expectedBadgeCount,
    },
    readState: {
      serverReadFailureCount: 0,
      clientReportedReadFailureCount: readState.clientReportedReadFailureCount ?? 0,
    },
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
        userId, tenantId, sourceSkill, type: 'reminder', priority: 'time_sensitive',
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
  const relatedEntityId = input.relatedEntityId == null ? null : String(input.relatedEntityId);
  const relatedEntityType = input.relatedEntityType ?? null;
  const actionButtons = normalizeActions(input.actionButtons ?? defaultActionsForType(input.type));
  const decisionContext = normalizeDecisionContext({
    ...(input.decisionContext ?? {}),
    ...(input.visibilityScope ? { visibilityScope: input.visibilityScope } : {}),
  });
  const contract = resolveNotificationContract({
    sourceSkill: input.sourceSkill,
    type: input.type,
    actionId: actionButtons[0]?.id ?? null,
    entityType: relatedEntityType,
    entityId: relatedEntityId,
    recipe: typeof decisionContext?.recipe === 'string' ? decisionContext.recipe : null,
  });

  return {
    intentId: input.intentId ?? `ni_${randomUUID()}`,
    userId: input.userId,
    tenantId,
    sourceSkill: input.sourceSkill,
    type: input.type,
    priority: input.priority,
    relatedEntityId,
    relatedEntityType,
    title: input.title.trim(),
    body: input.body.trim(),
    sensitiveBody: input.sensitiveBody?.trim() || null,
    actionButtons,
    deeplink: input.deeplink ?? `nexus://notifications/${input.intentId ?? 'pending'}`,
    expiresAt: input.expiresAt ?? null,
    quietHoursPolicy: input.quietHoursPolicy ?? 'respect',
    dedupeKey: input.dedupeKey ?? defaultDedupeKey(input),
    requiresUserAction: !!input.requiresUserAction,
    decisionDeadline: input.decisionDeadline ?? null,
    deliveryPolicy: input.deliveryPolicy ?? deliveryPolicyForNotificationContract(contract),
    privacyPolicy: input.privacyPolicy ?? contract.privacySafeCopyPolicy,
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
      type, priority, status, deeplink, actions_json, dedupe_key, expires_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unread', ?, ?, ?, ?, datetime('now'))
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
    intent.expiresAt,
  );
  const row = getDb().prepare('SELECT * FROM notification_center_items WHERE item_id = ?').get(itemId) as any;
  return mapCenterItem(row);
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
): Promise<DeliveryAttempt> {
  const tokens = getPushTokensForUser(intent.userId);
  if (tokens.length === 0) {
    return persistDeliveryAttempt(intent, notificationId, 'push', 'mock', 'blocked_missing_device_token', null, 'no_active_device_token');
  }

  const deliveryMode = config.notificationDelivery?.mode
    ?? (process.env.NOTIFICATION_DELIVERY_MODE === 'apns' ? 'apns' : 'mock');
  if (deliveryMode !== 'apns') {
    return persistDeliveryAttempt(intent, notificationId, 'push', 'mock', 'mock_sent', 'mock', null);
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
      collapseId: isDecisionPush ? `decision:${notificationId}` : undefined,
    });
    if (result.sent > 0) {
      return persistDeliveryAttempt(intent, notificationId, 'push', 'apns', 'sent', '2xx', null);
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
  const sentAt = status === 'sent' || status === 'mock_sent' ? new Date().toISOString() : null;
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
    SELECT * FROM notification_center_items
    WHERE user_id = ?
      AND tenant_id = ?
      AND source_skill = ?
      AND dedupe_key = ?
      AND status IN ('unread', 'read')
      AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))
    ORDER BY created_at DESC
    LIMIT 1
  `).get(intent.userId, intent.tenantId, intent.sourceSkill, intent.dedupeKey) as any;
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
       AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))
     ORDER BY created_at DESC
     LIMIT 1
  `).get(intent.userId, intent.tenantId, intent.sourceSkill, intent.dedupeKey) as any;
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
  return Object.keys(context).length ? context : null;
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
  return {
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
      { id: 'mark_done', label: 'Done', style: 'primary' },
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
