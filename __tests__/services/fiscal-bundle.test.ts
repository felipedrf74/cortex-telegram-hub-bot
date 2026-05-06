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
  LOGGER_REDACTION_PATHS: [],
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
  getFiscalCollectionSummary,
  isFiscalBundleDue,
} from '../../src/services/fiscal-bundle';
import type { FiscalCollectionProfileRow } from '../../src/state/fiscal-collection-profiles';
import { getUserById } from '../../src/services/user-service';
import { getOrCreateFiscalCollectionProfile } from '../../src/state/fiscal-collection-profiles';
import { getAllVendors } from '../../src/services/invoice-collector';
import { isConnected } from '../../src/services/oauth-store';
import { isFiscalBundleDeliveryConfigured } from '../../src/services/email-sender';

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

  it('does not leak the account email into the fiscal delivery destination', () => {
    vi.mocked(getOrCreateFiscalCollectionProfile).mockReturnValue(
      profile({ destination_email: null }),
    );
    vi.mocked(getUserById).mockReturnValue({
      id: 12,
      telegram_id: 12,
      email: 'owner@example.com',
      password_hash: null,
      apple_user_id: null,
      google_user_id: null,
      email_verified: 1,
      username: 'felipe',
      first_name: 'Felipe',
      last_name: 'Dominguez',
      avatar_url: null,
      language: 'pt-BR',
      timezone: 'Europe/Lisbon',
      tier: 'pro',
      status: 'active',
      auth_provider: 'email',
      invite_code: null,
      daily_message_limit: 0,
      daily_token_limit: 0,
      daily_cost_limit_usd: 0,
      created_at: '2026-04-01T00:00:00Z',
      last_active_at: null,
    });
    vi.mocked(getAllVendors).mockReturnValue([]);
    vi.mocked(isConnected).mockReturnValue(false);
    vi.mocked(isFiscalBundleDeliveryConfigured).mockReturnValue(true);

    const summary = getFiscalCollectionSummary(12);

    expect(summary.destinationEmail).toBeNull();
    expect(summary.warnings).toContain('DESTINATION_EMAIL_MISSING');
  });
});
