import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetUserById = vi.fn();
const mockGetOrCreateFiscalCollectionProfile = vi.fn();
const mockUpdateFiscalCollectionProfile = vi.fn();
const mockGetAllVendors = vi.fn();
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
    expect(mockUpdateFiscalCollectionProfile).toHaveBeenCalledWith(12, expect.objectContaining({
      last_bundle_document_count: 3,
    }));
  });
});
