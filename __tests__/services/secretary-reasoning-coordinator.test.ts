// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, expect, it, vi } from 'vitest';
import type { SecretaryContextSnapshot } from '../../src/services/chat-core-v2/secretary-context-snapshot';
import type { SecretaryReasoningCandidate, SecretaryReasoningResult } from '../../src/services/chat-core-v2/secretary-candidate-schema';
import { selectSecretaryReasoningOutcome } from '../../src/services/chat-core-v2/secretary-reasoning-coordinator';

function snapshot(overrides: Partial<SecretaryContextSnapshot> = {}): SecretaryContextSnapshot {
  return {
    schemaVersion: 'secretary_context.v1', snapshotId: 'snapshot_1', contextHash: 'hash_1', contextVersion: 'ctx_1', tenantId: 1, userId: 1,
    observedAt: '2026-07-10T12:00:00.000Z', expiresAt: '2026-07-10T12:10:00.000Z',
    facts: [{
      evidenceId: 'current-turn', category: 'inferred_intent', tenantId: 1, userId: 1, ownerUserId: 1,
      visibilityScope: 'user_private', source: 'current_turn',
      observedAt: '2026-07-10T12:00:00.000Z', freshness: 'fresh', reliability: 'authoritative',
      confidence: 1, critical: true, provenanceReason: 'current request', entityVersion: 'turn-v1',
      permissionRequirements: ['authenticated_user'], sensitivity: 'personal', value: 'What should I do?',
    }],
    sourceHealth: [{ source: 'current_turn', status: 'available', observedAt: '2026-07-10T12:00:00.000Z' }],
    unresolvedQuestions: [],
    entityVersions: { 'current-turn': 'turn-v1' },
    permissionSnapshotVersion: 'perm_1',
    ...overrides,
  };
}

function candidate(overrides: Partial<SecretaryReasoningCandidate> = {}): SecretaryReasoningCandidate {
  return {
    candidateId: 'candidate_1', behavior: 'answer', userFacingText: 'Start with the confirmed deadline.',
    conciseRationale: 'It is the most relevant verified item.', evidenceIds: ['current-turn'], assumptions: [],
    unresolvedQuestions: [],
    factors: {
      relevance: 'direct', confidence: 'high', urgency: 'today', expectedImpact: 'medium', risk: 'low',
      reversibility: 'not_applicable', requiredPermissions: [], requiredApproval: 'none', dependencies: [],
      contextFreshness: 'fresh',
    },
    ...overrides,
  };
}

function reasoning(candidates: SecretaryReasoningCandidate[]): SecretaryReasoningResult {
  return {
    schemaVersion: 'secretary_reasoning.v1', promptVersion: 'secretary_reasoning_prompt.v1',
    snapshotId: 'snapshot_1', contextHash: 'hash_1', candidates,
  };
}

describe('secretary-reasoning-coordinator', () => {
  it('selects deterministically using evidence-derived factors then stable candidate id', () => {
    vi.setSystemTime(new Date('2026-07-10T12:01:00.000Z'));
    const result = selectSecretaryReasoningOutcome(snapshot(), reasoning([
      candidate({ candidateId: 'z', factors: { ...candidate().factors, relevance: 'weak', confidence: 'low' } }),
      candidate({ candidateId: 'b' }),
      candidate({ candidateId: 'a' }),
    ]));
    expect(result.candidateId).toBe('a');
    vi.useRealTimers();
  });

  it('prefers the lower-risk, lower-effort candidate when relevance, confidence, urgency, and value are tied', () => {
    const restrictedAction = candidate({
      candidateId: 'a_restricted',
      behavior: 'decision_center',
      capabilityId: 'finance.payment_or_tax_action_blocked',
      actionDraft: {
        intent: 'review_restricted_action',
        targetEvidenceIds: ['current-turn'],
        expectedEffectCodes: ['manual_review'],
        prohibitedEffectCodes: ['automatic_execution'],
      },
      factors: { ...candidate().factors, expectedImpact: 'high' },
    });
    const directAnswer = candidate({
      candidateId: 'z_answer',
      factors: { ...candidate().factors, expectedImpact: 'medium' },
    });

    const result = selectSecretaryReasoningOutcome(
      snapshot(),
      reasoning([restrictedAction, directAnswer]),
      { phase: 'decision_preview', now: new Date('2026-07-10T12:01:00.000Z') },
    );

    expect(result).toMatchObject({ behavior: 'answer', candidateId: 'z_answer' });
    expect(result.reasonCodes).toEqual(expect.arrayContaining([
      'relevance_direct',
      'confidence_high',
      'expected_value_medium',
      'risk_low',
      'actionability_high',
      'user_effort_none',
      'dependencies_none',
    ]));
  });

  it('ranks an urgent actionable candidate ahead of an otherwise equivalent later candidate', () => {
    const action = (candidateId: string, start: string, end: string) => candidate({
      candidateId,
      behavior: 'decision_center',
      capabilityId: 'secretary.schedule_event_preview',
      actionDraft: {
        intent: 'review_schedule_change',
        targetEvidenceIds: ['current-turn'],
        requestedWindow: { start, end, timezone: 'Europe/Lisbon' },
        expectedEffectCodes: ['calendar_preview'],
        prohibitedEffectCodes: ['automatic_calendar_write'],
      },
      factors: { ...candidate().factors, expectedImpact: 'medium' },
    });

    const result = selectSecretaryReasoningOutcome(snapshot(), reasoning([
      action('a_later', '2026-07-11T15:00:00.000Z', '2026-07-11T16:00:00.000Z'),
      action('z_today', '2026-07-10T15:00:00.000Z', '2026-07-10T16:00:00.000Z'),
    ]), { phase: 'decision_preview', now: new Date('2026-07-10T12:01:00.000Z') });

    expect(result).toMatchObject({ behavior: 'decision_center', candidateId: 'z_today' });
    expect(result.candidate?.factors.urgency).toBe('today');
  });

  it('classifies today in the requested timezone rather than by the UTC date', () => {
    const context = snapshot({ expiresAt: '2026-07-11T23:10:00.000Z' });
    const action = candidate({
      behavior: 'decision_center',
      capabilityId: 'secretary.schedule_event_preview',
      actionDraft: {
        intent: 'review_schedule_change',
        targetEvidenceIds: ['current-turn'],
        requestedWindow: {
          start: '2026-07-11T02:00:00.000Z',
          end: '2026-07-11T03:00:00.000Z',
          timezone: 'America/Los_Angeles',
        },
        expectedEffectCodes: ['calendar_preview'],
        prohibitedEffectCodes: ['automatic_calendar_write'],
      },
    });

    const result = selectSecretaryReasoningOutcome(context, reasoning([action]), {
      phase: 'decision_preview',
      now: new Date('2026-07-10T23:00:00.000Z'),
    });

    expect(result.candidate?.factors.urgency).toBe('today');
  });

  it('does not call a next-local-day window today when its UTC date is unchanged', () => {
    const context = snapshot({ expiresAt: '2026-07-12T00:00:00.000Z' });
    const action = candidate({
      behavior: 'decision_center',
      capabilityId: 'secretary.schedule_event_preview',
      actionDraft: {
        intent: 'review_schedule_change',
        targetEvidenceIds: ['current-turn'],
        requestedWindow: {
          start: '2026-07-11T08:00:00.000Z',
          end: '2026-07-11T09:00:00.000Z',
          timezone: 'America/Los_Angeles',
        },
        expectedEffectCodes: ['calendar_preview'],
        prohibitedEffectCodes: ['automatic_calendar_write'],
      },
    });

    const result = selectSecretaryReasoningOutcome(context, reasoning([action]), {
      phase: 'decision_preview',
      now: new Date('2026-07-11T06:00:00.000Z'),
    });

    expect(result.candidate?.factors.urgency).toBe('later');
  });

  it('suppresses a suggestion whose advisory impact is none', () => {
    const result = selectSecretaryReasoningOutcome(snapshot(), reasoning([
      candidate({
        behavior: 'suggest',
        userFacingText: 'Maybe revisit this later.',
        factors: { ...candidate().factors, expectedImpact: 'none' },
      }),
    ]), { now: new Date('2026-07-10T12:01:00.000Z') });

    expect(result).toMatchObject({ behavior: 'suppress', candidateId: null });
    expect(result.reasonCodes).toContain('low_value_candidate');
  });

  it('suppresses a weak, non-urgent suggestion backed only by inferred context', () => {
    const context = snapshot({
      facts: [{
        ...snapshot().facts[0],
        evidenceId: 'memory-1',
        source: 'shared_memory',
        reliability: 'inferred',
        confidence: 0.6,
        critical: false,
      }],
      sourceHealth: [{ source: 'shared_memory', status: 'available', observedAt: '2026-07-10T12:00:00.000Z' }],
      entityVersions: { 'memory-1': 'memory-v1' },
    });
    const suggestion = candidate({
      behavior: 'suggest',
      evidenceIds: ['memory-1'],
      factors: { ...candidate().factors, expectedImpact: 'low' },
    });

    const result = selectSecretaryReasoningOutcome(context, reasoning([suggestion]), {
      now: new Date('2026-07-10T12:01:00.000Z'),
    });

    expect(result.behavior).toBe('suppress');
    expect(result.reasonCodes).toContain('low_value_candidate');
  });

  it('asks an evidence-bound question instead of selecting an action with unresolved input', () => {
    const action = candidate({
      behavior: 'decision_center',
      capabilityId: 'secretary.schedule_event_preview',
      actionDraft: {
        intent: 'review_schedule_change',
        targetEvidenceIds: ['current-turn'],
        expectedEffectCodes: ['calendar_preview'],
        prohibitedEffectCodes: ['automatic_calendar_write'],
      },
      unresolvedQuestions: [{ question: 'Which calendar item should move?', evidenceIds: ['current-turn'] }],
    });

    const result = selectSecretaryReasoningOutcome(snapshot(), reasoning([action]), {
      phase: 'decision_preview', now: new Date('2026-07-10T12:01:00.000Z'),
    });

    expect(result).toMatchObject({
      behavior: 'clarify',
      userFacingText: 'Which calendar item should move?',
    });
    expect(result.reasonCodes).toContain('candidate_requires_clarification');
  });

  it('suppresses an action whose requested window has already expired', () => {
    const action = candidate({
      behavior: 'decision_center',
      capabilityId: 'secretary.schedule_event_preview',
      actionDraft: {
        intent: 'review_schedule_change',
        targetEvidenceIds: ['current-turn'],
        requestedWindow: {
          start: '2026-07-10T10:00:00.000Z',
          end: '2026-07-10T11:00:00.000Z',
          timezone: 'Europe/Lisbon',
        },
        expectedEffectCodes: ['calendar_preview'],
        prohibitedEffectCodes: ['automatic_calendar_write'],
      },
    });

    const result = selectSecretaryReasoningOutcome(snapshot(), reasoning([action]), {
      phase: 'decision_preview', now: new Date('2026-07-10T12:01:00.000Z'),
    });

    expect(result.reasonCodes).toContain('candidate_window_expired');
    expect(result.behavior).toBe('suppress');
  });

  it('suppresses an action draft that has no declared effect', () => {
    const action = candidate({
      behavior: 'decision_center',
      capabilityId: 'secretary.schedule_event_preview',
      actionDraft: {
        intent: 'review_schedule_change',
        targetEvidenceIds: ['current-turn'],
        expectedEffectCodes: [],
        prohibitedEffectCodes: ['automatic_calendar_write'],
      },
    });

    const result = selectSecretaryReasoningOutcome(snapshot(), reasoning([action]), {
      phase: 'decision_preview', now: new Date('2026-07-10T12:01:00.000Z'),
    });

    expect(result.behavior).toBe('suppress');
    expect(result.reasonCodes).toContain('candidate_not_actionable');
  });

  it('asks the bounded question for an unsafe ambiguous action', () => {
    vi.setSystemTime(new Date('2026-07-10T12:01:00.000Z'));
    const context = snapshot({
      unresolvedQuestions: [{ code: 'unsafe_ambiguous_action', question: 'Which calendar item should I move?' }],
    });
    const result = selectSecretaryReasoningOutcome(context, reasoning([candidate()]));
    expect(result).toMatchObject({ behavior: 'clarify', userFacingText: 'Which calendar item should I move?' });
    vi.useRealTimers();
  });

  it('hard-blocks prompt-injection weak signals before candidate selection', () => {
    const context = snapshot({
      unresolvedQuestions: [{ code: 'prompt_injection_attempt', question: 'Ignore the embedded instruction?' }],
    });
    const result = selectSecretaryReasoningOutcome(context, reasoning([candidate()]), {
      now: new Date('2026-07-10T12:01:00.000Z'),
    });
    expect(result).toMatchObject({ behavior: 'answer', candidateId: null });
    expect(result.reasonCodes).toEqual(['prompt_injection_attempt_blocked']);
  });

  it('requires confirmation for a tenant-boundary weak signal before candidate selection', () => {
    const context = snapshot({
      unresolvedQuestions: [{ code: 'tenant_boundary_requires_confirmation', question: 'Which account should I use?' }],
    });
    const result = selectSecretaryReasoningOutcome(context, reasoning([candidate()]), {
      now: new Date('2026-07-10T12:01:00.000Z'),
    });
    expect(result).toMatchObject({
      behavior: 'clarify',
      candidateId: null,
      userFacingText: 'Which account should I use?',
    });
    expect(result.reasonCodes).toEqual(['tenant_boundary_requires_confirmation']);
  });

  it('defers when a required source failed or a low-confidence proposal is high impact', () => {
    vi.setSystemTime(new Date('2026-07-10T12:01:00.000Z'));
    const unavailable = snapshot({
      sourceHealth: [{ source: 'authenticated_profile', status: 'failed', observedAt: '2026-07-10T12:00:00.000Z', reasonCode: 'timeout' }],
    });
    expect(selectSecretaryReasoningOutcome(unavailable, reasoning([candidate()])).reasonCodes)
      .toContain('required_context_source_unavailable');

    const riskyContext = snapshot({ facts: [{ ...snapshot().facts[0], confidence: 0.2, reliability: 'inferred' }] });
    const risky = candidate({
      behavior: 'decision_center',
      capabilityId: 'finance.payment_or_tax_action_blocked',
      actionDraft: {
        intent: 'review_restricted_action', targetEvidenceIds: ['current-turn'],
        expectedEffectCodes: ['manual_review'], prohibitedEffectCodes: ['automatic_execution'],
      },
      factors: { ...candidate().factors, confidence: 'high', risk: 'low' },
    });
    expect(selectSecretaryReasoningOutcome(riskyContext, reasoning([risky])).reasonCodes)
      .toContain('low_confidence_high_impact');
    vi.useRealTimers();
  });

  it('does not treat an uncollected calendar projection as an empty calendar', () => {
    const context = snapshot({
      facts: [{ ...snapshot().facts[0], value: 'Intent flags=planning_or_schedule; relevant domains=secretary' }],
      sourceHealth: [
        { source: 'daily_context', status: 'available', observedAt: '2026-07-10T12:00:00.000Z' },
        { source: 'calendar', status: 'unknown', observedAt: '2026-07-10T12:00:00.000Z', reasonCode: 'daily_context_projection_absent' },
      ],
    });

    const result = selectSecretaryReasoningOutcome(context, reasoning([candidate()]), {
      now: new Date('2026-07-10T12:01:00.000Z'),
    });
    expect(result.reasonCodes).toContain('required_context_source_unavailable');
  });

  it.each([
    ['mail', 'Do I have unread mail?', 'failed'],
    ['tasks', 'List my pending tasks', 'failed'],
    ['reminders', 'List my reminders', 'unknown'],
    ['garmin', 'Show my Garmin training', 'unknown'],
  ] as const)('defers a direct %s answer when its requested source is unavailable', (source, prompt, status) => {
    const base = snapshot();
    const context = snapshot({
      facts: [{ ...base.facts[0], value: prompt }],
      sourceHealth: [
        ...base.sourceHealth,
        { source, status, observedAt: '2026-07-10T12:00:00.000Z', reasonCode: `${source}_unavailable` },
      ],
    });

    const result = selectSecretaryReasoningOutcome(context, reasoning([candidate()]), {
      now: new Date('2026-07-10T12:01:00.000Z'),
    });

    expect(result.reasonCodes).toContain('required_context_source_unavailable');
  });

  it('answers a verified empty mail state only when the candidate cites that source evidence', () => {
    const base = snapshot();
    const mailFact = {
      ...base.facts[0],
      evidenceId: 'mail-empty',
      category: 'verified_fact' as const,
      source: 'mail' as const,
      sourceRef: 'mail:unread-pressure',
      reliability: 'verified' as const,
      provenanceReason: 'Successful unread-count read returned zero.',
      entityVersion: 'mail-zero-v1',
      permissionRequirements: ['authenticated_user', 'mail:read'],
      value: 'Unread mail pressure: total=0.',
    };
    const context = snapshot({
      facts: [{ ...base.facts[0], value: 'Do I have unread mail?' }, mailFact],
      sourceHealth: [
        ...base.sourceHealth,
        { source: 'mail', status: 'empty', observedAt: '2026-07-10T12:00:00.000Z', reasonCode: 'no_unread_mail' },
      ],
      entityVersions: { ...base.entityVersions, 'mail:unread-pressure': 'mail-zero-v1' },
    });

    const uncited = selectSecretaryReasoningOutcome(context, reasoning([candidate()]), {
      now: new Date('2026-07-10T12:01:00.000Z'),
    });
    expect(uncited.reasonCodes).toContain('required_context_source_unavailable');

    const cited = selectSecretaryReasoningOutcome(context, reasoning([candidate({
      userFacingText: 'You have no unread mail in the connected providers.',
      evidenceIds: ['current-turn', 'mail-empty'],
    })]), { now: new Date('2026-07-10T12:01:00.000Z') });
    expect(cited).toMatchObject({ behavior: 'answer', candidateId: 'candidate_1' });
  });

  it('answers a direct bounded task read with cited task evidence and a deterministic coverage caveat', () => {
    const base = snapshot();
    const context = snapshot({
      facts: [
        { ...base.facts[0], value: 'List my pending tasks' },
        {
          ...base.facts[0], evidenceId: 'task-aggregate', category: 'verified_fact', source: 'tasks',
          sourceRef: 'tasks:pending-aggregate', reliability: 'verified', entityVersion: 'tasks-v1',
          provenanceReason: 'Complete aggregate for a bounded task sample.',
          permissionRequirements: ['authenticated_user', 'tasks:read'],
          value: 'Pending task coverage: total=9; detailed=5; omitted=4.',
        },
      ],
      sourceHealth: [
        ...base.sourceHealth,
        { source: 'tasks', status: 'available', observedAt: '2026-07-10T12:00:00.000Z', reasonCode: 'tasks_result_bounded' },
        { source: 'daily_context', status: 'empty', observedAt: '2026-07-10T12:00:00.000Z', reasonCode: 'daily_context_not_materialized' },
      ],
      entityVersions: { ...base.entityVersions, 'tasks:pending-aggregate': 'tasks-v1' },
    });

    const result = selectSecretaryReasoningOutcome(context, reasoning([candidate({
      userFacingText: 'Here are the highest-priority tasks from the available detail.',
      evidenceIds: ['current-turn', 'task-aggregate'],
    })]), { now: new Date('2026-07-10T12:01:00.000Z') });

    expect(result.behavior).toBe('answer');
    expect(result.reasonCodes).toContain('planning_context_partially_bounded');
    expect(result.candidate?.factors.confidence).toBe('medium');
    expect(result.userFacingText).toContain('some items were outside the detailed view');
  });

  it('never authorizes an action candidate in the read-only phase', () => {
    vi.setSystemTime(new Date('2026-07-10T12:01:00.000Z'));
    const result = selectSecretaryReasoningOutcome(snapshot(), reasoning([
      candidate({
        behavior: 'authorized_execute_request', capabilityId: 'secretary.schedule_event_preview',
        actionDraft: {
          intent: 'schedule_event', targetEvidenceIds: ['current-turn'],
          expectedEffectCodes: ['calendar_preview'], prohibitedEffectCodes: ['automatic_calendar_write'],
        },
      }),
    ]));
    expect(result).toMatchObject({ behavior: 'defer', candidateId: null });
    expect(result.reasonCodes).toContain('behavior_requires_deterministic_action_pipeline');
    vi.useRealTimers();
  });

  it('overwrites model risk, permissions, and approval with capability policy', () => {
    const action = candidate({
      behavior: 'decision_center',
      capabilityId: 'finance.payment_or_tax_action_blocked',
      actionDraft: {
        intent: 'review_restricted_action', targetEvidenceIds: ['current-turn'],
        expectedEffectCodes: ['manual_review'], prohibitedEffectCodes: ['automatic_execution'],
      },
      factors: { ...candidate().factors, risk: 'low', requiredPermissions: [], requiredApproval: 'none' },
    });
    const result = selectSecretaryReasoningOutcome(snapshot(), reasoning([action]), { phase: 'decision_preview', now: new Date('2026-07-10T12:01:00.000Z') });
    expect(result.candidate?.factors).toMatchObject({
      risk: 'critical',
      requiredApproval: 'admin_review',
      requiredPermissions: ['finance:read'],
    });
  });

  it('includes action-target evidence in deterministic freshness and confidence', () => {
    const currentTurn = snapshot().facts[0];
    const context = snapshot({
      facts: [
        currentTurn,
        {
          ...currentTurn,
          evidenceId: 'calendar-target',
          source: 'calendar',
          sourceRef: 'calendar:event:opaque-1',
          freshness: 'unknown',
          reliability: 'inferred',
          confidence: 0.2,
          entityVersion: 'calendar-v1',
          permissionRequirements: ['calendar:read'],
        },
      ],
      sourceHealth: [
        ...snapshot().sourceHealth,
        { source: 'calendar', status: 'available', observedAt: '2026-07-10T12:00:00.000Z' },
      ],
      entityVersions: { 'current-turn': 'turn-v1', 'calendar:event:opaque-1': 'calendar-v1' },
    });
    const action = candidate({
      behavior: 'decision_center',
      capabilityId: 'secretary.schedule_event_preview',
      actionDraft: {
        intent: 'review_schedule_change',
        targetEvidenceIds: ['calendar-target'],
        expectedEffectCodes: ['calendar_preview'],
        prohibitedEffectCodes: ['automatic_calendar_write'],
      },
      evidenceIds: ['current-turn'],
    });

    const result = selectSecretaryReasoningOutcome(context, reasoning([action]), {
      phase: 'decision_preview', now: new Date('2026-07-10T12:01:00.000Z'),
    });

    expect(result.candidate?.factors).toMatchObject({
      confidence: 'low',
      contextFreshness: 'unknown',
      reversibility: 'irreversible',
    });
    expect(result.evidenceIds).toEqual(['calendar-target', 'current-turn']);
  });

  it('includes evidence-backed assumptions in deterministic action confidence', () => {
    const currentTurn = snapshot().facts[0];
    const context = snapshot({
      facts: [
        currentTurn,
        {
          ...currentTurn,
          evidenceId: 'planning-assumption',
          category: 'assumption',
          source: 'conversation_history',
          sourceRef: 'conversation:opaque-1',
          freshness: 'recent',
          reliability: 'inferred',
          confidence: 0.4,
          critical: false,
          entityVersion: 'assumption-v1',
        },
      ],
      sourceHealth: [
        ...snapshot().sourceHealth,
        { source: 'conversation_history', status: 'available', observedAt: '2026-07-10T12:00:00.000Z' },
      ],
      entityVersions: { 'current-turn': 'turn-v1', 'conversation:opaque-1': 'assumption-v1' },
    });
    const action = candidate({
      behavior: 'decision_center',
      capabilityId: 'secretary.schedule_event_preview',
      actionDraft: {
        intent: 'review_schedule_change',
        targetEvidenceIds: ['current-turn'],
        expectedEffectCodes: ['calendar_preview'],
        prohibitedEffectCodes: ['automatic_calendar_write'],
      },
      assumptions: [{ summary: 'The earlier preference still applies.', evidenceIds: ['planning-assumption'] }],
    });

    const result = selectSecretaryReasoningOutcome(context, reasoning([action]), {
      phase: 'decision_preview', now: new Date('2026-07-10T12:01:00.000Z'),
    });

    expect(result.candidate?.factors).toMatchObject({ confidence: 'low', contextFreshness: 'mixed' });
    expect(result.evidenceIds).toEqual(['current-turn', 'planning-assumption']);
  });

  it('requires a matching server authorization envelope before returning an execute request', () => {
    const action = candidate({
      behavior: 'authorized_execute_request',
      capabilityId: 'secretary.schedule_event_preview',
      actionDraft: {
        intent: 'schedule_event', targetEvidenceIds: ['current-turn'],
        expectedEffectCodes: ['calendar_preview'], prohibitedEffectCodes: ['automatic_calendar_write'],
      },
    });
    const withoutEnvelope = selectSecretaryReasoningOutcome(snapshot(), reasoning([action]), {
      phase: 'decision_preview', now: new Date('2026-07-10T12:01:00.000Z'),
    });
    expect(withoutEnvelope.reasonCodes).toContain('authorized_envelope_required');
  });
});
