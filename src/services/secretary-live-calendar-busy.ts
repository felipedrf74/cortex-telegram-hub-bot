// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { DateTime } from 'luxon';
import {
  type SecretarySchedulingIntent,
  type SecretaryTimeWindow,
} from './secretary-scheduling-arbitrator';
import { getEventsWithDiagnostics, type UnifiedCalendarEvent } from './unified-calendar';
import { logger } from '../utils/logger';

export interface SecretaryLiveCalendarBusyWindowsResult {
  windows: SecretaryTimeWindow[];
  degraded: boolean;
  providerConfigured: boolean;
  warningCodes: string[];
  warnings: string[];
}

export async function loadLiveCalendarBusyWindowsForSecretaryIntent(
  intent: SecretarySchedulingIntent,
): Promise<SecretaryLiveCalendarBusyWindowsResult> {
  const range = resolveCalendarBusyRange(intent);
  if (!range) return { windows: [], degraded: false, providerConfigured: false, warningCodes: [], warnings: [] };

  try {
    const result = await getEventsWithDiagnostics(range.start, range.end, intent.ownerUserId);
    const providerConfigured = result.sources.configured.length > 0;
    const windows = result.events
      .map(calendarEventToBusyWindow)
      .filter((window): window is SecretaryTimeWindow => Boolean(window));
    return {
      windows,
      degraded: result.status !== 'ready' && providerConfigured,
      providerConfigured,
      warningCodes: result.warningCodes,
      warnings: result.warnings,
    };
  } catch (err) {
    logger.warn(
      { err, userId: intent.ownerUserId, tenantId: intent.tenantId, intentId: intent.intentId },
      'Secretary live calendar busy-window fetch failed',
    );
    return {
      windows: [],
      degraded: true,
      providerConfigured: true,
      warningCodes: ['CALENDAR_BUSY_WINDOWS_UNAVAILABLE'],
      warnings: ['Calendar availability could not be checked right now.'],
    };
  }
}

function resolveCalendarBusyRange(intent: SecretarySchedulingIntent): { start: string; end: string } | null {
  const windows = [
    ...(intent.preferredWindows ?? []),
    ...(intent.hardConstraints?.unavailableWindows ?? []),
    ...(intent.hardConstraints?.protectedWindows ?? []),
    ...(intent.hardConstraints?.hardCommitments ?? []),
  ];
  const parsed = windows.flatMap((window) => [DateTime.fromISO(window.start, { setZone: true }), DateTime.fromISO(window.end, { setZone: true })])
    .filter((value) => value.isValid);

  const deadline = intent.deadline ? DateTime.fromISO(intent.deadline, { setZone: true }) : null;
  if (deadline?.isValid) parsed.push(deadline);

  if (parsed.length === 0) {
    const start = DateTime.now().toUTC();
    return { start: start.toISO()!, end: start.plus({ days: 14 }).toISO()! };
  }

  const min = parsed.reduce((earliest, value) => value.toMillis() < earliest.toMillis() ? value : earliest, parsed[0]).toUTC();
  const max = parsed.reduce((latest, value) => value.toMillis() > latest.toMillis() ? value : latest, parsed[0]).toUTC();
  return {
    start: min.minus({ days: 1 }).toISO()!,
    end: max.plus({ days: 1 }).toISO()!,
  };
}

function calendarEventToBusyWindow(event: UnifiedCalendarEvent): SecretaryTimeWindow | null {
  if (!event.start || !event.end) return null;
  const start = DateTime.fromISO(event.start, { setZone: true });
  const end = DateTime.fromISO(event.end, { setZone: true });
  if (!start.isValid || !end.isValid || end.toMillis() <= start.toMillis()) return null;
  return {
    start: start.toUTC().toISO()!,
    end: end.toUTC().toISO()!,
    label: event.summary || 'Calendar event',
  };
}
