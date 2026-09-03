// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { DateTime } from 'luxon';
import {
  listSecretaryAgendaItems,
  type SecretaryAgendaItem,
} from './secretary-scheduling-arbitrator';
import {
  getSecretaryRoutineProfile,
  type SecretaryProtectedRoutine,
} from './secretary-routine-profile';
import type { CalendarSource, UnifiedCalendarEvent } from './unified-calendar';

export type SecretaryLocalCalendarConflictKind = 'agenda' | 'protected_routine';

export interface SecretaryLocalCalendarConflict {
  id: string;
  title: string;
  start: string;
  end: string;
  kind: SecretaryLocalCalendarConflictKind;
  providerEventId: string | null;
  providerSource: CalendarSource | null;
}

export type SecretaryLocalCalendarConflictSnapshot =
  | { status: 'ready'; conflicts: SecretaryLocalCalendarConflict[]; warningCodes: [] }
  | { status: 'unavailable'; conflicts: []; warningCodes: string[] };

export interface ReadSecretaryLocalCalendarConflictsInput {
  userId: number;
  tenantId: string | number;
  start: string;
  end: string;
  excludeAgendaItemId?: string | null;
  excludeSourceIntentId?: string | null;
}

/**
 * Reads Secretary-owned calendar commitments without touching any provider.
 * Calendar command services use this beside their provider snapshot so an
 * unsynchronized agenda item or protected routine can never be mistaken for
 * free time. Any unreadable or DST-unresolvable state fails closed.
 */
export function readSecretaryLocalCalendarConflicts(
  input: ReadSecretaryLocalCalendarConflictsInput,
): SecretaryLocalCalendarConflictSnapshot {
  const tenantId = normalizeScope(input.userId, input.tenantId);
  const range = normalizeRange(input.start, input.end);
  try {
    const agendaConflicts = listSecretaryAgendaItems({
      ownerUserId: input.userId,
      tenantId,
    })
      .filter((item) => ['scheduled', 'synced', 'reflowed', 'compressed', 'failed_sync']
        .includes(item.lifecycleState))
      .filter((item) => item.agendaItemId !== input.excludeAgendaItemId)
      .filter((item) => item.sourceIntentId !== input.excludeSourceIntentId)
      .flatMap(projectAgendaItem)
      .filter((conflict) => overlaps(range.start, range.end, conflict.start, conflict.end));

    const profile = getSecretaryRoutineProfile({
      userId: input.userId,
      tenantId: Number(tenantId),
    });
    const routineExpansion = profile.status === 'configured'
      ? expandProtectedRoutines(profile.protectedRoutines, range.start, range.end, profile.timezone)
      : { conflicts: [] as SecretaryLocalCalendarConflict[], unresolvedDst: false };
    if (routineExpansion.unresolvedDst) {
      return {
        status: 'unavailable',
        conflicts: [],
        warningCodes: [
          'CALENDAR_CONFLICT_STATE_UNKNOWN',
          'SECRETARY_PROTECTED_ROUTINE_DST_UNRESOLVED',
        ],
      };
    }
    return {
      status: 'ready',
      conflicts: dedupeLocalConflicts([...agendaConflicts, ...routineExpansion.conflicts]),
      warningCodes: [],
    };
  } catch {
    return {
      status: 'unavailable',
      conflicts: [],
      warningCodes: [
        'CALENDAR_CONFLICT_STATE_UNKNOWN',
        'SECRETARY_LOCAL_CALENDAR_STATE_UNAVAILABLE',
      ],
    };
  }
}

export function localConflictAsUnifiedCalendarEvent(
  conflict: SecretaryLocalCalendarConflict,
  fallbackSource: CalendarSource,
): UnifiedCalendarEvent {
  return {
    id: conflict.providerEventId ?? `secretary-local:${conflict.id}`,
    source: conflict.providerSource ?? fallbackSource,
    summary: conflict.title,
    start: conflict.start,
    end: conflict.end,
    blocksTime: true,
  };
}

function normalizeScope(userId: number, tenantIdValue: string | number): string {
  const tenantId = String(tenantIdValue ?? '').trim();
  if (!Number.isSafeInteger(userId) || userId <= 0 || tenantId !== String(userId)) {
    throw new Error('SECRETARY_LOCAL_CALENDAR_SCOPE_MISMATCH');
  }
  return tenantId;
}

function normalizeRange(startValue: string, endValue: string): { start: string; end: string } {
  const start = DateTime.fromISO(startValue, { setZone: true });
  const end = DateTime.fromISO(endValue, { setZone: true });
  if (!start.isValid || !end.isValid || end <= start) {
    throw new Error('SECRETARY_LOCAL_CALENDAR_RANGE_INVALID');
  }
  return { start: start.toUTC().toISO()!, end: end.toUTC().toISO()! };
}

function projectAgendaItem(item: SecretaryAgendaItem): SecretaryLocalCalendarConflict[] {
  const windows = item.scheduledSegments.length > 0
    ? item.scheduledSegments
    : item.startAt && item.endAt
      ? [{ start: item.startAt, end: item.endAt }]
      : [];
  return windows.flatMap((window, index) => {
    const start = DateTime.fromISO(window.start, { setZone: true });
    const end = DateTime.fromISO(window.end, { setZone: true });
    if (!start.isValid || !end.isValid || end <= start) return [];
    return [{
      id: `agenda:${item.agendaItemId}:${index}`,
      title: item.title,
      start: start.toUTC().toISO()!,
      end: end.toUTC().toISO()!,
      kind: 'agenda' as const,
      providerEventId: item.providerEventId,
      providerSource: item.providerSource === 'google' || item.providerSource === 'outlook'
        ? item.providerSource
        : null,
    }];
  });
}

function expandProtectedRoutines(
  routines: SecretaryProtectedRoutine[],
  rangeStart: string,
  rangeEnd: string,
  timezone: string,
): { conflicts: SecretaryLocalCalendarConflict[]; unresolvedDst: boolean } {
  const start = DateTime.fromISO(rangeStart, { setZone: true }).setZone(timezone);
  const end = DateTime.fromISO(rangeEnd, { setZone: true }).setZone(timezone);
  const firstDay = start.startOf('day');
  const lastDay = end.startOf('day');
  const conflicts: SecretaryLocalCalendarConflict[] = [];
  let unresolvedDst = false;
  // Calendar commands are capped at 24 hours, so at most three local dates
  // can be relevant around an offset transition. Advance by calendar day
  // rather than elapsed hours so a 23/25-hour DST day is never skipped.
  for (
    let day = firstDay, visited = 0;
    day.toMillis() <= lastDay.toMillis() && visited < 3;
    day = day.plus({ days: 1 }).startOf('day'), visited += 1
  ) {
    for (const routine of routines.filter((candidate) => candidate.weekdays.includes(day.weekday))) {
      const routineStart = routineClockOnDay(day, routine.start);
      const routineEnd = routineClockOnDay(day, routine.end);
      if (!routineStart || !routineEnd || routineEnd <= routineStart) {
        unresolvedDst = true;
        continue;
      }
      const projected = {
        id: `routine:${routine.id}:${day.toISODate()}`,
        title: routine.label,
        start: routineStart.toUTC().toISO()!,
        end: routineEnd.toUTC().toISO()!,
        kind: 'protected_routine' as const,
        providerEventId: null,
        providerSource: null,
      };
      if (overlaps(rangeStart, rangeEnd, projected.start, projected.end)) conflicts.push(projected);
    }
  }
  return { conflicts, unresolvedDst };
}

function routineClockOnDay(day: DateTime, clock: string): DateTime | null {
  const match = /^(\d{2}):(\d{2})$/.exec(clock);
  if (!match) return null;
  const value = day.set({
    hour: Number(match[1]),
    minute: Number(match[2]),
    second: 0,
    millisecond: 0,
  });
  return value.isValid && value.toFormat('HH:mm') === clock ? value : null;
}

function overlaps(start: string, end: string, otherStart: string, otherEnd: string): boolean {
  return Date.parse(start) < Date.parse(otherEnd) && Date.parse(end) > Date.parse(otherStart);
}

function dedupeLocalConflicts(conflicts: SecretaryLocalCalendarConflict[]): SecretaryLocalCalendarConflict[] {
  const seen = new Set<string>();
  return conflicts.filter((conflict) => {
    const key = [
      conflict.providerSource ?? conflict.kind,
      conflict.providerEventId ?? conflict.id,
      conflict.start,
      conflict.end,
    ].join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
