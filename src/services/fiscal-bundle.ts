// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import fs from 'fs';
import path from 'path';
import { DateTime } from 'luxon';
import { config } from '../config';
import { logger } from '../utils/logger';
import {
  getOrCreateFiscalCollectionProfile,
  updateFiscalCollectionProfile,
  type FiscalCollectionCadence,
  type FiscalCollectionProfileRow,
} from '../state/fiscal-collection-profiles';
import { getFilingsForPeriod } from '../state/invoice-filings';
import {
  findFiscalBundleSendByIdempotencyKey,
  findFiscalBundleSendForPeriod,
  normalizeFiscalBundleIdempotencyKey,
  recordFiscalBundleSend,
} from '../state/fiscal-bundle-sends';
import { getAllVendors, normalizeSenderAddress, subjectMatchesPatterns, senderMatchesPatterns } from './invoice-collector';
import { verifyInvoiceObjectChecksum } from './invoice-object-storage';
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
type FiscalBundleProvider = FiscalMailProvider | 'filed';

export class FiscalBundleBadRequestError extends Error {
  code = 'BAD_REQUEST';
  status = 400;
}

export interface FiscalCollectionProviderStatus {
  provider: FiscalMailProvider;
  connected: boolean;
}

export interface FiscalBundleDocument {
  provider: FiscalBundleProvider;
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
  providers: FiscalBundleProvider[];
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
  providers: FiscalBundleProvider[];
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
const FISCAL_BUNDLE_HOUR_LOCAL = 8;
const FISCAL_BUNDLE_MISSED_RUN_LOOKBACK_DAYS = 7;
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
  const localBase = base.setZone(config.app.timezone);
  const clampedDay = Math.min(day, localBase.daysInMonth ?? day);
  return localBase.set({
    day: clampedDay,
    hour: FISCAL_BUNDLE_HOUR_LOCAL,
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

function shouldConsiderDueCandidate(scheduled: DateTime, nowUtc: DateTime): boolean {
  if (scheduled > nowUtc) return false;

  const nowLocal = nowUtc.setZone(config.app.timezone);
  const scheduledLocal = scheduled.setZone(config.app.timezone);
  if (scheduledLocal.hasSame(nowLocal, 'month')) return true;

  const previousMonth = nowLocal.startOf('month').minus({ months: 1 });
  if (!scheduledLocal.hasSame(previousMonth, 'month')) return false;

  const daysSinceScheduled = nowLocal
    .startOf('day')
    .diff(scheduledLocal.startOf('day'), 'days')
    .days;
  return daysSinceScheduled >= 0 && daysSinceScheduled <= FISCAL_BUNDLE_MISSED_RUN_LOOKBACK_DAYS;
}

function defaultPeriodStart(profile: FiscalCollectionProfileRow): DateTime {
  if (profile.last_bundle_sent_at) {
    const parsed = DateTime.fromISO(profile.last_bundle_sent_at, { zone: 'utc' });
    if (parsed.isValid) return parsed.plus({ seconds: 1 });
  }
  return startOfTodayUtc().startOf('month');
}

function resolveBundlePeriod(
  profile: FiscalCollectionProfileRow,
  options?: { startAt?: string; endAt?: string },
): { start: DateTime; end: DateTime; isExplicitPeriod: boolean } {
  const hasStart = typeof options?.startAt === 'string' && options.startAt.trim().length > 0;
  const hasEnd = typeof options?.endAt === 'string' && options.endAt.trim().length > 0;
  if (hasStart !== hasEnd) {
    throw new FiscalBundleBadRequestError('startAt and endAt must be provided together.');
  }

  if (!hasStart && !hasEnd) {
    return {
      start: defaultPeriodStart(profile).toUTC(),
      end: startOfTodayUtc().endOf('day').toUTC(),
      isExplicitPeriod: false,
    };
  }

  const start = DateTime.fromISO(options!.startAt!, { zone: 'utc' });
  const end = DateTime.fromISO(options!.endAt!, { zone: 'utc' });
  if (!start.isValid || !end.isValid) {
    throw new FiscalBundleBadRequestError('startAt and endAt must be valid ISO-8601 timestamps.');
  }
  if (start >= end) {
    throw new FiscalBundleBadRequestError('startAt must be before endAt.');
  }
  if (end > DateTime.utc().endOf('day')) {
    throw new FiscalBundleBadRequestError('endAt cannot be in the future.');
  }
  if (end.diff(start, 'months').months > 18) {
    throw new FiscalBundleBadRequestError('Fiscal bundle period cannot exceed 18 months.');
  }

  return {
    start: start.toUTC(),
    end: end.toUTC(),
    isExplicitPeriod: true,
  };
}

function parseStoredFiscalBundleResult(resultJson: string | null): FiscalBundleResult | null {
  if (!resultJson) return null;
  try {
    return JSON.parse(resultJson) as FiscalBundleResult;
  } catch {
    return null;
  }
}

export function computeNextFiscalBundleRun(
  profile: FiscalCollectionProfileRow,
  now: DateTime = startOfTodayUtc(),
): string | null {
  if (!profile.enabled) return null;

  const days = configuredRunDays(profile);
  if (days.length === 0) return null;

  const nowUtc = now.toUTC();
  const currentMonth = nowUtc.setZone(config.app.timezone).startOf('month');
  for (let monthOffset = 0; monthOffset < 12; monthOffset += 1) {
    const monthBase = currentMonth.plus({ months: monthOffset });
    for (const day of days) {
      const candidate = scheduledRunAt(monthBase, day);
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

  const nowUtc = now.toUTC();
  const localMonth = nowUtc.setZone(config.app.timezone).startOf('month');
  const runDays = configuredRunDays(profile);
  const candidates = [-1, 0]
    .flatMap((monthOffset) => runDays.map((day) => scheduledRunAt(localMonth.plus({ months: monthOffset }), day)))
    .filter((scheduled) => shouldConsiderDueCandidate(scheduled, nowUtc))
    .sort((a, b) => b.toMillis() - a.toMillis());

  return candidates.some((scheduled) => !alreadySentForCandidate(profile, scheduled));
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

export function getFiscalCollectionSummary(userId: number, tenantId = userId): {
  profile: FiscalCollectionProfileRow;
  destinationEmail: string | null;
  nextRunAt: string | null;
  providers: FiscalCollectionProviderStatus[];
  ruleCount: number;
  customRuleCount: number;
  deliveryAvailable: boolean;
  warnings: string[];
} {
  const profile = getOrCreateFiscalCollectionProfile(userId, tenantId);
  const providers = fiscalProvidersForUser(userId);
  const rules = getAllVendors(userId, tenantId);
  const customRuleCount = rules.filter((rule) => !rule.builtin).length;
  const destinationEmail = profile.destination_email || null;

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

async function collectOutlookDocs(userId: number, start: DateTime, end: DateTime, tenantId = userId): Promise<BundleCollection> {
  const rules = getAllVendors(userId, tenantId);
  const warnings: string[] = [];
  const filter = `receivedDateTime ge ${start.toISO()!} and receivedDateTime lt ${end.toISO()!} and hasAttachments eq true`;
  const emails = await searchOutlookEmailsByFilter(filter, 2000);
  if (emails.length >= 2000) warnings.push('OUTLOOK_RESULTS_TRUNCATED');

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

  if (emails.length > 0 && rules.length > 0 && totalMatchedEmails === 0) {
    warnings.push('NO_RULE_MATCHED_ANY_EMAIL');
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

async function collectGmailDocs(userId: number, start: DateTime, end: DateTime, tenantId = userId): Promise<BundleCollection> {
  const rules = getAllVendors(userId, tenantId);
  const warnings: string[] = [];
  const query = [
    'has:attachment',
    `after:${Math.floor(start.toUTC().toSeconds())}`,
    `before:${Math.floor(end.toUTC().toSeconds())}`,
  ].join(' ');
  const emails = await searchGmailEmails(query, 2000);
  if (emails.length >= 2000) warnings.push('GMAIL_RESULTS_TRUNCATED');

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

  if (emails.length > 0 && rules.length > 0 && totalMatchedEmails === 0) {
    warnings.push('NO_RULE_MATCHED_ANY_EMAIL');
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

async function collectFiledDocs(
  tenantId: number,
  userId: number,
  start: DateTime,
  end: DateTime,
  existingBytes: number,
  seenDurableKeys: Set<string>,
): Promise<BundleCollection> {
  const filings = getFilingsForPeriod(tenantId, userId, start.toUTC().toISO()!, end.toUTC().toISO()!);
  const warnings: string[] = [];
  const documents: FiscalBundleDocument[] = [];
  const attachments: BundleAttachment[] = [];
  let totalBytes = 0;

  for (const filing of filings) {
    if (!filing.object_key) {
      warnings.push(`FILED_OBJECT_MISSING:${filing.id}`);
      continue;
    }

    const durableKey = filing.checksum
      ? `checksum:${filing.checksum}`
      : filing.source_ref
        ? `source:${filing.source}:${filing.source_ref}`
        : `filing:${filing.id}`;
    if (seenDurableKeys.has(durableKey)) continue;

    try {
      const content = await verifyInvoiceObjectChecksum(
        filing.object_key,
        filing.checksum,
        filing.storage_backend,
      );
      if ((existingBytes + totalBytes + content.length) > MAX_ATTACHMENT_BYTES) {
        warnings.push(`FILED_SKIPPED_SIZE:${filing.id}`);
        continue;
      }

      seenDurableKeys.add(durableKey);
      const filename = filing.filename || path.basename(filing.object_key);
      const contentType = filing.mime || 'application/octet-stream';
      totalBytes += content.length;
      attachments.push({ filename, content, contentType });
      documents.push({
        provider: 'filed',
        ruleName: filing.vendor,
        subject: filing.invoice_number ? `Filed invoice ${filing.invoice_number}` : 'Filed invoice',
        from: filing.source,
        receivedAt: DateTime.fromISO(filing.document_date || filing.created_at, { zone: 'utc' }).toUTC().toISO()!,
        filename,
        sizeBytes: content.length,
      });
    } catch (err) {
      logger.warn({ err, filingId: filing.id }, 'Fiscal bundle: failed to read filed invoice object');
      warnings.push(`FILED_OBJECT_READ_FAILED:${filing.id}`);
    }
  }

  return {
    providers: documents.length > 0 ? ['filed'] : [],
    totalMatchedEmails: 0,
    totalDocuments: documents.length,
    totalBytes,
    warnings,
    documents,
    attachments,
  };
}

function mergeCollection(target: BundleCollection, source: BundleCollection): void {
  for (const provider of source.providers) {
    if (!target.providers.includes(provider)) target.providers.push(provider);
  }
  target.totalMatchedEmails += source.totalMatchedEmails;
  target.totalDocuments += source.totalDocuments;
  target.totalBytes += source.totalBytes;
  target.warnings.push(...source.warnings);
  target.documents.push(...source.documents);
  target.attachments.push(...source.attachments);
}

async function collectBundle(tenantId: number, userId: number, start: DateTime, end: DateTime): Promise<BundleCollection> {
  const providers = fiscalProvidersForUser(userId);
  const hasRealProvider = isConnected(userId, 'outlook') || isConnected(userId, 'google');
  if (!hasRealProvider) {
    const demo = collectDemoDocs(userId, start, end);
    if (demo) return demo;
  }

  const collection: BundleCollection = {
    providers: [],
    totalMatchedEmails: 0,
    totalDocuments: 0,
    totalBytes: 0,
    warnings: [],
    documents: [],
    attachments: [],
  };
  const seenDurableKeys = new Set<string>();

  if (providers.find((provider) => provider.provider === 'outlook')?.connected) {
    try {
      mergeCollection(collection, await collectOutlookDocs(userId, start, end, tenantId));
    } catch (err) {
      logger.warn({ err, userId }, 'Fiscal bundle: Outlook collection failed');
      collection.warnings.push('OUTLOOK_COLLECTION_FAILED');
    }
  }

  if (providers.find((provider) => provider.provider === 'gmail')?.connected) {
    try {
      mergeCollection(collection, await collectGmailDocs(userId, start, end, tenantId));
    } catch (err) {
      logger.warn({ err, userId }, 'Fiscal bundle: Gmail collection failed');
      collection.warnings.push('GMAIL_COLLECTION_FAILED');
    }
  }

  mergeCollection(
    collection,
    await collectFiledDocs(tenantId, userId, start, end, collection.totalBytes, seenDurableKeys),
  );

  if (collection.totalDocuments === 0) {
    collection.warnings.push('NO_FISCAL_DOCUMENTS_FOUND');
  }

  return collection;
}

export async function sendFiscalBundleNow(
  userId: number,
  options?: {
    tenantId?: number;
    startAt?: string;
    endAt?: string;
    idempotencyKey?: string;
  },
): Promise<FiscalBundleResult> {
  const tenantId = options?.tenantId ?? userId;
  const summary = getFiscalCollectionSummary(userId, tenantId);
  const { profile } = summary;
  const destinationEmail = summary.destinationEmail;

  if (!destinationEmail) {
    throw new Error('Set a destination email before sending the fiscal bundle.');
  }
  if (!summary.deliveryAvailable) {
    throw new Error('Fiscal bundle delivery is not configured on the server.');
  }

  const { start, end, isExplicitPeriod } = resolveBundlePeriod(profile, options);
  const periodStart = start.toUTC().toISO()!;
  const periodEnd = end.toUTC().toISO()!;
  const idempotencyKey = normalizeFiscalBundleIdempotencyKey(
    tenantId,
    userId,
    periodStart,
    periodEnd,
    options?.idempotencyKey,
  );

  const existingByKey = findFiscalBundleSendByIdempotencyKey(tenantId, userId, idempotencyKey);
  const existingKeyResult = parseStoredFiscalBundleResult(existingByKey?.result_json ?? null);
  if (existingKeyResult) return existingKeyResult;

  const existingByPeriod = findFiscalBundleSendForPeriod(tenantId, userId, periodStart, periodEnd);
  const existingPeriodResult = parseStoredFiscalBundleResult(existingByPeriod?.result_json ?? null);
  if (existingPeriodResult) {
    return {
      ...existingPeriodResult,
      warnings: [...new Set([...existingPeriodResult.warnings, 'FISCAL_BUNDLE_PERIOD_ALREADY_SENT'])],
    };
  }

  const collection = await collectBundle(tenantId, userId, start, end);
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

  const result: FiscalBundleResult = {
    destinationEmail,
    periodStart,
    periodEnd,
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

  recordFiscalBundleSend({
    tenantId,
    userId,
    periodStart,
    periodEnd,
    documentCount: collection.totalDocuments,
    totalBytes: collection.totalBytes,
    idempotencyKey,
    resultJson: JSON.stringify(result),
  });

  if (!isExplicitPeriod) {
    updateFiscalCollectionProfile(userId, {
      last_bundle_sent_at: DateTime.utc().toISO(),
      last_bundle_document_count: collection.totalDocuments,
    }, tenantId);
  }

  return result;
}
