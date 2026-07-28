// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetUserById = vi.fn();
const mockGetUserByTelegramId = vi.fn();
const mockCheckSkillAccess = vi.fn();
const mockGetEffectiveEntitlement = vi.fn();
const mockLoggerInfo = vi.fn();
const mockLoggerWarn = vi.fn();

vi.mock('../../src/services/user-service', () => ({
  getUserById: (...args: unknown[]) => mockGetUserById(...args),
  getUserByTelegramId: (...args: unknown[]) => mockGetUserByTelegramId(...args),
}));

vi.mock('../../src/services/skill-tiers', () => ({
  checkSkillAccess: (...args: unknown[]) => mockCheckSkillAccess(...args),
}));

vi.mock('../../src/services/entitlement', () => ({
  getEffectiveEntitlement: (...args: unknown[]) => mockGetEffectiveEntitlement(...args),
  entitlementPlanToSkillTier: (plan: string) => (plan === 'beta' ? 'max' : plan),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: (...args: unknown[]) => mockLoggerInfo(...args),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
  },
  LOGGER_REDACTION_PATHS: [],
}));

import { sendChatTierRequiredIfNeeded } from '../../src/api/routes/chat-message-tier-gate';

function mockRes() {
  const response: any = {
    statusCode: undefined,
    body: undefined,
    status: vi.fn((statusCode: number) => {
      response.statusCode = statusCode;
      return response;
    }),
    json: vi.fn((body: unknown) => {
      response.body = body;
      return response;
    }),
  };
  return response;
}

describe('chat message tier gate', () => {
  beforeEach(() => {
    mockGetUserById.mockReset();
    mockGetUserByTelegramId.mockReset();
    mockCheckSkillAccess.mockReset();
    mockGetEffectiveEntitlement.mockReset();
    mockLoggerInfo.mockReset();
    mockLoggerWarn.mockReset();

    mockGetUserById.mockReturnValue({ id: 42, tier: 'pro' });
    mockGetUserByTelegramId.mockReturnValue(null);
    mockGetEffectiveEntitlement.mockReturnValue({ plan: 'pro' });
    mockCheckSkillAccess.mockReturnValue({
      allowed: true,
      reason: 'catalog',
      userTier: 'pro',
      requiredTier: 'pro',
      skillId: 'content',
    });
  });

  it('allows the message when no user can be resolved', () => {
    mockGetUserById.mockReturnValue(null);

    const res = mockRes();
    expect(sendChatTierRequiredIfNeeded(res, 42, 'content')).toBe(false);

    expect(mockCheckSkillAccess).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('allows the message when the resolved user has tier access', () => {
    const res = mockRes();
    expect(sendChatTierRequiredIfNeeded(res, 42, 'content')).toBe(false);

    expect(mockCheckSkillAccess).toHaveBeenCalledWith({ id: 42, tier: 'pro' }, 'content');
    expect(res.status).not.toHaveBeenCalled();
  });

  it('uses subscription entitlement instead of the stale users.tier column', () => {
    mockGetUserById.mockReturnValue({ id: 42, tier: 'free' });
    mockGetEffectiveEntitlement.mockReturnValue({ plan: 'max' });

    const res = mockRes();
    expect(sendChatTierRequiredIfNeeded(res, 42, 'finance')).toBe(false);

    expect(mockCheckSkillAccess).toHaveBeenCalledWith({ id: 42, tier: 'max' }, 'finance');
    expect(res.status).not.toHaveBeenCalled();
  });

  it('never falls back to telegram id lookup — userId comes from the verified iOS JWT keyed to users.id', () => {
    // M9 follow-through: a telegram-id fallback here could resolve a
    // DIFFERENT user whose telegram_id collides with an iOS users.id.
    mockGetUserById.mockReturnValue(null);
    mockGetUserByTelegramId.mockReturnValue({ id: 7, tier: 'owner' });

    const res = mockRes();
    expect(sendChatTierRequiredIfNeeded(res, 99, 'finance')).toBe(false);

    expect(mockGetUserByTelegramId).not.toHaveBeenCalled();
    expect(mockCheckSkillAccess).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('sends the stable iOS tier-required response when the user is blocked', () => {
    mockGetUserById.mockReturnValue({ id: 42, tier: 'free' });
    mockCheckSkillAccess.mockReturnValue({
      allowed: false,
      reason: 'catalog',
      userTier: 'free',
      requiredTier: 'pro',
      skillId: 'content',
    });

    const res = mockRes();
    expect(sendChatTierRequiredIfNeeded(res, 42, 'content')).toBe(true);

    expect(mockLoggerInfo).toHaveBeenCalledWith(
      {
        userId: 42,
        domain: 'content',
        userTier: 'free',
        requiredTier: 'pro',
        reason: 'catalog',
      },
      'iOS tier gate blocked message',
    );
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({
      error: {
        code: 'TIER_REQUIRED',
        message: 'This feature requires the pro tier. Your current tier: free.',
        details: {
          domain: 'content',
          userTier: 'free',
          requiredTier: 'pro',
          reason: 'catalog',
        },
      },
    });
  });

  it('fails closed if the tier lookup path throws', () => {
    const err = new Error('db locked');
    mockGetUserById.mockImplementation(() => {
      throw err;
    });

    const res = mockRes();
    expect(sendChatTierRequiredIfNeeded(res, 42, 'content')).toBe(true);

    expect(mockLoggerWarn).toHaveBeenCalledWith(
      { err, userId: 42, domain: 'content' },
      'iOS tier gate check failed — fail-closed',
    );
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({
      error: {
        code: 'ACCESS_CHECK_UNAVAILABLE',
        message: 'Nexus could not verify access for this request. Please try again.',
        details: { domain: 'content' },
      },
    });
  });
});
