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
import { getSessionById } from './training-plans';
import { stripTrainingIdentityMarker } from './training-session-identity';

const MARKER_PREFIX = 'NEXUS_SECRETARY_AGENDA_ITEM';
const SOURCE_INTENT_PREFIX = 'NEXUS_SECRETARY_SOURCE_INTENT';
const SOURCE_SKILL_PREFIX = 'NEXUS_SECRETARY_SOURCE_SKILL';
const SOURCE_ENTITY_PREFIX = 'NEXUS_SECRETARY_SOURCE_ENTITY';
const VERSION_PREFIX = 'NEXUS_SECRETARY_VERSION';
const SHAPE_PREFIX = 'NEXUS_SECRETARY_SHAPE';
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
        .filter((event) => extractSecretaryAgendaMarker(event.description) === agendaItemId)
        .map((event) => toSecretaryProviderEvent(event, input));
    },
  };
}

export function buildSecretaryCalendarDescription(input: SecretaryProviderEventInput): string {
  const footerLines = [
    `${MARKER_PREFIX}:${input.agendaItemId}`,
    `${SOURCE_INTENT_PREFIX}:${input.sourceIntentId}`,
    `${SOURCE_SKILL_PREFIX}:${input.sourceSkill}`,
    `${SOURCE_ENTITY_PREFIX}:${input.sourceEntityType ?? 'unknown'}:${input.sourceEntityId ?? 'unknown'}`,
    `${VERSION_PREFIX}:${input.version}`,
    `${SHAPE_PREFIX}:${input.sourceShapeHash}`,
  ];
  if (input.decisionReasonCodes.length > 0) {
    footerLines.push(`Decision reasons: ${input.decisionReasonCodes.join(', ')}`);
  }
  const sourceBody = sourceBodyForSecretaryCalendarEvent(input);
  const footer = footerLines.join('\n');
  return sourceBody ? `${sourceBody}\n\n${footer}` : footer;
}

function sourceBodyForSecretaryCalendarEvent(input: SecretaryProviderEventInput): string | null {
  if (input.sourceSkill !== 'training' || input.sourceEntityType !== 'training_session') return null;
  const sessionId = Number(input.sourceEntityId);
  if (!Number.isFinite(sessionId) || sessionId <= 0) return null;
  const session = getSessionById(Math.floor(sessionId));
  const description = stripTrainingIdentityMarker(session?.description ?? '');
  return description.trim() || null;
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
