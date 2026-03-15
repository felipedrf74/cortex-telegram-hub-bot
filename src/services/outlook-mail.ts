import { getGraphClient, isMicrosoftConfigured } from './microsoft-auth';
import { logger } from '../utils/logger';
import { pushEvent } from '../portal/telemetry';

// ─── Email Delivery Logging ──────────────────────────────────────────

/** Log an email send attempt to SQLite (non-critical — swallow errors). */
function logEmailSend(recipient: string, subject: string, status: 'sent' | 'failed', source?: string, errorMessage?: string): void {
  try {
    const { getDb } = require('./database');
    getDb().prepare(`
      INSERT INTO email_log (recipient, subject, status, source, error_message)
      VALUES (?, ?, ?, ?, ?)
    `).run(recipient, subject, status, source ?? null, errorMessage ?? null);
  } catch {
    // table may not exist yet — swallow
  }
}

export function isOutlookMailConfigured(): boolean {
  return isMicrosoftConfigured();
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
  source?: string;  // job name for tracking (e.g. 'fossa_email')
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

    logEmailSend(data.to, data.subject, 'sent', data.source);
    pushEvent({ ts: new Date().toISOString(), type: 'job', summary: `Email sent: "${data.subject}" → ${data.to.split(',')[0]}` });
  } catch (err) {
    logEmailSend(data.to, data.subject, 'failed', data.source, (err as Error)?.message);
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

/**
 * Returns unread count, or -1 if the API call failed.
 * Callers should check for -1 and display a warning instead of "0 unread".
 */
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
    return -1;
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
    // Also match by file extension — many senders tag PDFs as 'application/octet-stream'
    if (contentTypeFilter) {
      const filterLower = contentTypeFilter.toLowerCase();
      const ext = filterLower === 'application/pdf' ? '.pdf' : null;
      return attachments.filter((a: OutlookAttachment) =>
        a.contentType.toLowerCase().includes(filterLower) ||
        (ext && a.name.toLowerCase().endsWith(ext)),
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
 * IMPORTANT: Personal Outlook/Hotmail accounts have limited $filter support:
 *   ✅ receivedDateTime ge/lt (date range)
 *   ✅ hasAttachments eq true
 *   ✅ from/emailAddress/address eq 'exact@email.com'
 *   ❌ contains() / startsWith() — NOT supported on personal accounts
 *   ❌ $filter + $orderby on different fields — may fail on personal accounts
 *
 * For sender domain matching, use client-side filtering after fetching by date range.
 */
export async function searchEmailsByFilter(
  filter: string,
  maxResults = 50,
): Promise<OutlookEmail[]> {
  try {
    const client = getGraphClient();

    // Try with $orderby first (works on most accounts)
    try {
      const response = await client
        .api('/me/messages')
        .filter(filter)
        .top(maxResults)
        .select('id,conversationId,from,toRecipients,subject,bodyPreview,receivedDateTime,isRead,importance,hasAttachments')
        .orderby('receivedDateTime DESC')
        .get();

      return mapEmailResponse(response);
    } catch (orderErr: any) {
      // If $orderby + $filter fails, retry without $orderby (personal account fallback)
      if (orderErr?.statusCode === 400) {
        logger.warn('$filter + $orderby failed, retrying without $orderby (personal account fallback)');
        const response = await client
          .api('/me/messages')
          .filter(filter)
          .top(maxResults)
          .select('id,conversationId,from,toRecipients,subject,bodyPreview,receivedDateTime,isRead,importance,hasAttachments')
          .get();

        return mapEmailResponse(response);
      }
      throw orderErr;
    }
  } catch (err) {
    logger.error({ err, filter }, 'Failed to search Outlook emails by filter');
    throw err;
  }
}

/** Shared mapper for Graph API email responses. */
function mapEmailResponse(response: any): OutlookEmail[] {
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

export async function getUnreadEmails(maxResults = 10): Promise<{ count: number; emails: OutlookEmail[] }> {
  try {
    const client = getGraphClient();
    const [folderResp, emailsResp] = await Promise.all([
      client.api('/me/mailFolders/inbox').select('unreadItemCount').get(),
      client.api('/me/messages')
        .query({
          $filter: 'isRead eq false',
          $top: maxResults,
          $select: 'id,conversationId,from,toRecipients,subject,bodyPreview,receivedDateTime,isRead,importance',
          $orderby: 'receivedDateTime DESC',
        })
        .get(),
    ]);

    const emails: OutlookEmail[] = (emailsResp.value || []).map((msg: any) => ({
      id: msg.id || '',
      conversationId: msg.conversationId || '',
      from: msg.from?.emailAddress?.address || '',
      to: (msg.toRecipients || []).map((r: any) => r.emailAddress?.address).join(', '),
      subject: msg.subject || '(No subject)',
      snippet: msg.bodyPreview || '',
      date: msg.receivedDateTime || '',
      isRead: false,
      importance: msg.importance || 'normal',
    }));

    return { count: folderResp.unreadItemCount || 0, emails };
  } catch (err) {
    logger.error({ err }, 'Failed to get unread Outlook emails');
    throw err;
  }
}
