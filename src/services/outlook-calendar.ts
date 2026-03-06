import { Client } from '@microsoft/microsoft-graph-client';
import { PublicClientApplication } from '@azure/msal-node';
import { config } from '../config';
import { logger } from '../utils/logger';
import { CalendarEvent } from './google-calendar';

let graphClient: Client | null = null;
let msalClient: PublicClientApplication | null = null;

function getMsalClient(): PublicClientApplication {
  if (msalClient) return msalClient;

  msalClient = new PublicClientApplication({
    auth: {
      clientId: config.outlook.clientId,
      authority: `https://login.microsoftonline.com/${config.outlook.tenantId}`,
    },
  });

  return msalClient;
}

async function getAccessToken(): Promise<string> {
  const msal = getMsalClient();

  const result = await msal.acquireTokenByRefreshToken({
    refreshToken: config.outlook.refreshToken,
    scopes: ['https://graph.microsoft.com/Calendars.ReadWrite', 'https://graph.microsoft.com/Mail.ReadWrite', 'https://graph.microsoft.com/Mail.Send', 'https://graph.microsoft.com/User.Read'],
  });

  if (!result?.accessToken) {
    throw new Error('Failed to acquire Outlook access token');
  }

  return result.accessToken;
}

function getGraphClient(): Client {
  if (graphClient) return graphClient;

  graphClient = Client.init({
    authProvider: async (done) => {
      try {
        const token = await getAccessToken();
        done(null, token);
      } catch (err) {
        done(err as Error, null);
      }
    },
  });

  return graphClient;
}

export function isOutlookCalendarConfigured(): boolean {
  return !!(config.outlook.clientId && config.outlook.refreshToken);
}

export async function getEvents(startDate: string, endDate: string): Promise<CalendarEvent[]> {
  try {
    const client = getGraphClient();
    const response = await client
      .api('/me/calendarView')
      .query({
        startDateTime: new Date(startDate).toISOString(),
        endDateTime: new Date(endDate).toISOString(),
        $orderby: 'start/dateTime',
        $top: 50,
        $select: 'id,subject,start,end,bodyPreview,location,webLink',
      })
      .header('Prefer', `outlook.timezone="${config.app.timezone}"`)
      .get();

    return (response.value || []).map((event: any) => ({
      id: event.id || '',
      summary: event.subject || '(No title)',
      start: event.start?.dateTime || '',
      end: event.end?.dateTime || '',
      description: event.bodyPreview || undefined,
      location: event.location?.displayName || undefined,
      htmlLink: event.webLink || undefined,
    }));
  } catch (err) {
    logger.error({ err }, 'Failed to fetch Outlook calendar events');
    throw err;
  }
}

export async function createEvent(data: {
  title: string;
  start: string;
  end: string;
  description?: string;
}): Promise<CalendarEvent> {
  try {
    const client = getGraphClient();
    const response = await client.api('/me/events').post({
      subject: data.title,
      start: {
        dateTime: data.start,
        timeZone: config.app.timezone,
      },
      end: {
        dateTime: data.end,
        timeZone: config.app.timezone,
      },
      body: data.description
        ? { contentType: 'Text', content: data.description }
        : undefined,
    });

    return {
      id: response.id || '',
      summary: response.subject || data.title,
      start: response.start?.dateTime || data.start,
      end: response.end?.dateTime || data.end,
      description: response.bodyPreview || undefined,
      htmlLink: response.webLink || undefined,
    };
  } catch (err) {
    logger.error({ err }, 'Failed to create Outlook calendar event');
    throw err;
  }
}

export async function updateEvent(data: {
  event_id: string;
  new_start?: string;
  new_end?: string;
  new_title?: string;
}): Promise<CalendarEvent> {
  try {
    const client = getGraphClient();
    const patch: any = {};

    if (data.new_title) patch.subject = data.new_title;
    if (data.new_start) patch.start = { dateTime: data.new_start, timeZone: config.app.timezone };
    if (data.new_end) patch.end = { dateTime: data.new_end, timeZone: config.app.timezone };

    const response = await client.api(`/me/events/${data.event_id}`).patch(patch);

    return {
      id: response.id || data.event_id,
      summary: response.subject || '',
      start: response.start?.dateTime || '',
      end: response.end?.dateTime || '',
      htmlLink: response.webLink || undefined,
    };
  } catch (err) {
    logger.error({ err }, 'Failed to update Outlook calendar event');
    throw err;
  }
}

export async function deleteEvent(eventId: string): Promise<void> {
  try {
    const client = getGraphClient();
    await client.api(`/me/events/${eventId}`).delete();
  } catch (err) {
    logger.error({ err }, 'Failed to delete Outlook calendar event');
    throw err;
  }
}
