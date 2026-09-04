import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import * as runtimeFlags from '../../src/services/runtime-flags';
import {
  RUNTIME_FLAG_CATALOG,
  RUNTIME_FLAG_NON_CATALOG_EXPORTS,
  readRuntimeFlagCatalog,
} from '../../src/services/runtime-flags-catalog';

const runtimeFlagsSource = fs.readFileSync(path.resolve(__dirname, '../../src/services/runtime-flags.ts'), 'utf8');

function exportedReaderNames(): string[] {
  return Object.keys(runtimeFlags)
    .filter((name) => typeof (runtimeFlags as Record<string, unknown>)[name] === 'function')
    .filter((name) => /^(is|get|are|can|resolve)[A-Z]/.test(name))
    .sort();
}

describe('runtime flag catalog', () => {
  it('covers every flag reader exported by runtime-flags.ts exactly once', () => {
    const cataloged = RUNTIME_FLAG_CATALOG.map((entry) => entry.name);
    const listed = [...cataloged, ...RUNTIME_FLAG_NON_CATALOG_EXPORTS].sort();
    expect(new Set(listed).size).toBe(listed.length);
    expect(listed).toEqual(exportedReaderNames());
  });

  it('names only env keys that runtime-flags.ts actually consults, and never secret-bearing ones', () => {
    for (const entry of RUNTIME_FLAG_CATALOG) {
      expect(entry.envKeys.length, `${entry.name} has no env keys`).toBeGreaterThan(0);
      for (const key of entry.envKeys) {
        expect(runtimeFlagsSource.includes(key), `${entry.name} references ${key}, which runtime-flags.ts never reads`).toBe(true);
        expect(key).not.toMatch(/(KEY|SECRET|TOKEN|PASSWORD)$/);
      }
    }
  });

  it('reads parsed values without leaking raw env strings', () => {
    const env: NodeJS.ProcessEnv = {
      ANTHROPIC_ENABLED: 'true',
      ANTHROPIC_API_KEY: 'sk-super-secret-value',
      CHAT_LLM_TIER1_ENABLED: 'true',
      CHAT_LLM_TIER1_ENABLED_USER_7: 'false',
      CHAT_LLM_TIER1_ENABLED_TENANT_3: 'false',
      SECRETARY_REASONING_V1_MODE: 'shadow',
      TRAINING_PLAN_M4_ALLOWLIST: 'user-alpha:run,user-beta:cycle',
    };
    const readings = readRuntimeFlagCatalog(env);
    const serialized = JSON.stringify(readings);

    expect(readings).toHaveLength(RUNTIME_FLAG_CATALOG.length);
    expect(serialized).not.toContain('sk-super-secret-value');
    expect(readings.filter((reading) => reading.error)).toEqual([]);

    const byName = new Map(readings.map((reading) => [reading.name, reading]));
    expect(byName.get('isAnthropicRuntimeEnabled')?.value).toBe(true);
    expect(byName.get('isAnthropicRuntimeEnabled')?.envSet).toEqual({ ANTHROPIC_ENABLED: true });
    expect(byName.get('isChatLlmTier1Enabled')?.value).toBe(true);
    expect(byName.get('isChatLlmTier1Enabled')?.scopedOverrides).toBe(2);
    expect(byName.get('getSecretaryReasoningV1Mode')?.value).toBe('shadow');
    expect(byName.get('getAICallTimeoutMs')?.envSet).toEqual({ AI_CALL_TIMEOUT_MS: false });

    const allowlist = byName.get('getTrainingM4Allowlist');
    expect(allowlist?.redacted).toBe(true);
    expect(typeof allowlist?.value).toBe('string');
    expect(String(allowlist?.value)).toMatch(/entries$/);
    expect(serialized).not.toContain('user-alpha');
  });

  it('reports a reader error instead of throwing when a flag reader fails', () => {
    const env = new Proxy({} as NodeJS.ProcessEnv, {
      get(_target, key) {
        if (key === 'AI_CALL_TIMEOUT_MS') throw new Error('boom');
        return undefined;
      },
      ownKeys: () => [],
      getOwnPropertyDescriptor: () => undefined,
    });
    const reading = readRuntimeFlagCatalog(env).find((entry) => entry.name === 'getAICallTimeoutMs');
    expect(reading?.error).toBe('boom');
    expect(reading?.value).toBeNull();
  });
});
