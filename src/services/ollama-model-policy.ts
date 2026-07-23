// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * ServerDominguez runs Ollama in small-only mode. Keep the allowlist in one
 * dependency-free module so startup config, per-request chat routing, and
 * persisted portal overrides all enforce the same fail-closed rule.
 */
export const OLLAMA_SMALL_ONLY_MODEL = 'qwen2.5:3b-instruct-q4_K_M';
export const OLLAMA_FAST_MODEL_DISABLED = 'off';

export class OllamaSmallOnlyPolicyError extends Error {
  readonly code = 'ollama_small_only_policy_violation';

  constructor(source: string, model: string) {
    super(
      `${source} must be "${OLLAMA_SMALL_ONLY_MODEL}"`
      + ` (or "${OLLAMA_FAST_MODEL_DISABLED}" where explicitly supported); received "${model}"`,
    );
    this.name = 'OllamaSmallOnlyPolicyError';
  }
}

export function assertSmallOnlyOllamaModel(
  model: string,
  source: string,
  options: { allowOff?: boolean } = {},
): string {
  const normalized = model.trim();
  if (options.allowOff && normalized.toLowerCase() === OLLAMA_FAST_MODEL_DISABLED) {
    return OLLAMA_FAST_MODEL_DISABLED;
  }
  if (normalized !== OLLAMA_SMALL_ONLY_MODEL) {
    throw new OllamaSmallOnlyPolicyError(source, normalized || '(empty)');
  }
  return OLLAMA_SMALL_ONLY_MODEL;
}

export interface OllamaSmallOnlyRuntimeConfig {
  model: typeof OLLAMA_SMALL_ONLY_MODEL;
  classifierModel: typeof OLLAMA_SMALL_ONLY_MODEL;
  localChatModel: typeof OLLAMA_SMALL_ONLY_MODEL;
  localChatRecipeModel: typeof OLLAMA_SMALL_ONLY_MODEL;
  localChatFastModel: typeof OLLAMA_SMALL_ONLY_MODEL | typeof OLLAMA_FAST_MODEL_DISABLED;
}

/** Validate every environment-controlled local-model selection at startup. */
export function resolveOllamaSmallOnlyRuntimeConfig(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): OllamaSmallOnlyRuntimeConfig {
  const legacyRollback = String(env.OLLAMA_OPERATIONAL_ROLLBACK_MODEL ?? '').trim();
  if (legacyRollback) {
    throw new OllamaSmallOnlyPolicyError('OLLAMA_OPERATIONAL_ROLLBACK_MODEL (removed)', legacyRollback);
  }

  const model = assertSmallOnlyOllamaModel(
    String(env.OLLAMA_MODEL ?? OLLAMA_SMALL_ONLY_MODEL),
    'OLLAMA_MODEL',
  ) as typeof OLLAMA_SMALL_ONLY_MODEL;
  const classifierModel = assertSmallOnlyOllamaModel(
    String(env.OLLAMA_CLASSIFIER_MODEL ?? model),
    'OLLAMA_CLASSIFIER_MODEL',
  ) as typeof OLLAMA_SMALL_ONLY_MODEL;
  const localChatModel = assertSmallOnlyOllamaModel(
    String(env.CHAT_CORE_V2_LOCAL_CHAT_MODEL ?? classifierModel),
    'CHAT_CORE_V2_LOCAL_CHAT_MODEL',
  ) as typeof OLLAMA_SMALL_ONLY_MODEL;
  const localChatRecipeModel = assertSmallOnlyOllamaModel(
    String(env.CHAT_CORE_V2_LOCAL_CHAT_RECIPE_MODEL ?? localChatModel),
    'CHAT_CORE_V2_LOCAL_CHAT_RECIPE_MODEL',
  ) as typeof OLLAMA_SMALL_ONLY_MODEL;
  const localChatFastModel = assertSmallOnlyOllamaModel(
    String(env.CHAT_CORE_V2_LOCAL_CHAT_FAST_MODEL ?? OLLAMA_FAST_MODEL_DISABLED),
    'CHAT_CORE_V2_LOCAL_CHAT_FAST_MODEL',
    { allowOff: true },
  ) as OllamaSmallOnlyRuntimeConfig['localChatFastModel'];

  return {
    model,
    classifierModel,
    localChatModel,
    localChatRecipeModel,
    localChatFastModel,
  };
}
