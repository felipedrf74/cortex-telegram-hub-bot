import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  storeChatMessage: vi.fn(),
  updateAssistantMessage: vi.fn(),
  addToConversation: vi.fn(),
  syncLastAssistantConversationMessage: vi.fn(),
}));

vi.mock('../../src/services/chat-history-store', () => ({
  storeChatMessage: (...args: unknown[]) => mocks.storeChatMessage(...args),
  updateAssistantMessage: (...args: unknown[]) => mocks.updateAssistantMessage(...args),
}));

vi.mock('../../src/state/conversation', () => ({
  addToConversation: (...args: unknown[]) => mocks.addToConversation(...args),
  syncLastAssistantConversationMessage: (...args: unknown[]) => mocks.syncLastAssistantConversationMessage(...args),
}));

import {
  persistAssistantEdit,
  persistCallbackAssistantResponse,
  persistExchange,
  syncConversationStateForShortcut,
} from '../../src/api/routes/chat-persistence';

describe('chat-persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('persists user and assistant exchange entries together', () => {
    persistExchange(42, 'u-1', 'hello', 'a-1', {
      text: 'hi',
      domain: 'secretary',
      routeMethod: 'fast-path',
      confidence: 0.91,
      buttons: [[{ text: 'Today', callbackData: 'cmd:/day' }]],
      metadata: { source: 'test' },
      timestamp: '2026-04-23T10:00:00.000Z',
    }, 1001);

    expect(mocks.storeChatMessage).toHaveBeenCalledTimes(2);
    expect(mocks.storeChatMessage).toHaveBeenNthCalledWith(1, {
      tenantId: 1001,
      userId: 42,
      messageId: 'u-1',
      role: 'user',
      text: 'hello',
      timestamp: '2026-04-23T10:00:00.000Z',
      lifecycleState: 'sent',
      clientMessageId: null,
      requestId: null,
    });
    expect(mocks.storeChatMessage).toHaveBeenNthCalledWith(2, {
      tenantId: 1001,
      userId: 42,
      messageId: 'a-1',
      role: 'assistant',
      text: 'hi',
      domain: 'secretary',
      routeMethod: 'fast-path',
      confidence: 0.91,
      buttons: [[{ text: 'Today', callbackData: 'cmd:/day' }]],
      metadata: { source: 'test' },
      timestamp: '2026-04-23T10:00:00.000Z',
      lifecycleState: 'completed',
      completedAt: '2026-04-23T10:00:00.000Z',
      retryOfMessageId: 'u-1',
      requestId: null,
    });
  });

  it('syncs shortcut conversation turns', () => {
    syncConversationStateForShortcut(42, 'finance', 'budget?', 'Budget is stable.', 1001);

    expect(mocks.addToConversation).toHaveBeenCalledTimes(2);
    expect(mocks.addToConversation).toHaveBeenNthCalledWith(1, 42, 'finance', 'user', 'budget?', 1001);
    expect(mocks.addToConversation).toHaveBeenNthCalledWith(2, 42, 'finance', 'assistant', 'Budget is stable.', 1001);
  });

  it('edits persisted assistant messages and syncs conversation state', () => {
    mocks.updateAssistantMessage.mockReturnValue(true);

    const updated = persistAssistantEdit({
      userId: 42,
      messageId: 'a-1',
      text: 'Updated',
      domain: 'secretary',
      buttons: null,
      metadata: null,
      routeMethod: 'fast-path',
      timestamp: '2026-04-23T10:01:00.000Z',
      tenantId: 1001,
    });

    expect(updated).toBe(true);
    expect(mocks.updateAssistantMessage).toHaveBeenCalledWith(42, 'a-1', {
      text: 'Updated',
      domain: 'secretary',
      buttons: null,
      metadata: null,
      routeMethod: 'fast-path',
      confidence: null,
      timestamp: '2026-04-23T10:01:00.000Z',
    }, 1001);
    expect(mocks.syncLastAssistantConversationMessage).toHaveBeenCalledWith(42, 'secretary', 'Updated', 1001);
  });

  it('stores a fallback callback message when original edit misses', () => {
    mocks.updateAssistantMessage.mockReturnValue(false);

    const result = persistCallbackAssistantResponse({
      userId: 42,
      messageId: 'missing',
      text: 'Cancelled.',
      domain: 'secretary',
      buttons: null,
      metadata: null,
      timestamp: '2026-04-23T10:02:00.000Z',
      editOriginal: true,
      fallbackMessageId: 'cb-test',
      tenantId: 1001,
    });

    expect(result).toEqual({ updatedOriginal: false, storedFallback: true });
    expect(mocks.updateAssistantMessage).toHaveBeenCalledTimes(1);
    expect(mocks.storeChatMessage).toHaveBeenCalledWith({
      tenantId: 1001,
      userId: 42,
      messageId: 'cb-test',
      role: 'assistant',
      text: 'Cancelled.',
      domain: 'secretary',
      routeMethod: undefined,
      confidence: undefined,
      buttons: null,
      metadata: null,
      timestamp: '2026-04-23T10:02:00.000Z',
    });
    expect(mocks.syncLastAssistantConversationMessage).toHaveBeenCalledWith(42, 'secretary', 'Cancelled.', 1001);
  });
});
