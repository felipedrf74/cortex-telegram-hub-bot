// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { google, gmail_v1 } from 'googleapis';
import { logger } from '../utils/logger';
import { withTimeout } from '../utils/timeout';
import {
  buildGoogleOAuth2Client,
  buildGoogleOAuth2ClientForUser,
  getGoogleRefreshTokenForUser,
  isGoogleConfigured,
  registerGoogleClientReset,
} from './google-auth';

// Gmail API calls are bounded to 15s — same rationale as google-calendar.ts.
// Gmail list + get operations normally respond in <2s. Audit Month 2 #4.
const GMAIL_API_TIMEOUT_MS = 15_000;

let gmailClient: gmail_v1.Gmail | null = null;

// Reset the cached Gmail client when /connect google writes a fresh token.
registerGoogleClientReset(() => { gmailClient = null; });

function getGmail(): gmail_v1.Gmail {
  let contextUserId: number | null = null;
  try {
    const { getCurrentContext } = require('../utils/request-context');
    contextUserId = getCurrentContext()?.userId ?? null;
  } catch { /* outside request context */ }

  if (contextUserId !== null) {
    const oauth2Client = buildGoogleOAuth2ClientForUser(contextUserId);
    return google.gmail({ version: 'v1', auth: oauth2Client });
  }

  if (gmailClient) return gmailClient;
  const oauth2Client = buildGoogleOAuth2Client();
  gmailClient = google.gmail({ version: 'v1', auth: oauth2Client });
  return gmailClient;
}

function getGmailForUser(userId: number): gmail_v1.Gmail {
  const oauth2Client = buildGoogleOAuth2ClientForUser(userId);
  return google.gmail({ version: 'v1', auth: oauth2Client });
}

export function isGmailConfigured(): boolean {
  return isGoogleConfigured();
}

export function isGmailConfiguredForUser(userId: number): boolean {
  return !!getGoogleRefreshTokenForUser(userId);
}

export interface EmailMessage {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  snippet: string;
  date: string;
  body?: string;
}

export interface GmailAttachment {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  attachmentId?: string;
  inlineData?: string;
}

export interface AttachmentDownload {
  buffer: Buffer;
  name: string;
  contentType: string;
}

function decodeBase64Url(value: string): Buffer {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normalized, 'base64');
}

function collectAttachmentParts(
  part: gmail_v1.Schema$MessagePart | undefined,
  acc: GmailAttachment[],
): void {
  if (!part) return;

  const filename = part.filename || '';
  const body = part.body;
  const hasAttachment = !!filename || !!body?.attachmentId;
  if (hasAttachment && body) {
    acc.push({
      id: body.attachmentId || part.partId || filename || `attachment-${acc.length + 1}`,
      filename: filename || 'attachment',
      contentType: part.mimeType || 'application/octet-stream',
      size: body.size || 0,
      attachmentId: body.attachmentId || undefined,
      inlineData: body.data || undefined,
    });
  }

  for (const child of part.parts || []) {
    collectAttachmentParts(child, acc);
  }
}

function getHeader(headers: gmail_v1.Schema$MessagePartHeader[] | undefined, name: string): string {
  return headers?.find((h) => h.name === name)?.value || '';
}

async function searchEmailsWithClient(gmail: gmail_v1.Gmail, query: string, maxResults = 10): Promise<EmailMessage[]> {
  try {
    const messageRefs: gmail_v1.Schema$Message[] = [];
    let pageToken: string | undefined;
    do {
      const response = await withTimeout(
        gmail.users.messages.list({
          userId: 'me',
          q: query,
          maxResults: Math.min(500, Math.max(1, maxResults - messageRefs.length)),
          pageToken,
        }),
        GMAIL_API_TIMEOUT_MS,
      );
      messageRefs.push(...(response.data.messages || []));
      pageToken = response.data.nextPageToken || undefined;
    } while (pageToken && messageRefs.length < maxResults);

    if (messageRefs.length === 0) return [];

    const detailResults = await Promise.allSettled(
      messageRefs.slice(0, maxResults).map((msg) =>
        withTimeout(
          gmail.users.messages.get({
            userId: 'me',
            id: msg.id!,
            format: 'metadata',
            metadataHeaders: ['From', 'To', 'Subject', 'Date'],
          }),
          GMAIL_API_TIMEOUT_MS,
        ).then((detail) => ({
          id: msg.id!,
          threadId: msg.threadId || '',
          from: getHeader(detail.data.payload?.headers, 'From'),
          to: getHeader(detail.data.payload?.headers, 'To'),
          subject: getHeader(detail.data.payload?.headers, 'Subject'),
          snippet: detail.data.snippet || '',
          date: getHeader(detail.data.payload?.headers, 'Date'),
        })),
      ),
    );

    return detailResults.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : [],
    );
  } catch (err) {
    logger.error({ err }, 'Failed to search emails');
    throw err;
  }
}

export async function searchEmails(query: string, maxResults = 10): Promise<EmailMessage[]> {
  return searchEmailsWithClient(getGmail(), query, maxResults);
}

export async function searchEmailsForUser(userId: number, query: string, maxResults = 10): Promise<EmailMessage[]> {
  return searchEmailsWithClient(getGmailForUser(userId), query, maxResults);
}

async function countEmailsWithClient(gmail: gmail_v1.Gmail, query: string): Promise<number> {
  try {
    const response = await withTimeout(
      gmail.users.messages.list({
        userId: 'me',
        q: query,
        maxResults: 1,
      }),
      GMAIL_API_TIMEOUT_MS,
    );

    return response.data.resultSizeEstimate || 0;
  } catch (err) {
    logger.error({ err }, 'Failed to count Gmail emails');
    throw err;
  }
}

export async function countEmails(query: string): Promise<number> {
  return countEmailsWithClient(getGmail(), query);
}

export async function countEmailsForUser(userId: number, query: string): Promise<number> {
  return countEmailsWithClient(getGmailForUser(userId), query);
}

async function readEmailWithClient(gmail: gmail_v1.Gmail, messageId: string): Promise<EmailMessage & { body: string }> {
  try {
    const detail = await withTimeout(
      gmail.users.messages.get({
        userId: 'me',
        id: messageId,
        format: 'full',
      }),
      GMAIL_API_TIMEOUT_MS,
    );

    let body = '';
    const payload = detail.data.payload;
    if (payload?.body?.data) {
      body = decodeBase64Url(payload.body.data).toString('utf-8');
    } else if (payload?.parts) {
      const textPart = payload.parts.find((p) => p.mimeType === 'text/plain');
      if (textPart?.body?.data) {
        body = decodeBase64Url(textPart.body.data).toString('utf-8');
      }
    }

    return {
      id: messageId,
      threadId: detail.data.threadId || '',
      from: getHeader(detail.data.payload?.headers, 'From'),
      to: getHeader(detail.data.payload?.headers, 'To'),
      subject: getHeader(detail.data.payload?.headers, 'Subject'),
      snippet: detail.data.snippet || '',
      date: getHeader(detail.data.payload?.headers, 'Date'),
      body,
    };
  } catch (err) {
    logger.error({ err }, 'Failed to read email');
    throw err;
  }
}

export async function readEmail(messageId: string): Promise<EmailMessage & { body: string }> {
  return readEmailWithClient(getGmail(), messageId);
}

export async function readEmailForUser(userId: number, messageId: string): Promise<EmailMessage & { body: string }> {
  return readEmailWithClient(getGmailForUser(userId), messageId);
}

export async function getAttachments(
  messageId: string,
  contentTypeFilter?: string,
): Promise<GmailAttachment[]> {
  try {
    const gmail = getGmail();
    const detail = await withTimeout(
      gmail.users.messages.get({
        userId: 'me',
        id: messageId,
        format: 'full',
      }),
      GMAIL_API_TIMEOUT_MS,
    );

    const attachments: GmailAttachment[] = [];
    collectAttachmentParts(detail.data.payload, attachments);

    if (!contentTypeFilter) return attachments;
    const filterLower = contentTypeFilter.toLowerCase();
    const ext = filterLower === 'application/pdf' ? '.pdf' : null;
    return attachments.filter((attachment) =>
      attachment.contentType.toLowerCase().includes(filterLower) ||
      (ext && attachment.filename.toLowerCase().endsWith(ext)),
    );
  } catch (err) {
    logger.error({ err, messageId }, 'Failed to list Gmail attachments');
    throw err;
  }
}

export async function downloadAttachment(
  messageId: string,
  attachment: GmailAttachment,
): Promise<AttachmentDownload> {
  try {
    if (attachment.inlineData) {
      return {
        buffer: decodeBase64Url(attachment.inlineData),
        name: attachment.filename || 'attachment',
        contentType: attachment.contentType || 'application/octet-stream',
      };
    }

    if (!attachment.attachmentId) {
      throw new Error(`Attachment ${attachment.id} has no Gmail attachmentId or inline data`);
    }

    const gmail = getGmail();
    const response = await withTimeout(
      gmail.users.messages.attachments.get({
        userId: 'me',
        messageId,
        id: attachment.attachmentId,
      }),
      GMAIL_API_TIMEOUT_MS,
    );

    if (!response.data.data) {
      throw new Error(`Attachment ${attachment.id} has no payload data`);
    }

    return {
      buffer: decodeBase64Url(response.data.data),
      name: attachment.filename || 'attachment',
      contentType: attachment.contentType || 'application/octet-stream',
    };
  } catch (err) {
    logger.error({ err, messageId, attachmentId: attachment.id }, 'Failed to download Gmail attachment');
    throw err;
  }
}
