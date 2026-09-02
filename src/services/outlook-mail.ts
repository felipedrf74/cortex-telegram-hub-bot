// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import crypto from 'node:crypto';
import {
  getGraphClient,
  getGraphClientForUser,
  getOutlookRefreshTokenForUser,
  isMicrosoftConfigured,
} from './microsoft-auth';
import { logger } from '../utils/logger';
import { pushEvent } from '../portal/telemetry';

// ─── Email Delivery Logging ──────────────────────────────────────────

/** Log an email send attempt to SQLite (non-critical — swallow errors). */
function logEmailSend(recipient: string, subject: string, status: 'sent' | 'failed', source?: string, errorMessage?: string): void {
  try {
    const { getDb } = require('./database');
    const recipientHash = crypto
      .createHash('sha256')
      .update(recipient.trim().toLowerCase())
      .digest('hex')
      .slice(0, 16);
    const trimmedSubject = subject.trim();
    const subjectSummary = trimmedSubject.length > 40
      ? `${trimmedSubject.slice(0, 40)}… (${trimmedSubject.length} chars)`
      : `${trimmedSubject} (${trimmedSubject.length} chars)`;
    getDb().prepare(`
      INSERT INTO email_log (recipient, subject, status, source, error_message)
      VALUES (?, ?, ?, ?, ?)
    `).run(recipientHash, subjectSummary, status, source ?? null, errorMessage ?? null);
  } catch {
    // table may not exist yet — swallow
  }
}

export function isOutlookMailConfigured(): boolean {
  return isMicrosoftConfigured();
}

export function isOutlookMailConfiguredForUser(userId: number): boolean {
  return !!getOutlookRefreshTokenForUser(userId);
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

export interface OutlookMailWriteInput {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  source?: string;
}

export interface OutlookMailWriteReceipt {
  provider: 'outlook_mail';
  messageId: string;
  internetMessageId: string | null;
  state: 'draft' | 'sent';
  verified: boolean;
  verificationError?: 'draft_read_back_mismatch' | 'sent_read_back_mismatch' | 'sent_read_back_unavailable';
}

type OutlookMailWriteReadBack = {
  id: string;
  internetMessageId: string | null;
  recipients: string[];
  subject: string;
  body: string;
  isDraft: boolean;
  sentDateTime: string | null;
};

type OutlookMailWriteOptions = { signal?: AbortSignal };

const OUTLOOK_MAIL_WRITE_PREFER = 'IdType="ImmutableId", outlook.body-content-type="text"';

function normalizeAddresses(value: string): string[] {
  return value
    .split(',')
    .map((address) => address.trim().toLowerCase())
    .filter(Boolean)
    .sort();
}

function normalizeMailBody(value: string): string {
  return value.replace(/\r\n/g, '\n').trim();
}

function graphMessagePayload(data: OutlookMailWriteInput): Record<string, unknown> {
  return {
    subject: data.subject,
    body: { contentType: 'Text', content: data.body },
    toRecipients: normalizeAddresses(data.to).map((address) => ({ emailAddress: { address } })),
    ...(data.cc
      ? { ccRecipients: normalizeAddresses(data.cc).map((address) => ({ emailAddress: { address } })) }
      : {}),
  };
}

function prepareOutlookMailWriteRequest(request: any, options?: OutlookMailWriteOptions): any {
  const prepared = request.header('Prefer', OUTLOOK_MAIL_WRITE_PREFER);
  if (options?.signal) prepared.option('signal', options.signal);
  return prepared;
}

async function readOutlookMailWriteState(
  client: any,
  messageId: string,
  options?: OutlookMailWriteOptions,
): Promise<OutlookMailWriteReadBack> {
  const msg = await prepareOutlookMailWriteRequest(
    client.api(`/me/messages/${messageId}`),
    options,
  )
    .select('id,internetMessageId,toRecipients,subject,body,isDraft,sentDateTime')
    .get();
  return {
    id: typeof msg?.id === 'string' ? msg.id.trim() : '',
    internetMessageId: typeof msg?.internetMessageId === 'string' ? msg.internetMessageId : null,
    recipients: (Array.isArray(msg?.toRecipients) ? msg.toRecipients : [])
      .map((recipient: any) => String(recipient?.emailAddress?.address || '').trim().toLowerCase())
      .filter(Boolean)
      .sort(),
    subject: String(msg?.subject || ''),
    body: String(msg?.body?.content || ''),
    isDraft: msg?.isDraft === true,
    sentDateTime: typeof msg?.sentDateTime === 'string' && msg.sentDateTime ? msg.sentDateTime : null,
  };
}

function writeFieldsMatch(readBack: OutlookMailWriteReadBack, data: OutlookMailWriteInput): boolean {
  return Boolean(readBack.id)
    && JSON.stringify(readBack.recipients) === JSON.stringify(normalizeAddresses(data.to))
    && readBack.subject.trim() === data.subject.trim()
    && normalizeMailBody(readBack.body) === normalizeMailBody(data.body);
}

async function createOutlookDraftWithClient(
  client: any,
  data: OutlookMailWriteInput,
  options?: OutlookMailWriteOptions,
): Promise<OutlookMailWriteReceipt> {
  const created = await prepareOutlookMailWriteRequest(client.api('/me/messages'), options)
    .post(graphMessagePayload(data));
  const messageId = typeof created?.id === 'string' ? created.id.trim() : '';
  if (!messageId) throw new Error('outlook_draft_id_missing');
  const readBack = await readOutlookMailWriteState(client, messageId, options);
  const verified = readBack.id === messageId && readBack.isDraft && writeFieldsMatch(readBack, data);
  return {
    provider: 'outlook_mail',
    messageId,
    internetMessageId: readBack.internetMessageId,
    state: 'draft',
    verified,
    ...(verified ? {} : { verificationError: 'draft_read_back_mismatch' as const }),
  };
}

/**
 * Creates an Outlook draft for one authenticated user and reads that exact
 * immutable provider object back before allowing callers to claim success.
 */
export async function createOutlookDraftForUser(
  userId: number,
  data: OutlookMailWriteInput,
  options?: OutlookMailWriteOptions,
): Promise<OutlookMailWriteReceipt> {
  return createOutlookDraftWithClient(getGraphClientForUser(userId), data, options);
}

/**
 * Sends through a provider-created draft so the post-send state can be read
 * back by immutable Graph id. A 202/POST alone is never treated as verified.
 */
export async function sendOutlookEmailWithReadBackForUser(
  userId: number,
  data: OutlookMailWriteInput,
  options?: OutlookMailWriteOptions,
): Promise<OutlookMailWriteReceipt> {
  const client = getGraphClientForUser(userId);
  const draft = await createOutlookDraftWithClient(client, data, options);
  if (!draft.verified) return draft;

  await prepareOutlookMailWriteRequest(
    client.api(`/me/messages/${draft.messageId}/send`),
    options,
  )
    .post({});

  let readBack: OutlookMailWriteReadBack;
  try {
    readBack = await readOutlookMailWriteState(client, draft.messageId, options);
  } catch {
    // Graph errors can carry provider response bodies. Keep operational logs
    // to scoped, opaque identifiers and return a stable public error code.
    logger.warn({ userId, messageId: draft.messageId }, 'Outlook sent-message read-back unavailable');
    return {
      ...draft,
      state: 'sent',
      verified: false,
      verificationError: 'sent_read_back_unavailable',
    };
  }
  const verified = readBack.id === draft.messageId
    && !readBack.isDraft
    && Boolean(readBack.sentDateTime)
    && writeFieldsMatch(readBack, data);
  if (verified) {
    logEmailSend(data.to, data.subject, 'sent', data.source);
    pushEvent({
      ts: new Date().toISOString(),
      type: 'job',
      summary: 'Outlook email sent and verified by chat action planner',
    });
  }
  return {
    provider: 'outlook_mail',
    messageId: readBack.id,
    internetMessageId: readBack.internetMessageId,
    state: 'sent',
    verified,
    ...(verified ? {} : { verificationError: 'sent_read_back_mismatch' as const }),
  };
}

function mapGraphMessages(messages: any[]): OutlookEmail[] {
  return (messages || []).map((msg: any) => ({
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

async function searchEmailsWithClient(client: any, query: string, maxResults = 10): Promise<OutlookEmail[]> {
  try {
    const response = await client
      .api('/me/messages')
      .query({
        $search: `"${query}"`,
        $top: maxResults,
        $select: 'id,conversationId,from,toRecipients,subject,bodyPreview,receivedDateTime,isRead,importance',
        $orderby: 'receivedDateTime DESC',
      })
      .get();

    return mapGraphMessages(response.value || []);
  } catch (err) {
    logger.error({ err }, 'Failed to search Outlook emails');
    throw err;
  }
}

export async function searchEmails(query: string, maxResults = 10): Promise<OutlookEmail[]> {
  return searchEmailsWithClient(getGraphClient(), query, maxResults);
}

export async function searchEmailsForUser(userId: number, query: string, maxResults = 10): Promise<OutlookEmail[]> {
  return searchEmailsWithClient(getGraphClientForUser(userId), query, maxResults);
}

async function readEmailWithClient(client: any, messageId: string): Promise<OutlookEmail & { body: string }> {
  try {
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

export async function readEmail(messageId: string): Promise<OutlookEmail & { body: string }> {
  return readEmailWithClient(getGraphClient(), messageId);
}

export async function readEmailForUser(userId: number, messageId: string): Promise<OutlookEmail & { body: string }> {
  return readEmailWithClient(getGraphClientForUser(userId), messageId);
}

export async function sendEmail(data: {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  source?: string;  // job name for tracking
}): Promise<void> {
  return sendEmailWithClient(getGraphClient(), data);
}

export async function sendEmailForUser(userId: number, data: {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  source?: string;
}): Promise<void> {
  return sendEmailWithClient(getGraphClientForUser(userId), data, userId);
}

async function sendEmailWithClient(client: any, data: {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  source?: string;
}, userId?: number): Promise<void> {
  try {
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
    logger.error({ err, userId }, 'Failed to send Outlook email');
    throw err;
  }
}

export async function replyToEmail(data: {
  messageId: string;
  body: string;
}): Promise<void> {
  return replyToEmailWithClient(getGraphClient(), data);
}

export async function replyToEmailForUser(userId: number, data: {
  messageId: string;
  body: string;
}): Promise<void> {
  return replyToEmailWithClient(getGraphClientForUser(userId), data, userId);
}

async function replyToEmailWithClient(client: any, data: {
  messageId: string;
  body: string;
}, userId?: number): Promise<void> {
  try {
    await client.api(`/me/messages/${data.messageId}/reply`).post({
      comment: data.body,
    });
  } catch (err) {
    logger.error({ err, userId }, 'Failed to reply to Outlook email');
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

export async function getUnreadCountForUser(userId: number): Promise<number> {
  try {
    const client = getGraphClientForUser(userId);
    const response = await client
      .api('/me/mailFolders/inbox')
      .select('unreadItemCount')
      .get();
    return response.unreadItemCount || 0;
  } catch (err) {
    logger.error({ err, userId }, 'Failed to get Outlook unread count for user');
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
    const pageSize = Math.min(Math.max(maxResults, 1), 250);

    const fetchPages = async (useOrderBy: boolean): Promise<OutlookEmail[]> => {
      const messages: OutlookEmail[] = [];
      let nextLink: string | null = null;

      do {
        let request: any;
        if (nextLink) {
          request = client.api(nextLink);
        } else {
          request = client
            .api('/me/messages')
            .filter(filter)
            .top(Math.min(pageSize, maxResults - messages.length))
            .select('id,conversationId,from,toRecipients,subject,bodyPreview,receivedDateTime,isRead,importance,hasAttachments');
          if (useOrderBy) request = request.orderby('receivedDateTime DESC');
        }
        const response: any = await request.get();

        messages.push(...mapEmailResponse(response));
        nextLink = response['@odata.nextLink'] || null;
      } while (nextLink && messages.length < maxResults);

      return messages.slice(0, maxResults);
    };

    // Try with $orderby first (works on most accounts)
    try {
      return await fetchPages(true);
    } catch (orderErr: any) {
      // If $orderby + $filter fails, retry without $orderby (personal account fallback)
      if (orderErr?.statusCode === 400) {
        logger.warn('$filter + $orderby failed, retrying without $orderby (personal account fallback)');
        return await fetchPages(false);
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
  return getUnreadEmailsForClient(getGraphClient(), maxResults);
}

async function getUnreadEmailsForClient(client: any, maxResults = 10): Promise<{ count: number; emails: OutlookEmail[] }> {
  try {
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

    const emails: OutlookEmail[] = mapGraphMessages((emailsResp.value || []).map((msg: any) => ({
      ...msg,
      isRead: false,
    })));

    return { count: folderResp.unreadItemCount || 0, emails };
  } catch (err) {
    logger.error({ err }, 'Failed to get unread Outlook emails');
    throw err;
  }
}

export async function getUnreadEmailsForUser(userId: number, maxResults = 10): Promise<{ count: number; emails: OutlookEmail[] }> {
  return getUnreadEmailsForClient(getGraphClientForUser(userId), maxResults);
}
