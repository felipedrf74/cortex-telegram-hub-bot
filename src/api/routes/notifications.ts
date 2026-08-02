// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Router, Response } from 'express';
import { DateTime } from 'luxon';
import { AuthenticatedRequest } from '../auth-middleware';
import { sendSuccess, sendError, asyncHandler } from '../response-helpers';
import {
  getNotifications,
  getUnreadCountExcludingNotificationIds,
  markAllRead,
  markRead,
  resolveNotification,
  type NotificationStatus,
  type NotificationType,
} from '../../services/content-notification-store';
import { getRecentReports, getUnreadReportCountExcludingIds } from '../../services/report-document-store';
import { isConnected } from '../../services/oauth-store';
import { getUnreadEmailsForUser as getOutlookUnreadEmailsForUser, readEmailForUser as readOutlookEmailForUser } from '../../services/outlook-mail';
import {
  searchEmailsForUser as searchGmailEmailsForUser,
  readEmailForUser as readGmailEmailForUser,
  countEmailsForUser as countGmailEmailsForUser,
} from '../../services/google-gmail';
import { getEvents as getOutlookEvents } from '../../services/outlook-calendar';
import { getEvents as getGoogleEvents } from '../../services/google-calendar';
import { resolveMailReadPreference } from '../../services/provider-preferences';
import { logger } from '../../utils/logger';
import { config } from '../../config';
import { secureSecretMatches } from '../secret-guards';
import { AITimeoutError, withTimeout } from '../../utils/timeout';
import { isValidTenantUserId } from '../../services/tenant-scope-observability';
import { listTasks } from '../../services/task-store/task-service';
import { priorityToImportance } from '../../services/task-store/task-priority';
import type { NormalizedTask } from '../../services/task-store/types';
import { ensureCachedRouteTenantScope, handleCachedRoute, routeCacheKey } from '../route-helpers/cached-route-handler';
import { invalidateNotificationInboxCaches } from '../../services/notification-cache-invalidation';
import {
  buildSkillNotificationFixtureIntent,
  countUnreadNotificationCenterItems,
  createNotificationIntent,
  dismissNotificationCenterItem,
  getNotificationDecisionLog,
  getNotificationReliabilityDashboard,
  getOrCreateNotificationProfile,
  listNotificationBridgeEntityIds,
  listNotificationCenterItems,
  markNotificationCenterItemRead,
  performNotificationAction,
  recordNotificationReliabilityEvent,
  registerNotificationDeviceToken,
  revokeNotificationDeviceToken,
  applyNotificationProfilePatch,
  notificationReachability,
  notificationTimezoneDrift,
  updateNotificationProfile,
  type NotificationCenterStatus,
  type NotificationCenterItem,
  type NotificationEvaluationResult,
  type NotificationIntentInput,
  type NotificationProfile,
  type NotificationSourceSkill,
} from '../../services/notification-orchestrator';
import { DecisionActionError, getDecisionItem, performDecisionAction } from '../../services/decision-center';

type InboxItemKind = 'notification' | 'report' | 'email' | 'task' | 'event';
type InboxAction = 'open_content' | 'open_report' | 'view_email' | 'open_tasks' | 'view_event';
type InboxPriority = 'high' | 'medium' | 'low';
type InboxStatus = 'ready' | 'degraded' | 'unavailable';

const INBOX_CACHE_TTL = 45;
const INBOX_SWR_STALE = 300;
const INBOX_SUMMARY_CACHE_TTL = 30;
const INBOX_SUMMARY_SWR_STALE = 180;
const DEFAULT_INBOX_SOURCE_TIMEOUT_MS = 3_000;
const DEFAULT_INBOX_SUMMARY_SOURCE_TIMEOUT_MS = 2_000;

interface UnifiedInboxItem {
  kind: InboxItemKind;
  id: string;
  numericId?: number;
  title: string;
  body: string | null;
  type: string;
  status: string;
  createdAt: string;
  source: string | null;
  priority: InboxPriority;
  action: InboxAction;
  metadata?: Record<string, any>;
}

interface UnifiedInboxSourceResult {
  items: UnifiedInboxItem[];
  unreadCount: number;
}

function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getInboxSourceTimeoutMs(): number {
  return positiveIntFromEnv('UNIFIED_INBOX_SOURCE_TIMEOUT_MS', DEFAULT_INBOX_SOURCE_TIMEOUT_MS);
}

function getInboxSummarySourceTimeoutMs(): number {
  return positiveIntFromEnv('UNIFIED_INBOX_SUMMARY_SOURCE_TIMEOUT_MS', DEFAULT_INBOX_SUMMARY_SOURCE_TIMEOUT_MS);
}

function safeErrorName(err: unknown): string {
  if (err instanceof Error && err.name) return err.name;
  return typeof err;
}

function safeErrorCode(err: unknown): string | number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const candidate = err as { code?: unknown; status?: unknown; response?: { status?: unknown } };
  if (typeof candidate.code === 'string' || typeof candidate.code === 'number') return candidate.code;
  if (typeof candidate.status === 'string' || typeof candidate.status === 'number') return candidate.status;
  if (typeof candidate.response?.status === 'string' || typeof candidate.response?.status === 'number') {
    return candidate.response.status;
  }
  return undefined;
}

async function runInboxSource<T>(
  opts: {
    key: string;
    userId: number;
    limit?: number;
    timeoutMs: number;
    run: () => Promise<T>;
  },
): Promise<T> {
  const startedAt = Date.now();
  try {
    const value = await withTimeout(opts.run(), opts.timeoutMs);
    logger.debug(
      {
        event: 'unified_inbox_source',
        source: opts.key,
        outcome: 'success',
        userId: opts.userId,
        limit: opts.limit,
        durationMs: Date.now() - startedAt,
      },
      'Unified inbox source completed',
    );
    return value;
  } catch (err) {
    logger.warn(
      {
        event: 'unified_inbox_source',
        source: opts.key,
        outcome: err instanceof AITimeoutError ? 'timeout' : 'failed',
        userId: opts.userId,
        limit: opts.limit,
        durationMs: Date.now() - startedAt,
        timeoutMs: opts.timeoutMs,
        errorName: safeErrorName(err),
        errorCode: safeErrorCode(err),
      },
      'Unified inbox source degraded',
    );
    throw err;
  }
}

function ensureValidNotificationsRouteScope(
  res: Response,
  userId: number | undefined,
  operation: string,
  details?: Record<string, unknown>,
): userId is number {
  return ensureCachedRouteTenantScope(res, userId, operation, details);
}

function safeIso(input: unknown, fallback = new Date()): string {
  if (typeof input === 'string' && input.length > 0) {
    const date = new Date(input);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  if (input instanceof Date && !Number.isNaN(input.getTime())) {
    return input.toISOString();
  }
  return fallback.toISOString();
}

const INBOX_METADATA_STRING_FIELDS = new Set([
  'provider',
  'providerMessageId',
  'from',
  'to',
  'importance',
  'taskId',
  'dueDateTime',
  'listId',
  'listName',
  'eventId',
  'start',
  'end',
  'location',
  'htmlLink',
  'sourceJob',
  'notificationId',
  'deeplink',
  'sourceSkill',
]);

function coerceInboxMetadataString(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  return null;
}

function normalizeInboxMetadata(metadata: Record<string, any> | null | undefined): Record<string, any> {
  const normalized = { ...(metadata || {}) };
  for (const key of INBOX_METADATA_STRING_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(normalized, key)) {
      normalized[key] = coerceInboxMetadataString(normalized[key]);
    }
  }
  return normalized;
}

function routeTenantId(req: AuthenticatedRequest, userId: number): number {
  const candidate = (req as any).tenantId;
  return isValidTenantUserId(candidate) ? candidate : userId;
}

function isInternalNotificationIntentRequest(req: AuthenticatedRequest): boolean {
  const expected = process.env.INTERNAL_API_SECRET || '';
  const provided = req.header('x-internal-secret');
  return Boolean(expected) && secureSecretMatches(expected, provided);
}

// Global report-schedule fallbacks. NULL profile columns mean "use the global
// default"; these mirror the resolution the report-schedule dispatcher applies
// (morning = TODO digest time, coach = Garmin coach time, end of day 21:00,
// weekly review Friday 17:00).
import {
  END_OF_DAY_DEFAULT_TIME,
  WEEKLY_REVIEW_DEFAULT_DAY as WEEKLY_REVIEW_REPORT_DEFAULT_DAY,
  WEEKLY_REVIEW_DEFAULT_TIME as WEEKLY_REVIEW_REPORT_DEFAULT_TIME,
} from '../../services/report-schedule-dispatcher';

function buildReportScheduleForApi(profile: NotificationProfile): Record<string, unknown> {
  const morningBriefingTime = profile.morningBriefingTime ?? null;
  const coachBriefingTime = profile.coachBriefingTime ?? null;
  const endOfDayTime = profile.endOfDayTime ?? null;
  const weeklyReviewReportDay = profile.weeklyReviewReportDay ?? null;
  const weeklyReviewReportTime = profile.weeklyReviewReportTime ?? null;
  return {
    morningBriefingTime,
    coachBriefingTime,
    endOfDayTime,
    weeklyReviewReportDay,
    weeklyReviewReportTime,
    effective: {
      morningBriefingTime: morningBriefingTime ?? config.todo.digestTime,
      coachBriefingTime: coachBriefingTime ?? config.garmin.coachTime,
      endOfDayTime: endOfDayTime ?? END_OF_DAY_DEFAULT_TIME,
      weeklyReviewReportDay: weeklyReviewReportDay ?? WEEKLY_REVIEW_REPORT_DEFAULT_DAY,
      weeklyReviewReportTime: weeklyReviewReportTime ?? WEEKLY_REVIEW_REPORT_DEFAULT_TIME,
    },
  };
}

function formatCenterItemForApi(item: NotificationCenterItem): Record<string, unknown> {
  return {
    itemId: item.itemId,
    id: item.itemId,
    intentId: item.intentId,
    decisionLogId: item.decisionLogId,
    title: item.title,
    body: item.body,
    safeBody: item.safeBody,
    sensitiveBody: item.sensitiveBody,
    sourceSkill: item.sourceSkill,
    type: item.type,
    priority: item.priority,
    status: item.status,
    deeplink: item.deeplink,
    actions: item.actions,
    actionEffectiveStatuses: item.actionEffectiveStatuses ?? [],
    frontendActionState: item.frontendActionState ?? 'enabled',
    dedupeKey: item.dedupeKey,
    createdAt: item.createdAt,
    expiresAt: item.expiresAt,
    // Clients cannot render "snoozed until 16:00" — or tell a snoozed row from
    // a dismissed one — without this. It was tracked server-side but never
    // projected.
    snoozedUntil: item.snoozedUntil ?? null,
  };
}

function formatEvaluationForApi(result: NotificationEvaluationResult): Record<string, unknown> {
  return {
    intent: {
      intentId: result.intent.intentId,
      sourceSkill: result.intent.sourceSkill,
      type: result.intent.type,
      priority: result.intent.priority,
      dedupeKey: result.intent.dedupeKey,
      createdAt: result.intent.createdAt,
    },
    item: result.item ? formatCenterItemForApi(result.item) : null,
    decisionLog: {
      decisionLogId: result.decisionLog.decisionLogId,
      decision: result.decisionLog.decision,
      reason: result.decisionLog.reason,
      scheduledFor: result.decisionLog.scheduledFor,
      sentAt: result.decisionLog.sentAt,
    },
    deliveryAttempts: result.deliveryAttempts.map((attempt) => ({
      attemptId: attempt.attemptId,
      channel: attempt.channel,
      provider: attempt.provider,
      status: attempt.status,
      errorCode: attempt.errorCode,
      sentAt: attempt.sentAt,
    })),
    pushPayload: result.pushPayload,
  };
}

function notificationCenterSection(item: NotificationCenterItem): string {
  if (item.type === 'decision_required' || item.type === 'reflow_suggestion') return 'needsDecision';
  if (item.type === 'conflict_detected') return 'conflicts';
  if (item.type === 'reminder' || item.type === 'missed_item') return 'reminders';
  if (item.type === 'approval_required') return 'approvals';
  if (item.type === 'schedule_changed') return 'scheduleChanges';
  if (item.type === 'insight' || item.type === 'daily_digest' || item.type === 'weekly_review') return 'insights';
  return 'history';
}

function buildDecisionCenterSections(items: NotificationCenterItem[]): Record<string, Record<string, unknown>[]> {
  const sections: Record<string, Record<string, unknown>[]> = {
    needsDecision: [],
    conflicts: [],
    reminders: [],
    scheduleChanges: [],
    approvals: [],
    insights: [],
    history: [],
  };
  for (const item of items) {
    sections[notificationCenterSection(item)].push(formatCenterItemForApi(item));
  }
  return sections;
}

function bridgedEntityIdsForScope(
  userId: number,
  tenantId: number,
  bridgePrefix: 'content' | 'report',
): number[] {
  try {
    return listNotificationBridgeEntityIds(userId, tenantId, bridgePrefix);
  } catch (err) {
    logger.warn(
      {
        event: 'notification_bridge_ids_degraded',
        userId,
        tenantId,
        bridgePrefix,
        errorName: safeErrorName(err),
        errorCode: safeErrorCode(err),
      },
      'Notification bridge entity-id lookup degraded',
    );
    return [];
  }
}

function centerItemsToInboxResult(centerItems: NotificationCenterItem[]): UnifiedInboxSourceResult {
  const items = centerItems.map((item) => ({
    kind: 'notification' as const,
    id: `decision:${item.itemId}`,
    title: item.title,
    body: item.safeBody || item.body || null,
    type: item.type,
    status: item.status,
    createdAt: safeIso(item.createdAt),
    source: item.sourceSkill,
    priority: item.priority === 'time_sensitive' || item.priority === 'critical'
      ? 'high' as const
      : item.priority === 'active'
        ? 'medium' as const
        : 'low' as const,
    action: 'open_content' as const,
    metadata: normalizeInboxMetadata({
      notificationId: item.itemId != null ? String(item.itemId) : null,
      deeplink: item.deeplink,
      sourceSkill: item.sourceSkill,
      actions: item.actions,
      dedupeKey: item.dedupeKey,
    }),
  }));
  return { items, unreadCount: centerItems.filter((item) => item.status === 'unread').length };
}

function toHumanDateTime(input: unknown): string | null {
  if (typeof input !== 'string' || !input) return null;
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function inboxTaskPriority(task: NormalizedTask): InboxPriority {
  // M10 P-scale (NEX-17): P1/P2 are the high bucket, P3 (normal) maps to
  // medium, P4/none to low — see task-priority.ts.
  const importance = priorityToImportance(task.priority);
  if (importance === 'high') return 'high';
  if (importance === 'normal' && task.priority === 3) return 'medium';
  return 'low';
}

function inboxPriorityScore(item: UnifiedInboxItem): number {
  const createdAt = new Date(item.createdAt).getTime();
  const hoursSinceCreated = Number.isNaN(createdAt)
    ? 9999
    : Math.max(0, (Date.now() - createdAt) / 3_600_000);

  let score = 20;
  if (item.status === 'unread') score += 20;
  if (item.priority === 'high') score += 40;
  else if (item.priority === 'medium') score += 20;

  if (item.kind === 'task') {
    if (item.type === 'task_overdue') score += 110;
    else if (item.type === 'task_due_today') score += 55;
    else score += 25;
  } else if (item.kind === 'event') {
    if (item.type === 'event_starting_soon') score += 70;
    else score += 35;
  } else if (item.kind === 'email') {
    score += item.metadata?.importance === 'high' ? 45 : 25;
  } else if (item.kind === 'report') {
    score += 35;
  } else if (item.kind === 'notification') {
    score += 30;
  }

  return score - Math.min(30, hoursSinceCreated);
}

function compareInboxItems(a: UnifiedInboxItem, b: UnifiedInboxItem): number {
  const scoreDiff = inboxPriorityScore(b) - inboxPriorityScore(a);
  if (scoreDiff !== 0) return scoreDiff;
  return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
}

async function buildUnifiedInbox(userId: number, tenantId: number, limit: number): Promise<{
  totalUnread: number;
  count: number;
  items: UnifiedInboxItem[];
  status: InboxStatus;
  warningCodes: string[];
  warnings: string[];
}> {
  const zone = config.app.timezone || 'Europe/Lisbon';
  const now = DateTime.now().setZone(zone);
  const nowDate = now.toJSDate();
  const start = now.startOf('day').toUTC().toISO()!;
  const end = now.endOf('day').toUTC().toISO()!;
  const todayStr = now.toISODate()!;
  const outlookConnected = isConnected(userId, 'outlook');
  const googleConnected = isConnected(userId, 'google');
  // Phase 17 hostile-QA fix (2026-05-18): pass real tenantId from the route
  // scope so cross-tenant users read their persisted mail preference
  // instead of falling back to the (userId, userId) default which silently
  // reverts to 'auto'.
  const mailPreference = resolveMailReadPreference(userId, tenantId);
  const warningCodes: string[] = [];
  const warnings: string[] = [];
  const items: UnifiedInboxItem[] = [];
  let totalUnread = 0;
  let successCount = 0;
  let centerItems: NotificationCenterItem[] = [];

  try {
    const centerResult = await runInboxSource({
      key: 'decision-center',
      userId,
      limit,
      timeoutMs: getInboxSourceTimeoutMs(),
      run: async () => {
        centerItems = listNotificationCenterItems(userId, tenantId, { status: 'all', limit });
        return {
          ...centerItemsToInboxResult(centerItems),
          unreadCount: countUnreadNotificationCenterItems(userId, tenantId),
        };
      },
    });
    successCount += 1;
    items.push(...centerResult.items);
    totalUnread += centerResult.unreadCount;
  } catch {
    warningCodes.push('DECISION_CENTER_UNAVAILABLE');
    warnings.push('Decision Center notifications are temporarily unavailable.');
  }

  const bridgedContentNotificationIds = bridgedEntityIdsForScope(userId, tenantId, 'content');
  const bridgedReportIds = bridgedEntityIdsForScope(userId, tenantId, 'report');
  const bridgedContentNotificationIdSet = new Set(bridgedContentNotificationIds);
  const bridgedReportIdSet = new Set(bridgedReportIds);

  const fetchers: Array<{
    key: string;
    warningCode: string;
    warning: string;
    run: () => Promise<UnifiedInboxSourceResult>;
  }> = [
    {
      key: 'notifications',
      warningCode: 'CONTENT_NOTIFICATIONS_UNAVAILABLE',
      warning: 'Content notifications are temporarily unavailable.',
      run: async () => {
        const notifications = getNotifications(userId, { limit, tenantId })
          .filter((n: any) => !bridgedContentNotificationIdSet.has(Number(n.id)));
        const items = notifications.map((n: any) => ({
          kind: 'notification' as const,
          id: `notification:${n.id}`,
          numericId: n.id,
          title: n.title,
          body: n.body || null,
          type: n.type,
          status: n.status,
          createdAt: safeIso(n.createdAt),
          source: 'content',
          priority: n.status === 'unread' ? 'medium' as const : 'low' as const,
          action: 'open_content' as const,
          metadata: normalizeInboxMetadata(n.data || {}),
        }));
        return { items, unreadCount: getUnreadCountExcludingNotificationIds(userId, bridgedContentNotificationIds, tenantId) };
      },
    },
    {
      key: 'reports',
      warningCode: 'REPORTS_UNAVAILABLE',
      warning: 'Reports are temporarily unavailable.',
      run: async () => {
        const reports = getRecentReports(userId, { limit })
          .filter((r: any) => !bridgedReportIdSet.has(Number(r.id)));
        const items = reports.map((r: any) => ({
          kind: 'report' as const,
          id: `report:${r.id}`,
          numericId: r.id,
          title: r.title,
          body: r.summary || null,
          type: r.type,
          status: r.status,
          createdAt: safeIso(r.createdAt),
          source: 'nexus',
          priority: r.status === 'unread' ? 'high' as const : 'medium' as const,
          action: 'open_report' as const,
          metadata: normalizeInboxMetadata({ sourceJob: r.sourceJob || null }),
        }));
        return { items, unreadCount: getUnreadReportCountExcludingIds(userId, bridgedReportIds) };
      },
    },
    {
      key: 'tasks',
      warningCode: 'TASKS_INBOX_UNAVAILABLE',
      warning: 'Task items are temporarily unavailable.',
      run: async () => {
        const tasks = listTasks(userId, { status: 'pending' });
        if (!Array.isArray(tasks)) throw new Error('Task data unavailable');

        const items = tasks
          .map((task) => {
            const dueDateTime = task.dueDate || null;
            const dueIso = dueDateTime ? safeIso(dueDateTime) : null;
            const dueStr = dueIso
              ? DateTime.fromISO(dueIso, { zone: 'utc' }).setZone(zone).toISODate()
              : null;
            const isOverdue = !!dueStr && dueStr < todayStr;
            const isDueToday = !!dueStr && dueStr === todayStr;
            const dueLabel = dueIso ? toHumanDateTime(dueIso) : null;
            const taskId = task.id ?? task.externalId;
            return {
              kind: 'task' as const,
              id: `task:${taskId}`,
              numericId: task.id,
              title: task.title || 'Untitled task',
              body: task.description || task.notes || (dueLabel ? `Due ${dueLabel}` : task.projectName || null),
              type: isOverdue ? 'task_overdue' : isDueToday ? 'task_due_today' : 'task_pending',
              status: isOverdue ? 'attention' : isDueToday ? 'due_today' : 'pending',
              createdAt: dueIso || safeIso(nowDate),
              source: task.provider === 'ms_todo' ? 'microsoft_todo' : task.provider,
              priority: isOverdue ? 'high' as const : isDueToday ? 'medium' as const : inboxTaskPriority(task),
              action: 'open_tasks' as const,
              metadata: normalizeInboxMetadata({
                taskId,
                dueDateTime: dueIso,
                listId: task.projectId,
                listName: task.projectName || null,
                importance: priorityToImportance(task.priority),
              }),
            };
          })
          .sort(compareInboxItems)
          .slice(0, Math.max(4, Math.ceil(limit / 2)));

        return { items, unreadCount: 0 };
      },
    },
  ];

  if (mailPreference.sources.includes('outlook')) {
    fetchers.push(
      {
        key: 'outlook-email',
        warningCode: 'OUTLOOK_MAIL_UNAVAILABLE',
        warning: 'Outlook mail is temporarily unavailable.',
        run: async () => {
          const { count, emails } = await getOutlookUnreadEmailsForUser(userId, Math.max(4, Math.ceil(limit / 3)));
          const items = (emails || []).map((email: any) => ({
            kind: 'email' as const,
            id: `email:outlook:${email.id}`,
            title: email.subject || '(No subject)',
            body: email.snippet || null,
            type: email.importance === 'high' ? 'email_important' : 'email_unread',
            status: email.isRead ? 'read' : 'unread',
            createdAt: safeIso(email.date),
            source: 'outlook',
            priority: email.importance === 'high' ? 'high' as const : 'medium' as const,
            action: 'view_email' as const,
            metadata: normalizeInboxMetadata({
              provider: 'outlook',
              providerMessageId: email.id,
              from: email.from || null,
              to: email.to || null,
              importance: email.importance || 'normal',
            }),
          }));
          return { items, unreadCount: count || items.length };
        },
      },
      {
        key: 'outlook-calendar',
        warningCode: 'OUTLOOK_CALENDAR_UNAVAILABLE',
        warning: 'Outlook calendar is temporarily unavailable.',
        run: async () => {
          const events = await getOutlookEvents(start, end, userId);
          const items = (events || []).map((event: any) => {
            const startIso = safeIso(event.start);
            const minutesUntilStart = Math.round((new Date(startIso).getTime() - Date.now()) / 60_000);
            const isSoon = minutesUntilStart >= -30 && minutesUntilStart <= 120;
            return {
              kind: 'event' as const,
              id: `event:outlook:${event.id}`,
              title: event.summary || '(No title)',
              body: [toHumanDateTime(startIso), event.location].filter(Boolean).join(' • ') || null,
              type: isSoon ? 'event_starting_soon' : 'event_today',
              status: isSoon ? 'starting_soon' : 'upcoming',
              createdAt: startIso,
              source: 'outlook',
              priority: isSoon ? 'high' as const : 'medium' as const,
              action: 'view_event' as const,
              metadata: normalizeInboxMetadata({
                provider: 'outlook',
                eventId: event.id,
                start: startIso,
                end: safeIso(event.end, new Date(startIso)),
                location: event.location || null,
                htmlLink: event.htmlLink || null,
              }),
            };
          });
          return { items, unreadCount: 0 };
        },
      },
    );
  }

  if (mailPreference.sources.includes('gmail')) {
    fetchers.push(
      {
        key: 'gmail',
        warningCode: 'GMAIL_UNAVAILABLE',
        warning: 'Gmail is temporarily unavailable.',
        run: async () => {
          const emails = await searchGmailEmailsForUser(userId, 'in:inbox is:unread newer_than:14d', Math.max(4, Math.ceil(limit / 3)));
          const items = (emails || []).map((email: any) => ({
            kind: 'email' as const,
            id: `email:gmail:${email.id}`,
            title: email.subject || '(No subject)',
            body: email.snippet || null,
            type: 'email_unread',
            status: 'unread',
            createdAt: safeIso(email.date),
            source: 'gmail',
            priority: 'medium' as const,
            action: 'view_email' as const,
            metadata: normalizeInboxMetadata({
              provider: 'gmail',
              providerMessageId: email.id,
              from: email.from || null,
              to: email.to || null,
              importance: 'normal',
            }),
          }));
          return { items, unreadCount: items.length };
        },
      },
      {
        key: 'google-calendar',
        warningCode: 'GOOGLE_CALENDAR_UNAVAILABLE',
        warning: 'Google Calendar is temporarily unavailable.',
        run: async () => {
          const events = await getGoogleEvents(start, end, userId);
          const items = (events || []).map((event: any) => {
            const startIso = safeIso(event.start);
            const minutesUntilStart = Math.round((new Date(startIso).getTime() - Date.now()) / 60_000);
            const isSoon = minutesUntilStart >= -30 && minutesUntilStart <= 120;
            return {
              kind: 'event' as const,
              id: `event:google:${event.id}`,
              title: event.summary || '(No title)',
              body: [toHumanDateTime(startIso), event.location].filter(Boolean).join(' • ') || null,
              type: isSoon ? 'event_starting_soon' : 'event_today',
              status: isSoon ? 'starting_soon' : 'upcoming',
              createdAt: startIso,
              source: 'google',
              priority: isSoon ? 'high' as const : 'medium' as const,
              action: 'view_event' as const,
              metadata: normalizeInboxMetadata({
                provider: 'google',
                eventId: event.id,
                start: startIso,
                end: safeIso(event.end, new Date(startIso)),
                location: event.location || null,
                htmlLink: event.htmlLink || null,
              }),
            };
          });
          return { items, unreadCount: 0 };
        },
      },
    );
  }

  const sourceTimeoutMs = getInboxSourceTimeoutMs();
  const results = await Promise.allSettled(fetchers.map((fetcher) =>
    runInboxSource({
      key: fetcher.key,
      userId,
      limit,
      timeoutMs: sourceTimeoutMs,
      run: fetcher.run,
    }),
  ));
  if (mailPreference.warningCode) {
    warningCodes.push(mailPreference.warningCode);
    warnings.push(mailPreference.warning || 'Preferred mail provider is unavailable.');
  }
  if (!outlookConnected && !googleConnected) {
    warningCodes.push('MAIL_INTEGRATION_MISSING');
    warnings.push('No mail integration is connected yet.');
    warningCodes.push('CALENDAR_INTEGRATION_MISSING');
    warnings.push('No calendar integration is connected yet.');
  }

  results.forEach((result, index) => {
    const fetcher = fetchers[index];
    if (result.status === 'fulfilled') {
      successCount += 1;
      items.push(...result.value.items);
      totalUnread += result.value.unreadCount;
    } else {
      warningCodes.push(fetcher.warningCode);
      warnings.push(fetcher.warning);
    }
  });

  const status: InboxStatus = warningCodes.length == 0
    ? 'ready'
    : successCount === 0
      ? 'unavailable'
      : 'degraded';

  const sortedItems = items
    .sort(compareInboxItems)
    .slice(0, limit);

  return {
    totalUnread,
    count: sortedItems.length,
    items: sortedItems,
    status,
    warningCodes,
    warnings,
  };
}

async function buildUnifiedInboxSummary(userId: number, tenantId: number): Promise<{
  unreadCount: number;
  warningCodes: string[];
  warnings: string[];
}> {
  const outlookConnected = isConnected(userId, 'outlook');
  const googleConnected = isConnected(userId, 'google');
  // Phase 17 hostile-QA fix (2026-05-18): pass real tenantId.
  const mailPreference = resolveMailReadPreference(userId, tenantId);
  const warningCodes: string[] = [];
  const warnings: string[] = [];
  let unreadCount = 0;

  try {
    const centerUnreadCount = await runInboxSource({
      key: 'decision-center',
      userId,
      timeoutMs: getInboxSummarySourceTimeoutMs(),
      run: async () => countUnreadNotificationCenterItems(userId, tenantId),
    });
    unreadCount += centerUnreadCount;
  } catch {
    warningCodes.push('DECISION_CENTER_UNAVAILABLE');
    warnings.push('Decision Center notifications are temporarily unavailable.');
  }

  const bridgedContentNotificationIds = bridgedEntityIdsForScope(userId, tenantId, 'content');
  const bridgedReportIds = bridgedEntityIdsForScope(userId, tenantId, 'report');

  const fetchers: Array<{
    key: string;
    warningCode: string;
    warning: string;
    run: () => Promise<number>;
  }> = [
    {
      key: 'notifications',
      warningCode: 'CONTENT_NOTIFICATIONS_UNAVAILABLE',
      warning: 'Content notifications are temporarily unavailable.',
      run: async () => getUnreadCountExcludingNotificationIds(userId, bridgedContentNotificationIds, tenantId),
    },
    {
      key: 'reports',
      warningCode: 'REPORTS_UNAVAILABLE',
      warning: 'Reports are temporarily unavailable.',
      run: async () => getUnreadReportCountExcludingIds(userId, bridgedReportIds),
    },
  ];

  if (mailPreference.sources.includes('outlook')) {
    fetchers.push({
      key: 'outlook-email',
      warningCode: 'OUTLOOK_MAIL_UNAVAILABLE',
      warning: 'Outlook mail is temporarily unavailable.',
      run: async () => {
        const { count } = await getOutlookUnreadEmailsForUser(userId, 1);
        return count || 0;
      },
    });
  }

  if (mailPreference.sources.includes('gmail')) {
    fetchers.push({
      key: 'gmail',
      warningCode: 'GMAIL_UNAVAILABLE',
      warning: 'Gmail is temporarily unavailable.',
        run: async () => countGmailEmailsForUser(userId, 'in:inbox is:unread newer_than:14d'),
    });
  }

  const sourceTimeoutMs = getInboxSummarySourceTimeoutMs();
  const results = await Promise.allSettled(fetchers.map((fetcher) =>
    runInboxSource({
      key: fetcher.key,
      userId,
      timeoutMs: sourceTimeoutMs,
      run: fetcher.run,
    }),
  ));
  if (mailPreference.warningCode) {
    warningCodes.push(mailPreference.warningCode);
    warnings.push(mailPreference.warning || 'Preferred mail provider is unavailable.');
  }
  if (!outlookConnected && !googleConnected) {
    warningCodes.push('MAIL_INTEGRATION_MISSING');
    warnings.push('No mail integration is connected yet.');
    warningCodes.push('CALENDAR_INTEGRATION_MISSING');
    warnings.push('No calendar integration is connected yet.');
  }

  results.forEach((result, index) => {
    const fetcher = fetchers[index];
    if (result.status === 'fulfilled') {
      unreadCount += result.value;
    } else {
      warningCodes.push(fetcher.warningCode);
      warnings.push(fetcher.warning);
    }
  });

  return { unreadCount, warningCodes, warnings };
}

/**
 * Content Notification Inbox — iOS API routes.
 *
 * These endpoints power the iOS notification center and the portal's
 * notification inspector. Notifications are durable — they survive
 * push delivery failures and are the system of record.
 *
 * Lifecycle:
 *   1. Content event creates notification (status='unread')
 *   2. APNs push sent as delivery hint
 *   3. iOS reads via GET /notifications
 *   4. User marks read via POST /notifications/:id/read
 *   5. User resolves via POST /notifications/:id/resolve
 */
export function notificationRoutes(): Router {
  const router = Router();

  /**
   * GET /api/v1/notifications
   *
   * List notifications for the authenticated user.
   * Query: ?status=unread (default: unread), ?type=topic_candidates_ready, ?limit=20
   */
  router.get('/', asyncHandler(async (req, res: Response) => {
    const authReq = req as unknown as AuthenticatedRequest;
    const { userId } = authReq;
    if (!ensureValidNotificationsRouteScope(res, userId, 'notifications_route_list')) return;
    const tenantId = routeTenantId(authReq, userId);
    const status = (req.query.status as NotificationStatus | undefined) || undefined;
    const type = (req.query.type as NotificationType | undefined) || undefined;
    const limit = parseInt(String(req.query.limit || '20'), 10);

    const notifications = status === undefined
      ? getNotifications(userId, { limit, tenantId })
      : getNotifications(userId, { status, type, limit, tenantId });

    const warnings: Array<{ code: string; message: string }> = [];
    let centerItems: NotificationCenterItem[] = [];
    let centerUnreadCount = 0;
    try {
      centerItems = listNotificationCenterItems(userId, tenantId, {
        status: (String(req.query.centerStatus || 'all') as NotificationCenterStatus | 'all'),
        limit,
      });
      centerUnreadCount = countUnreadNotificationCenterItems(userId, tenantId);
    } catch (err) {
      logger.warn(
        {
          event: 'notification_center_source_degraded',
          userId,
          tenantId,
          errorName: safeErrorName(err),
          errorCode: safeErrorCode(err),
        },
        'Decision Center source degraded for notifications list',
      );
      warnings.push({
        code: 'DECISION_CENTER_UNAVAILABLE',
        message: 'Decision Center notifications are temporarily unavailable.',
      });
    }
    sendSuccess(res, {
      unreadCount: centerUnreadCount,
      count: notifications.length,
      notifications: notifications.map((n: any) => ({
        id: n.id,
        type: n.type,
        title: n.title,
        body: n.body,
        data: n.data,
        status: n.status,
        createdAt: n.createdAt,
      })),
      items: centerItems.map(formatCenterItemForApi),
      warnings,
    });
  }));

  /**
   * POST /api/v1/notifications/intents
   *
   * Central write path for trusted skill runtimes. userId/tenantId are always
   * derived from authentication; forged body scope is ignored. The arbitrary
   * intent surface is internal-secret gated so iOS clients cannot fabricate
   * security/time-sensitive intents. Local fixture routes below remain the
   * deterministic external validation path.
   */
  router.post('/intents', asyncHandler(async (req, res: Response) => {
    const authReq = req as unknown as AuthenticatedRequest;
    const { userId } = authReq;
    if (!ensureValidNotificationsRouteScope(res, userId, 'notifications_route_create_intent')) return;
    if (!isInternalNotificationIntentRequest(authReq)) {
      sendError(res, 'FORBIDDEN', 'Notification intent creation requires an internal skill context', 403);
      return;
    }
    const tenantId = routeTenantId(authReq, userId);

    try {
      const body = req.body ?? {};
      const result = await createNotificationIntent({
        ...body,
        userId,
        tenantId,
      } as NotificationIntentInput);
      if (result.item) invalidateNotificationInboxCaches(userId, tenantId);
      sendSuccess(res, formatEvaluationForApi(result));
    } catch (err: any) {
      logger.warn({ err, userId }, 'Notification intent rejected');
      sendError(res, 'INVALID_NOTIFICATION_INTENT', 'Unable to create notification intent', 400);
    }
  }));

  /**
   * POST /api/v1/notifications/intents/fixtures/:sourceSkill
   *
   * Deterministic local/test path for skill integration validation. It still
   * uses the authenticated user's scope and the real orchestrator.
   */
  router.post('/intents/fixtures/:sourceSkill', asyncHandler(async (req, res: Response) => {
    const authReq = req as unknown as AuthenticatedRequest;
    const { userId } = authReq;
    if (!ensureValidNotificationsRouteScope(res, userId, 'notifications_route_fixture_intent')) return;
    const tenantId = routeTenantId(authReq, userId);
    const sourceSkill = String(req.params.sourceSkill || '') as NotificationSourceSkill;

    try {
      const fixture = buildSkillNotificationFixtureIntent(sourceSkill, userId, {
        ...(req.body ?? {}),
        tenantId,
      });
      const result = await createNotificationIntent(fixture);
      if (result.item) invalidateNotificationInboxCaches(userId, tenantId);
      sendSuccess(res, formatEvaluationForApi(result));
    } catch (err: any) {
      logger.warn({ err, userId, sourceSkill }, 'Notification fixture rejected');
      sendError(res, 'INVALID_NOTIFICATION_FIXTURE', 'Unable to create notification fixture', 400);
    }
  }));

  /**
   * GET /api/v1/notifications/decision-center
   */
  router.get('/decision-center', asyncHandler(async (req, res: Response) => {
    const authReq = req as unknown as AuthenticatedRequest;
    const { userId } = authReq;
    if (!ensureValidNotificationsRouteScope(res, userId, 'notifications_route_decision_center')) return;
    const tenantId = routeTenantId(authReq, userId);
    const status = String(req.query.status || 'all') as NotificationCenterStatus | 'all';
    const limit = parseInt(String(req.query.limit || '80'), 10);
    const items = listNotificationCenterItems(userId, tenantId, { status, limit });
    sendSuccess(res, {
      count: items.length,
      unreadCount: items.filter((item) => item.status === 'unread').length,
      sections: buildDecisionCenterSections(items),
      items: items.map(formatCenterItemForApi),
    });
  }));

  router.get('/preferences', asyncHandler(async (req, res: Response) => {
    const authReq = req as unknown as AuthenticatedRequest;
    const { userId } = authReq;
    if (!ensureValidNotificationsRouteScope(res, userId, 'notifications_route_get_preferences')) return;
    const tenantId = routeTenantId(authReq, userId);
    const profile = getOrCreateNotificationProfile(userId, tenantId);
    sendSuccess(res, { profile, reportSchedule: buildReportScheduleForApi(profile) });
  }));

  router.put('/preferences', asyncHandler(async (req, res: Response) => {
    const authReq = req as unknown as AuthenticatedRequest;
    const { userId } = authReq;
    if (!ensureValidNotificationsRouteScope(res, userId, 'notifications_route_update_preferences')) return;
    const tenantId = routeTenantId(authReq, userId);
    try {
      // `applied` / `rejected` exist because this endpoint used to answer 200
      // for fields it silently dropped — including five decision preferences
      // that are hardcoded literals on read, so a client could send `false`
      // and be told `true`. Invalid input still falls back rather than 400ing
      // (older iOS builds send fields this server never honoured), but the
      // caller is now told which of its writes actually landed.
      const { profile, applied, rejected } = applyNotificationProfilePatch(userId, tenantId, req.body ?? {});
      sendSuccess(res, {
        profile,
        reportSchedule: buildReportScheduleForApi(profile),
        applied,
        rejected,
      });
    } catch (err: any) {
      logger.warn({ err, userId }, 'Notification preferences rejected');
      sendError(res, 'INVALID_NOTIFICATION_PREFERENCES', 'Unable to update notification preferences', 400);
    }
  }));

  router.get('/reliability-dashboard', asyncHandler(async (req, res: Response) => {
    const authReq = req as unknown as AuthenticatedRequest;
    const { userId } = authReq;
    if (!ensureValidNotificationsRouteScope(res, userId, 'notifications_route_reliability_dashboard')) return;
    const tenantId = routeTenantId(authReq, userId);
    let canonicalUnreadCount: number | undefined;
    try {
      canonicalUnreadCount = (await buildUnifiedInboxSummary(userId, tenantId)).unreadCount;
    } catch (err) {
      logger.warn({ err, userId, tenantId }, 'Notification reliability dashboard badge baseline degraded');
    }
    sendSuccess(res, {
      dashboard: getNotificationReliabilityDashboard(userId, tenantId, {
        expectedBadgeCount: canonicalUnreadCount,
        canonicalUnreadCount,
      }),
    });
  }));

  router.post('/reliability-events', asyncHandler(async (req, res: Response) => {
    const authReq = req as unknown as AuthenticatedRequest;
    const { userId } = authReq;
    if (!ensureValidNotificationsRouteScope(res, userId, 'notifications_route_reliability_event')) return;
    const tenantId = routeTenantId(authReq, userId);
    const eventType = typeof req.body?.eventType === 'string' ? req.body.eventType : '';
    if (eventType !== 'badge_reconciled' && eventType !== 'read_state_failure') {
      sendError(res, 'VALIDATION', 'eventType must be badge_reconciled or read_state_failure', 400);
      return;
    }
    try {
      recordNotificationReliabilityEvent({
        userId,
        tenantId,
        eventType,
        badgeCount: Number.isInteger(req.body?.badgeCount) ? req.body.badgeCount : null,
        source: typeof req.body?.source === 'string' ? req.body.source : null,
        errorCode: typeof req.body?.errorCode === 'string' ? req.body.errorCode : null,
      });
      sendSuccess(res, { recorded: true });
    } catch (err) {
      logger.warn({ err, userId, tenantId, eventType }, 'Notification reliability event rejected');
      sendError(res, 'INVALID_NOTIFICATION_RELIABILITY_EVENT', 'Unable to record notification reliability event', 400);
    }
  }));

  router.post('/device-tokens', asyncHandler(async (req, res: Response) => {
    const authReq = req as unknown as AuthenticatedRequest;
    const { userId } = authReq;
    if (!ensureValidNotificationsRouteScope(res, userId, 'notifications_route_register_device_token')) return;
    const tenantId = routeTenantId(authReq, userId);
    try {
      const token = registerNotificationDeviceToken({
        userId,
        tenantId,
        token: String(req.body?.token || ''),
        environment: req.body?.environment === 'production' ? 'production' : 'sandbox',
        // Device ownership comes from the signed iOS session, never the body.
        // A caller-chosen id could re-associate another user's known device
        // and revoke that user's push rows in the cross-login cleanup below.
        deviceId: authReq.deviceId,
        appVersion: typeof req.body?.appVersion === 'string' ? req.body.appVersion : null,
        // Advisory: the client reports where the DEVICE is, the server never
        // shifts the profile on its own. See migration 271.
        deviceTimezone: typeof req.body?.timezone === 'string' ? req.body.timezone : null,
        // What iOS actually granted. Absent means a full grant, which is what
        // every token minted before this field existed represents.
        authorizationTier: typeof req.body?.authorizationTier === 'string' ? req.body.authorizationTier : null,
      });
      sendSuccess(res, {
        token: {
          tokenId: token.tokenId,
          platform: token.platform,
          environment: token.environment,
          tokenSuffix: token.tokenSuffix,
          deviceId: token.deviceId,
          lastSeenAt: token.lastSeenAt,
        },
        // Returned so the client can offer the change in context — "you're in
        // New York, move your brief?" — instead of the server silently moving
        // every scheduled notification.
        timezoneDrift: notificationTimezoneDrift(userId, tenantId),
        reachability: notificationReachability(userId, tenantId),
      });
    } catch (err: any) {
      logger.warn({ err, userId }, 'Notification device token rejected');
      sendError(res, 'INVALID_DEVICE_TOKEN', 'Unable to register notification device token', 400);
    }
  }));

  router.delete('/device-tokens/:tokenId', asyncHandler(async (req, res: Response) => {
    const authReq = req as unknown as AuthenticatedRequest;
    const { userId } = authReq;
    if (!ensureValidNotificationsRouteScope(res, userId, 'notifications_route_revoke_device_token')) return;
    const tenantId = routeTenantId(authReq, userId);
    const revoked = revokeNotificationDeviceToken(String(req.params.tokenId || ''), userId, tenantId);
    sendSuccess(res, { revoked });
  }));

  router.get('/decision-logs/:id', asyncHandler(async (req, res: Response) => {
    const authReq = req as unknown as AuthenticatedRequest;
    const { userId } = authReq;
    if (!ensureValidNotificationsRouteScope(res, userId, 'notifications_route_decision_log')) return;
    const tenantId = routeTenantId(authReq, userId);
    const log = getNotificationDecisionLog(String(req.params.id || ''), userId, tenantId);
    if (!log) {
      sendError(res, 'NOT_FOUND', 'Notification decision log not found', 404);
      return;
    }
    sendSuccess(res, { log });
  }));

  router.patch('/:id/read', asyncHandler(async (req, res: Response) => {
    const authReq = req as unknown as AuthenticatedRequest;
    const { userId } = authReq;
    if (!ensureValidNotificationsRouteScope(res, userId, 'notifications_route_center_mark_read')) return;
    const tenantId = routeTenantId(authReq, userId);
    const item = markNotificationCenterItemRead(String(req.params.id || ''), userId, tenantId);
    if (!item) {
      sendError(res, 'NOT_FOUND', 'Notification not found', 404);
      return;
    }
    invalidateNotificationInboxCaches(userId, tenantId);
    sendSuccess(res, { item: formatCenterItemForApi(item) });
  }));

  router.patch('/:id/dismiss', asyncHandler(async (req, res: Response) => {
    const authReq = req as unknown as AuthenticatedRequest;
    const { userId } = authReq;
    if (!ensureValidNotificationsRouteScope(res, userId, 'notifications_route_center_dismiss')) return;
    const tenantId = routeTenantId(authReq, userId);
    const item = dismissNotificationCenterItem(String(req.params.id || ''), userId, tenantId);
    if (!item) {
      sendError(res, 'NOT_FOUND', 'Notification not found', 404);
      return;
    }
    invalidateNotificationInboxCaches(userId, tenantId);
    sendSuccess(res, { item: formatCenterItemForApi(item) });
  }));

  router.post('/:id/actions', asyncHandler(async (req, res: Response) => {
    const authReq = req as unknown as AuthenticatedRequest;
    const { userId } = authReq;
    if (!ensureValidNotificationsRouteScope(res, userId, 'notifications_route_center_action')) return;
    const tenantId = routeTenantId(authReq, userId);
    const itemId = String(req.params.id || '');
    const actionId = String(req.body?.actionId || '');
    try {
      const decision = getDecisionItem(itemId, userId, tenantId);
      if (decision) {
        const result = await performDecisionAction(itemId, actionId, userId, tenantId, {
          idempotencyKey: typeof req.body?.idempotencyKey === 'string' ? req.body.idempotencyKey : undefined,
          payload: typeof req.body?.payload === 'object' && req.body.payload ? req.body.payload : {},
          channel: typeof req.body?.channel === 'string' ? req.body.channel : undefined,
        });
        invalidateNotificationInboxCaches(userId, tenantId);
        sendSuccess(res, result);
        return;
      }

      // `snoozedUntil` lets the client offer "remind me at…" instead of the
      // fixed hour. The orchestrator clamps it to [5m, 7d]; an unparseable
      // value falls back to the default rather than erroring, because the
      // lock-screen button has nowhere to render a validation failure.
      const result = performNotificationAction(itemId, actionId, userId, tenantId, {
        snoozedUntil: typeof req.body?.snoozedUntil === 'string' ? req.body.snoozedUntil : undefined,
      });
      invalidateNotificationInboxCaches(userId, tenantId);
      sendSuccess(res, {
        actionId: result.actionId,
        idempotent: result.idempotent,
        item: formatCenterItemForApi(result.item),
      });
    } catch (err: any) {
      if (err instanceof DecisionActionError) {
        sendError(res, err.code, err.message, err.status, err.details);
        return;
      }
      logger.warn({ err, userId }, 'Notification action rejected');
      sendError(res, 'INVALID_NOTIFICATION_ACTION', 'Unable to apply notification action', 400);
    }
  }));

  /**
   * GET /api/v1/notifications/inbox
   *
   * Unified secretary workspace feed:
   *   reports + content notifications + unread email + attention tasks + today's events
   *
   * Ordered by urgency first, recency second.
   */
  router.get('/inbox', asyncHandler(async (req, res: Response) => {
    const authReq = req as unknown as AuthenticatedRequest;
    const { userId } = authReq;
    const tenantId = routeTenantId(authReq, userId);
    if (!ensureValidNotificationsRouteScope(res, userId, 'notifications_route_inbox')) return;
    const limit = parseInt(String(req.query.limit || '30'), 10);
    const cacheKey = routeCacheKey('unified-inbox', userId, 'tenant', tenantId, limit);
    await handleCachedRoute<any>({
      cacheKey,
      ttlSeconds: INBOX_CACHE_TTL,
      staleSeconds: INBOX_SWR_STALE,
      refreshContext: { source: 'notifications_route', operation: 'inbox_swr_refresh', userId },
      fetchFresh: () => buildUnifiedInbox(userId, tenantId, limit),
      send: (inbox, meta) => sendSuccess(res, inbox, { cached: meta.cached }),
    });
  }));

  /**
   * GET /api/v1/notifications/inbox/email?provider=&id=
   *
   * Read-only email detail for the unified iOS inbox.
   * This keeps the inbox honest without pretending the app is a full mail client yet.
   */
  router.get('/inbox/email', asyncHandler(async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    if (!ensureValidNotificationsRouteScope(res, userId, 'notifications_route_inbox_email')) return;
    const provider = String(req.query.provider || '').toLowerCase();
    const messageId = String(req.query.id || '');

    if (!messageId || !['outlook', 'gmail', 'google'].includes(provider)) {
      sendError(res, 'INVALID_INBOX_EMAIL_REQUEST', 'provider and id are required', 400);
      return;
    }

    let email: any;
    if (provider === 'outlook') {
      email = await readOutlookEmailForUser(userId, messageId);
    } else {
      email = await readGmailEmailForUser(userId, messageId);
    }

    sendSuccess(res, {
      email: {
        provider: provider === 'google' ? 'gmail' : provider,
        id: messageId,
        subject: email.subject || '(No subject)',
        from: email.from || '',
        to: email.to || '',
        snippet: email.snippet || '',
        body: email.body || '',
        date: safeIso(email.date),
      },
    });
  }));

  /**
   * GET /api/v1/notifications/unread-count
   *
   * Unified unread count for the Home bell badge.
   */
  router.get('/unread-count', asyncHandler(async (req, res: Response) => {
    const authReq = req as unknown as AuthenticatedRequest;
    const { userId } = authReq;
    const tenantId = routeTenantId(authReq, userId);
    if (!ensureValidNotificationsRouteScope(res, userId, 'notifications_route_unread_count')) return;
    const cacheKey = routeCacheKey('unified-inbox-unread', userId, 'tenant', tenantId);
    await handleCachedRoute<{ unreadCount: number; warningCodes: string[]; warnings: string[] }>({
      cacheKey,
      ttlSeconds: INBOX_SUMMARY_CACHE_TTL,
      staleSeconds: INBOX_SUMMARY_SWR_STALE,
      refreshContext: { source: 'notifications_route', operation: 'inbox_swr_refresh', userId },
      fetchFresh: () => buildUnifiedInboxSummary(userId, tenantId),
      send: (summary, meta) => sendSuccess(res, summary, { cached: meta.cached }),
    });
  }));

  /**
   * POST /api/v1/notifications/:id/read
   *
   * Mark a notification as read.
   */
  router.post('/:id/read', asyncHandler(async (req, res: Response) => {
    const authReq = req as unknown as AuthenticatedRequest;
    const { userId } = authReq;
    if (!ensureValidNotificationsRouteScope(res, userId, 'notifications_route_mark_read', { notificationId: req.params.id })) return;
    const tenantId = routeTenantId(authReq, userId);
    const { id } = req.params;
    const success = markRead(parseInt(id, 10), userId, tenantId);
    if (!success) {
      sendError(res, 'NOT_FOUND', 'Notification not found', 404);
      return;
    }
    invalidateNotificationInboxCaches(userId, tenantId);
    sendSuccess(res, { marked: true });
  }));

  /**
   * POST /api/v1/notifications/read-all
   *
   * Mark all unread notifications as read.
   */
  router.post('/read-all', asyncHandler(async (req, res: Response) => {
    const authReq = req as unknown as AuthenticatedRequest;
    const { userId } = authReq;
    if (!ensureValidNotificationsRouteScope(res, userId, 'notifications_route_mark_all_read')) return;
    const tenantId = routeTenantId(authReq, userId);
    const count = markAllRead(userId, tenantId);
    invalidateNotificationInboxCaches(userId, tenantId);
    sendSuccess(res, { markedCount: count });
  }));

  /**
   * POST /api/v1/notifications/:id/resolve
   *
   * Resolve a notification (action completed).
   */
  router.post('/:id/resolve', asyncHandler(async (req, res: Response) => {
    const authReq = req as unknown as AuthenticatedRequest;
    const { userId } = authReq;
    if (!ensureValidNotificationsRouteScope(res, userId, 'notifications_route_resolve', { notificationId: req.params.id })) return;
    const tenantId = routeTenantId(authReq, userId);
    const { id } = req.params;
    const success = resolveNotification(parseInt(id, 10), userId, tenantId);
    if (!success) {
      sendError(res, 'NOT_FOUND', 'Notification not found', 404);
      return;
    }
    invalidateNotificationInboxCaches(userId, tenantId);
    sendSuccess(res, { resolved: true });
  }));

  return router;
}
