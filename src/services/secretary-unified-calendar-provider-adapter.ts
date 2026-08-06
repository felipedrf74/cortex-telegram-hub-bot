// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import {
  createEvent,
  deleteEvent,
  getEventById,
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
import { getPlanById, getSessionByIdForScope, type TrainingSession } from './training-plans';
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
      return toSecretaryProviderEvent(event, input, true);
    },
    async updateEvent(eventId, input) {
      const event = await updateEvent({
        event_id: eventId,
        new_title: calendarTitleForSecretaryProviderEvent(input),
        new_start: input.startAt,
        new_end: input.endAt,
        new_description: providerDescriptionForSecretaryEvent(input),
      }, source, input.ownerUserId);
      return toSecretaryProviderEvent(event, input, true);
    },
    async deleteEvent(eventId, input) {
      await deleteEvent(eventId, source, input?.ownerUserId);
    },
    async getEvent(eventId, input) {
      if (!input) return { status: 'unknown', reasonCode: 'provider_exact_read_scope_missing' };
      try {
        const event = await getEventById(eventId, source, input.ownerUserId);
        return event
          ? { status: 'found', event: toSecretaryProviderEvent(event, input) }
          : { status: 'not_found' };
      } catch {
        logger.warn({ providerSource: source }, 'Secretary exact provider event read failed');
        return { status: 'unknown', reasonCode: 'provider_exact_read_failed' };
      }
    },
    async findEventsByAgendaItemId(agendaItemId, input) {
      if (!input) return [];
      const events = await fetchSecretaryReadbackWindow(input, source);
      return events
        .filter((event) => event.source === source)
        .filter((event) => (
          extractSecretaryAgendaMarker(event.description) === agendaItemId
          || isLikelySameTrainingCalendarEvent(event, input)
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
  const description = [
    buildSecretaryCalendarDescription(input),
    `${MARKER_PREFIX}:${input.agendaItemId}`,
  ].filter(Boolean).join('\n\n');
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
  const sessionId = positiveSafeInteger(input.sourceEntityId);
  const userId = positiveSafeInteger(input.ownerUserId);
  const tenantId = positiveSafeInteger(input.tenantId);
  if (sessionId == null || userId == null || tenantId == null) return null;
  return getSessionByIdForScope(sessionId, { userId, tenantId });
}

function positiveSafeInteger(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const normalized = typeof value === 'string' ? value.trim() : value;
  if (normalized === '') return null;
  const numeric = typeof normalized === 'number' ? normalized : Number(normalized);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : null;
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
  const session = trainingSessionForInput(input);
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
  if (positiveSafeInteger(input.sourceEntityId) == null) return input.title;
  const session = trainingSessionForInput(input);
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
  if (!marker?.sessionId) return false;
  const intent = parseTrainingSourceIntent(input.sourceIntentId);
  // An agenda row whose intent and entity disagree is corrupt — never guess.
  if (intent && intent.sessionId !== Math.floor(sessionId)) return false;
  if (intent && marker.planId && marker.planId !== intent.planId) return false;
  if (marker.sessionId === Math.floor(sessionId)) return true;

  // A regenerated plan may replace the physical session row while retaining
  // the same provider event. Cross-version adoption is allowed only through
  // the current scoped row's exact stable identity AND material shape. This
  // deliberately excludes title/time matching and same-key changed sessions.
  if (!intent || marker.planId !== intent.planId) return false;
  if (!marker.planVersion || marker.planVersion >= intent.planVersion) return false;
  const current = trainingSessionForInput(input);
  if (!current || current.plan_id !== intent.planId) return false;
  const currentKey = current.session_identity_key?.trim() ?? '';
  const currentShape = current.session_shape_hash?.trim() ?? '';
  const markerKey = marker.sessionIdentityKey?.trim() ?? '';
  const markerShape = marker.sessionShapeHash?.trim() ?? '';
  return Boolean(
    currentKey
    && currentShape
    && markerKey === currentKey
    && markerShape === currentShape,
  );
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
  trustedWriteResult = false,
): SecretaryProviderEvent {
  const markerAgendaItemId = extractSecretaryAgendaMarker(event.description);
  const trainingOwned = isLikelySameTrainingCalendarEvent(event, input);
  return {
    eventId: event.id,
    source: event.source,
    // Only an exact marker (or the direct response to our own marker-bearing
    // write) may assign Secretary ownership. Readback title/time similarity
    // is never sufficient authority to adopt or delete an event.
    agendaItemId: markerAgendaItemId ?? (trainingOwned || trustedWriteResult ? input.agendaItemId : ''),
    title: event.summary,
    startAt: event.start,
    endAt: event.end,
    version: input.version,
    // Canonical-event selection must never delete the event Training links
    // to; flag marker-bearing events so the sync engine prefers them.
    trainingOwned: trainingOwned || undefined,
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
