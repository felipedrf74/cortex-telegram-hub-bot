import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLazyAnthropicClient } from '../../src/services/anthropic-lazy-client';

describe('createLazyAnthropicClient', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('does not construct a client while the Anthropic runtime is disabled', () => {
    vi.stubEnv('ANTHROPIC_ENABLED', 'false');
    const client = createLazyAnthropicClient();

    expect(client.peekForTest()).toBeNull();
    expect(() => client.get()).toThrow('ANTHROPIC_RUNTIME_DISABLED');
    expect(client.peekForTest()).toBeNull();
  });

  it('does not construct a client when Anthropic is enabled without an API key', () => {
    vi.stubEnv('ANTHROPIC_ENABLED', 'true');
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    const client = createLazyAnthropicClient();

    expect(client.peekForTest()).toBeNull();
    expect(() => client.get()).toThrow('ANTHROPIC_RUNTIME_DISABLED');
    expect(client.peekForTest()).toBeNull();
  });

  it('constructs once on first enabled use and reuses the instance', () => {
    vi.stubEnv('ANTHROPIC_ENABLED', 'true');
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key');
    const client = createLazyAnthropicClient({ maxRetries: 2 });

    expect(client.peekForTest()).toBeNull();
    const first = client.get();
    expect(client.peekForTest()).toBe(first);
    expect(client.get()).toBe(first);
  });

  it('can reset the cached client in tests', () => {
    vi.stubEnv('ANTHROPIC_ENABLED', 'true');
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key');
    const client = createLazyAnthropicClient();

    client.get();
    expect(client.peekForTest()).not.toBeNull();
    client.resetForTest();
    expect(client.peekForTest()).toBeNull();
  });
});
