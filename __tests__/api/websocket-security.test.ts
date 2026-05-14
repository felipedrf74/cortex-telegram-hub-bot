import { describe, expect, it } from 'vitest';

import { consumeWebSocketMessageBudget, isAllowedWebSocketOrigin } from '../../src/api/websocket';

describe('WebSocket security boundary helpers', () => {
  it('allows native clients and configured Nexus origins but rejects hostile browser origins', () => {
    const previousAllowedOrigins = process.env.IOS_WS_ALLOWED_ORIGINS;
    delete process.env.IOS_WS_ALLOWED_ORIGINS;

    try {
      expect(isAllowedWebSocketOrigin(undefined)).toBe(true);
      expect(isAllowedWebSocketOrigin('https://nexushub.me')).toBe(true);
      expect(isAllowedWebSocketOrigin('https://api.nexushub.me')).toBe(true);

      expect(isAllowedWebSocketOrigin('null')).toBe(false);
      expect(isAllowedWebSocketOrigin('https://nexushub.me.evil.test')).toBe(false);
      expect(isAllowedWebSocketOrigin('not a url')).toBe(false);
    } finally {
      if (previousAllowedOrigins === undefined) {
        delete process.env.IOS_WS_ALLOWED_ORIGINS;
      } else {
        process.env.IOS_WS_ALLOWED_ORIGINS = previousAllowedOrigins;
      }
    }
  });

  it('enforces a rolling per-connection message budget', () => {
    const state: { messageTimestamps?: number[] } = {};

    expect(consumeWebSocketMessageBudget(state, 1_000, 2)).toBe(true);
    expect(consumeWebSocketMessageBudget(state, 1_100, 2)).toBe(true);
    expect(consumeWebSocketMessageBudget(state, 1_200, 2)).toBe(false);

    expect(consumeWebSocketMessageBudget(state, 62_000, 2)).toBe(true);
  });
});
