// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Five-minute, rollout-independent chat-quality regression monitor.
 *
 * This path deliberately does not read ChatV2 activation flags or active
 * tenant ids. It consumes only aggregate readiness artifacts, signed paired
 * behavior evidence, and route/count fallback counters, then writes deduped
 * operator alerts. It never performs model/provider calls.
 */

import type Database from 'better-sqlite3';
import {
  loadChatV2ReadinessReportFromFile,
  validateChatV2ReadinessReportStructure,
} from './chat-quality-dashboard';
import {
  buildChatV2ReadinessAlertInputs,
  selectChatV2ParityFallbackRegressionAlerts,
  type ChatV2CompletionReadinessReportLike,
} from './chatv2-readiness-alerts';
import {
  buildChatV2RetirementBehaviorRegressionAlertInputs,
  buildChatV2RetirementCampaign,
  buildChatV2RetirementFallbackAlertInputs,
} from './chat-route-exit-sampler';
import type {
  RecordOperatorAlertInput,
  RecordOperatorAlertResult,
} from './operator-alerts';

export const CHAT_QUALITY_READINESS_ARTIFACT_MAX_AGE_HOURS = 8 * 24;
const MAX_FUTURE_SKEW_MS = 5 * 60_000;

export interface RunChatQualityRegressionMonitorOptions {
  db?: Database.Database;
  now?: Date;
  /** Explicit report wins; undefined reads the canonical artifact. */
  readinessReport?: ChatV2CompletionReadinessReportLike | null;
  readinessUnavailableReason?: string;
  readinessReportPath?: string;
  recordAlert?: (input: RecordOperatorAlertInput) => RecordOperatorAlertResult;
}

export interface ChatQualityRegressionMonitorResult {
  readinessAvailable: boolean;
  readinessArtifactHealthy: boolean;
  readinessUnavailableReason: string | null;
  readinessHealthAlertCount: number;
  readinessRegressionAlertCount: number;
  behaviorRegressionAlertCount: number;
  fallbackRegressionAlertCount: number;
  recordedAlertCount: number;
}

export async function runChatQualityRegressionMonitor(
  options: RunChatQualityRegressionMonitorOptions = {},
): Promise<ChatQualityRegressionMonitorResult> {
  const db = options.db ?? (await import('./database')).getDb();
  const now = options.now ?? new Date();
  const readiness = options.readinessReport !== undefined
    ? {
      report: options.readinessReport,
      reason: options.readinessReport
        ? null
        : options.readinessUnavailableReason ?? 'no readiness report provided',
    }
    : loadChatV2ReadinessReportFromFile(options.readinessReportPath);

  const readinessHealth = evaluateReadinessArtifactHealth(
    readiness.report,
    readiness.reason,
    now,
  );
  const readinessHealthAlerts = readinessHealth.healthy
    ? []
    : [buildReadinessArtifactHealthAlert(readinessHealth, now)];

  const readinessAlerts = readiness.report && readinessHealth.healthy
    ? selectChatV2ParityFallbackRegressionAlerts(
      buildChatV2ReadinessAlertInputs(readiness.report, {
        source: 'chat_quality_regression_monitor',
        owner: 'ai-quality',
        runbookUrl: 'docs/release/chat-quality-operations.md',
      }),
    )
    : [];
  const campaign = buildChatV2RetirementCampaign(db, { now });
  const generatedAt = now.toISOString();
  const behaviorAlerts = buildChatV2RetirementBehaviorRegressionAlertInputs(campaign, { generatedAt });
  const fallbackAlerts = buildChatV2RetirementFallbackAlertInputs(campaign, { generatedAt });
  const allAlerts = [
    ...readinessHealthAlerts,
    ...readinessAlerts,
    ...behaviorAlerts,
    ...fallbackAlerts,
  ];

  let recordedAlertCount = 0;
  if (allAlerts.length > 0) {
    const recordAlert = options.recordAlert
      ?? (await import('./operator-alerts')).recordOperatorAlert;
    for (const alert of allAlerts) {
      if (recordAlert(alert).ok) recordedAlertCount += 1;
    }
  }

  return {
    readinessAvailable: readiness.report !== null,
    readinessArtifactHealthy: readinessHealth.healthy,
    readinessUnavailableReason: readinessHealth.reason,
    readinessHealthAlertCount: readinessHealthAlerts.length,
    readinessRegressionAlertCount: readinessAlerts.length,
    behaviorRegressionAlertCount: behaviorAlerts.length,
    fallbackRegressionAlertCount: fallbackAlerts.length,
    recordedAlertCount,
  };
}

interface ReadinessArtifactHealth {
  healthy: boolean;
  health: 'healthy' | 'unavailable' | 'invalid' | 'stale';
  reason: string | null;
  generatedAt: string | null;
  ageHours: number | null;
}

function evaluateReadinessArtifactHealth(
  report: ChatV2CompletionReadinessReportLike | null,
  unavailableReason: string | null,
  now: Date,
): ReadinessArtifactHealth {
  if (!report) {
    return {
      healthy: false,
      health: 'unavailable',
      reason: sanitizeReason(unavailableReason ?? 'readiness artifact unavailable'),
      generatedAt: null,
      ageHours: null,
    };
  }
  const structureError = validateChatV2ReadinessReportStructure(report);
  if (structureError) {
    return {
      healthy: false,
      health: 'invalid',
      reason: structureError,
      generatedAt: null,
      ageHours: null,
    };
  }
  const generatedAt = typeof report.generatedAt === 'string' ? report.generatedAt : null;
  const generatedMs = generatedAt ? Date.parse(generatedAt) : Number.NaN;
  if (!Number.isFinite(generatedMs) || generatedMs > now.getTime() + MAX_FUTURE_SKEW_MS) {
    return {
      healthy: false,
      health: 'invalid',
      reason: 'readiness artifact generatedAt is missing, invalid, or in the future',
      generatedAt,
      ageHours: null,
    };
  }
  const ageHours = Number(((now.getTime() - generatedMs) / 3_600_000).toFixed(2));
  if (ageHours > CHAT_QUALITY_READINESS_ARTIFACT_MAX_AGE_HOURS) {
    return {
      healthy: false,
      health: 'stale',
      reason: `readiness artifact is older than ${CHAT_QUALITY_READINESS_ARTIFACT_MAX_AGE_HOURS} hours`,
      generatedAt,
      ageHours,
    };
  }
  return { healthy: true, health: 'healthy', reason: null, generatedAt, ageHours };
}

function buildReadinessArtifactHealthAlert(
  health: Exclude<ReadinessArtifactHealth, { health: 'healthy' }>,
  now: Date,
): RecordOperatorAlertInput {
  return {
    severity: 'warning',
    source: 'chat_quality_regression_monitor',
    dedupeKey: 'chat-quality-regression-monitor:readiness-artifact-health',
    title: 'Chat quality readiness artifact unavailable or stale',
    detail: `The five-minute monitor cannot make current readiness/parity claims: ${health.reason ?? health.health}.`,
    metadata: {
      health: health.health,
      reason: health.reason,
      artifactGeneratedAt: health.generatedAt,
      ageHours: health.ageHours,
      maxAgeHours: CHAT_QUALITY_READINESS_ARTIFACT_MAX_AGE_HOURS,
      monitoredAt: now.toISOString(),
    },
    owner: 'ai-quality',
    suspectedArea: 'chat_quality_readiness_artifact',
    userImpact: 'ChatV2 promotion and route retirement must pause until current readiness evidence is restored.',
    runbookUrl: 'docs/release/chat-quality-operations.md',
  };
}

function sanitizeReason(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 180) || 'readiness artifact unavailable';
}
