import * as googleCal from './google-calendar';
import * as outlookCal from './outlook-calendar';
import { logger } from '../utils/logger';

export type CalendarSource = 'google' | 'outlook';

export interface UnifiedCalendarEvent extends googleCal.CalendarEvent {
  source: CalendarSource;
}

export function isAnyCalendarConfigured(): boolean {
  return googleCal.isGoogleCalendarConfigured() || outlookCal.isOutlookCalendarConfigured();
}

export function getConfiguredSources(): CalendarSource[] {
  const sources: CalendarSource[] = [];
  if (googleCal.isGoogleCalendarConfigured()) sources.push('google');
  if (outlookCal.isOutlookCalendarConfigured()) sources.push('outlook');
  return sources;
}

export async function getEvents(startDate: string, endDate: string): Promise<UnifiedCalendarEvent[]> {
  const events: UnifiedCalendarEvent[] = [];

  // Fetch from both in parallel
  const promises: Promise<void>[] = [];

  if (googleCal.isGoogleCalendarConfigured()) {
    promises.push(
      googleCal.getEvents(startDate, endDate)
        .then((gEvents) => {
          for (const e of gEvents) {
            events.push({ ...e, source: 'google' });
          }
        })
        .catch((err) => {
          logger.error({ err }, 'Failed to fetch Google Calendar events');
        })
    );
  }

  if (outlookCal.isOutlookCalendarConfigured()) {
    promises.push(
      outlookCal.getEvents(startDate, endDate)
        .then((oEvents) => {
          for (const e of oEvents) {
            events.push({ ...e, source: 'outlook' });
          }
        })
        .catch((err) => {
          logger.error({ err }, 'Failed to fetch Outlook Calendar events');
        })
    );
  }

  await Promise.all(promises);

  // Sort all events by start time
  events.sort((a, b) => {
    const aTime = new Date(a.start).getTime();
    const bTime = new Date(b.start).getTime();
    return aTime - bTime;
  });

  return events;
}

export async function createEvent(
  data: { title: string; start: string; end: string; description?: string },
  target?: CalendarSource
): Promise<UnifiedCalendarEvent> {
  // Default to outlook if configured, else google
  const source = target || (outlookCal.isOutlookCalendarConfigured() ? 'outlook' : 'google');

  if (source === 'outlook') {
    const event = await outlookCal.createEvent(data);
    return { ...event, source: 'outlook' };
  } else {
    const event = await googleCal.createEvent(data);
    return { ...event, source: 'google' };
  }
}

export async function updateEvent(
  data: { event_id: string; new_start?: string; new_end?: string; new_title?: string },
  source: CalendarSource
): Promise<UnifiedCalendarEvent> {
  if (source === 'outlook') {
    const event = await outlookCal.updateEvent(data);
    return { ...event, source: 'outlook' };
  } else {
    const event = await googleCal.updateEvent(data);
    return { ...event, source: 'google' };
  }
}

export async function deleteEvent(eventId: string, source: CalendarSource): Promise<void> {
  if (source === 'outlook') {
    await outlookCal.deleteEvent(eventId);
  } else {
    await googleCal.deleteEvent(eventId);
  }
}
