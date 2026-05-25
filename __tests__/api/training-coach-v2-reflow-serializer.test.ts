/**
 * R4 P2 — reflow response serializer tests.
 *
 * Codex caught (R4 P2 #7) that the C6 reflow endpoint built its
 * response shape in two separate branches that had drifted: the
 * happy path emitted `{ ...result, scenario, perActionResults }`,
 * while the idempotency-conflict replay emitted a hand-rolled
 * `{ mode: 'apply', adaptationId, adaptationRevision, alreadyExisted,
 *    mutated, mutatedRows }` — silently dropping `scenario`,
 * `actions`, `perActionResults`, and `sciencePolicyVersion`.
 *
 * These tests pin the new canonical shape and confirm:
 *
 *   - The happy path serializes the full classifier output.
 *   - The replay path emits exactly the SAME keys (with empty
 *     actions/perActionResults and null scenario) so iOS can decode
 *     both branches with one Codable.
 *   - buildReplayReflowResult marks `alreadyExisted: true,
 *     mutated: false, mutatedRows: 0` regardless of input.
 *   - sciencePolicyVersion is required + surfaced on both branches.
 */
import { describe, expect, it } from 'vitest';
import {
  serializeReflowResponse,
  buildReplayReflowResult,
} from '../../src/api/routes/training-coach-v2-reflow-serializer';
import type { ScenarioAssessment } from '../../src/services/coach-kernel/scenario-classifier';
import type { ReflowResult } from '../../src/services/training-week-reflow';

function makeApplyResult(overrides: Partial<ReflowResult> = {}): ReflowResult {
  return {
    mode: 'apply',
    adaptationId: 42,
    adaptationRevision: 3,
    alreadyExisted: false,
    mutated: true,
    mutatedRows: 2,
    ...overrides,
  };
}

function makeScenario(overrides: Partial<ScenarioAssessment> = {}): ScenarioAssessment {
  return {
    primaryScenario: 'travel',
    modifiers: [],
    safetyOverrides: [],
    confidence: 'medium',
    actions: [
      {
        type: 'scale_volume',
        sessionId: 101,
        multiplier: 0.7,
        reasonCode: 'travel_capacity',
      },
    ],
    ...overrides,
  } as ScenarioAssessment;
}

describe('R4 P2 — serializeReflowResponse (happy path)', () => {
  it('exposes mode/adaptationId/adaptationRevision/mutated from result', () => {
    const body = serializeReflowResponse({
      result: makeApplyResult(),
      scenario: makeScenario(),
      perActionResults: [
        { action: { type: 'scale_volume', sessionId: 101, multiplier: 0.7, reasonCode: 'travel_capacity' }, mutatedRows: 1, skipped: false },
      ],
      sciencePolicyVersion: '1.2.3',
    });
    expect(body.mode).toBe('apply');
    expect(body.adaptationId).toBe(42);
    expect(body.adaptationRevision).toBe(3);
    expect(body.alreadyExisted).toBe(false);
    expect(body.mutated).toBe(true);
    expect(body.mutatedRows).toBe(2);
  });

  it('surfaces classifier actions + scenario + sciencePolicyVersion', () => {
    const scenario = makeScenario();
    const body = serializeReflowResponse({
      result: makeApplyResult(),
      scenario,
      perActionResults: [],
      sciencePolicyVersion: '1.2.3',
    });
    expect(body.actions).toEqual(scenario.actions);
    expect(body.scenario).toEqual(scenario);
    expect(body.sciencePolicyVersion).toBe('1.2.3');
  });

  it('preview mode surfaces the same shape minus per-action mutation rows', () => {
    const body = serializeReflowResponse({
      result: makeApplyResult({ mode: 'preview', mutated: false, mutatedRows: 0 }),
      scenario: makeScenario(),
      perActionResults: [],
      sciencePolicyVersion: '1.2.3',
    });
    expect(body.mode).toBe('preview');
    expect(body.mutated).toBe(false);
    expect(body.perActionResults).toEqual([]);
    expect(body.actions.length).toBeGreaterThan(0);
  });

  it('omitting perActionResults yields empty array (never undefined)', () => {
    const body = serializeReflowResponse({
      result: makeApplyResult(),
      scenario: makeScenario(),
      sciencePolicyVersion: '1.2.3',
    });
    expect(body.perActionResults).toEqual([]);
  });

  it('omitting scenario yields null scenario + empty actions', () => {
    const body = serializeReflowResponse({
      result: makeApplyResult(),
      sciencePolicyVersion: '1.2.3',
    });
    expect(body.scenario).toBeNull();
    expect(body.actions).toEqual([]);
  });
});

describe('R4 P2 — buildReplayReflowResult + serialize (idempotency replay)', () => {
  it('always marks alreadyExisted=true and mutated=false', () => {
    const replay = buildReplayReflowResult({ adaptationId: 9, adaptationRevision: 7 });
    expect(replay.alreadyExisted).toBe(true);
    expect(replay.mutated).toBe(false);
    expect(replay.mutatedRows).toBe(0);
    expect(replay.mode).toBe('apply');
  });

  it('carries adaptationId + adaptationRevision through to the response body', () => {
    const body = serializeReflowResponse({
      result: buildReplayReflowResult({ adaptationId: 9, adaptationRevision: 7 }),
      sciencePolicyVersion: '1.2.3',
    });
    expect(body.adaptationId).toBe(9);
    expect(body.adaptationRevision).toBe(7);
    expect(body.alreadyExisted).toBe(true);
    expect(body.mutated).toBe(false);
  });

  it('replay body has the SAME shape as a fresh apply body (regression vs the half-payload bug)', () => {
    const fresh = serializeReflowResponse({
      result: makeApplyResult(),
      scenario: makeScenario(),
      perActionResults: [],
      sciencePolicyVersion: '1.2.3',
    });
    const replay = serializeReflowResponse({
      result: buildReplayReflowResult({ adaptationId: 9, adaptationRevision: 7 }),
      sciencePolicyVersion: '1.2.3',
    });
    // Same key set — iOS can decode both with one Codable.
    expect(new Set(Object.keys(fresh))).toEqual(new Set(Object.keys(replay)));
  });

  it('handles null adaptationRevision (preview-promoted-to-apply replay edge case)', () => {
    const body = serializeReflowResponse({
      result: buildReplayReflowResult({ adaptationId: 9, adaptationRevision: null }),
      sciencePolicyVersion: '1.2.3',
    });
    expect(body.adaptationRevision).toBeNull();
    expect(body.adaptationId).toBe(9);
  });
});

describe('R4 P2 — sciencePolicyVersion is non-optional', () => {
  it('always present on the body (audit invariant)', () => {
    const body = serializeReflowResponse({
      result: makeApplyResult(),
      sciencePolicyVersion: '1.2.3',
    });
    expect(typeof body.sciencePolicyVersion).toBe('string');
    expect(body.sciencePolicyVersion).toBe('1.2.3');
  });
});
