import Anthropic from '@anthropic-ai/sdk';
import { DateTime } from 'luxon';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import fs from 'fs';
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
  filePath?: string;       // Remote path on Mac
  folderPath?: string;     // Year/month folder name
  filename?: string;
  analysis?: InvoiceAnalysis;
  error?: string;
}

// ─── SSH/SCP Helpers ────────────────────────────────────────────────

/** Builds the base SSH command prefix with key, port, and options. */
function sshPrefix(): string {
  const parts = ['ssh', '-o', 'StrictHostKeyChecking=no', '-o', 'BatchMode=yes'];
  if (config.invoices.sshKeyPath) parts.push('-i', config.invoices.sshKeyPath);
  if (config.invoices.sshPort !== '22') parts.push('-p', config.invoices.sshPort);
  return parts.join(' ');
}

/** SCP uses uppercase -P for port (vs SSH's lowercase -p). */
function scpPortFlag(): string {
  return config.invoices.sshPort !== '22' ? `-P ${config.invoices.sshPort}` : '';
}

/** Returns user@host string for SSH/SCP commands. */
function sshTarget(): string {
  return `${config.invoices.sshUser}@${config.invoices.sshHost}`;
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

/** Resolves the remote target directory on the Mac's iCloud Drive. */
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
 * Files an invoice image to iCloud Drive on the Mac via SSH/SCP.
 *
 * Flow:
 *   1. Write image buffer to a temp file on the server
 *   2. SSH mkdir -p to create year/month folder on Mac
 *   3. SCP the temp file to the Mac's iCloud Drive folder
 *   4. macOS syncs the folder to iCloud automatically
 *
 * SCP quoting note: Modern OpenSSH (9+) uses SFTP internally for SCP,
 * so the remote path is NOT passed through a remote shell. We wrap the
 * entire "user@host:path" in double quotes for the local shell only —
 * no single quotes around the remote path (they'd become literal chars).
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

  // Write to temp file on the server
  const ext = mediaType === 'image/png' ? 'png' : mediaType === 'image/webp' ? 'webp' : 'jpg';
  const tmpPath = path.join(tmpdir(), `invoice_${Date.now()}.${ext}`);

  try {
    fs.writeFileSync(tmpPath, imageBuffer);

    // SSH: create remote year/month directory on Mac
    // Single quotes around path protect spaces in remote shell
    const mkdirCmd = `${sshPrefix()} ${sshTarget()} "mkdir -p '${remoteDir}'"`;
    execSync(mkdirCmd, { timeout: 15_000, stdio: 'pipe' });
    logger.debug({ remoteDir }, 'Remote directory ensured via SSH');

    // SCP: copy file to Mac's iCloud Drive
    // Double quotes wrap the whole "user@host:path" for the local shell.
    // NO single quotes — modern SCP/SFTP treats them as literal characters.
    const keyFlag = config.invoices.sshKeyPath ? `-i ${config.invoices.sshKeyPath}` : '';
    const portFlag = scpPortFlag();
    const scpCmd = `scp ${keyFlag} ${portFlag} -o StrictHostKeyChecking=no -o BatchMode=yes "${tmpPath}" "${sshTarget()}:${remotePath}"`;
    execSync(scpCmd, { timeout: 30_000, stdio: 'pipe' });

    logger.info(
      { remotePath, vendor: analysis.vendor, date: analysis.documentDate },
      'Invoice filed to iCloud Drive via SCP'
    );

    return {
      success: true,
      filePath: remotePath,
      folderPath: `${effectiveDate.year}/${monthFolder}`,
      filename,
      analysis,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    logger.error({ err, remotePath }, 'Failed to file invoice via SSH/SCP');
    return { success: false, error: message, analysis };
  } finally {
    // Always clean up temp file
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
  }
}
