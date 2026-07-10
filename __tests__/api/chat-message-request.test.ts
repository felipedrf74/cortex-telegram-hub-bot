// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetUserLanguage = vi.fn();
const mockSetUserLanguage = vi.fn();
const mockLoggerDebug = vi.fn();
const mockLoggerWarn = vi.fn();

vi.mock('../../src/services/user-service', () => ({
  // Identity-safety: iOS routes call the strict by-id helper after the
  // May 2026 audit. Tests mock both legacy + *ById names for safety.
  getUserLanguage: (...args: unknown[]) => mockGetUserLanguage(...args),
  getUserLanguageById: (...args: unknown[]) => mockGetUserLanguage(...args),
  setUserLanguage: (...args: unknown[]) => mockSetUserLanguage(...args),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    debug: (...args: unknown[]) => mockLoggerDebug(...args),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
  },
  LOGGER_REDACTION_PATHS: [],
}));

import {
  normalizeChatMessageRequest,
  persistChatLanguagePreference,
} from '../../src/api/routes/chat-message-request';

describe('chat message request-boundary helpers', () => {
  beforeEach(() => {
    mockGetUserLanguage.mockReset();
    mockSetUserLanguage.mockReset();
    mockLoggerDebug.mockReset();
    mockLoggerWarn.mockReset();

    mockGetUserLanguage.mockReturnValue('en-US');
  });

  it('normalizes text and filters unsupported attachments at the request boundary', () => {
    const normalized = normalizeChatMessageRequest({
      text: '  Olá Nexus  ',
      attachments: [
        { base64: ' abc ', mimeType: 'image/jpg' },
        { base64: '', mimeType: 'image/png' },
        { base64: 'def', mimeType: 'application/pdf' },
      ],
    });

    expect(normalized).toEqual({
      normalizedText: 'Olá Nexus',
      normalizedTextLower: 'olá nexus',
      normalizedAttachments: [
        { base64: 'abc', mimeType: 'image/jpeg' },
      ],
      clientMessageId: null,
      idempotencyKey: null,
    });
  });

  it('persists the iOS language header only when the preference changes', () => {
    persistChatLanguagePreference({ header: () => 'pt-PT' }, 42);

    expect(mockSetUserLanguage).toHaveBeenCalledWith(42, 'pt-PT');
    expect(mockLoggerDebug).toHaveBeenCalledWith(
      { userId: 42, from: 'en-US', to: 'pt-PT', platform: 'ios' },
      'iOS X-Language header flipped user language preference',
    );

    mockSetUserLanguage.mockClear();
    mockLoggerDebug.mockClear();
    mockGetUserLanguage.mockReturnValue('pt-PT');

    persistChatLanguagePreference({ header: () => 'pt-PT' }, 42);

    expect(mockSetUserLanguage).not.toHaveBeenCalled();
    expect(mockLoggerDebug).not.toHaveBeenCalled();
  });

  it('does not block chat when language preference persistence fails', () => {
    mockGetUserLanguage.mockImplementationOnce(() => {
      throw new Error('database locked');
    });

    expect(() => persistChatLanguagePreference({ header: () => 'pt-BR' }, 42)).not.toThrow();
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      { err: expect.any(Error) },
      'iOS X-Language header handling failed — continuing with existing preference',
    );
  });

});
