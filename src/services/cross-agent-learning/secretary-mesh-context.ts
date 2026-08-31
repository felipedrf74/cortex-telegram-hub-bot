// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/** Deterministic Secretary mesh adapter. */

import { DateTime } from 'luxon';
import { getFocusBlockRecommendation } from '../focus-planner';
import { getPendingTasks } from '../task-store/unified-task-store';
import type { NormalizedTask } from '../task-store/types';
import { getEvents, hasWritableCalendarForUser, type UnifiedCalendarEvent } from '../unified-calendar';
import { getUnreadMailSummaryForUser } from '../unified-mail-pressure';
import { isValidTenantUserId } from '../tenant-scope-observability';
import type { MeshSignalDraft, SecretaryMeshContext } from './types';
import {
  endOfDayIso,
  extractTravelDates,
  reportInvalidMeshScope,
  resolveWeekWindow,
  roundTo,
  safely,
  summarizeBusyDates,
  summarizeCalendarFragmentation,
  uniqueStrings,
} from './mesh-common';

export function createEmptySecretaryMeshContext(opts: { userId: number; weekStart?: string; timezone?: string }): SecretaryMeshContext {
  const window = resolveWeekWindow(opts.weekStart, opts.timezone);
  return {
    userId: opts.userId,
    weekStart: window.weekStart,
    weekEnd: window.weekEnd,
    events: [],
    focusBlock: null,
    dueToday: [],
    dueThisWeek: [],
    overdue: [],
    pending: [],
    writableCalendar: false,
    derivedSignals: [],
  };
}
export async function readSecretaryMeshContext(opts: {
  userId: number;
  tenantId?: number;
  weekStart?: string;
  timezone?: string;
}): Promise<SecretaryMeshContext> {
  if (!isValidTenantUserId(opts.userId)) {
    reportInvalidMeshScope('read_secretary_mesh_context', opts.userId, opts.weekStart);
    return createEmptySecretaryMeshContext(opts);
  }

  const window = resolveWeekWindow(opts.weekStart, opts.timezone);
  const tenantId = opts.tenantId ?? opts.userId;
  const timezone = window.start.zoneName ?? opts.timezone ?? 'UTC';
  const [eventsResult, focusResult, mailPressureResult] = await Promise.allSettled([
    getEvents(window.start.toUTC().toISO()!, window.end.endOf('day').toUTC().toISO()!, opts.userId),
    opts.tenantId == null
      ? Promise.resolve(null)
      : getFocusBlockRecommendation(opts.userId, { tenantId: opts.tenantId, horizonDays: 7 }),
    getUnreadMailSummaryForUser(opts.userId),
  ]);

  const events = eventsResult.status === 'fulfilled' ? eventsResult.value : [];
  const focusBlock = focusResult.status === 'fulfilled' ? focusResult.value : null;
  const mailPressure = mailPressureResult.status === 'fulfilled' ? mailPressureResult.value : null;
  const pending = safely(() => getPendingTasks(opts.userId, tenantId), []);
  const today = DateTime.now().setZone(timezone).toISODate()!;
  const dueToday = pending.filter((task) => taskDueDateInZone(task.dueDate, timezone) === today);
  const dueThisWeekStart = today > window.weekStart ? today : window.weekStart;
  const dueThisWeek = pending.filter((task) => {
    const dueDate = taskDueDateInZone(task.dueDate, timezone);
    return dueDate != null && dueDate >= dueThisWeekStart && dueDate <= window.weekEnd;
  });
  const overdue = pending.filter((task) => {
    const dueDate = taskDueDateInZone(task.dueDate, timezone);
    return dueDate != null && dueDate < today;
  });
  const writableCalendar = safely(() => hasWritableCalendarForUser(opts.userId), false);

  const busyDates = summarizeBusyDates(events, timezone);
  const travelDates = extractTravelDates(events, timezone);
  const fragmentation = summarizeCalendarFragmentation(events, timezone);
  const criticalMeetings = summarizeMeetingCriticality(events, timezone);
  const portability = summarizeTaskPortability(pending);
  const deadlinePressure = summarizeDeadlinePressure({
    overdueCount: overdue.length,
    dueTodayCount: dueToday.length,
    dueThisWeekCount: dueThisWeek.length,
    pendingCount: pending.length,
    mailUnreadTotal: mailPressure?.totalUnread ?? 0,
  });
  const derivedSignals: MeshSignalDraft[] = [];

  if (busyDates.length > 0) {
    derivedSignals.push({
      sourceAgent: 'mesh.secretary-context',
      signalType: 'calendar_busy_blocks',
      meshPriority: 1,
      priority: 'urgent',
      expiresAt: endOfDayIso(window.end),
      payload: {
        dates: busyDates,
        totalEvents: events.length,
      },
    });
  }

  if (travelDates.length > 0) {
    derivedSignals.push({
      sourceAgent: 'mesh.secretary-context',
      signalType: 'travel_window',
      meshPriority: 1,
      priority: 'urgent',
      expiresAt: endOfDayIso(window.end),
      payload: {
        dates: travelDates,
      },
    });
  }

  derivedSignals.push({
    sourceAgent: 'mesh.secretary-context',
    signalType: 'inbox_pressure',
    meshPriority: deadlinePressure.level === 'high' ? 2 : 4,
    priority: deadlinePressure.level === 'high' ? 'urgent' : overdue.length > 0 ? 'normal' : 'background',
    expiresAt: endOfDayIso(window.start),
    payload: {
      overdueCount: overdue.length,
      dueTodayCount: dueToday.length,
      dueThisWeekCount: dueThisWeek.length,
      pendingCount: pending.length,
      mailUnreadTotal: mailPressure?.totalUnread ?? 0,
      mailProviders: mailPressure?.configuredProviders ?? [],
      outlookUnread: mailPressure?.outlookUnread ?? null,
      gmailUnread: mailPressure?.gmailUnread ?? null,
    },
  });

  if (fragmentation.fragmentedDates.length > 0) {
    derivedSignals.push({
      sourceAgent: 'mesh.secretary-context',
      signalType: 'calendar_fragmentation',
      meshPriority: 2,
      priority: 'normal',
      expiresAt: endOfDayIso(window.end),
      payload: {
        dates: fragmentation.fragmentedDates,
        fragmentedDayCount: fragmentation.fragmentedDates.length,
        maxEventsInDay: fragmentation.maxEventsInDay,
      },
    });
  }

  if (criticalMeetings.criticalEventCount > 0) {
    derivedSignals.push({
      sourceAgent: 'mesh.secretary-context',
      signalType: 'meeting_criticality',
      meshPriority: 2,
      priority: 'normal',
      expiresAt: endOfDayIso(window.end),
      payload: {
        criticalEventCount: criticalMeetings.criticalEventCount,
        dates: criticalMeetings.dates,
        examples: criticalMeetings.examples,
      },
    });
  }

  if (deadlinePressure.level !== 'low') {
    derivedSignals.push({
      sourceAgent: 'mesh.secretary-context',
      signalType: 'deadline_pressure',
      meshPriority: deadlinePressure.level === 'high' ? 1 : 2,
      priority: deadlinePressure.level === 'high' ? 'urgent' : 'normal',
      expiresAt: endOfDayIso(window.start),
      payload: deadlinePressure,
    });
  }

  if (portability.fixedCount > 0 || portability.portableCount > 0) {
    derivedSignals.push({
      sourceAgent: 'mesh.secretary-context',
      signalType: 'task_portability',
      meshPriority: 3,
      priority: 'background',
      expiresAt: endOfDayIso(window.start),
      payload: portability,
    });
  }

  return {
    userId: opts.userId,
    weekStart: window.weekStart,
    weekEnd: window.weekEnd,
    events,
    focusBlock,
    dueToday,
    dueThisWeek,
    overdue,
    pending,
    writableCalendar,
    mailPressure,
    derivedSignals,
  };
}

function taskDueDateInZone(value: string | null | undefined, timezone?: string): string | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const parsed = DateTime.fromISO(raw, { setZone: true, zone: timezone ?? 'UTC' });
  if (!parsed.isValid) return null;
  return parsed.setZone(timezone ?? 'UTC').toISODate();
}

function summarizeMeetingCriticality(events: UnifiedCalendarEvent[], timezone: string): {
  criticalEventCount: number;
  dates: string[];
  examples: string[];
} {
  const regex = /\b(client|cliente|interview|entrevista|doctor|m[eé]dico|meeting|reuni[aã]o|call|sponsor|patroc[ií]nio|filming|shoot|flight|voo|deadline)\b/i;
  const critical = events.filter((event) => regex.test(String(event.summary ?? '')));
  return {
    criticalEventCount: critical.length,
    dates: uniqueStrings(critical
      .map((event) => taskDueDateInZone(event.start, timezone))
      .filter((date): date is string => Boolean(date))),
    examples: critical
      .slice(0, 3)
      .map((event) => String(event.summary ?? '').trim())
      .filter(Boolean),
  };
}

function summarizeTaskPortability(tasks: NormalizedTask[]): {
  fixedCount: number;
  portableCount: number;
  portableRatio: number;
} {
  const fixedCount = tasks.filter((task) => Boolean(task.dueDate)).length;
  const portableCount = Math.max(0, tasks.length - fixedCount);
  const portableRatio = tasks.length > 0 ? roundTo(portableCount / tasks.length, 2) : 0;
  return { fixedCount, portableCount, portableRatio };
}

function summarizeDeadlinePressure(opts: {
  overdueCount: number;
  dueTodayCount: number;
  dueThisWeekCount: number;
  pendingCount: number;
  mailUnreadTotal: number;
}): {
  level: 'low' | 'elevated' | 'high';
  overdueCount: number;
  dueTodayCount: number;
  dueThisWeekCount: number;
  pendingCount: number;
  mailUnreadTotal: number;
} {
  const level = opts.overdueCount > 0
    || opts.dueTodayCount >= 3
    || opts.mailUnreadTotal >= 20
    ? 'high'
    : opts.dueTodayCount > 0 || opts.dueThisWeekCount >= 4 || opts.mailUnreadTotal >= 8
      ? 'elevated'
      : 'low';
  return {
    level,
    overdueCount: opts.overdueCount,
    dueTodayCount: opts.dueTodayCount,
    dueThisWeekCount: opts.dueThisWeekCount,
    pendingCount: opts.pendingCount,
    mailUnreadTotal: opts.mailUnreadTotal,
  };
}
