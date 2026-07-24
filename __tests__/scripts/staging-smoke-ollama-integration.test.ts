import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(path, 'utf8');

describe('canonical staging gate Ollama integration', () => {
  it('runs the exact-release policy smoke once in the existing sequential gate', () => {
    const canonical = read('scripts/staging-smoke.sh');
    const ollama = read('scripts/staging-smoke-ollama.sh');
    const operator = read('scripts/release-operator.sh');

    expect(canonical.match(/staging-smoke-ollama\.sh/g)).toHaveLength(1);
    expect(canonical).toContain('OLLAMA_INVENTORY_PHASE=governed');
    expect(canonical).toContain('NEXUS_HUB_BASE_URL=http://127.0.0.1:8201');
    expect(canonical).toContain('PM2_APP_NAME=nexus-hub-staging');
    expect(canonical).toContain('PM2_BIN=/home/dominguez/.npm-global/bin/pm2');
    expect(canonical).toContain('evidence_record "Ollama release policy"');
    expect(ollama).toContain('strict|pre_cleanup|governed');
    expect(ollama).toContain('PM2_BIN must name an absolute executable PM2 launcher');
    expect(ollama).toContain('$names == ([$model] | sort)');
    expect(ollama).toContain('$names == ([$model, $remove1, $remove2, $remove3] | sort)');
    expect(ollama).toContain('test($disallowed_model_pattern)');
    expect(ollama).not.toContain('test("flash|nano|mini|haiku|lite|classifier|fast")');
    const pattern = ollama.match(
      /^DISALLOWED_REASONING_MODEL_TOKEN_PATTERN='([^']+)'$/m,
    )?.[1];
    expect(pattern).toBeTruthy();
    const disallowedModelToken = new RegExp(pattern!);
    expect(disallowedModelToken.test('gemini-2.5-pro')).toBe(false);
    expect(disallowedModelToken.test('gpt-5-mini')).toBe(true);
    expect(disallowedModelToken.test('gemini-2.5-flash')).toBe(true);
    expect(disallowedModelToken.test('claude-haiku-4-5')).toBe(true);
    expect(disallowedModelToken.test('geminiflash')).toBe(false);

    const filterStart = ollama.indexOf(
      '      [.[] | select(.name == $name and .pm2_env.status == "online")',
    );
    const filterEnd = ollama.indexOf("\n    ' >/dev/null; then", filterStart);
    expect(filterStart).toBeGreaterThan(0);
    expect(filterEnd).toBeGreaterThan(filterStart);
    const routingFilter = ollama.slice(filterStart, filterEnd);
    const appName = 'nexus-hub-staging';
    const retainedModel = 'qwen2.5:3b-instruct-q4_K_M';
    const routingEnvironment = (provider: string, model: string) => ({
      status: 'online',
      OLLAMA_ENABLED: 'true',
      AI_CLASSIFY_PRIMARY: 'gemini',
      LOCAL_LLM_CLASSIFY_SHADOW: 'true',
      CHAT_CORE_V2_LOCAL_CHAT_LLM_MODE: 'shadow',
      LOCAL_LLM_EVALUATION_MODE: 'false',
      AI_SCRIPT_GENERATION_REQUIRE_LOCAL: 'false',
      AI_SCRIPT_GENERATION_FALLBACK: 'approved_cloud_reasoning',
      AI_LOCAL_REASONING_FALLBACK: 'approved_cloud_reasoning',
      CLOUD_REASONING_FALLBACK_ENABLED: 'true',
      CLOUD_REASONING_REQUIRE_APPROVED_MODEL: 'true',
      CLOUD_REASONING_ON_UNAPPROVED_MODEL: 'fail_visibly',
      CLOUD_REASONING_PRIVACY_MODE: 'never',
      CLOUD_REASONING_ALLOW_RAW_PRIVATE_DATA: 'false',
      CLOUD_REASONING_PROVIDER: provider,
      CLOUD_REASONING_MODEL: model,
      APPROVED_REASONING_MODELS: model,
      OLLAMA_MODEL: retainedModel,
      OLLAMA_CLASSIFIER_MODEL: retainedModel,
      CHAT_CORE_V2_LOCAL_CHAT_MODEL: retainedModel,
      CHAT_CORE_V2_LOCAL_CHAT_RECIPE_MODEL: retainedModel,
      CHAT_CORE_V2_LOCAL_CHAT_FAST_MODEL: 'off',
    });
    const evaluateRouting = (provider: string, model: string, environment = {}) => {
      const input = JSON.stringify([{
        name: appName,
        pm2_env: { ...routingEnvironment(provider, model), ...environment },
      }]);
      return execFileSync('jq', [
        '-e',
        '--arg', 'name', appName,
        '--arg', 'model', retainedModel,
        '--arg', 'disallowed_model_pattern', pattern!,
        routingFilter,
      ], { input, encoding: 'utf8' });
    };

    expect(() => evaluateRouting('gemini', 'gemini-2.5-pro')).not.toThrow();
    for (const [provider, model] of [
      ['openai', 'gpt-5-mini'],
      ['gemini', 'gemini-2.5-flash'],
      ['anthropic', 'claude-haiku-4-5'],
    ]) {
      expect(() => evaluateRouting(provider, model)).toThrow();
    }
    expect(() => evaluateRouting('anthropic', 'gemini-2.5-pro')).toThrow();
    expect(() => evaluateRouting('gemini', 'gemini-2.5-pro', {
      OLLAMA_ENABLED: 'false',
    })).toThrow();

    expect(operator).toContain('scripts/staging-smoke.sh');
    expect(operator).not.toContain('scripts/staging-smoke-ollama.sh');
  });
});
