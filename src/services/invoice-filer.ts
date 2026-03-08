import Anthropic from '@anthropic-ai/sdk';
import { DateTime } from 'luxon';
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { config } from '../config';
import { logger } from '../utils/logger';

const client = new Anthropic({
  apiKey: config.anthropic.apiKey,
  maxRetries: 3,
});

// Portuguese month abbreviations for folder naming
const PT_MONTHS: Record<number, string> = {
  1: 'Jan', 2: 'Fev', 3: 'Mar', 4: 'Abr', 5: 'Mai', 6: 'Jun',
  7: 'Jul', 8: 'Ago', 9: 'Set', 10: 'Out', 11: 'Nov', 12: 'Dez',
};

// ─── Types ──────────────────────────────────────────────────────────

export interface InvoiceAnalysis {
  isInvoice: boolean;
  confidence: number;
  documentDate: string | null;       // ISO 8601: "2026-01-15"
  documentDateRaw: string | null;    // As found: "15/01/2026"
  vendor: string | null;
  totalAmount: string | null;
  invoiceNumber: string | null;
}

export interface FilingResult {
  success: boolean;
  remotePath?: string;     // Full remote path on Mac
  folderPath?: string;     // Year/month folder name
  filename?: string;
  analysis?: InvoiceAnalysis;
  error?: string;
}

// ─── Configuration Guard ────────────────────────────────────────────

export function isInvoiceFilingConfigured(): boolean {
  return (
    config.invoices.enabled &&
    config.invoices.sshHost !== '' &&
    config.invoices.remotePath !== ''
  );
}

// ─── Invoice Analysis (Haiku Vision) ────────────────────────────────

/**
 * Single Haiku vision call to detect if image is an invoice AND extract
 * structured metadata simultaneously. Cost: ~$0.001 per call.
 */
export async function analyzeInvoiceImage(
  imageBase64: string,
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp',
  caption?: string
): Promise<InvoiceAnalysis> {
  const captionCtx = caption ? `\nCaption from user: "${caption}"` : '';

  const response = await client.messages.create({
    model: config.anthropic.classifierModel,
    max_tokens: 400,
    system: `You analyze images to determine if they are invoices, receipts, or payment documents.
Return ONLY valid JSON:
{
  "isInvoice": boolean,
  "confidence": number (0.0-1.0),
  "documentDate": string|null (ISO 8601 "YYYY-MM-DD", null if not found),
  "documentDateRaw": string|null (date exactly as shown on document),
  "vendor": string|null (business/company name),
  "totalAmount": string|null (total with currency, e.g. "€ 45,90"),
  "invoiceNumber": string|null (NF, NFS-e, receipt number)
}

IS an invoice/receipt: nota fiscal, recibo, fatura, comprovante de pagamento, NF-e, NFS-e, receipt, invoice, bill, payment proof, ticket de compra, cupom fiscal.
NOT an invoice: personal photos, selfies, food photos, memes, screenshots of messages, whiteboards, maps, non-financial documents.

For dates: look for "Data:", "Emissão:", "Date:", "Data de emissão:", or any prominent date. Convert to ISO 8601.
For amounts: look for "Total:", "Valor:", "Total a pagar:", "Amount:".`,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
        { type: 'text', text: `Analyze this image.${captionCtx}` },
      ],
    }],
  });

  let text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');

  // Strip markdown fences
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  try {
    const parsed = JSON.parse(text) as InvoiceAnalysis;
    logger.info(
      { isInvoice: parsed.isInvoice, confidence: parsed.confidence, vendor: parsed.vendor },
      'Invoice analysis complete'
    );
    return parsed;
  } catch (err) {
    logger.warn({ text, err }, 'Failed to parse invoice analysis JSON');
    return {
      isInvoice: false, confidence: 0,
      documentDate: null, documentDateRaw: null,
      vendor: null, totalAmount: null, invoiceNumber: null,
    };
  }
}

// ─── Path & Filename Helpers ────────────────────────────────────────

/** Returns Portuguese month folder name, e.g. "Mar-2026" */
export function getPortugueseMonthFolder(date: DateTime): string {
  return `${PT_MONTHS[date.month]}-${date.year}`;
}

/** Resolves the remote target directory path on the Mac. */
export function resolveTargetDirectory(documentDate: string | null): {
  remoteDir: string;
  year: number;
  monthFolder: string;
  effectiveDate: DateTime;
} {
  let effectiveDate: DateTime;
  if (documentDate) {
    const parsed = DateTime.fromISO(documentDate, { zone: config.app.timezone });
    effectiveDate = parsed.isValid ? parsed : DateTime.now().setZone(config.app.timezone);
  } else {
    effectiveDate = DateTime.now().setZone(config.app.timezone);
  }

  const year = effectiveDate.year;
  const monthFolder = getPortugueseMonthFolder(effectiveDate);
  const remoteDir = `${config.invoices.remotePath}/${year}/${monthFolder}`;

  return { remoteDir, year, monthFolder, effectiveDate };
}

/** Builds a filesystem-safe, descriptive filename. */
export function buildFilename(
  analysis: InvoiceAnalysis,
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp',
  effectiveDate: DateTime
): string {
  const ext = mediaType === 'image/png' ? 'png' : mediaType === 'image/webp' ? 'webp' : 'jpg';
  const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9€.,\-_àáãâéêíóôõúçÀÁÃÂÉÊÍÓÔÕÚÇ]/g, '_').slice(0, 40);

  const parts: string[] = [effectiveDate.toFormat('yyyy-MM-dd')];
  if (analysis.vendor) parts.push(sanitize(analysis.vendor));
  if (analysis.totalAmount) parts.push(sanitize(analysis.totalAmount));
  if (analysis.invoiceNumber) parts.push(sanitize(analysis.invoiceNumber));

  // Collision-prevention suffix
  const suffix = Date.now().toString().slice(-6);
  parts.push(suffix);

  return `${parts.join('_')}.${ext}`;
}

// ─── SSH/SCP Filing ─────────────────────────────────────────────────

/**
 * Builds the SSH command prefix with key, port, and host.
 * Paths with spaces are handled via shell quoting.
 */
function sshPrefix(): string {
  const { sshHost, sshPort, sshUser, sshKeyPath } = config.invoices;
  const keyFlag = sshKeyPath ? `-i "${sshKeyPath}"` : '';
  const portFlag = sshPort !== 22 ? `-p ${sshPort}` : '';
  const userHost = sshUser ? `${sshUser}@${sshHost}` : sshHost;
  return `${keyFlag} ${portFlag} ${userHost}`.replace(/\s+/g, ' ').trim();
}

/** Returns the SCP port flag (-P for SCP, different from SSH's -p). */
function scpPortFlag(): string {
  return config.invoices.sshPort !== 22 ? `-P ${config.invoices.sshPort}` : '';
}

/**
 * Main filing function. Saves image to temp file on server,
 * creates year/month directory on Mac via SSH, copies file via SCP.
 */
export async function fileInvoice(
  imageBuffer: Buffer,
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp',
  analysis: InvoiceAnalysis
): Promise<FilingResult> {
  if (!isInvoiceFilingConfigured()) {
    return { success: false, error: 'Invoice filing is not configured.' };
  }

  const { remoteDir, monthFolder, effectiveDate } = resolveTargetDirectory(analysis.documentDate);
  const filename = buildFilename(analysis, mediaType, effectiveDate);
  const remotePath = `${remoteDir}/${filename}`;

  // Write to temp file on server
  const ext = mediaType === 'image/png' ? 'png' : mediaType === 'image/webp' ? 'webp' : 'jpg';
  const tmpFile = path.join(os.tmpdir(), `invoice_${Date.now()}.${ext}`);

  try {
    fs.writeFileSync(tmpFile, imageBuffer);

    const prefix = sshPrefix();

    // Create year/month directory on Mac (mkdir -p is idempotent)
    const mkdirCmd = `ssh ${prefix} "mkdir -p '${remoteDir}'"`;
    logger.debug({ cmd: mkdirCmd }, 'Creating remote directory');
    execSync(mkdirCmd, { timeout: 10_000, stdio: 'pipe' });

    // SCP the file to Mac (-P flag for SCP port, different from SSH's -p)
    // Modern SCP uses SFTP internally — no remote shell, so no shell quoting.
    // Wrap the entire user@host:path in double quotes to handle local spaces.
    const scpDest = `${config.invoices.sshUser ? `${config.invoices.sshUser}@` : ''}${config.invoices.sshHost}:${remotePath}`;
    const scpCmd = `scp ${scpPortFlag()} ${config.invoices.sshKeyPath ? `-i "${config.invoices.sshKeyPath}"` : ''} "${tmpFile}" "${scpDest}"`;
    logger.debug({ cmd: scpCmd }, 'SCP file to Mac');
    execSync(scpCmd, { timeout: 30_000, stdio: 'pipe' });

    logger.info(
      { remotePath, vendor: analysis.vendor, date: analysis.documentDate },
      'Invoice filed to iCloud via SCP'
    );

    return {
      success: true,
      remotePath,
      folderPath: `${effectiveDate.year}/${monthFolder}`,
      filename,
      analysis,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    logger.error({ err, remotePath }, 'Failed to file invoice via SCP');
    return { success: false, error: message, analysis };
  } finally {
    // Clean up temp file
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
  }
}
