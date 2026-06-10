import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  dispatchLocalReasoning: vi.fn(),
  dispatchCloudAllowlistAnswer: vi.fn(),
  maybeRecordCanaryTurn: vi.fn(),
  safeRecordChatV2CloudAllowlistEvidence: vi.fn(),
  evaluateCookingSafetyText: vi.fn(() => ({
    blocked: false,
    surface: 'chat_core_v2_recipe',
    issues: [],
  })),
  hasCookingSafetyPreferences: vi.fn(() => false),
  renderCookingSafetyBlockedResponse: vi.fn(() => 'I cannot suggest that option because it conflicts with a saved cooking safety preference.\nI can help with a safe alternative.'),
  renderCookingSafetyPromptBlockForUser: vi.fn(() => '<cooking_safety_preferences>\nAllergies: peanuts\n</cooking_safety_preferences>'),
}));

vi.mock('../../src/services/provider-registry', () => ({
  ensureActiveProvider: vi.fn(() => ({
    dispatchLocalReasoning: mocks.dispatchLocalReasoning,
  })),
}));

vi.mock('../../src/services/chat-core-v2/cloud-allowlist-answer', () => ({
  dispatchCloudAllowlistAnswer: mocks.dispatchCloudAllowlistAnswer,
}));

vi.mock('../../src/services/chat-cloud-allowlist-evidence', () => ({
  safeRecordChatV2CloudAllowlistEvidence: mocks.safeRecordChatV2CloudAllowlistEvidence,
}));

vi.mock('../../src/services/cooking-safety-policy', () => ({
  cookingSafetyLogPayload: vi.fn((evaluation: any) => ({
    surface: evaluation.surface,
    issueCodes: [...new Set((evaluation.issues ?? []).map((issue: any) => issue.code))],
    issueSources: [...new Set((evaluation.issues ?? []).map((issue: any) => issue.source))],
    issueCount: evaluation.issues?.length ?? 0,
  })),
  evaluateCookingSafetyText: (...args: unknown[]) => mocks.evaluateCookingSafetyText(...args),
  hasCookingSafetyPreferences: (...args: unknown[]) => mocks.hasCookingSafetyPreferences(...args),
  renderCookingSafetyBlockedResponse: (...args: unknown[]) => mocks.renderCookingSafetyBlockedResponse(...args),
  renderCookingSafetyPromptBlockForUser: (...args: unknown[]) => mocks.renderCookingSafetyPromptBlockForUser(...args),
}));

vi.mock('../../src/services/chat-core-v2/canary-turn-log', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/chat-core-v2/canary-turn-log')>(
    '../../src/services/chat-core-v2/canary-turn-log',
  );
  return {
    ...actual,
    maybeRecordCanaryTurn: mocks.maybeRecordCanaryTurn,
  };
});

import {
  COMPOSED_ANSWER_DRAFT_SCHEMA_VERSION,
} from '../../src/services/chat-core-v2/answer-composition';
import {
  isChatCoreV2LocalChatVisibleEnabled,
  resolveChatCoreV2LocalChatLlmMode,
  runChatCoreV2LocalChatTurn,
} from '../../src/services/chat-core-v2/local-chat-orchestrator';
import { _resetLocalInferenceGateForTests } from '../../src/services/chat-core-v2/local-inference-concurrency-gate';

function baseEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    CHAT_CORE_V2_ORCHESTRATOR_MODE: 'canary',
    CHAT_CORE_V2_ALLOWED_SURFACES: 'ios',
    CHAT_CORE_V2_CANARY_ENABLED_TENANT_IDS: '84',
    CHAT_CORE_V2_LOCAL_CHAT_LLM_MODE: 'canary',
    CHAT_CORE_V2_LOCAL_CHAT_MODEL: 'qwen2.5:3b-instruct-q4_K_M',
    ...overrides,
  } as NodeJS.ProcessEnv;
}

describe('ChatCoreV2 local chat orchestrator', () => {
  beforeEach(() => {
    mocks.dispatchLocalReasoning.mockReset();
    mocks.dispatchCloudAllowlistAnswer.mockReset();
    mocks.maybeRecordCanaryTurn.mockReset();
    mocks.safeRecordChatV2CloudAllowlistEvidence.mockReset();
    mocks.evaluateCookingSafetyText.mockReset();
    mocks.evaluateCookingSafetyText.mockReturnValue({
      blocked: false,
      surface: 'chat_core_v2_recipe',
      issues: [],
    });
    mocks.hasCookingSafetyPreferences.mockReset();
    mocks.hasCookingSafetyPreferences.mockReturnValue(false);
    mocks.renderCookingSafetyBlockedResponse.mockClear();
    mocks.renderCookingSafetyPromptBlockForUser.mockClear();
    mocks.maybeRecordCanaryTurn.mockReturnValue(true);
    _resetLocalInferenceGateForTests();
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

  it('requires the tenant canary cohort before local user narrowing can serve', async () => {
    const env = baseEnv({
      CHAT_CORE_V2_CANARY_ENABLED_TENANT_IDS: undefined,
      CHAT_CORE_V2_LOCAL_CHAT_CANARY_USERS: '84:42',
    });

    expect(isChatCoreV2LocalChatVisibleEnabled(env, {
      surface: 'ios',
      userId: 42,
      tenantId: 84,
    })).toBe(false);

    const result = await runChatCoreV2LocalChatTurn({
      normalizedText: 'How do I keep focus today?',
      userId: 42,
      tenantId: 84,
      requestId: 'req-no-cohort',
      locale: 'en',
      surface: 'ios',
      env,
    });

    expect(result).toBeNull();
    expect(mocks.dispatchLocalReasoning).not.toHaveBeenCalled();
    expect(mocks.maybeRecordCanaryTurn).not.toHaveBeenCalled();
  });

  it('treats local-chat canary users as an extra narrowing gate only', () => {
    expect(isChatCoreV2LocalChatVisibleEnabled(baseEnv({
      CHAT_CORE_V2_LOCAL_CHAT_CANARY_USERS: '99:42',
    }), {
      surface: 'ios',
      userId: 42,
      tenantId: 84,
    })).toBe(false);

    expect(isChatCoreV2LocalChatVisibleEnabled(baseEnv({
      CHAT_CORE_V2_LOCAL_CHAT_CANARY_USERS: '42',
    }), {
      surface: 'ios',
      userId: 42,
      tenantId: 84,
    })).toBe(true);
  });

  it('falls through instead of answering when the inferred answer domain is excluded', async () => {
    const result = await runChatCoreV2LocalChatTurn({
      normalizedText: 'Explain my finance summary for this month',
      userId: 42,
      tenantId: 84,
      requestId: 'req-domain-excluded',
      locale: 'en',
      surface: 'ios',
      env: baseEnv({ CHAT_CORE_V2_ALLOWED_DOMAINS: 'content' }),
    });

    expect(result).toBeNull();
    expect(mocks.dispatchLocalReasoning).not.toHaveBeenCalled();
    expect(mocks.maybeRecordCanaryTurn).not.toHaveBeenCalled();
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
      // WP-11: pin the standard model for this assertion by disabling the
      // fast-model branch (the literal `off`). Without this, a short non-write
      // question is classified 'fast_extraction' and would use the 1.5B fast
      // model. The fast-model selection itself is covered in
      // chat-core-v2-local-chat-fast-model.test.ts.
      env: baseEnv({ CHAT_CORE_V2_LOCAL_CHAT_FAST_MODEL: 'off' }),
    });

    expect(result?.degraded).toBe(false);
    expect(result?.response.routeMethod).toBe('chat-core-v2-local-llm');
    expect(result?.response.text).toContain('prioridade pequena');
    expect(result?.response.metadata).toEqual(expect.objectContaining({
      finalAnswerComposerVersion: 'chat_core_v2_final_answer_composer@1.0.0',
      chatCoreV2ResponseSchemaVersion: 'chat_response_v2@1.0.0',
      chatCoreV2ResponseKind: 'message',
    }));
    expect(mocks.dispatchLocalReasoning).toHaveBeenCalledWith(expect.objectContaining({
      modelOverride: 'qwen2.5:3b-instruct-q4_K_M',
      think: false,
      numCtx: 512,
      numPredict: 80,
      timeoutMs: 15000,
      keepAliveSeconds: -1,
      outputSchema: undefined,
      allowCloudEscalation: false,
      containsPrivateData: true,
      systemContext: expect.stringContaining('Answer the CURRENT message directly'),
      prompt: expect.stringContaining('Answer only in Brazilian Portuguese.'),
    }));
    expect(mocks.dispatchLocalReasoning).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining('current: Como posso manter foco hoje?'),
    }));
    expect(mocks.maybeRecordCanaryTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: '84',
        userId: '42',
        turnId: 'req-1',
        routePath: 'chat-core-v2-local-answer',
        routeMethod: 'chat-core-v2-local-llm',
        reasoningTier: 'fast_extraction',
        confidence: 0.9,
        locale: 'pt-BR',
      }),
      { env: expect.objectContaining({ CHAT_CORE_V2_CANARY_ENABLED_TENANT_IDS: '84' }) },
    );
  });

  it('answers simple cooking-idea prompts through a templated non-degraded path', async () => {
    const result = await runChatCoreV2LocalChatTurn({
      normalizedText: 'Me dê uma ideia simples de receita para duas pessoas',
      userId: 42,
      tenantId: 84,
      requestId: 'req-cooking-domain-answer',
      locale: 'pt-BR',
      surface: 'ios',
      env: baseEnv({ CHAT_CORE_V2_LOCAL_CHAT_FAST_MODEL: 'off' }),
    });

    expect(result?.degraded).toBe(false);
    expect(result?.response.routeMethod).toBe('chat-core-v2-local-llm');
    expect(result?.response.domain).toBe('cooking');
    expect(result?.response.text).toContain('Uma opção simples');
    expect(result?.response.text).toContain('proteína');
    expect(result?.response.text).not.toMatch(/\bkibe\b|\bmassa\b|\bfrango\b/i);
    expect(result?.response.metadata).toEqual(expect.objectContaining({
      compositionMode: 'templated',
      localModelBypassed: true,
      draftReasonCodes: expect.arrayContaining(['templated_cooking_idea']),
    }));
    expect(mocks.dispatchLocalReasoning).not.toHaveBeenCalled();
    expect(mocks.maybeRecordCanaryTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        routeMethod: 'chat-core-v2-local-llm',
        reasoningTier: 'none',
        confidence: 0.86,
        locale: 'pt-BR',
      }),
      expect.any(Object),
    );
  });

  it('repairs obvious wrong-language local answers before returning them', async () => {
    mocks.dispatchLocalReasoning
      .mockResolvedValueOnce({
        text: '¿No quieres probar una ensalada casera? Es rápida y saludable.',
        providerMetadata: {
          providerUsed: 'ollama',
          modelUsed: 'qwen2.5:3b-instruct-q4_K_M',
          fallbackUsed: false,
        },
      })
      .mockResolvedValueOnce({
        text: 'Podes experimentar uma salada caseira simples. É rápida e saudável.',
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
      requestId: 'req-locale-repair',
      locale: 'pt-PT',
      surface: 'ios',
      env: baseEnv({ CHAT_CORE_V2_LOCAL_CHAT_FAST_MODEL: 'off' }),
    });

    expect(result?.degraded).toBe(false);
    expect(result?.response.text).toContain('salada caseira');
    expect(result?.response.text).not.toContain('¿');
    expect(result?.response.metadata).toEqual(expect.objectContaining({
      localeRepairApplied: true,
      draftReasonCodes: expect.arrayContaining(['locale_model_repair']),
    }));
    expect(mocks.dispatchLocalReasoning).toHaveBeenCalledTimes(2);
    expect(mocks.dispatchLocalReasoning.mock.calls[1][0]).toEqual(expect.objectContaining({
      systemContext: expect.stringContaining('Answer only in European Portuguese.'),
      prompt: expect.stringContaining('target_locale: pt-PT'),
      allowCloudEscalation: false,
    }));
  });

  it('repairs Brazilian Portuguese drift when pt-PT is expected', async () => {
    mocks.dispatchLocalReasoning
      .mockResolvedValueOnce({
        text: 'Como sugestão simples, você pode fazer massa com legumes salteados.',
        providerMetadata: {
          providerUsed: 'ollama',
          modelUsed: 'qwen2.5:3b-instruct-q4_K_M',
          fallbackUsed: false,
        },
      })
      .mockResolvedValueOnce({
        text: 'Como sugestão simples, podes fazer massa com legumes salteados.',
        providerMetadata: {
          providerUsed: 'ollama',
          modelUsed: 'qwen2.5:3b-instruct-q4_K_M',
          fallbackUsed: false,
        },
      });

    const result = await runChatCoreV2LocalChatTurn({
      normalizedText: 'Como posso organizar melhor o dia?',
      userId: 42,
      tenantId: 84,
      requestId: 'req-pt-pt-repair',
      locale: 'pt-PT',
      surface: 'ios',
      env: baseEnv({ CHAT_CORE_V2_LOCAL_CHAT_FAST_MODEL: 'off' }),
    });

    expect(result?.response.text).toContain('podes fazer');
    expect(result?.response.text).not.toContain('você');
    expect(result?.response.metadata).toEqual(expect.objectContaining({
      localeRepairApplied: true,
      draftReasonCodes: expect.arrayContaining(['locale_model_repair']),
    }));
  });

  it('fails visibly on local queue pressure when explicitly configured without using cloud', async () => {
    const env = baseEnv({
      CHAT_CORE_V2_LOCAL_INFERENCE_MAX_CONCURRENCY: '1',
      CHAT_CORE_V2_QUEUE_FALLBACK_MODE: 'fail_visible',
      CHAT_CORE_V2_QUEUE_CLOUD_AFTER_QUEUED_COUNT: '0',
    });
    let releaseFirst!: () => void;
    mocks.dispatchLocalReasoning.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
      return {
        text: 'Primeira resposta.',
        providerMetadata: { providerUsed: 'ollama', modelUsed: 'qwen2.5:3b-instruct-q4_K_M' },
      };
    });

    const first = runChatCoreV2LocalChatTurn({
      normalizedText: 'Como mantenho foco?',
      userId: 42,
      tenantId: 84,
      requestId: 'req-queue-first',
      locale: 'pt-BR',
      surface: 'ios',
      env,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const second = await runChatCoreV2LocalChatTurn({
      normalizedText: 'Dá-me uma próxima ação pequena.',
      userId: 42,
      tenantId: 84,
      requestId: 'req-queue-second',
      locale: 'pt-BR',
      surface: 'ios',
      env,
    });

    expect(second?.degraded).toBe(true);
    expect(second?.response.metadata).toEqual(expect.objectContaining({
      reason: 'local_queue_saturated',
      queueFallbackDecision: expect.objectContaining({
        kind: 'fail_visible',
        reasonCode: 'fail_visible_configured',
      }),
    }));
    expect(mocks.dispatchLocalReasoning).toHaveBeenCalledTimes(1);

    releaseFirst();
    await first;
  });

  it('uses only a supplied positive allowlist packet for queue cloud fallback', async () => {
    const env = baseEnv({
      CHAT_CORE_V2_ALLOW_CLOUD_FALLBACK: 'true',
      CHAT_CORE_V2_LOCAL_INFERENCE_MAX_CONCURRENCY: '1',
      CHAT_CORE_V2_QUEUE_FALLBACK_MODE: 'cloud_allowlist',
      CHAT_CORE_V2_QUEUE_CLOUD_AFTER_QUEUED_COUNT: '0',
    });
    let releaseFirst!: () => void;
    mocks.dispatchLocalReasoning.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
      return {
        text: 'Primeira resposta.',
        providerMetadata: { providerUsed: 'ollama', modelUsed: 'qwen2.5:3b-instruct-q4_K_M' },
      };
    });
    mocks.dispatchCloudAllowlistAnswer.mockResolvedValue({
      text: 'Preciso de mais contexto seguro para responder com qualidade.',
      providerMetadata: {
        providerUsed: 'gemini',
        modelUsed: 'gemini-2.5-pro',
        cloudAllowlistPrivacyAction: 'packet_only',
      },
    });

    const first = runChatCoreV2LocalChatTurn({
      normalizedText: 'Como mantenho foco?',
      userId: 42,
      tenantId: 84,
      requestId: 'req-cloud-first',
      locale: 'pt-BR',
      surface: 'ios',
      env,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const packet = {
      schemaVersion: 'cloud_allowlist_packet@1.0.0' as const,
      intent: 'answer' as const,
      capabilityId: 'chat.general_answer',
      domain: 'content' as const,
      hmacEntityIds: [],
      evidenceFingerprints: ['evidence:general-focus'],
      locale: 'pt-BR',
      complexityScore: 0.2,
      escalationReason: 'cloud_allowlist_candidate' as const,
    };
    const second = await runChatCoreV2LocalChatTurn({
      normalizedText: 'Dá-me uma próxima ação pequena.',
      userId: 42,
      tenantId: 84,
      requestId: 'req-cloud-second',
      locale: 'pt-BR',
      surface: 'ios',
      cloudAllowlistPacket: { ok: true, packet },
      env,
    });

    expect(second?.response.routeMethod).toBe('chat-core-v2-cloud-allowlist');
    expect(second?.response.metadata).toEqual(expect.objectContaining({
      type: 'chat_core_v2_cloud_allowlist',
      finalAnswerComposerVersion: 'chat_core_v2_final_answer_composer@1.0.0',
      chatCoreV2ResponseSchemaVersion: 'chat_response_v2@1.0.0',
      chatCoreV2ResponseKind: 'message',
      queueFallbackDecision: expect.objectContaining({
        kind: 'use_cloud_allowlist',
        reasonCode: 'cloud_allowlist_packet_safe',
      }),
    }));
    expect(mocks.dispatchCloudAllowlistAnswer).toHaveBeenCalledWith(packet, {
      userId: 42,
      tenantId: 84,
      requestId: 'req-cloud-second',
    });
    expect(mocks.dispatchLocalReasoning).toHaveBeenCalledTimes(1);

    releaseFirst();
    await first;
  });

  it('blocks unsafe cooking answers returned by queue cloud fallback even when input detection misses', async () => {
    const env = baseEnv({
      CHAT_CORE_V2_ALLOW_CLOUD_FALLBACK: 'true',
      CHAT_CORE_V2_LOCAL_INFERENCE_MAX_CONCURRENCY: '1',
      CHAT_CORE_V2_QUEUE_FALLBACK_MODE: 'cloud_allowlist',
      CHAT_CORE_V2_QUEUE_CLOUD_AFTER_QUEUED_COUNT: '0',
    });
    let releaseFirst!: () => void;
    mocks.dispatchLocalReasoning.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
      return {
        text: 'Primeira resposta.',
        providerMetadata: { providerUsed: 'ollama', modelUsed: 'qwen2.5:3b-instruct-q4_K_M' },
      };
    });
    mocks.dispatchCloudAllowlistAnswer.mockResolvedValue({
      text: 'Serve peanut butter cookies with chocolate cupcakes.',
      providerMetadata: {
        providerUsed: 'gemini',
        modelUsed: 'gemini-2.5-pro',
        cloudAllowlistPrivacyAction: 'packet_only',
      },
    });
    mocks.evaluateCookingSafetyText.mockReturnValueOnce({
      blocked: true,
      surface: 'chat_core_v2_cooking',
      issues: [{
        code: 'ALLERGY_CONFLICT',
        severity: 'blocker',
        surface: 'chat_core_v2_cooking',
        term: 'peanuts',
        source: 'cooking_preference_profile',
      }],
    });

    const first = runChatCoreV2LocalChatTurn({
      normalizedText: 'Como mantenho foco?',
      userId: 42,
      tenantId: 84,
      requestId: 'req-cloud-cooking-first',
      locale: 'pt-BR',
      surface: 'ios',
      env,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const packet = {
      schemaVersion: 'cloud_allowlist_packet@1.0.0' as const,
      intent: 'answer' as const,
      capabilityId: 'content.brainstorm',
      domain: 'content' as const,
      hmacEntityIds: [],
      evidenceFingerprints: ['evidence:party_safe'],
      locale: 'en',
      complexityScore: 0.2,
      escalationReason: 'cloud_allowlist_candidate' as const,
    };
    const second = await runChatCoreV2LocalChatTurn({
      normalizedText: 'Give me birthday party ideas',
      userId: 42,
      tenantId: 84,
      requestId: 'req-cloud-cooking-second',
      locale: 'en',
      surface: 'ios',
      cloudAllowlistPacket: { ok: true, packet },
      env,
    });

    expect(second?.response.text).toContain('saved cooking safety preference');
    expect(second?.response.text).not.toContain('peanut butter cookies');
    expect(second?.response.metadata).toEqual(expect.objectContaining({
      safetyBlocked: true,
      safetySurface: 'chat_core_v2_cooking',
      safetyIssueCodes: ['ALLERGY_CONFLICT'],
      cloudAllowlistSafetyBlocked: true,
      queueFallbackDecision: expect.objectContaining({
        kind: 'use_cloud_allowlist',
        reasonCode: 'cloud_allowlist_packet_safe',
      }),
    }));
    expect(mocks.evaluateCookingSafetyText).toHaveBeenCalledWith(
      42,
      84,
      'chat_core_v2_cooking',
      [expect.stringContaining('peanut butter cookies')],
    );

    releaseFirst();
    await first;
  });

  it('builds a packet-only cloud fallback from safe local-chat metadata under explicit producer flags', async () => {
    const env = baseEnv({
      CHAT_CORE_V2_ALLOW_CLOUD_FALLBACK: 'true',
      CHAT_CORE_V2_LOCAL_INFERENCE_MAX_CONCURRENCY: '1',
      CHAT_CORE_V2_QUEUE_FALLBACK_MODE: 'cloud_allowlist',
      CHAT_CORE_V2_QUEUE_CLOUD_AFTER_QUEUED_COUNT: '0',
      CHAT_CORE_V2_CLOUD_ALLOWLIST_PACKET_PRODUCER_ENABLED: 'true',
      CHAT_CORE_V2_CLOUD_ALLOWLIST_BUDGET_AVAILABLE: 'true',
      CHAT_CORE_V2_CLOUD_ALLOWLIST_HMAC_SECRET: 'test-cloud-allowlist-secret',
    });
    let releaseFirst!: () => void;
    mocks.dispatchLocalReasoning.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
      return {
        text: 'Primeira resposta.',
        providerMetadata: { providerUsed: 'ollama', modelUsed: 'qwen2.5:3b-instruct-q4_K_M' },
      };
    });
    mocks.dispatchCloudAllowlistAnswer.mockResolvedValue({
      text: 'Escolhe uma próxima ação pequena e limita o escopo.',
      providerMetadata: {
        providerUsed: 'gemini',
        modelUsed: 'gemini-2.5-pro',
        cloudAllowlistPrivacyAction: 'packet_only',
      },
    });

    const first = runChatCoreV2LocalChatTurn({
      normalizedText: 'Como mantenho foco?',
      userId: 42,
      tenantId: 84,
      requestId: 'req-producer-first',
      locale: 'pt-BR',
      surface: 'ios',
      env,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const second = await runChatCoreV2LocalChatTurn({
      normalizedText: 'Dá-me um próximo passo pequeno para hoje.',
      userId: 42,
      tenantId: 84,
      requestId: 'req-producer-second',
      locale: 'pt-BR',
      surface: 'ios',
      env,
    });

    expect(second?.response.routeMethod).toBe('chat-core-v2-cloud-allowlist');
    expect(second?.response.metadata).toEqual(expect.objectContaining({
      type: 'chat_core_v2_cloud_allowlist',
      queueFallbackDecision: expect.objectContaining({
        kind: 'use_cloud_allowlist',
        reasonCode: 'cloud_allowlist_packet_safe',
      }),
      queueFallbackObservabilityEvent: expect.objectContaining({
        failureMode: 'local_queue_saturation',
        safeMetadata: expect.objectContaining({
          routeMethod: 'chat-core-v2-local-chat',
          surface: 'ios',
          reasonCode: 'cloud_allowlist_packet_safe',
          locale: 'pt-BR',
        }),
      }),
    }));
    const packet = mocks.dispatchCloudAllowlistAnswer.mock.calls[0]?.[0];
    expect(packet).toEqual(expect.objectContaining({
      capabilityId: 'chat.general_next_step',
      domain: 'content',
      locale: 'pt-BR',
    }));
    expect(JSON.stringify(packet)).not.toContain('Dá-me');
    expect(JSON.stringify(packet)).not.toContain('próximo passo');
    expect(JSON.stringify(packet)).not.toContain('req-producer-second');
    expect(mocks.safeRecordChatV2CloudAllowlistEvidence).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 84,
      userId: 42,
      requestId: 'req-producer-second',
      sentToCloud: false,
      denied: false,
      rawPrivateFieldCount: 0,
      hmacEntityIdCount: 1,
      nonHmacEntityIdCount: 0,
      hmacEvidenceFingerprintCount: 1,
      nonHmacEvidenceFingerprintCount: 0,
      safeMetadata: expect.objectContaining({
        routeMethod: 'chat-core-v2-local-chat',
        cloudPacketAuditOnly: true,
        capabilityId: 'chat.general_next_step',
      }),
    }));
    expect(mocks.dispatchLocalReasoning).toHaveBeenCalledTimes(1);

    releaseFirst();
    await first;
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

  it('fails closed through the final composer when a structured draft changes locale', async () => {
    mocks.dispatchLocalReasoning.mockResolvedValue({
      text: JSON.stringify({
        schemaVersion: COMPOSED_ANSWER_DRAFT_SCHEMA_VERSION,
        mode: 'model_constrained',
        locale: 'en',
        text: 'Pick one 25-minute action for today.',
        factualClaims: [],
        reasonCodes: ['wrong_locale'],
      }),
      parsed: {
        schemaVersion: COMPOSED_ANSWER_DRAFT_SCHEMA_VERSION,
        mode: 'model_constrained',
        locale: 'en',
        text: 'Pick one 25-minute action for today.',
        factualClaims: [],
        reasonCodes: ['wrong_locale'],
      },
    });

    const result = await runChatCoreV2LocalChatTurn({
      normalizedText: 'Agora me dá um próximo passo pequeno para hoje.',
      userId: 42,
      tenantId: 84,
      requestId: 'req-locale-mismatch',
      locale: 'pt-BR',
      surface: 'ios',
      env: baseEnv({ CHAT_CORE_V2_LOCAL_CHAT_REQUIRE_JSON: 'true' }),
    });

    expect(result?.degraded).toBe(true);
    expect(result?.response.routeMethod).toBe('chat-core-v2-local-llm-degraded');
    expect(result?.response.text).toContain('25 minutos');
    expect(result?.response.text).not.toContain('Pick one');
    expect(result?.response.metadata).toEqual(expect.objectContaining({
      reason: 'final_answer_composition_failed',
      fallbackKind: 'safe_concise_answer',
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

  it('injects and enforces cooking safety on non-recipe cooking advice generated by the local model', async () => {
    mocks.dispatchLocalReasoning.mockResolvedValue({
      text: 'Store cooked dinner leftovers in the fridge within 2 hours and reheat until steaming hot.',
      providerMetadata: {
        providerUsed: 'ollama',
        modelUsed: 'qwen2.5:3b-instruct-q4_K_M',
        fallbackUsed: false,
      },
    });

    const result = await runChatCoreV2LocalChatTurn({
      normalizedText: 'Explain safe storage for leftovers from dinner.',
      userId: 42,
      tenantId: 84,
      requestId: 'req-cooking-non-recipe-safety',
      locale: 'en',
      surface: 'ios',
      env: baseEnv({ CHAT_CORE_V2_LOCAL_CHAT_FAST_MODEL: 'off' }),
    });

    expect(result?.response.domain).toBe('cooking');
    expect(mocks.dispatchLocalReasoning).toHaveBeenCalledWith(expect.objectContaining({
      systemContext: expect.stringContaining('<cooking_safety_preferences>'),
      prompt: expect.stringContaining('<cooking_safety_preferences>'),
    }));
    expect(mocks.evaluateCookingSafetyText).toHaveBeenCalledWith(
      42,
      84,
      'chat_core_v2_cooking',
      [expect.stringContaining('Store cooked dinner leftovers')],
    );
  });

  it('blocks and suppresses unsafe non-recipe cooking advice', async () => {
    mocks.dispatchLocalReasoning.mockResolvedValue({
      text: 'For brunch, offer peanut butter cookies with fruit.',
      providerMetadata: {
        providerUsed: 'ollama',
        modelUsed: 'qwen2.5:3b-instruct-q4_K_M',
        fallbackUsed: false,
      },
    });
    mocks.evaluateCookingSafetyText.mockReturnValueOnce({
      blocked: true,
      surface: 'chat_core_v2_cooking',
      issues: [{
        code: 'ALLERGY_CONFLICT',
        severity: 'blocker',
        surface: 'chat_core_v2_cooking',
        term: 'peanuts',
        source: 'cooking_preference_profile',
      }],
    });

    const result = await runChatCoreV2LocalChatTurn({
      normalizedText: 'Explain safe storage for leftovers from dinner.',
      userId: 42,
      tenantId: 84,
      requestId: 'req-cooking-non-recipe-blocked',
      locale: 'en',
      surface: 'ios',
      env: baseEnv({ CHAT_CORE_V2_LOCAL_CHAT_FAST_MODEL: 'off' }),
    });

    expect(result?.response.text).toContain('saved cooking safety preference');
    expect(result?.response.text).not.toContain('peanut butter cookies');
    expect(result?.response.metadata).toEqual(expect.objectContaining({
      safetyBlocked: true,
      safetySurface: 'chat_core_v2_cooking',
      safetyIssueCodes: ['ALLERGY_CONFLICT'],
    }));
  });

  it('blocks generated cooking output when the input-side cooking detector misses', async () => {
    mocks.dispatchLocalReasoning.mockResolvedValue({
      text: 'Serve peanut butter cookies and chocolate cake for the birthday table.',
      providerMetadata: {
        providerUsed: 'ollama',
        modelUsed: 'qwen2.5:3b-instruct-q4_K_M',
        fallbackUsed: false,
      },
    });
    mocks.evaluateCookingSafetyText.mockReturnValueOnce({
      blocked: true,
      surface: 'chat_core_v2_cooking',
      issues: [{
        code: 'ALLERGY_CONFLICT',
        severity: 'blocker',
        surface: 'chat_core_v2_cooking',
        term: 'peanuts',
        source: 'cooking_preference_profile',
      }],
    });

    const result = await runChatCoreV2LocalChatTurn({
      normalizedText: 'Give me birthday party ideas',
      userId: 42,
      tenantId: 84,
      requestId: 'req-cooking-output-detected',
      locale: 'en',
      surface: 'ios',
      env: baseEnv({ CHAT_CORE_V2_LOCAL_CHAT_FAST_MODEL: 'off' }),
    });

    expect(result?.response.text).toContain('saved cooking safety preference');
    expect(result?.response.text).not.toContain('peanut butter cookies');
    expect(mocks.evaluateCookingSafetyText).toHaveBeenCalledWith(
      42,
      84,
      'chat_core_v2_cooking',
      [expect.stringContaining('peanut butter cookies')],
    );
  });

  it('blocks stored sesame allergies even when generated output misses cooking vocabulary', async () => {
    mocks.hasCookingSafetyPreferences.mockReturnValue(true);
    mocks.dispatchLocalReasoning.mockResolvedValue({
      text: 'Drizzle tahini over the bowl.',
      providerMetadata: {
        providerUsed: 'ollama',
        modelUsed: 'qwen2.5:3b-instruct-q4_K_M',
        fallbackUsed: false,
      },
    });
    mocks.evaluateCookingSafetyText.mockReturnValueOnce({
      blocked: true,
      surface: 'chat_core_v2_cooking',
      issues: [{
        code: 'ALLERGY_CONFLICT',
        severity: 'blocker',
        surface: 'chat_core_v2_cooking',
        term: 'sesame',
        source: 'cooking_preference_profile',
      }],
    });

    const result = await runChatCoreV2LocalChatTurn({
      normalizedText: 'Give me birthday party ideas',
      userId: 42,
      tenantId: 84,
      requestId: 'req-sesame-output-detected',
      locale: 'en',
      surface: 'ios',
      env: baseEnv({ CHAT_CORE_V2_LOCAL_CHAT_FAST_MODEL: 'off' }),
    });

    expect(result?.response.text).toContain('saved cooking safety preference');
    expect(result?.response.text).not.toContain('tahini');
    expect(mocks.evaluateCookingSafetyText).toHaveBeenCalledWith(
      42,
      84,
      'chat_core_v2_cooking',
      [expect.stringContaining('tahini')],
    );
  });

  it('blocks stored soy allergies when generated output only mentions tofu', async () => {
    mocks.hasCookingSafetyPreferences.mockReturnValue(true);
    mocks.dispatchLocalReasoning.mockResolvedValue({
      text: 'Try tofu with a bright herb sauce.',
      providerMetadata: {
        providerUsed: 'ollama',
        modelUsed: 'qwen2.5:3b-instruct-q4_K_M',
        fallbackUsed: false,
      },
    });
    mocks.evaluateCookingSafetyText.mockReturnValueOnce({
      blocked: true,
      surface: 'chat_core_v2_cooking',
      issues: [{
        code: 'ALLERGY_CONFLICT',
        severity: 'blocker',
        surface: 'chat_core_v2_cooking',
        term: 'soy',
        source: 'cooking_preference_profile',
      }],
    });

    const result = await runChatCoreV2LocalChatTurn({
      normalizedText: 'Give me birthday party ideas',
      userId: 42,
      tenantId: 84,
      requestId: 'req-soy-output-detected',
      locale: 'en',
      surface: 'ios',
      env: baseEnv({ CHAT_CORE_V2_LOCAL_CHAT_FAST_MODEL: 'off' }),
    });

    expect(result?.response.text).toContain('saved cooking safety preference');
    expect(result?.response.text).not.toContain('tofu');
    expect(mocks.evaluateCookingSafetyText).toHaveBeenCalledWith(
      42,
      84,
      'chat_core_v2_cooking',
      [expect.stringContaining('tofu')],
    );
  });

  it('does not false-positive non-food answers for a user with stored allergies', async () => {
    mocks.hasCookingSafetyPreferences.mockReturnValue(true);
    mocks.dispatchLocalReasoning.mockResolvedValue({
      text: 'Your meeting is at 3pm.',
      providerMetadata: {
        providerUsed: 'ollama',
        modelUsed: 'qwen2.5:3b-instruct-q4_K_M',
        fallbackUsed: false,
      },
    });

    const result = await runChatCoreV2LocalChatTurn({
      normalizedText: 'Share a calm sentence for today.',
      userId: 42,
      tenantId: 84,
      requestId: 'req-non-food-allergy-safe',
      locale: 'en',
      surface: 'ios',
      env: baseEnv({ CHAT_CORE_V2_LOCAL_CHAT_FAST_MODEL: 'off' }),
    });

    expect(result?.response.text).toContain('Your meeting is at 3pm.');
    expect(result?.response.metadata).not.toHaveProperty('safetyBlocked');
    expect(mocks.evaluateCookingSafetyText).toHaveBeenCalledWith(
      42,
      84,
      'chat_core_v2_cooking',
      ['Your meeting is at 3pm.'],
    );
  });

  it('does not evaluate uncategorized non-food output when the user has no safety preferences', async () => {
    mocks.hasCookingSafetyPreferences.mockReturnValue(false);
    mocks.dispatchLocalReasoning.mockResolvedValue({
      text: 'Your meeting is at 3pm.',
      providerMetadata: {
        providerUsed: 'ollama',
        modelUsed: 'qwen2.5:3b-instruct-q4_K_M',
        fallbackUsed: false,
      },
    });

    const result = await runChatCoreV2LocalChatTurn({
      normalizedText: 'Share a calm sentence for today.',
      userId: 42,
      tenantId: 84,
      requestId: 'req-no-preference-safe',
      locale: 'en',
      surface: 'ios',
      env: baseEnv({ CHAT_CORE_V2_LOCAL_CHAT_FAST_MODEL: 'off' }),
    });

    expect(result?.response.text).toContain('Your meeting is at 3pm.');
    expect(mocks.evaluateCookingSafetyText).not.toHaveBeenCalled();
  });

  it('checks the full generated recipe draft before truncation can hide a late allergen', async () => {
    const unsafeRecipe = [
      '**Title**',
      'Rice bowl for two',
      '**Serves:** 2',
      '**Prep:** 10 min',
      '**Cook:** 15 min',
      '**Macros per serving (estimated):** Protein 10 g; Fat 6 g; Carbs 52 g; Calories 320 kcal',
      '**Ingredients:**',
      '- 200 g rice',
      '- 120 g vegetables',
      '**Instructions:**',
      '1. Cook the rice.',
      '2. Steam the vegetables.',
      '3. Combine and season.',
      '4. Serve warm.',
      'A'.repeat(1700),
      'Finish with crushed peanuts.',
    ].join('\n');
    expect(unsafeRecipe.indexOf('crushed peanuts')).toBeGreaterThan(1600);
    mocks.dispatchLocalReasoning.mockResolvedValue({
      text: unsafeRecipe,
      providerMetadata: {
        providerUsed: 'ollama',
        modelUsed: 'qwen3.6:35b-a3b-q4_K_M',
        fallbackUsed: false,
      },
    });
    mocks.evaluateCookingSafetyText.mockReturnValueOnce({
      blocked: true,
      surface: 'chat_core_v2_recipe',
      issues: [{
        code: 'ALLERGY_CONFLICT',
        severity: 'blocker',
        surface: 'chat_core_v2_recipe',
        term: 'peanuts',
        source: 'cooking_preference_profile',
      }],
    });

    const result = await runChatCoreV2LocalChatTurn({
      normalizedText: 'Give me a rice bowl recipe for two',
      userId: 42,
      tenantId: 84,
      requestId: 'req-recipe-late-allergen',
      locale: 'en',
      surface: 'ios',
      env: baseEnv({ CHAT_CORE_V2_LOCAL_CHAT_RECIPE_MODEL: 'qwen3.6:35b-a3b-q4_K_M' }),
    });

    expect(result?.response.text).toContain('saved cooking safety preference');
    expect(result?.response.text).not.toContain('crushed peanuts');
    expect(mocks.evaluateCookingSafetyText).toHaveBeenCalledWith(
      42,
      84,
      'chat_core_v2_recipe',
      [expect.stringContaining('crushed peanuts')],
    );
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
      keepAliveSeconds: -1,
      prompt: expect.stringContaining('Formato da receita:'),
    }));
    expect(mocks.dispatchLocalReasoning.mock.calls[0][0].prompt).toContain('Preserva o prato pedido');
    expect(mocks.dispatchLocalReasoning).toHaveBeenNthCalledWith(2, expect.objectContaining({
      modelOverride: 'qwen3.6:35b-a3b-q4_K_M',
      numPredict: 380,
      timeoutMs: 50000,
      keepAliveSeconds: -1,
      prompt: expect.stringContaining('Rewrite as a complete recipe'),
      systemContext: expect.stringContaining('<cooking_safety_preferences>'),
    }));
    expect(mocks.dispatchLocalReasoning.mock.calls[1][0].prompt).toContain('<cooking_safety_preferences>');
  });

  it('blocks allergens reintroduced by the recipe repair path', async () => {
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
        '**Recipe repaired by model**',
        '**Serves:** 2',
        '**Prep:** 18 min',
        '**Cook:** 25 min',
        '**Macros per serving (estimated):** Protein 31 g; Fat 18 g; Carbs 29 g; Calories 405 kcal',
        '**Ingredients:**',
        '- 200 g rice',
        '- 30 g crushed peanuts',
        '**Instructions:**',
        '1. Prepare the rice.',
        '2. Fold in crushed peanuts.',
        '3. Bake until hot.',
        '4. Serve warm.',
      ].join('\n'),
      providerMetadata: {
        providerUsed: 'ollama',
        modelUsed: 'qwen2.5:3b-instruct-q4_K_M',
        fallbackUsed: false,
      },
    });
    mocks.evaluateCookingSafetyText.mockReturnValueOnce({
      blocked: true,
      surface: 'chat_core_v2_recipe',
      issues: [{
        code: 'ALLERGY_CONFLICT',
        severity: 'blocker',
        surface: 'chat_core_v2_recipe',
        term: 'peanuts',
        source: 'cooking_preference_profile',
      }],
    });

    const result = await runChatCoreV2LocalChatTurn({
      normalizedText: 'make me a baked kibe recipe for two',
      userId: 42,
      tenantId: 84,
      requestId: 'req-recipe-repair-allergen',
      locale: 'en',
      surface: 'ios',
      env: baseEnv({ CHAT_CORE_V2_LOCAL_CHAT_RECIPE_MODEL: 'qwen3.6:35b-a3b-q4_K_M' }),
    });

    expect(mocks.dispatchLocalReasoning).toHaveBeenCalledTimes(2);
    expect(result?.response.text).toContain('saved cooking safety preference');
    expect(result?.response.text).not.toContain('crushed peanuts');
    expect(mocks.evaluateCookingSafetyText).toHaveBeenCalledWith(
      42,
      84,
      'chat_core_v2_recipe',
      [expect.stringContaining('crushed peanuts')],
    );
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

  it('rewrites saved/added success claims in EN and PT (aligned with the eval grader)', async () => {
    for (const claim of ["I've saved the recipe for you.", "I've added it to your list.", 'Pronto, guardei isso.', 'Adicionei isso à tua lista.']) {
      mocks.dispatchLocalReasoning.mockResolvedValue({
        text: JSON.stringify({
          schemaVersion: COMPOSED_ANSWER_DRAFT_SCHEMA_VERSION,
          mode: 'model_constrained',
          locale: 'en',
          text: claim,
          factualClaims: [],
          reasonCodes: ['bad_action_claim'],
        }),
        parsed: {
          schemaVersion: COMPOSED_ANSWER_DRAFT_SCHEMA_VERSION,
          mode: 'model_constrained',
          locale: 'en',
          text: claim,
          factualClaims: [],
          reasonCodes: ['bad_action_claim'],
        },
      });

      const result = await runChatCoreV2LocalChatTurn({
        normalizedText: 'Can you help me think about this?',
        userId: 42,
        tenantId: 84,
        requestId: `req-claim-${claim.slice(0, 6)}`,
        locale: 'en',
        surface: 'ios',
        env: baseEnv(),
      });

      expect(result?.response.metadata).toEqual(expect.objectContaining({ antiClaimGuardRewritten: true }));
    }
  });
});
