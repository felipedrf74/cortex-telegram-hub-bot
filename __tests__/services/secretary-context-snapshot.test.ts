// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, expect, it } from 'vitest';
import type { ChatPromptContext } from '../../src/services/chat-context-engine';
import { buildSecretaryContextSnapshotFromPromptContext } from '../../src/services/chat-core-v2/secretary-context-snapshot';

function promptContext(): ChatPromptContext {
  return {
    tenantId: 42,
    userId: 42,
    domain: 'secretary',
    intent: {
      relevantDomains: ['secretary'],
      ambiguousFollowUp: false,
      asksWhy: false,
      memoryRecall: false,
      memoryWrite: false,
      correction: false,
      tenantBoundaryMention: false,
      planning: true,
      actionReference: true,
      promptInjectionAttempt: false,
    },
    items: [
      {
        id: 'current-turn', tenantId: 42, userId: 42, ownerUserId: 42, scope: 'user_private',
        source: 'current_turn', content: 'Move my focus block tomorrow.', freshness: 'fresh', confidence: 1,
        relevanceScore: 1, priority: 100, permissionRequirements: ['authenticated_user'], critical: true,
        staleAfter: '2026-07-10T12:10:00.000Z', reason: 'current request',
      },
      {
        id: 'authenticated-user', tenantId: 42, userId: 42, ownerUserId: 42, scope: 'user_private',
        source: 'authenticated_profile', content: 'Authenticated profile is scoped.', freshness: 'fresh', confidence: 1,
        relevanceScore: 1, priority: 99, permissionRequirements: ['authenticated_user'], critical: true,
        staleAfter: '2026-07-10T12:10:00.000Z', reason: 'scope identity',
      },
      {
        id: 'memory-1', tenantId: 42, userId: 42, ownerUserId: 42, scope: 'user_private',
        source: 'shared_memory', content: 'preferred focus window: mornings', freshness: 'recent', confidence: 0.8,
        relevanceScore: 0.8, priority: 80, permissionRequirements: ['authenticated_user'],
        expiresAt: '2026-07-12T12:00:00.000Z', reason: 'preference',
      },
      {
        id: 'shared-decision-secretary', tenantId: 42, userId: 42, ownerUserId: 42, scope: 'user_private',
        source: 'shared_decision_context', content: 'confirmed calendar commitment exists', freshness: 'recent', confidence: 0.9,
        relevanceScore: 0.9, priority: 90, permissionRequirements: ['skill_context_read'],
        staleAfter: '2026-07-10T12:00:30.000Z', reason: 'commitment',
      },
    ],
    sourceDiagnostics: [
      { source: 'current_turn', status: 'available', observedAt: '2026-07-10T12:00:00.000Z' },
      { source: 'authenticated_profile', status: 'available', observedAt: '2026-07-10T12:00:00.000Z' },
      { source: 'shared_memory', status: 'available', observedAt: '2026-07-10T12:00:00.000Z' },
      { source: 'shared_decision_context', status: 'available', observedAt: '2026-07-10T12:00:00.000Z' },
      { source: 'daily_context', status: 'empty', observedAt: '2026-07-10T12:00:00.000Z', reasonCode: 'daily_context_not_materialized' },
    ],
    weakSignals: [],
    block: '',
    budgetChars: 2600,
    usedChars: 100,
  };
}

describe('secretary-context-snapshot', () => {
  it('classifies facts and records empty sources separately from available evidence', () => {
    const snapshot = buildSecretaryContextSnapshotFromPromptContext(promptContext(), {
      now: new Date('2026-07-10T12:00:00.000Z'),
    });

    expect(snapshot.schemaVersion).toBe('secretary_context.v1');
    expect(snapshot.snapshotId).toMatch(/^secretary_snapshot_[a-f0-9]{24}$/);
    expect(snapshot.contextVersion).toBe(`ctx_${snapshot.contextHash.slice(0, 32)}`);
    expect(snapshot.facts.find((fact) => fact.evidenceId === 'current-turn')?.category).toBe('explicit_user_instruction');
    expect(snapshot.facts.find((fact) => fact.evidenceId === 'memory-1')?.category).toBe('preference');
    expect(snapshot.facts.find((fact) => fact.evidenceId === 'shared-decision-secretary')?.category).toBe('existing_commitment');
    expect(snapshot.sourceHealth.find((source) => source.source === 'shared_memory')?.status).toBe('available');
    expect(snapshot.sourceHealth.find((source) => source.source === 'daily_context')?.status).toBe('empty');
    expect(snapshot.expiresAt).toBe('2026-07-10T12:00:30.000Z');
    expect(snapshot.permissionSnapshotVersion).toMatch(/^perm_[a-f0-9]{24}$/);
    expect(snapshot.entityVersions['memory-1']).toMatch(/^evidence_/);
    expect(snapshot.facts[0]).toMatchObject({ tenantId: 42, userId: 42, ownerUserId: 42, visibilityScope: 'user_private' });
  });

  it('preserves explicit source failure and permission-denied diagnostics', () => {
    const snapshot = buildSecretaryContextSnapshotFromPromptContext(promptContext(), {
      now: new Date('2026-07-10T12:00:00.000Z'),
      sourceDiagnostics: [
        { source: 'daily_context', status: 'failed', reasonCode: 'daily_context_timeout' },
        { source: 'shared_memory', status: 'permission_denied', reasonCode: 'memory_scope_denied' },
      ],
    });

    expect(snapshot.sourceHealth).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'daily_context', status: 'failed', reasonCode: 'daily_context_timeout' }),
      expect.objectContaining({ source: 'shared_memory', status: 'permission_denied', reasonCode: 'memory_scope_denied' }),
    ]));
  });

  it.each([
    ['Should I cancel the focus block?', 'inferred_intent'],
    ['Devo cancelar o bloco de foco?', 'inferred_intent'],
    ['Cancel the focus block.', 'explicit_user_instruction'],
    ['Cancela o bloco de foco.', 'explicit_user_instruction'],
  ] as const)('distinguishes an interrogative from an explicit instruction: %s', (content, expectedCategory) => {
    const context = promptContext();
    context.items[0] = { ...context.items[0], content };

    const snapshot = buildSecretaryContextSnapshotFromPromptContext(context, {
      now: new Date('2026-07-10T12:00:00.000Z'),
    });

    expect(snapshot.facts.find((fact) => fact.evidenceId === 'current-turn')?.category).toBe(expectedCategory);
  });

  it.each([
    ['Current user request: "Can you cancel this"\nIntent flags: action_reference', 'inferred_intent'],
    ['Current user request: "Podes cancelar isto"\nIntent flags: action_reference', 'inferred_intent'],
    ['Current user request: "Cancel this now."\nIntent flags: action_reference', 'explicit_user_instruction'],
    ['Current user request: "Cancela isto agora."\nIntent flags: action_reference', 'explicit_user_instruction'],
  ] as const)('classifies production-shaped current-turn evidence: %s', (content, expectedCategory) => {
    const context = promptContext();
    context.items[0] = { ...context.items[0], content };

    const snapshot = buildSecretaryContextSnapshotFromPromptContext(context, {
      now: new Date('2026-07-10T12:00:00.000Z'),
    });

    expect(snapshot.facts.find((fact) => fact.evidenceId === 'current-turn')?.category).toBe(expectedCategory);
  });

  it('does not let already-stale optional evidence expire the whole snapshot', () => {
    const context = promptContext();
    context.items.push({
      id: 'stale-readiness', tenantId: 42, userId: 42, ownerUserId: 42, scope: 'user_private',
      source: 'readiness', content: 'old readiness summary', freshness: 'stale', confidence: 0.4,
      relevanceScore: 0.2, priority: 20, permissionRequirements: ['authenticated_user'],
      staleAfter: '2026-07-10T11:30:00.000Z', reason: 'optional stale evidence',
    });

    const snapshot = buildSecretaryContextSnapshotFromPromptContext(context, {
      now: new Date('2026-07-10T12:00:00.000Z'),
    });

    expect(snapshot.expiresAt).toBe('2026-07-10T12:00:30.000Z');
    expect(snapshot.facts.find((fact) => fact.evidenceId === 'stale-readiness')?.freshness).toBe('stale');
  });

  it('produces a stable hash for the same observation and changes it when evidence changes', () => {
    const now = new Date('2026-07-10T12:00:00.000Z');
    const first = buildSecretaryContextSnapshotFromPromptContext(promptContext(), { now });
    const second = buildSecretaryContextSnapshotFromPromptContext(promptContext(), { now });
    const changed = promptContext();
    changed.items[0] = { ...changed.items[0], content: 'Cancel the focus block tomorrow.' };
    const third = buildSecretaryContextSnapshotFromPromptContext(changed, { now });

    expect(first).toEqual(second);
    expect(first.contextHash).not.toBe(third.contextHash);
  });

  it('keeps contextVersion stable across collection times while snapshotId remains unique', () => {
    const first = buildSecretaryContextSnapshotFromPromptContext(promptContext(), { now: new Date('2026-07-10T12:00:00.000Z') });
    const second = buildSecretaryContextSnapshotFromPromptContext(promptContext(), { now: new Date('2026-07-10T12:00:01.000Z') });
    expect(first.contextVersion).toBe(second.contextVersion);
    expect(first.snapshotId).not.toBe(second.snapshotId);
  });
});
