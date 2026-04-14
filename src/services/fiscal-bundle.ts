// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import fs from 'fs';
import path from 'path';
import { DateTime } from 'luxon';
import { config } from '../config';
import { logger } from '../utils/logger';
import { getUserById } from './user-service';
import {
  getOrCreateFiscalCollectionProfile,
  updateFiscalCollectionProfile,
  type FiscalCollectionCadence,
  type FiscalCollectionProfileRow,
} from '../state/fiscal-collection-profiles';
import { getAllVendors, normalizeSenderAddress, subjectMatchesPatterns, senderMatchesPatterns } from './invoice-collector';
import { isConnected } from './oauth-store';
import { sendFiscalBundleEmail, isFiscalBundleDeliveryConfigured } from './email-sender';
import {
  searchEmailsByFilter as searchOutlookEmailsByFilter,
  getAttachments as getOutlookAttachments,
  downloadAttachment as downloadOutlookAttachment,
} from './outlook-mail';
import {
  searchEmails as searchGmailEmails,
  getAttachments as getGmailAttachments,
  downloadAttachment as downloadGmailAttachment,
  type GmailAttachment,
} from './google-gmail';

type FiscalMailProvider = 'outlook' | 'gmail';

export interface FiscalCollectionProviderStatus {
  provider: FiscalMailProvider;
  connected: boolean;
}

export interface FiscalBundleDocument {
  provider: FiscalMailProvider;
  ruleName: string;
  subject: string;
  from: string;
  receivedAt: string;
  filename: string;
  sizeBytes: number;
}

export interface FiscalBundleResult {
  destinationEmail: string;
  periodStart: string;
  periodEnd: string;
  cadence: FiscalCollectionCadence;
  providers: FiscalMailProvider[];
  ruleCount: number;
  totalMatchedEmails: number;
  totalDocuments: number;
  totalBytes: number;
  sent: boolean;
  warnings: string[];
  documents: FiscalBundleDocument[];
}

interface BundleAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

interface BundleCollection {
  providers: FiscalMailProvider[];
  totalMatchedEmails: number;
  totalDocuments: number;
  totalBytes: number;
  warnings: string[];
  documents: FiscalBundleDocument[];
  attachments: BundleAttachment[];
}

interface DemoFiscalAttachment {
  filename: string;
  contentType?: string;
  contentBase64: string;
}

interface DemoFiscalEmail {
  provider: FiscalMailProvider;
  ruleName: string;
  subject: string;
  from: string;
  receivedAt: string;
  attachments: DemoFiscalAttachment[];
}

interface DemoFiscalFixture {
  emails: DemoFiscalEmail[];
}

const MAX_ATTACHMENT_BYTES = 35 * 1024 * 1024;
const FISCAL_BUNDLE_HOUR_UTC = 8;
const SUPPORTED_FISCAL_ATTACHMENT_EXTENSIONS = new Set([
  'pdf',
  'xml',
  'p7m',
  'zip',
  'csv',
  'xls',
  'xlsx',
  'doc',
  'docx',
  'jpg',
  'jpeg',
  'png',
  'heic',
  'heif',
  'tif',
  'tiff',
]);
const SUPPORTED_FISCAL_ATTACHMENT_CONTENT_TYPES = [
  'application/pdf',
  'application/xml',
  'text/xml',
  'application/pkcs7-mime',
  'application/zip',
  'application/x-zip-compressed',
  'text/csv',
  'application/csv',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/heif',
  'image/tiff',
];

function startOfTodayUtc(): DateTime {
  return DateTime.utc().startOf('day');
}

function configuredRunDays(profile: FiscalCollectionProfileRow): number[] {
  return [profile.primary_day, profile.secondary_day]
    .filter((day): day is number => typeof day === 'number')
    .sort((a, b) => a - b);
}

function fiscalDemoFixturePath(userId: number): string {
  const dir = process.env.FISCAL_BUNDLE_DEMO_DIR || './data/fiscal-bundle-demo';
  return path.resolve(process.cwd(), dir, `user-${userId}.json`);
}

function loadFiscalBundleDemoFixture(userId: number): DemoFiscalFixture | null {
  if (!config.isStaging) return null;

  const fixturePath = fiscalDemoFixturePath(userId);
  if (!fs.existsSync(fixturePath)) return null;

  try {
    const raw = fs.readFileSync(fixturePath, 'utf-8');
    const parsed = JSON.parse(raw) as DemoFiscalFixture;
    if (!Array.isArray(parsed.emails)) return null;
    return parsed;
  } catch (err) {
    logger.warn({ err, userId, fixturePath }, 'Fiscal bundle: failed to load demo fixture');
    return null;
  }
}

function scheduledRunAt(base: DateTime, day: number): DateTime {
  return base.set({
    day,
    hour: FISCAL_BUNDLE_HOUR_UTC,
    minute: 0,
    second: 0,
    millisecond: 0,
  }).toUTC();
}

function lastSentAt(profile: FiscalCollectionProfileRow): DateTime | null {
  if (!profile.last_bundle_sent_at) return null;
  const parsed = DateTime.fromISO(profile.last_bundle_sent_at, { zone: 'utc' });
  return parsed.isValid ? parsed.toUTC() : null;
}

function alreadySentForCandidate(profile: FiscalCollectionProfileRow, candidate: DateTime): boolean {
  const sentAt = lastSentAt(profile);
  return !!sentAt && sentAt.hasSame(candidate, 'day');
}

function defaultPeriodStart(profile: FiscalCollectionProfileRow): DateTime {
  if (profile.last_bundle_sent_at) {
    const parsed = DateTime.fromISO(profile.last_bundle_sent_at, { zone: 'utc' });
    if (parsed.isValid) return parsed.plus({ seconds: 1 });
  }
  return startOfTodayUtc().startOf('month');
}

export function computeNextFiscalBundleRun(
  profile: FiscalCollectionProfileRow,
  now: DateTime = startOfTodayUtc(),
): string | null {
  if (!profile.enabled) return null;

  const days = configuredRunDays(profile);
  if (days.length === 0) return null;

  const currentMonth = now.toUTC().startOf('month');
  for (let monthOffset = 0; monthOffset < 12; monthOffset += 1) {
    const monthBase = currentMonth.plus({ months: monthOffset });
    for (const day of days) {
      const candidate = scheduledRunAt(monthBase, day);
      if (candidate < now.startOf('day')) continue;
      if (alreadySentForCandidate(profile, candidate)) continue;
      return candidate.toISO();
    }
  }

  return null;
}

export function isFiscalBundleDue(
  profile: FiscalCollectionProfileRow,
  now: DateTime = DateTime.utc(),
): boolean {
  if (!profile.enabled) return false;

  const candidateDay = configuredRunDays(profile).find((day) => day === now.toUTC().day);
  if (!candidateDay) return false;

  const scheduled = scheduledRunAt(now.toUTC(), candidateDay);
  if (now.toUTC() < scheduled) return false;
  if (alreadySentForCandidate(profile, scheduled)) return false;

  return true;
}

function fiscalProvidersForUser(userId: number): FiscalCollectionProviderStatus[] {
  const realProviders: FiscalCollectionProviderStatus[] = [
    { provider: 'outlook', connected: isConnected(userId, 'outlook') },
    { provider: 'gmail', connected: isConnected(userId, 'google') },
  ];

  if (realProviders.some((provider) => provider.connected)) {
    return realProviders;
  }

  const demoFixture = loadFiscalBundleDemoFixture(userId);
  if (!demoFixture) return realProviders;

  const demoProviders = new Set(demoFixture.emails.map((email) => email.provider));
  return realProviders.map((provider) => ({
    provider: provider.provider,
    connected: demoProviders.has(provider.provider),
  }));
}

export function getFiscalCollectionSummary(userId: number): {
  profile: FiscalCollectionProfileRow;
  destinationEmail: string | null;
  nextRunAt: string | null;
  providers: FiscalCollectionProviderStatus[];
  ruleCount: number;
  customRuleCount: number;
  deliveryAvailable: boolean;
  warnings: string[];
} {
  const profile = getOrCreateFiscalCollectionProfile(userId);
  const user = getUserById(userId);
  const providers = fiscalProvidersForUser(userId);
  const rules = getAllVendors(userId);
  const customRuleCount = rules.filter((rule) => !rule.builtin).length;
  const destinationEmail = profile.destination_email || user?.email || null;

  const warnings: string[] = [];
  if (!destinationEmail) warnings.push('DESTINATION_EMAIL_MISSING');
  if (!providers.some((provider) => provider.connected)) warnings.push('NO_MAIL_PROVIDER_CONNECTED');
  if (!isFiscalBundleDeliveryConfigured()) warnings.push('BUNDLE_DELIVERY_NOT_CONFIGURED');

  return {
    profile,
    destinationEmail,
    nextRunAt: computeNextFiscalBundleRun(profile),
    providers,
    ruleCount: rules.length,
    customRuleCount,
    deliveryAvailable: isFiscalBundleDeliveryConfigured(),
    warnings,
  };
}

function textSummaryForBundle(
  profile: FiscalCollectionProfileRow,
  destinationEmail: string,
  result: BundleCollection,
  periodStart: DateTime,
  periodEnd: DateTime,
): { subject: string; text: string; html: string } {
  const periodLabel = `${periodStart.toFormat('dd LLL yyyy')} – ${periodEnd.toFormat('dd LLL yyyy')}`;
  const providerLabel = result.providers.length > 0 ? result.providers.join(', ') : 'none';
  const docsPreview = result.documents.slice(0, 12).map((doc) =>
    `• ${doc.filename} — ${doc.ruleName} — ${doc.provider.toUpperCase()} — ${doc.receivedAt.slice(0, 10)}`
  ).join('\n');

  const warningLines = result.warnings.length > 0
    ? `Warnings:\n${result.warnings.map((warning) => `- ${warning}`).join('\n')}\n\n`
    : '';

  const text = [
    `Fiscal bundle ready for ${periodLabel}.`,
    '',
    `Cadence: ${profile.cadence}`,
    `Destination: ${destinationEmail}`,
    `Providers scanned: ${providerLabel}`,
    `Matched emails: ${result.totalMatchedEmails}`,
    `Documents attached: ${result.totalDocuments}`,
    '',
    warningLines.trim(),
    docsPreview || 'No documents attached.',
  ].filter(Boolean).join('\n');

  const docsHtml = result.documents.slice(0, 20).map((doc) =>
    `<li><strong>${escapeHtml(doc.filename)}</strong> · ${escapeHtml(doc.ruleName)} · ${doc.provider.toUpperCase()} · ${escapeHtml(doc.receivedAt.slice(0, 10))}</li>`
  ).join('');

  const warningsHtml = result.warnings.length > 0
    ? `<p><strong>Warnings</strong><br>${result.warnings.map((warning) => escapeHtml(warning)).join('<br>')}</p>`
    : '';

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Inter',sans-serif;max-width:620px;margin:0 auto;padding:24px;color:#111827">
      <h2 style="margin-bottom:8px">Fiscal bundle ready</h2>
      <p style="margin-top:0;color:#4B5563">${escapeHtml(periodLabel)}</p>
      <p><strong>Cadence:</strong> ${escapeHtml(profile.cadence)}<br>
      <strong>Destination:</strong> ${escapeHtml(destinationEmail)}<br>
      <strong>Providers scanned:</strong> ${escapeHtml(providerLabel)}<br>
      <strong>Matched emails:</strong> ${result.totalMatchedEmails}<br>
      <strong>Documents attached:</strong> ${result.totalDocuments}</p>
      ${warningsHtml}
      <h3 style="margin-top:24px">Attached documents</h3>
      <ul>${docsHtml || '<li>No documents attached.</li>'}</ul>
    </div>
  `;

  return {
    subject: `Nexus Hub — fiscal bundle (${periodLabel})`,
    text,
    html,
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function dedupePushDocument(
  seen: Set<string>,
  key: string,
  attachmentBytes: number,
  currentBytes: number,
): boolean {
  if (seen.has(key)) return false;
  if ((currentBytes + attachmentBytes) > MAX_ATTACHMENT_BYTES) return false;
  seen.add(key);
  return true;
}

export function isSupportedFiscalAttachment(
  filename: string,
  contentType: string | null | undefined,
): boolean {
  const normalizedFilename = filename.trim().toLowerCase();
  const dotIndex = normalizedFilename.lastIndexOf('.');
  const extension = dotIndex >= 0 ? normalizedFilename.slice(dotIndex + 1) : '';
  if (extension && SUPPORTED_FISCAL_ATTACHMENT_EXTENSIONS.has(extension)) {
    return true;
  }

  const normalizedContentType = (contentType ?? '').trim().toLowerCase();
  return SUPPORTED_FISCAL_ATTACHMENT_CONTENT_TYPES.some((supported) =>
    normalizedContentType.startsWith(supported),
  );
}

function collectDemoDocs(userId: number, start: DateTime, end: DateTime): BundleCollection | null {
  const fixture = loadFiscalBundleDemoFixture(userId);
  if (!fixture) return null;

  const seen = new Set<string>();
  const documents: FiscalBundleDocument[] = [];
  const attachments: BundleAttachment[] = [];
  const warnings: string[] = [];
  const activeProviders = new Set<FiscalMailProvider>();
  let totalMatchedEmails = 0;
  let totalBytes = 0;

  for (const email of fixture.emails) {
    const receivedAt = DateTime.fromISO(email.receivedAt, { zone: 'utc' });
    if (!receivedAt.isValid || receivedAt < start || receivedAt >= end) {
      continue;
    }

    totalMatchedEmails += 1;
    activeProviders.add(email.provider);

    for (const attachment of email.attachments) {
      const contentType = attachment.contentType || 'application/octet-stream';
      if (!isSupportedFiscalAttachment(attachment.filename, contentType)) continue;

      try {
        const buffer = Buffer.from(attachment.contentBase64, 'base64');
        const dedupeKey = `demo:${email.provider}:${email.subject}:${attachment.filename}`;
        if (!dedupePushDocument(seen, dedupeKey, buffer.length, totalBytes)) {
          warnings.push(`DEMO_SKIPPED:${attachment.filename}`);
          continue;
        }

        totalBytes += buffer.length;
        attachments.push({
          filename: attachment.filename,
          content: buffer,
          contentType,
        });
        documents.push({
          provider: email.provider,
          ruleName: email.ruleName,
          subject: email.subject,
          from: normalizeSenderAddress(email.from),
          receivedAt: receivedAt.toUTC().toISO()!,
          filename: attachment.filename,
          sizeBytes: buffer.length,
        });
      } catch (err) {
        warnings.push(`DEMO_ATTACHMENT_DECODE_FAILED:${attachment.filename}`);
      }
    }
  }

  return {
    providers: [...activeProviders],
    totalMatchedEmails,
    totalDocuments: documents.length,
    totalBytes,
    warnings,
    documents,
    attachments,
  };
}

async function collectOutlookDocs(userId: number, start: DateTime, end: DateTime): Promise<BundleCollection> {
  const rules = getAllVendors(userId);
  const warnings: string[] = [];
  const filter = `receivedDateTime ge ${start.toISO()!} and receivedDateTime lt ${end.toISO()!} and hasAttachments eq true`;
  const emails = await searchOutlookEmailsByFilter(filter, 250);

  const seen = new Set<string>();
  const documents: FiscalBundleDocument[] = [];
  const attachments: BundleAttachment[] = [];
  let totalBytes = 0;
  let totalMatchedEmails = 0;

  for (const email of emails) {
    const matchedRule = rules.find((rule) =>
      senderMatchesPatterns(email.from, rule.senderPatterns) &&
      subjectMatchesPatterns(email.subject, rule.subjectPatterns),
    );
    if (!matchedRule) continue;
    totalMatchedEmails += 1;

    let attachmentsForEmail;
    try {
      attachmentsForEmail = (await getOutlookAttachments(email.id)).filter((attachment) =>
        isSupportedFiscalAttachment(attachment.name, attachment.contentType),
      );
    } catch (err) {
      warnings.push(`OUTLOOK_ATTACHMENT_READ_FAILED:${email.id}`);
      continue;
    }

    for (const attachment of attachmentsForEmail) {
      try {
        const downloaded = await downloadOutlookAttachment(email.id, attachment.id);
        const dedupeKey = `outlook:${email.id}:${attachment.name}`;
        if (!dedupePushDocument(seen, dedupeKey, downloaded.buffer.length, totalBytes)) {
          warnings.push(`OUTLOOK_SKIPPED:${attachment.name}`);
          continue;
        }

        totalBytes += downloaded.buffer.length;
        attachments.push({
          filename: downloaded.name,
          content: downloaded.buffer,
          contentType: downloaded.contentType,
        });
        documents.push({
          provider: 'outlook',
          ruleName: matchedRule.name,
          subject: email.subject,
          from: normalizeSenderAddress(email.from),
          receivedAt: DateTime.fromISO(email.date || start.toISO()!, { zone: 'utc' }).toUTC().toISO() ?? start.toISO()!,
          filename: downloaded.name,
          sizeBytes: downloaded.buffer.length,
        });
      } catch {
        warnings.push(`OUTLOOK_ATTACHMENT_DOWNLOAD_FAILED:${attachment.name}`);
      }
    }
  }

  return {
    providers: ['outlook'],
    totalMatchedEmails,
    totalDocuments: documents.length,
    totalBytes,
    warnings,
    documents,
    attachments,
  };
}

async function collectGmailDocs(userId: number, start: DateTime, end: DateTime): Promise<BundleCollection> {
  const rules = getAllVendors(userId);
  const warnings: string[] = [];
  const query = [
    'has:attachment',
    `after:${start.toFormat('yyyy/MM/dd')}`,
    `before:${end.toFormat('yyyy/MM/dd')}`,
  ].join(' ');
  const emails = await searchGmailEmails(query, 200);

  const seen = new Set<string>();
  const documents: FiscalBundleDocument[] = [];
  const attachments: BundleAttachment[] = [];
  let totalBytes = 0;
  let totalMatchedEmails = 0;

  for (const email of emails) {
    const matchedRule = rules.find((rule) =>
      senderMatchesPatterns(email.from, rule.senderPatterns) &&
      subjectMatchesPatterns(email.subject, rule.subjectPatterns),
    );
    if (!matchedRule) continue;
    totalMatchedEmails += 1;

    let attachmentsForEmail: GmailAttachment[];
    try {
      attachmentsForEmail = (await getGmailAttachments(email.id)).filter((attachment) =>
        isSupportedFiscalAttachment(attachment.filename, attachment.contentType),
      );
    } catch {
      warnings.push(`GMAIL_ATTACHMENT_READ_FAILED:${email.id}`);
      continue;
    }

    for (const attachment of attachmentsForEmail) {
      try {
        const downloaded = await downloadGmailAttachment(email.id, attachment);
        const dedupeKey = `gmail:${email.id}:${attachment.filename}`;
        if (!dedupePushDocument(seen, dedupeKey, downloaded.buffer.length, totalBytes)) {
          warnings.push(`GMAIL_SKIPPED:${attachment.filename}`);
          continue;
        }

        totalBytes += downloaded.buffer.length;
        attachments.push({
          filename: downloaded.name,
          content: downloaded.buffer,
          contentType: downloaded.contentType,
        });
        documents.push({
          provider: 'gmail',
          ruleName: matchedRule.name,
          subject: email.subject,
          from: normalizeSenderAddress(email.from),
          receivedAt: DateTime.fromHTTP(email.date || '').isValid
            ? DateTime.fromHTTP(email.date).toUTC().toISO()!
            : start.toISO()!,
          filename: downloaded.name,
          sizeBytes: downloaded.buffer.length,
        });
      } catch {
        warnings.push(`GMAIL_ATTACHMENT_DOWNLOAD_FAILED:${attachment.filename}`);
      }
    }
  }

  return {
    providers: ['gmail'],
    totalMatchedEmails,
    totalDocuments: documents.length,
    totalBytes,
    warnings,
    documents,
    attachments,
  };
}

async function collectBundle(userId: number, start: DateTime, end: DateTime): Promise<BundleCollection> {
  const providers = fiscalProvidersForUser(userId);
  const hasRealProvider = isConnected(userId, 'outlook') || isConnected(userId, 'google');
  if (!hasRealProvider) {
    const demo = collectDemoDocs(userId, start, end);
    if (demo) return demo;
  }

  const warnings: string[] = [];
  const documents: FiscalBundleDocument[] = [];
  const attachments: BundleAttachment[] = [];
  let totalBytes = 0;
  let totalMatchedEmails = 0;
  const activeProviders: FiscalMailProvider[] = [];

  if (providers.find((provider) => provider.provider === 'outlook')?.connected) {
    try {
      const outlook = await collectOutlookDocs(userId, start, end);
      activeProviders.push(...outlook.providers);
      totalMatchedEmails += outlook.totalMatchedEmails;
      totalBytes += outlook.totalBytes;
      warnings.push(...outlook.warnings);
      documents.push(...outlook.documents);
      attachments.push(...outlook.attachments);
    } catch (err) {
      logger.warn({ err, userId }, 'Fiscal bundle: Outlook collection failed');
      warnings.push('OUTLOOK_COLLECTION_FAILED');
    }
  }

  if (providers.find((provider) => provider.provider === 'gmail')?.connected) {
    try {
      const gmail = await collectGmailDocs(userId, start, end);
      activeProviders.push(...gmail.providers);
      totalMatchedEmails += gmail.totalMatchedEmails;
      totalBytes += gmail.totalBytes;
      warnings.push(...gmail.warnings);
      documents.push(...gmail.documents);
      attachments.push(...gmail.attachments);
    } catch (err) {
      logger.warn({ err, userId }, 'Fiscal bundle: Gmail collection failed');
      warnings.push('GMAIL_COLLECTION_FAILED');
    }
  }

  return {
    providers: activeProviders,
    totalMatchedEmails,
    totalDocuments: documents.length,
    totalBytes,
    warnings,
    documents,
    attachments,
  };
}

export async function sendFiscalBundleNow(
  userId: number,
  options?: {
    startAt?: string;
    endAt?: string;
  },
): Promise<FiscalBundleResult> {
  const summary = getFiscalCollectionSummary(userId);
  const { profile } = summary;
  const destinationEmail = summary.destinationEmail;

  if (!destinationEmail) {
    throw new Error('Set a destination email before sending the fiscal bundle.');
  }
  if (!summary.deliveryAvailable) {
    throw new Error('Fiscal bundle delivery is not configured on the server.');
  }

  const start = options?.startAt
    ? DateTime.fromISO(options.startAt, { zone: 'utc' })
    : defaultPeriodStart(profile);
  const end = options?.endAt
    ? DateTime.fromISO(options.endAt, { zone: 'utc' })
    : startOfTodayUtc().endOf('day');

  const collection = await collectBundle(userId, start, end);
  const emailBody = textSummaryForBundle(profile, destinationEmail, collection, start, end);
  const sent = await sendFiscalBundleEmail({
    to: destinationEmail,
    subject: emailBody.subject,
    text: emailBody.text,
    html: emailBody.html,
    attachments: collection.attachments,
  });

  if (!sent) {
    throw new Error('Failed to send the fiscal bundle email.');
  }

  updateFiscalCollectionProfile(userId, {
    last_bundle_sent_at: DateTime.utc().toISO(),
    last_bundle_document_count: collection.totalDocuments,
  });

  return {
    destinationEmail,
    periodStart: start.toUTC().toISO()!,
    periodEnd: end.toUTC().toISO()!,
    cadence: profile.cadence,
    providers: collection.providers,
    ruleCount: summary.ruleCount,
    totalMatchedEmails: collection.totalMatchedEmails,
    totalDocuments: collection.totalDocuments,
    totalBytes: collection.totalBytes,
    sent,
    warnings: collection.warnings,
    documents: collection.documents,
  };
}
