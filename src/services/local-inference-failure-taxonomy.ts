// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { LocalLLMErrorKind } from './local-llm-error';

/**
 * Every LocalLLMError kind is classified here so adding a new provider error
 * cannot silently inherit an arbitrary fair-use policy.
 */
export const LOCAL_LLM_FAIR_USE_ACCOUNTING = {
  capacity_exceeded: 'exempt',
  timeout: 'exempt',
  invalid_json: 'chargeable',
  provider_unhealthy: 'exempt',
  transport_unavailable: 'exempt',
  unsupported_capability: 'exempt',
  model_oom: 'exempt',
  model_missing: 'exempt',
  input_token_overflow: 'chargeable',
} as const satisfies Record<LocalLLMErrorKind, 'exempt' | 'chargeable'>;

const NON_PROVIDER_INFRASTRUCTURE_FAILURE_REASONS = [
  'LOCAL_CAPACITY_BUSY',
  'LOCAL_QUEUE_FULL',
  'LOCAL_QUEUE_DEADLINE',
  'circuit_open',
  'provider_router_unavailable',
  'model_manifest_unavailable',
  'runtime_control_unavailable',
  'manifest_version_changed_requires_reactivation',
  'active_model_digest_changed_requires_reactivation',
  'skill_profile_version_changed_requires_reactivation',
  'runtime_prerequisite_changed_requires_reactivation',
  'environment_hard_kill',
  'PRIVATE_LOCAL_ROUTE_UNAVAILABLE',
  'INFERENCE_EMPTY_OUTPUT',
  'CONTENT_SCRIPT_JOB_LEASE_LOST',
  'CONTENT_SCRIPT_HEARTBEAT_FAILED',
  'CONTENT_SCRIPT_SHUTDOWN_REQUEUE',
  'CONTENT_SCRIPT_CLOUD_GATE_UNAVAILABLE',
  'CONTENT_ENGINE_CLIENT_DISCONNECTED',
  'ACCOUNT_DELETION_IN_PROGRESS',
] as const;

const localLlmInfrastructureFailureReasons = (
  Object.entries(LOCAL_LLM_FAIR_USE_ACCOUNTING) as Array<[
    LocalLLMErrorKind,
    'exempt' | 'chargeable',
  ]>
)
  .filter(([, accounting]) => accounting === 'exempt')
  .map(([kind]) => kind);

export const LOCAL_FAIR_USE_EXEMPT_FAILURE_REASONS: readonly string[] = Object.freeze([
  ...NON_PROVIDER_INFRASTRUCTURE_FAILURE_REASONS,
  ...localLlmInfrastructureFailureReasons,
]);

const localFairUseExemptFailureReasonSet = new Set(LOCAL_FAIR_USE_EXEMPT_FAILURE_REASONS);

export function isLocalFairUseExemptFailureReason(reason: unknown): boolean {
  return typeof reason === 'string' && localFairUseExemptFailureReasonSet.has(reason);
}

export function localInferenceFailureReason(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const reason = (error as { code?: unknown; kind?: unknown }).code
    ?? (error as { kind?: unknown }).kind;
  return typeof reason === 'string' && reason ? reason : null;
}

export type ContentScriptInfrastructureAbortCode =
  | 'CONTENT_SCRIPT_JOB_LEASE_LOST'
  | 'CONTENT_SCRIPT_HEARTBEAT_FAILED'
  | 'CONTENT_SCRIPT_SHUTDOWN_REQUEUE';

export function createContentScriptInfrastructureAbort(
  code: ContentScriptInfrastructureAbortCode,
): Error & { code: ContentScriptInfrastructureAbortCode } {
  return Object.assign(new Error(code.toLowerCase()), {
    name: 'LocalInfrastructureAbortError',
    code,
  });
}
