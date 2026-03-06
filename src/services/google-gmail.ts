import { google, gmail_v1 } from 'googleapis';
import { config } from '../config';
import { logger } from '../utils/logger';

let gmailClient: gmail_v1.Gmail | null = null;

function getGmail(): gmail_v1.Gmail {
  if (gmailClient) return gmailClient;

  if (!config.google.clientId || !config.google.clientSecret || !config.google.refreshToken) {
    throw new Error('Gmail credentials not configured');
  }

  const oauth2Client = new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret
  );
  oauth2Client.setCredentials({ refresh_token: config.google.refreshToken });

  gmailClient = google.gmail({ version: 'v1', auth: oauth2Client });
  return gmailClient;
}

export function isGmailConfigured(): boolean {
  return !!(config.google.clientId && config.google.clientSecret && config.google.refreshToken);
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

export async function searchEmails(query: string, maxResults = 10): Promise<EmailMessage[]> {
  try {
    const gmail = getGmail();
    const response = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults,
    });

    if (!response.data.messages) return [];

    const emails: EmailMessage[] = [];
    for (const msg of response.data.messages.slice(0, maxResults)) {
      const detail = await gmail.users.messages.get({
        userId: 'me',
        id: msg.id!,
        format: 'metadata',
        metadataHeaders: ['From', 'To', 'Subject', 'Date'],
      });

      const headers = detail.data.payload?.headers || [];
      const getHeader = (name: string) => headers.find((h) => h.name === name)?.value || '';

      emails.push({
        id: msg.id!,
        threadId: msg.threadId || '',
        from: getHeader('From'),
        to: getHeader('To'),
        subject: getHeader('Subject'),
        snippet: detail.data.snippet || '',
        date: getHeader('Date'),
      });
    }

    return emails;
  } catch (err) {
    logger.error({ err }, 'Failed to search emails');
    throw err;
  }
}

export async function readEmail(messageId: string): Promise<EmailMessage & { body: string }> {
  try {
    const gmail = getGmail();
    const detail = await gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full',
    });

    const headers = detail.data.payload?.headers || [];
    const getHeader = (name: string) => headers.find((h) => h.name === name)?.value || '';

    let body = '';
    const payload = detail.data.payload;
    if (payload?.body?.data) {
      body = Buffer.from(payload.body.data, 'base64').toString('utf-8');
    } else if (payload?.parts) {
      const textPart = payload.parts.find((p) => p.mimeType === 'text/plain');
      if (textPart?.body?.data) {
        body = Buffer.from(textPart.body.data, 'base64').toString('utf-8');
      }
    }

    return {
      id: messageId,
      threadId: detail.data.threadId || '',
      from: getHeader('From'),
      to: getHeader('To'),
      subject: getHeader('Subject'),
      snippet: detail.data.snippet || '',
      date: getHeader('Date'),
      body,
    };
  } catch (err) {
    logger.error({ err }, 'Failed to read email');
    throw err;
  }
}
