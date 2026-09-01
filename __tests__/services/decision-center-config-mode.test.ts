import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

async function loadConfigFresh() {
  vi.resetModules();
  return import('../../src/config');
}

describe('Decision Center rewrite startup mode', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.unstubAllEnvs();
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('IOS_API_ENABLED', 'false');
    vi.stubEnv('STAGING', 'false');
    delete process.env.DECISION_CENTER_REWRITE_MODE;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    process.env = { ...ORIGINAL_ENV };
    vi.resetModules();
  });

  it('makes the rewrite authoritative when the mode is absent', async () => {
    const { config } = await loadConfigFresh();
    expect(config.decisionCenter.rewriteMode).toBe('active');
  });

  it.each(['active', 'legacy'] as const)('accepts the explicit %s engine', async (mode) => {
    vi.stubEnv('DECISION_CENTER_REWRITE_MODE', mode);
    const { config } = await loadConfigFresh();
    expect(config.decisionCenter.rewriteMode).toBe(mode);
  });

  it.each(['', 'ACTIVE', 'shadow', 'legacy '])(
    'fails startup for invalid explicit mode %j',
    async (mode) => {
      vi.stubEnv('DECISION_CENTER_REWRITE_MODE', mode);
      await expect(loadConfigFresh()).rejects.toThrow(
        'DECISION_CENTER_REWRITE_MODE must be "active" or "legacy".',
      );
    },
  );
});
