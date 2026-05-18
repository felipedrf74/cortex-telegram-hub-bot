// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import Anthropic from '@anthropic-ai/sdk';
import { DateTime } from 'luxon';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { config } from '../config';
import { logger } from '../utils/logger';
import { trackedCreate } from '../portal/anthropic-hook';
import { completeVisionOneShotWithFallback } from './gemini-provider';
import { sanitizeForPromptInterpolation } from '../utils/prompt-sanitizer';
import { centsToNumber, parseUserAmount } from './money';

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
  // Item-level validation fields (Option C enhancement)
  itemCount?: number | null;         // How many line items visible
  itemsSum?: string | null;          // Sum of individual item prices
  validationNote?: string | null;    // Discrepancy explanation if any
}

export interface InvoiceAnalysisResult {
  analysis: InvoiceAnalysis;
  provider: string;
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

/** Returns user@host string for SSH/SCP commands. */
function sshTarget(): string {
  return `${config.invoices.sshUser}@${config.invoices.sshHost}`;
}

// ─── Configuration Guard ────────────────────────────────────────────

export function isInvoiceFilingConfigured(): boolean {
  return (
    config.invoices.enabled &&
    config.invoices.sshHost !== '' &&
    config.invoices.sshUser !== '' &&
    config.invoices.remotePath !== ''
  );
}

// ─── Invoice Analysis (Haiku Vision) ────────────────────────────────

/**
 * Single vision call to detect if image is an invoice AND extract
 * structured metadata simultaneously.
 *
 * Gemini-first (gemini-2.5-flash vision) ≈ $0.0001/call, with Anthropic
 * Haiku vision as fallback (~$0.001/call). ~10× cost reduction when
 * Gemini is available, identical output shape either way.
 *
 * The user's caption (if any) goes in the user prompt, not the system
 * prompt, so the model treats it as input data rather than an instruction
 * — important because captions can say things like "is this an invoice?"
 * that we don't want leaking into system-level behavior.
 */
const INVOICE_SYSTEM_PROMPT = `You analyze images to determine if they are invoices, receipts, or payment documents.
Return ONLY valid JSON:
{
  "isInvoice": boolean,
  "confidence": number (0.0-1.0),
  "documentDate": string|null (ISO 8601 "YYYY-MM-DD", null if not found),
  "documentDateRaw": string|null (date exactly as shown on document),
  "vendor": string|null (business/company name),
  "totalAmount": string|null (total with currency, e.g. "€ 45,90"),
  "invoiceNumber": string|null (NF, NFS-e, receipt number),
  "itemCount": number|null (how many line items/products on the receipt),
  "itemsSum": string|null (sum of individual item prices you can read, e.g. "€ 4,38"),
  "validationNote": string|null (if totalAmount != itemsSum, explain the discrepancy)
}

IS an invoice/receipt: nota fiscal, recibo, fatura, comprovante de pagamento, NF-e, NFS-e, receipt, invoice, bill, payment proof, ticket de compra, cupom fiscal.
NOT an invoice: personal photos, selfies, food photos, memes, screenshots of messages, whiteboards, maps, non-financial documents.

For dates: look for "Data:", "Emissão:", "Date:", "Data de emissão:", or any prominent date. Convert to ISO 8601.

For amounts — CRITICAL RULES:
- Extract the FINAL GRAND TOTAL only — the last "Total" at the bottom of the receipt.
- IGNORE subtotals, line item prices, tax-only amounts, and intermediate sums.
- If there are multiple "Total" lines, use the LARGEST one (the final amount paid).
- Include the currency symbol exactly as shown (€, R$, $, £).
- Use the format with comma/period as shown on the document (e.g., "€ 4,38" not "€ 438,00").
- Pay attention to decimal separators: European receipts use comma (4,38 = four euros thirty-eight cents).
- Double-check: does the total make sense for the type of business? A kebab shop total of €438 is almost certainly a misread of €4,38.

VALIDATION — Cross-check the total:
- Count visible line items and sum their individual prices.
- If itemsSum and totalAmount differ by more than 10%, set validationNote explaining why (e.g., "Total €438,00 but only 1 item at €4,38 — likely decimal misread").
- If itemCount is 1-3 but totalAmount > €100, flag as suspicious in validationNote.
- If you're unsure about the decimal placement, prefer the SMALLER amount (€4,38 over €438).`;

export async function analyzeInvoiceImage(
  imageBase64: string,
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp',
  caption?: string
): Promise<InvoiceAnalysisResult> {
  const captionCtx = caption ? `\nCaption from user: ${sanitizeForPromptInterpolation(caption)}` : '';
  const userPrompt = `Analyze this image.${captionCtx}`;

  let rawText: string;
  let usedProvider = 'anthropic-haiku';

  try {
    if (!config.anthropic.apiKey) {
      throw new Error('Anthropic not configured');
    }
    const response = await trackedCreate(client, {
      model: config.anthropic.classifierModel,
      max_tokens: 400,
      system: INVOICE_SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
          { type: 'text', text: userPrompt },
        ],
      }],
    }, 'invoice_filing');
    rawText = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
  } catch (err) {
    logger.warn({ err }, 'Anthropic Haiku invoice analysis failed — falling back to alternate vision providers');
    const fallback = await completeVisionOneShotWithFallback(
      INVOICE_SYSTEM_PROMPT,
      userPrompt,
      { base64: imageBase64, mimeType: mediaType },
      'invoice_filing',
      async () => {
        // Final Anthropic retry in case fallback providers are down but the
        // first call failed due to a transient network or usage issue.
        const response = await trackedCreate(client, {
          model: config.anthropic.classifierModel,
          max_tokens: 400,
          system: INVOICE_SYSTEM_PROMPT,
          messages: [{
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
              { type: 'text', text: userPrompt },
            ],
          }],
        }, 'invoice_filing');
        return response.content
          .filter((b): b is Anthropic.TextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('');
      },
      { maxTokens: 400, temperature: 0 },
    );
    rawText = fallback.text;
    usedProvider = fallback.provider;
  }
  logger.debug({ usedProvider, category: 'invoice_filing' }, 'Invoice analysis provider');

  let text = rawText;

  // Strip markdown fences
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  try {
    const parsed = JSON.parse(text) as InvoiceAnalysis;

    // ── Post-processing validation ──────────────────────────────
    // If the AI flagged a validation issue, or if the amount looks
    // suspicious based on item count, auto-correct when possible.
    if (parsed.totalAmount && parsed.itemsSum) {
      const parseAmount = (s: string): number => {
        try {
          return centsToNumber(parseUserAmount(s, 'EUR'));
        } catch {
          return 0;
        }
      };
      const total = parseAmount(parsed.totalAmount);
      const itemSum = parseAmount(parsed.itemsSum);

      // If items sum to ~X but total is 100× X, likely decimal misread
      if (itemSum > 0 && total > 0 && total / itemSum > 50) {
        logger.warn(
          { total, itemSum, vendor: parsed.vendor, validationNote: parsed.validationNote },
          'Invoice total vs item sum mismatch — auto-correcting to item sum'
        );
        parsed.totalAmount = parsed.itemsSum;
        parsed.confidence = Math.min(parsed.confidence, 0.7); // downgrade confidence
      }
    }

    // Suspicious: few items but very high total (e.g., 1 item at €438)
    if (parsed.itemCount != null && parsed.itemCount <= 3 && parsed.totalAmount) {
      const total = (() => {
        try {
          return centsToNumber(parseUserAmount(parsed.totalAmount, 'EUR'));
        } catch {
          return 0;
        }
      })();
      if (total > 200) {
        parsed.confidence = Math.min(parsed.confidence, 0.6);
        if (!parsed.validationNote) {
          parsed.validationNote = `Suspicious: ${parsed.itemCount} item(s) but total is ${parsed.totalAmount}`;
        }
      }
    }

    logger.info(
      { isInvoice: parsed.isInvoice, confidence: parsed.confidence, vendor: parsed.vendor },
      'Invoice analysis complete'
    );
    return { analysis: parsed, provider: usedProvider };
  } catch (err) {
    logger.warn({ err, responseChars: text.length }, 'Failed to parse invoice analysis JSON');
    return {
      analysis: {
        isInvoice: false, confidence: 0,
        documentDate: null, documentDateRaw: null,
        vendor: null, totalAmount: null, invoiceNumber: null,
      },
      provider: usedProvider,
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

// ─── SSH Connectivity Check ─────────────────────────────────────────

/**
 * Quick SSH connectivity test (5s timeout).
 * Returns true if the tunnel is up and the Mac is reachable.
 */
export function testSshConnection(): boolean {
  if (!isInvoiceFilingConfigured()) return false;
  try {
    const args = ['-o', 'StrictHostKeyChecking=accept-new', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5'];
    if (config.invoices.sshKeyPath) args.push('-i', config.invoices.sshKeyPath);
    if (config.invoices.sshPort !== '22') args.push('-p', config.invoices.sshPort);
    args.push(sshTarget(), 'echo ok');
    execFileSync('ssh', args, { timeout: 8_000, stdio: 'pipe' });
    return true;
  } catch {
    return false;
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
  // SSH: create remote year/month directory on Mac (uses execFileSync to avoid shell injection)
  // Escape single quotes for the remote shell: ' → '\'' (end quote, escaped quote, restart quote)
  const safeRemoteDir = remoteDir.replace(/'/g, "'\\''");
  const sshArgs = ['-o', 'StrictHostKeyChecking=accept-new', '-o', 'BatchMode=yes'];
  if (config.invoices.sshKeyPath) sshArgs.push('-i', config.invoices.sshKeyPath);
  if (config.invoices.sshPort !== '22') sshArgs.push('-p', config.invoices.sshPort);
  sshArgs.push(sshTarget(), `mkdir -p '${safeRemoteDir}'`);
  execFileSync('ssh', sshArgs, { timeout: 15_000, stdio: 'pipe' });
  logger.debug({ remoteDir }, 'Remote directory ensured via SSH');

  // SCP: copy file to Mac's iCloud Drive (uses execFileSync to avoid shell injection)
  const scpArgs = ['-o', 'StrictHostKeyChecking=accept-new', '-o', 'BatchMode=yes'];
  if (config.invoices.sshKeyPath) scpArgs.push('-i', config.invoices.sshKeyPath);
  if (config.invoices.sshPort !== '22') scpArgs.push('-P', config.invoices.sshPort);
  scpArgs.push(localPath, `${sshTarget()}:${remotePath}`);
  execFileSync('scp', scpArgs, { timeout: 30_000, stdio: 'pipe' });
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
