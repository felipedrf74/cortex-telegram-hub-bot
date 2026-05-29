// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

export type ChatCoreV2FailureMode =
  | 'prepass_recall_miss'
  | 'schema_validation_fail'
  | 'composer_mode_drift'
  | 'plan_repair_loop'
  | 'escalation_rate_to_35b'
  | 'local_queue_saturation'
  | 'background_timeout'
  | 'cloud_allowlist_denial'
  | 'legacy_fallback_rate'
  | 'ollama_daemon_unhealthy';

export interface ChatCoreV2FailureObservabilityRule {
  failureMode: ChatCoreV2FailureMode;
  detection: string;
  loggedWhere: string;
  alertThreshold: string;
}

export type ChatCoreV2FailureObservabilityAction =
  | 'log_only'
  | 'auto_shadow_revert'
  | 'page_operator'
  | 'pin_planner_to_repair_only';

export interface ChatCoreV2FailureObservabilityEvent {
  schemaVersion: 'chat_core_v2_failure_observability_event@1.0.0';
  failureMode: ChatCoreV2FailureMode;
  reasonCode: string;
  action: ChatCoreV2FailureObservabilityAction;
  metricValue?: number;
  threshold: string;
  safeMetadata: Record<string, string | number | boolean>;
  occurredAt: string;
}

export const CHAT_CORE_V2_FAILURE_OBSERVABILITY_MATRIX: ChatCoreV2FailureObservabilityRule[] = [
  {
    failureMode: 'prepass_recall_miss',
    detection: 'planner none_of_these_fit or validation unknown_capability',
    loggedWhere: 'prepass_recall_failures table and structured log',
    alertThreshold: 'rolling 24h recall < 97% per language',
  },
  {
    failureMode: 'schema_validation_fail',
    detection: 'Zod/Ajv invalid after Ollama format enforcement and one repair',
    loggedWhere: 'error_log and format_compliance_fail counter',
    alertThreshold: 'rolling 1h > 2%',
  },
  {
    failureMode: 'composer_mode_drift',
    detection: 'AnswerCompositionMode usage share',
    loggedWhere: 'api_usage tags',
    alertThreshold: 'model_constrained > 35% sustained',
  },
  {
    failureMode: 'legacy_fallback_rate',
    detection: 'reason-coded legacy fallback counter',
    loggedWhere: 'dashboard and structured log',
    alertThreshold: '>= 5% auto-shadow revert; >= 15% pager',
  },
  {
    failureMode: 'ollama_daemon_unhealthy',
    detection: '/health/detailed.providers.ollama.healthy = false',
    loggedWhere: 'health monitor',
    alertThreshold: 'immediate auto-shadow revert',
  },
  {
    failureMode: 'cloud_allowlist_denial',
    detection: 'cloud allowlist packet builder denied with reason',
    loggedWhere: 'structured log and counter by denial reason',
    alertThreshold: '> 10% per day for any single reason',
  },
  {
    failureMode: 'background_timeout',
    detection: 'background job state expired',
    loggedWhere: 'background job queue',
    alertThreshold: '> 5% per day',
  },
  {
    failureMode: 'plan_repair_loop',
    detection: 'repair attempts per turn',
    loggedWhere: 'trace span',
    alertThreshold: 'repair-attempt p95 > 1',
  },
  {
    failureMode: 'escalation_rate_to_35b',
    detection: 'counter per escalation reason',
    loggedWhere: 'trace span and dashboard',
    alertThreshold: '> 25% sustained',
  },
  {
    failureMode: 'local_queue_saturation',
    detection: 'local inference queue exceeds configured queue-fallback threshold',
    loggedWhere: 'trace span and queue fallback decision counter',
    alertThreshold: '> 10% of turns per hour use queue fallback or wait beyond progress threshold',
  },
];

export function buildChatCoreV2FailureObservabilityEvent(input: {
  failureMode: ChatCoreV2FailureMode;
  reasonCode: string;
  metricValue?: number;
  metadata?: Record<string, unknown>;
  occurredAt?: string;
}): ChatCoreV2FailureObservabilityEvent {
  const rule = CHAT_CORE_V2_FAILURE_OBSERVABILITY_MATRIX.find((entry) => entry.failureMode === input.failureMode);
  return {
    schemaVersion: 'chat_core_v2_failure_observability_event@1.0.0',
    failureMode: input.failureMode,
    reasonCode: input.reasonCode,
    action: actionForFailure(input.failureMode, input.metricValue),
    metricValue: Number.isFinite(input.metricValue) ? input.metricValue : undefined,
    threshold: rule?.alertThreshold ?? 'unconfigured',
    safeMetadata: sanitizeFailureMetadata(input.metadata ?? {}),
    occurredAt: input.occurredAt ?? new Date().toISOString(),
  };
}

function actionForFailure(
  failureMode: ChatCoreV2FailureMode,
  metricValue: number | undefined,
): ChatCoreV2FailureObservabilityAction {
  if (failureMode === 'ollama_daemon_unhealthy') return 'auto_shadow_revert';
  if (failureMode === 'legacy_fallback_rate') {
    if ((metricValue ?? 0) >= 0.15) return 'page_operator';
    if ((metricValue ?? 0) >= 0.05) return 'auto_shadow_revert';
  }
  if (failureMode === 'schema_validation_fail' && (metricValue ?? 1) < 0.95) {
    return 'pin_planner_to_repair_only';
  }
  return 'log_only';
}

function sanitizeFailureMetadata(input: Record<string, unknown>): Record<string, string | number | boolean> {
  const output: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(input)) {
    if (Object.keys(output).length >= 12) break;
    if (isSensitiveMetadataKey(key)) continue;
    if (typeof value === 'string') {
      if (!isAllowlistedStringMetadataKey(key)) continue;
      output[key] = value.slice(0, 120);
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      output[key] = value;
    } else if (typeof value === 'boolean') {
      output[key] = value;
    }
  }
  return output;
}

function isSensitiveMetadataKey(key: string): boolean {
  return /(?:message|prompt|raw|content|email|phone|token|secret|context|name|title)/i.test(key);
}

function isAllowlistedStringMetadataKey(key: string): boolean {
  return /^(?:locale|language|domain|capabilityId|actionType|routeMethod|mode|surface|reasonCode|cloudDenialReason)$/i.test(key);
}
