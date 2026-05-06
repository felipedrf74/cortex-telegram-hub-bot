import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loggerWarn = vi.fn();
const loggerInfo = vi.fn();
const loggerDebug = vi.fn();
const loggerError = vi.fn();
const captureError = vi.fn();

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
  captureError: (...args: unknown[]) => captureError(...args),
}));

describe('provider registry Anthropic gate observability', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    loggerWarn.mockReset();
    loggerInfo.mockReset();
    loggerDebug.mockReset();
    loggerError.mockReset();
    captureError.mockReset();
    process.env = {
      ...originalEnv,
      NODE_ENV: 'test',
      NEXUS_LOCAL_ALLOW_MODEL_CALLS: '1',
      AI_CHAT_PRIMARY: 'anthropic',
      AI_CHAT_FALLBACK: 'openai',
      ANTHROPIC_ENABLED: 'false',
      ANTHROPIC_API_KEY: 'anthropic-disabled',
      OPENAI_API_KEY: 'sk-test',
      GEMINI_API_KEY: '',
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('emits a warning when chat primary is pinned to Anthropic while Anthropic is disabled', async () => {
    const { createRoutingProvider } = await import('../../src/services/provider-registry');

    const provider = createRoutingProvider();

    expect(provider.name).toContain('routing(');
    expect(loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        taskType: 'chat',
        position: 'primary',
        configuredProvider: 'anthropic',
        anthropicEnabled: false,
      }),
      'Anthropic provider configured while ANTHROPIC_ENABLED is false; provider will be skipped',
    );
    expect(captureError).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'warning',
        message: 'Anthropic provider configured while disabled for chat primary',
        context: expect.objectContaining({
          taskType: 'chat',
          position: 'primary',
        }),
      }),
      false,
    );
  });
});
