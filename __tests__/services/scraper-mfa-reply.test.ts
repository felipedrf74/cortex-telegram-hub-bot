import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockResolveAmazonReply = vi.fn();
const mockResolveUberReply = vi.fn();
const mockRegisterAmazonReplyWaiter = vi.fn();
const mockRegisterUberReplyWaiter = vi.fn();
const mockCreateNotificationIntent = vi.fn();

vi.mock('../../src/services/amazon-collector', () => ({
  registerReplyWaiter: (...args: unknown[]) => mockRegisterAmazonReplyWaiter(...args),
  resolveReply: (...args: unknown[]) => mockResolveAmazonReply(...args),
}));

vi.mock('../../src/services/uber-collector', () => ({
  registerReplyWaiter: (...args: unknown[]) => mockRegisterUberReplyWaiter(...args),
  resolveReply: (...args: unknown[]) => mockResolveUberReply(...args),
}));

vi.mock('../../src/services/notification-orchestrator', () => ({
  createNotificationIntent: (...args: unknown[]) => mockCreateNotificationIntent(...args),
}));

import {
  createScraperMfaInteractiveCallbacks,
  normalizeScraperMfaCode,
  normalizeScraperMfaSource,
  notifyScraperMfaChallenge,
  submitScraperMfaReply,
} from '../../src/services/scraper-mfa-reply';

describe('scraper MFA reply service', () => {
  beforeEach(() => {
    mockResolveAmazonReply.mockReset();
    mockResolveUberReply.mockReset();
    mockRegisterAmazonReplyWaiter.mockReset();
    mockRegisterUberReplyWaiter.mockReset();
    mockCreateNotificationIntent.mockReset();
  });

  it('normalizes only supported scraper MFA sources', () => {
    expect(normalizeScraperMfaSource(' Amazon ')).toBe('amazon');
    expect(normalizeScraperMfaSource('UBER')).toBe('uber');
    expect(normalizeScraperMfaSource('garmin')).toBeNull();
    expect(normalizeScraperMfaSource(null)).toBeNull();
  });

  it('normalizes non-empty bounded scraper MFA codes', () => {
    expect(normalizeScraperMfaCode(' 123456 ')).toBe('123456');
    expect(normalizeScraperMfaCode('  a1 b2 c3  ')).toBe('a1 b2 c3');
    expect(normalizeScraperMfaCode('')).toBeNull();
    expect(normalizeScraperMfaCode(' '.repeat(4))).toBeNull();
    expect(normalizeScraperMfaCode('1'.repeat(257))).toBeNull();
  });

  it('routes Amazon replies through the user-scoped Amazon waiter', () => {
    mockResolveAmazonReply.mockReturnValue(true);

    const result = submitScraperMfaReply({
      userId: 77,
      tenantId: 77,
      source: 'amazon',
      code: '123456',
    });

    expect(result).toEqual({
      accepted: true,
      source: 'amazon',
    });
    expect(mockResolveAmazonReply).toHaveBeenCalledWith(77, '123456');
    expect(mockResolveUberReply).not.toHaveBeenCalled();
  });

  it('routes Uber replies through the user-scoped Uber waiter', () => {
    mockResolveUberReply.mockReturnValue(false);

    const result = submitScraperMfaReply({
      userId: 88,
      tenantId: 88,
      source: 'uber',
      code: '654321',
    });

    expect(result).toEqual({
      accepted: false,
      source: 'uber',
    });
    expect(mockResolveUberReply).toHaveBeenCalledWith(88, '654321');
    expect(mockResolveAmazonReply).not.toHaveBeenCalled();
  });

  it('creates a privacy-safe APNs-eligible notification for scraper MFA challenges', async () => {
    mockCreateNotificationIntent.mockResolvedValue({
      intent: { intentId: 'intent-1' },
      item: { itemId: 'item-1' },
    });

    await notifyScraperMfaChallenge({
      userId: 99,
      tenantId: 99,
      source: 'uber',
    });

    expect(mockCreateNotificationIntent).toHaveBeenCalledWith(expect.objectContaining({
      userId: 99,
      tenantId: 99,
      sourceSkill: 'finance',
      type: 'approval_required',
      priority: 'time_sensitive',
      relatedEntityId: 'uber-scraper-mfa',
      relatedEntityType: 'invoice_scraper_mfa',
      title: 'Uber needs verification',
      body: 'Uber needs a verification code to continue invoice collection.',
      deeplink: 'nexus://finance/invoices/scraper-mfa?source=uber',
      expiresAt: expect.any(String),
      decisionDeadline: expect.any(String),
      quietHoursPolicy: 'allow_time_sensitive',
      dedupeKey: 'finance:scraper-mfa:99:99:uber',
      requiresUserAction: true,
      deliveryPolicy: 'auto',
      privacyPolicy: 'financial',
      visibilityScope: 'user_private',
    }));
    const payload = mockCreateNotificationIntent.mock.calls[0][0];
    expect(payload.decisionDeadline).toBe(payload.expiresAt);
    expect(Date.parse(payload.decisionDeadline)).toBeGreaterThan(Date.now());
    expect(JSON.stringify(payload)).not.toContain('123456');
    expect(payload.actionButtons).toEqual([
      expect.objectContaining({
        id: 'open_detail',
        label: 'Enter code',
        deeplink: 'nexus://finance/invoices/scraper-mfa?source=uber',
      }),
    ]);
  });

  it('builds app-side callbacks that notify the user and wait on the user-scoped scraper key', async () => {
    const waiter = Promise.resolve('123456');
    mockRegisterAmazonReplyWaiter.mockReturnValue(waiter);
    mockCreateNotificationIntent.mockResolvedValue({
      intent: { intentId: 'intent-1' },
      item: { itemId: 'item-1' },
    });

    const callbacks = createScraperMfaInteractiveCallbacks({
      userId: 123,
      tenantId: 123,
      source: 'amazon',
    });

    await callbacks.sendMessage('ignored legacy prompt');
    await callbacks.sendScreenshot(Buffer.from('not-persisted'));
    const result = callbacks.waitForReply(300_000);

    expect(mockCreateNotificationIntent).toHaveBeenCalledWith(expect.objectContaining({
      userId: 123,
      tenantId: 123,
      sourceSkill: 'finance',
      deeplink: 'nexus://finance/invoices/scraper-mfa?source=amazon',
    }));
    expect(mockRegisterAmazonReplyWaiter).toHaveBeenCalledWith(123, 300_000);
    expect(mockRegisterUberReplyWaiter).not.toHaveBeenCalled();
    await expect(result).resolves.toBe('123456');
  });
});
