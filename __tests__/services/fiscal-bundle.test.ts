import { describe, expect, it, vi } from 'vitest';
import { DateTime } from 'luxon';

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

vi.mock('../../src/services/user-service', () => ({
  getUserById: vi.fn(),
}));

vi.mock('../../src/state/fiscal-collection-profiles', () => ({
  getOrCreateFiscalCollectionProfile: vi.fn(),
  updateFiscalCollectionProfile: vi.fn(),
}));

vi.mock('../../src/services/invoice-collector', () => ({
  getAllVendors: vi.fn(() => []),
  normalizeSenderAddress: vi.fn((value: string) => value),
  senderMatchesPatterns: vi.fn(() => true),
  subjectMatchesPatterns: vi.fn(() => true),
}));

vi.mock('../../src/services/oauth-store', () => ({
  isConnected: vi.fn(() => false),
}));

vi.mock('../../src/services/email-sender', () => ({
  sendFiscalBundleEmail: vi.fn(),
  isFiscalBundleDeliveryConfigured: vi.fn(() => true),
}));

vi.mock('../../src/services/outlook-mail', () => ({
  searchEmailsByFilter: vi.fn(),
  getAttachments: vi.fn(),
  downloadAttachment: vi.fn(),
}));

vi.mock('../../src/services/google-gmail', () => ({
  searchEmails: vi.fn(),
  getAttachments: vi.fn(),
  downloadAttachment: vi.fn(),
}));

import {
  computeNextFiscalBundleRun,
  isFiscalBundleDue,
} from '../../src/services/fiscal-bundle';
import type { FiscalCollectionProfileRow } from '../../src/state/fiscal-collection-profiles';

function profile(overrides: Partial<FiscalCollectionProfileRow> = {}): FiscalCollectionProfileRow {
  return {
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
    ...overrides,
  };
}

describe('Fiscal bundle scheduling', () => {
  it('returns the current-month scheduled day when it has not been sent yet', () => {
    const nextRun = computeNextFiscalBundleRun(
      profile({ primary_day: 28 }),
      DateTime.fromISO('2026-04-14T10:00:00Z', { zone: 'utc' }),
    );

    expect(nextRun).toBe('2026-04-28T08:00:00.000Z');
  });

  it('skips the current-day run when it was already sent today', () => {
    const nextRun = computeNextFiscalBundleRun(
      profile({
        primary_day: 14,
        last_bundle_sent_at: '2026-04-14T08:21:00Z',
      }),
      DateTime.fromISO('2026-04-14T09:00:00Z', { zone: 'utc' }),
    );

    expect(nextRun).toBe('2026-05-14T08:00:00.000Z');
  });

  it('uses the second configured day before moving to the next month', () => {
    const nextRun = computeNextFiscalBundleRun(
      profile({
        cadence: 'twice_monthly',
        primary_day: 10,
        secondary_day: 25,
        last_bundle_sent_at: '2026-04-10T08:10:00Z',
      }),
      DateTime.fromISO('2026-04-12T12:00:00Z', { zone: 'utc' }),
    );

    expect(nextRun).toBe('2026-04-25T08:00:00.000Z');
  });

  it('is due once the configured day reaches 08:00 UTC and has not been sent yet', () => {
    const due = isFiscalBundleDue(
      profile({ primary_day: 14 }),
      DateTime.fromISO('2026-04-14T08:30:00Z', { zone: 'utc' }),
    );

    expect(due).toBe(true);
  });

  it('is not due before the scheduled hour or after a same-day send', () => {
    expect(
      isFiscalBundleDue(
        profile({ primary_day: 14 }),
        DateTime.fromISO('2026-04-14T07:59:00Z', { zone: 'utc' }),
      ),
    ).toBe(false);

    expect(
      isFiscalBundleDue(
        profile({
          primary_day: 14,
          last_bundle_sent_at: '2026-04-14T08:05:00Z',
        }),
        DateTime.fromISO('2026-04-14T10:00:00Z', { zone: 'utc' }),
      ),
    ).toBe(false);
  });
});
