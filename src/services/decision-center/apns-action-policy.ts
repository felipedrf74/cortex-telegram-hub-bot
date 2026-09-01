// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Pure APNs action policy. The caller must perform an exact, scoped fetch and
 * pass its result here; this module performs no reads, writes, or delivery.
 */

export type DecisionApnsActionRisk = 'low' | 'medium' | 'high';

export interface DecisionApnsActionRequest {
  readonly decisionId: string;
  readonly actionId: string;
  readonly userId: number;
  readonly tenantId: number;
  readonly recordVersion: number | null;
  readonly contextVersion: string | null;
}

export interface DecisionApnsCurrentAction {
  readonly actionId: string;
  readonly riskLevel: DecisionApnsActionRisk;
  readonly reviewRequired: boolean;
  readonly executable: boolean;
}

export interface DecisionApnsExactCurrentState {
  readonly fetchKind: 'exact_current_state';
  readonly status: 'found';
  readonly fetchedAt: string;
  readonly decisionId: string;
  readonly userId: number;
  readonly tenantId: number;
  readonly recordVersion: number | null;
  readonly contextVersion: string | null;
  readonly actions: readonly DecisionApnsCurrentAction[];
}

export interface DecisionApnsExactNotFound {
  readonly fetchKind: 'exact_current_state';
  readonly status: 'not_found';
  readonly fetchedAt: string;
  readonly decisionId: string;
  readonly userId: number;
  readonly tenantId: number;
}

export type DecisionApnsExactFetchResult =
  | DecisionApnsExactCurrentState
  | DecisionApnsExactNotFound;

export type DecisionApnsActionPolicyReasonCode =
  | 'exact_fetch_required'
  | 'decision_not_found'
  | 'scope_mismatch'
  | 'decision_mismatch'
  | 'request_record_version_missing'
  | 'request_context_version_missing'
  | 'current_record_version_missing'
  | 'current_context_version_missing'
  | 'record_version_changed'
  | 'context_version_changed'
  | 'action_not_current'
  | 'action_not_executable'
  | 'action_review_required'
  | 'action_risk_not_low'
  | 'execute_low_risk_current_action';

export interface DecisionApnsActionPolicyDecision {
  readonly disposition: 'execute' | 'open_app';
  readonly execute: boolean;
  readonly reasonCode: DecisionApnsActionPolicyReasonCode;
  readonly decisionId: string;
  readonly actionId: string;
  readonly recordVersion: number | null;
  readonly contextVersion: string | null;
}

/**
 * Only an exact, current, low-risk action with matching non-null versions may
 * execute from APNs. Every uncertain or review-bearing case opens the app.
 */
export function evaluateDecisionApnsActionPolicy(input: {
  readonly request: DecisionApnsActionRequest;
  readonly exactCurrentState: DecisionApnsExactFetchResult;
}): DecisionApnsActionPolicyDecision {
  const request = input?.request;
  const exact = input?.exactCurrentState;

  if (!request || !exact || exact.fetchKind !== 'exact_current_state') {
    return openApp(
      request?.decisionId ?? '',
      request?.actionId ?? '',
      request?.recordVersion ?? null,
      request?.contextVersion ?? null,
      'exact_fetch_required',
    );
  }
  if (exact.status === 'not_found') {
    return openApp(request.decisionId, request.actionId, request.recordVersion, request.contextVersion, 'decision_not_found');
  }
  if (exact.userId !== request.userId || exact.tenantId !== request.tenantId) {
    return openApp(request.decisionId, request.actionId, request.recordVersion, request.contextVersion, 'scope_mismatch');
  }
  if (exact.decisionId !== request.decisionId) {
    return openApp(request.decisionId, request.actionId, request.recordVersion, request.contextVersion, 'decision_mismatch');
  }
  if (!isPositiveVersion(request.recordVersion)) {
    return openApp(request.decisionId, request.actionId, request.recordVersion, request.contextVersion, 'request_record_version_missing');
  }
  if (!isNonBlank(request.contextVersion)) {
    return openApp(request.decisionId, request.actionId, request.recordVersion, request.contextVersion, 'request_context_version_missing');
  }
  if (!isPositiveVersion(exact.recordVersion)) {
    return openApp(request.decisionId, request.actionId, request.recordVersion, request.contextVersion, 'current_record_version_missing');
  }
  if (!isNonBlank(exact.contextVersion)) {
    return openApp(request.decisionId, request.actionId, request.recordVersion, request.contextVersion, 'current_context_version_missing');
  }
  if (exact.recordVersion !== request.recordVersion) {
    return openApp(request.decisionId, request.actionId, exact.recordVersion, exact.contextVersion, 'record_version_changed');
  }
  if (exact.contextVersion !== request.contextVersion) {
    return openApp(request.decisionId, request.actionId, exact.recordVersion, exact.contextVersion, 'context_version_changed');
  }

  const currentAction = exact.actions.find((action) => action.actionId === request.actionId);
  if (!currentAction) {
    return openApp(request.decisionId, request.actionId, exact.recordVersion, exact.contextVersion, 'action_not_current');
  }
  if (!currentAction.executable) {
    return openApp(request.decisionId, request.actionId, exact.recordVersion, exact.contextVersion, 'action_not_executable');
  }
  if (currentAction.reviewRequired) {
    return openApp(request.decisionId, request.actionId, exact.recordVersion, exact.contextVersion, 'action_review_required');
  }
  if (currentAction.riskLevel !== 'low') {
    return openApp(request.decisionId, request.actionId, exact.recordVersion, exact.contextVersion, 'action_risk_not_low');
  }

  return Object.freeze({
    disposition: 'execute',
    execute: true,
    reasonCode: 'execute_low_risk_current_action',
    decisionId: request.decisionId,
    actionId: request.actionId,
    recordVersion: exact.recordVersion,
    contextVersion: exact.contextVersion,
  });
}

function openApp(
  decisionId: string,
  actionId: string,
  recordVersion: number | null,
  contextVersion: string | null,
  reasonCode: Exclude<DecisionApnsActionPolicyReasonCode, 'execute_low_risk_current_action'>,
): DecisionApnsActionPolicyDecision {
  return Object.freeze({
    disposition: 'open_app',
    execute: false,
    reasonCode,
    decisionId,
    actionId,
    recordVersion,
    contextVersion,
  });
}

function isPositiveVersion(value: number | null): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isNonBlank(value: string | null): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
