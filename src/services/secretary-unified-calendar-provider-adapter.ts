// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import {
  createEvent,
  deleteEvent,
  updateEvent,
  type CalendarSource,
  type UnifiedCalendarEvent,
} from './unified-calendar';
import * as googleCalendar from './google-calendar';
import * as outlookCalendar from './outlook-calendar';
import {
  type SecretaryAgendaProviderAdapter,
  type SecretaryCalendarProviderSource,
  type SecretaryProviderEvent,
  type SecretaryProviderEventInput,
} from './secretary-agenda-provider-sync';
import { getSessionById, type TrainingSession } from './training-plans';
import { stripTrainingIdentityMarker } from './training-session-identity';
import { renderSectionsAsText, type SessionSections } from './training-session-description';
import { logger } from '../utils/logger';

const MARKER_PREFIX = 'NEXUS_SECRETARY_AGENDA_ITEM';
const READBACK_PADDING_MS = 24 * 60 * 60 * 1000;

export function createUnifiedCalendarSecretaryProviderAdapter(
  source: SecretaryCalendarProviderSource,
): SecretaryAgendaProviderAdapter {
  return {
    source,
    async createEvent(input) {
      const event = await createEvent({
        title: input.title,
        start: input.startAt,
        end: input.endAt,
        description: buildSecretaryCalendarDescription(input),
        categories: dedupeCategories(['Nexus', 'Secretary', input.sourceSkill]),
      }, source, input.ownerUserId);
      return toSecretaryProviderEvent(event, input);
    },
    async updateEvent(eventId, input) {
      const event = await updateEvent({
        event_id: eventId,
        new_title: input.title,
        new_start: input.startAt,
        new_end: input.endAt,
        new_description: buildSecretaryCalendarDescription(input),
      }, source, input.ownerUserId);
      return toSecretaryProviderEvent(event, input);
    },
    async deleteEvent(eventId, input) {
      await deleteEvent(eventId, source, input?.ownerUserId);
    },
    async getEvent(eventId, input) {
      if (!input) return null;
      const events = await fetchSecretaryReadbackWindow(input, source);
      const event = events.find((candidate) => candidate.id === eventId);
      return event ? toSecretaryProviderEvent(event, input) : null;
    },
    async findEventsByAgendaItemId(agendaItemId, input) {
      if (!input) return [];
      const events = await fetchSecretaryReadbackWindow(input, source);
      return events
        .filter((event) => event.source === source)
        .filter((event) => (
          extractSecretaryAgendaMarker(event.description) === agendaItemId
          || isLikelySameSecretaryEvent(event, input)
        ))
        .map((event) => toSecretaryProviderEvent(event, input));
    },
  };
}

export function buildSecretaryCalendarDescription(input: SecretaryProviderEventInput): string {
  const sourceBody = sourceBodyForSecretaryCalendarEvent(input);
  const durationMinutes = typeof input.durationMinutes === 'number' && Number.isFinite(input.durationMinutes) && input.durationMinutes > 0
    ? input.durationMinutes
    : null;
  const headerLines = [
    input.title.trim(),
    durationMinutes ? `Duration: ${durationMinutes} min` : '',
  ].filter(Boolean);
  const sourceLine = userFacingSourceLine(input);
  const sections = [
    headerLines.join('\n'),
    sourceBody,
    sourceLine,
  ]
    .map((section) => section?.trim() ?? '')
    .filter(Boolean);
  return sections.join('\n\n');
}

// 2026-05-25 Bug #3 (Stage 1) — body hydration. Pre-fix this function
// only read `session.description`. When the planner had stored a
// session without a populated `description` (some session-type
// branches skip the rich-text rendering step at persistence time),
// the calendar event body collapsed to just the metadata footer —
// the bug the user reported (screenshot showed a "Strength + Core
// Support" event whose body was 6 lines of NEXUS_SECRETARY_* markers
// and nothing else).
//
// Hydration priority (first non-empty wins):
//   1. `session.description` — the pre-rendered plain text, what the
//      planner historically wrote at persistence time. iOS reads this
//      same field.
//   2. `session.description_json` parsed + re-rendered via
//      `renderSectionsAsText` — the typed `SessionSections` source of
//      truth. Used when description was never written.
//   3. Minimal fallback one-liner from `title + intensity_text +
//      duration_minutes` — never empty when the session row exists.
function sourceBodyForSecretaryCalendarEvent(input: SecretaryProviderEventInput): string | null {
  if (input.sourceSkill !== 'training' || input.sourceEntityType !== 'training_session') return null;
  const sessionId = Number(input.sourceEntityId);
  if (!Number.isFinite(sessionId) || sessionId <= 0) return null;
  const session = getSessionById(Math.floor(sessionId));
  if (!session) return null;

  // Priority 1: stored plain-text description.
  const storedDescription = stripTrainingIdentityMarker(session.description ?? '').trim();
  if (storedDescription) return storedDescription;

  // Priority 2: re-render from structured sections.
  const renderedFromSections = tryRenderSectionsFromJson(session.description_json);
  if (renderedFromSections) return renderedFromSections;

  // Priority 3: minimal fallback so the event body is never empty.
  return buildMinimalSessionFallback(session);
}

function userFacingSourceLine(input: SecretaryProviderEventInput): string {
  if (input.sourceSkill === 'training') return 'Source: Nexus Hub training plan.';
  return 'Source: Nexus Hub secretary.';
}

function tryRenderSectionsFromJson(raw: string | null | undefined): string | null {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    logger.warn({ err }, 'secretary-calendar-adapter: description_json parse failed — falling back to minimal body');
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  try {
    const rendered = renderSectionsAsText(parsed as SessionSections).trim();
    return rendered || null;
  } catch (err) {
    logger.warn({ err }, 'secretary-calendar-adapter: renderSectionsAsText failed — falling back to minimal body');
    return null;
  }
}

function buildMinimalSessionFallback(session: TrainingSession): string | null {
  const parts: string[] = [];
  if (session.title) parts.push(session.title);
  if (session.intensity_text) parts.push(session.intensity_text);
  if (typeof session.duration_minutes === 'number' && session.duration_minutes > 0) {
    parts.push(`${session.duration_minutes} min`);
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

function isLikelySameSecretaryEvent(event: UnifiedCalendarEvent, input: SecretaryProviderEventInput): boolean {
  if (!sameInstant(event.start, input.startAt) || !sameInstant(event.end, input.endAt)) return false;
  return normalizeComparableText(event.summary) === normalizeComparableText(input.title);
}

function sameInstant(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const left = Date.parse(a);
  const right = Date.parse(b);
  return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= 1000;
}

function normalizeComparableText(value: string | undefined): string {
  return (value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

export function extractSecretaryAgendaMarker(description: string | undefined): string | null {
  if (!description) return null;
  const marker = description
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith(`${MARKER_PREFIX}:`));
  return marker ? marker.slice(MARKER_PREFIX.length + 1).trim() || null : null;
}

async function fetchSecretaryReadbackWindow(
  input: SecretaryProviderEventInput,
  source: CalendarSource,
): Promise<UnifiedCalendarEvent[]> {
  const start = new Date(Date.parse(input.startAt) - READBACK_PADDING_MS).toISOString();
  const end = new Date(Date.parse(input.endAt) + READBACK_PADDING_MS).toISOString();
  if (source === 'google') {
    const events = await googleCalendar.getEvents(start, end, input.ownerUserId);
    return events.map((event) => ({ ...event, source: 'google' as const }));
  }
  const events = await outlookCalendar.getEvents(start, end, input.ownerUserId);
  return events.map((event) => ({ ...event, source: 'outlook' as const }));
}

function toSecretaryProviderEvent(
  event: UnifiedCalendarEvent,
  input: SecretaryProviderEventInput,
): SecretaryProviderEvent {
  return {
    eventId: event.id,
    source: event.source,
    agendaItemId: extractSecretaryAgendaMarker(event.description) ?? input.agendaItemId,
    title: event.summary,
    startAt: event.start,
    endAt: event.end,
    version: input.version,
  };
}

function dedupeCategories(categories: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const category of categories) {
    const normalized = category.trim();
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    deduped.push(normalized);
  }
  return deduped;
}
