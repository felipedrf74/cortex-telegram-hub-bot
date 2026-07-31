// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * M8 — unified chat answer finalizer.
 *
 * ONE terminal pipeline for every /message response family. Wraps contract
 * enrichment (grounding envelope + NexusAnswerContract + fallback policy)
 * and — for model-backed families only — the final-answer composer plus the
 * heuristic response quality gate.
 *
 * Policy is driven by a per-family table (stage family first, resolved
 * routeMethod second). Three policies exist:
 *
 *   'passthrough'   — envelope returned byte-identical (idempotent replay,
 *                     planner envelopes that already carry their own
 *                     contract metadata from services/chat.ts).
 *   'contract_only' — contract enrichment + metadata stamping only. For
 *                     deterministic/token-zero/cached/identity/templated
 *                     families: they CANNOT hallucinate, so the heuristic
 *                     quality gate (the "quality-gate cliff") is skipped.
 *   'full_gate'     — enrichment + composeNexusFinalAnswer +
 *                     applyChatResponseQualityGate with token-zero claim
 *                     verification. Model-backed families (legacy domain
 *                     handlers, ChatCoreV2 local answer owner, model
 *                     planner outputs, internet research, attachments).
 *
 * UNKNOWN families default to 'full_gate' — fail closed.
 */

import { logger } from '../../utils/logger';
import {
  buildNexusAnswerContract,
  metadataGroundingFacts,
  type ChatLatencyTracker,
  type NexusAnswerContract,
  type NexusChatActionability,
  type NexusGroundingFact,
  type NexusChatLanguage,
  type NexusChatVerificationStatus,
} from '../../services/chat-answer-contract';
import { inferChatTurnContract } from '../../services/chat-turn-contract';
import { buildChatGroundingEnvelope } from '../../services/chat-grounding-layer';
import { applyChatFallbackPolicy } from '../../services/chat-fallback-policy';
import {
  buildNexusComposedAnswerDraft,
  composeNexusFinalAnswer,
  type NexusAnswerCompositionMode,
  type NexusFinalAnswerGateMode,
} from '../../services/chat-final-answer-composer';
import {
  isChatQualityGateEnabled,
  isChatTurnContractEnabled,
} from '../../services/runtime-flags';
import {
  buildBlocksFromMarkdown,
  type ChatResponseBlock,
} from '../../services/chat-response-blocks';
import { recordChatQualityGateOutcome } from '../../services/chat-hybrid-metrics';
import {
  buildResponseLanguageTelemetry,
  checkResponseLocaleFidelity,
  detectResponseLanguage,
  detectStrictShortResponseLanguage,
} from '../../services/chat-language-detector';
import type { analyzeChatSkillOrchestration } from '../../services/chat-skill-orchestrator';

// ─── Gate policy table ─────────────────────────────────────────────

export type ChatFinalizerGatePolicy = 'passthrough' | 'contract_only' | 'full_gate';

/**
 * Stage families (the recordChatStage checkpoint names) with an explicit
 * policy. Highest precedence — call sites pass their stage family.
 */
const STAGE_FAMILY_GATE_POLICIES: Readonly<Record<string, ChatFinalizerGatePolicy>> = {
  // Replay families: envelopes were finalized on the ORIGINAL turn; they
  // must be returned byte-identical, never re-gated or re-stamped.
  idempotent_replay: 'passthrough',
  // Planner envelopes are built (and verified) inside services/chat.ts with
  // their own contract metadata. The deterministic planner cannot
  // hallucinate; re-enriching would double-wrap its envelope.
  action_planner_deterministic: 'passthrough',
  // Confirmed action runs re-use the planner envelope construction and are
  // read-back verified inside the executor.
  decision_confirmation_execute: 'passthrough',

  // Deterministic / token-zero / cached / identity / templated families.
  idempotency_in_progress: 'contract_only',
  token_zero_shortcut: 'contract_only',
  chat_core_v2_deterministic_read_early: 'contract_only',
  chat_core_v2_deterministic_read: 'contract_only',
  pending_work_cancelled: 'contract_only',
  pending_work_cancel_empty: 'contract_only',
  action_gateway_preview: 'contract_only',
  action_gateway_stop: 'contract_only',
  cached_command: 'contract_only',
  authenticated_identity: 'contract_only',
  fast_path: 'contract_only',
  training_plan_shortcut: 'contract_only',
  decision_confirmation_templated: 'contract_only',
  destructive_confirmation_hold: 'contract_only',
  // M14: deterministic routing-clarify terminal — fixed templated question,
  // cannot hallucinate.
  routing_clarify: 'contract_only',
  // M19: fixed localized disclosure after both planner passes decline an
  // actionable cross-skill request; no model/tool execution in this stage.
  cross_skill_plan_declined: 'contract_only',
  chat_core_v2_unsupported_fallback: 'contract_only',
  // M18: deterministic partial-progress template after a domain-handler
  // timeout with checkpointed tool work — fixed localized string listing
  // completed tools, cannot hallucinate, honestly tagged partial_failure.
  legacy_timeout_partial: 'contract_only',
  // NOTE: domain_shortcut is intentionally ABSENT from this table. The
  // family is mixed (deterministic state shortcuts AND model-authored
  // refinement/script outputs share the stage checkpoint), so it is
  // resolved per-routeMethod in resolveChatFinalizerGatePolicy with a
  // fail-closed full_gate default.

  // The degraded-response terminal (chat-message-degraded-response.ts)
  // hand-rolls its own NexusAnswerContract + fallback policy for the
  // retryable-provider-failure path; it routes through the finalizer
  // only so governance can see ONE terminal pipeline. Byte-identical.
  degraded_response: 'passthrough',

  // Model-backed families — full compose + gate.
  action_planner_model: 'full_gate',
  attachment: 'full_gate',
  internet_research: 'full_gate',
  chat_core_v2_local_answer: 'full_gate',
  legacy_timeout_background: 'full_gate',
  legacy_response: 'full_gate',
};

/**
 * Deterministic routeMethods (fallback lookup when a caller has no stage
 * family, e.g. cached envelopes whose routeMethod was stamped on the
 * original deterministic turn). Anything NOT listed resolves 'full_gate'.
 */
const DETERMINISTIC_ROUTE_METHOD_POLICIES: ReadonlySet<string> = new Set([
  'idempotency-in-progress',
  'idempotent-replay',
  'pending-action-cancelled',
  'pending-action-cancel-empty',
  'chat-core-v2-action-gateway',
  'chat-core-v2-command-preview',
  'chat-core-v2-deterministic-read',
  'authenticated-identity',
  'fast-path',
  'training-today-read-shortcut',
  'training-plan-shortcut',
  'plan-shortcut',
  'confirmation-required',
  'routing-clarify',
  'cross-skill-plan-declined',
  'decision-center-action',
  'unsupported',
  'finance-state-shortcut',
  'content-intelligence-shortcut',
  // Templated *-unavailable fallbacks cannot hallucinate — they are fixed
  // localized strings.
  'content-script-unavailable',
  'content-refine-unavailable',
]);

/**
 * Adversarial-review fix (2026-07): routeMethods inside the domain_shortcut
 * family whose text is model-authored. 'content-refine' is a live
 * completeOneShotWithFallback call, 'content-script' carries model-generated
 * script text from the content engine, and 'content-refine-fallback' is a
 * heuristic rewrite of model-sourced text. All of them MUST run the full
 * compose + quality gate (Phase K F3: a side-effect success claim like
 * "Publiquei o reel" must trip even for creative-text owners).
 */
const MODEL_AUTHORED_SHORTCUT_ROUTE_METHODS: ReadonlySet<string> = new Set([
  'content-refine',
  'content-refine-fallback',
  'content-script',
]);

export function resolveChatFinalizerGatePolicy(input: {
  stageFamily?: string;
  routeMethod?: string | null;
}): ChatFinalizerGatePolicy {
  if (input.stageFamily === 'domain_shortcut') {
    // Mixed family: split by routeMethod. Deterministic siblings keep
    // contract_only; model-authored routeMethods and anything unknown fail
    // closed to the full gate.
    if (
      input.routeMethod
      && !MODEL_AUTHORED_SHORTCUT_ROUTE_METHODS.has(input.routeMethod)
      && DETERMINISTIC_ROUTE_METHOD_POLICIES.has(input.routeMethod)
    ) {
      return 'contract_only';
    }
    return 'full_gate';
  }
  if (input.stageFamily && STAGE_FAMILY_GATE_POLICIES[input.stageFamily]) {
    return STAGE_FAMILY_GATE_POLICIES[input.stageFamily];
  }
  if (input.routeMethod && DETERMINISTIC_ROUTE_METHOD_POLICIES.has(input.routeMethod)) {
    return 'contract_only';
  }
  // Fail closed: unknown families run the full gate.
  return 'full_gate';
}

// ─── Shared helpers (moved from chat-message-routes.ts) ────────────

export function deterministicReadGroundingFact(source: string): NexusGroundingFact {
  return {
    statement: 'Server-side deterministic read produced this response.',
    source,
    freshness: 'fresh',
    confidence: 1,
    safeForUser: true,
  };
}

export function normalizeNexusAnswerLanguage(locale: string | null | undefined): NexusChatLanguage | undefined {
  if (!locale) return undefined;
  const normalized = locale.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === 'mixed') return 'mixed';
  if (normalized.startsWith('pt')) return 'pt';
  if (normalized.startsWith('en')) return 'en';
  if (normalized.startsWith('es')) return 'en';
  return undefined;
}

const SUPPORTED_LANGUAGE_MISMATCH_FALLBACK = {
  en: 'I could not safely present that response in English. Please try again.',
  pt: 'Não consegui apresentar essa resposta com segurança em português. Tente novamente.',
} as const;

interface SupportedLanguageMismatchGuardResult {
  text: string;
  contract: NexusAnswerContract;
  trip: {
    action: 'replaced';
    reason: 'response_locale_mismatch';
    expected: 'en' | 'pt';
    detected: 'en' | 'pt' | 'es';
    confidence: number;
  } | null;
}

function hasSupportedEntityListFraming(text: string, expected: 'en' | 'pt'): boolean {
  const colonIndex = text.indexOf(':');
  if (colonIndex <= 0 || colonIndex > 100) return false;
  const prefix = text.slice(0, colonIndex).trim();
  const values = text.slice(colonIndex + 1).trim();
  const listSeparators = (values.match(/[;,]/g) ?? []).length;
  if (listSeparators === 0) return false;

  const prefixDetection = detectResponseLanguage(prefix);
  return prefixDetection.language === expected;
}

/**
 * Enforce the supported EN/PT response contract at the single terminal
 * boundary for model-authored/full-gate responses. Long replies require a
 * detector-named contradiction backed by discriminative language evidence;
 * this avoids treating weak shared words as the framing language. A small
 * exact set of unambiguous short replies closes the detector's intentional
 * short-text fail-open seam.
 * Contradictions are replaced locally without another provider call.
 */
function enforceSupportedResponseLanguageContract(
  text: string,
  contract: NexusAnswerContract,
): SupportedLanguageMismatchGuardResult {
  const fidelity = checkResponseLocaleFidelity(contract.language, text);
  const shortDetected = detectStrictShortResponseLanguage(text, fidelity.expected);
  const detected = shortDetected ?? fidelity.detected;
  const confidence = shortDetected ? 1 : fidelity.confidence;
  const mixedSpanishMismatch = contract.language === 'mixed' && detected === 'es';
  const expected = mixedSpanishMismatch ? 'en' : fidelity.expected;
  if (expected !== 'en' && expected !== 'pt') {
    return { text, contract, trip: null };
  }
  if (
    detected === 'unknown'
    || detected === expected
    || (
      !mixedSpanishMismatch
      && !shortDetected
      && hasSupportedEntityListFraming(text, expected)
    )
  ) {
    return { text, contract, trip: null };
  }
  const fallbackText = SUPPORTED_LANGUAGE_MISMATCH_FALLBACK[expected];

  const guardedContract: NexusAnswerContract = {
    ...contract,
    language: expected,
    fallbackUsed: true,
    fallback: {
      fallbackType: 'deterministic_summary',
      fallbackReason: 'response_locale_mismatch_blocked',
      retryable: true,
      sourceFreshness: contract.staleness,
      userActionRequired: true,
      operatorActionRequired: true,
    },
    userFacingSummary: fallbackText,
    nextBestActions: [
      ...contract.nextBestActions.filter((action) => (
        action.id !== 'retry_in_english'
        && action.id !== 'retry_in_portuguese'
        && action.id !== 'retry_in_supported_language'
      )),
      {
        id: 'retry_in_supported_language',
        label: expected === 'pt' ? 'Tentar novamente em português' : 'Try again in English',
        kind: 'retry',
        targetSkill: contract.ownerSkill,
      },
    ],
  };
  return {
    text: fallbackText,
    contract: guardedContract,
    trip: {
      action: 'replaced',
      reason: 'response_locale_mismatch',
      expected,
      detected,
      confidence,
    },
  };
}

function contextSourcesFromMetadata(metadata: Record<string, unknown> | null | undefined): Array<{ source: string; freshness?: string; confidence?: number; reason?: string }> {
  if (!metadata) return [];
  const sources: Array<{ source: string; freshness?: string; confidence?: number; reason?: string }> = [];
  const type = typeof metadata.type === 'string' ? metadata.type : undefined;
  if (type) {
    sources.push({
      source: `metadata.${type}`,
      freshness: 'fresh',
      confidence: 0.85,
      reason: `Backend returned scoped ${type} metadata for this answer.`,
    });
  }
  if (typeof metadata.verificationStatus === 'string') {
    sources.push({
      source: 'metadata.verification_status',
      freshness: 'fresh',
      confidence: 0.9,
      reason: `Backend verifier reported ${metadata.verificationStatus}.`,
    });
  }
  if (metadata.responseSufficiency && typeof metadata.responseSufficiency === 'object') {
    sources.push({
      source: 'metadata.response_sufficiency',
      freshness: 'fresh',
      confidence: 0.8,
      reason: 'Response sufficiency metadata was available.',
    });
  }
  return sources;
}

function anchorRequestedAnswerSubject(input: {
  normalizedText: string;
  responseText: string;
  domain: unknown;
}): string {
  if (input.domain !== 'triathlon' && input.domain !== 'training') return input.responseText;
  if (!/\bwhat(?:['’]s| is)\s+today(?:['’]s)?\s+workout\b/i.test(input.normalizedText)) {
    return input.responseText;
  }
  if (/\btoday(?:['’]s)?\s+workout\b/i.test(input.responseText)) return input.responseText;
  return `Today's workout: ${input.responseText}`;
}

// ─── Contract enrichment + gated composition ───────────────────────

export interface FinalizeChatAnswerMetadataInput {
  normalizedText: string;
  responseText: string;
  userId: number;
  tenantId: number;
  chatRequestId: string;
  routeMethod: string;
  domain: any;
  confidence: number;
  tracker: ChatLatencyTracker;
  latencyTier: Parameters<ChatLatencyTracker['snapshot']>[0];
  activeContext?: any;
  route?: any;
  routingDecision?: ReturnType<typeof analyzeChatSkillOrchestration>;
  existingMetadata?: Record<string, unknown> | null;
  groundingFacts?: NexusGroundingFact[];
  actionability?: NexusChatActionability;
  verificationStatus?: NexusChatVerificationStatus;
  compositionMode?: NexusAnswerCompositionMode;
  locale?: string | null;
  fallback?: Partial<NexusAnswerContract['fallback']>;
  /** Stage family for gate policy resolution. Unknown → full gate. */
  stageFamily?: string;
  /**
   * Request start (ms epoch) for the token-zero verification window. A
   * verified_kept outcome requires the matched row's write timestamp to fall
   * inside this request (small skew allowance). Absent → the grounding layer
   * falls back to verification-time Date.now(), which is strictly tighter.
   */
  requestStartedAt?: number;
}

export function finalizeChatAnswerMetadata(input: FinalizeChatAnswerMetadataInput): {
  text: string;
  metadata: Record<string, unknown>;
  contract: NexusAnswerContract;
} {
  const gatePolicy = resolveChatFinalizerGatePolicy({
    stageFamily: input.stageFamily,
    routeMethod: input.routeMethod,
  });
  const responseText = input.responseText;
  try {
    const rolloutScope = { userId: input.userId, tenantId: input.tenantId };
    const turnContract = isChatTurnContractEnabled(process.env, rolloutScope)
      ? inferChatTurnContract({
        message: input.normalizedText,
        routedDomain: input.domain,
        activeContextDomain: input.activeContext?.domain ?? null,
        involvedSkills: input.routingDecision?.involvedSkills,
      })
      : null;
    const grounding = buildChatGroundingEnvelope({
      message: input.normalizedText,
      userId: input.userId,
      tenantId: input.tenantId,
      route: input.route,
      routedDomain: input.domain,
      activeContextDomain: input.activeContext?.domain ?? null,
      involvedSkills: input.routingDecision?.involvedSkills,
      contextSources: contextSourcesFromMetadata(input.existingMetadata),
    });
    const contract = buildNexusAnswerContract({
      intent: grounding.capability.intent,
      ownerSkill: turnContract?.skill ?? grounding.capability.ownerSkill,
      routeKind: turnContract?.routeKind,
      groundingRequirement: turnContract?.groundingRequired,
      expectedResponseShape: turnContract?.expectedResponseShape,
      language: normalizeNexusAnswerLanguage(input.locale) ?? turnContract?.language,
      ambiguityReasons: turnContract?.ambiguityReasons,
      routeMethod: input.routeMethod,
      confidence: Math.min(input.confidence, turnContract?.confidence ?? 1),
      groundingFacts: [...grounding.groundingFacts, ...(input.groundingFacts ?? [])],
      missingFacts: grounding.missingFacts,
      staleness: grounding.staleness,
      riskLevel: turnContract?.riskClass === 'destructive' ? 'high' : turnContract?.riskClass,
      actionability: input.actionability ?? grounding.capability.actionability,
      verificationStatus: input.verificationStatus ?? 'not_required',
      fallback: input.fallback,
      userFacingSummary: responseText.slice(0, 240),
      nextBestActions: grounding.missingFacts.length > 0
        ? [{ id: 'clarify_missing_facts', label: 'Clarify missing details', kind: 'ask', targetSkill: grounding.capability.ownerSkill }]
        : [],
      traceId: input.chatRequestId,
      latency: input.tracker.snapshot(input.latencyTier, grounding.capability.capability.latencyBudgetMs),
    });
    const qualityGateEnabled = isChatQualityGateEnabled(process.env, rolloutScope);
    const fallbackPolicy = applyChatFallbackPolicy(contract);
    const draft = buildNexusComposedAnswerDraft({
      text: responseText,
      contract: fallbackPolicy.contract,
      mode: input.compositionMode,
      reasonCodes: ['chat_message_route'],
    });
    const gateMode: NexusFinalAnswerGateMode = gatePolicy === 'contract_only' ? 'contract_only' : 'full';
    const composed = composeNexusFinalAnswer({
      draft,
      contract: fallbackPolicy.contract,
      qualityGateEnabled,
      gateMode,
      verification: gateMode === 'full'
        ? {
          userId: input.userId,
          tenantId: input.tenantId,
          ...(typeof input.requestStartedAt === 'number' ? { requestStartedAt: input.requestStartedAt } : {}),
        }
        : undefined,
    });
    const gated = composed.quality;
    const composedText = gatePolicy === 'full_gate'
      ? anchorRequestedAnswerSubject({ ...input, responseText: composed.text })
      : composed.text;
    const outputGuard = gatePolicy === 'full_gate'
      ? enforceSupportedResponseLanguageContract(composedText, composed.contract)
      : { text: composedText, contract: composed.contract, trip: null };
    const finalText = outputGuard.text;
    const effectiveFallbackPolicy = outputGuard.trip
      ? applyChatFallbackPolicy(outputGuard.contract)
      : fallbackPolicy;
    const finalContract = outputGuard.trip
      ? effectiveFallbackPolicy.contract
      : outputGuard.contract;
    // M8 counters: only full-gate families run the heuristics, so only they
    // produce meaningful pass/verified-kept/surgical/replaced outcomes.
    if (gateMode === 'full' && (outputGuard.trip || gated.action)) {
      recordChatQualityGateOutcome(outputGuard.trip ? 'replaced' : gated.action!);
    }
    // M8 (d): every trip persists { originalText, issues, action } under
    // metadata.qualityGate — operator-visible, never user-visible text.
    const effectiveGateAction = outputGuard.trip ? 'replaced' : gated.action;
    const qualityGateTripStamp = effectiveGateAction && effectiveGateAction !== 'pass'
      ? {
        qualityGate: {
          action: effectiveGateAction,
          issues: outputGuard.trip
            ? ['response_locale_mismatch']
            : gated.tripIssues ?? gated.issues,
          originalText: outputGuard.trip
            ? '[response-language mismatch withheld]'
            : gated.originalText ?? responseText,
          ...(gated.verifiedEntity ? { verifiedEntity: gated.verifiedEntity } : {}),
        },
      }
      : {};
    return {
      text: finalText,
      contract: finalContract,
      metadata: {
        ...(input.existingMetadata ?? {}),
        type: (input.existingMetadata?.type as string | undefined) ?? 'nexus_answer',
        chatReasoning: finalContract,
        ...(turnContract ? { chatTurnContract: turnContract } : {}),
        ...(input.routingDecision && input.routingDecision.involvedSkills.length > 1
          ? { involvedSkills: [...input.routingDecision.involvedSkills] }
          : {}),
        groundingFacts: metadataGroundingFacts(finalContract.groundingFacts),
        finalAnswerComposition: {
          version: composed.composerVersion,
          ok: outputGuard.trip ? false : composed.ok,
          issues: outputGuard.trip
            ? [...new Set([...composed.issues, 'response_locale_mismatch'])]
            : composed.issues,
          mode: draft.mode,
          draftSchemaVersion: draft.schemaVersion,
        },
        responseQuality: {
          status: outputGuard.trip ? 'repaired' : gated.status,
          issues: [
            ...effectiveFallbackPolicy.issues,
            ...gated.issues,
            ...(outputGuard.trip ? ['response_locale_mismatch'] : []),
          ],
          score: outputGuard.trip ? Math.min(gated.score, 0.5) : gated.score,
          qualityGateDisabled: !qualityGateEnabled,
          // Phase K (2026-05-26) observability — surface the gate's
          // skip decision so audit_trail / portal show whether the
          // creative-text-owner short-circuit fired for this turn.
          qualityGateSkipped: outputGuard.trip ? false : gated.qualityGateSkipped === true,
          qualityGateReason: outputGuard.trip
            ? 'response_locale_mismatch'
            : gated.qualityGateReason ?? (qualityGateEnabled ? 'pass' : 'gate_disabled'),
        },
        ...qualityGateTripStamp,
        ...(outputGuard.trip ? { responseLanguageGuard: outputGuard.trip } : {}),
        fallbackPolicy: effectiveFallbackPolicy.policy,
        responseLanguage: buildResponseLanguageTelemetry(input.locale, finalText),
      },
    };
  } catch (err) {
    logger.error(
      { err, chatRequestId: input.chatRequestId, userId: input.userId, tenantId: input.tenantId },
      'Chat answer metadata build failed; returning original response text',
    );
    const contract = buildNexusAnswerContract({
      intent: 'chat.answer',
      ownerSkill: 'chat',
      language: normalizeNexusAnswerLanguage(input.locale),
      routeMethod: input.routeMethod,
      confidence: Math.min(input.confidence, 0.5),
      actionability: 'answer_only',
      verificationStatus: 'not_required',
      fallback: {
        fallbackType: 'deterministic_summary',
        fallbackReason: 'answer_contract_build_failed',
        retryable: false,
        userActionRequired: false,
        operatorActionRequired: true,
      },
      userFacingSummary: responseText.slice(0, 240),
      traceId: input.chatRequestId,
      latency: input.tracker.snapshot(input.latencyTier),
    });
    const composedText = gatePolicy === 'full_gate'
      ? anchorRequestedAnswerSubject(input)
      : responseText;
    const outputGuard = gatePolicy === 'full_gate'
      ? enforceSupportedResponseLanguageContract(composedText, contract)
      : { text: composedText, contract, trip: null };
    const finalText = outputGuard.text;
    const guardedFallbackPolicy = outputGuard.trip
      ? applyChatFallbackPolicy(outputGuard.contract)
      : null;
    const finalContract = guardedFallbackPolicy?.contract ?? outputGuard.contract;
    return {
      text: finalText,
      contract: finalContract,
      metadata: {
        ...(input.existingMetadata ?? {}),
        type: (input.existingMetadata?.type as string | undefined) ?? 'nexus_answer',
        chatReasoning: finalContract,
        responseQuality: {
          status: 'blocked',
          issues: [
            'answer_contract_build_failed',
            ...(outputGuard.trip ? ['response_locale_mismatch'] : []),
          ],
          score: 0.2,
        },
        ...(outputGuard.trip ? { responseLanguageGuard: outputGuard.trip } : {}),
        ...(guardedFallbackPolicy ? { fallbackPolicy: guardedFallbackPolicy.policy } : {}),
        responseLanguage: buildResponseLanguageTelemetry(input.locale, finalText),
      },
    };
  }
}

// ─── Envelope-level finalizer (the single terminal pipeline) ───────

export interface FinalizeChatMessageResponseContext {
  normalizedText: string;
  userId: number;
  tenantId: number;
  chatRequestId: string;
  tracker: ChatLatencyTracker;
  latencyTier: Parameters<ChatLatencyTracker['snapshot']>[0];
  fallbackDomain?: any;
  fallbackRouteMethod?: string;
  fallbackConfidence?: number;
  actionability?: NexusChatActionability;
  verificationStatus?: NexusChatVerificationStatus;
  compositionMode?: NexusAnswerCompositionMode;
  groundingFacts?: NexusGroundingFact[];
  locale?: string | null;
  fallback?: Partial<NexusAnswerContract['fallback']>;
  routingDecision?: ReturnType<typeof analyzeChatSkillOrchestration>;
  /** Stage family for gate policy resolution. Unknown → full gate. */
  stageFamily?: string;
  /** Request start (ms epoch) — see FinalizeChatAnswerMetadataInput. */
  requestStartedAt?: number;
}

export function finalizeChatMessageResponse<T extends {
  text: string;
  domain?: any;
  routeMethod?: string;
  confidence?: number;
  metadata?: unknown;
  responseBlocks?: ChatResponseBlock[];
}>(response: T, input: FinalizeChatMessageResponseContext): T {
  const resolvedRouteMethod = response.routeMethod ?? input.fallbackRouteMethod ?? 'deterministic';
  const gatePolicy = resolveChatFinalizerGatePolicy({
    stageFamily: input.stageFamily,
    routeMethod: resolvedRouteMethod,
  });
  if (gatePolicy === 'passthrough') {
    // Replay/planner envelopes are already finalized — byte-identical return.
    return response;
  }
  const existingMetadata = response.metadata && typeof response.metadata === 'object'
    ? response.metadata as Record<string, unknown>
    : null;
  const enriched = finalizeChatAnswerMetadata({
    normalizedText: input.normalizedText,
    responseText: response.text,
    userId: input.userId,
    tenantId: input.tenantId,
    chatRequestId: input.chatRequestId,
    routeMethod: resolvedRouteMethod,
    domain: response.domain ?? input.fallbackDomain ?? 'chat',
    confidence: response.confidence ?? input.fallbackConfidence ?? 1,
    tracker: input.tracker,
    latencyTier: input.latencyTier,
    existingMetadata,
    routingDecision: input.routingDecision,
    groundingFacts: input.groundingFacts,
    actionability: input.actionability,
    verificationStatus: input.verificationStatus,
    compositionMode: input.compositionMode,
    locale: input.locale,
    fallback: input.fallback,
    stageFamily: input.stageFamily,
    requestStartedAt: input.requestStartedAt,
  });
  // Phase 16 batch 85 (2026-05-17): always emit responseBlocks alongside
  // text. The action-planner path already populates it; this branch fills
  // it for LLM domain handlers, fast-path, identity, and shortcut
  // responses that produce text without going through buildActionResponse.
  // We respect a caller-provided value if present (action planner emits it
  // already with planner-specific structure).
  //
  // Adversarial-review fix (2026-07): when the finalized text DIFFERS from
  // the incoming text (quality-gate trip, composition change), caller-built
  // blocks describe text the user will never see — REBUILD them from the
  // final text so blocks and text can never disagree. Identical text keeps
  // the caller's richer block structure.
  const responseBlocks = enriched.text === response.text
    ? response.responseBlocks ?? buildBlocksFromMarkdown(enriched.text)
    : buildBlocksFromMarkdown(enriched.text);
  return {
    ...response,
    text: enriched.text,
    metadata: enriched.metadata,
    responseBlocks,
  } as T;
}
