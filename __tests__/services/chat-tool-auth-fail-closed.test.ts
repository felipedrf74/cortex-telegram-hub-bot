import { describe, expect, it } from 'vitest';
import { authorizeChatToolCall, getChatToolRisk } from '../../src/services/chat-tool-authorization';

describe('chat tool authorization fail-closed behavior', () => {
  it('denies tool calls when AsyncLocalStorage authorization context is missing', () => {
    const result = authorizeChatToolCall('create_calendar_event', { title: 'private tenant event' }, 7, 70);

    expect(result).toMatchObject({
      allowed: false,
      code: 'AUTH_REQUIRED',
      toolRisk: 'write',
      message: 'create_calendar_event requires authenticated chat authorization context',
    });
  });

  it('classifies shared_memory_set as destructive because it persists long-lived memory', () => {
    expect(getChatToolRisk('shared_memory_set')).toBe('destructive');
  });
});
