import { describe, expect, it } from 'vitest';
import { authorizeChatToolCall } from '../../src/services/chat-tool-authorization';

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
});
