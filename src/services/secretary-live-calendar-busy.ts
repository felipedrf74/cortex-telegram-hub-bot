// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { DateTime } from 'luxon';
import {
  type SecretaryTimeWindow,
  type SecretarySchedulingIntent,
} from './secretary-scheduling-arbitrator';
import {
  normalizeProviderDescriptionForMarkerParse,
  parseTrainingIdentityMarker,
} from './training-session-identity';
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
  return loadLiveCalendarBusyWindowsForRange({
    ownerUserId: intent.ownerUserId,
    tenantId: intent.tenantId,
    start: range.start,
    end: range.end,
    context: intent.intentId,
  });
}

export interface SecretaryLiveCalendarBusyRangeInput {
  ownerUserId: number;
  tenantId: string | number;
  start: string;
  end: string;
  /** Correlation label for the failure log (intent id, plan id, ...). */
  context?: string;
}

/**
 * F29 (Phase 3): range-level entry point so batch callers (the training
 * calendar-sync drain) can fetch the athlete's live busy windows ONCE for a
 * whole plan window instead of once per session/intent.
 */
export async function loadLiveCalendarBusyWindowsForRange(
  input: SecretaryLiveCalendarBusyRangeInput,
): Promise<SecretaryLiveCalendarBusyWindowsResult> {
  try {
    const result = await getEventsWithDiagnostics(input.start, input.end, input.ownerUserId);
    const providerConfigured = result.sources.configured.length > 0;
    const windows = result.events
      .map((event) => calendarEventToBusyWindow(event, input))
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
      { err, userId: input.ownerUserId, tenantId: input.tenantId, context: input.context ?? null },
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

function calendarEventToBusyWindow(
  event: UnifiedCalendarEvent,
  scope: Pick<SecretaryLiveCalendarBusyRangeInput, 'ownerUserId' | 'tenantId'>,
): SecretaryTimeWindow | null {
  if (!event.start || !event.end) return null;
  const start = DateTime.fromISO(event.start, { setZone: true });
  const end = DateTime.fromISO(event.end, { setZone: true });
  if (!start.isValid || !end.isValid || end.toMillis() <= start.toMillis()) return null;
  const providerEventId = String(event.id || '').trim();
  const description = String(event.description || '');
  return {
    start: start.toUTC().toISO()!,
    end: end.toUTC().toISO()!,
    label: event.summary || 'Calendar event',
    ...(providerEventId ? {
      providerIdentity: {
        providerEventId,
        providerSource: event.source,
        ownerUserId: scope.ownerUserId,
        tenantId: String(scope.tenantId),
        agendaItemId: extractExactSecretaryAgendaMarker(description),
        trainingIdentity: extractExactTrainingIdentity(description),
      },
    } : {}),
  };
}

/**
 * A marker is identity evidence only when exactly one marker is present.
 * Duplicate markers are ambiguous and deliberately collapse to `null`, which
 * keeps the provider event hard-busy in the Stage 1 planner.
 */
function extractExactSecretaryAgendaMarker(description: string): string | null {
  const normalized = normalizeProviderDescriptionForMarkerParse(description);
  const matches = [...normalized.matchAll(/\bNEXUS_SECRETARY_AGENDA_ITEM:([A-Za-z0-9._:-]+)\b/gi)];
  if (matches.length !== 1) return null;
  return matches[0][1]?.trim() || null;
}

function extractExactTrainingIdentity(description: string) {
  const normalized = normalizeProviderDescriptionForMarkerParse(description);
  const matches = normalized.match(/\[NEXUS_TRAINING_IDENTITY\s+[^\]]+\]/gi) ?? [];
  if (matches.length !== 1) return null;
  return parseTrainingIdentityMarker(normalized);
}
