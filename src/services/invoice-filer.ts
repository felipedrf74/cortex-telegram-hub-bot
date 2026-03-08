import Anthropic from '@anthropic-ai/sdk';
import { DateTime } from 'luxon';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { config } from '../config';
import { logger } from '../utils/logger';

const client = new Anthropic({
  apiKey: config.anthropic.apiKey,
  maxRetries: 3,
});

// Portuguese month abbreviations for folder naming
export const PT_MONTHS: Record<number, string> = {
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
  originalSizeKB?: number;
  compressedSizeKB?: number;
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

// ─── Image Compression ──────────────────────────────────────────────

/**
 * Compress an image buffer using sharp.
 * Only uses compressed result if it's actually smaller than the original.
 * Returns { buffer, compressed } where compressed indicates if compression helped.
 */
async function compressImage(
  imageBuffer: Buffer,
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp',
): Promise<{ buffer: Buffer; compressed: boolean; originalKB: number; compressedKB: number }> {
  if (!config.invoices.compressionEnabled) {
    const kb = Math.round(imageBuffer.length / 1024);
    return { buffer: imageBuffer, compressed: false, originalKB: kb, compressedKB: kb };
  }

  const originalKB = Math.round(imageBuffer.length / 1024);

  try {
    let pipeline = sharp(imageBuffer);
    switch (mediaType) {
      case 'image/jpeg':
        pipeline = pipeline.jpeg({ quality: config.invoices.jpegQuality, mozjpeg: true });
        break;
      case 'image/png':
        pipeline = pipeline.png({ compressionLevel: 8 });
        break;
      case 'image/webp':
        pipeline = pipeline.webp({ quality: config.invoices.jpegQuality });
        break;
    }

    const compressedBuffer = await pipeline.toBuffer();
    const compressedKB = Math.round(compressedBuffer.length / 1024);

    // Only use compressed version if it's actually smaller
    if (compressedBuffer.length < imageBuffer.length) {
      const savings = Math.round((1 - compressedBuffer.length / imageBuffer.length) * 100);
      logger.info(
        { originalKB, compressedKB, savings: `${savings}%`, mediaType },
        'Image compressed successfully',
      );
      return { buffer: compressedBuffer, compressed: true, originalKB, compressedKB };
    }

    logger.debug({ originalKB, compressedKB }, 'Compression skipped (would increase size)');
    return { buffer: imageBuffer, compressed: false, originalKB, compressedKB: originalKB };
  } catch (err) {
    logger.warn({ err }, 'Image compression failed, using original');
    return { buffer: imageBuffer, compressed: false, originalKB, compressedKB: originalKB };
  }
}

// ─── SSH/SCP Core ───────────────────────────────────────────────────

/**
 * Core SCP upload: ensures remote directory exists, then copies a local file.
 *
 * SCP quoting note: Modern OpenSSH (9+) uses SFTP internally for SCP,
 * so the remote path is NOT passed through a remote shell. We wrap the
 * entire "user@host:path" in double quotes for the local shell only —
 * no single quotes around the remote path (they'd become literal chars).
 */
function scpUpload(localPath: string, remoteDir: string, remotePath: string): void {
  // SSH: create remote year/month directory on Mac
  // Single quotes around path protect spaces in remote shell
  const mkdirCmd = `${sshPrefix()} ${sshTarget()} "mkdir -p '${remoteDir}'"`;
  execSync(mkdirCmd, { timeout: 15_000, stdio: 'pipe' });
  logger.debug({ remoteDir }, 'Remote directory ensured via SSH');

  // SCP: copy file to Mac's iCloud Drive
  const keyFlag = config.invoices.sshKeyPath ? `-i ${config.invoices.sshKeyPath}` : '';
  const portFlag = scpPortFlag();
  const scpCmd = `scp ${keyFlag} ${portFlag} -o StrictHostKeyChecking=no -o BatchMode=yes "${localPath}" "${sshTarget()}:${remotePath}"`;
  execSync(scpCmd, { timeout: 30_000, stdio: 'pipe' });
}

// ─── SSH/SCP Filing (Images) ────────────────────────────────────────

/**
 * Files an invoice image to iCloud Drive on the Mac via SSH/SCP.
 * Compresses the image with sharp before upload (if enabled).
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

  const ext = mediaType === 'image/png' ? 'png' : mediaType === 'image/webp' ? 'webp' : 'jpg';
  const tmpPath = path.join(tmpdir(), `invoice_${Date.now()}.${ext}`);

  try {
    // Compress image before writing to temp file
    const { buffer: finalBuffer, originalKB, compressedKB } =
      await compressImage(imageBuffer, mediaType);

    fs.writeFileSync(tmpPath, finalBuffer);
    scpUpload(tmpPath, remoteDir, remotePath);

    logger.info(
      { remotePath, vendor: analysis.vendor, date: analysis.documentDate, originalKB, compressedKB },
      'Invoice image filed to iCloud Drive via SCP',
    );

    return {
      success: true,
      filePath: remotePath,
      folderPath: `${effectiveDate.year}/${monthFolder}`,
      filename,
      analysis,
      originalSizeKB: originalKB,
      compressedSizeKB: compressedKB,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    logger.error({ err, remotePath }, 'Failed to file invoice image via SSH/SCP');
    return { success: false, error: message, analysis };
  } finally {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
  }
}

// ─── SSH/SCP Filing (PDFs from email) ───────────────────────────────

/** Builds a filesystem-safe PDF filename for email-sourced invoices. */
export function buildPdfFilename(
  vendor: string,
  effectiveDate: DateTime,
  invoiceNumber?: string | null,
  originalName?: string | null,
): string {
  const sanitize = (s: string) =>
    s.replace(/[^a-zA-Z0-9€.,\-_àáãâéêíóôõúçÀÁÃÂÉÊÍÓÔÕÚÇ]/g, '_').slice(0, 40);

  const parts: string[] = [effectiveDate.toFormat('yyyy-MM-dd')];
  parts.push(sanitize(vendor));
  if (invoiceNumber) parts.push(sanitize(invoiceNumber));

  // Use original filename as hint if no invoice number
  if (!invoiceNumber && originalName) {
    const nameWithoutExt = originalName.replace(/\.pdf$/i, '');
    parts.push(sanitize(nameWithoutExt));
  }

  const suffix = Date.now().toString().slice(-6);
  parts.push(suffix);

  return `${parts.join('_')}.pdf`;
}

/**
 * Files a PDF invoice (from email) to iCloud Drive on the Mac via SSH/SCP.
 * Follows the same year/Portuguese-month folder structure as photo invoices.
 */
export async function filePdf(
  pdfBuffer: Buffer,
  vendor: string,
  documentDate: string | null,
  invoiceNumber?: string | null,
  originalName?: string | null,
): Promise<FilingResult> {
  if (!isInvoiceFilingConfigured()) {
    return { success: false, error: 'Invoice filing is not configured.' };
  }

  const { remoteDir, monthFolder, effectiveDate } = resolveTargetDirectory(documentDate);
  const filename = buildPdfFilename(vendor, effectiveDate, invoiceNumber, originalName);
  const remotePath = `${remoteDir}/${filename}`;

  const tmpPath = path.join(tmpdir(), `invoice_${Date.now()}.pdf`);

  try {
    fs.writeFileSync(tmpPath, pdfBuffer);
    scpUpload(tmpPath, remoteDir, remotePath);

    const sizeKB = Math.round(pdfBuffer.length / 1024);
    logger.info(
      { remotePath, vendor, documentDate, sizeKB },
      'PDF invoice filed to iCloud Drive via SCP',
    );

    return {
      success: true,
      filePath: remotePath,
      folderPath: `${effectiveDate.year}/${monthFolder}`,
      filename,
      originalSizeKB: sizeKB,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    logger.error({ err, remotePath, vendor }, 'Failed to file PDF invoice via SSH/SCP');
    return { success: false, error: message };
  } finally {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
  }
}
