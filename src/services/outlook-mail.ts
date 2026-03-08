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

// ── Attachment Types ─────────────────────────────────────────────────

export interface OutlookAttachment {
  id: string;
  name: string;
  contentType: string;
  size: number;
  isInline: boolean;
}

export interface AttachmentDownload {
  buffer: Buffer;
  name: string;
  contentType: string;
}

// ── Attachment Functions (for invoice collection) ────────────────────

/**
 * List non-inline attachments for an email.
 * Filters to PDF by default but accepts a custom content type filter.
 */
export async function getAttachments(
  messageId: string,
  contentTypeFilter?: string,
): Promise<OutlookAttachment[]> {
  try {
    const client = getGraphClient();
    const response = await client
      .api(`/me/messages/${messageId}/attachments`)
      .select('id,name,contentType,size,isInline')
      .get();

    const attachments = (response.value || [])
      .filter((att: any) => !att.isInline)  // Skip inline images (signatures, etc.)
      .map((att: any) => ({
        id: att.id || '',
        name: att.name || 'attachment',
        contentType: att.contentType || 'application/octet-stream',
        size: att.size || 0,
        isInline: att.isInline || false,
      }));

    // Apply content type filter if specified (e.g. 'application/pdf')
    if (contentTypeFilter) {
      return attachments.filter((a: OutlookAttachment) =>
        a.contentType.toLowerCase().includes(contentTypeFilter.toLowerCase()),
      );
    }
    return attachments;
  } catch (err) {
    logger.error({ err, messageId }, 'Failed to list Outlook attachments');
    throw err;
  }
}

/**
 * Download a specific attachment as a Buffer.
 * Microsoft Graph returns base64-encoded contentBytes for file attachments.
 */
export async function downloadAttachment(
  messageId: string,
  attachmentId: string,
): Promise<AttachmentDownload> {
  try {
    const client = getGraphClient();
    const att = await client
      .api(`/me/messages/${messageId}/attachments/${attachmentId}`)
      .get();

    if (!att.contentBytes) {
      throw new Error(`Attachment ${attachmentId} has no contentBytes (may be a reference attachment)`);
    }

    return {
      buffer: Buffer.from(att.contentBytes, 'base64'),
      name: att.name || 'attachment',
      contentType: att.contentType || 'application/octet-stream',
    };
  } catch (err) {
    logger.error({ err, messageId, attachmentId }, 'Failed to download Outlook attachment');
    throw err;
  }
}

/**
 * Search emails using OData $filter (precise queries, unlike $search which is full-text).
 *
 * OData filter supports:
 *   - from/emailAddress/address eq 'sender@example.com'
 *   - receivedDateTime ge 2026-01-01T00:00:00Z
 *   - hasAttachments eq true
 *   - contains(subject, 'fatura')
 *
 * Example: searchEmailsByFilter(
 *   "from/emailAddress/address eq 'fatura@viaverde.pt' and receivedDateTime ge 2026-02-01T00:00:00Z and receivedDateTime lt 2026-03-01T00:00:00Z and hasAttachments eq true"
 * )
 */
export async function searchEmailsByFilter(
  filter: string,
  maxResults = 50,
): Promise<OutlookEmail[]> {
  try {
    const client = getGraphClient();
    const response = await client
      .api('/me/messages')
      .filter(filter)
      .top(maxResults)
      .select('id,conversationId,from,toRecipients,subject,bodyPreview,receivedDateTime,isRead,importance,hasAttachments')
      .orderby('receivedDateTime DESC')
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
    logger.error({ err, filter }, 'Failed to search Outlook emails by filter');
    throw err;
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
