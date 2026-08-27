import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  trackedCreate: vi.fn(),
  providerFallback: vi.fn(),
  loggerDebug: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
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
  buildInvoiceObjectKey: vi.fn(),
  getInvoiceObjectBuffer: vi.fn(),
  isInvoiceObjectStorageConfigured: vi.fn(() => false),
  putInvoiceObject: vi.fn(),
  sha256Hex: vi.fn(),
  verifyInvoiceObjectChecksum: vi.fn(),
}));

import { analyzeInvoiceImage } from '../../src/services/invoice-filer';

describe('invoice filer privacy-safe observability', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
