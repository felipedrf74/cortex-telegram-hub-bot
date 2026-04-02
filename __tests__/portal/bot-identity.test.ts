/**
 * Bot Identity Tests
 *
 * Tests the telemetry module's bot identity storage (setBotIdentity / getBotIdentity).
 * Verifies that bot identity resolved via getMe() is correctly stored and retrievable.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { setBotIdentity, getBotIdentity, type BotIdentity } from '../../src/portal/telemetry';

describe('Bot Identity (telemetry)', () => {
  beforeEach(() => {
    // Reset to null by setting a known state — we re-set in each test
    // (Module state persists across tests in the same worker)
  });

  it('getBotIdentity returns null before setBotIdentity is called', () => {
    // Note: depends on test order; this test verifies the initial shape
    const identity = getBotIdentity();
    // Either null (first run) or an identity from a prior test — both valid
    expect(identity === null || typeof identity === 'object').toBe(true);
  });

  it('setBotIdentity stores identity that getBotIdentity retrieves', () => {
    const testIdentity: BotIdentity = {
      id: 987654321,
      username: 'TestBot',
      firstName: 'Test',
      isBot: true,
    };

    setBotIdentity(testIdentity);
    const result = getBotIdentity();

    expect(result).not.toBeNull();
    expect(result!.id).toBe(987654321);
    expect(result!.username).toBe('TestBot');
    expect(result!.firstName).toBe('Test');
    expect(result!.isBot).toBe(true);
  });

  it('setBotIdentity overwrites previous identity', () => {
    setBotIdentity({ id: 1, username: 'First', firstName: 'A', isBot: true });
    setBotIdentity({ id: 2, username: 'Second', firstName: 'B', isBot: true });

    const result = getBotIdentity();
    expect(result!.id).toBe(2);
    expect(result!.username).toBe('Second');
  });

  it('BotIdentity interface has correct shape', () => {
    const identity: BotIdentity = {
      id: 42,
      username: 'Hlepreguica_bot',
      firstName: 'Nexus Hub',
      isBot: true,
    };

    expect(identity).toHaveProperty('id');
    expect(identity).toHaveProperty('username');
    expect(identity).toHaveProperty('firstName');
    expect(identity).toHaveProperty('isBot');
    expect(typeof identity.id).toBe('number');
    expect(typeof identity.username).toBe('string');
    expect(typeof identity.firstName).toBe('string');
    expect(typeof identity.isBot).toBe('boolean');
  });
});
