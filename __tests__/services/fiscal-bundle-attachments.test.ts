import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetUserById = vi.fn();
const mockGetOrCreateFiscalCollectionProfile = vi.fn();
const mockUpdateFiscalCollectionProfile = vi.fn();
const mockGetAllVendors = vi.fn();
const mockGetFilingsForPeriod = vi.fn();
const mockHasStoredInvoiceObjectOwnership = vi.fn();
const mockVerifyInvoiceObjectChecksum = vi.fn();
const mockFindFiscalBundleSendByIdempotencyKey = vi.fn();
const mockFindFiscalBundleSendForPeriod = vi.fn();
const mockNormalizeFiscalBundleIdempotencyKey = vi.fn();
const mockRecordFiscalBundleSend = vi.fn();
const mockNormalizeSenderAddress = vi.fn((value: string) => value);
const mockSenderMatchesPatterns = vi.fn(() => true);
const mockSubjectMatchesPatterns = vi.fn(() => true);
const mockIsConnected = vi.fn();
const mockSendFiscalBundleEmail = vi.fn();
const mockIsEmailConfigured = vi.fn();
const mockSearchOutlookEmailsByFilter = vi.fn();
const mockGetOutlookAttachments = vi.fn();
const mockDownloadOutlookAttachment = vi.fn();
const mockSearchGmailEmails = vi.fn();
const mockGetGmailAttachments = vi.fn();
const mockDownloadGmailAttachment = vi.fn();

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

vi.mock('../../src/services/user-service', () => ({
  getUserById: (...args: unknown[]) => mockGetUserById(...args),
}));

vi.mock('../../src/state/fiscal-collection-profiles', () => ({
  getOrCreateFiscalCollectionProfile: (...args: unknown[]) => mockGetOrCreateFiscalCollectionProfile(...args),
  updateFiscalCollectionProfile: (...args: unknown[]) => mockUpdateFiscalCollectionProfile(...args),
}));

vi.mock('../../src/state/invoice-filings', () => ({
  getFilingsForPeriod: (...args: unknown[]) => mockGetFilingsForPeriod(...args),
  hasStoredInvoiceObjectOwnership: (...args: unknown[]) =>
    mockHasStoredInvoiceObjectOwnership(...args),
}));

vi.mock('../../src/services/invoice-object-storage', () => ({
  verifyInvoiceObjectChecksum: (...args: unknown[]) => mockVerifyInvoiceObjectChecksum(...args),
}));

vi.mock('../../src/state/fiscal-bundle-sends', () => ({
  findFiscalBundleSendByIdempotencyKey: (...args: unknown[]) => mockFindFiscalBundleSendByIdempotencyKey(...args),
  findFiscalBundleSendForPeriod: (...args: unknown[]) => mockFindFiscalBundleSendForPeriod(...args),
  normalizeFiscalBundleIdempotencyKey: (...args: unknown[]) => mockNormalizeFiscalBundleIdempotencyKey(...args),
  recordFiscalBundleSend: (...args: unknown[]) => mockRecordFiscalBundleSend(...args),
}));

vi.mock('../../src/services/invoice-collector', () => ({
  getAllVendors: (...args: unknown[]) => mockGetAllVendors(...args),
  normalizeSenderAddress: (...args: unknown[]) => mockNormalizeSenderAddress(...args),
  senderMatchesPatterns: (...args: unknown[]) => mockSenderMatchesPatterns(...args),
  subjectMatchesPatterns: (...args: unknown[]) => mockSubjectMatchesPatterns(...args),
}));

vi.mock('../../src/services/oauth-store', () => ({
  isConnected: (...args: unknown[]) => mockIsConnected(...args),
}));

vi.mock('../../src/services/email-sender', () => ({
  sendFiscalBundleEmail: (...args: unknown[]) => mockSendFiscalBundleEmail(...args),
  isFiscalBundleDeliveryConfigured: (...args: unknown[]) => mockIsEmailConfigured(...args),
}));

vi.mock('../../src/services/outlook-mail', () => ({
  searchEmailsByFilter: (...args: unknown[]) => mockSearchOutlookEmailsByFilter(...args),
  getAttachments: (...args: unknown[]) => mockGetOutlookAttachments(...args),
  downloadAttachment: (...args: unknown[]) => mockDownloadOutlookAttachment(...args),
}));

vi.mock('../../src/services/google-gmail', () => ({
  searchEmails: (...args: unknown[]) => mockSearchGmailEmails(...args),
  getAttachments: (...args: unknown[]) => mockGetGmailAttachments(...args),
  downloadAttachment: (...args: unknown[]) => mockDownloadGmailAttachment(...args),
}));

import { isSupportedFiscalAttachment, sendFiscalBundleNow } from '../../src/services/fiscal-bundle';

describe('Fiscal bundle attachment support', () => {
  beforeEach(() => {
    mockGetUserById.mockReset();
    mockGetOrCreateFiscalCollectionProfile.mockReset();
    mockUpdateFiscalCollectionProfile.mockReset();
    mockGetAllVendors.mockReset();
    mockGetFilingsForPeriod.mockReset();
    mockGetFilingsForPeriod.mockReturnValue([]);
    mockHasStoredInvoiceObjectOwnership.mockReset();
    mockHasStoredInvoiceObjectOwnership.mockReturnValue(true);
    mockVerifyInvoiceObjectChecksum.mockReset();
    mockFindFiscalBundleSendByIdempotencyKey.mockReset();
    mockFindFiscalBundleSendByIdempotencyKey.mockReturnValue(null);
    mockFindFiscalBundleSendForPeriod.mockReset();
    mockFindFiscalBundleSendForPeriod.mockReturnValue(null);
    mockNormalizeFiscalBundleIdempotencyKey.mockReset();
    mockNormalizeFiscalBundleIdempotencyKey.mockImplementation(
      (_tenantId: number, _userId: number, start: string, end: string, explicit?: string) =>
        explicit || `fiscal:${start}:${end}`,
    );
    mockRecordFiscalBundleSend.mockReset();
    mockNormalizeSenderAddress.mockReset();
    mockNormalizeSenderAddress.mockImplementation((value: string) => value);
    mockSenderMatchesPatterns.mockReset();
    mockSenderMatchesPatterns.mockReturnValue(true);
    mockSubjectMatchesPatterns.mockReset();
    mockSubjectMatchesPatterns.mockReturnValue(true);
    mockIsConnected.mockReset();
    mockSendFiscalBundleEmail.mockReset();
    mockIsEmailConfigured.mockReset();
    mockSearchOutlookEmailsByFilter.mockReset();
    mockGetOutlookAttachments.mockReset();
    mockDownloadOutlookAttachment.mockReset();
    mockSearchGmailEmails.mockReset();
    mockGetGmailAttachments.mockReset();
    mockDownloadGmailAttachment.mockReset();

    mockGetUserById.mockReturnValue({ id: 12, email: 'felipe@nexushub.me' });
    mockGetOrCreateFiscalCollectionProfile.mockReturnValue({
      user_id: 12,
      tenant_id: 12,
      destination_email: 'felipe@nexushub.me',
      cadence: 'monthly',
      primary_day: 28,
      secondary_day: null,
      enabled: 1,
      last_bundle_sent_at: null,
      last_bundle_document_count: 0,
      created_at: '2026-04-01T00:00:00Z',
      updated_at: '2026-04-01T00:00:00Z',
    });
    mockGetAllVendors.mockReturnValue([
      {
        name: 'Fiscal invoices',
        senderPatterns: ['billing@example.com'],
        subjectPatterns: ['invoice'],
        builtin: false,
      },
    ]);
    mockIsConnected.mockImplementation((_userId: number, provider: string) => provider === 'outlook');
    mockIsEmailConfigured.mockReturnValue(true);
    mockSendFiscalBundleEmail.mockResolvedValue(true);
    mockSearchOutlookEmailsByFilter.mockResolvedValue([
      {
        id: 'msg-1',
        from: 'billing@example.com',
        subject: 'Invoice April',
        date: '2026-04-12T09:00:00Z',
      },
    ]);
    mockSearchGmailEmails.mockResolvedValue([]);
  });

  it('accepts accountant-friendly attachment formats beyond PDF', () => {
    expect(isSupportedFiscalAttachment('invoice.pdf', 'application/pdf')).toBe(true);
    expect(isSupportedFiscalAttachment('saft.xml', 'application/octet-stream')).toBe(true);
    expect(isSupportedFiscalAttachment('receipt.jpg', 'image/jpeg')).toBe(true);
    expect(isSupportedFiscalAttachment('statement.xlsx', 'application/octet-stream')).toBe(true);
    expect(isSupportedFiscalAttachment('notes.txt', 'text/plain')).toBe(false);
  });

  it('includes supported non-PDF attachments in the fiscal bundle email', async () => {
    mockGetOutlookAttachments.mockResolvedValue([
      { id: 'a-pdf', name: 'invoice.pdf', contentType: 'application/pdf', size: 1024, isInline: false },
      { id: 'a-xml', name: 'saft.xml', contentType: 'application/octet-stream', size: 512, isInline: false },
      { id: 'a-jpg', name: 'receipt.jpg', contentType: 'image/jpeg', size: 2048, isInline: false },
      { id: 'a-txt', name: 'notes.txt', contentType: 'text/plain', size: 128, isInline: false },
    ]);
    mockDownloadOutlookAttachment.mockImplementation(async (_messageId: string, attachmentId: string) => {
      const files: Record<string, { name: string; contentType: string }> = {
        'a-pdf': { name: 'invoice.pdf', contentType: 'application/pdf' },
        'a-xml': { name: 'saft.xml', contentType: 'application/xml' },
        'a-jpg': { name: 'receipt.jpg', contentType: 'image/jpeg' },
      };
      const file = files[attachmentId];
      return {
        buffer: Buffer.from(`file:${attachmentId}`),
        name: file.name,
        contentType: file.contentType,
      };
    });

    const result = await sendFiscalBundleNow(12, {
      startAt: '2026-04-01T00:00:00Z',
      endAt: '2026-04-14T23:59:59Z',
    });

    expect(result.totalDocuments).toBe(3);
    expect(result.documents.map((doc) => doc.filename)).toEqual([
      'invoice.pdf',
      'saft.xml',
      'receipt.jpg',
    ]);
    expect(mockSendFiscalBundleEmail).toHaveBeenCalledWith(expect.objectContaining({
      attachments: expect.arrayContaining([
        expect.objectContaining({ filename: 'invoice.pdf', contentType: 'application/pdf' }),
        expect.objectContaining({ filename: 'saft.xml', contentType: 'application/xml' }),
        expect.objectContaining({ filename: 'receipt.jpg', contentType: 'image/jpeg' }),
      ]),
    }));
    expect(mockSendFiscalBundleEmail.mock.calls[0][0].attachments).toHaveLength(3);
    expect(mockUpdateFiscalCollectionProfile).not.toHaveBeenCalled();
    expect(mockRecordFiscalBundleSend).toHaveBeenCalled();
  });

  it('includes durable filed invoice objects in the fiscal bundle email', async () => {
    mockGetOutlookAttachments.mockResolvedValue([]);
    mockGetFilingsForPeriod.mockReturnValue([
      {
        id: 501,
        tenant_id: 12,
        user_id: 12,
        vendor: 'Photo Vendor',
        amount: '12.30',
        document_date: '2026-04-10',
        invoice_number: 'PHOTO-1',
        source: 'photo',
        source_ref: 'photo:one',
        remote_path: null,
        folder_path: '2026/Abr-2026',
        filename: 'photo-invoice.jpg',
        file_size_bytes: 13,
        compressed_size_bytes: 13,
        object_key: 'invoices/12/12/2026/Abr-2026/photo-invoice.jpg',
        checksum: 'checksum-1',
        mime: 'image/jpeg',
        bytes: 13,
        storage_backend: 'filesystem',
        status: 'filed',
        error_message: null,
        created_at: '2026-04-10T12:00:00Z',
      },
    ]);
    mockVerifyInvoiceObjectChecksum.mockResolvedValue(Buffer.from('filed-photo'));

    const result = await sendFiscalBundleNow(12, {
      startAt: '2026-04-01T00:00:00Z',
      endAt: '2026-04-14T23:59:59Z',
    });

    expect(result.providers).toContain('filed');
    expect(result.totalDocuments).toBe(1);
    expect(mockGetFilingsForPeriod).toHaveBeenCalledWith(
      12,
      12,
      '2026-04-01T00:00:00.000Z',
      '2026-04-14T23:59:59.000Z',
    );
    expect(mockVerifyInvoiceObjectChecksum).toHaveBeenCalledWith(
      'invoices/12/12/2026/Abr-2026/photo-invoice.jpg',
      'checksum-1',
      'filesystem',
    );
    expect(mockSendFiscalBundleEmail).toHaveBeenCalledWith(expect.objectContaining({
      attachments: [
        expect.objectContaining({
          filename: 'photo-invoice.jpg',
          content: Buffer.from('filed-photo'),
          contentType: 'image/jpeg',
        }),
      ],
    }));
  });

  it('refuses a filed object whose manifest does not prove the same owner', async () => {
    mockGetOutlookAttachments.mockResolvedValue([]);
    mockGetFilingsForPeriod.mockReturnValue([{
      id: 503,
      tenant_id: 12,
      user_id: 12,
      vendor: 'Foreign object fixture',
      document_date: '2026-04-10',
      invoice_number: 'FOREIGN-1',
      source: 'photo',
      source_ref: 'photo:foreign',
      object_key: 'invoices/99/99/2026/Abr-2026/foreign.pdf',
      checksum: 'checksum-foreign',
      mime: 'application/pdf',
      bytes: 8,
      storage_backend: 'filesystem',
      status: 'filed',
      created_at: '2026-04-10T12:00:00Z',
    }]);
    mockHasStoredInvoiceObjectOwnership.mockReturnValue(false);

    const result = await sendFiscalBundleNow(12, {
      startAt: '2026-04-01T00:00:00Z',
      endAt: '2026-04-14T23:59:59Z',
    });

    expect(result.warnings).toContain('FILED_OBJECT_OWNERSHIP_INVALID:503');
    expect(mockVerifyInvoiceObjectChecksum).not.toHaveBeenCalled();
  });

  it('includes today-dated durable filed objects in the default bundle period', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-30T15:00:00.000Z'));
    mockSearchOutlookEmailsByFilter.mockResolvedValue([]);
    mockGetFilingsForPeriod.mockReturnValue([
      {
        id: 502,
        tenant_id: 12,
        user_id: 12,
        vendor: 'Today Vendor',
        amount: '42.00',
        document_date: '2026-04-30',
        invoice_number: 'TODAY-1',
        source: 'photo',
        source_ref: 'photo:today',
        remote_path: null,
        folder_path: '2026/Abr-2026',
        filename: 'today-invoice.pdf',
        file_size_bytes: 17,
        compressed_size_bytes: 17,
        object_key: 'invoices/12/12/2026/Abr-2026/today-invoice.pdf',
        checksum: 'checksum-today',
        mime: 'application/pdf',
        bytes: 17,
        storage_backend: 'filesystem',
        status: 'filed',
        error_message: null,
        created_at: '2026-04-30T12:00:00Z',
      },
    ]);
    mockVerifyInvoiceObjectChecksum.mockResolvedValue(Buffer.from('today-filed-pdf'));

    try {
      const result = await sendFiscalBundleNow(12);

      expect(mockGetFilingsForPeriod).toHaveBeenCalledWith(
        12,
        12,
        '2026-04-01T00:00:00.000Z',
        '2026-04-30T23:59:59.999Z',
      );
      expect(result.documents.map((doc) => doc.filename)).toContain('today-invoice.pdf');
      expect(mockSendFiscalBundleEmail).toHaveBeenCalledWith(expect.objectContaining({
        attachments: [
          expect.objectContaining({
            filename: 'today-invoice.pdf',
            content: Buffer.from('today-filed-pdf'),
          }),
        ],
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('warns when provider mail was scanned but no invoice rule matched', async () => {
    mockSenderMatchesPatterns.mockReturnValue(false);

    const result = await sendFiscalBundleNow(12, {
      startAt: '2026-04-01T00:00:00Z',
      endAt: '2026-04-14T23:59:59Z',
    });

    expect(result.totalMatchedEmails).toBe(0);
    expect(result.totalDocuments).toBe(0);
    expect(result.warnings).toContain('NO_RULE_MATCHED_ANY_EMAIL');
    expect(result.warnings).toContain('NO_FISCAL_DOCUMENTS_FOUND');
    expect(mockGetOutlookAttachments).not.toHaveBeenCalled();
    expect(mockSendFiscalBundleEmail).toHaveBeenCalledWith(expect.objectContaining({
      attachments: [],
    }));
  });

  it('rejects malformed explicit periods before sending email', async () => {
    await expect(sendFiscalBundleNow(12, {
      startAt: '2026-5',
      endAt: '2026-04-14T23:59:59Z',
    })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      status: 400,
    });

    expect(mockSendFiscalBundleEmail).not.toHaveBeenCalled();
    expect(mockRecordFiscalBundleSend).not.toHaveBeenCalled();
  });

  it('replays an existing idempotency result without sending another email', async () => {
    const storedResult = {
      destinationEmail: 'felipe@nexushub.me',
      periodStart: '2026-04-01T00:00:00.000Z',
      periodEnd: '2026-04-14T23:59:59.000Z',
      cadence: 'monthly',
      providers: [],
      ruleCount: 1,
      totalMatchedEmails: 0,
      totalDocuments: 0,
      totalBytes: 0,
      sent: true,
      warnings: ['NO_FISCAL_DOCUMENTS_FOUND'],
      documents: [],
    };
    mockFindFiscalBundleSendByIdempotencyKey.mockReturnValue({
      result_json: JSON.stringify(storedResult),
    });

    const result = await sendFiscalBundleNow(12, {
      startAt: '2026-04-01T00:00:00Z',
      endAt: '2026-04-14T23:59:59Z',
      idempotencyKey: 'repeat',
    });

    expect(result).toEqual(storedResult);
    expect(mockSendFiscalBundleEmail).not.toHaveBeenCalled();
    expect(mockRecordFiscalBundleSend).not.toHaveBeenCalled();
  });
});
