import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  dispatchLocalReasoning: vi.fn(),
}));

vi.mock('../../src/services/provider-registry', () => ({
  ensureActiveProvider: vi.fn(() => ({
    dispatchLocalReasoning: mocks.dispatchLocalReasoning,
  })),
}));

import {
  COMPOSED_ANSWER_DRAFT_SCHEMA_VERSION,
} from '../../src/services/chat-core-v2/answer-composition';
import {
  isChatCoreV2LocalChatVisibleEnabled,
  resolveChatCoreV2LocalChatLlmMode,
  runChatCoreV2LocalChatTurn,
} from '../../src/services/chat-core-v2/local-chat-orchestrator';

function baseEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    CHAT_CORE_V2_ORCHESTRATOR_MODE: 'canary',
    CHAT_CORE_V2_ALLOWED_SURFACES: 'ios',
    CHAT_CORE_V2_LOCAL_CHAT_LLM_MODE: 'canary',
    CHAT_CORE_V2_LOCAL_CHAT_MODEL: 'qwen2.5:3b-instruct-q4_K_M',
    ...overrides,
  } as NodeJS.ProcessEnv;
}

describe('ChatCoreV2 local chat orchestrator', () => {
  beforeEach(() => {
    mocks.dispatchLocalReasoning.mockReset();
  });

  it('keeps the master orchestrator switch authoritative', () => {
    const env = baseEnv({
      CHAT_CORE_V2_ORCHESTRATOR_MODE: 'off',
      CHAT_CORE_V2_LOCAL_CHAT_LLM_MODE: 'on',
    });

    expect(resolveChatCoreV2LocalChatLlmMode(env)).toBe('off');
    expect(isChatCoreV2LocalChatVisibleEnabled(env, {
      surface: 'ios',
      userId: 42,
      tenantId: 84,
    })).toBe(false);
  });

  it('does not visible-enable canary mode in production without an explicit allow flag', () => {
    expect(isChatCoreV2LocalChatVisibleEnabled(baseEnv({ NODE_ENV: 'production' }), {
      surface: 'ios',
      userId: 42,
      tenantId: 84,
    })).toBe(false);

    expect(isChatCoreV2LocalChatVisibleEnabled(baseEnv({
      NODE_ENV: 'production',
      CHAT_CORE_V2_LOCAL_CHAT_ALLOW_PROD: '1',
      CHAT_CORE_V2_LOCAL_CHAT_CANARY_USERS: '84:42',
    }), {
      surface: 'ios',
      userId: 42,
      tenantId: 84,
    })).toBe(true);
  });

  it('returns a validated local LLM response for non-write chat using constrained plain text by default', async () => {
    mocks.dispatchLocalReasoning.mockResolvedValue({
      text: 'Uma boa estratégia é escolher uma prioridade pequena e terminar antes de abrir outra.',
      providerMetadata: {
        providerUsed: 'ollama',
        modelUsed: 'qwen2.5:3b-instruct-q4_K_M',
        fallbackUsed: false,
      },
    });

    const result = await runChatCoreV2LocalChatTurn({
      normalizedText: 'Como posso manter foco hoje?',
      userId: 42,
      tenantId: 84,
      requestId: 'req-1',
      locale: 'pt-BR',
      surface: 'ios',
      env: baseEnv(),
    });

    expect(result?.degraded).toBe(false);
    expect(result?.response.routeMethod).toBe('chat-core-v2-local-llm');
    expect(result?.response.text).toContain('prioridade pequena');
    expect(mocks.dispatchLocalReasoning).toHaveBeenCalledWith(expect.objectContaining({
      modelOverride: 'qwen2.5:3b-instruct-q4_K_M',
      think: false,
      numCtx: 512,
      numPredict: 80,
      timeoutMs: 15000,
      outputSchema: undefined,
      allowCloudEscalation: false,
      containsPrivateData: true,
      systemContext: expect.stringContaining('Answer the CURRENT message directly'),
      prompt: expect.stringContaining('current: Como posso manter foco hoje?'),
    }));
  });

  it('can require structured JSON output when the feature flag is enabled', async () => {
    mocks.dispatchLocalReasoning.mockResolvedValue({
      text: JSON.stringify({
        schemaVersion: COMPOSED_ANSWER_DRAFT_SCHEMA_VERSION,
        mode: 'model_constrained',
        locale: 'pt-BR',
        text: 'Escolhe uma prioridade pequena e protege um bloco curto para terminá-la.',
        factualClaims: [],
        reasonCodes: ['general_answer'],
      }),
      parsed: {
        schemaVersion: COMPOSED_ANSWER_DRAFT_SCHEMA_VERSION,
        mode: 'model_constrained',
        locale: 'pt-BR',
        text: 'Escolhe uma prioridade pequena e protege um bloco curto para terminá-la.',
        factualClaims: [],
        reasonCodes: ['general_answer'],
      },
    });

    const result = await runChatCoreV2LocalChatTurn({
      normalizedText: 'Como posso manter foco hoje?',
      userId: 42,
      tenantId: 84,
      requestId: 'req-json',
      locale: 'pt-BR',
      surface: 'ios',
      env: baseEnv({ CHAT_CORE_V2_LOCAL_CHAT_REQUIRE_JSON: 'true' }),
    });

    expect(result?.degraded).toBe(false);
    expect(result?.response.text).toContain('prioridade pequena');
    expect(mocks.dispatchLocalReasoning).toHaveBeenCalledWith(expect.objectContaining({
      outputSchema: expect.objectContaining({ additionalProperties: false }),
    }));
  });

  it('skips local answer composition when the message may mutate state', async () => {
    const result = await runChatCoreV2LocalChatTurn({
      normalizedText: 'Mark comprar suplementos QA LOCAL task as done',
      userId: 42,
      tenantId: 84,
      requestId: 'req-2',
      locale: 'en',
      surface: 'ios',
      env: baseEnv(),
    });

    expect(result).toBeNull();
    expect(mocks.dispatchLocalReasoning).not.toHaveBeenCalled();
  });

  it('returns a helpful safe fallback when local Ollama times out on answer-only chat', async () => {
    mocks.dispatchLocalReasoning.mockRejectedValue(new Error('LocalLLMError: timeout'));

    const result = await runChatCoreV2LocalChatTurn({
      normalizedText: 'Agora me dá um próximo passo pequeno para hoje.',
      userId: 42,
      tenantId: 84,
      requestId: 'req-timeout',
      locale: 'pt-BR',
      surface: 'ios',
      env: baseEnv(),
    });

    expect(result?.degraded).toBe(true);
    expect(result?.response.routeMethod).toBe('chat-core-v2-local-llm-degraded');
    expect(result?.response.text).toContain('25 minutos');
    expect(result?.response.text).not.toContain('não conseguiu responder');
    expect(result?.response.metadata).toEqual(expect.objectContaining({
      degraded: true,
      fallbackKind: 'safe_concise_answer',
    }));
  });

  it('does not fabricate a hardcoded recipe when local Ollama times out on recipe requests', async () => {
    mocks.dispatchLocalReasoning.mockRejectedValue(new Error('LocalLLMError: timeout'));

    const result = await runChatCoreV2LocalChatTurn({
      normalizedText: 'faça uma receita de kibe de forno para duas pessoas com queijos variados de recheio.',
      userId: 42,
      tenantId: 84,
      requestId: 'req-recipe-timeout',
      locale: 'pt-BR',
      surface: 'ios',
      env: baseEnv(),
    });

    expect(result?.degraded).toBe(true);
    expect(result?.response.routeMethod).toBe('chat-core-v2-local-llm-degraded');
    expect(result?.response.domain).toBe('cooking');
    expect(result?.response.text).toContain('Não consegui gerar uma receita completa');
    expect(result?.response.text).not.toContain('Kibe de forno');
    expect(result?.response.text).not.toContain('Ingredientes');
    expect(result?.response.text).not.toContain('próxima ação');
  });

  it('uses a larger bounded budget for recipe requests and repairs incomplete recipes through the model', async () => {
    mocks.dispatchLocalReasoning.mockResolvedValueOnce({
      text: '**Kibe de forno recheado**\n**Modo de preparo:**',
      stopReason: 'length',
      providerMetadata: {
        providerUsed: 'ollama',
        modelUsed: 'qwen2.5:3b-instruct-q4_K_M',
        fallbackUsed: false,
      },
    }).mockResolvedValueOnce({
      text: [
        '**Receita reparada pelo modelo**',
        '**Rende:** 2 pessoas',
        '**Preparo:** 18 min',
        '**Cozimento:** 25 min',
        '**Macros por porção (estimado):**',
        '- Proteína: 31 g',
        '- Gordura: 18 g',
        '- Carboidratos: 29 g',
        '- Calorias: 405 kcal',
        '**Ingredientes:**',
        '- 200 g de ingrediente principal',
        '- 80 g de base',
        '**Modo de preparo:**',
        '1. Prepara os ingredientes.',
        '2. Cozinha até ficar seguro.',
        '3. Serve quente.',
        '4. Ajusta temperos.',
      ].join('\n'),
      providerMetadata: {
        providerUsed: 'ollama',
        modelUsed: 'qwen2.5:3b-instruct-q4_K_M',
        fallbackUsed: false,
      },
    });

    const result = await runChatCoreV2LocalChatTurn({
      normalizedText: 'faça uma receita de kibe de forno para duas pessoas com queijos variados de recheio.',
      userId: 42,
      tenantId: 84,
      requestId: 'req-recipe-length',
      locale: 'pt-BR',
      surface: 'ios',
      env: baseEnv({ CHAT_CORE_V2_LOCAL_CHAT_RECIPE_MODEL: 'qwen3.6:35b-a3b-q4_K_M' }),
    });

    expect(result?.degraded).toBe(false);
    expect(result?.response.domain).toBe('cooking');
    expect(result?.response.text).toContain('Receita reparada pelo modelo');
    expect(result?.response.text).toContain('Ingredientes');
    expect(result?.response.text).toContain('1. Prepara');
    expect(result?.response.text).toContain('Preparo');
    expect(result?.response.text).toContain('Cozimento');
    expect(result?.response.text).toContain('Proteína');
    expect(result?.response.text).not.toBe('**Kibe de forno recheado**\n**Modo de preparo:**');
    expect(mocks.dispatchLocalReasoning).toHaveBeenCalledTimes(2);
    expect(mocks.dispatchLocalReasoning).toHaveBeenNthCalledWith(1, expect.objectContaining({
      modelOverride: 'qwen3.6:35b-a3b-q4_K_M',
      numPredict: 380,
      timeoutMs: 50000,
      prompt: expect.stringContaining('Formato da receita:'),
    }));
    expect(mocks.dispatchLocalReasoning.mock.calls[0][0].prompt).toContain('Preserva o prato pedido');
    expect(mocks.dispatchLocalReasoning).toHaveBeenNthCalledWith(2, expect.objectContaining({
      modelOverride: 'qwen3.6:35b-a3b-q4_K_M',
      numPredict: 380,
      timeoutMs: 50000,
      prompt: expect.stringContaining('Rewrite as a complete recipe'),
    }));
  });

  it('uses recipe routing for generic cooking requests without hardcoded dish names', async () => {
    const completeRecipe = [
      '**Título**',
      'Prato de forno para duas pessoas',
      '**Rende:** 2 porções',
      '**Preparo:** 10 minutos',
      '**Cozimento:** 25 minutos',
      '**Macros por porção (estimado):** Proteína 20 g; Gordura 12 g; Carboidratos 30 g; Calorias 320 kcal',
      '**Ingredientes:**',
      '- 200 g de ingrediente principal',
      '- 150 g de acompanhamento',
      '**Modo de preparo:**',
      '1. Prepara os ingredientes.',
      '2. Assa até ficar pronto.',
    ].join('\n');
    mocks.dispatchLocalReasoning.mockResolvedValueOnce({
      text: completeRecipe,
      providerMetadata: {
        providerUsed: 'ollama',
        modelUsed: 'qwen3.6:35b-a3b-q4_K_M',
        fallbackUsed: false,
      },
    });

    const result = await runChatCoreV2LocalChatTurn({
      normalizedText: 'faz um prato de forno para duas pessoas',
      userId: 42,
      tenantId: 84,
      requestId: 'req-recipe-generic-cooking',
      locale: 'pt-BR',
      surface: 'ios',
      env: baseEnv({ CHAT_CORE_V2_LOCAL_CHAT_RECIPE_MODEL: 'qwen3.6:35b-a3b-q4_K_M' }),
    });

    expect(result?.degraded).toBe(false);
    expect(result?.response.domain).toBe('cooking');
    expect(result?.response.text).toBe(completeRecipe);
    expect(mocks.dispatchLocalReasoning).toHaveBeenCalledWith(expect.objectContaining({
      modelOverride: 'qwen3.6:35b-a3b-q4_K_M',
      numPredict: 380,
      timeoutMs: 50000,
      prompt: expect.stringContaining('Formato da receita:'),
    }));
  });

  it('does not discard a complete recipe just because the model stopped at the token cap', async () => {
    const completeRecipe = [
      '**Título**',
      'Panquecas de banana e aveia',
      '**Rende:** 2 porções',
      '**Preparo:** 8 minutos',
      '**Cozimento:** 10 minutos',
      '**Macros por porção (estimado):** Proteína 10 g; Gordura 8 g; Carboidratos 38 g; Calorias 260 kcal',
      '**Ingredientes:**',
      '- 2 bananas maduras',
      '- 2 ovos',
      '- 60 g de aveia',
      '- 1 pitada de canela',
      '**Modo de preparo:**',
      '1. Amassa as bananas.',
      '2. Mistura ovos, aveia e canela.',
      '3. Cozinha pequenas porções numa frigideira antiaderente.',
      '4. Serve quente.',
    ].join('\n');
    mocks.dispatchLocalReasoning.mockResolvedValueOnce({
      text: completeRecipe,
      stopReason: 'length',
      providerMetadata: {
        providerUsed: 'ollama',
        modelUsed: 'qwen3.6:35b-a3b-q4_K_M',
        fallbackUsed: false,
        evalCount: 380,
      },
    });

    const result = await runChatCoreV2LocalChatTurn({
      normalizedText: 'faça uma receita de panquecas com banana e aveia para duas pessoas',
      userId: 42,
      tenantId: 84,
      requestId: 'req-recipe-complete-at-cap',
      locale: 'pt-BR',
      surface: 'ios',
      env: baseEnv({ CHAT_CORE_V2_LOCAL_CHAT_RECIPE_MODEL: 'qwen3.6:35b-a3b-q4_K_M' }),
    });

    expect(result?.degraded).toBe(false);
    expect(result?.response.text).toBe(completeRecipe);
    expect(mocks.dispatchLocalReasoning).toHaveBeenCalledTimes(1);
  });

  it('does not expose incomplete recipe text when model repair fails', async () => {
    mocks.dispatchLocalReasoning.mockResolvedValueOnce({
      text: '**Kibe de forno recheado**\n**Modo de preparo:**',
      stopReason: 'length',
      providerMetadata: {
        providerUsed: 'ollama',
        modelUsed: 'qwen2.5:3b-instruct-q4_K_M',
        fallbackUsed: false,
      },
    }).mockRejectedValueOnce(new Error('repair timeout'));

    const result = await runChatCoreV2LocalChatTurn({
      normalizedText: 'faça uma receita de kibe de forno para duas pessoas com queijos variados de recheio.',
      userId: 42,
      tenantId: 84,
      requestId: 'req-recipe-repair-fails',
      locale: 'pt-BR',
      surface: 'ios',
      env: baseEnv(),
    });

    expect(result?.degraded).toBe(true);
    expect(result?.response.domain).toBe('cooking');
    expect(result?.response.text).toContain('Não consegui gerar uma receita completa');
    expect(result?.response.text).not.toContain('Kibe de forno');
    expect(mocks.dispatchLocalReasoning).toHaveBeenCalledTimes(2);
  });

  it('rewrites unverified success claims from the local model', async () => {
    mocks.dispatchLocalReasoning.mockResolvedValue({
      text: JSON.stringify({
        schemaVersion: COMPOSED_ANSWER_DRAFT_SCHEMA_VERSION,
        mode: 'model_constrained',
        locale: 'en',
        text: 'Done — I marked the task as completed.',
        factualClaims: [],
        reasonCodes: ['bad_success_claim'],
      }),
      parsed: {
        schemaVersion: COMPOSED_ANSWER_DRAFT_SCHEMA_VERSION,
        mode: 'model_constrained',
        locale: 'en',
        text: 'Done — I marked the task as completed.',
        factualClaims: [],
        reasonCodes: ['bad_success_claim'],
      },
    });

    const result = await runChatCoreV2LocalChatTurn({
      normalizedText: 'Can you help me think about this?',
      userId: 42,
      tenantId: 84,
      requestId: 'req-3',
      locale: 'en',
      surface: 'ios',
      env: baseEnv(),
    });

    expect(result?.response.text).toBe('I did not execute an action in this answer. I can prepare a verified preview if you want.');
    expect(result?.response.metadata).toEqual(expect.objectContaining({
      antiClaimGuardRewritten: true,
    }));
  });

  it('rewrites action-confirmation boilerplate on answer-only prompts', async () => {
    mocks.dispatchLocalReasoning.mockResolvedValue({
      text: JSON.stringify({
        schemaVersion: COMPOSED_ANSWER_DRAFT_SCHEMA_VERSION,
        mode: 'model_constrained',
        locale: 'pt-BR',
        text: 'Antes de executar isso, preciso de confirmação explícita.',
        factualClaims: [],
        reasonCodes: ['bad_confirmation_boilerplate'],
      }),
      parsed: {
        schemaVersion: COMPOSED_ANSWER_DRAFT_SCHEMA_VERSION,
        mode: 'model_constrained',
        locale: 'pt-BR',
        text: 'Antes de executar isso, preciso de confirmação explícita.',
        factualClaims: [],
        reasonCodes: ['bad_confirmation_boilerplate'],
      },
    });

    const result = await runChatCoreV2LocalChatTurn({
      normalizedText: 'Responde em uma frase: qual é uma boa forma de manter foco enquanto crio um SaaS?',
      userId: 42,
      tenantId: 84,
      requestId: 'req-4',
      locale: 'pt-BR',
      surface: 'ios',
      env: baseEnv(),
    });

    expect(result?.response.text).toContain('manter foco');
    expect(result?.response.text).not.toContain('confirmação');
    expect(result?.response.metadata).toEqual(expect.objectContaining({
      antiClaimGuardRewritten: true,
    }));
  });

  it('rewrites review-and-confirm hallucinations on answer-only follow-ups', async () => {
    mocks.dispatchLocalReasoning.mockResolvedValue({
      text: JSON.stringify({
        schemaVersion: COMPOSED_ANSWER_DRAFT_SCHEMA_VERSION,
        mode: 'model_constrained',
        locale: 'pt-BR',
        text: 'Revê e confirma para manter foco enquanto cria um SaaS: práticas de mindfulness e rotina de trabalho eficazes.',
        factualClaims: [],
        reasonCodes: ['bad_confirmation_boilerplate'],
      }),
      parsed: {
        schemaVersion: COMPOSED_ANSWER_DRAFT_SCHEMA_VERSION,
        mode: 'model_constrained',
        locale: 'pt-BR',
        text: 'Revê e confirma para manter foco enquanto cria um SaaS: práticas de mindfulness e rotina de trabalho eficazes.',
        factualClaims: [],
        reasonCodes: ['bad_confirmation_boilerplate'],
      },
    });

    const result = await runChatCoreV2LocalChatTurn({
      normalizedText: 'Agora me dá um próximo passo pequeno para hoje.',
      userId: 42,
      tenantId: 84,
      requestId: 'req-confirm-followup',
      locale: 'pt-BR',
      surface: 'ios',
      recentTurns: [
        {
          role: 'user',
          text: 'Responde em uma frase: qual é uma boa forma de manter foco enquanto crio um SaaS?',
        },
        {
          role: 'assistant',
          text: 'Manter foco enquanto cria um SaaS pode ser facilitado com práticas de mindfulness e rotinas de trabalho eficazes.',
        },
      ],
      env: baseEnv(),
    });

    expect(result?.response.text).toContain('25 minutos');
    expect(result?.response.text).not.toContain('Revê e confirma');
    expect(result?.response.text).not.toContain('confirma');
    expect(result?.response.metadata).toEqual(expect.objectContaining({
      antiClaimGuardRewritten: true,
    }));
  });

  it('does not rewrite legitimate recipe text that merely contains the word "done"', async () => {
    const recipe = [
      '**Title:** Oven-baked lemon chicken',
      '**Serves:** 2',
      '**Prep:** 10 minutes',
      '**Cook:** 25 minutes',
      '**Macros per serving (estimate):** Protein 38 g; Fat 14 g; Carbs 6 g; Calories 300 kcal',
      '**Ingredients:**',
      '- 2 chicken breasts',
      '- 1 lemon',
      '- 2 tbsp olive oil',
      '**Method:**',
      '1. Season the chicken.',
      '2. Roast for 25 minutes until cooked through and done.',
    ].join('\n');
    mocks.dispatchLocalReasoning.mockResolvedValue({
      text: recipe,
      stopReason: 'stop',
    });

    const result = await runChatCoreV2LocalChatTurn({
      normalizedText: 'Give me a simple oven-baked chicken recipe for 2 people',
      userId: 42,
      tenantId: 84,
      requestId: 'req-recipe-done',
      locale: 'en',
      surface: 'ios',
      env: baseEnv(),
    });

    expect(result?.degraded).toBe(false);
    expect(result?.response.domain).toBe('cooking');
    expect(result?.response.text).toContain('Oven-baked lemon chicken');
    expect(result?.response.text).toContain('done');
    expect(result?.response.metadata).toEqual(expect.objectContaining({
      antiClaimGuardRewritten: false,
    }));
  });

  it('rewrites a fabricated cancellation / intent-to-act claim from the local model', async () => {
    mocks.dispatchLocalReasoning.mockResolvedValue({
      text: JSON.stringify({
        schemaVersion: COMPOSED_ANSWER_DRAFT_SCHEMA_VERSION,
        mode: 'model_constrained',
        locale: 'en',
        text: "Sure — I'll cancel that for you.",
        factualClaims: [],
        reasonCodes: ['bad_intent_claim'],
      }),
      parsed: {
        schemaVersion: COMPOSED_ANSWER_DRAFT_SCHEMA_VERSION,
        mode: 'model_constrained',
        locale: 'en',
        text: "Sure — I'll cancel that for you.",
        factualClaims: [],
        reasonCodes: ['bad_intent_claim'],
      },
    });

    const result = await runChatCoreV2LocalChatTurn({
      normalizedText: 'Can you help me think about this?',
      userId: 42,
      tenantId: 84,
      requestId: 'req-cancel-claim',
      locale: 'en',
      surface: 'ios',
      env: baseEnv(),
    });

    expect(result?.response.metadata).toEqual(expect.objectContaining({ antiClaimGuardRewritten: true }));
    expect(result?.response.text).not.toContain('cancel');
  });
});
