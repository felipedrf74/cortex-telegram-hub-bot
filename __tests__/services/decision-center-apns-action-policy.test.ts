import { describe, expect, it } from 'vitest';
import {
  evaluateDecisionApnsActionPolicy,
  type DecisionApnsActionRequest,
  type DecisionApnsExactCurrentState,
} from '../../src/services/decision-center/apns-action-policy';

const REQUEST: DecisionApnsActionRequest = Object.freeze({
  decisionId: 'dc_1',
  actionId: 'dismiss',
  userId: 7,
  tenantId: 11,
  recordVersion: 3,
  contextVersion: 'ctx_3',
});

function currentState(
  overrides: Partial<DecisionApnsExactCurrentState> = {},
): DecisionApnsExactCurrentState {
  return {
    fetchKind: 'exact_current_state',
    status: 'found',
    fetchedAt: '2026-08-30T09:00:00.000Z',
    decisionId: 'dc_1',
    userId: 7,
    tenantId: 11,
    recordVersion: 3,
    contextVersion: 'ctx_3',
    actions: [{
      actionId: 'dismiss',
      riskLevel: 'low',
      reviewRequired: false,
      executable: true,
    }],
    ...overrides,
  };
}

describe('Decision Center APNs action policy', () => {
  it('allows only an exact current low-risk action with matching versions', () => {
    const state = currentState();
    const decision = evaluateDecisionApnsActionPolicy({ request: REQUEST, exactCurrentState: state });

    expect(decision).toEqual({
      disposition: 'execute',
      execute: true,
      reasonCode: 'execute_low_risk_current_action',
      decisionId: 'dc_1',
      actionId: 'dismiss',
      recordVersion: 3,
      contextVersion: 'ctx_3',
    });
    expect(Object.isFrozen(decision)).toBe(true);
  });

  it.each([
    [{ recordVersion: null }, {}, 'request_record_version_missing'],
    [{ contextVersion: null }, {}, 'request_context_version_missing'],
    [{}, { recordVersion: null }, 'current_record_version_missing'],
    [{}, { contextVersion: null }, 'current_context_version_missing'],
  ] as const)('opens the app when a required version is missing', (requestPatch, statePatch, reasonCode) => {
    const decision = evaluateDecisionApnsActionPolicy({
      request: { ...REQUEST, ...requestPatch },
      exactCurrentState: currentState(statePatch),
    });
    expect(decision).toMatchObject({ disposition: 'open_app', execute: false, reasonCode });
  });

  it.each([
    ['medium', false, true, 'action_risk_not_low'],
    ['high', false, true, 'action_risk_not_low'],
    ['low', true, true, 'action_review_required'],
    ['low', false, false, 'action_not_executable'],
  ] as const)(
    'opens the app for risk=%s review=%s executable=%s',
    (riskLevel, reviewRequired, executable, reasonCode) => {
      const exactCurrentState = currentState({
        actions: [{ actionId: 'dismiss', riskLevel, reviewRequired, executable }],
      });
      expect(evaluateDecisionApnsActionPolicy({ request: REQUEST, exactCurrentState })).toMatchObject({
        disposition: 'open_app',
        execute: false,
        reasonCode,
      });
    },
  );

  it.each([
    [{ recordVersion: 4 }, 'record_version_changed'],
    [{ contextVersion: 'ctx_4' }, 'context_version_changed'],
    [{ actions: [] }, 'action_not_current'],
    [{ userId: 8 }, 'scope_mismatch'],
    [{ tenantId: 12 }, 'scope_mismatch'],
    [{ decisionId: 'dc_other' }, 'decision_mismatch'],
  ] as const)('opens the app when exact current state changed: %s', (patch, reasonCode) => {
    expect(evaluateDecisionApnsActionPolicy({
      request: REQUEST,
      exactCurrentState: currentState(patch),
    })).toMatchObject({ disposition: 'open_app', execute: false, reasonCode });
  });

  it('opens the app for an exact scoped not-found result', () => {
    expect(evaluateDecisionApnsActionPolicy({
      request: REQUEST,
      exactCurrentState: {
        fetchKind: 'exact_current_state',
        status: 'not_found',
        fetchedAt: '2026-08-30T09:00:00.000Z',
        decisionId: 'dc_1',
        userId: 7,
        tenantId: 11,
      },
    })).toMatchObject({ disposition: 'open_app', execute: false, reasonCode: 'decision_not_found' });
  });

  it('fails closed at runtime when the mandatory exact-fetch result is absent', () => {
    expect(evaluateDecisionApnsActionPolicy({
      request: REQUEST,
      exactCurrentState: undefined,
    } as unknown as Parameters<typeof evaluateDecisionApnsActionPolicy>[0])).toMatchObject({
      disposition: 'open_app',
      execute: false,
      reasonCode: 'exact_fetch_required',
    });
  });

  it('is side-effect-free and does not mutate deeply frozen inputs', () => {
    const request = Object.freeze({ ...REQUEST });
    const action = Object.freeze({
      actionId: 'dismiss',
      riskLevel: 'low' as const,
      reviewRequired: false,
      executable: true,
    });
    const exactCurrentState = Object.freeze({
      ...currentState(),
      actions: Object.freeze([action]),
    });
    const before = JSON.stringify({ request, exactCurrentState });

    evaluateDecisionApnsActionPolicy({ request, exactCurrentState });
    expect(JSON.stringify({ request, exactCurrentState })).toBe(before);
  });
});
