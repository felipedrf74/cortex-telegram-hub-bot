import Anthropic from '@anthropic-ai/sdk';
import { DateTime } from 'luxon';
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
  filePath?: string;       // Full local path where file was written
  folderPath?: string;     // Year/month folder name
  filename?: string;
  analysis?: InvoiceAnalysis;
  error?: string;
}

// ─── Configuration Guard ────────────────────────────────────────────

export function isInvoiceFilingConfigured(): boolean {
  return (
    config.invoices.enabled &&
    config.invoices.localPath !== ''
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

/** Resolves the target directory path on the local filesystem. */
export function resolveTargetDirectory(documentDate: string | null): {
  targetDir: string;
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
  const targetDir = path.join(config.invoices.localPath, String(year), monthFolder);

  return { targetDir, year, monthFolder, effectiveDate };
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

// ─── Local Filesystem Filing ────────────────────────────────────────

/**
 * Files an invoice image directly to the local iCloud Drive mount.
 * Creates year/month directories if they don't exist, then writes the file.
 */
export async function fileInvoice(
  imageBuffer: Buffer,
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp',
  analysis: InvoiceAnalysis
): Promise<FilingResult> {
  if (!isInvoiceFilingConfigured()) {
    return { success: false, error: 'Invoice filing is not configured.' };
  }

  const { targetDir, monthFolder, effectiveDate } = resolveTargetDirectory(analysis.documentDate);
  const filename = buildFilename(analysis, mediaType, effectiveDate);
  const filePath = path.join(targetDir, filename);

  try {
    // Create year/month directory (recursive, idempotent)
    fs.mkdirSync(targetDir, { recursive: true });
    logger.debug({ targetDir }, 'Ensured target directory exists');

    // Write the image file directly
    fs.writeFileSync(filePath, imageBuffer);

    logger.info(
      { filePath, vendor: analysis.vendor, date: analysis.documentDate },
      'Invoice filed to iCloud Drive'
    );

    return {
      success: true,
      filePath,
      folderPath: `${effectiveDate.year}/${monthFolder}`,
      filename,
      analysis,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    logger.error({ err, filePath }, 'Failed to file invoice');
    return { success: false, error: message, analysis };
  }
}
