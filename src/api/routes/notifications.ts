// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Router, Response } from 'express';
import { DateTime } from 'luxon';
import { AuthenticatedRequest } from '../auth-middleware';
import { sendSuccess, sendError, asyncHandler } from '../response-helpers';
import {
  getNotifications,
  getUnreadCount,
  markAllRead,
  markRead,
  resolveNotification,
  type NotificationStatus,
  type NotificationType,
} from '../../services/content-notification-store';
import { getRecentReports, getUnreadReportCount } from '../../services/report-document-store';
import { isConnected } from '../../services/oauth-store';
import { getUnreadEmailsForUser as getOutlookUnreadEmailsForUser, readEmailForUser as readOutlookEmailForUser } from '../../services/outlook-mail';
import {
  searchEmailsForUser as searchGmailEmailsForUser,
  readEmailForUser as readGmailEmailForUser,
  countEmailsForUser as countGmailEmailsForUser,
} from '../../services/google-gmail';
import { getEvents as getOutlookEvents } from '../../services/outlook-calendar';
import { getEvents as getGoogleEvents } from '../../services/google-calendar';
import { getCachedSWR, setCacheSWR } from '../../services/cache-store';
import { logger } from '../../utils/logger';
import { config } from '../../config';
import { AITimeoutError, withTimeout } from '../../utils/timeout';
import { isValidTenantUserId, recordTenantScopeAnomaly } from '../../services/tenant-scope-observability';
import { listTasks } from '../../services/task-store/task-service';
import type { NormalizedTask } from '../../services/task-store/types';
import { recordSWRRefreshFailure, recordSWRRefreshSuccess } from '../../services/swr-refresh-observability';

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
const inboxSWRInFlight = new Set<string>();

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

function reportInvalidNotificationsRouteScope(
  operation: string,
  userId: number | undefined,
  details?: Record<string, unknown>,
): void {
  recordTenantScopeAnomaly({
    layer: 'delivery',
    operation,
    reason: 'invalid_user_scope',
    userId: typeof userId === 'number' ? userId : null,
    details,
  });
}

function ensureValidNotificationsRouteScope(
  res: Response,
  userId: number | undefined,
  operation: string,
  details?: Record<string, unknown>,
): userId is number {
  if (isValidTenantUserId(userId)) return true;
  reportInvalidNotificationsRouteScope(operation, userId, details);
  sendError(res, 'UNAUTHORIZED', 'Invalid authenticated user scope', 401);
  return false;
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
  if (task.priority >= 3) return 'high';
  if (task.priority === 2) return 'medium';
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

function swrRefresh(key: string, fn: () => Promise<void>): void {
  if (inboxSWRInFlight.has(key)) return;
  inboxSWRInFlight.add(key);
  fn()
    .then(() => recordSWRRefreshSuccess(key))
    .catch((err) => recordSWRRefreshFailure(key, err, { source: 'notifications_route', operation: 'inbox_swr_refresh' }))
    .finally(() => inboxSWRInFlight.delete(key));
}

async function buildUnifiedInbox(userId: number, limit: number): Promise<{
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
        const notifications = getNotifications(userId, { limit });
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
          metadata: n.data || {},
        }));
        return { items, unreadCount: getUnreadCount(userId) };
      },
    },
    {
      key: 'reports',
      warningCode: 'REPORTS_UNAVAILABLE',
      warning: 'Reports are temporarily unavailable.',
      run: async () => {
        const reports = getRecentReports(userId, { limit });
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
          metadata: { sourceJob: r.sourceJob || null },
        }));
        return { items, unreadCount: getUnreadReportCount(userId) };
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
              metadata: {
                taskId,
                dueDateTime: dueIso,
                listId: task.projectId || null,
                listName: task.projectName || null,
                importance: task.priority >= 3 ? 'high' : task.priority === 1 ? 'low' : 'normal',
              },
            };
          })
          .sort(compareInboxItems)
          .slice(0, Math.max(4, Math.ceil(limit / 2)));

        return { items, unreadCount: 0 };
      },
    },
  ];

  if (outlookConnected) {
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
            metadata: {
              provider: 'outlook',
              providerMessageId: email.id,
              from: email.from || null,
              to: email.to || null,
              importance: email.importance || 'normal',
            },
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
              metadata: {
                provider: 'outlook',
                eventId: event.id,
                start: startIso,
                end: safeIso(event.end, new Date(startIso)),
                location: event.location || null,
                htmlLink: event.htmlLink || null,
              },
            };
          });
          return { items, unreadCount: 0 };
        },
      },
    );
  }

  if (googleConnected) {
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
            metadata: {
              provider: 'gmail',
              providerMessageId: email.id,
              from: email.from || null,
              to: email.to || null,
              importance: 'normal',
            },
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
              metadata: {
                provider: 'google',
                eventId: event.id,
                start: startIso,
                end: safeIso(event.end, new Date(startIso)),
                location: event.location || null,
                htmlLink: event.htmlLink || null,
              },
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
  const warningCodes: string[] = [];
  const warnings: string[] = [];
  if (!outlookConnected && !googleConnected) {
    warningCodes.push('MAIL_INTEGRATION_MISSING');
    warnings.push('No mail integration is connected yet.');
    warningCodes.push('CALENDAR_INTEGRATION_MISSING');
    warnings.push('No calendar integration is connected yet.');
  }
  const items: UnifiedInboxItem[] = [];
  let totalUnread = 0;
  let successCount = 0;

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

async function buildUnifiedInboxSummary(userId: number): Promise<{
  unreadCount: number;
  warningCodes: string[];
  warnings: string[];
}> {
  const outlookConnected = isConnected(userId, 'outlook');
  const googleConnected = isConnected(userId, 'google');
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
      run: async () => getUnreadCount(userId),
    },
    {
      key: 'reports',
      warningCode: 'REPORTS_UNAVAILABLE',
      warning: 'Reports are temporarily unavailable.',
      run: async () => getUnreadReportCount(userId),
    },
  ];

  if (outlookConnected) {
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

  if (googleConnected) {
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
  const warningCodes: string[] = [];
  const warnings: string[] = [];
  if (!outlookConnected && !googleConnected) {
    warningCodes.push('MAIL_INTEGRATION_MISSING');
    warnings.push('No mail integration is connected yet.');
    warningCodes.push('CALENDAR_INTEGRATION_MISSING');
    warnings.push('No calendar integration is connected yet.');
  }
  let unreadCount = 0;

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
    const { userId } = req as unknown as AuthenticatedRequest;
    if (!ensureValidNotificationsRouteScope(res, userId, 'notifications_route_list')) return;
    const status = (req.query.status as NotificationStatus | undefined) || undefined;
    const type = (req.query.type as NotificationType | undefined) || undefined;
    const limit = parseInt(String(req.query.limit || '20'), 10);

    const notifications = status === undefined
      ? getNotifications(userId, { limit })
      : getNotifications(userId, { status, type, limit });

    const unreadCount = getUnreadCount(userId);

    sendSuccess(res, {
      unreadCount,
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
    });
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
    const { userId } = req as unknown as AuthenticatedRequest;
    if (!ensureValidNotificationsRouteScope(res, userId, 'notifications_route_inbox')) return;
    const limit = parseInt(String(req.query.limit || '30'), 10);
    const cacheKey = `unified-inbox:${userId}:${limit}`;
    const cached = getCachedSWR<any>(cacheKey);

    if (cached) {
      sendSuccess(res, cached.value, { cached: true });

      if (!cached.fresh) {
        swrRefresh(cacheKey, async () => {
          const refreshed = await buildUnifiedInbox(userId, limit);
          setCacheSWR(cacheKey, refreshed, INBOX_CACHE_TTL, INBOX_SWR_STALE);
        });
      }
      return;
    }

    const inbox = await buildUnifiedInbox(userId, limit);
    setCacheSWR(cacheKey, inbox, INBOX_CACHE_TTL, INBOX_SWR_STALE);
    sendSuccess(res, inbox);
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
    const { userId } = req as unknown as AuthenticatedRequest;
    if (!ensureValidNotificationsRouteScope(res, userId, 'notifications_route_unread_count')) return;
    const cacheKey = `unified-inbox-unread:${userId}`;
    const cached = getCachedSWR<{ unreadCount: number; warningCodes: string[]; warnings: string[] }>(cacheKey);

    if (cached) {
      sendSuccess(res, cached.value, { cached: true });

      if (!cached.fresh) {
        swrRefresh(cacheKey, async () => {
          const refreshed = await buildUnifiedInboxSummary(userId);
          setCacheSWR(cacheKey, refreshed, INBOX_SUMMARY_CACHE_TTL, INBOX_SUMMARY_SWR_STALE);
        });
      }
      return;
    }

    const summary = await buildUnifiedInboxSummary(userId);
    setCacheSWR(cacheKey, summary, INBOX_SUMMARY_CACHE_TTL, INBOX_SUMMARY_SWR_STALE);
    sendSuccess(res, summary);
  }));

  /**
   * POST /api/v1/notifications/:id/read
   *
   * Mark a notification as read.
   */
  router.post('/:id/read', asyncHandler(async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    if (!ensureValidNotificationsRouteScope(res, userId, 'notifications_route_mark_read', { notificationId: req.params.id })) return;
    const { id } = req.params;
    const success = markRead(parseInt(id, 10), userId);
    if (!success) {
      sendError(res, 'NOT_FOUND', 'Notification not found', 404);
      return;
    }
    sendSuccess(res, { marked: true });
  }));

  /**
   * POST /api/v1/notifications/read-all
   *
   * Mark all unread notifications as read.
   */
  router.post('/read-all', asyncHandler(async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    if (!ensureValidNotificationsRouteScope(res, userId, 'notifications_route_mark_all_read')) return;
    const count = markAllRead(userId);
    sendSuccess(res, { markedCount: count });
  }));

  /**
   * POST /api/v1/notifications/:id/resolve
   *
   * Resolve a notification (action completed).
   */
  router.post('/:id/resolve', asyncHandler(async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    if (!ensureValidNotificationsRouteScope(res, userId, 'notifications_route_resolve', { notificationId: req.params.id })) return;
    const { id } = req.params;
    const success = resolveNotification(parseInt(id, 10), userId);
    if (!success) {
      sendError(res, 'NOT_FOUND', 'Notification not found', 404);
      return;
    }
    sendSuccess(res, { resolved: true });
  }));

  return router;
}
