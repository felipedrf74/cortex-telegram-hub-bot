import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('local-primary release controls', () => {
  it('defaults every admission switch off and keeps the approved ceilings', async () => {
    vi.stubEnv('LOCAL_PRIMARY_CONTENT_PROXY_ENABLED', '');
    vi.stubEnv('LOCAL_PRIMARY_SCRIPT_JOBS_ENABLED', '');
    vi.stubEnv('CONTENT_SCRIPT_JOBS_CLOUD_PRIMARY_ENABLED', '');
    vi.stubEnv('CONTENT_SCRIPT_JOBS_PUBLIC_ENABLED', '');
    vi.stubEnv('LOCAL_PRIMARY_LLM_HARD_KILL', '');
    vi.stubEnv('OLLAMA_GATEWAY_SOCKET_PATH', '');
    vi.stubEnv('LOCAL_PRIMARY_STAFF_USER_IDS', '');
    const { localPrimaryInferenceConfig } = await import('../../src/services/local-primary-config');
    expect(localPrimaryInferenceConfig).toMatchObject({
      contentProxyEnabled: false,
      scriptJobsEnabled: false,
      scriptJobsCloudPrimaryEnabled: false,
      scriptJobsPublicEnabled: false,
      hardKill: false,
      gatewaySocketPath: '',
      staffUserIds: [],
      maxContextTokens: 16_384,
      maxOutputTokens: 6_144,
      waitingQueueDepth: 4,
    });
  });

  it('accepts ordinary feature flags and fail-safe emergency-kill spellings', async () => {
    vi.stubEnv('LOCAL_PRIMARY_CONTENT_PROXY_ENABLED', 'true');
    vi.stubEnv('LOCAL_PRIMARY_SCRIPT_JOBS_ENABLED', 'true');
    vi.stubEnv('CONTENT_SCRIPT_JOBS_CLOUD_PRIMARY_ENABLED', 'true');
    vi.stubEnv('CONTENT_SCRIPT_JOBS_PUBLIC_ENABLED', 'true');
    vi.stubEnv('LOCAL_PRIMARY_LLM_HARD_KILL', 'TRUE');
    vi.stubEnv('OLLAMA_GATEWAY_SOCKET_PATH', '/run/nexus-inference/staging/ollama.sock');
    vi.stubEnv('LOCAL_PRIMARY_STAFF_USER_IDS', '42, 84, invalid, -1, 1.5');
    const { localPrimaryInferenceConfig } = await import('../../src/services/local-primary-config');
    expect(localPrimaryInferenceConfig.contentProxyEnabled).toBe(true);
    expect(localPrimaryInferenceConfig.scriptJobsEnabled).toBe(true);
    expect(localPrimaryInferenceConfig.scriptJobsCloudPrimaryEnabled).toBe(true);
    expect(localPrimaryInferenceConfig.scriptJobsPublicEnabled).toBe(true);
    expect(localPrimaryInferenceConfig.hardKill).toBe(true);
    expect(localPrimaryInferenceConfig.gatewaySocketPath)
      .toBe('/run/nexus-inference/staging/ollama.sock');
    expect(localPrimaryInferenceConfig.staffUserIds).toEqual([42, 84]);
  });

  it.each(['1', 'true', 'TRUE', 'yes', 'YES', 'on', 'ON'])(
    'treats %s as an affirmative emergency kill',
    async (value) => {
      vi.stubEnv('LOCAL_PRIMARY_LLM_HARD_KILL', value);
      const { localPrimaryInferenceConfig } = await import('../../src/services/local-primary-config');
      expect(localPrimaryInferenceConfig.hardKill).toBe(true);
    },
  );

  it('normalizes a whitespace-only gateway path to the fail-closed empty value', async () => {
    vi.stubEnv('OLLAMA_GATEWAY_SOCKET_PATH', '   ');
    const { localPrimaryInferenceConfig } = await import('../../src/services/local-primary-config');
    expect(localPrimaryInferenceConfig.gatewaySocketPath).toBe('');
  });
});
