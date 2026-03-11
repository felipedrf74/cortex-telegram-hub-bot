import { DateTime } from 'luxon';
import { config } from '../config';
import { logger } from '../utils/logger';
import {
  searchEmailsByFilter,
  getAttachments,
  downloadAttachment,
  isOutlookMailConfigured,
  OutlookEmail,
} from './outlook-mail';
import { filePdf, resolveTargetDirectory } from './invoice-filer';
import { recordFiling, isDuplicate, isEmailAlreadyFiled } from '../state/invoice-filings';
import { getActiveVendors } from '../state/invoice-vendors';

// ─── Vendor Configuration ───────────────────────────────────────────

export interface VendorConfig {
  name: string;
  senderPatterns: string[];      // Email domains or addresses to match
  subjectPatterns: string[];     // Subject keywords (any match = invoice)
  builtin: boolean;              // true = hardcoded, false = user-added from DB
}

/** Hardcoded vendors — always present, cannot be removed. */
const BUILTIN_VENDORS: VendorConfig[] = [
  {
    name: 'Santander Consumer',
    senderPatterns: ['santanderconsumer.pt', 'santander.pt'],
    subjectPatterns: ['fatura', 'extrato'],
    builtin: true,
  },
  {
    name: 'ViaVerde',
    senderPatterns: ['viaverde.pt'],
    subjectPatterns: ['fatura', 'extrato', 'extracto'],  // both PT spellings
    builtin: true,
  },
  {
    name: 'Aegon Santander',
    senderPatterns: ['aegon.pt', 'aegonsantander.pt', 'aegon-santander.pt'],
    subjectPatterns: ['seguro', 'fatura', 'recibo'],
    builtin: true,
  },
  {
    name: 'NOS Empresas',
    senderPatterns: ['nos.pt'],
    subjectPatterns: ['fatura', 'NOS'],
    builtin: true,
  },
  {
    name: 'Cofidis',
    senderPatterns: ['cofidis.pt'],
    subjectPatterns: ['fatura'],
    builtin: true,
  },
];

/** Merge hardcoded + user-added vendors from DB. */
export function getAllVendors(): VendorConfig[] {
  const dbVendors = getActiveVendors().map((v) => ({
    name: v.name,
    senderPatterns: [v.sender_pattern],
    subjectPatterns: v.subject_patterns?.split(',').map((s) => s.trim()) || ['fatura'],
    builtin: false,
  }));
  return [...BUILTIN_VENDORS, ...dbVendors];
}

/** Get only the builtin vendors (for display). */
export function getBuiltinVendors(): VendorConfig[] {
  return BUILTIN_VENDORS;
}

// ─── Collection Result Types ────────────────────────────────────────

export interface VendorCollectionResult {
  vendor: string;
  filed: number;
  duplicates: number;
  errors: number;
  details: string[];   // Human-readable log lines for the Telegram notification
}

export interface MonthlyCollectionResult {
  year: number;
  month: number;
  monthLabel: string;          // e.g. "Fev-2026"
  vendors: VendorCollectionResult[];
  totalFiled: number;
  totalDuplicates: number;
  totalErrors: number;
  durationMs: number;
}

// ─── Invoice Number Extraction ──────────────────────────────────────

/**
 * Try to extract an invoice number from an email subject.
 * Common Portuguese patterns: "Fatura n.º 12345", "FT2026/001", "N.º 12345-A"
 */
function extractInvoiceNumber(subject: string): string | null {
  const patterns = [
    /(?:fatura|nf|nfs-?e|recibo)\s*(?:n\.?[ºo°]?\s*|#\s*)([A-Z0-9\-/]+)/i,
    /\b(FT\d{4}\/\d+)\b/,                   // FT2026/001
    /\bn\.?[ºo°]\s*([A-Z0-9\-/]+)/i,        // N.º 12345-A
    /\b(\d{5,})\b/,                           // Fallback: 5+ digit number
  ];

  for (const pattern of patterns) {
    const match = subject.match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

/**
 * Try to extract a document date from an email subject.
 * Patterns: "Fatura Fevereiro 2026", "02/2026", "2026-02"
 */
function extractDateFromSubject(subject: string, fallbackYear: number, fallbackMonth: number): string | null {
  // Portuguese month names → month number
  const ptMonths: Record<string, number> = {
    janeiro: 1, fevereiro: 2, março: 3, marco: 3, abril: 4,
    maio: 5, junho: 6, julho: 7, agosto: 8, setembro: 9,
    outubro: 10, novembro: 11, dezembro: 12,
    jan: 1, fev: 2, mar: 3, abr: 4, mai: 5, jun: 6,
    jul: 7, ago: 8, set: 9, out: 10, nov: 11, dez: 12,
  };

  // "Fevereiro 2026" or "Fev 2026"
  const monthNamePattern = new RegExp(
    `(${Object.keys(ptMonths).join('|')})\\s*(\\d{4})`, 'i',
  );
  const nameMatch = subject.match(monthNamePattern);
  if (nameMatch) {
    const m = ptMonths[nameMatch[1].toLowerCase()];
    const y = parseInt(nameMatch[2], 10);
    if (m && y) return `${y}-${m.toString().padStart(2, '0')}-15`;
  }

  // "02/2026" or "2/2026"
  const slashMatch = subject.match(/\b(\d{1,2})\/(\d{4})\b/);
  if (slashMatch) {
    const m = parseInt(slashMatch[1], 10);
    const y = parseInt(slashMatch[2], 10);
    if (m >= 1 && m <= 12) return `${y}-${m.toString().padStart(2, '0')}-15`;
  }

  // Fallback: use the target month we're collecting for
  return `${fallbackYear}-${fallbackMonth.toString().padStart(2, '0')}-15`;
}

// ─── Client-Side Sender Matching ────────────────────────────────────

/**
 * Check if an email's sender matches any of a vendor's sender patterns.
 * Supports both domain-level ("viaverde.pt") and exact address ("noreply@viaverde.pt") matching.
 *
 * Personal Outlook/Hotmail accounts do NOT support `contains()` in OData $filter,
 * so we fetch all emails with attachments in the month and filter sender client-side.
 *
 * Domain matching extracts the registrable domain from the sender's email and compares
 * against the pattern. E.g. "noreply@docs.santanderconsumer.pt" → matches "santanderconsumer.pt"
 * but NOT "santander.pt" (which would be a different registrable domain).
 */
function senderMatchesVendor(email: OutlookEmail, vendor: VendorConfig): boolean {
  const emailFrom = email.from.toLowerCase();
  // Extract the domain part after @
  const atIdx = emailFrom.indexOf('@');
  if (atIdx === -1) return false;
  const emailDomain = emailFrom.slice(atIdx + 1); // e.g. "docs.aegon-santander.pt"

  return vendor.senderPatterns.some((pattern) => {
    const p = pattern.toLowerCase();
    // Exact address match (pattern contains @)
    if (p.includes('@')) return emailFrom === p;
    // Domain match: the sender's domain must be exactly the pattern OR a subdomain of it
    // e.g. "docs.viaverde.pt" matches "viaverde.pt", but "aegon-santander.pt" does NOT match "santander.pt"
    return emailDomain === p || emailDomain.endsWith(`.${p}`);
  });
}

// ─── Core Collection Logic ──────────────────────────────────────────

/**
 * Collect and file invoices for a single vendor from pre-fetched emails.
 *
 * The caller fetches ALL emails-with-attachments for the month in one Graph API
 * call, then passes them here for client-side sender + subject filtering.
 * This avoids the `contains()` OData limitation on personal Outlook accounts.
 */
async function collectForVendor(
  vendor: VendorConfig,
  allEmails: OutlookEmail[],
  targetYear: number,
  targetMonth: number,
): Promise<VendorCollectionResult> {
  const result: VendorCollectionResult = {
    vendor: vendor.name,
    filed: 0,
    duplicates: 0,
    errors: 0,
    details: [],
  };

  // Client-side: filter emails matching this vendor's sender patterns
  const vendorEmails = allEmails.filter((e) => senderMatchesVendor(e, vendor));

  logger.info(
    { vendor: vendor.name, matched: vendorEmails.length, total: allEmails.length },
    'Filtered emails for vendor',
  );

  for (const email of vendorEmails) {
    // Check if we've already processed this email
    if (isEmailAlreadyFiled(email.id)) {
      result.duplicates++;
      result.details.push(`⏭ Duplicado: ${email.subject}`);
      continue;
    }

    // Check subject matches vendor patterns (email may be from same sender but not an invoice)
    const subjectLower = email.subject.toLowerCase();
    const hasSubjectMatch = vendor.subjectPatterns.some((p) =>
      subjectLower.includes(p.toLowerCase()),
    );
    if (!hasSubjectMatch) {
      logger.debug(
        { subject: email.subject, vendor: vendor.name },
        'Email subject does not match vendor patterns, skipping',
      );
      continue;
    }

    // Get PDF attachments
    let pdfAttachments;
    try {
      pdfAttachments = await getAttachments(email.id, 'application/pdf');
    } catch (err) {
      logger.error({ err, emailId: email.id }, 'Failed to list attachments');
      result.errors++;
      result.details.push(`⚠️ Erro ao ler anexos: ${email.subject}`);
      continue;
    }

    if (pdfAttachments.length === 0) {
      logger.debug({ subject: email.subject }, 'No PDF attachments found');
      continue;
    }

    // Process each PDF attachment
    for (const att of pdfAttachments) {
      // Extract metadata from email subject
      const invoiceNumber = extractInvoiceNumber(email.subject);
      const documentDate = extractDateFromSubject(email.subject, targetYear, targetMonth);

      // Check for duplicate by invoice number
      if (isDuplicate(vendor.name, invoiceNumber)) {
        result.duplicates++;
        result.details.push(`⏭ Duplicado: ${att.name} (${invoiceNumber})`);
        recordFiling({
          vendor: vendor.name,
          invoice_number: invoiceNumber,
          source: 'email',
          source_ref: email.id,
          status: 'duplicate',
        });
        continue;
      }

      // Download and file the PDF
      try {
        const download = await downloadAttachment(email.id, att.id);
        const filingResult = await filePdf(
          download.buffer,
          vendor.name,
          documentDate,
          invoiceNumber,
          att.name,
        );

        if (filingResult.success) {
          result.filed++;
          result.details.push(`✅ ${att.name} → ${filingResult.folderPath}/${filingResult.filename}`);
          recordFiling({
            vendor: vendor.name,
            amount: null,  // Could extract from PDF in Phase 2
            document_date: documentDate,
            invoice_number: invoiceNumber,
            source: 'email',
            source_ref: email.id,
            remote_path: filingResult.filePath,
            folder_path: filingResult.folderPath,
            filename: filingResult.filename,
            file_size_bytes: download.buffer.length,
            status: 'filed',
          });
        } else {
          result.errors++;
          result.details.push(`⚠️ Falha: ${att.name} — ${filingResult.error}`);
          recordFiling({
            vendor: vendor.name,
            document_date: documentDate,
            invoice_number: invoiceNumber,
            source: 'email',
            source_ref: email.id,
            status: 'failed',
            error_message: filingResult.error,
          });
        }
      } catch (err) {
        result.errors++;
        const message = err instanceof Error ? err.message : 'Unknown error';
        result.details.push(`⚠️ Erro: ${att.name} — ${message}`);
        logger.error({ err, emailId: email.id, attachmentId: att.id }, 'Failed to download/file attachment');
      }
    }
  }

  return result;
}

// ─── Monthly Collection Orchestrator ────────────────────────────────

/**
 * Main entry point: collect invoices from all vendors for a given year/month.
 *
 * Called by:
 *   - Monthly cron job (1st of each month for previous month)
 *   - Manual `/invoices [YYYY-MM]` command
 */
export async function collectMonthlyInvoices(
  year: number,
  month: number,
): Promise<MonthlyCollectionResult> {
  const startTime = Date.now();
  const { monthFolder } = resolveTargetDirectory(`${year}-${month.toString().padStart(2, '0')}-15`);

  logger.info({ year, month, monthFolder }, 'Starting monthly invoice collection');

  if (!isOutlookMailConfigured()) {
    logger.warn('Outlook mail not configured, skipping invoice collection');
    return {
      year, month, monthLabel: monthFolder,
      vendors: [],
      totalFiled: 0, totalDuplicates: 0, totalErrors: 0,
      durationMs: Date.now() - startTime,
    };
  }

  // Date range for the target month (UTC for Graph API)
  const startDt = DateTime.fromObject({ year, month, day: 1 }, { zone: 'UTC' });
  const endDt = startDt.plus({ months: 1 });
  const startDate = startDt.toISO()!;
  const endDate = endDt.toISO()!;

  // Fetch ALL emails with attachments in the month in a single Graph API call.
  // Personal Outlook/Hotmail accounts don't support `contains()` in $filter,
  // so we use a simple date range + hasAttachments filter and match senders client-side.
  let allEmails: OutlookEmail[];
  try {
    const filter = `receivedDateTime ge ${startDate} and receivedDateTime lt ${endDate} and hasAttachments eq true`;
    allEmails = await searchEmailsByFilter(filter, 250);
    logger.info(
      { year, month, emailCount: allEmails.length },
      'Fetched emails with attachments for month',
    );
  } catch (err) {
    logger.error({ err, year, month }, 'Failed to fetch monthly emails');
    return {
      year, month, monthLabel: monthFolder,
      vendors: [],
      totalFiled: 0, totalDuplicates: 0, totalErrors: 1,
      durationMs: Date.now() - startTime,
    };
  }

  const vendors = getAllVendors();
  const vendorResults: VendorCollectionResult[] = [];

  for (const vendor of vendors) {
    try {
      const vResult = await collectForVendor(vendor, allEmails, year, month);
      vendorResults.push(vResult);
      logger.info(
        { vendor: vendor.name, filed: vResult.filed, duplicates: vResult.duplicates, errors: vResult.errors },
        'Vendor collection complete',
      );
    } catch (err) {
      logger.error({ err, vendor: vendor.name }, 'Vendor collection failed');
      vendorResults.push({
        vendor: vendor.name,
        filed: 0, duplicates: 0, errors: 1,
        details: [`⚠️ Erro geral: ${err instanceof Error ? err.message : 'Unknown error'}`],
      });
    }
  }

  const totalFiled = vendorResults.reduce((s, v) => s + v.filed, 0);
  const totalDuplicates = vendorResults.reduce((s, v) => s + v.duplicates, 0);
  const totalErrors = vendorResults.reduce((s, v) => s + v.errors, 0);

  logger.info(
    { year, month, totalFiled, totalDuplicates, totalErrors, durationMs: Date.now() - startTime },
    'Monthly invoice collection complete',
  );

  return {
    year, month, monthLabel: monthFolder,
    vendors: vendorResults,
    totalFiled, totalDuplicates, totalErrors,
    durationMs: Date.now() - startTime,
  };
}

// ─── Telegram Notification Formatter ────────────────────────────────

/** Format collection results as a Portuguese Telegram notification. */
export function formatCollectionNotification(result: MonthlyCollectionResult): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lines: string[] = [
    `📊 <b>Recolha de Faturas — ${esc(result.monthLabel)}</b>`,
    '',
  ];

  if (result.vendors.length === 0) {
    lines.push('⚠️ Nenhum fornecedor configurado.');
    return lines.join('\n');
  }

  for (const v of result.vendors) {
    if (v.filed === 0 && v.duplicates === 0 && v.errors === 0) {
      lines.push(`📭 <b>${esc(v.vendor)}</b>: Sem faturas encontradas`);
    } else {
      const parts: string[] = [];
      if (v.filed > 0) parts.push(`✅ ${v.filed} arquivada(s)`);
      if (v.duplicates > 0) parts.push(`⏭ ${v.duplicates} duplicada(s)`);
      if (v.errors > 0) parts.push(`⚠️ ${v.errors} erro(s)`);
      lines.push(`<b>${esc(v.vendor)}</b>: ${parts.join(' · ')}`);

      // Show filed details (truncate if too many)
      const filedDetails = v.details.filter((d) => d.startsWith('✅'));
      for (const detail of filedDetails.slice(0, 3)) {
        lines.push(`  ${esc(detail)}`);
      }
      if (filedDetails.length > 3) {
        lines.push(`  <i>...e mais ${filedDetails.length - 3}</i>`);
      }
    }
  }

  lines.push('');
  lines.push(`📈 <b>Total</b>: ${result.totalFiled} arquivada(s) · ${result.totalDuplicates} duplicada(s) · ${result.totalErrors} erro(s)`);
  lines.push(`⏱ ${Math.round(result.durationMs / 1000)}s`);

  return lines.join('\n');
}
