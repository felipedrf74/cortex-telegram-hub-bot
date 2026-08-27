import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DateTime } from 'luxon';

const mocks = vi.hoisted(() => ({
  trackedCreate: vi.fn(),
  providerFallback: vi.fn(),
  loggerDebug: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
  buildInvoiceObjectKey: vi.fn(),
  objectStorageConfigured: vi.fn(),
  putInvoiceObject: vi.fn(),
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class AnthropicMock {
    constructor(_options: unknown) { /* no network client in this unit test */ }
  },
}));

vi.mock('../../src/config', () => ({
  config: {
    anthropic: { apiKey: 'unit-test-key', classifierModel: 'unit-test-model' },
    app: { timezone: 'Europe/Lisbon' },
    invoices: { remotePath: '/unused', compressionEnabled: false, jpegQuality: 80 },
  },
}));

vi.mock('../../src/utils/logger', () => ({
  LOGGER_REDACTION_PATHS: [],
  logger: {
    debug: (...args: unknown[]) => mocks.loggerDebug(...args),
    info: (...args: unknown[]) => mocks.loggerInfo(...args),
    warn: (...args: unknown[]) => mocks.loggerWarn(...args),
    error: (...args: unknown[]) => mocks.loggerError(...args),
  },
}));

vi.mock('../../src/portal/anthropic-hook', () => ({
  trackedCreate: (...args: unknown[]) => mocks.trackedCreate(...args),
}));

vi.mock('../../src/services/gemini-provider', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/gemini-provider')>(
    '../../src/services/gemini-provider',
  );
  return {
    ...actual,
    completeVisionOneShotWithFallback: (...args: unknown[]) => mocks.providerFallback(...args),
  };
});

vi.mock('../../src/services/invoice-object-storage', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/services/invoice-object-storage')>(),
  buildInvoiceObjectKey: (...args: unknown[]) => mocks.buildInvoiceObjectKey(...args),
  getInvoiceObjectBuffer: vi.fn(),
  isInvoiceObjectStorageConfigured: () => mocks.objectStorageConfigured(),
  putInvoiceObject: (...args: unknown[]) => mocks.putInvoiceObject(...args),
  sha256Hex: vi.fn(),
  verifyInvoiceObjectChecksum: vi.fn(),
}));

import {
  analyzeInvoiceImage,
  buildFilename,
  buildPdfFilename,
  fileInvoice,
  filePdf,
} from '../../src/services/invoice-filer';

describe('invoice filer privacy-safe observability', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.objectStorageConfigured.mockReturnValue(true);
    mocks.buildInvoiceObjectKey.mockReturnValue(
      'invoices/71/71/2026/Ago-2026/queue-identity.pdf',
    );
    mocks.putInvoiceObject.mockResolvedValue({
      objectKey: 'invoices/71/71/2026/Ago-2026/queue-identity.pdf',
      checksum: 'a'.repeat(64),
      mime: 'application/pdf',
      bytes: 19,
      storageBackend: 'filesystem',
    });
  });

  it('builds deterministic image and PDF names while preserving legacy suffix branches', () => {
    const date = DateTime.fromISO('2026-08-27T12:00:00Z');
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_123_456);
    const completeAnalysis = {
      isInvoice: true,
      confidence: 0.9,
      documentDate: '2026-08-27',
      documentDateRaw: '27/08/2026',
      vendor: 'Vendor Name',
      totalAmount: '€12,34',
      invoiceNumber: 'INV/41',
    };

    expect(buildFilename(completeAnalysis, 'image/png', date, 'queue/41')).toBe(
      '2026-08-27_queue_41_Vendor_Name_€12,34_INV_41.png',
    );
    expect(buildFilename({
      ...completeAnalysis,
      vendor: null,
      totalAmount: null,
      invoiceNumber: null,
    }, 'image/webp', date)).toBe('2026-08-27_123456.webp');
    expect(buildFilename(completeAnalysis, 'image/jpeg', date)).toMatch(/\.jpg$/u);

    expect(buildPdfFilename(
      'Vendor Name',
      date,
      'INV/41',
      'scan.Final.PDF',
      'queue/41',
    )).toBe('2026-08-27_queue_41_Vendor_Name_INV_41.pdf');
    expect(buildPdfFilename('Vendor', date, null, null)).toBe(
      '2026-08-27_Vendor_123456.pdf',
    );
    expect(buildPdfFilename('Vendor', date, null, 'scan')).toBe(
      '2026-08-27_Vendor_scan_123456.pdf',
    );
    now.mockRestore();
  });

  it('binds queue identity and write intent into image and PDF object writes', async () => {
    const analysis = {
      isInvoice: true,
      confidence: 0.9,
      documentDate: '2026-08-27',
      documentDateRaw: '27/08/2026',
      vendor: 'Synthetic Vendor',
      totalAmount: null,
      invoiceNumber: null,
    };
    const writeIntent = {
      kind: 'invoice_queue' as const,
      id: '41',
      sourceChecksum: 'b'.repeat(64),
    };

    await expect(fileInvoice(
      Buffer.from('private image bytes'),
      'image/png',
      analysis,
      { tenantId: 71, userId: 71, filingIdentity: 'queue-41', writeIntent },
    )).resolves.toMatchObject({ success: true, storageBackend: 'filesystem' });
    expect(mocks.putInvoiceObject).toHaveBeenLastCalledWith(
      Buffer.from('private image bytes'),
      'invoices/71/71/2026/Ago-2026/queue-identity.pdf',
      'image/png',
      { writeIntent },
    );

    await expect(filePdf(
      Buffer.from('private pdf bytes'),
      'Synthetic Vendor',
      '2026-08-27',
      null,
      null,
      {
        tenantId: 71,
        userId: 71,
        mime: 'application/x-pdf',
        filingIdentity: 'queue-41',
        writeIntent,
      },
    )).resolves.toMatchObject({ success: true, storageBackend: 'filesystem' });
    expect(mocks.putInvoiceObject).toHaveBeenLastCalledWith(
      Buffer.from('private pdf bytes'),
      'invoices/71/71/2026/Ago-2026/queue-identity.pdf',
      'application/x-pdf',
      { writeIntent },
    );

    await expect(fileInvoice(
      Buffer.from('private image bytes'),
      'image/png',
      analysis,
      { tenantId: 71, userId: 71 },
    )).resolves.toMatchObject({ success: true, storageBackend: 'filesystem' });
    expect(mocks.putInvoiceObject).toHaveBeenLastCalledWith(
      Buffer.from('private image bytes'),
      'invoices/71/71/2026/Ago-2026/queue-identity.pdf',
      'image/png',
      {},
    );
  });

  it('fails closed with content-free errors across configuration, scope, and storage failures', async () => {
    mocks.objectStorageConfigured.mockReturnValueOnce(false);
    await expect(filePdf(Buffer.from('pdf'), 'Vendor', null)).resolves.toEqual({
      success: false,
      error: 'Invoice object storage is not configured.',
    });
    await expect(fileInvoice(
      Buffer.from('image'),
      'image/jpeg',
      {
        isInvoice: true,
        confidence: 0.9,
        documentDate: null,
        documentDateRaw: null,
        vendor: null,
        totalAmount: null,
        invoiceNumber: null,
      },
      { tenantId: 0, userId: 71 },
    )).resolves.toEqual({
      success: false,
      error: 'tenantId and userId are required for invoice object storage.',
      analysis: {
        isInvoice: true,
        confidence: 0.9,
        documentDate: null,
        documentDateRaw: null,
        vendor: null,
        totalAmount: null,
        invoiceNumber: null,
      },
    });

    mocks.putInvoiceObject.mockRejectedValueOnce('non-error storage failure');
    await expect(filePdf(
      Buffer.from('pdf'),
      'Vendor',
      null,
      null,
      null,
      { tenantId: 71, userId: 71 },
    )).resolves.toEqual({
      success: false,
      error: 'Invoice object storage write failed.',
    });
    expect(mocks.loggerError).toHaveBeenLastCalledWith(
      { errorName: 'string' },
      'Failed to file invoice attachment to object storage',
    );

    mocks.putInvoiceObject.mockRejectedValueOnce(new TypeError('private storage failure'));
    await expect(filePdf(
      Buffer.from('pdf'),
      'Vendor',
      null,
      null,
      null,
      { tenantId: 71, userId: 71 },
    )).resolves.toMatchObject({ success: false });
    expect(mocks.loggerError).toHaveBeenLastCalledWith(
      { errorName: 'TypeError' },
      'Failed to file invoice attachment to object storage',
    );
  });

  it('logs only safe mismatch indicators and buckets, never extracted receipt values', async () => {
    const sensitiveAnalysis = {
      isInvoice: true,
      confidence: 0.98,
      documentDate: '2026-07-19',
      documentDateRaw: '19/07/2026',
      vendor: 'PRIVATE-MERCHANT-93E20',
      totalAmount: 'EUR 9.876,54',
      invoiceNumber: 'PRIVATE-INVOICE-77',
      itemCount: 2,
      itemsSum: 'EUR 98,76',
      validationNote: 'PRIVATE-VALIDATION-NOTE-4A91',
    };
    mocks.trackedCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: JSON.stringify(sensitiveAnalysis) }],
    });

    const result = await analyzeInvoiceImage(
      Buffer.from('private-image-bytes').toString('base64'),
      'image/jpeg',
      'PRIVATE-OCR-HINT-108C',
      { userId: 71, tenantId: 71 },
    );

    expect(result.analysis.totalAmount).toBe(sensitiveAnalysis.itemsSum);
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      {
        amountMismatchDetected: true,
        amountRatioBucket: 'over_50x',
        hasVendor: true,
        hasValidationNote: true,
      },
      'Invoice total vs item sum mismatch — auto-correcting to item sum',
    );
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      {
        isInvoice: true,
        confidenceBucket: 'medium',
        hasVendor: true,
        hasValidationNote: true,
      },
      'Invoice analysis complete',
    );

    const serializedLogs = JSON.stringify({
      debug: mocks.loggerDebug.mock.calls,
      info: mocks.loggerInfo.mock.calls,
      warn: mocks.loggerWarn.mock.calls,
      error: mocks.loggerError.mock.calls,
    });
    for (const privateValue of [
      sensitiveAnalysis.vendor,
      sensitiveAnalysis.totalAmount,
      sensitiveAnalysis.itemsSum,
      sensitiveAnalysis.validationNote,
      sensitiveAnalysis.invoiceNumber,
      sensitiveAnalysis.documentDateRaw,
      'PRIVATE-OCR-HINT-108C',
    ]) {
      expect(serializedLogs).not.toContain(privateValue);
    }
  });

  it('never logs raw primary-provider errors while falling back', async () => {
    const privateErrorMarker = 'PRIVATE-RECEIPT-PROVIDER-ERROR-7F3A';
    mocks.trackedCreate.mockRejectedValueOnce(new Error(privateErrorMarker));
    mocks.providerFallback.mockResolvedValueOnce({
      provider: 'unit-test-fallback',
      text: JSON.stringify({
        isInvoice: true,
        confidence: 0.9,
        documentDate: '2026-07-19',
        documentDateRaw: '19/07/2026',
        vendor: 'Synthetic Market',
        totalAmount: 'EUR 12.34',
        invoiceNumber: null,
      }),
    });

    await analyzeInvoiceImage(
      Buffer.from('private-image-bytes').toString('base64'),
      'image/jpeg',
      'PRIVATE-OCR-HINT-FALLBACK',
      { userId: 72, tenantId: 72 },
    );

    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      { failureCategory: 'primary_receipt_provider_failed' },
      'Anthropic Haiku invoice analysis failed — falling back to alternate vision providers',
    );
    expect(JSON.stringify(mocks.loggerWarn.mock.calls)).not.toContain(privateErrorMarker);
  });

  it('never logs raw invalid provider output or JSON parser details', async () => {
    const privateOutputMarker = 'PRIVATE-INVALID-RECEIPT-OUTPUT-91C2';
    mocks.trackedCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: `{${privateOutputMarker}` }],
    });

    const result = await analyzeInvoiceImage(
      Buffer.from('private-image-bytes').toString('base64'),
      'image/jpeg',
      'PRIVATE-OCR-HINT-INVALID',
      { userId: 73, tenantId: 73 },
    );

    expect(result.analysis.isInvoice).toBe(false);
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      {
        failureCategory: 'invalid_receipt_provider_response',
        responseChars: privateOutputMarker.length + 1,
      },
      'Failed to parse invoice analysis JSON',
    );
    expect(JSON.stringify(mocks.loggerWarn.mock.calls)).not.toContain(privateOutputMarker);
  });
});
