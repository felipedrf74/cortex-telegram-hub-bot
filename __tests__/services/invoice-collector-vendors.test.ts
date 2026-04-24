import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetActiveVendors = vi.fn();
const mockAreGlobalInvoiceVendorsEnabled = vi.fn();

vi.mock('../../src/state/invoice-vendors', () => ({
  getActiveVendors: (...args: unknown[]) => mockGetActiveVendors(...args),
}));

vi.mock('../../src/services/runtime-flags', () => ({
  areGlobalInvoiceVendorsEnabled: (...args: unknown[]) => mockAreGlobalInvoiceVendorsEnabled(...args),
}));

vi.mock('../../src/services/outlook-mail', () => ({
  searchEmailsByFilter: vi.fn(),
  getAttachments: vi.fn(),
  downloadAttachment: vi.fn(),
  isOutlookMailConfigured: vi.fn(() => false),
}));

vi.mock('../../src/services/invoice-filer', () => ({
  filePdf: vi.fn(),
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
}));

import { getAllVendors, getBuiltinVendors } from '../../src/services/invoice-collector';

describe('invoice collector vendor policy', () => {
  beforeEach(() => {
    mockGetActiveVendors.mockReset();
    mockAreGlobalInvoiceVendorsEnabled.mockReset();
    mockAreGlobalInvoiceVendorsEnabled.mockReturnValue(false);
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

    expect(mockGetActiveVendors).toHaveBeenCalledWith(44);
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

  it('still exposes the static built-in list for admin/migration tooling without applying it to users', () => {
    const builtins = getBuiltinVendors();

    expect(builtins.length).toBeGreaterThan(0);
    expect(builtins.every((vendor) => vendor.builtin)).toBe(true);
  });
});
