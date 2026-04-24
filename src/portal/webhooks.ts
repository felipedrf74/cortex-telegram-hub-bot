// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

type HeaderRecord = Record<string, string | string[] | undefined>;

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
    case 'outlook_todo':
      return payload.subscriptionId as string | undefined;
    case 'github':
      return headers['x-github-delivery'] as string | undefined;
    case 'strava':
      return payload.event_time ? String(payload.event_time) : undefined;
    default:
      return payload.id ? String(payload.id) : undefined;
  }
}

/** Flatten Express headers into a simple string record for storage. */
export function flattenHeaders(headers: HeaderRecord): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) {
      result[key] = Array.isArray(value) ? value.join(', ') : value;
    }
  }
  return result;
}
