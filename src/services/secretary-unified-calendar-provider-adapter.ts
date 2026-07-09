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
import { getPlanById, getSessionById, type TrainingSession } from './training-plans';
import {
  appendTrainingIdentityMarker,
  normalizeProviderDescriptionForMarkerParse,
  parseTrainingIdentityMarker,
  stripTrainingIdentityMarker,
} from './training-session-identity';
import { emojiForTrainingSession } from './training-calendar-format';
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
        title: calendarTitleForSecretaryProviderEvent(input),
        start: input.startAt,
        end: input.endAt,
        description: providerDescriptionForSecretaryEvent(input),
        categories: dedupeCategories(['Nexus', 'Secretary', input.sourceSkill]),
      }, source, input.ownerUserId);
      return toSecretaryProviderEvent(event, input);
    },
    async updateEvent(eventId, input) {
      const event = await updateEvent({
        event_id: eventId,
        new_title: calendarTitleForSecretaryProviderEvent(input),
        new_start: input.startAt,
        new_end: input.endAt,
        new_description: providerDescriptionForSecretaryEvent(input),
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
          || isLikelySameTrainingCalendarEvent(event, input)
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

// What actually gets pushed to the provider. The user-facing body stays
// marker-free (2026-05-25 Bug #3 contract on buildSecretaryCalendarDescription),
// but training-backed events must carry the same [NEXUS_TRAINING_IDENTITY ...]
// trailer the direct Training calendar sync writes: it is the only signal that
// lets Training re-adopt the event after plan regeneration, lets the
// cancellation sweep find it, keeps busy-classification treating it as
// training-owned, and lets this adapter's own dedupe keep matching it after a
// Secretary rewrite. Without re-appending it here, the first Secretary update
// of an adopted Training event would destroy the fix's own match signal.
function providerDescriptionForSecretaryEvent(input: SecretaryProviderEventInput): string {
  const description = buildSecretaryCalendarDescription(input);
  const session = trainingSessionForInput(input);
  if (!session) return description;
  const intent = parseTrainingSourceIntent(input.sourceIntentId);
  const planVersion = intent?.planVersion
    ?? getPlanById(session.plan_id)?.plan_version
    ?? null;
  return appendTrainingIdentityMarker(description, {
    planId: session.plan_id,
    planVersion,
    sessionId: session.id,
    sessionIdentityKey: session.session_identity_key ?? null,
    sessionShapeHash: session.session_shape_hash ?? null,
  });
}

function trainingSessionForInput(input: SecretaryProviderEventInput): TrainingSession | null {
  if (input.sourceSkill !== 'training' || input.sourceEntityType !== 'training_session') return null;
  const sessionId = Number(input.sourceEntityId);
  if (!Number.isFinite(sessionId) || sessionId <= 0) return null;
  return getSessionById(Math.floor(sessionId));
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

function calendarTitleForSecretaryProviderEvent(input: SecretaryProviderEventInput): string {
  if (input.sourceSkill !== 'training' || input.sourceEntityType !== 'training_session') {
    return input.title;
  }
  const sessionId = Number(input.sourceEntityId);
  if (!Number.isFinite(sessionId) || sessionId <= 0) return input.title;
  const session = getSessionById(Math.floor(sessionId));
  const durationMinutes = typeof input.durationMinutes === 'number' && Number.isFinite(input.durationMinutes) && input.durationMinutes > 0
    ? Math.round(input.durationMinutes)
    : session?.duration_minutes;
  const title = input.title.trim();
  if (!title) return title;
  const emoji = emojiForTrainingSession(session?.session_type);
  if (durationMinutes && /\(\d+\s*min\)$/i.test(title)) {
    // Already fully decorated (persistence-path intent titles). Only add the
    // emoji when it is missing so the title matches the direct-sync format.
    return hasLeadingTrainingEmoji(title) ? title : `${emoji} ${title}`;
  }
  const cleanTitle = stripLeadingTrainingEmoji(title);
  return durationMinutes ? `${emoji} ${cleanTitle} (${durationMinutes}min)` : `${emoji} ${cleanTitle}`;
}

const LEADING_TRAINING_EMOJI_RE = /^\s*(?:💪|🏃|🚴|🏊|🏋️|🏋)/u;

function hasLeadingTrainingEmoji(title: string): boolean {
  return LEADING_TRAINING_EMOJI_RE.test(title);
}

function stripLeadingTrainingEmoji(title: string): string {
  return title
    .replace(/^\s*(?:💪|🏃|🚴|🏊|🏋️|🏋)\s*/u, '')
    .trim();
}

function isLikelySameSecretaryEvent(event: UnifiedCalendarEvent, input: SecretaryProviderEventInput): boolean {
  if (!sameInstant(event.start, input.startAt) || !sameInstant(event.end, input.endAt)) return false;
  const eventTitle = normalizeComparableText(event.summary);
  return eventTitle === normalizeComparableText(input.title)
    || eventTitle === normalizeComparableText(calendarTitleForSecretaryProviderEvent(input));
}

// Identity-marker match. Deliberately NOT gated on start/end equality: the
// marker names the exact training session, so a same-session event at a
// drifted slot is still the same provider event (adopt and move it, don't
// duplicate it). This also keeps the match alive on Outlook, where Graph
// returns timezone-naive datetimes that make instant comparison unreliable.
// Candidates are already bounded to the ±24h readback window.
function isLikelySameTrainingCalendarEvent(event: UnifiedCalendarEvent, input: SecretaryProviderEventInput): boolean {
  if (input.sourceSkill !== 'training' || input.sourceEntityType !== 'training_session') return false;
  const sessionId = Number(input.sourceEntityId);
  if (!Number.isFinite(sessionId) || sessionId <= 0) return false;
  const marker = parseTrainingIdentityMarker(event.description);
  if (!marker?.sessionId || marker.sessionId !== Math.floor(sessionId)) return false;
  const intent = parseTrainingSourceIntent(input.sourceIntentId);
  // An agenda row whose intent and entity disagree is corrupt — never guess.
  if (intent && intent.sessionId !== Math.floor(sessionId)) return false;
  if (intent && marker.planId && marker.planId !== intent.planId) return false;
  return true;
}

function parseTrainingSourceIntent(value: string): { planId: number; planVersion: number; sessionId: number } | null {
  const match = value.match(/^training:(\d+):(\d+):(\d+)$/);
  if (!match) return null;
  const planId = Number(match[1]);
  const planVersion = Number(match[2]);
  const sessionId = Number(match[3]);
  if (![planId, planVersion, sessionId].every((part) => Number.isFinite(part) && part > 0)) return null;
  return {
    planId: Math.floor(planId),
    planVersion: Math.floor(planVersion),
    sessionId: Math.floor(sessionId),
  };
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
  // Graph can return the body HTML-wrapped even for text events; strip tags
  // so the line-oriented scan still finds a marker written into a text body.
  const marker = normalizeProviderDescriptionForMarkerParse(description)
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
    // Canonical-event selection must never delete the event Training links
    // to; flag marker-bearing events so the sync engine prefers them.
    trainingOwned: isLikelySameTrainingCalendarEvent(event, input) || undefined,
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
