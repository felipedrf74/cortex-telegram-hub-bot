import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Regression test for the multi-tenant tenant-leak in
 * `isOutlookCalendarConfigured(userId)`.
 *
 * The previous implementation early-returned `true` whenever the
 * server had owner Outlook tokens (`isMicrosoftConfigured()`),
 * regardless of whether the requesting `userId` actually had any
 * Outlook OAuth tokens of their own. The unified calendar then
 * routed `createEvent` to Outlook for iOS users who only had
 * Google connected, every Graph call failed with "Outlook not
 * connected for user N", and `Promise.allSettled` swallowed the
 * failures — the user-visible symptom was a generated training
 * plan with N sessions in the DB and 0 calendar events created
 * (production log 2026-04-25 user 29: planId 6 / totalSessions 20
 * / eventsCreated 0).
 *
 * The fix mirrors `isGoogleConfigured(userId)`: when `userId` is
 * passed, return per-user truth ONLY; the owner-global path runs
 * only when `userId` is undefined.
 */

const mocks = vi.hoisted(() => ({
  isMicrosoftConfigured: vi.fn(),
  getTokens: vi.fn(),
  loggerWarn: vi.fn(),
  outlookClientId: 'mock-outlook-client-id' as string | undefined,
}));

vi.mock('../../src/services/microsoft-auth', () => ({
  isMicrosoftConfigured: () => mocks.isMicrosoftConfigured(),
  getGraphClient: vi.fn(),
  getGraphClientForUser: vi.fn(),
}));

vi.mock('../../src/services/oauth-store', () => ({
  getTokens: (...args: unknown[]) => mocks.getTokens(...args),
}));

vi.mock('../../src/config', () => ({
  config: {
    get outlook() { return { clientId: mocks.outlookClientId }; },
  },
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: (...args: unknown[]) => mocks.loggerWarn(...args),
    error: vi.fn(),
    debug: vi.fn(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

import { isOutlookCalendarConfigured } from '../../src/services/outlook-calendar';

describe('isOutlookCalendarConfigured — per-user vs owner scoping', () => {
  beforeEach(() => {
    mocks.isMicrosoftConfigured.mockReset();
    mocks.getTokens.mockReset();
    mocks.loggerWarn.mockReset();
    mocks.outlookClientId = 'mock-outlook-client-id';
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns false immediately when the server lacks an Outlook client id', () => {
    mocks.outlookClientId = undefined;
    mocks.isMicrosoftConfigured.mockReturnValue(true);
    mocks.getTokens.mockReturnValue({ refreshToken: 'whatever' });

    expect(isOutlookCalendarConfigured(29)).toBe(false);
    expect(isOutlookCalendarConfigured()).toBe(false);
  });

  describe('with a userId argument', () => {
    it('returns true when the user has stored Outlook tokens', () => {
      mocks.isMicrosoftConfigured.mockReturnValue(false);
      mocks.getTokens.mockReturnValue({ refreshToken: 'user29-rt' });

      expect(isOutlookCalendarConfigured(29)).toBe(true);
      expect(mocks.getTokens).toHaveBeenCalledWith(29, 'outlook');
    });

    it('returns false when the user has no Outlook tokens, EVEN IF the owner has them globally', () => {
      // Owner-global is configured (server has owner Outlook tokens),
      // but user 29 only connected Google — the previous implementation
      // returned true here, which is the regression this test pins.
      mocks.isMicrosoftConfigured.mockReturnValue(true);
      mocks.getTokens.mockReturnValue(undefined);

      expect(isOutlookCalendarConfigured(29)).toBe(false);
      expect(mocks.isMicrosoftConfigured).not.toHaveBeenCalled();
    });

    it('returns false when oauth-store returns a token row without a refresh token', () => {
      mocks.isMicrosoftConfigured.mockReturnValue(true);
      mocks.getTokens.mockReturnValue({ refreshToken: null });

      expect(isOutlookCalendarConfigured(29)).toBe(false);
    });

    it('returns false defensively when oauth-store throws', () => {
      mocks.isMicrosoftConfigured.mockReturnValue(true);
      mocks.getTokens.mockImplementation(() => {
        throw new Error('oauth-store unavailable');
      });

      expect(isOutlookCalendarConfigured(29)).toBe(false);
    });
  });

  describe('without a userId argument (owner / Telegram codepath)', () => {
    it('falls back to the owner-global Microsoft check', () => {
      mocks.isMicrosoftConfigured.mockReturnValue(true);

      expect(isOutlookCalendarConfigured()).toBe(true);
      expect(mocks.getTokens).not.toHaveBeenCalled();
      expect(mocks.loggerWarn).toHaveBeenCalledWith(
        { provider: 'outlook', scope: 'owner_global' },
        expect.stringContaining('owner-global scope'),
      );
    });

    it('returns false when neither a per-user token nor owner config exists', () => {
      mocks.isMicrosoftConfigured.mockReturnValue(false);

      expect(isOutlookCalendarConfigured()).toBe(false);
      expect(mocks.getTokens).not.toHaveBeenCalled();
    });
  });
});
