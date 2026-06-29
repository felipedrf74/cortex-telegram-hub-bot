// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { isConnected } from './oauth-store';
import { resolveCalendarWritePreference } from './provider-preferences';
import { isTrainingCalendarSourceWritesEnabled } from './training-operational-switches';
import { requireTenantIdParam } from './tenant-scope';
import type { CalendarSource } from './unified-calendar';

const TRAINING_CALENDAR_SOURCES: readonly CalendarSource[] = ['outlook', 'google'];

export type TrainingCalendarSourceErrorCode =
  | 'INVALID_CALENDAR_SOURCE'
  | 'CALENDAR_SOURCE_NOT_CONNECTED'
  | 'CALENDAR_SOURCE_DISABLED';

export type TrainingCalendarSourceValidation =
  | { ok: true; source?: CalendarSource }
  | {
      ok: false;
      code: TrainingCalendarSourceErrorCode;
      message: string;
      status: number;
    };

export function normalizeTrainingCalendarSource(value: unknown): CalendarSource | null | 'invalid' {
  if (value == null) return null;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === 'auto' || normalized === 'default') return null;
  if (normalized === 'google' || normalized === 'gmail' || normalized === 'gcal') return 'google';
  if (normalized === 'outlook' || normalized === 'microsoft' || normalized === 'msft') return 'outlook';
  return 'invalid';
}

export function validateRequestedTrainingCalendarSource(
  userId: number,
  requestedSource: unknown,
): TrainingCalendarSourceValidation {
  const source = normalizeTrainingCalendarSource(requestedSource);
  if (source === 'invalid') {
    return {
      ok: false,
      code: 'INVALID_CALENDAR_SOURCE',
      status: 400,
      message: 'calendarSource must be "auto", "outlook", or "google".',
    };
  }
  if (!source) return { ok: true };
  if (!isTrainingCalendarSourceWritesEnabled(source)) {
    return {
      ok: false,
      code: 'CALENDAR_SOURCE_DISABLED',
      status: 503,
      message: `${displayTrainingCalendarSource(source)} sync is temporarily disabled for Training.`,
    };
  }
  if (!isTrainingCalendarSourceConnected(userId, source)) {
    return {
      ok: false,
      code: 'CALENDAR_SOURCE_NOT_CONNECTED',
      status: 409,
      message: `Connect ${displayTrainingCalendarSource(source)} before syncing Training sessions there.`,
    };
  }
  return { ok: true, source };
}

export function resolveTrainingCalendarSource(input: {
  userId: number;
  tenantId: number;
  requestedSource?: CalendarSource | null;
  planPreferencesJson?: string | null;
  linkedSources?: Array<unknown>;
}): CalendarSource | undefined {
  const tenantId = requireTenantIdParam(input.tenantId, 'resolveTrainingCalendarSource');
  if (input.requestedSource) {
    return isTrainingCalendarSourceAvailable(input.userId, input.requestedSource)
      ? input.requestedSource
      : undefined;
  }

  // Current explicit calendar choices outrank stale plan/session links.
  // Without this, a plan created while Google was active can keep reflowing
  // workouts into Google after the user switches the main provider to Outlook.
  const preference = resolveCalendarWritePreference(input.userId, tenantId);
  if (preference.requested !== 'auto') {
    return preference.source && isTrainingCalendarSourceAvailable(input.userId, preference.source)
      ? preference.source
      : undefined;
  }
  if (preference.source && isTrainingCalendarSourceAvailable(input.userId, preference.source)) {
    return preference.source;
  }

  const preferred = readTrainingCalendarSourcePreference(input.planPreferencesJson);
  if (preferred) {
    if (isTrainingCalendarSourceAvailable(input.userId, preferred)) {
      return preferred;
    }
  }

  for (const linked of input.linkedSources ?? []) {
    const source = normalizeTrainingCalendarSource(linked);
    if (source !== 'invalid' && source && isTrainingCalendarSourceAvailable(input.userId, source)) {
      return source;
    }
  }

  // Match unified-calendar.createEvent's authenticated-user default, including
  // tenant-scoped provider preferences. In auto mode, preserve Training's
  // legacy connected-source fallback so a down preferred calendar does not
  // strand sync when another writable calendar is connected.
  for (const source of TRAINING_CALENDAR_SOURCES) {
    if (isTrainingCalendarSourceAvailable(input.userId, source)) {
      return source;
    }
  }
  return undefined;
}

export function withTrainingCalendarSourcePreference(
  preferencesJson: string | null | undefined,
  source: CalendarSource | undefined,
): string {
  const preferences = parsePreferences(preferencesJson);
  if (source) {
    preferences.trainingCalendarSource = source;
  } else {
    delete preferences.trainingCalendarSource;
  }
  return JSON.stringify(preferences);
}

function readTrainingCalendarSourcePreference(preferencesJson: string | null | undefined): CalendarSource | null {
  const preferences = parsePreferences(preferencesJson);
  const source = normalizeTrainingCalendarSource(preferences.trainingCalendarSource ?? preferences.calendarSource);
  return source === 'invalid' ? null : source;
}

function parsePreferences(preferencesJson: string | null | undefined): Record<string, unknown> {
  if (!preferencesJson) return {};
  try {
    const parsed = JSON.parse(preferencesJson);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function isTrainingCalendarSourceConnected(userId: number, source: CalendarSource): boolean {
  try {
    return isConnected(userId, source);
  } catch {
    return false;
  }
}

function isTrainingCalendarSourceAvailable(userId: number, source: CalendarSource): boolean {
  return isTrainingCalendarSourceWritesEnabled(source) && isTrainingCalendarSourceConnected(userId, source);
}

function displayTrainingCalendarSource(source: CalendarSource): string {
  return source === 'google' ? 'Google Calendar' : 'Outlook Calendar';
}
