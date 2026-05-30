import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';

import {
  resolveChatCoreV2ActivationConfig,
} from '../../src/services/chat-core-v2/activation-flags';
import {
  resolveChatCoreV2ActionGatewayMode,
} from '../../src/services/chat-core-v2/action-gateway';
import {
  COMPOSED_ANSWER_DRAFT_SCHEMA_VERSION,
  validateComposedAnswerDraft,
} from '../../src/services/chat-core-v2/answer-composition';
import {
  evaluateChatCoreV2AutoRevertPolicy,
} from '../../src/services/chat-core-v2/auto-revert-policy';
import {
  buildCloudAllowlistPacket,
  hmacTenantScopedEntityId,
} from '../../src/services/chat-core-v2/cloud-allowlist-packet';
import {
  evaluateContextStaleness,
} from '../../src/services/chat-core-v2/context-staleness-policy';
import {
  buildTurnStateEvent,
  shouldApplyTurnStateEvent,
} from '../../src/services/chat-core-v2/turn-state-events';
import {
  backgroundJobRequiresAbortSignal,
  canTransitionBackgroundJob,
} from '../../src/services/chat-core-v2/background-lifecycle';
import {
  CHAT_CORE_V2_FAILURE_OBSERVABILITY_MATRIX,
  buildChatCoreV2FailureObservabilityEvent,
} from '../../src/services/chat-core-v2/failure-observability';
import {
  CHAT_CORE_V2_GOLDEN_CORPUS_SCHEMA_VERSION,
  validateGoldenCorpus,
} from '../../src/services/chat-core-v2/golden-corpus';
import { CHAT_CORE_V2_GOLDEN_CORPUS_SEED } from '../../src/services/chat-core-v2/golden-corpus-seed';
import {
  CHAT_CORE_V2_MODEL_RESIDENCY_POLICIES,
  resolveChatCoreV2ModelResidencyConfig,
  validateChatCoreV2ModelResidencyConfig,
} from '../../src/services/chat-core-v2/model-residency-policy';
import {
  validateResponseLocalePreservation,
} from '../../src/services/chat-core-v2/locale-preservation-policy';
import {
  validateChatTurnPlanMicroAgainstContext,
} from '../../src/services/chat-core-v2/plan-validator';
import {
  auditPrepassSourceForDeterminism,
  validatePrepassOutputBounds,
} from '../../src/services/chat-core-v2/prepass-contract';
import {
  selectPrepassCandidateCapabilities,
} from '../../src/services/chat-core-v2/prepass-candidate-selection';
import {
  buildPrepassRecallFailureRecord,
} from '../../src/services/chat-core-v2/prepass-miss-log';
import {
  buildPlannerRepairPrompt,
  canAttemptPlannerRepair,
} from '../../src/services/chat-core-v2/planner-repair';
import {
  decidePlannerPromptBudget,
} from '../../src/services/chat-core-v2/prompt-budget';
import {
  requires35BOrBackgroundEscalation,
} from '../../src/services/chat-core-v2/write-risk-policy';
import {
  evaluateWriteSuccessClaim,
} from '../../src/services/chat-core-v2/write-verification-policy';
import {
  type ChatTurnPlanMicro,
  CHAT_TURN_PLAN_MICRO_PROMPT_VERSION,
  CHAT_TURN_PLAN_MICRO_SCHEMA_VERSION,
} from '../../src/services/chat-core-v2/plan-schema';

describe('ChatCoreV2 activation contracts', () => {
  it('keeps the master kill switch authoritative over every other flag', () => {
    const config = resolveChatCoreV2ActivationConfig({
      CHAT_CORE_V2_ORCHESTRATOR_MODE: 'off',
      CHAT_CORE_V2_ALLOWED_SURFACES: 'ios,web',
      CHAT_CORE_V2_ALLOWED_DOMAINS: 'training,cooking,content,finance',
      CHAT_CORE_V2_ALLOW_DETERMINISTIC_READS: 'true',
      CHAT_CORE_V2_ALLOW_WRITE_PREVIEWS: 'true',
      CHAT_CORE_V2_ALLOW_WRITE_EXECUTION: 'true',
      CHAT_CORE_V2_ALLOW_CLOUD_FALLBACK: 'true',
      CHAT_CORE_V2_DISABLE_NL_TOKEN_ZERO: 'true',
      CHAT_CORE_V2_FORCE_CLARIFICATION_ON_PLAN_INVALID: 'true',
      CHAT_CORE_V2_FORCE_EVIDENCE_FOR_FACTUAL_CLAIMS: 'true',
    });

    expect(config.mode).toBe('off');
    expect(config.allowedSurfaces).toEqual([]);
    expect(config.allowedDomains).toEqual([]);
    expect(config.allowDeterministicReads).toBe(false);
    expect(config.allowWritePreviews).toBe(false);
    expect(config.allowWriteExecution).toBe(false);
    expect(config.allowCloudFallback).toBe(false);
    expect(config.disableNaturalLanguageTokenZero).toBe(false);
    expect(config.forceClarificationOnPlanInvalid).toBe(false);
    expect(config.forceEvidenceForFactualClaims).toBe(false);
    expect(resolveChatCoreV2ActionGatewayMode({
      CHAT_CORE_V2_ORCHESTRATOR_MODE: 'off',
      CHAT_CORE_V2_ACTION_GATEWAY_MODE: 'enforce',
      CHAT_CORE_V2_ENABLED: 'true',
      CHAT_CORE_V2_WRITES_ENABLED: 'true',
    } as NodeJS.ProcessEnv)).toBe('off');
  });

  it('builds cloud allowlist packets from positive safe fields only', () => {
    const result = buildCloudAllowlistPacket({
      enabled: true,
      budgetAvailable: true,
      tenantId: 'tenant-a',
      hmacSecret: 'secret-a',
      intent: 'read',
      capabilityId: 'training.session_explain',
      domain: 'training',
      entityRefs: [{ entityType: 'training_session', entityId: 'raw-session-123' }],
      evidenceFingerprints: [' evidence:abc ', 'evidence:abc'],
      locale: 'pt-PT',
      complexityScore: 0.2,
      escalationReason: 'low_confidence',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected allowlist packet');
    expect(JSON.stringify(result.packet)).not.toContain('raw-session-123');
    expect(result.packet.evidenceFingerprints).toEqual(['evidence:abc']);
    expect(result.packet.hmacEntityIds[0]).toEqual(expect.objectContaining({
      entityType: 'training_session',
    }));
    expect(result.packet.hmacEntityIds[0]?.scopedEntityId).toMatch(/^hmac:training_session:[a-f0-9]{32}$/);
  });

  it('uses tenant-scoped HMAC identifiers rather than plain hashes', () => {
    const base = {
      hmacSecret: 'shared-secret',
      entityType: 'task',
      entityId: 'task-42',
    };

    expect(hmacTenantScopedEntityId({ ...base, tenantId: 'tenant-a' }))
      .not.toEqual(hmacTenantScopedEntityId({ ...base, tenantId: 'tenant-b' }));
  });

  it('denies cloud fallback when no safe allowlist context is available', () => {
    const result = buildCloudAllowlistPacket({
      enabled: true,
      budgetAvailable: true,
      tenantId: 'tenant-a',
      hmacSecret: 'secret-a',
      intent: 'answer',
      capabilityId: 'general.help',
      domain: 'content',
      locale: 'en',
      complexityScore: 0.1,
      escalationReason: 'cloud_allowlist_candidate',
    });

    expect(result).toEqual({ ok: false, denialReason: 'insufficient_safe_context_for_cloud' });
  });

  it('rejects supported factual claims without evidence in answer drafts', () => {
    const issues = validateComposedAnswerDraft({
      schemaVersion: COMPOSED_ANSWER_DRAFT_SCHEMA_VERSION,
      mode: 'model_constrained',
      locale: 'en',
      text: 'You have a session today.',
      factualClaims: [{
        claimId: 'claim-1',
        text: 'You have a session today.',
        evidenceIds: [],
        support: 'supported',
      }],
      reasonCodes: [],
    });

    expect(issues).toContain('unsupported_factual_claim');
  });

  it('keeps Class C writes on the 35B/background escalation path', () => {
    expect(requires35BOrBackgroundEscalation({ riskClass: 'A' })).toBe(false);
    expect(requires35BOrBackgroundEscalation({ riskClass: 'B' })).toBe(false);
    expect(requires35BOrBackgroundEscalation({ riskClass: 'C' })).toBe(true);
    expect(requires35BOrBackgroundEscalation({
      riskClass: 'B',
      escalationReasons: ['ambiguous_reference'],
    })).toBe(true);
  });

  it('gives iOS monotonic turn-state events with reconnect-friendly sequencing', () => {
    const event = buildTurnStateEvent({
      turnId: 'turn-1',
      state: 'planning',
      sequenceNumber: 2,
      idempotencyKey: 'turn-1:2',
      displayTextKey: 'chat.turn.planning',
      canCancel: true,
      canResume: true,
      serverTime: '2026-05-27T10:00:00.000Z',
    });

    expect(event.serverTime).toBe('2026-05-27T10:00:00.000Z');
    expect(shouldApplyTurnStateEvent(1, event)).toBe(true);
    expect(shouldApplyTurnStateEvent(2, event)).toBe(false);
  });

  it('models background superseded as terminal and abort-required', () => {
    expect(canTransitionBackgroundJob('running', 'superseded')).toBe(true);
    expect(canTransitionBackgroundJob('superseded', 'running')).toBe(false);
    expect(backgroundJobRequiresAbortSignal('superseded')).toBe(true);
  });

  it('keeps 3B as the only foreground model in the residency policy', () => {
    expect(CHAT_CORE_V2_MODEL_RESIDENCY_POLICIES.filter((policy) => policy.foregroundAllowed))
      .toEqual([expect.objectContaining({ role: 'planner_3b', defaultKeepAlive: '-1' })]);
  });

  it('resolves model residency config without promoting 35B to foreground', () => {
    const resolved = resolveChatCoreV2ModelResidencyConfig({
      OLLAMA_CLASSIFIER_MODEL: 'qwen2.5:3b-instruct-q4_K_M',
      OLLAMA_MODEL: 'qwen3.6:35b-a3b-q4_K_M',
    });

    expect(validateChatCoreV2ModelResidencyConfig(resolved)).toEqual([]);
    expect(resolved).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: 'planner_3b',
        model: 'qwen2.5:3b-instruct-q4_K_M',
        keepAlive: '-1',
        foregroundAllowed: true,
      }),
      expect.objectContaining({
        role: 'escalation_35b',
        model: 'qwen3.6:35b-a3b-q4_K_M',
        keepAlive: '5m',
        foregroundAllowed: false,
      }),
    ]));
  });

  it('keeps failure observability rules wired for auto-shadow revert signals', () => {
    expect(CHAT_CORE_V2_FAILURE_OBSERVABILITY_MATRIX).toEqual(expect.arrayContaining([
      expect.objectContaining({
        failureMode: 'legacy_fallback_rate',
        alertThreshold: expect.stringContaining('auto-shadow revert'),
      }),
      expect.objectContaining({
        failureMode: 'ollama_daemon_unhealthy',
        alertThreshold: expect.stringContaining('auto-shadow revert'),
      }),
    ]));
  });

  it('normalizes failure observability events without raw private metadata', () => {
    const event = buildChatCoreV2FailureObservabilityEvent({
      failureMode: 'legacy_fallback_rate',
      reasonCode: 'legacy_fallback_rate_auto_shadow_threshold',
      metricValue: 0.08,
      occurredAt: '2026-05-28T11:00:00.000Z',
      metadata: {
        locale: 'pt-PT',
        rawMessage: 'mark my private task done',
        userEmail: 'person@example.com',
        debug: 'contains possibly private free text',
        capabilityId: 'tasks.complete',
        cloudDenialReason: 'required_fact_never_cloud',
        legacyFallbackCount: 12,
      },
    });

    expect(event).toMatchObject({
      schemaVersion: 'chat_core_v2_failure_observability_event@1.0.0',
      action: 'auto_shadow_revert',
      threshold: expect.stringContaining('auto-shadow revert'),
      occurredAt: '2026-05-28T11:00:00.000Z',
      safeMetadata: {
        locale: 'pt-PT',
        capabilityId: 'tasks.complete',
        cloudDenialReason: 'required_fact_never_cloud',
        legacyFallbackCount: 12,
      },
    });
    expect(JSON.stringify(event)).not.toContain('private task');
    expect(JSON.stringify(event)).not.toContain('person@example.com');
    expect(JSON.stringify(event)).not.toContain('possibly private');
  });

  it('enforces prepass candidate bounds without making routing decisions', () => {
    expect(validatePrepassOutputBounds({
      prepassVersion: 'chat_core_v2_prepass@0.1.0',
      candidateCapabilityIds: ['clarify_reference', 'unsupported'],
      highRiskSignals: [],
      referenceCandidates: [],
      contextHash: 'ctx-1',
    })).toContain('too_few_candidates');

    expect(validatePrepassOutputBounds({
      prepassVersion: 'chat_core_v2_prepass@0.1.0',
      candidateCapabilityIds: [
        'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i',
      ],
      highRiskSignals: [],
      referenceCandidates: [],
      contextHash: '',
    })).toEqual(expect.arrayContaining(['too_many_candidates', 'missing_context_hash']));
  });

  it('flags non-deterministic prepass source references for CI enforcement', () => {
    expect(auditPrepassSourceForDeterminism(`
      import { getActiveProvider } from '../provider-registry';
      export async function badPrepass() {
        const provider = getActiveProvider();
        await fetch('https://example.com');
        return provider;
      }
    `)).toEqual(expect.arrayContaining([
      'network_call',
      'model_call',
      'llm_provider_reference',
    ]));

    expect(auditPrepassSourceForDeterminism(`
      export function goodPrepass(message: string) {
        return message.includes('today') ? ['tasks.today_summary'] : ['clarify_reference'];
      }
    `)).toEqual([]);
  });

  it('keeps the actual Layer 1 candidate selector free of model and network calls', () => {
    const source = readFileSync('src/services/chat-core-v2/prepass-candidate-selection.ts', 'utf8');

    expect(auditPrepassSourceForDeterminism(source)).toEqual([]);
  });

  it('builds HMAC-only prepass recall failure records', () => {
    const record = buildPrepassRecallFailureRecord({
      hmacSecret: 'secret-a',
      tenantId: 'tenant-a',
      userId: 'user-a',
      message: 'please move my private appointment',
      locale: 'en',
      candidateCapabilityIds: ['tasks.today_summary', 'tasks.today_summary', 'clarify_reference'],
      finalCapabilityId: 'secretary.move_event',
      reasonCodes: ['unknown_capability'],
      metadata: {
        candidateCount: 2,
        hadPendingConfirmation: false,
        unsafe: undefined,
        rawMessage: 'please move my private appointment',
        exactTitle: 'private appointment',
        debug: 'string metadata is not stored',
      },
      createdAt: '2026-05-27T12:00:00.000Z',
    });

    expect(record.messageHash).toMatch(/^[a-f0-9]{64}$/);
    expect(record.tenantHash).toMatch(/^[a-f0-9]{64}$/);
    expect(record.userHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(record)).not.toContain('private appointment');
    expect(JSON.stringify(record)).not.toContain('string metadata');
    expect(record.candidateCapabilityIds).toEqual(['tasks.today_summary', 'clarify_reference']);
    expect(record.metadata).toEqual({ candidateCount: 2, hadPendingConfirmation: false });
  });

  it('validates micro plans against allowed capabilities, evidence, flags, and context hash', () => {
    const plan: ChatTurnPlanMicro = {
      schemaVersion: CHAT_TURN_PLAN_MICRO_SCHEMA_VERSION,
      intent: 'write_preview',
      domains: ['training'],
      capabilityIds: ['training.modify_session_preview', 'unknown.capability'],
      requiredReads: [{ requestId: 'read-1', capabilityId: 'training.session_explain' }],
      proposedWrites: [{ requestId: 'write-1', capabilityId: 'training.modify_session_preview', riskClass: 'B' }],
      evidenceClaimIds: ['evidence:missing'],
      confidence: 0.5,
      complexityScore: 0.6,
      escalationReasons: ['ambiguous_reference', 'cloud_allowlist_candidate'],
      contextHash: 'ctx-old',
      promptVersion: CHAT_TURN_PLAN_MICRO_PROMPT_VERSION,
    };

    const result = validateChatTurnPlanMicroAgainstContext(plan, {
      contextHash: 'ctx-new',
      allowedCapabilityIds: ['training.session_explain', 'training.modify_session_preview'],
      availableEvidenceIds: ['evidence:present'],
      activation: {
        allowWritePreviews: false,
        allowCloudFallback: false,
        forceEvidenceForFactualClaims: true,
      },
      promptTokenCount: 4000,
      promptHardCapTokens: 3000,
    });

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      'unknown_capability',
      'write_not_allowed_in_current_phase',
      'cloud_fallback_not_allowed',
      'missing_grounding',
      'stale_context',
      'ambiguous_reference',
      'budget_exceeded',
    ]));
    expect(result.requiredClarificationReason).toBe('stale_context');
  });

  it('bounds planner repair to one attempt with a compact correction prompt', () => {
    expect(canAttemptPlannerRepair(0)).toBe(true);
    expect(canAttemptPlannerRepair(1)).toBe(false);

    const prompt = buildPlannerRepairPrompt({
      rawModelOutput: 'x'.repeat(1200),
      issues: [{ code: 'missing_required', path: '$.intent', message: 'intent is required' }],
    });

    expect(prompt).toContain('$.intent:missing_required');
    expect(prompt.length).toBeLessThan(1000);
  });

  it('turns prompt hard-cap overflow into clarify/escalate instead of truncating required context', () => {
    expect(decidePlannerPromptBudget(500).decision).toBe('within_budget');
    expect(decidePlannerPromptBudget(2500).decision).toBe('drop_optional_context');
    expect(decidePlannerPromptBudget(3500)).toEqual(expect.objectContaining({
      decision: 'clarify_or_escalate',
      reasonCodes: ['prompt_budget_overflow'],
    }));
  });

  it('requires the golden corpus to be large, multilingual, grounded, and not synthetic-only', () => {
    const issues = validateGoldenCorpus({
      schemaVersion: CHAT_CORE_V2_GOLDEN_CORPUS_SCHEMA_VERSION,
      items: [{
        id: 'seed-1',
        language: 'en',
        message: 'What changed today?',
        expectedDomainIds: ['tasks'],
        expectedCapabilityIds: [],
        forbiddenClaims: ['done without verification'],
        evidenceRequirements: [],
        source: 'regression_seed',
      }],
    });

    expect(issues).toEqual(expect.arrayContaining([
      'too_few_items',
      'missing_language',
      'missing_expected_capability',
      'missing_evidence_requirement',
      'synthetic_only',
    ]));
  });

  it('ships a 200+ item multilingual golden corpus seed with operator-reported failures', () => {
    expect(validateGoldenCorpus(CHAT_CORE_V2_GOLDEN_CORPUS_SEED)).toEqual([]);
    expect(CHAT_CORE_V2_GOLDEN_CORPUS_SEED.items.length).toBeGreaterThanOrEqual(200);
    expect(CHAT_CORE_V2_GOLDEN_CORPUS_SEED.items.some((item) => item.source === 'real_failure')).toBe(true);
    expect(new Set(CHAT_CORE_V2_GOLDEN_CORPUS_SEED.items.map((item) => item.language))).toEqual(new Set([
      'en',
      'pt-BR',
      'pt-PT',
      'mixed',
    ]));
    expect(CHAT_CORE_V2_GOLDEN_CORPUS_SEED.items.some((item) => (
      item.message.includes('comprar suplementos QA LOCAL')
      && item.expectedCapabilityIds.includes('tasks.complete')
    ))).toBe(true);
  });

  it('encodes auto-shadow revert and pager thresholds without mutating env', () => {
    expect(evaluateChatCoreV2AutoRevertPolicy({
      legacyFallbackRate24h: 0.16,
      ollamaHealthy: false,
      schemaComplianceRate1h: 0.94,
      prepassRecallByLanguage: { en: 0.99, 'pt-PT': 0.89 },
    })).toEqual({
      actions: [
        'flip_global_to_shadow',
        'page_operator',
        'pin_planner_to_repair_only',
        'flip_language_to_shadow',
      ],
      affectedLanguages: ['pt-PT'],
      reasonCodes: [
        'ollama_unhealthy',
        'legacy_fallback_rate_pager_threshold',
        'legacy_fallback_rate_auto_shadow_threshold',
        'schema_compliance_below_95',
        'prepass_recall_below_90_for_language',
      ],
    });
  });

  it('demotes a tenant to shadow on a schema-compliance breach (pin alone is inert on the live path until task #14)', () => {
    // A schema breach as the SOLE trigger must still produce a STOP that reaches
    // the live path: flip_global_to_shadow is enforced via the kill-switch seam,
    // whereas pin_planner_to_repair_only has no live consumer yet (deferred
    // enforceAndRepairChatTurnPlanMicro). Without the flip this would be an inert
    // valve recording a mitigation that never happened.
    const decision = evaluateChatCoreV2AutoRevertPolicy({
      legacyFallbackRate24h: 0.0,
      ollamaHealthy: true,
      schemaComplianceRate1h: 0.90,
    });
    expect(decision.actions).toContain('flip_global_to_shadow');
    expect(decision.actions).toContain('pin_planner_to_repair_only');
    expect(decision.reasonCodes).toContain('schema_compliance_below_95');
  });

  it('turns context hash drift into re-read/replan/clarify decisions', () => {
    expect(evaluateContextStaleness({
      plannedContextHash: 'a',
      currentContextHash: 'a',
      writeDependsOnContext: false,
    })).toBe('continue');
    expect(evaluateContextStaleness({
      plannedContextHash: 'a',
      currentContextHash: 'b',
      writeDependsOnContext: true,
    })).toBe('re_read_context');
    expect(evaluateContextStaleness({
      plannedContextHash: 'a',
      currentContextHash: 'b',
      writeDependsOnContext: false,
    })).toBe('replan');
    expect(evaluateContextStaleness({
      plannedContextHash: 'a',
      currentContextHash: 'b',
      writeDependsOnContext: false,
      replanAlreadyUsed: true,
    })).toBe('clarify');
  });

  it('prohibits write success claims without verified readback', () => {
    expect(evaluateWriteSuccessClaim('verified')).toBe('may_claim_verified_success');
    expect(evaluateWriteSuccessClaim('partial')).toBe('must_claim_partial');
    expect(evaluateWriteSuccessClaim('failed')).toBe('must_not_claim_success');
    expect(evaluateWriteSuccessClaim('indeterminate')).toBe('must_not_claim_success');
  });

  it('flags composer locale drift before a ChatCoreV2Response is accepted', () => {
    expect(validateResponseLocalePreservation({
      expectedLocale: 'pt-PT',
      actualLocale: 'pt-PT',
    })).toEqual({
      ok: true,
      expectedLocale: 'pt-PT',
      actualLocale: 'pt-PT',
    });
    expect(validateResponseLocalePreservation({
      expectedLocale: 'pt-BR',
      actualLocale: 'pt-PT',
    })).toEqual({
      ok: false,
      expectedLocale: 'pt-BR',
      actualLocale: 'pt-PT',
      reasonCode: 'composer_locale_mismatch',
    });
  });

  it('selects Layer 1 capability candidates as bounded hints only', () => {
    const result = selectPrepassCandidateCapabilities({
      message: 'Move it to Friday after my training',
      activeThreadCapabilityIds: ['training.session_explain'],
      pendingConfirmationCapabilityId: 'secretary.schedule_event_preview',
      recentDomainCapabilityIds: ['tasks.today_summary'],
    });

    expect(result.candidateCapabilityIds).toContain('secretary.schedule_event_preview');
    expect(result.candidateCapabilityIds).toContain('training.modify_session_preview');
    expect(result.candidateCapabilityIds).toContain('clarify_reference');
    expect(result.candidateCapabilityIds.length).toBeLessThanOrEqual(8);
    expect(result.reasonCodes).toEqual(expect.arrayContaining([
      'pending_confirmation',
      'reschedule_keyword',
      'active_thread_anchor',
      'ambiguous_reference_widened',
    ]));
  });
});
