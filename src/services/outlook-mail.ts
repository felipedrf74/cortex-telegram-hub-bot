import { Client } from '@microsoft/microsoft-graph-client';
import { PublicClientApplication } from '@azure/msal-node';
import { config } from '../config';
import { logger } from '../utils/logger';

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

export function isOutlookMailConfigured(): boolean {
  return !!(config.outlook.clientId && config.outlook.refreshToken);
}

export interface OutlookEmail {
  id: string;
  conversationId: string;
  from: string;
  to: string;
  subject: string;
  snippet: string;
  date: string;
  body?: string;
  isRead: boolean;
  importance: string;
}

export async function searchEmails(query: string, maxResults = 10): Promise<OutlookEmail[]> {
  try {
    const client = getGraphClient();
    const response = await client
      .api('/me/messages')
      .query({
        $search: `"${query}"`,
        $top: maxResults,
        $select: 'id,conversationId,from,toRecipients,subject,bodyPreview,receivedDateTime,isRead,importance',
        $orderby: 'receivedDateTime DESC',
      })
      .get();

    return (response.value || []).map((msg: any) => ({
      id: msg.id || '',
      conversationId: msg.conversationId || '',
      from: msg.from?.emailAddress?.address || '',
      to: (msg.toRecipients || []).map((r: any) => r.emailAddress?.address).join(', '),
      subject: msg.subject || '(No subject)',
      snippet: msg.bodyPreview || '',
      date: msg.receivedDateTime || '',
      isRead: msg.isRead || false,
      importance: msg.importance || 'normal',
    }));
  } catch (err) {
    logger.error({ err }, 'Failed to search Outlook emails');
    throw err;
  }
}

export async function readEmail(messageId: string): Promise<OutlookEmail & { body: string }> {
  try {
    const client = getGraphClient();
    const msg = await client
      .api(`/me/messages/${messageId}`)
      .select('id,conversationId,from,toRecipients,subject,bodyPreview,body,receivedDateTime,isRead,importance')
      .get();

    return {
      id: msg.id || messageId,
      conversationId: msg.conversationId || '',
      from: msg.from?.emailAddress?.address || '',
      to: (msg.toRecipients || []).map((r: any) => r.emailAddress?.address).join(', '),
      subject: msg.subject || '(No subject)',
      snippet: msg.bodyPreview || '',
      date: msg.receivedDateTime || '',
      isRead: msg.isRead || false,
      importance: msg.importance || 'normal',
      body: msg.body?.content || '',
    };
  } catch (err) {
    logger.error({ err }, 'Failed to read Outlook email');
    throw err;
  }
}

export async function sendEmail(data: {
  to: string;
  subject: string;
  body: string;
  cc?: string;
}): Promise<void> {
  try {
    const client = getGraphClient();
    const toRecipients = data.to.split(',').map((email) => ({
      emailAddress: { address: email.trim() },
    }));

    const ccRecipients = data.cc
      ? data.cc.split(',').map((email) => ({
          emailAddress: { address: email.trim() },
        }))
      : undefined;

    await client.api('/me/sendMail').post({
      message: {
        subject: data.subject,
        body: { contentType: 'Text', content: data.body },
        toRecipients,
        ccRecipients,
      },
    });
  } catch (err) {
    logger.error({ err }, 'Failed to send Outlook email');
    throw err;
  }
}

export async function replyToEmail(data: {
  messageId: string;
  body: string;
}): Promise<void> {
  try {
    const client = getGraphClient();
    await client.api(`/me/messages/${data.messageId}/reply`).post({
      comment: data.body,
    });
  } catch (err) {
    logger.error({ err }, 'Failed to reply to Outlook email');
    throw err;
  }
}

export async function getUnreadCount(): Promise<number> {
  try {
    const client = getGraphClient();
    const response = await client
      .api('/me/mailFolders/inbox')
      .select('unreadItemCount')
      .get();
    return response.unreadItemCount || 0;
  } catch (err) {
    logger.error({ err }, 'Failed to get Outlook unread count');
    return 0;
  }
}

export async function getRecentEmails(maxResults = 10): Promise<OutlookEmail[]> {
  try {
    const client = getGraphClient();
    const response = await client
      .api('/me/messages')
      .query({
        $top: maxResults,
        $select: 'id,conversationId,from,toRecipients,subject,bodyPreview,receivedDateTime,isRead,importance',
        $orderby: 'receivedDateTime DESC',
      })
      .get();

    return (response.value || []).map((msg: any) => ({
      id: msg.id || '',
      conversationId: msg.conversationId || '',
      from: msg.from?.emailAddress?.address || '',
      to: (msg.toRecipients || []).map((r: any) => r.emailAddress?.address).join(', '),
      subject: msg.subject || '(No subject)',
      snippet: msg.bodyPreview || '',
      date: msg.receivedDateTime || '',
      isRead: msg.isRead || false,
      importance: msg.importance || 'normal',
    }));
  } catch (err) {
    logger.error({ err }, 'Failed to get recent Outlook emails');
    throw err;
  }
}
