import { describe, expect, it } from 'vitest';

import { buildNexusAnswerContract, createChatLatencyTracker } from '../../src/services/chat-answer-contract';
import { applyChatFallbackPolicy, resolveChatFallbackPolicy } from '../../src/services/chat-fallback-policy';
import { buildChatGroundingEnvelope } from '../../src/services/chat-grounding-layer';
import { applyChatResponseQualityGate } from '../../src/services/chat-response-quality-gate';
import { getChatSkillCapability, getChatSkillCapabilityRegistry, resolveChatSkillCapability } from '../../src/services/chat-skill-capability-registry';

describe('nexus chat answer contract', () => {
  it('declares broad cross-skill capabilities with verifiers and latency budgets', () => {
    const registry = getChatSkillCapabilityRegistry();
    expect(registry.map((entry) => entry.skill)).toEqual(expect.arrayContaining([
      'secretary',
      'tasks',
      'training',
      'cooking',
      'finance',
      'content',
      'decision_center',
      'connections',
      'notifications',
      'owner_admin',
    ]));

    for (const capability of registry) {
      expect(capability.latencyBudgetMs).toBeGreaterThan(0);
      expect(capability.responseCardType).toBeTruthy();
      if (capability.executableActions.length > 0 && capability.skill !== 'owner_admin') {
        expect(capability.verifier).not.toBe('none');
      }
    }
    expect(getChatSkillCapability('finance').privacyPolicy).toBe('sensitive_redacted');
  });

  it('resolves skill ownership and missing facts for Portuguese calendar writes', () => {
    const grounding = buildChatGroundingEnvelope({
      message: 'Colocar no calendario evento no próximo sábado das 9h às 13h. Volei Lucas.',
      userId: 7,
      tenantId: 7,
      routedDomain: 'secretary',
    });

    expect(grounding.capability.ownerSkill).toBe('secretary');
    expect(grounding.capability.actionability).toBe('execute');
    expect(grounding.missingFacts).toEqual([]);
    expect(grounding.groundingFacts.map((fact) => fact.source)).toEqual(expect.arrayContaining([
      'auth.scope',
      'chat.skill_capability_registry',
    ]));
  });

  it('marks weak grounding as clarification instead of confident state claims', () => {
    const grounding = buildChatGroundingEnvelope({
      message: 'move it',
      userId: 7,
      tenantId: 7,
      routedDomain: 'secretary',
    });

    expect(grounding.missingFacts).toEqual(expect.arrayContaining(['date', 'time', 'title']));
    const contract = buildNexusAnswerContract({
      intent: grounding.capability.intent,
      ownerSkill: grounding.capability.ownerSkill,
      routeMethod: 'context',
      confidence: 0.4,
      groundingFacts: grounding.groundingFacts,
      missingFacts: grounding.missingFacts,
      actionability: 'clarify',
      verificationStatus: 'pending',
    });
    expect(contract.missingFacts).toContain('title');
    expect(contract.actionability).toBe('clarify');
  });

  it('quality gate repairs unverified success claims and blocks hallucinated completion', () => {
    const contract = buildNexusAnswerContract({
      intent: 'secretary.create',
      ownerSkill: 'secretary',
      routeMethod: 'model',
      actionability: 'execute',
      verificationStatus: 'not_required',
      groundingFacts: [],
      missingFacts: [],
      confidence: 0.8,
    });

    const result = applyChatResponseQualityGate({
      text: 'Pronto ✅ Agendei no Google/Outlook.',
      contract,
    });

    expect(result.status).toBe('repaired');
    expect(result.issues).toContain('unverified_success_claim');
    expect(result.contract.verificationStatus).toBe('pending');
    expect(result.contract.missingFacts).toContain('read_back_verification');
    expect(result.text).not.toMatch(/Agendei|✅/);
  });

  it('quality gate strips raw backend/debug details from user-facing text', () => {
    const resolved = resolveChatSkillCapability({
      message: 'explain my training',
      routedDomain: 'triathlon',
    });
    const contract = buildNexusAnswerContract({
      intent: resolved.intent,
      ownerSkill: resolved.ownerSkill,
      routeMethod: 'context',
      actionability: 'answer_only',
      verificationStatus: 'not_required',
      groundingFacts: [{
        statement: 'Training owns this response.',
        source: 'test',
        freshness: 'fresh',
        confidence: 1,
        safeForUser: true,
      }],
    });

    const result = applyChatResponseQualityGate({
      text: 'session_prescription · mp3 says calendar_busy_blocks.',
      contract,
    });

    expect(result.status).toBe('repaired');
    expect(result.text).not.toMatch(/session_prescription|calendar_busy_blocks|mp3/);
  });

  it('quality gate converts unsupported concrete state details into clarification', () => {
    const contract = buildNexusAnswerContract({
      intent: 'secretary.answer',
      ownerSkill: 'secretary',
      routeMethod: 'model',
      actionability: 'answer_only',
      verificationStatus: 'not_required',
      groundingFacts: [{
        statement: 'Secretary owns this response.',
        source: 'chat.skill_capability_registry',
        freshness: 'fresh',
        confidence: 0.9,
        safeForUser: true,
      }],
    });

    const result = applyChatResponseQualityGate({
      text: 'You have a calendar event on 15/05/2026 at 09:30.',
      contract,
    });

    expect(result.status).toBe('repaired');
    expect(result.issues).toContain('unsupported_specific_state_claim');
    expect(result.contract.actionability).toBe('clarify');
    expect(result.contract.missingFacts).toContain('scoped_state_read');
    expect(result.text).toContain('current scoped read');
  });

  it('metadata-backed context sources count as scoped grounding', () => {
    const grounding = buildChatGroundingEnvelope({
      message: 'what tax is due next?',
      userId: 7,
      tenantId: 7,
      routedDomain: 'finance',
      contextSources: [{
        source: 'metadata.finance_tax_snapshot',
        freshness: 'fresh',
        confidence: 0.85,
        reason: 'Backend returned scoped finance tax snapshot metadata.',
      }],
    });
    const contract = buildNexusAnswerContract({
      intent: grounding.capability.intent,
      ownerSkill: grounding.capability.ownerSkill,
      routeMethod: 'finance-state-shortcut',
      actionability: 'answer_only',
      verificationStatus: 'not_required',
      groundingFacts: grounding.groundingFacts,
    });

    const result = applyChatResponseQualityGate({
      text: 'The next tax snapshot is for 2026-03.',
      contract,
    });

    expect(result.status).toBe('pass');
    expect(result.issues).toEqual([]);
  });

  it('records route latency budgets and budget overrun metadata', () => {
    const tracker = createChatLatencyTracker(Date.now() - 900);
    tracker.mark('routed');
    const snapshot = tracker.snapshot('tier1_fast_read', 800);

    expect(snapshot.budgetMs).toBe(800);
    expect(snapshot.budgetExceeded).toBe(true);
    expect(snapshot.stageTimingsMs.routed).toBeGreaterThanOrEqual(800);
  });

  it('fallback policy allows stale read-only answers only with freshness labels', () => {
    const contract = buildNexusAnswerContract({
      intent: 'finance.read',
      ownerSkill: 'finance',
      routeMethod: 'cached',
      actionability: 'answer_only',
      verificationStatus: 'not_required',
      staleness: 'stale',
      fallback: {
        fallbackType: 'cached_read',
        fallbackReason: 'provider_unavailable',
        retryable: true,
        sourceFreshness: 'stale',
      },
    });

    const policy = resolveChatFallbackPolicy(contract);
    expect(policy.operationKind).toBe('read_only_answer');
    expect(policy.fallbackAllowed).toBe(true);
    expect(policy.mayUseCachedData).toBe(true);
    expect(policy.requiresFreshnessLabel).toBe(true);
    expect(policy.mayClaimSuccess).toBe(false);
  });

  it('fallback policy blocks mutating fallback success without verifier', () => {
    const contract = buildNexusAnswerContract({
      intent: 'secretary.create',
      ownerSkill: 'secretary',
      routeMethod: 'model',
      actionability: 'execute',
      verificationStatus: 'pending',
      fallback: {
        fallbackType: 'provider_fallback',
        fallbackReason: 'primary_timeout',
        retryable: true,
      },
    });

    const result = applyChatFallbackPolicy(contract);
    expect(result.issues).toContain('fallback_not_allowed_for_operation');
    expect(result.issues).toContain('success_requires_verifier');
    expect(result.policy.responseMode).toBe('blocked');
    expect(result.contract.actionability).toBe('blocked');
    expect(result.contract.verificationStatus).toBe('blocked');
    expect(result.contract.missingFacts).toContain('verified_mutation_result');
  });
});
