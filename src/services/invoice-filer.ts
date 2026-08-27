// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import Anthropic from '@anthropic-ai/sdk';
import { DateTime } from 'luxon';
import path from 'path';
import sharp from 'sharp';
import { config } from '../config';
import { logger } from '../utils/logger';
import { trackedCreate } from '../portal/anthropic-hook';
import { completeVisionOneShotWithFallback } from './gemini-provider';
import { sanitizeForPromptInterpolation } from '../utils/prompt-sanitizer';
import { centsToNumber, parseUserAmount } from './money';
import { rethrowAiUsageFailClosedError } from './api-usage-fallback';
import {
  buildInvoiceObjectKey,
  isInvoiceObjectStorageConfigured,
  putInvoiceObject,
  type InvoiceStorageBackend,
} from './invoice-object-storage';
import type { InvoiceArtifactWriteIntent } from './invoice-artifact-admission';
import { getPortugueseMonthFolder } from './invoice-paths';

export { PT_MONTHS, getPortugueseMonthFolder } from './invoice-paths';

const client = new Anthropic({
  apiKey: config.anthropic.apiKey,
  maxRetries: 3,
});

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
  filePath?: string;       // Object key
  folderPath?: string;     // Year/month folder name
  filename?: string;
  objectKey?: string;
  checksum?: string;
  mime?: string;
  bytes?: number;
  storageBackend?: InvoiceStorageBackend;
  analysis?: InvoiceAnalysis;
  originalSizeKB?: number;
  compressedSizeKB?: number;
  error?: string;
}

function invoiceConfidenceBucket(confidence: number): 'low' | 'medium' | 'high' {
  if (!Number.isFinite(confidence) || confidence < 0.5) return 'low';
  if (confidence < 0.85) return 'medium';
  return 'high';
}

function safeErrorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

// ─── Configuration Guard ────────────────────────────────────────────

export function isInvoiceFilingConfigured(): boolean {
  return isInvoiceObjectStorageConfigured();
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
  caption?: string,
  options?: { userId?: number; tenantId?: number },
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
    }, 'invoice_filing', options);
    rawText = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
  } catch (err) {
    rethrowAiUsageFailClosedError(err);
    // Do not log provider Error objects here: messages/stacks can echo OCR,
    // image request metadata, or provider response fragments.
    logger.warn(
      { failureCategory: 'primary_receipt_provider_failed' },
      'Anthropic Haiku invoice analysis failed — falling back to alternate vision providers',
    );
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
        }, 'invoice_filing', options);
        return response.content
          .filter((b): b is Anthropic.TextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('');
      },
      { maxTokens: 400, temperature: 0, userId: options?.userId, tenantId: options?.tenantId },
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
          {
            amountMismatchDetected: true,
            amountRatioBucket: 'over_50x',
            hasVendor: Boolean(parsed.vendor),
            hasValidationNote: Boolean(parsed.validationNote),
          },
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
      {
        isInvoice: parsed.isInvoice,
        confidenceBucket: invoiceConfidenceBucket(parsed.confidence),
        hasVendor: Boolean(parsed.vendor),
        hasValidationNote: Boolean(parsed.validationNote),
      },
      'Invoice analysis complete'
    );
    return { analysis: parsed, provider: usedProvider };
  } catch {
    logger.warn(
      { failureCategory: 'invalid_receipt_provider_response', responseChars: text.length },
      'Failed to parse invoice analysis JSON',
    );
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
  effectiveDate: DateTime,
  filingIdentity?: string,
): string {
  const ext = mediaType === 'image/png' ? 'png' : mediaType === 'image/webp' ? 'webp' : 'jpg';
  const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9€.,\-_àáãâéêíóôõúçÀÁÃÂÉÊÍÓÔÕÚÇ]/g, '_').slice(0, 40);

  const deterministicSuffix = filingIdentity ? sanitize(filingIdentity) : '';
  const parts: string[] = [effectiveDate.toFormat('yyyy-MM-dd')];
  if (deterministicSuffix) parts.push(deterministicSuffix);
  if (analysis.vendor) parts.push(sanitize(analysis.vendor));
  if (analysis.totalAmount) parts.push(sanitize(analysis.totalAmount));
  if (analysis.invoiceNumber) parts.push(sanitize(analysis.invoiceNumber));

  // Collision-prevention suffix
  const suffix = deterministicSuffix || Date.now().toString().slice(-6);
  if (!deterministicSuffix) parts.push(suffix);

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
    logger.warn({ errorName: safeErrorName(err) }, 'Image compression failed, using original');
    return { buffer: imageBuffer, compressed: false, originalKB, compressedKB: originalKB };
  }
}

// ─── Object Storage Filing (Images) ─────────────────────────────────

/**
 * Files an invoice image to durable tenant-scoped object storage.
 * Compresses the image with sharp before upload (if enabled).
 */
export async function fileInvoice(
  imageBuffer: Buffer,
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp',
  analysis: InvoiceAnalysis,
  options: {
    tenantId?: number;
    userId?: number;
    filingIdentity?: string;
    writeIntent?: InvoiceArtifactWriteIntent;
  } = {},
): Promise<FilingResult> {
  if (!isInvoiceFilingConfigured()) {
    return { success: false, error: 'Invoice object storage is not configured.' };
  }
  if (!options.tenantId || !options.userId) {
    return { success: false, error: 'tenantId and userId are required for invoice object storage.', analysis };
  }

  const { monthFolder, effectiveDate } = resolveTargetDirectory(analysis.documentDate);
  const filename = buildFilename(analysis, mediaType, effectiveDate, options.filingIdentity);

  const { buffer: finalBuffer, originalKB, compressedKB } =
    await compressImage(imageBuffer, mediaType);

  try {
    const objectKey = buildInvoiceObjectKey({
      tenantId: options.tenantId,
      userId: options.userId,
      documentDate: analysis.documentDate,
      filename,
    });
    const stored = await putInvoiceObject(finalBuffer, objectKey, mediaType, {
      ...(options.writeIntent ? { writeIntent: options.writeIntent } : {}),
    });
    logger.info(
      {
        originalKB,
        compressedKB,
        storageBackend: stored.storageBackend,
      },
      'Invoice image filed to object storage',
    );
    return {
      success: true,
      filePath: stored.objectKey,
      folderPath: `${effectiveDate.year}/${monthFolder}`,
      filename,
      objectKey: stored.objectKey,
      checksum: stored.checksum,
      mime: stored.mime,
      bytes: stored.bytes,
      storageBackend: stored.storageBackend,
      analysis,
      originalSizeKB: originalKB,
      compressedSizeKB: compressedKB,
    };
  } catch (err) {
    logger.error(
      { errorName: safeErrorName(err) },
      'Failed to file invoice image to object storage',
    );
    return { success: false, error: 'Invoice object storage write failed.', analysis };
  }
}

// ─── Object Storage Filing (Email Attachments) ──────────────────────

/** Builds a filesystem-safe PDF filename for email-sourced invoices. */
export function buildPdfFilename(
  vendor: string,
  effectiveDate: DateTime,
  invoiceNumber?: string | null,
  originalName?: string | null,
  filingIdentity?: string,
): string {
  const sanitize = (s: string) =>
    s.replace(/[^a-zA-Z0-9€.,\-_àáãâéêíóôõúçÀÁÃÂÉÊÍÓÔÕÚÇ]/g, '_').slice(0, 40);
  const extensionMatch = originalName?.trim().toLowerCase().match(/\.([a-z0-9]{1,8})$/);
  const extension = extensionMatch?.[1] || 'pdf';

  const deterministicSuffix = filingIdentity ? sanitize(filingIdentity) : '';
  const parts: string[] = [effectiveDate.toFormat('yyyy-MM-dd')];
  if (deterministicSuffix) parts.push(deterministicSuffix);
  parts.push(sanitize(vendor));
  if (invoiceNumber) parts.push(sanitize(invoiceNumber));

  // Use original filename as hint if no invoice number
  if (!invoiceNumber && originalName) {
    const nameWithoutExt = originalName.replace(/\.[^.]+$/i, '');
    parts.push(sanitize(nameWithoutExt));
  }

  const suffix = deterministicSuffix || Date.now().toString().slice(-6);
  if (!deterministicSuffix) parts.push(suffix);

  return `${parts.join('_')}.${extension}`;
}

/**
 * Files an invoice attachment (from email/collector) to durable object storage.
 * Follows the same year/Portuguese-month folder structure as photo invoices.
 */
export async function filePdf(
  pdfBuffer: Buffer,
  vendor: string,
  documentDate: string | null,
  invoiceNumber?: string | null,
  originalName?: string | null,
  options: {
    tenantId?: number;
    userId?: number;
    mime?: string;
    filingIdentity?: string;
    writeIntent?: InvoiceArtifactWriteIntent;
  } = {},
): Promise<FilingResult> {
  if (!isInvoiceFilingConfigured()) {
    return { success: false, error: 'Invoice object storage is not configured.' };
  }
  if (!options.tenantId || !options.userId) {
    return { success: false, error: 'tenantId and userId are required for invoice object storage.' };
  }

  const { monthFolder, effectiveDate } = resolveTargetDirectory(documentDate);
  const filename = buildPdfFilename(
    vendor,
    effectiveDate,
    invoiceNumber,
    originalName,
    options.filingIdentity,
  );
  const mime = options.mime || 'application/pdf';

  try {
    const objectKey = buildInvoiceObjectKey({
      tenantId: options.tenantId,
      userId: options.userId,
      documentDate,
      filename,
    });
    const stored = await putInvoiceObject(pdfBuffer, objectKey, mime, {
      ...(options.writeIntent ? { writeIntent: options.writeIntent } : {}),
    });
    logger.info(
      {
        sizeKB: Math.round(pdfBuffer.length / 1024),
        storageBackend: stored.storageBackend,
      },
      'Invoice attachment filed to object storage',
    );
    return {
      success: true,
      filePath: stored.objectKey,
      folderPath: `${effectiveDate.year}/${monthFolder}`,
      filename,
      objectKey: stored.objectKey,
      checksum: stored.checksum,
      mime: stored.mime,
      bytes: stored.bytes,
      storageBackend: stored.storageBackend,
      originalSizeKB: Math.round(pdfBuffer.length / 1024),
    };
  } catch (err) {
    logger.error(
      { errorName: safeErrorName(err) },
      'Failed to file invoice attachment to object storage',
    );
    return { success: false, error: 'Invoice object storage write failed.' };
  }
}
