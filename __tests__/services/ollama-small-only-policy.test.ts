import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  assertSmallOnlyOllamaModel,
  OLLAMA_FAST_MODEL_DISABLED,
  OLLAMA_SMALL_ONLY_MODEL,
  resolveOllamaSmallOnlyRuntimeConfig,
} from '../../src/services/ollama-model-policy';

describe('Ollama small-only policy', () => {
  it('defaults every local role to 3B and disables the absent fast path', () => {
    expect(resolveOllamaSmallOnlyRuntimeConfig({})).toEqual({
      model: OLLAMA_SMALL_ONLY_MODEL,
      classifierModel: OLLAMA_SMALL_ONLY_MODEL,
      localChatModel: OLLAMA_SMALL_ONLY_MODEL,
      localChatRecipeModel: OLLAMA_SMALL_ONLY_MODEL,
      localChatFastModel: OLLAMA_FAST_MODEL_DISABLED,
    });
  });

  it.each([
    'OLLAMA_MODEL',
    'OLLAMA_CLASSIFIER_MODEL',
    'CHAT_CORE_V2_LOCAL_CHAT_MODEL',
    'CHAT_CORE_V2_LOCAL_CHAT_RECIPE_MODEL',
    'CHAT_CORE_V2_LOCAL_CHAT_FAST_MODEL',
  ])('fails closed when %s selects another tag', (key) => {
    expect(() => resolveOllamaSmallOnlyRuntimeConfig({ [key]: 'qwen3.6:35b-a3b-q4_K_M' }))
      .toThrow(`${key} must be`);
  });

  it('rejects the removed local rollback variable even when it names 3B', () => {
    expect(() => resolveOllamaSmallOnlyRuntimeConfig({
      OLLAMA_OPERATIONAL_ROLLBACK_MODEL: OLLAMA_SMALL_ONLY_MODEL,
    })).toThrow('OLLAMA_OPERATIONAL_ROLLBACK_MODEL (removed)');

    const configSource = readFileSync('src/config.ts', 'utf8');
    expect(configSource).toContain('operationalRollbackModel: OLLAMA_MODELS.model');
  });

  it('allows off only for the fast-chat model', () => {
    expect(resolveOllamaSmallOnlyRuntimeConfig({
      CHAT_CORE_V2_LOCAL_CHAT_FAST_MODEL: 'OFF',
    }).localChatFastModel).toBe('off');
    expect(() => assertSmallOnlyOllamaModel('off', 'OLLAMA_MODEL')).toThrow();
  });

  it('pins the installer to the bounded service policy', () => {
    const source = readFileSync('scripts/install-ollama.sh', 'utf8');
    for (const required of [
      'PRIMARY_MODEL="qwen2.5:3b-instruct-q4_K_M"',
      'readonly OLLAMA_MEMORY_HIGH="4G"',
      'readonly OLLAMA_MEMORY_MAX="6G"',
      'readonly OLLAMA_MEMORY_SWAP_MAX="512M"',
      'readonly OLLAMA_CONTEXT_LENGTH="4096"',
      'readonly OLLAMA_MAX_QUEUE="4"',
      'readonly OLLAMA_NUM_PARALLEL="1"',
      'readonly OLLAMA_MAX_LOADED_MODELS="1"',
      'readonly OLLAMA_CPU_QUOTA="200%"',
      'Environment="OLLAMA_MAX_LOADED_MODELS=${OLLAMA_MAX_LOADED_MODELS}"',
      'Environment="OLLAMA_NUM_PARALLEL=${OLLAMA_NUM_PARALLEL}"',
      'CPUQuota=${OLLAMA_CPU_QUOTA}',
      'CPUWeight=${OLLAMA_CPUWEIGHT}',
      'Nice=${OLLAMA_NICE}',
      'ollama-service-envelope-check.mjs" --expected-swap-bytes 536870912',
    ]) {
      expect(source).toContain(required);
    }
    expect(source).not.toMatch(/OLLAMA_(?:MEMORY_HIGH|MEMORY_MAX|MEMORY_SWAP_MAX|CONTEXT_LENGTH|MAX_QUEUE|NUM_PARALLEL|MAX_LOADED_MODELS|CPU_QUOTA)="\$\{/);
    expect(source).not.toContain('qwen3.6:');
    expect(source).not.toContain('gemma2:');
  });

  it('keeps staging health authenticated and required smokes fail-closed', () => {
    const source = readFileSync('scripts/staging-smoke-ollama.sh', 'utf8');
    expect(source).toContain('HEALTH_TOKEN is required');
    expect(source).toContain('-H @"${AUTH_HEADER_FILE}"');
    expect(source).toContain('Required small-only inference round-trip');
    expect(source).toContain('length == 1 and .[0].name == $model');
    expect(source).toContain('OLLAMA_INVENTORY_PHASE');
    expect(source).toContain('strict|pre_cleanup');
    expect(source).toContain('[$model, $remove1, $remove2, $remove3]');
    expect(source).toContain('.providers.gemini.circuit.state == "CLOSED"');
    expect(source).toContain('.providers.ollama.circuit.state == "CLOSED"');
    expect(source).toContain('$apps[0].AI_CLASSIFY_PRIMARY == "gemini"');
    expect(source).toContain('$apps[0].LOCAL_LLM_CLASSIFY_SHADOW == "true"');
    expect(source).toContain('$apps[0].CHAT_CORE_V2_LOCAL_CHAT_LLM_MODE == "shadow"');
    expect(source).toContain('$apps[0].LOCAL_LLM_EVALUATION_MODE == "false"');
    expect(source).toContain('$apps[0].AI_SCRIPT_GENERATION_FALLBACK == "approved_cloud_reasoning"');
    expect(source).toContain('$apps[0].AI_LOCAL_REASONING_FALLBACK == "approved_cloud_reasoning"');
    expect(source).toContain('$apps[0].CLOUD_REASONING_FALLBACK_ENABLED == "true"');
    expect(source).toContain('$apps[0].CLOUD_REASONING_REQUIRE_APPROVED_MODEL == "true"');
    expect(source).toContain('$apps[0].CLOUD_REASONING_ON_UNAPPROVED_MODEL == "fail_visibly"');
    expect(source).toContain('$apps[0].CLOUD_REASONING_PRIVACY_MODE == "never"');
    expect(source).toContain('$apps[0].CLOUD_REASONING_ALLOW_RAW_PRIVATE_DATA == "false"');
    expect(source).toContain('$provider == "gemini"');
    expect(source).toContain('$provider == "anthropic"');
    expect(source).toContain('$provider == "openai"');
    expect(source).toContain('test("^(gpt|chatgpt|o[1-9])([-.:]|$)")');
    expect(source).toContain('$approved_models | index($reasoning_model) != null');
    expect(source).toContain('$reasoning_model | contains("preview")');
    expect(source).toContain('$apps[0].CHAT_CORE_V2_LOCAL_CHAT_FAST_MODEL | ascii_downcase');
    expect(source).not.toContain('OLLAMA_REQUIRED_BACKEND_SMOKE_PATHS');
    expect(source).not.toContain('404 — endpoint not yet implemented');
  });

  it('keeps captured coach evaluation local unless a gated private-cloud run is explicitly authorized', () => {
    const source = readFileSync('scripts/coach-local-eval.mjs', 'utf8');
    expect(source).toContain("else if (arg === '--with-cloud') parsed.withCloud = true;");
    expect(source).toContain("else if (arg === '--operator-authorize-private-cloud') parsed.authorizePrivateCloud = true;");
    expect(source).toContain('const cloudRequested = args.withCloud || args.cloudOnly;');
    expect(source).toContain('if (cloudRequested && !args.authorizePrivateCloud)');
    expect(source).toContain('selectApprovedCloudReasoningProvider');
    expect(source).toContain('containsPrivateData: true');
    expect(source).toContain('allowCloudEscalation: true');
    expect(source).toContain('if (selection.rejected)');
    expect(source).toContain('selection.provider.callDomain(');
    expect(source).not.toContain('completeOneShotWithFallback(');
    expect(source).not.toMatch(/if \(!args\.localOnly\)\s*\{\s*try \{\s*const cloudRun/);
  });

  it('uses explicit queue arithmetic so Stryker cannot emit invalid postfix TypeScript', () => {
    const source = readFileSync('src/services/ollama-provider.ts', 'utf8');
    expect(source).toContain('queueState[key] = (queueState[key] as number) + 1;');
    expect(source).toContain('queueState[key] = (queueState[key] as number) - 1;');
    expect(source).not.toMatch(/\(queueState\[key\] as number\)(?:\+\+|--)/);
  });

  it('keeps full script generation and larger reasoning cloud-gated by default', () => {
    const configSource = readFileSync('src/config.ts', 'utf8');
    const providerSource = readFileSync('src/services/ollama-provider.ts', 'utf8');
    const scriptSource = readFileSync('src/services/script-generation.ts', 'utf8');

    expect(configSource).toContain("AI_SCRIPT_GENERATION_FALLBACK || 'approved_cloud_reasoning'");
    expect(configSource).toContain("LOCAL_LLM_EVALUATION_MODE || 'false'");
    expect(configSource).toContain("AI_SCRIPT_GENERATION_REQUIRE_LOCAL || 'false'");
    expect(providerSource).toContain('production_script_generation_requires_approved_cloud_reasoning');
    expect(providerSource).toContain("| 'validated_local_chat'");
    expect(providerSource).toContain("| 'classifier_shadow'");
    expect(providerSource).toContain("| 'offline_evaluation'");
    expect(providerSource).toContain("capability: 'local_workload_role_not_allowed'");
    expect(providerSource).toContain("Math.min(4096, readPositiveInt('OLLAMA_CLASSIFIER_NUM_CTX', 2048))");
    expect(configSource).not.toContain("max: 8192");
    expect(scriptSource).not.toContain('num_ctx: 8192');
    expect(scriptSource.match(/num_ctx: 4096/g)).toHaveLength(2);
  });
});
