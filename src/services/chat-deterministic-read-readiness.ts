// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

export const NEXUS_CHAT_DETERMINISTIC_READ_READINESS_VERSION = 'nexus_chat_deterministic_read_readiness.v1';

export type ChatDeterministicReadSurface = 'slash' | 'button' | 'api';

export interface ChatDeterministicReadThresholds {
  minValidResponseRate: number;
  requireZeroTenantUserIsolationViolations: boolean;
  requiredTokenZeroSurfaces: ChatDeterministicReadSurface[];
}

export const DEFAULT_CHAT_DETERMINISTIC_READ_THRESHOLDS: ChatDeterministicReadThresholds = {
  minValidResponseRate: 1,
  requireZeroTenantUserIsolationViolations: true,
  requiredTokenZeroSurfaces: ['slash', 'button', 'api'],
};

export interface ChatDeterministicReadSample {
  sampleId: string;
  responseContractValid: boolean;
  tenantUserIsolationPassed: boolean;
}

export interface ChatTokenZeroSurfaceSample {
  sampleId: string;
  surface: ChatDeterministicReadSurface;
  preserved: boolean;
}

export interface ChatDeterministicReadReadinessInput {
  readSamples: ChatDeterministicReadSample[];
  tokenZeroSamples: ChatTokenZeroSurfaceSample[];
  thresholds?: Partial<ChatDeterministicReadThresholds>;
}

export type ChatDeterministicReadGateId =
  | 'deterministic_read_response_contracts'
  | 'deterministic_read_tenant_user_isolation'
  | 'explicit_token_zero_surfaces_preserved';

export interface ChatDeterministicReadGateResult {
  gateId: ChatDeterministicReadGateId;
  passed: boolean;
  sampleCount: number;
  observed: number;
  threshold: number;
  reasonCode?: string;
}

export interface ChatTokenZeroSurfaceResult {
  surface: ChatDeterministicReadSurface;
  preserved: number;
  total: number;
  passed: boolean;
}

export interface ChatDeterministicReadReadinessResult {
  version: typeof NEXUS_CHAT_DETERMINISTIC_READ_READINESS_VERSION;
  passed: boolean;
  gates: ChatDeterministicReadGateResult[];
  tokenZeroResults: ChatTokenZeroSurfaceResult[];
}

export function evaluateChatDeterministicReadReadiness(
  input: ChatDeterministicReadReadinessInput,
): ChatDeterministicReadReadinessResult {
  const thresholds = mergeThresholds(input.thresholds);
  const tokenZeroResults = thresholds.requiredTokenZeroSurfaces.map((surface) =>
    evaluateTokenZeroSurface(surface, input.tokenZeroSamples),
  );
  const gates: ChatDeterministicReadGateResult[] = [
    evaluateResponseContracts(input.readSamples, thresholds),
    evaluateTenantUserIsolation(input.readSamples, thresholds),
    {
      gateId: 'explicit_token_zero_surfaces_preserved',
      passed: tokenZeroResults.every((surface) => surface.passed),
      sampleCount: input.tokenZeroSamples.length,
      observed: tokenZeroResults.filter((surface) => surface.passed).length,
      threshold: thresholds.requiredTokenZeroSurfaces.length,
      reasonCode: tokenZeroResults.every((surface) => surface.total > 0)
        ? undefined
        : 'missing_required_token_zero_surface_samples',
    },
  ];
  return {
    version: NEXUS_CHAT_DETERMINISTIC_READ_READINESS_VERSION,
    passed: gates.every((gate) => gate.passed),
    gates,
    tokenZeroResults,
  };
}

function mergeThresholds(
  overrides?: Partial<ChatDeterministicReadThresholds>,
): ChatDeterministicReadThresholds {
  return {
    ...DEFAULT_CHAT_DETERMINISTIC_READ_THRESHOLDS,
    ...overrides,
    requiredTokenZeroSurfaces: overrides?.requiredTokenZeroSurfaces
      ?? DEFAULT_CHAT_DETERMINISTIC_READ_THRESHOLDS.requiredTokenZeroSurfaces,
  };
}

function evaluateResponseContracts(
  samples: ChatDeterministicReadSample[],
  thresholds: ChatDeterministicReadThresholds,
): ChatDeterministicReadGateResult {
  const valid = samples.filter((sample) => sample.responseContractValid).length;
  const observed = samples.length > 0 ? valid / samples.length : 0;
  return {
    gateId: 'deterministic_read_response_contracts',
    passed: samples.length > 0 && observed >= thresholds.minValidResponseRate,
    sampleCount: samples.length,
    observed,
    threshold: thresholds.minValidResponseRate,
    reasonCode: samples.length > 0 ? undefined : 'missing_deterministic_read_samples',
  };
}

function evaluateTenantUserIsolation(
  samples: ChatDeterministicReadSample[],
  thresholds: ChatDeterministicReadThresholds,
): ChatDeterministicReadGateResult {
  const violations = samples.filter((sample) => !sample.tenantUserIsolationPassed).length;
  return {
    gateId: 'deterministic_read_tenant_user_isolation',
    passed: samples.length > 0
      && (!thresholds.requireZeroTenantUserIsolationViolations || violations === 0),
    sampleCount: samples.length,
    observed: violations,
    threshold: 0,
    reasonCode: samples.length > 0 ? undefined : 'missing_tenant_user_isolation_samples',
  };
}

function evaluateTokenZeroSurface(
  surface: ChatDeterministicReadSurface,
  samples: ChatTokenZeroSurfaceSample[],
): ChatTokenZeroSurfaceResult {
  const relevant = samples.filter((sample) => sample.surface === surface);
  const preserved = relevant.filter((sample) => sample.preserved).length;
  return {
    surface,
    preserved,
    total: relevant.length,
    passed: relevant.length > 0 && preserved === relevant.length,
  };
}
