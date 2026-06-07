import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetActiveVendors = vi.fn();
const mockAreGlobalInvoiceVendorsEnabled = vi.fn();
const mockSearchEmailsByFilter = vi.fn();
const mockGetAttachments = vi.fn();
const mockDownloadAttachment = vi.fn();
const mockIsOutlookMailConfigured = vi.fn(() => false);
const mockFilePdf = vi.fn();

vi.mock('../../src/state/invoice-vendors', () => ({
  getActiveVendors: (...args: unknown[]) => mockGetActiveVendors(...args),
}));

vi.mock('../../src/services/runtime-flags', () => ({
  areGlobalInvoiceVendorsEnabled: (...args: unknown[]) => mockAreGlobalInvoiceVendorsEnabled(...args),
}));

vi.mock('../../src/services/outlook-mail', () => ({
  searchEmailsByFilter: (...args: unknown[]) => mockSearchEmailsByFilter(...args),
  getAttachments: (...args: unknown[]) => mockGetAttachments(...args),
  downloadAttachment: (...args: unknown[]) => mockDownloadAttachment(...args),
  isOutlookMailConfigured: (...args: unknown[]) => mockIsOutlookMailConfigured(...args),
}));

vi.mock('../../src/services/invoice-filer', () => ({
  filePdf: (...args: unknown[]) => mockFilePdf(...args),
  resolveTargetDirectory: vi.fn(() => ({ monthFolder: 'Abr-2026', remoteDir: '/tmp' })),
}));

vi.mock('../../src/state/invoice-filings', () => ({
  recordFiling: vi.fn(),
  isDuplicate: vi.fn(() => false),
  isEmailAlreadyFiled: vi.fn(() => false),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

import {
  getAllVendors,
  getBuiltinVendors,
  collectMonthlyInvoices,
  senderMatchesPatterns,
  subjectMatchesPatterns,
} from '../../src/services/invoice-collector';

describe('invoice collector vendor policy', () => {
  beforeEach(() => {
    mockGetActiveVendors.mockReset();
    mockAreGlobalInvoiceVendorsEnabled.mockReset();
    mockSearchEmailsByFilter.mockReset();
    mockGetAttachments.mockReset();
    mockDownloadAttachment.mockReset();
    mockIsOutlookMailConfigured.mockReset();
    mockFilePdf.mockReset();
    mockAreGlobalInvoiceVendorsEnabled.mockReturnValue(false);
    mockIsOutlookMailConfigured.mockReturnValue(false);
    mockGetActiveVendors.mockReturnValue([
      {
        name: 'Jaqueline Energia',
        sender_pattern: 'energia.example',
        subject_patterns: 'fatura,recibo',
      },
    ]);
  });

  it('does not apply legacy global built-in vendors unless explicitly enabled', () => {
    const vendors = getAllVendors(44);

    expect(mockGetActiveVendors).toHaveBeenCalledWith(44, 44);
    expect(vendors).toEqual([
      {
        name: 'Jaqueline Energia',
        senderPatterns: ['energia.example'],
        subjectPatterns: ['fatura', 'recibo'],
        builtin: false,
      },
    ]);
  });

  it('keeps the legacy built-in vendor list behind an explicit runtime flag', () => {
    mockAreGlobalInvoiceVendorsEnabled.mockReturnValue(true);

    const vendors = getAllVendors(44);

    expect(vendors.map((vendor) => vendor.name)).toContain('Santander Consumer');
    expect(vendors.map((vendor) => vendor.name)).toContain('Jaqueline Energia');
    expect(vendors.some((vendor) => vendor.builtin)).toBe(true);
  });

  it('treats blank custom subject patterns as match-any', () => {
    mockGetActiveVendors.mockReturnValue([
      {
        name: 'Sender Only Vendor',
        sender_pattern: 'billing@example.com',
        subject_patterns: null,
      },
    ]);

    const vendors = getAllVendors(44);

    expect(vendors[0]).toMatchObject({
      name: 'Sender Only Vendor',
      subjectPatterns: [],
    });
    expect(subjectMatchesPatterns('Your April statement is ready', vendors[0].subjectPatterns)).toBe(true);
  });

  it('uses additive sender_patterns when present', () => {
    mockGetActiveVendors.mockReturnValue([
      {
        name: 'Multi Sender Vendor',
        sender_pattern: 'billing@example.com',
        sender_patterns: ['billing@example.com', 'receipts@example.com'],
        subject_patterns: null,
      },
    ]);

    const vendors = getAllVendors(44);

    expect(vendors[0].senderPatterns).toEqual(['billing@example.com', 'receipts@example.com']);
    expect(senderMatchesPatterns('receipts@example.com', vendors[0].senderPatterns)).toBe(true);
  });

  it('matches exact senders across plus-addressed variants', () => {
    expect(senderMatchesPatterns('billing+april@example.com', ['billing@example.com'])).toBe(true);
  });

  it('still exposes the static built-in list for admin/migration tooling without applying it to users', () => {
    const builtins = getBuiltinVendors();

    expect(builtins.length).toBeGreaterThan(0);
    expect(builtins.every((vendor) => vendor.builtin)).toBe(true);
  });

  it('files supported non-PDF invoice attachments from monthly scans', async () => {
    mockIsOutlookMailConfigured.mockReturnValue(true);
    mockGetActiveVendors.mockReturnValue([
      {
        name: 'Image Vendor',
        sender_pattern: 'billing@example.com',
        subject_patterns: null,
      },
    ]);
    mockSearchEmailsByFilter.mockResolvedValue([
      {
        id: 'email-1',
        conversationId: 'thread-1',
        from: 'billing@example.com',
        to: 'felipe@example.com',
        subject: 'April invoice',
        snippet: '',
        date: '2026-04-12T10:00:00Z',
        isRead: false,
        importance: 'normal',
      },
    ]);
    mockGetAttachments.mockResolvedValue([
      { id: 'att-1', name: 'invoice.png', contentType: 'image/png', size: 128, isInline: false },
    ]);
    mockDownloadAttachment.mockResolvedValue({
      buffer: Buffer.from('png-bytes'),
      name: 'invoice.png',
      contentType: 'image/png',
    });
    mockFilePdf.mockResolvedValue({
      success: true,
      folderPath: '2026/Abr-2026',
      filename: 'invoice.png',
      filePath: 'invoices/44/44/2026/Abr-2026/invoice.png',
      objectKey: 'invoices/44/44/2026/Abr-2026/invoice.png',
      checksum: 'sha256',
      mime: 'image/png',
      bytes: 9,
      storageBackend: 'filesystem',
    });

    const result = await collectMonthlyInvoices(44, 2026, 4);

    expect(result.totalFiled).toBe(1);
    expect(mockGetAttachments).toHaveBeenCalledWith('email-1');
    expect(mockFilePdf).toHaveBeenCalledWith(
      Buffer.from('png-bytes'),
      'Image Vendor',
      '2026-04-15',
      null,
      'invoice.png',
      { tenantId: 44, userId: 44, mime: 'image/png' },
    );
  });

  it('uses the expanded monthly email cap and reports truncation risk', async () => {
    mockIsOutlookMailConfigured.mockReturnValue(true);
    mockGetActiveVendors.mockReturnValue([]);
    mockSearchEmailsByFilter.mockResolvedValue(
      Array.from({ length: 2000 }, (_, index) => ({
        id: `email-${index}`,
        conversationId: `thread-${index}`,
        from: 'billing@example.com',
        to: 'felipe@example.com',
        subject: `Invoice ${index}`,
        snippet: '',
        date: '2026-04-12T10:00:00Z',
        isRead: false,
        importance: 'normal',
      })),
    );

    const result = await collectMonthlyInvoices(44, 2026, 4);

    expect(mockSearchEmailsByFilter).toHaveBeenCalledWith(expect.any(String), 2000);
    expect(result.warnings).toContain('RESULTS_TRUNCATED');
    expect(result.vendors).toEqual([]);
  });
});
