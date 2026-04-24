// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetUserById = vi.fn();
const mockGetUserByTelegramId = vi.fn();
const mockCheckTierAccess = vi.fn();
const mockLoggerInfo = vi.fn();
const mockLoggerWarn = vi.fn();

vi.mock('../../src/services/user-service', () => ({
  getUserById: (...args: unknown[]) => mockGetUserById(...args),
  getUserByTelegramId: (...args: unknown[]) => mockGetUserByTelegramId(...args),
}));

vi.mock('../../src/services/skill-tiers', () => ({
  checkTierAccess: (...args: unknown[]) => mockCheckTierAccess(...args),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: (...args: unknown[]) => mockLoggerInfo(...args),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
  },
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
    mockCheckTierAccess.mockReset();
    mockLoggerInfo.mockReset();
    mockLoggerWarn.mockReset();

    mockGetUserById.mockReturnValue({ id: 42, tier: 'pro' });
    mockGetUserByTelegramId.mockReturnValue(null);
    mockCheckTierAccess.mockReturnValue({
      allowed: true,
      reason: 'catalog',
      userTier: 'pro',
      requiredTier: 'pro',
      skillId: 'content',
    });
  });

  it('allows the message when no user can be resolved', () => {
    mockGetUserById.mockReturnValue(null);
    mockGetUserByTelegramId.mockReturnValue(null);

    const res = mockRes();
    expect(sendChatTierRequiredIfNeeded(res, 42, 'content')).toBe(false);

    expect(mockCheckTierAccess).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('allows the message when the resolved user has tier access', () => {
    const res = mockRes();
    expect(sendChatTierRequiredIfNeeded(res, 42, 'content')).toBe(false);

    expect(mockCheckTierAccess).toHaveBeenCalledWith({ id: 42, tier: 'pro' }, 'content');
    expect(res.status).not.toHaveBeenCalled();
  });

  it('falls back to telegram id lookup when the direct user id lookup misses', () => {
    mockGetUserById.mockReturnValue(null);
    mockGetUserByTelegramId.mockReturnValue({ id: 7, tier: 'owner' });

    const res = mockRes();
    expect(sendChatTierRequiredIfNeeded(res, 99, 'finance')).toBe(false);

    expect(mockCheckTierAccess).toHaveBeenCalledWith({ id: 7, tier: 'owner' }, 'finance');
    expect(res.status).not.toHaveBeenCalled();
  });

  it('sends the stable iOS tier-required response when the user is blocked', () => {
    mockGetUserById.mockReturnValue({ id: 42, tier: 'free' });
    mockCheckTierAccess.mockReturnValue({
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
        },
      },
    });
  });

  it('fails open if the tier lookup path throws', () => {
    const err = new Error('db locked');
    mockGetUserById.mockImplementation(() => {
      throw err;
    });

    const res = mockRes();
    expect(sendChatTierRequiredIfNeeded(res, 42, 'content')).toBe(false);

    expect(mockLoggerWarn).toHaveBeenCalledWith(
      { err },
      'iOS tier gate check failed — falling through (fail-open)',
    );
    expect(res.status).not.toHaveBeenCalled();
  });
});
