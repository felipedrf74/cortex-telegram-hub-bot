// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type Database from 'better-sqlite3';
import { logger } from '../utils/logger';
import { getDb } from './database';
import { buildLocalInferenceSummary } from './local-inference-reporting';
import {
  getLocalInferenceRuntimeControl,
  setLocalInferenceRuntimeControl,
} from './local-inference-runtime-control';
import { localPrimaryInferenceConfig } from './local-primary-config';
import { getOwnerBootstrapTarget } from './user-service';
import { listRecentCriticalLocalInferenceSafetyIncidents } from './local-inference-safety-incidents';

let monitor: ReturnType<typeof setInterval> | null = null;

function resolveRollbackAuditActorId(
  db: Database.Database,
  environment: 'staging' | 'production',
): number | null {
  const owner = getOwnerBootstrapTarget();
  const ownerTenantId = owner?.tenantId;
  if (Number.isSafeInteger(ownerTenantId) && Number(ownerTenantId) > 0) {
    return Number(ownerTenantId);
  }
  try {
    const row = db.prepare(`SELECT updated_by FROM local_inference_runtime_control
      WHERE environment = ?`).get(environment) as { updated_by?: number } | undefined;
    const durableActorId = row?.updated_by;
    if (Number.isSafeInteger(durableActorId) && Number(durableActorId) > 0) {
      logger.warn(
        { environment },
        'Local inference auto-rollback reused the durable last-authorized actor because owner bootstrap was unavailable',
      );
      return Number(durableActorId);
    }
  } catch { /* the explicit failure below remains authoritative */ }
  return null;
}

export function evaluateLocalInferenceRollback(
  db: Database.Database = getDb(),
): { rolledBack: boolean; reasons: string[] } {
  if (!localPrimaryInferenceConfig.autoRollbackEnabled) return { rolledBack: false, reasons: [] };
  const control = getLocalInferenceRuntimeControl(db);
  const durableControl = db.prepare(`SELECT mode FROM local_inference_runtime_control
    WHERE environment = ?`).get(control.environment) as { mode?: string } | undefined;
  if (durableControl?.mode !== 'canary' && durableControl?.mode !== 'active') {
    return { rolledBack: false, reasons: [] };
  }
  const summary = buildLocalInferenceSummary(24, db);
  const reasons: string[] = [];
  if (!summary.host.manifestAvailable) {
    reasons.push('model_manifest_unavailable');
  } else if (!summary.host.manifestVersionMatchesControl) {
    reasons.push('model_manifest_version_changed');
  } else if (!summary.host.modelDigestMatchesControl) {
    reasons.push('active_model_digest_changed');
  } else if (!summary.host.profileVersionMatchesControl) {
    reasons.push('skill_profile_version_changed');
  }
  if (summary.pricingProof.profileVersionObservationCount > 0
      && !summary.pricingProof.profileVersionStablePass) {
    reasons.push('skill_profile_version_changed');
  }
  if (summary.pricingProof.modelDigestObservationCount > 0
      && !summary.pricingProof.modelDigestStablePass) {
    reasons.push('model_digest_changed');
  }
  if (summary.host.memoryHeadroomPass === false) {
    reasons.push(`host_memory_available_${summary.host.memoryAvailableBytes ?? 0}bytes`);
  }
  if (summary.host.zeroSwapPass === false) {
    reasons.push(`host_swap_used_${summary.host.swapUsedBytes ?? 0}bytes`);
  }
  if (summary.nonAiApiLatency.currentSampleCount >= 20
      && summary.nonAiApiLatency.regressionPercent != null
      && summary.nonAiApiLatency.regressionPercent > 5) {
    reasons.push(`non_ai_api_p95_regression_${summary.nonAiApiLatency.regressionPercent}pct`);
  }
  if (summary.endUserApiErrors.currentSampleCount >= 20
      && summary.endUserApiErrors.regressionPercentagePoints != null
      && summary.endUserApiErrors.regressionPercentagePoints > 0.5) {
    reasons.push(`end_user_api_error_regression_${summary.endUserApiErrors.regressionPercentagePoints}pp`);
  }
  const meaningfulLocalWindow = summary.operations.localRoutingDecisions >= 20;
  if (meaningfulLocalWindow
      && summary.operations.localSuccessPercent != null
      && summary.operations.localSuccessPercent < 95) {
    reasons.push(`local_success_${summary.operations.localSuccessPercent.toFixed(2)}pct`);
  }
  if (meaningfulLocalWindow
      && summary.operations.eligibleFallbackPercent != null
      && summary.operations.eligibleFallbackPercent > 15) {
    reasons.push(`eligible_fallback_${summary.operations.eligibleFallbackPercent.toFixed(2)}pct`);
  }
  if (summary.operations.cloudFallbackReliabilityAttempts >= 20
      && summary.operations.cloudFallbackSuccessPercent != null
      && summary.operations.cloudFallbackSuccessPercent < 99) {
    reasons.push(`cloud_fallback_success_${summary.operations.cloudFallbackSuccessPercent.toFixed(2)}pct`);
  }
  if (summary.latency.ordinaryChatFirstTokenSampleCount >= 20
      && summary.latency.ordinaryChatFirstTokenP95Ms != null
      && summary.latency.ordinaryChatFirstTokenP95Ms > 12_000) {
    reasons.push(`ordinary_chat_first_token_p95_${summary.latency.ordinaryChatFirstTokenP95Ms}ms`);
  }
  if (summary.latency.ordinaryChatTotalSampleCount >= 20
      && summary.latency.ordinaryChatTotalP95Ms != null
      && summary.latency.ordinaryChatTotalP95Ms > 45_000) {
    reasons.push(`ordinary_chat_total_p95_${summary.latency.ordinaryChatTotalP95Ms}ms`);
  }
  if (summary.latency.scriptThroughputSampleCount >= 20
      && summary.latency.scriptThroughputAverageTokensPerSecond != null
      && summary.latency.scriptThroughputAverageTokensPerSecond < 4) {
    reasons.push(`script_throughput_average_${summary.latency.scriptThroughputAverageTokensPerSecond}tps`);
  }
  if (summary.latency.scriptJobDurationSampleCount >= 20
      && summary.latency.scriptJobP95DurationMs != null
      && summary.latency.scriptJobP95DurationMs > 12 * 60 * 1_000) {
    reasons.push(`script_job_p95_${summary.latency.scriptJobP95DurationMs}ms`);
  }
  if (summary.quality.structuredRuns >= 100
      && summary.quality.schemaValidityPercent != null
      && summary.quality.schemaValidityPercent < 99) {
    reasons.push(`schema_validity_${summary.quality.schemaValidityPercent.toFixed(2)}pct`);
  }
  const safetyIncidents = listRecentCriticalLocalInferenceSafetyIncidents(control.environment, 24, db);
  for (const incident of safetyIncidents) {
    if (incident.count > 0) reasons.push(`safety_incident_${incident.code}`);
  }
  if (reasons.length === 0) return { rolledBack: false, reasons };

  const auditActorId = resolveRollbackAuditActorId(db, control.environment);
  if (!auditActorId) {
    logger.error(
      { reasons },
      'Local inference auto-rollback is disabling routing without a user actor; the system event remains authoritative',
    );
  }
  setLocalInferenceRuntimeControl({
    mode: 'off',
    rolloutPercent: 0,
    reason: `automatic_rollback:${reasons.join(',')}`.slice(0, 240),
    updatedBy: auditActorId,
    actorType: 'system_monitor',
    evidenceReference: `local-inference-summary:${summary.window.startsAt}:${summary.window.generatedAt}`.slice(0, 240),
  }, db);
  logger.error({ reasons, previousMode: durableControl.mode }, 'Local inference automatically rolled back to OFF');
  return { rolledBack: true, reasons };
}

export function startLocalInferenceAutoRollbackMonitor(): void {
  if (monitor || !localPrimaryInferenceConfig.autoRollbackEnabled) return;
  monitor = setInterval(() => {
    try { evaluateLocalInferenceRollback(); } catch (error) {
      logger.error({ errorName: error instanceof Error ? error.name : typeof error }, 'Local inference rollback monitor failed');
    }
  }, 5 * 60 * 1_000);
  monitor.unref?.();
}

export function stopLocalInferenceAutoRollbackMonitor(): void {
  if (!monitor) return;
  clearInterval(monitor);
  monitor = null;
}
