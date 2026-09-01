// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, expect, it } from 'vitest';
import { buildNormalizedDecisionAction } from '../../src/services/decision-action-contract';
import {
  buildDecisionConflictSummary,
  evaluateDecisionConflicts,
  normalizeConflictComparisonAction,
  normalizeConflictEvaluation,
  type ConflictAuthority,
} from '../../src/services/decision-conflict-evaluator';

function action(input: {
  intent?: string;
  start?: string;
  end?: string;
  contextVersion?: string;
  risk?: 'low' | 'medium' | 'high' | 'critical';
  targetId?: string;
} = {}) {
  const targetId = input.targetId ?? 'agenda_1';
  return buildNormalizedDecisionAction({
    intent: input.intent ?? 'review_calendar_conflict',
    targetEntities: [{ type: 'secretary_agenda_item', id: targetId, version: '1' }],
    affectedResources: [{ type: 'calendar_timeline', id: 'primary' }],
    requestedWindow: {
      start: input.start ?? '2026-07-11T08:00:00.000Z',
      end: input.end ?? '2026-07-11T09:00:00.000Z',
      timezone: 'UTC',
    },
    preconditions: [{ type: 'agenda_version', ref: targetId, expectedVersion: '1', required: true }],
    expectedEffects: [{ type: 'review_required', targetRef: `secretary_agenda_item:${targetId}` }],
    prohibitedEffects: [{ type: 'automatic_calendar_mutation', targetRef: `secretary_agenda_item:${targetId}` }],
    dependencies: [],
    exclusivityKeys: ['calendar_timeline:42'],
    authorizationScope: ['decision_center:read'],
    risk: input.risk ?? 'medium',
    reversibility: 'reversible',
    contextVersion: input.contextVersion ?? 'ctx_v1',
  });
}

function compare(authority: ConflictAuthority = 'approved_commitment') {
  return {
    action: action({ intent: 'preserve_commitment', start: '2026-07-11T08:30:00.000Z', end: '2026-07-11T09:30:00.000Z', targetId: 'event_2' }),
    authority,
    approved: true,
    createdAt: '2026-07-10T12:00:00.000Z',
  } as const;
}

describe('decision-conflict-evaluator', () => {
  it('requires review for a legitimate overlap with an approved commitment', () => {
    const result = evaluateDecisionConflicts({
      candidate: action(),
      existing: [compare()],
      now: new Date('2026-07-10T12:00:00.000Z'),
      authorizationAllowed: true,
      confidence: 'high',
    });

    expect(result.disposition).toBe('needs_confirmation');
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ class: 'time_overlap', severity: 'soft' }),
      expect.objectContaining({ class: 'approved_commitment', severity: 'soft' }),
    ]));
    expect(result.autoResolved).toBe(false);
    expect(result.alternatives.length).toBeGreaterThanOrEqual(2);
  });

  it('hard-blocks higher-authority instructions and deterministic permission/precondition failures', () => {
    const explicit = evaluateDecisionConflicts({
      candidate: action(),
      existing: [compare('explicit_user_instruction')],
      now: new Date('2026-07-10T12:00:00.000Z'),
    });
    expect(explicit.disposition).toBe('block');
    expect(explicit.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ class: 'explicit_instruction', severity: 'hard' }),
    ]));

    const denied = evaluateDecisionConflicts({
      candidate: action(),
      authorizationAllowed: false,
      missingRequiredPreconditions: ['agenda_version'],
      now: new Date('2026-07-10T12:00:00.000Z'),
    });
    expect(denied.disposition).toBe('block');
    expect(denied.reasonCodes).toEqual(expect.arrayContaining([
      'authorization_or_policy_denied',
      'missing_precondition:agenda_version',
    ]));
  });

  it('classifies preference, inferred-goal, unsafe-combination, and concurrent-mutation conflicts', () => {
    const preference = evaluateDecisionConflicts({
      candidate: action(),
      existing: [compare('configured_preference')],
      now: new Date('2026-07-10T12:00:00.000Z'),
    });
    expect(preference.disposition).toBe('needs_confirmation');
    expect(preference.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ class: 'preference_conflict', severity: 'soft' }),
    ]));

    const inferred = evaluateDecisionConflicts({
      candidate: action(),
      existing: [compare('inferred_goal')],
      now: new Date('2026-07-10T12:00:00.000Z'),
    });
    expect(inferred.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ class: 'inferred_goal_conflict', severity: 'soft' }),
    ]));

    const blocked = evaluateDecisionConflicts({
      candidate: action(),
      combinationSafetyAllowed: false,
      activeExecutionExclusivityKeys: ['calendar_timeline:42'],
      now: new Date('2026-07-10T12:00:00.000Z'),
    });
    expect(blocked.disposition).toBe('block');
    expect(blocked.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ class: 'unsafe_combination', severity: 'hard' }),
      expect.objectContaining({ class: 'concurrent_mutation', severity: 'hard' }),
    ]));
  });

  it('supersedes an unapproved older candidate and tightly bounds low-risk auto-resolution', () => {
    const candidate = action({ contextVersion: 'ctx_new' });
    const superseded = evaluateDecisionConflicts({
      candidate,
      existing: [{
        action: action({ contextVersion: 'ctx_old' }),
        authority: 'optimization',
        approved: false,
        createdAt: '2026-07-10T11:00:00.000Z',
      }],
      now: new Date('2026-07-10T12:00:00.000Z'),
    });
    expect(superseded.disposition).toBe('supersede');
    expect(superseded.findings[0]).toMatchObject({ class: 'supersedes' });

    const olderReplay = evaluateDecisionConflicts({
      candidate: action({ contextVersion: 'ctx_replayed_old' }),
      candidateCreatedAt: '2026-07-10T10:00:00.000Z',
      existing: [{
        action: action({ contextVersion: 'ctx_existing_new' }),
        authority: 'optimization',
        approved: false,
        decisionId: 'decision-newer',
        createdAt: '2026-07-10T11:00:00.000Z',
      }],
      now: new Date('2026-07-10T12:00:00.000Z'),
    });
    expect(olderReplay.disposition).toBe('suppress_duplicate');
    expect(olderReplay.winnerDecisionId).toBe('decision-newer');

    const lowRisk = action({ risk: 'low' });
    const competing = buildNormalizedDecisionAction({
      ...lowRisk,
      targetEntities: [{ type: 'secretary_agenda_item', id: 'agenda_2', version: '1' }],
      requestedWindow: undefined,
      preconditions: [],
      contextVersion: 'ctx_competing',
    });
    expect(evaluateDecisionConflicts({
      candidate: lowRisk,
      existing: [{ action: competing, authority: 'optimization', approved: false, createdAt: '2026-07-10T11:00:00.000Z' }],
      allowLowRiskAutoResolution: true,
      now: new Date('2026-07-10T12:00:00.000Z'),
    }).disposition).toBe('auto_resolve');
    expect(evaluateDecisionConflicts({
      candidate: action({ risk: 'high' }),
      existing: [{ action: competing, authority: 'optimization', approved: false, createdAt: '2026-07-10T11:00:00.000Z' }],
      allowLowRiskAutoResolution: true,
      now: new Date('2026-07-10T12:00:00.000Z'),
    }).disposition).not.toBe('auto_resolve');
  });

  it('treats a shared semantic exclusivity key as a conflict even across non-overlapping windows', () => {
    const result = evaluateDecisionConflicts({
      candidate: action({ start: '2026-07-11T08:00:00.000Z', end: '2026-07-11T09:00:00.000Z' }),
      existing: [{
        action: action({ start: '2026-07-12T08:00:00.000Z', end: '2026-07-12T09:00:00.000Z', targetId: 'agenda_2' }),
        authority: 'optimization',
        approved: false,
        createdAt: '2026-07-10T12:00:00.000Z',
      }],
      now: new Date('2026-07-10T12:00:00.000Z'),
    });

    expect(result.disposition).toBe('needs_confirmation');
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ class: 'resource_competition', reasonCode: 'shared_exclusivity_key' }),
    ]));
  });

  it('does not lexically order opaque entity versions and validates persisted comparisons', () => {
    const candidate = buildNormalizedDecisionAction({
      ...action({ intent: 'move_candidate' }),
      targetEntities: [{ type: 'calendar_event', id: 'shared', version: 'hmac:evidence:entity:ffffffffffffffffffffffffffffffff' }],
      requestedWindow: undefined,
      contextVersion: 'ctx_candidate',
    });
    const existingAction = buildNormalizedDecisionAction({
      ...action({ intent: 'preserve_existing' }),
      targetEntities: [{ type: 'calendar_event', id: 'shared', version: 'hmac:evidence:entity:00000000000000000000000000000000' }],
      requestedWindow: undefined,
      contextVersion: 'ctx_existing',
    });
    const comparison = {
      action: existingAction,
      decisionId: 'decision-a',
      authority: 'optimization' as const,
      approved: false,
      createdAt: '2026-07-10T12:00:00.000Z',
    };
    const result = evaluateDecisionConflicts({
      candidate,
      candidateDecisionId: 'decision-z',
      candidateCreatedAt: comparison.createdAt,
      existing: [comparison],
      now: new Date('2026-07-10T12:00:00.000Z'),
    });

    expect(result.winnerDecisionId).toBe('decision-a');
    expect(normalizeConflictComparisonAction(JSON.parse(JSON.stringify(comparison)))).toEqual(comparison);
    expect(normalizeConflictComparisonAction({
      ...comparison,
      action: { ...existingAction, logicalActionHash: 'tampered' },
    })).toBeNull();
  });

  it('suppresses exact logical duplicates and rejects stale non-low-risk actions', () => {
    const candidate = action();
    expect(evaluateDecisionConflicts({
      candidate,
      existing: [{ action: candidate, authority: 'optimization', approved: false, createdAt: '2026-07-10T12:00:00.000Z' }],
      now: new Date('2026-07-10T12:00:00.000Z'),
    }).disposition).toBe('suppress_duplicate');

    expect(evaluateDecisionConflicts({
      candidate,
      now: new Date('2026-07-12T12:00:00.000Z'),
    }).disposition).toBe('stale');
  });

  it('records an explainable confirmation requirement for low-confidence high-impact candidates', () => {
    const result = evaluateDecisionConflicts({
      candidate: action({ risk: 'high' }),
      confidence: 'low',
      now: new Date('2026-07-10T12:00:00.000Z'),
    });

    expect(result.disposition).toBe('needs_confirmation');
    expect(result.findings).toContainEqual(expect.objectContaining({
      class: 'low_confidence_high_impact',
      severity: 'soft',
      reasonCode: 'low_confidence_high_impact_requires_review',
    }));
    expect(result.reasonCodes).toContain('low_confidence_high_impact_requires_review');
  });

  it('allows an inherently irreversible action only after current strong confirmation', () => {
    const irreversible = buildNormalizedDecisionAction({
      ...action({ risk: 'high' }),
      reversibility: 'irreversible',
      contextVersion: 'ctx_irreversible',
    });

    expect(evaluateDecisionConflicts({
      candidate: irreversible,
      authorizationAllowed: true,
      entityVersionsMatch: true,
      now: new Date('2026-07-10T12:00:00.000Z'),
    }).disposition).toBe('needs_confirmation');
    expect(evaluateDecisionConflicts({
      candidate: irreversible,
      authorizationAllowed: true,
      entityVersionsMatch: true,
      confirmationApproved: true,
      now: new Date('2026-07-10T12:00:00.000Z'),
    }).disposition).toBe('allow');
  });

  it('uses deterministic authority, approval, freshness, risk, reversibility, and stable-id tie-breaks', () => {
    const candidate = action({ risk: 'low', contextVersion: 'ctx_new' });
    const result = evaluateDecisionConflicts({
      candidate,
      candidateAuthority: 'optimization',
      candidateDecisionId: 'decision-z',
      candidateCreatedAt: '2026-07-10T12:00:00.000Z',
      existing: [{
        action: action({ risk: 'medium', contextVersion: 'ctx_old', targetId: 'agenda_2' }),
        authority: 'explicit_user_instruction',
        approved: true,
        decisionId: 'decision-a',
        createdAt: '2026-07-09T12:00:00.000Z',
        updatedAt: '2026-07-09T13:00:00.000Z',
      }],
      now: new Date('2026-07-10T12:00:00.000Z'),
    });

    expect(result.disposition).toBe('block');
    expect(result.winnerDecisionId).toBe('decision-a');
    expect(result.precedenceTrace).toEqual(expect.arrayContaining([
      'authority:explicit_user_instruction',
      'approved_wins',
      'stable_id:decision-a',
    ]));
  });

  it('normalizes persisted evaluations and produces fixed privacy-safe user copy', () => {
    const result = evaluateDecisionConflicts({
      candidate: action(),
      existing: [compare()],
      now: new Date('2026-07-10T12:00:00.000Z'),
    });
    const normalized = normalizeConflictEvaluation(JSON.parse(JSON.stringify(result)));
    const summary = buildDecisionConflictSummary(normalized, 'en-US');

    expect(normalized).toEqual(result);
    expect(summary).toMatchObject({
      disposition: 'needs_confirmation',
      severity: 'soft',
      requiresConfirmation: true,
      blocking: false,
      contextVersion: 'ctx_v1',
    });
    expect(JSON.stringify(summary)).not.toContain('agenda_1');
    expect(summary?.explanation).toContain('will not change either one automatically');
  });
});
