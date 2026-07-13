// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SecretaryContextSnapshot } from '../../src/services/chat-core-v2/secretary-context-snapshot';
import type { SecretaryReasoningCandidate } from '../../src/services/chat-core-v2/secretary-candidate-schema';

const mocks = vi.hoisted(() => ({
  revalidate: vi.fn(),
  createDecisionIntent: vi.fn(),
}));

vi.mock('../../src/services/decision-preexecution-revalidator', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/decision-preexecution-revalidator')>(
    '../../src/services/decision-preexecution-revalidator',
  );
  return {
    ...actual,
    revalidateNormalizedDecisionAction: mocks.revalidate,
  };
});
vi.mock('../../src/services/decision-center', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/decision-center')>(
    '../../src/services/decision-center',
  );
  return {
    ...actual,
    createDecisionIntent: mocks.createDecisionIntent,
  };
});

import {
  createSecretaryDecisionPreview,
  mapSecretaryCandidateToNormalizedAction,
} from '../../src/services/chat-core-v2/secretary-decision-preview';

function snapshot(): SecretaryContextSnapshot {
  return {
    schemaVersion: 'secretary_context.v1',
    snapshotId: 'snapshot_1',
    contextHash: 'hash_1',
    contextVersion: 'ctx_1',
    tenantId: 42,
    userId: 7,
    observedAt: '2026-07-10T12:00:00.000Z',
    expiresAt: '2026-07-10T12:10:00.000Z',
    facts: [{
      evidenceId: 'calendar-evidence',
      category: 'existing_commitment',
      tenantId: 42,
      userId: 7,
      ownerUserId: 7,
      visibilityScope: 'user_private',
      source: 'calendar',
      sourceRef: 'calendar:outlook:RAW_EVENT_REFERENCE',
      observedAt: '2026-07-10T12:00:00.000Z',
      freshness: 'fresh',
      reliability: 'verified',
      confidence: 0.95,
      critical: true,
      provenanceReason: 'live scoped read',
      permissionRequirements: ['calendar:read'],
      entityVersion: 'event-version-4',
      sensitivity: 'personal',
      value: 'PRIVATE CALENDAR TITLE and provider body must not enter the action contract',
    }],
    sourceHealth: [{ source: 'calendar', status: 'available', observedAt: '2026-07-10T12:00:00.000Z' }],
    unresolvedQuestions: [],
    entityVersions: { 'calendar:outlook:RAW_EVENT_REFERENCE': 'event-version-4' },
    permissionSnapshotVersion: 'perm_1',
  };
}

function candidate(behavior: 'decision_center' | 'conflict_review' = 'decision_center'): SecretaryReasoningCandidate {
  return {
    candidateId: 'candidate_1',
    behavior,
    capabilityId: 'secretary.schedule_event_preview',
    actionDraft: {
      intent: 'MODEL_AUTHORED_INTENT_MUST_NOT_AUTHORIZE',
      targetEvidenceIds: ['calendar-evidence'],
      requestedWindow: {
        start: '2026-07-10T15:00:00.000Z',
        end: '2026-07-10T16:00:00.000Z',
        timezone: 'UTC',
      },
      expectedEffectCodes: ['MODEL_AUTHORED_EFFECT'],
      prohibitedEffectCodes: [],
    },
    userFacingText: 'Model proposal copy.',
    conciseRationale: 'Model rationale.',
    evidenceIds: ['calendar-evidence'],
    assumptions: [],
    unresolvedQuestions: [],
    factors: {
      relevance: 'direct', confidence: 'high', urgency: 'today', expectedImpact: 'medium', risk: 'low',
      reversibility: 'reversible', requiredPermissions: [], requiredApproval: 'none',
      dependencies: ['capability:secretary.schedule_event_preview'], contextFreshness: 'fresh',
    },
  };
}

function evaluation(disposition: 'allow' | 'block' | 'suppress_duplicate') {
  return {
    schemaVersion: 'decision_conflict_evaluation.v1' as const,
    policyVersion: 'decision_conflict_policy.v1' as const,
    disposition,
    findings: disposition === 'block'
      ? [{ class: 'permission_policy' as const, severity: 'hard' as const, reasonCode: 'authorization_or_policy_denied' }]
      : disposition === 'suppress_duplicate'
        ? [{ class: 'duplicate' as const, severity: 'soft' as const, reasonCode: 'exact_logical_action_duplicate' }]
        : [],
    reasonCodes: disposition === 'allow' ? [] : [disposition === 'block' ? 'authorization_or_policy_denied' : 'exact_logical_action_duplicate'],
    alternatives: [],
    contextVersion: 'ctx_1',
    evaluatedAt: '2026-07-10T12:00:00.000Z',
    autoResolved: false,
    precedenceTrace: [],
  };
}

describe('Secretary Decision Center preview', () => {
  beforeEach(() => {
    vi.stubEnv('CHAT_CORE_V2_DECISION_EVIDENCE_HMAC_SECRET', 'test-secretary-decision-evidence-secret');
    vi.stubEnv('CHAT_CORE_V2_ENABLED', 'true');
    vi.stubEnv('CHAT_CORE_V2_PREVIEWS_ENABLED', 'true');
    vi.clearAllMocks();
    mocks.revalidate.mockReturnValue({
      authorizationAllowed: true,
      missingPermissions: [],
      preconditions: [],
      conflictEvaluation: evaluation('allow'),
      contextSourcesHealthy: true,
      canExecute: true,
    });
    mocks.createDecisionIntent.mockResolvedValue({
      item: { decisionId: 'decision_1' },
      eligibility: { classification: 'decision', reasons: ['requires review'], apnsEligible: false, urgency: 'today' },
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('maps only capability policy and opaque evidence identity into the action contract', () => {
    const action = mapSecretaryCandidateToNormalizedAction({ candidate: candidate(), snapshot: snapshot(), tenantId: 42 });
    const serialized = JSON.stringify(action);

    expect(action.intent).toBe('secretary.schedule_event');
    expect(action.risk).toBe('medium');
    expect(action.reversibility).toBe('irreversible');
    expect(action.authorizationScope).toEqual(['decision_center:read']);
    expect(action.exclusivityKeys).toContain('calendar_timeline:42');
    expect(action.expectedEffects).toEqual([expect.objectContaining({ type: 'review_required' })]);
    expect(action.prohibitedEffects).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'automatic_execution' }),
    ]));
    expect(serialized).not.toContain('PRIVATE CALENDAR TITLE');
    expect(serialized).not.toContain('RAW_EVENT_REFERENCE');
    expect(serialized).not.toContain('MODEL_AUTHORED_INTENT');
    expect(serialized).not.toContain('MODEL_AUTHORED_EFFECT');
  });

  it('fails closed when the dedicated Decision Center evidence HMAC is absent', () => {
    vi.stubEnv('CHAT_CORE_V2_DECISION_EVIDENCE_HMAC_SECRET', '');

    expect(() => mapSecretaryCandidateToNormalizedAction({
      candidate: candidate(), snapshot: snapshot(), tenantId: 42,
    })).toThrow('SECRETARY_DECISION_PREVIEW_HMAC_SECRET_REQUIRED');
  });

  it('creates an in-app-only review item and reports that nothing executed', async () => {
    const result = await createSecretaryDecisionPreview({
      candidate: candidate(), snapshot: snapshot(), userId: 7, tenantId: 42, locale: 'en-US',
      now: new Date('2026-07-10T12:00:00.000Z'),
    });

    expect(result).toMatchObject({ status: 'created', decisionId: 'decision_1' });
    expect(result.userFacingText).toContain('Nothing was executed or changed');
    expect(mocks.createDecisionIntent).toHaveBeenCalledWith(expect.objectContaining({
      userId: 7,
      tenantId: 42,
      sourceSkill: 'secretary',
      type: 'decision_required',
      deliveryPolicy: 'in_app_only',
      requiresUserAction: true,
      expiresAt: '2026-07-10T15:00:00.000Z',
      decisionDeadline: '2026-07-10T15:00:00.000Z',
      actionButtons: [{ id: 'open_detail', label: 'Review proposal', style: 'primary' }],
    }));
    const intent = mocks.createDecisionIntent.mock.calls[0][0];
    expect(intent).not.toHaveProperty('sensitiveBody');
    expect(JSON.stringify(intent)).not.toContain('PRIVATE CALENDAR TITLE');
    expect(JSON.stringify(intent)).not.toContain('RAW_EVENT_REFERENCE');
    expect(intent.expiresAt).not.toBe(snapshot().expiresAt);
  });

  it('persists confidence and references for material assumption evidence', async () => {
    const baseSnapshot = snapshot();
    const context: SecretaryContextSnapshot = {
      ...baseSnapshot,
      facts: [
        ...baseSnapshot.facts,
        {
          ...baseSnapshot.facts[0],
          evidenceId: 'assumption-evidence',
          category: 'assumption',
          source: 'conversation_history',
          sourceRef: 'conversation:opaque-1',
          confidence: 0.2,
          reliability: 'inferred',
          freshness: 'recent',
          entityVersion: 'assumption-version-1',
        },
      ],
      sourceHealth: [
        ...baseSnapshot.sourceHealth,
        { source: 'conversation_history', status: 'available', observedAt: baseSnapshot.observedAt },
      ],
    };
    const proposal = candidate();
    proposal.assumptions = [{ summary: 'An earlier inferred preference still applies.', evidenceIds: ['assumption-evidence'] }];

    await createSecretaryDecisionPreview({
      candidate: proposal,
      snapshot: context,
      userId: 7,
      tenantId: 42,
      locale: 'en-US',
      now: new Date('2026-07-10T12:00:00.000Z'),
    });

    const intent = mocks.createDecisionIntent.mock.calls[0][0];
    expect(intent.decisionContext.evidenceConfidence).toBe(0.2);
    expect(intent.decisionContext.evidenceReferences).toHaveLength(2);
  });

  it('projects a cited negative explicit instruction as a hard authoritative comparison without raw text', async () => {
    const constrained = snapshot();
    constrained.facts = [{
      ...constrained.facts[0],
      category: 'explicit_user_instruction',
      source: 'current_turn',
      sourceRef: 'current-turn',
      value: 'Do not move this commitment automatically.',
      reliability: 'authoritative',
    }];

    await createSecretaryDecisionPreview({
      candidate: candidate('conflict_review'),
      snapshot: constrained,
      userId: 7,
      tenantId: 42,
      locale: 'en-US',
      now: new Date('2026-07-10T12:00:00.000Z'),
    });

    const revalidationInput = mocks.revalidate.mock.calls[0][0];
    expect(revalidationInput.additionalExisting).toEqual([
      expect.objectContaining({
        authority: 'explicit_user_instruction',
        approved: true,
        action: expect.objectContaining({
          prohibitedEffects: [expect.objectContaining({ type: 'review_required' })],
        }),
      }),
    ]);
    expect(JSON.stringify(revalidationInput.additionalExisting)).not.toContain('Do not move');
    const intent = mocks.createDecisionIntent.mock.calls[0][0];
    expect(intent.decisionContext.conflictComparisons).toHaveLength(1);
  });

  it('uses a closed conflict code to project a cited configured preference as review-only', async () => {
    const preferred = snapshot();
    preferred.facts = [{
      ...preferred.facts[0],
      category: 'preference',
      source: 'shared_memory',
      sourceRef: 'memory:opaque-preference',
      value: 'Private preference text',
      reliability: 'advisory',
    }];
    const proposal = candidate('conflict_review');
    proposal.assumptions = [{ summary: 'The preference may conflict.', evidenceIds: ['calendar-evidence'] }];
    proposal.actionDraft!.prohibitedEffectCodes = ['conflicts_with_preference'];

    await createSecretaryDecisionPreview({
      candidate: proposal,
      snapshot: preferred,
      userId: 7,
      tenantId: 42,
      locale: 'en-US',
      now: new Date('2026-07-10T12:00:00.000Z'),
    });

    expect(mocks.revalidate.mock.calls[0][0].additionalExisting).toEqual([
      expect.objectContaining({ authority: 'configured_preference', approved: false }),
    ]);
    expect(JSON.stringify(mocks.revalidate.mock.calls[0][0].additionalExisting)).not.toContain('Private preference text');
  });

  it('suppresses an exact duplicate before persistence', async () => {
    mocks.revalidate.mockReturnValue({
      authorizationAllowed: true, missingPermissions: [], preconditions: [],
      conflictEvaluation: evaluation('suppress_duplicate'), contextSourcesHealthy: true, canExecute: false,
    });
    const result = await createSecretaryDecisionPreview({
      candidate: candidate(), snapshot: snapshot(), userId: 7, tenantId: 42, locale: 'en-US',
    });
    expect(result.status).toBe('suppressed');
    expect(mocks.createDecisionIntent).not.toHaveBeenCalled();
  });

  it('persists a hard conflict as a blocked review item without a mutating action', async () => {
    mocks.revalidate.mockReturnValue({
      authorizationAllowed: false, missingPermissions: ['calendar:read'], preconditions: [],
      conflictEvaluation: evaluation('block'), contextSourcesHealthy: true, canExecute: false,
    });
    const result = await createSecretaryDecisionPreview({
      candidate: candidate('conflict_review'), snapshot: snapshot(), userId: 7, tenantId: 42, locale: 'en-US',
    });
    expect(result.status).toBe('blocked');
    expect(result.userFacingText).toContain('Nothing was executed or changed');
    expect(mocks.createDecisionIntent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'conflict_detected',
      deliveryPolicy: 'in_app_only',
    }));
  });
});
