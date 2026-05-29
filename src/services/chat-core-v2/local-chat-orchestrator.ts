// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { config } from '../../config';
import { logger } from '../../utils/logger';
import { ensureActiveProvider } from '../provider-registry';
import type { LocalReasoningResult, LocalReasoningTask } from '../ollama-provider';
import {
  COMPOSED_ANSWER_DRAFT_SCHEMA_VERSION,
  type ComposedAnswerDraft,
  validateComposedAnswerDraft,
} from './answer-composition';
import { detectChatCoreV2WriteIntent } from './action-gateway';
import { dispatchCloudAllowlistAnswer } from './cloud-allowlist-answer';
import { buildLocalChatCloudAllowlistPacket } from './cloud-allowlist-answer-packet';
import type { CloudAllowlistPacketResult } from './cloud-allowlist-packet';
import { buildChatCoreV2FailureObservabilityEvent } from './failure-observability';
import {
  getLocalInferenceGateSnapshot,
  runWithLocalInferenceSlot,
} from './local-inference-concurrency-gate';
import {
  evaluateChatCoreV2QueueFallback,
  resolveChatCoreV2QueueFallbackPolicy,
  type ChatCoreV2QueueFallbackDecision,
} from './queue-fallback-policy';
import { WRITE_SUCCESS_CLAIM_RE } from './success-claim-policy';
import { resolveChatCoreV2ActivationConfig, type ChatCoreV2AllowedSurface } from './activation-flags';
import type { ChatCoreV2Locale } from './response-contracts';

export type ChatCoreV2LocalChatLlmMode = 'off' | 'shadow' | 'canary' | 'on';

export interface ChatCoreV2LocalChatRecentTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface ChatCoreV2LocalChatTurnInput {
  normalizedText: string;
  userId: number;
  tenantId: number;
  requestId: string;
  locale?: string | null;
  surface: ChatCoreV2AllowedSurface;
  recentTurns?: ChatCoreV2LocalChatRecentTurn[];
  cloudAllowlistPacket?: CloudAllowlistPacketResult | null;
  env?: NodeJS.ProcessEnv;
}

export interface ChatCoreV2LocalChatTurnResult {
  response: {
    id: string;
    text: string;
    domain: 'chat' | 'cooking';
    routeMethod:
      | 'chat-core-v2-local-llm'
      | 'chat-core-v2-local-llm-degraded'
      | 'chat-core-v2-cloud-allowlist';
    confidence: number;
    buttons: null;
    metadata: Record<string, unknown>;
    timestamp: string;
    responseCards: [];
  };
  modelMetadata?: LocalReasoningResult['providerMetadata'];
  degraded: boolean;
}

const CHAT_CORE_V2_LOCAL_CHAT_SCHEMA_VERSION = 'chat_core_v2_local_chat@1.0.0';

const DEFAULT_LOCAL_CHAT_NUM_CTX = 512;
const DEFAULT_LOCAL_CHAT_NUM_PREDICT = 80;
const DEFAULT_LOCAL_CHAT_TIMEOUT_MS = 15_000;
const DEFAULT_RECIPE_NUM_PREDICT = 380;
const DEFAULT_RECIPE_TIMEOUT_MS = 50_000;

// WRITE_SUCCESS_CLAIM_RE is the shared single source of truth in
// ./success-claim-policy (imported above), kept identical to the eval grader so
// the runtime guard and its evaluator cannot drift.

const LOCAL_CHAT_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'mode', 'locale', 'text', 'factualClaims', 'reasonCodes'],
  properties: {
    schemaVersion: { type: 'string', enum: [COMPOSED_ANSWER_DRAFT_SCHEMA_VERSION] },
    mode: { type: 'string', enum: ['model_constrained'] },
    locale: { type: 'string', enum: ['en', 'pt-PT', 'pt-BR', 'es'] },
    text: { type: 'string', minLength: 1, maxLength: 1600 },
    factualClaims: {
      type: 'array',
      maxItems: 5,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['claimId', 'text', 'evidenceIds', 'support'],
        properties: {
          claimId: { type: 'string', minLength: 1, maxLength: 80 },
          text: { type: 'string', minLength: 1, maxLength: 300 },
          evidenceIds: {
            type: 'array',
            maxItems: 3,
            items: { type: 'string', minLength: 1, maxLength: 120 },
          },
          support: { type: 'string', enum: ['supported', 'assumption', 'clarification_needed'] },
        },
      },
    },
    reasonCodes: {
      type: 'array',
      maxItems: 8,
      items: { type: 'string', minLength: 1, maxLength: 80 },
    },
  },
} as const;

type EnvLike = NodeJS.ProcessEnv | Record<string, string | undefined>;

export function resolveChatCoreV2LocalChatLlmMode(env: EnvLike = process.env): ChatCoreV2LocalChatLlmMode {
  if (String(env.CHAT_CORE_V2_ORCHESTRATOR_MODE ?? '').trim().toLowerCase() === 'off') return 'off';
  const raw = String(env.CHAT_CORE_V2_LOCAL_CHAT_LLM_MODE ?? '').trim().toLowerCase();
  if (raw === 'off' || raw === 'shadow' || raw === 'canary' || raw === 'on') return raw;
  return 'off';
}

export function isChatCoreV2LocalChatVisibleEnabled(
  env: EnvLike = process.env,
  input: { surface: ChatCoreV2AllowedSurface; userId: number; tenantId: number },
): boolean {
  const activation = resolveChatCoreV2ActivationConfig(env as NodeJS.ProcessEnv);
  if (activation.mode === 'off') return false;
  if (!activation.allowedSurfaces.includes(input.surface)) return false;

  const mode = resolveChatCoreV2LocalChatLlmMode(env);
  if (mode === 'off' || mode === 'shadow') return false;
  if (mode === 'canary') {
    const nodeEnv = String(env.NODE_ENV ?? process.env.NODE_ENV ?? '').trim().toLowerCase();
    if (nodeEnv === 'production' && env.CHAT_CORE_V2_LOCAL_CHAT_ALLOW_PROD !== '1') return false;
    const canaryUsers = parseCanaryList(env.CHAT_CORE_V2_LOCAL_CHAT_CANARY_USERS);
    if (canaryUsers.length === 0) return nodeEnv !== 'production';
    return canaryUsers.includes(String(input.userId)) || canaryUsers.includes(`${input.tenantId}:${input.userId}`);
  }
  return true;
}

export async function runChatCoreV2LocalChatTurn(
  input: ChatCoreV2LocalChatTurnInput,
): Promise<ChatCoreV2LocalChatTurnResult | null> {
  const env = input.env ?? process.env;
  if (!isChatCoreV2LocalChatVisibleEnabled(env, {
    surface: input.surface,
    userId: input.userId,
    tenantId: input.tenantId,
  })) {
    return null;
  }

  const writeIntent = detectChatCoreV2WriteIntent(input.normalizedText);
  if (writeIntent.mayMutate) return null;

  const provider = ensureActiveProvider();
  if (!provider) {
    return buildDegradedResponse(input, 'provider_not_configured');
  }

  const cloudAllowlistPacket = input.cloudAllowlistPacket ?? buildLocalChatCloudAllowlistPacket({
    normalizedText: input.normalizedText,
    userId: input.userId,
    tenantId: input.tenantId,
    requestId: input.requestId,
    locale: input.locale,
    env,
  });
  const queueFallbackDecision = evaluateLocalQueueFallbackBeforeInference(input, env, cloudAllowlistPacket);
  const queueFallbackObservabilityEvent = buildQueueFallbackObservabilityEvent(input, queueFallbackDecision);
  logQueueFallbackDecision(input, queueFallbackDecision, queueFallbackObservabilityEvent);
  if (queueFallbackDecision.kind === 'fail_visible') {
    return buildDegradedResponse(input, 'local_queue_saturated', undefined, undefined, {
      queueFallbackDecision,
      queueFallbackObservabilityEvent,
    });
  }
  if (queueFallbackDecision.kind === 'use_cloud_allowlist') {
    if (!cloudAllowlistPacket.ok) {
      return buildDegradedResponse(input, 'cloud_allowlist_runtime_not_wired', undefined, undefined, {
        queueFallbackDecision,
        queueFallbackObservabilityEvent,
      });
    }
    try {
      const cloudAnswer = await dispatchCloudAllowlistAnswer(cloudAllowlistPacket.packet, {
        userId: input.userId,
        tenantId: input.tenantId,
        requestId: input.requestId,
      });
      const locale = normalizeLocale(input.locale);
      const guarded = applyNoUnverifiedSuccessClaimGuard(cloudAnswer.text, locale, input.normalizedText);
      return {
        response: {
          id: `msg-${Date.now()}`,
          text: guarded.text,
          domain: cloudAllowlistPacket.packet.domain === 'cooking' ? 'cooking' : 'chat',
          routeMethod: 'chat-core-v2-cloud-allowlist',
          confidence: guarded.rewritten ? 0.65 : 0.82,
          buttons: null,
          metadata: {
            type: 'chat_core_v2_cloud_allowlist',
            schemaVersion: CHAT_CORE_V2_LOCAL_CHAT_SCHEMA_VERSION,
            compositionMode: 'cloud_allowlist',
            queueFallbackDecision,
            queueFallbackObservabilityEvent,
            antiClaimGuardRewritten: guarded.rewritten,
            providerMetadata: cloudAnswer.providerMetadata,
          },
          timestamp: new Date().toISOString(),
          responseCards: [],
        },
        modelMetadata: cloudAnswer.providerMetadata,
        degraded: false,
      };
    } catch (err) {
      logger.warn(
        {
          requestId: input.requestId,
          userId: input.userId,
          tenantId: input.tenantId,
          err: err instanceof Error ? err.message : String(err),
        },
        'Chat Core v2 cloud allowlist answer failed',
      );
      return buildDegradedResponse(input, 'cloud_allowlist_answer_failed', undefined, undefined, {
        queueFallbackDecision,
        queueFallbackObservabilityEvent,
      });
    }
  }

  const locale = normalizeLocale(input.locale);
  const requireJson = parseBoolean(env.CHAT_CORE_V2_LOCAL_CHAT_REQUIRE_JSON, false);
  const foldedMessage = foldForIntent(input.normalizedText);
  const recipeRequest = isRecipeRequest(foldedMessage);
  const baseNumPredict = readPositiveInt(env.CHAT_CORE_V2_LOCAL_CHAT_NUM_PREDICT, DEFAULT_LOCAL_CHAT_NUM_PREDICT);
  const baseTimeoutMs = readPositiveInt(env.CHAT_CORE_V2_LOCAL_CHAT_TIMEOUT_MS, DEFAULT_LOCAL_CHAT_TIMEOUT_MS);
  const recipeNumPredict = readPositiveInt(env.CHAT_CORE_V2_LOCAL_CHAT_RECIPE_NUM_PREDICT, DEFAULT_RECIPE_NUM_PREDICT);
  const recipeTimeoutMs = readPositiveInt(env.CHAT_CORE_V2_LOCAL_CHAT_RECIPE_TIMEOUT_MS, DEFAULT_RECIPE_TIMEOUT_MS);
  const task: LocalReasoningTask = {
    systemContext: buildSystemPrompt(locale, requireJson),
    prompt: buildUserPrompt(input, locale, recipeRequest),
    userId: input.userId,
    tenantId: input.tenantId,
    allowCloudEscalation: false,
    containsPrivateData: true,
    redactionRequired: false,
    outputSchema: requireJson ? LOCAL_CHAT_OUTPUT_SCHEMA : undefined,
    modelOverride: resolveLocalChatModel(env, recipeRequest),
    think: false,
    numCtx: readPositiveInt(env.CHAT_CORE_V2_LOCAL_CHAT_NUM_CTX, DEFAULT_LOCAL_CHAT_NUM_CTX),
    numPredict: recipeRequest ? Math.max(baseNumPredict, recipeNumPredict) : baseNumPredict,
    timeoutMs: recipeRequest ? Math.max(baseTimeoutMs, recipeTimeoutMs) : baseTimeoutMs,
    temperature: 0.2,
  };

  try {
    const result = await runWithLocalInferenceSlot(() => provider.dispatchLocalReasoning(task)) as LocalReasoningResult;
    const stopReason = typeof result.stopReason === 'string'
      ? result.stopReason
      : '';
    const hitOutputCap = typeof result.providerMetadata?.evalCount === 'number'
      && typeof task.numPredict === 'number'
      && result.providerMetadata.evalCount >= task.numPredict;
    const draft = result.parsed !== undefined
      ? normalizeDraft(result.parsed, locale)
      : buildDraftFromPlainText(result.text, locale);
    if (recipeRequest && shouldRepairRecipeDraft(draft.text, stopReason, hitOutputCap)) {
      const repaired = await tryRepairRecipeDraft(provider, input, locale, draft.text, env);
      if (!repaired) {
        return buildHelpfulFallbackResponse(input, 'recipe_generation_incomplete', result.providerMetadata);
      }
      draft.text = repaired.text;
      draft.reasonCodes = [...draft.reasonCodes, 'recipe_model_repair'];
    }
    const issues = validateComposedAnswerDraft(draft);
    if (issues.length > 0) {
      logger.warn(
        { requestId: input.requestId, userId: input.userId, tenantId: input.tenantId, issues },
        'Chat Core v2 local chat draft failed validation',
      );
      return buildDegradedResponse(input, 'draft_validation_failed', result.providerMetadata, issues);
    }

    const guarded = applyNoUnverifiedSuccessClaimGuard(draft.text, locale, input.normalizedText);
    return {
      response: {
        id: `msg-${Date.now()}`,
        text: guarded.text,
        domain: recipeRequest ? 'cooking' : 'chat',
        routeMethod: 'chat-core-v2-local-llm',
        confidence: guarded.rewritten ? 0.7 : 0.9,
        buttons: null,
        metadata: {
          type: 'chat_core_v2_local_llm',
          schemaVersion: CHAT_CORE_V2_LOCAL_CHAT_SCHEMA_VERSION,
          compositionMode: 'model_constrained',
          draftSchemaVersion: draft.schemaVersion,
          draftReasonCodes: draft.reasonCodes,
          factualClaimCount: draft.factualClaims.length,
          antiClaimGuardRewritten: guarded.rewritten,
          queueFallbackDecision,
          providerMetadata: result.providerMetadata,
        },
        timestamp: new Date().toISOString(),
        responseCards: [],
      },
      modelMetadata: result.providerMetadata,
      degraded: false,
    };
  } catch (err) {
    logger.warn(
      {
        requestId: input.requestId,
        userId: input.userId,
        tenantId: input.tenantId,
        err: err instanceof Error ? err.message : String(err),
      },
      'Chat Core v2 local chat LLM failed',
    );
    return buildHelpfulFallbackResponse(input, 'local_llm_failed');
  }
}

function buildSystemPrompt(locale: ChatCoreV2Locale, requireJson: boolean): string {
  const base = [
    'You are Nexus Hub local chat.',
    `Locale: ${locale}. Answer in the user's language.`,
    'Answer the CURRENT message directly and briefly. Use recent turns only for pronouns or follow-ups.',
    'Never execute or claim app actions. If asked to mutate app data, say a verified preview is needed.',
    'Do not claim private app facts unless evidence is explicitly provided.',
  ];
  if (requireJson) {
    return [
      'Return ONLY valid JSON matching the provided schema.',
      ...base,
    ].join('\n');
  }
  return [
    ...base,
    'Return plain text only.',
  ].join('\n');
}

function buildUserPrompt(
  input: ChatCoreV2LocalChatTurnInput,
  locale: ChatCoreV2Locale,
  recipeRequest = false,
): string {
  const recentTurns = (input.recentTurns ?? [])
    .slice(-2)
    .map((turn) => `${turn.role}: ${truncate(turn.text, 120)}`);
  const parts = [
    `locale: ${locale}`,
    `current: ${truncate(input.normalizedText, 700)}`,
    '',
    'recent context only:',
    recentTurns.length > 0 ? recentTurns.join('\n') : '(none)',
    '',
    'Answer current only. No app actions.',
  ];
  if (recipeRequest) {
    parts.push(buildRecipeFormatInstructions(locale).join('\n'));
  }
  return parts.join('\n');
}

function normalizeDraft(parsed: unknown, locale: ChatCoreV2Locale): ComposedAnswerDraft {
  const record = parsed && typeof parsed === 'object' ? parsed as Partial<ComposedAnswerDraft> : {};
  return {
    schemaVersion: record.schemaVersion === COMPOSED_ANSWER_DRAFT_SCHEMA_VERSION
      ? record.schemaVersion
      : COMPOSED_ANSWER_DRAFT_SCHEMA_VERSION,
    mode: record.mode === 'model_constrained' ? record.mode : 'model_constrained',
    locale: isSupportedLocale(record.locale) ? record.locale : locale,
    text: typeof record.text === 'string' ? record.text : '',
    factualClaims: Array.isArray(record.factualClaims) ? record.factualClaims : [],
    reasonCodes: Array.isArray(record.reasonCodes) ? record.reasonCodes : ['local_chat_llm'],
  };
}

function buildDraftFromPlainText(text: string, locale: ChatCoreV2Locale): ComposedAnswerDraft {
  return {
    schemaVersion: COMPOSED_ANSWER_DRAFT_SCHEMA_VERSION,
    mode: 'model_constrained',
    locale,
    text: truncate(String(text ?? '').trim(), 1600),
    factualClaims: [],
    reasonCodes: ['local_chat_llm_plain_constrained'],
  };
}

function applyNoUnverifiedSuccessClaimGuard(
  text: string,
  locale: ChatCoreV2Locale,
  currentMessage = '',
): { text: string; rewritten: boolean } {
  const folded = text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
  if (
    /\b(antes de executar|preciso de confirmacao|confirmacao explicita|confirmacao necessaria|before i execute|explicit confirmation|confirmation required)\b/.test(folded)
    || /\b(reve|revise|rev[êe])\s+e\s+confirma\b/.test(folded)
    || /\b(review|revise)\s+and\s+confirm\b/.test(folded)
    || /\b(revisa|revisar)\s+y\s+confirma\b/.test(folded)
    || /\bconfirma\s+para\b/.test(folded)
  ) {
    return { text: helpfulFallbackText(currentMessage || text, locale), rewritten: true };
  }
  if (!WRITE_SUCCESS_CLAIM_RE.test(text)) return { text, rewritten: false };
  const rewritten = locale.startsWith('pt')
    ? 'Não executei nenhuma ação nesta resposta. Posso preparar uma prévia verificada se quiseres.'
    : locale === 'es'
      ? 'No ejecuté ninguna acción en esta respuesta. Puedo preparar una vista previa verificada si quieres.'
      : 'I did not execute an action in this answer. I can prepare a verified preview if you want.';
  return { text: rewritten, rewritten: true };
}

function buildDegradedResponse(
  input: ChatCoreV2LocalChatTurnInput,
  reason: string,
  providerMetadata?: LocalReasoningResult['providerMetadata'],
  validationIssues?: string[],
  extraMetadata: Record<string, unknown> = {},
): ChatCoreV2LocalChatTurnResult {
  const locale = normalizeLocale(input.locale);
  const text = locale.startsWith('pt')
    ? 'O raciocínio local não conseguiu responder esta mensagem com segurança agora. Tenta reformular ou pede uma ação específica.'
    : locale === 'es'
      ? 'El razonamiento local no pudo responder este mensaje con seguridad ahora. Intenta reformularlo o pide una acción específica.'
      : 'Local reasoning could not answer this message safely right now. Try rephrasing or ask for a specific action.';
  return {
    response: {
      id: `msg-${Date.now()}`,
      text,
      domain: 'chat',
      routeMethod: 'chat-core-v2-local-llm-degraded',
      confidence: 0.2,
      buttons: null,
      metadata: {
        type: 'chat_core_v2_local_llm',
        schemaVersion: CHAT_CORE_V2_LOCAL_CHAT_SCHEMA_VERSION,
        degraded: true,
        reason,
        validationIssues,
        ...extraMetadata,
        providerMetadata,
      },
      timestamp: new Date().toISOString(),
      responseCards: [],
    },
    modelMetadata: providerMetadata,
    degraded: true,
  };
}

function evaluateLocalQueueFallbackBeforeInference(
  input: ChatCoreV2LocalChatTurnInput,
  env: EnvLike,
  cloudAllowlistPacket: CloudAllowlistPacketResult,
): ChatCoreV2QueueFallbackDecision {
  const activation = resolveChatCoreV2ActivationConfig(env);
  return evaluateChatCoreV2QueueFallback({
    activation,
    queue: getLocalInferenceGateSnapshot(env as NodeJS.ProcessEnv),
    policy: resolveChatCoreV2QueueFallbackPolicy(env),
    cloudPacket: cloudAllowlistPacket,
    requestAllowsBackground: false,
  });
}

function logQueueFallbackDecision(
  input: ChatCoreV2LocalChatTurnInput,
  decision: ChatCoreV2QueueFallbackDecision,
  observabilityEvent: ReturnType<typeof buildQueueFallbackObservabilityEvent>,
): void {
  if (decision.kind === 'use_local_now' || decision.reasonCode === 'queue_below_threshold') return;
  logger.info(
    {
      requestId: input.requestId,
      userId: input.userId,
      tenantId: input.tenantId,
      decisionKind: decision.kind,
      reasonCode: decision.reasonCode,
      cloudDenialReason: decision.cloudDenialReason,
      observabilityEvent,
    },
    'Chat Core v2 local queue fallback decision',
  );
}

function buildQueueFallbackObservabilityEvent(
  input: ChatCoreV2LocalChatTurnInput,
  decision: ChatCoreV2QueueFallbackDecision,
) {
  return buildChatCoreV2FailureObservabilityEvent({
    failureMode: 'local_queue_saturation',
    reasonCode: decision.reasonCode,
    metricValue: decision.kind === 'use_local_now' || decision.reasonCode === 'queue_below_threshold' ? 0 : 1,
    metadata: {
      routeMethod: 'chat-core-v2-local-chat',
      surface: input.surface,
      reasonCode: decision.reasonCode,
      mode: decision.kind,
      // Safe enums only. cloudDenialReason is allowlisted in
      // failure-observability; undefined values are dropped by the sanitizer.
      cloudDenialReason: decision.cloudDenialReason,
      locale: normalizeLocale(input.locale),
    },
  });
}

function buildHelpfulFallbackResponse(
  input: ChatCoreV2LocalChatTurnInput,
  reason: string,
  providerMetadata?: LocalReasoningResult['providerMetadata'],
): ChatCoreV2LocalChatTurnResult {
  const locale = normalizeLocale(input.locale);
  const recipeRequest = isRecipeRequest(foldForIntent(input.normalizedText));
  const text = helpfulFallbackText(input.normalizedText, locale);
  return {
    response: {
      id: `msg-${Date.now()}`,
      text,
      domain: recipeRequest ? 'cooking' : 'chat',
      routeMethod: 'chat-core-v2-local-llm-degraded',
      confidence: 0.45,
      buttons: null,
      metadata: {
        type: 'chat_core_v2_local_llm',
        schemaVersion: CHAT_CORE_V2_LOCAL_CHAT_SCHEMA_VERSION,
        degraded: true,
        reason,
        fallbackKind: 'safe_concise_answer',
        providerMetadata,
      },
      timestamp: new Date().toISOString(),
      responseCards: [],
    },
    modelMetadata: providerMetadata,
    degraded: true,
  };
}

function helpfulFallbackText(message: string, locale: ChatCoreV2Locale): string {
  const folded = foldForIntent(message);
  if (isRecipeRequest(folded)) return recipeUnavailableText(locale);
  const asksNextStep = /\b(next step|proximo passo|pequeno passo|paso pequeno|siguiente paso)\b/.test(folded);
  const mentionsFocus = /\b(focus|foco|concentr)\b/.test(folded);
  if (locale.startsWith('pt')) {
    if (asksNextStep) return 'Escolhe uma única ação de 25 minutos para hoje, define o resultado esperado e fecha tudo que não ajuda esse passo.';
    if (mentionsFocus) return 'Para manter foco, escolhe uma única próxima ação pequena e termina-a antes de abrir outra frente.';
    return 'Divide isso numa próxima ação pequena, faz um bloco curto de foco e revê o resultado antes de continuar.';
  }
  if (locale === 'es') {
    if (asksNextStep) return 'Elige una sola acción de 25 minutos para hoy, define el resultado esperado y cierra todo lo que no ayude a ese paso.';
    if (mentionsFocus) return 'Para mantener el foco, elige una sola próxima acción pequeña y termínala antes de abrir otro frente.';
    return 'Convierte eso en una próxima acción pequeña, haz un bloque corto de foco y revisa el resultado antes de seguir.';
  }
  if (asksNextStep) return 'Pick one 25-minute action for today, define the expected result, and close anything that does not help that step.';
  if (mentionsFocus) return 'To stay focused, choose one small next action and finish it before opening another thread.';
  return 'Turn it into one small next action, do a short focus block, and review the result before continuing.';
}

function foldForIntent(message: string): string {
  return message.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

function isRecipeRequest(foldedText: string): boolean {
  if (/\b(recipe|recipes|receita|receitas|receta|recetas|ingredientes?|ingredients?|modo de preparo|instrucoes|instructions|servings?|porcoes|porcao)\b/.test(foldedText)) {
    return true;
  }

  const hasCookingAction = /\b(make|create|generate|cook|prepare|bake|roast|faca|faz|cria|crie|gera|gerar|cozinhe|cozinhar|prepare|prepara|preparar|asse|assar|horne|hornear)\b/.test(foldedText);
  const hasCookingContext = /\b(food|meal|dish|prato|plato|cozinha|cocina|forno|oven|panela|frigideira|recheio|recheado|massa|molho|servir|serves|pessoas|porcoes|porcao)\b/.test(foldedText);
  return hasCookingAction && hasCookingContext;
}

function recipeUnavailableText(locale: ChatCoreV2Locale): string {
  if (locale.startsWith('pt')) {
    return 'Não consegui gerar uma receita completa com segurança agora. Tenta novamente com o prato, porções e preferências principais.';
  }
  if (locale === 'es') {
    return 'No pude generar una receta completa con seguridad ahora. Inténtalo otra vez con el plato, las porciones y las preferencias principales.';
  }
  return 'I could not generate a complete recipe safely right now. Try again with the dish, servings, and main preferences.';
}

function shouldRepairRecipeDraft(text: string, stopReason: string, hitOutputCap: boolean): boolean {
  const folded = foldForIntent(text);
  const hasIngredients = /\b(ingredientes|ingredients|ingredientes)\b/.test(folded);
  const hasMethod = /\b(modo de preparo|preparo|method|instructions|directions|instrucciones)\b/.test(folded);
  const hasServings = /\b(rende|porcoes|porcoes|serves|servings|yields)\b/.test(folded);
  const hasTiming = /\b(preparo|prep|cozimento|cook)\b/.test(folded);
  const hasMacros = /\b(macros|proteina|protein|gordura|fat|carboidratos|carbs|calorias|calories)\b/.test(folded);
  const hasRequiredSections = hasIngredients && hasMethod && hasServings && hasTiming && hasMacros;
  if (hasRequiredSections) return false;
  return stopReason === 'length' || hitOutputCap || !hasRequiredSections;
}

async function tryRepairRecipeDraft(
  provider: { dispatchLocalReasoning(task: LocalReasoningTask): Promise<unknown> },
  input: ChatCoreV2LocalChatTurnInput,
  locale: ChatCoreV2Locale,
  partialText: string,
  env: EnvLike,
): Promise<{ text: string } | null> {
  try {
    const result = await runWithLocalInferenceSlot(() => provider.dispatchLocalReasoning({
      systemContext: [
        'You are Nexus Hub recipe composer.',
        `Locale: ${locale}. Answer in the user's language.`,
        'Generate a complete, saveable recipe that directly matches the user request.',
        'Do not use placeholder ingredients. Do not mention app actions. Do not hardcode a stock recipe.',
        'Be concise so every required section fits in one response.',
        'Return plain text only.',
      ].join('\n'),
      prompt: [
        `User request: ${truncate(input.normalizedText, 700)}`,
        '',
        'Incomplete draft, if useful:',
        truncate(partialText, 700) || '(none)',
        '',
        'Rewrite as a complete recipe.',
        ...buildRecipeFormatInstructions(locale),
      ].join('\n'),
      userId: input.userId,
      tenantId: input.tenantId,
      allowCloudEscalation: false,
      containsPrivateData: true,
      redactionRequired: false,
      modelOverride: resolveLocalChatModel(env, true),
      think: false,
      numCtx: Math.max(readPositiveInt(env.CHAT_CORE_V2_LOCAL_CHAT_NUM_CTX, DEFAULT_LOCAL_CHAT_NUM_CTX), 1024),
      numPredict: readPositiveInt(env.CHAT_CORE_V2_LOCAL_CHAT_RECIPE_NUM_PREDICT, DEFAULT_RECIPE_NUM_PREDICT),
      timeoutMs: readPositiveInt(env.CHAT_CORE_V2_LOCAL_CHAT_RECIPE_TIMEOUT_MS, DEFAULT_RECIPE_TIMEOUT_MS),
      temperature: 0.2,
    })) as LocalReasoningResult;
    const text = truncate(String(result.text ?? '').trim(), 1600);
    return shouldRepairRecipeDraft(text, String(result.stopReason ?? ''), false) ? null : { text };
  } catch (err) {
    logger.warn(
      {
        requestId: input.requestId,
        userId: input.userId,
        tenantId: input.tenantId,
        err: err instanceof Error ? err.message : String(err),
      },
      'Chat Core v2 recipe repair failed',
    );
    return null;
  }
}

function buildRecipeFormatInstructions(locale: ChatCoreV2Locale): string[] {
  if (locale.startsWith('pt')) {
    return [
      'Formato da receita: concisa, completa e pronta para guardar. Sem placeholders. Sem dizer que guardaste ou criaste algo no app.',
      'Preserva o prato pedido e os ingredientes centrais conhecidos; não troques por outro prato. Se não souberes o prato, pede clarificação.',
      'Usa exatamente estas secções em português:',
      '**Título**',
      '**Rende:** número de porções',
      '**Preparo:** minutos',
      '**Cozimento:** minutos',
      '**Macros por porção (estimado):** Proteína N g; Gordura N g; Carboidratos N g; Calorias N kcal',
      '**Ingredientes:** 5-8 linhas com quantidade + unidade + ingrediente quando possível',
      '**Modo de preparo:** 4-5 passos numerados',
      'Termina todas as secções.',
    ];
  }
  if (locale === 'es') {
    return [
      'Formato de receta: concisa, completa y lista para guardar. Sin placeholders. No digas que guardaste o creaste nada en la app.',
      'Conserva el plato pedido y sus ingredientes centrales conocidos; no lo cambies por otro plato. Si no conoces el plato, pide aclaración.',
      'Usa exactamente estas secciones en español:',
      '**Título**',
      '**Rinde:** número de porciones',
      '**Preparación:** minutos',
      '**Cocción:** minutos',
      '**Macros por porción (estimado):** Proteína N g; Grasa N g; Carbohidratos N g; Calorías N kcal',
      '**Ingredientes:** 5-8 líneas con cantidad + unidad + ingrediente cuando sea posible',
      '**Modo de preparación:** 4-5 pasos numerados',
      'Termina todas las secciones.',
    ];
  }
  return [
    'Recipe format: concise, complete, saveable recipe. No placeholders. Do not say you saved or created anything in the app.',
    'Preserve the requested dish and known core ingredients; do not substitute a different dish. If you do not know the dish, ask for clarification.',
    'Use exactly these English sections:',
    '**Title**',
    '**Serves:** number of servings',
    '**Prep:** minutes',
    '**Cook:** minutes',
    '**Macros per serving (estimate):** Protein N g; Fat N g; Carbs N g; Calories N kcal',
    '**Ingredients:** 5-8 lines with quantity + unit + ingredient when possible',
    '**Method:** 4-5 numbered steps',
    'Finish every section.',
  ];
}

function resolveLocalChatModel(env: EnvLike, recipeRequest = false): string {
  if (recipeRequest) {
    const recipeModel = String(env.CHAT_CORE_V2_LOCAL_CHAT_RECIPE_MODEL ?? '').trim();
    if (recipeModel) return recipeModel;
  }
  return String(env.CHAT_CORE_V2_LOCAL_CHAT_MODEL ?? '').trim()
    || config.ollama.classifierModel
    || config.ollama.model;
}

function normalizeLocale(raw: string | null | undefined): ChatCoreV2Locale {
  const value = String(raw ?? '').trim();
  if (value === 'pt-PT' || value === 'pt-BR' || value === 'es' || value === 'en') return value;
  const lower = value.toLowerCase();
  if (lower.startsWith('pt-pt')) return 'pt-PT';
  if (lower.startsWith('pt')) return 'pt-BR';
  if (lower.startsWith('es')) return 'es';
  return 'en';
}

function isSupportedLocale(value: unknown): value is ChatCoreV2Locale {
  return value === 'en' || value === 'pt-PT' || value === 'pt-BR' || value === 'es';
}

function readPositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

function parseCanaryList(raw: string | undefined): string[] {
  return String(raw ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}
