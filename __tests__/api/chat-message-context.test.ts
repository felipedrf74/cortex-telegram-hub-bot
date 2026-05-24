import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetLastAssistantMessage = vi.fn();
const mockGetLastCoachState = vi.fn();
const mockHandleSecretary = vi.fn();
const mockHandleTriathlon = vi.fn();
const mockHandleContent = vi.fn();
const mockHandleFinance = vi.fn();
const mockHandleCooking = vi.fn();

vi.mock('../../src/state/conversation', () => ({
  getLastAssistantMessage: (...args: unknown[]) => mockGetLastAssistantMessage(...args),
}));

vi.mock('../../src/domains/domain-handler', () => ({
  getLastCoachState: (...args: unknown[]) => mockGetLastCoachState(...args),
}));

vi.mock('../../src/domains/secretary', () => ({
  handleSecretary: (...args: unknown[]) => mockHandleSecretary(...args),
}));

vi.mock('../../src/domains/triathlon', () => ({
  handleTriathlon: (...args: unknown[]) => mockHandleTriathlon(...args),
}));

vi.mock('../../src/domains/content-creator', () => ({
  handleContent: (...args: unknown[]) => mockHandleContent(...args),
}));

vi.mock('../../src/domains/finance', () => ({
  handleFinance: (...args: unknown[]) => mockHandleFinance(...args),
}));

vi.mock('../../src/domains/cooking', () => ({
  handleCooking: (...args: unknown[]) => mockHandleCooking(...args),
}));

import {
  CHAT_ACTIVE_DOMAIN_TTL_MS,
  buildDefaultButtonsForChatDomain,
  clearChatActiveDomain,
  getChatDomainHandler,
  getLastChatActiveDomain,
  rememberChatActiveDomain,
  resetChatMessageContextForTests,
  resolveChatActiveContext,
  setLastActiveDomain,
} from '../../src/api/routes/chat-message-context';

describe('chat message context helpers', () => {
  beforeEach(() => {
    resetChatMessageContextForTests();
    mockGetLastAssistantMessage.mockReset();
    mockGetLastCoachState.mockReset();
    mockHandleSecretary.mockReset();
    mockHandleTriathlon.mockReset();
    mockHandleContent.mockReset();
    mockHandleFinance.mockReset();
    mockHandleCooking.mockReset();
  });

  it('keeps recent active-domain continuity with the last assistant message', () => {
    const now = Date.parse('2026-04-24T11:00:00.000Z');
    mockGetLastAssistantMessage.mockReturnValue('Latest secretary answer');

    rememberChatActiveDomain(42, 'secretary', now - 1000);

    expect(getLastChatActiveDomain(42, now)).toBe('secretary');
    expect(resolveChatActiveContext(42, now)).toEqual({
      domain: 'secretary',
      lastAssistantMessage: 'Latest secretary answer',
    });
    expect(mockGetLastAssistantMessage).toHaveBeenCalledWith(42, 'secretary');
  });

  it('drops expired or missing active-domain continuity', () => {
    const now = Date.parse('2026-04-24T11:00:00.000Z');

    rememberChatActiveDomain(42, 'finance', now - CHAT_ACTIVE_DOMAIN_TTL_MS - 1);

    expect(getLastChatActiveDomain(42, now)).toBeNull();
    expect(resolveChatActiveContext(42, now)).toBeNull();
    expect(mockGetLastAssistantMessage).not.toHaveBeenCalled();

    rememberChatActiveDomain(42, 'finance', now - 1000);
    clearChatActiveDomain(42);
    expect(getLastChatActiveDomain(42, now)).toBeNull();
  });

  it('exposes a scheduler-facing active-domain helper without Telegram state', () => {
    const before = Date.now();

    setLastActiveDomain(42, 'triathlon', 7);

    expect(getLastChatActiveDomain(42, before, 7)).toBe('triathlon');
    expect(getLastChatActiveDomain(42, before)).toBeNull();
  });

  it('fails closed when the conversation store cannot provide continuity', () => {
    const now = Date.parse('2026-04-24T11:00:00.000Z');
    mockGetLastAssistantMessage.mockImplementation(() => {
      throw new Error('conversation unavailable');
    });

    rememberChatActiveDomain(42, 'content', now - 1000);

    expect(resolveChatActiveContext(42, now)).toBeNull();
  });

  it('resolves only registered chat domain handlers', async () => {
    mockHandleSecretary.mockResolvedValue({ text: 'Done', domain: 'secretary' });

    const handler = getChatDomainHandler('secretary');

    expect(handler).toBeTypeOf('function');
    await expect(handler?.('What is today?', 42)).resolves.toEqual({ text: 'Done', domain: 'secretary' });
    expect(getChatDomainHandler('unknown')).toBeUndefined();
  });

  it('builds localized secretary default action buttons', () => {
    expect(buildDefaultButtonsForChatDomain('secretary', 'pt-PT')).toEqual([[
      { text: '📅 Hoje', callbackData: 'cmd:/day' },
      { text: '📋 Tarefas', callbackData: 'cmd:/todo_summary' },
      { text: '🗓 Semana', callbackData: 'cmd:/week' },
    ]]);
  });

  it('only exposes coach recommendation buttons for fresh triathlon state', () => {
    const requestStartedAt = Date.parse('2026-04-24T11:00:00.000Z');
    mockGetLastCoachState.mockReturnValue({
      timestamp: requestStartedAt,
      recommendations: [
        {
          eventId: 'evt-1',
          action: 'MODIFY',
          summary: 'Adjust intensity',
        },
      ],
    });

    const buttons = buildDefaultButtonsForChatDomain('triathlon', 'en-US', 42, requestStartedAt);
    expect(buttons?.[0]?.[0]?.text).toContain('Adjust intensity');

    mockGetLastCoachState.mockReturnValue({
      timestamp: requestStartedAt - 2000,
      recommendations: [
        {
          eventId: 'evt-2',
          action: 'MODIFY',
          summary: 'Old recommendation',
        },
      ],
    });

    expect(buildDefaultButtonsForChatDomain('triathlon', 'en-US', 42, requestStartedAt)).toBeNull();
  });
});
