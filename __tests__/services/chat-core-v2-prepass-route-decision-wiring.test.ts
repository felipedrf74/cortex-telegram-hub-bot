import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import {
  buildChatCoreV2RouteDecision,
  computeRouteDecisionContextHash,
  type BuildRouteDecisionInput,
} from '../../src/services/chat-core-v2/route-decision';
import { planChatCoreV2ShadowTurn } from '../../src/services/chat-core-v2/shadow-orchestrator';
import { recordChatV2TraceSpan } from '../../src/services/chat-core-v2/trace-recorder';

// A daily-read prompt whose ground-truth capability (tasks.today_summary) the
// deterministic Layer-1 selector is known to surface (see the recall@8 test).
const DAILY_READ = 'what are my tasks today?';

describe('Chat Core v2 prepass wiring into route-decision (WP-01)', () => {
  it('kill-switch parity: prepass off/absent leaves the decision bit-identical (no prepass fields)', () => {
    const input: BuildRouteDecisionInput = {
      intent: 'app_question',
      confidence: 0.96,
      domains: ['tasks'],
      capabilityIds: ['tasks.today_summary'],
    };
    const off = buildChatCoreV2RouteDecision(input);
    expect(off.prepassApplied).toBeUndefined();
    expect(off.prepassCandidateIds).toBeUndefined();
    // Passing a message but mode off must still not run prepass.
    const offWithMessage = buildChatCoreV2RouteDecision({ ...input, message: DAILY_READ });
    expect(offWithMessage).toEqual(off);
  });

  it('does not run prepass when the message is empty/whitespace, even in observe mode', () => {
    const decision = buildChatCoreV2RouteDecision({
      intent: 'app_question',
      confidence: 0.96,
      capabilityIds: ['tasks.today_summary'],
      prepassMode: 'observe',
      message: '   ',
    });
    expect(decision.prepassApplied).toBeUndefined();
  });

  it('observe mode records prepass candidates WITHOUT changing the routing outcome', () => {
    const base: BuildRouteDecisionInput = {
      intent: 'app_question',
      confidence: 0.96,
      domains: ['tasks'],
      capabilityIds: ['tasks.today_summary'],
    };
    const off = buildChatCoreV2RouteDecision(base);
    const observed = buildChatCoreV2RouteDecision({ ...base, prepassMode: 'observe', message: DAILY_READ });

    expect(observed.prepassApplied).toBe(true);
    expect(observed.prepassCandidateIds ?? []).toContain('tasks.today_summary');
    // Observation-only: routing is identical to the off-mode decision.
    expect(observed.selectedCapabilityIds).toEqual(off.selectedCapabilityIds);
    expect(observed.routeMethod).toBe(off.routeMethod);
    expect(observed.primaryDomain).toBe(off.primaryDomain);
    expect(observed.reasonCodes).toEqual(off.reasonCodes);
  });

  it('enforce mode narrows to the intersection and never adds a capability the caller lacked', () => {
    const base: BuildRouteDecisionInput = {
      intent: 'app_question',
      confidence: 0.96,
      domains: ['tasks', 'finance'],
      capabilityIds: ['tasks.today_summary', 'finance.summary'],
    };
    const off = buildChatCoreV2RouteDecision(base);
    const enforced = buildChatCoreV2RouteDecision({ ...base, prepassMode: 'enforce', message: DAILY_READ });

    expect(enforced.prepassApplied).toBe(true);
    // Enforce can only narrow: every selected capability must have been in the
    // caller's original selected set.
    for (const id of enforced.selectedCapabilityIds) {
      expect(off.selectedCapabilityIds).toContain(id);
    }
  });

  it('enforce mode falls back to the caller set when the intersection is empty (never routes on nothing)', () => {
    const base: BuildRouteDecisionInput = {
      intent: 'create_action',
      confidence: 0.9,
      domains: ['tasks'],
      capabilityIds: ['tasks.create'],
    };
    const off = buildChatCoreV2RouteDecision(base);
    const enforced = buildChatCoreV2RouteDecision({
      ...base,
      prepassMode: 'enforce',
      message: 'qwerty zxcvb unrelated gibberish',
    });
    expect(enforced.selectedCapabilityIds).toEqual(off.selectedCapabilityIds);
  });

  // DMV: the shadow orchestrator emits a kind='custom' prepass span that
  // PERSISTS through the real recorder. The pre-fix kind='prepass' would throw
  // at validateTraceSpan, so a green persist here is the actual fix proof.
  it('emits a custom prepass_candidate_selection span that persists via the real recorder', () => {
    const result = planChatCoreV2ShadowTurn({
      turnId: 'turn-prepass-1',
      tenantId: 't1',
      userId: 'u1',
      intent: 'app_question',
      confidence: 0.96,
      domains: ['tasks'],
      capabilityIds: ['tasks.today_summary'],
      message: DAILY_READ,
    });

    const prepassSpan = result.traceSpans.find((span) => span.name === 'prepass_candidate_selection');
    expect(prepassSpan).toBeDefined();
    expect(prepassSpan?.kind).toBe('custom');
    expect(result.routeDecision.prepassApplied).toBe(true);

    const db = new Database(':memory:');
    try {
      const saved = recordChatV2TraceSpan(prepassSpan!, db);
      expect(saved.kind).toBe('custom');
      const row = db
        .prepare("SELECT kind, name FROM chat_v2_trace_spans WHERE name = 'prepass_candidate_selection'")
        .get();
      expect(row).toMatchObject({ kind: 'custom', name: 'prepass_candidate_selection' });
    } finally {
      db.close();
    }
  });
});

describe('computeRouteDecisionContextHash (WP-01)', () => {
  const base: BuildRouteDecisionInput = {
    intent: 'app_question',
    confidence: 0.9,
    domains: ['tasks', 'finance'],
    capabilityIds: ['tasks.today_summary', 'finance.summary'],
    message: 'what are my tasks today?',
  };

  it('is deterministic and shaped as a sha256 hex digest', () => {
    expect(computeRouteDecisionContextHash(base)).toBe(computeRouteDecisionContextHash(base));
    expect(computeRouteDecisionContextHash(base)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('is independent of array ordering and of the classifier confidence', () => {
    const reordered: BuildRouteDecisionInput = {
      ...base,
      domains: ['finance', 'tasks'],
      capabilityIds: ['finance.summary', 'tasks.today_summary'],
      confidence: 0.42,
    };
    expect(computeRouteDecisionContextHash(reordered)).toBe(computeRouteDecisionContextHash(base));
  });

  it('changes when the routing-relevant context changes', () => {
    expect(computeRouteDecisionContextHash({ ...base, message: 'cancel my 3pm meeting' }))
      .not.toBe(computeRouteDecisionContextHash(base));
    expect(computeRouteDecisionContextHash({ ...base, intent: 'create_action' }))
      .not.toBe(computeRouteDecisionContextHash(base));
  });
});
