import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loggerInfo = vi.fn();
const loggerWarn = vi.fn();
const loggerError = vi.fn();
const loggerDebug = vi.fn();

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: (...args: unknown[]) => loggerInfo(...args),
    warn: (...args: unknown[]) => loggerWarn(...args),
    error: (...args: unknown[]) => loggerError(...args),
    debug: (...args: unknown[]) => loggerDebug(...args),
  },
  LOGGER_REDACTION_PATHS: [],
}));

vi.mock('../../src/services/error-monitor', () => ({
  captureError: vi.fn(),
}));

describe('provider registry local fixture mode', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    loggerInfo.mockReset();
    loggerWarn.mockReset();
    loggerError.mockReset();
    loggerDebug.mockReset();
    process.env = {
      ...originalEnv,
      NODE_ENV: 'test',
      NEXUS_LOCAL_ALLOW_MODEL_CALLS: '0',
      ANTHROPIC_ENABLED: 'false',
      GEMINI_API_KEY: '',
      OPENAI_API_KEY: '',
      ANTHROPIC_API_KEY: '',
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('initializes deterministic fixture provider instead of throwing when local model calls are disabled', async () => {
    const { createRoutingProvider } = await import('../../src/services/provider-registry');

    const provider = createRoutingProvider();

    expect(provider.name).toBe('routing(fixture)');
    expect(loggerError).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('Failed to initialize AI provider routing'),
    );
    expect(loggerWarn).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('Configured primary provider unavailable'),
    );
    expect(loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        classify: 'fixture→none',
        chat: 'fixture→none',
        'tool-use': 'fixture→none',
        fixtureMode: true,
      }),
      'Provider routing initialized',
    );
  });

  it('returns safe deterministic fixture completions without provider calls', async () => {
    const { createRoutingProvider } = await import('../../src/services/provider-registry');

    const provider = createRoutingProvider();
    const classified = await provider.classify('write a YouTube script from my content references');
    const result = await provider.callDomain('content', [], 'draft it', '', { userId: 7, tenantId: 70 });
    const continuation = await provider.continueWithToolResults('content', [], 'continue', '', []);

    expect(classified).toEqual({ domain: 'content', confidence: 0.8 });
    expect(result).toMatchObject({
      text: expect.stringContaining('Local model fixture response for content'),
      toolCalls: [],
      stopReason: 'fixture',
    });
    expect(continuation).toMatchObject({
      text: expect.stringContaining('Local model fixture continuation for content'),
      toolCalls: [],
      stopReason: 'fixture',
    });
  });
});
