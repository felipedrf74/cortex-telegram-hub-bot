// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import crypto from 'node:crypto';

type HeaderRecord = Record<string, string | string[] | undefined>;

const PERSISTABLE_WEBHOOK_HEADERS = new Set([
  'x-github-delivery',
  'x-github-event',
  'x-goog-channel-id',
  'x-goog-message-number',
  'x-goog-resource-id',
  'x-goog-resource-state',
]);

function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

/** Extract event type from provider-specific headers/payload. */
export function extractEventType(
  provider: string,
  headers: HeaderRecord,
  payload: Record<string, unknown>,
): string {
  switch (provider) {
    case 'google_calendar':
    case 'google_gmail':
      return (headers['x-goog-resource-state'] as string) || 'update';
    case 'outlook_calendar':
    case 'outlook_mail':
    case 'outlook_todo':
      return (payload.changeType as string) || 'updated';
    case 'garmin':
      return (payload.activityType as string) || 'activity';
    case 'strava':
      return (payload.aspect_type as string) || (payload.object_type as string) || 'activity';
    case 'github': {
      const ghEvent = headers['x-github-event'];
      return (typeof ghEvent === 'string' ? ghEvent : 'push');
    }
    default:
      return (payload.event_type as string) || (payload.type as string) || 'unknown';
  }
}

/** Extract idempotency key from provider-specific fields. */
export function extractIdempotencyKey(
  provider: string,
  headers: HeaderRecord,
  payload: Record<string, unknown>,
): string | undefined {
  switch (provider) {
    case 'google_calendar':
    case 'google_gmail':
      return headers['x-goog-message-number'] as string | undefined;
    case 'outlook_calendar':
    case 'outlook_mail':
    case 'outlook_todo': {
      // Microsoft Graph reuses subscriptionId for every notification. Bind
      // deduplication to the canonical notification instead so independent
      // changes on one subscription cannot collapse into one event.
      const digest = crypto
        .createHash('sha256')
        .update(`${provider}\0${canonicalJson(payload)}`)
        .digest('hex');
      return `outlook:${digest}`;
    }
    case 'github':
      return headers['x-github-delivery'] as string | undefined;
    case 'strava': {
      // `event_time` has one-second granularity and is not an event identity;
      // independent objects can legitimately share it. Bind retries to the
      // canonical provider notification instead.
      const digest = crypto
        .createHash('sha256')
        .update(`${provider}\0${canonicalJson(payload)}`)
        .digest('hex');
      return `strava:${digest}`;
    }
    default:
      return payload.id ? String(payload.id) : undefined;
  }
}

/** Select only non-secret provider metadata required for replay diagnostics. */
export function flattenHeaders(headers: HeaderRecord): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const normalizedKey = key.toLowerCase();
    if (value !== undefined && PERSISTABLE_WEBHOOK_HEADERS.has(normalizedKey)) {
      result[normalizedKey] = Array.isArray(value) ? value.join(', ') : value;
    }
  }
  return result;
}
