// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type Database from 'better-sqlite3';
import { getDb } from './database';
import { localInferenceScheduler } from './local-inference-scheduler';
import fs from 'node:fs';
import { getEndUserApiErrorSnapshot, getNonAiLatencySnapshot } from '../api/request-timer';
import { getLocalInferenceRuntimeControl } from './local-inference-runtime-control';
import { tryGetLocalModelManifest } from './ollama-model-policy';
import {
  getSkillInferenceProfile,
  isSkillInferenceSkill,
  profileAllowsRisk,
  SKILL_INFERENCE_PROFILE_VERSION,
  type SkillInferenceExecutionClass,
  type SkillInferenceRiskClass,
} from './skill-inference-profiles';
import {
  CLASSIFIER_SHADOW_JOB_NAME,
  isLongFormScriptDuration,
  LOCAL_PRIMARY_SHADOW_CATEGORY_PREFIX,
  LOCAL_PRIMARY_SHADOW_JOB_NAME,
} from './local-inference-vocabulary';
import { isLocalFairUseExemptFailureReason } from './local-inference-failure-taxonomy';

interface RunMetricRow {
  run_id: string;
  operation_id: string;
  tenant_id: number;
  user_id: number;
  plan_id: string;
  skill_id: string;
  task_type: string;
  evaluation_mode: 'production' | 'shadow';
  risk_class: string;
  execution_class: string;
  schema_id: string | null;
  profile_version: string;
  status: string;
  final_route: string | null;
  fallback_reason: string | null;
  validation_status: string | null;
  queue_wait_ms: number | null;
  first_token_ms: number | null;
  generation_tokens_per_second: number | null;
  duration_ms: number | null;
  created_at: string;
}

interface OperationMetric {
  key: string;
  primary: RunMetricRow;
  runs: RunMetricRow[];
  locallyAttempted: boolean;
  cloudAttempted: boolean;
  automaticCloudFallback: boolean;
  cloudFallbackReliabilityEligible: boolean;
  cloudFallbackSucceeded: boolean;
}

interface AttemptMetricRow {
  run_id: string;
  route: 'local' | 'cloud';
  outcome: 'success' | 'failure' | 'cancelled';
  failure_reason: string | null;
  model_digest: string | null;
}

function groupOperations(rows: RunMetricRow[], attempts: AttemptMetricRow[]): OperationMetric[] {
  const attemptsByRun = new Map<string, AttemptMetricRow[]>();
  for (const attempt of attempts) {
    const current = attemptsByRun.get(attempt.run_id) ?? [];
    current.push(attempt);
    attemptsByRun.set(attempt.run_id, current);
  }

  const grouped = new Map<string, RunMetricRow[]>();
  for (const row of rows) {
    const key = `${row.tenant_id}:${row.user_id}:${row.operation_id}`;
    const current = grouped.get(key) ?? [];
    current.push(row);
    grouped.set(key, current);
  }

  return [...grouped].map(([key, operationRuns]) => {
    // Rows arrive oldest-first. Reusing an operation id is intentionally
    // fair-use neutral, but the newest run is the authoritative visible
    // outcome for reporting and rollback decisions.
    const primary = operationRuns[operationRuns.length - 1]!;
    const operationAttempts = operationRuns.flatMap((run) => attemptsByRun.get(run.run_id) ?? []);
    const locallyAttempted = operationAttempts.some((attempt) => attempt.route === 'local');
    const cloudAttempts = operationAttempts.filter((attempt) => attempt.route === 'cloud');
    const automaticCloudFallback = cloudAttempts.length > 0 && (
      locallyAttempted
      || operationRuns.some((run) => isLocalFairUseExemptFailureReason(run.fallback_reason))
    );
    return {
      key,
      primary,
      runs: operationRuns,
      locallyAttempted,
      cloudAttempted: cloudAttempts.length > 0,
      automaticCloudFallback,
      cloudFallbackReliabilityEligible: automaticCloudFallback
        && cloudAttempts.some((attempt) => attempt.outcome !== 'cancelled'),
      cloudFallbackSucceeded: automaticCloudFallback
        && cloudAttempts.some((attempt) => attempt.outcome === 'success'),
    };
  });
}

function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))]!;
}

function parseSqliteTimestamp(value: string): number {
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/u.test(value)
    ? value
    : `${value.replace(' ', 'T')}Z`;
  return Date.parse(normalized);
}

function rate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? Number(((numerator / denominator) * 100).toFixed(2)) : null;
}

function hasScriptQualityWarnings(raw: string): boolean {
  try {
    const value = JSON.parse(raw) as unknown;
    return !Array.isArray(value)
      || value.some((warning) => typeof warning !== 'string' || warning.trim().length > 0);
  } catch {
    return true;
  }
}

function isLocallyEligibleOperation(row: RunMetricRow): boolean {
  if (!isSkillInferenceSkill(row.skill_id)) return false;
  if (!['low', 'medium', 'high', 'regulated'].includes(row.risk_class)) return false;
  if (!['interactive', 'background', 'action_proposal'].includes(row.execution_class)) return false;
  const profile = getSkillInferenceProfile(row.skill_id);
  return profile.allowedExecutionClasses.includes(
    row.execution_class as SkillInferenceExecutionClass,
  )
    && profileAllowsRisk(profile, row.risk_class as SkillInferenceRiskClass)
    && row.schema_id !== null
    && profile.allowedSchemaIds.includes(row.schema_id);
}

export interface LocalInferenceSummary {
  window: { hours: number; startsAt: string; generatedAt: string };
  baseline: {
    providerCompletions: number;
    activeUsers: number;
    contentScriptRuns: number;
    contentScriptValidationPassed: number;
    contentScriptFallbacks: number;
    contentSpecialistJobs: number;
    contentSpecialistJobsCompleted: number;
    contentSpecialistJobsFailed: number;
    providerWorkloads: Array<{
      provider: string;
      baseCategory: string;
      requestSource: string;
      completions: number;
      fallbackCompletions: number;
      activeUsers: number;
      inputTokens: number;
      outputTokens: number;
      modelCostUsd: number;
      searchToolCostUsd: number;
      averageDurationMs: number;
    }>;
  };
  operations: {
    total: number;
    completed: number;
    failed: number;
    cancelled: number;
    localCompleted: number;
    cloudCompleted: number;
    locallyAttempted: number;
    localRoutingDecisions: number;
    eligibleCompleted: number;
    localServedPercent: number | null;
    localSuccessPercent: number | null;
    eligibleFallbackPercent: number | null;
    cloudFallbackAttempts: number;
    cloudFallbackReliabilityAttempts: number;
    cloudFallbackSuccessPercent: number | null;
    scriptOperations: number;
    completedScriptOperations: number;
    locallyCompletedScripts: number;
    localScriptPercent: number | null;
    ordinaryChatOperations: number;
  };
  latency: {
    queueWaitP95Ms: number | null;
    firstTokenP95Ms: number | null;
    ordinaryChatFirstTokenP95Ms: number | null;
    ordinaryChatTotalP95Ms: number | null;
    scriptThroughputP50TokensPerSecond: number | null;
    scriptThroughputAverageTokensPerSecond: number | null;
    scriptJobP95DurationMs: number | null;
    ordinaryChatFirstTokenSampleCount: number;
    ordinaryChatTotalSampleCount: number;
    scriptThroughputSampleCount: number;
    scriptJobDurationSampleCount: number;
  };
  quality: {
    structuredRuns: number;
    invalidRuns: number;
    schemaValidityPercent: number | null;
    rejectionReasons: Array<{ reason: string; count: number }>;
    fallbackReasons: Array<{ reason: string; count: number }>;
  };
  economics: {
    actualCloudSpendUsd: number;
    actualSearchToolSpendUsd: number;
    estimatedCounterfactualCloudSpendUsd: number | null;
    estimatedAvoidedCloudSpendUsd: number | null;
    estimateMethod: string;
  };
  plans: Array<{
    plan: string;
    operations: number;
    localCompleted: number;
    activeTesterDays: number;
    scriptOperations: number;
    locallyCompletedScripts: number;
    actualCloudSpendUsd: number;
    actualSearchToolSpendUsd: number;
  }>;
  pricingProof: {
    repositoryMeasurementsPass: boolean;
    stableActiveConfigurationPass: boolean;
    tierConfigurationStablePass: boolean;
    profileVersionStablePass: boolean;
    modelDigestStablePass: boolean;
    profileVersionObservationCount: number;
    modelDigestObservationCount: number;
    observedLongFormScripts: number;
    observedWindowDays: number;
    minimumEligibleCompletions: 500;
    minimumLongFormScripts: 100;
    minimumActiveTesterDaysPerTier: 30;
    proActiveTesterDays: number;
    maxActiveTesterDays: number;
    externalEvidenceRequired: string[];
  };
  host: {
    manifestAvailable: boolean;
    manifestVersionMatchesControl: boolean;
    modelDigestMatchesControl: boolean;
    profileVersionMatchesControl: boolean;
    runtimeContractMatchesControl: boolean;
    memoryAvailableBytes: number | null;
    minimumMemoryAvailableBytes: number;
    swapUsedBytes: number | null;
    memoryHeadroomPass: boolean | null;
    zeroSwapPass: boolean | null;
    evidenceSource: string;
  };
  nonAiApiLatency: {
    baselineP95Ms: number | null;
    baselineSampleCount: number;
    baselineCapturedAt: string | null;
    currentP95Ms: number | null;
    currentSampleCount: number;
    regressionPercent: number | null;
  };
  endUserApiErrors: {
    baselineRatePercent: number | null;
    baselineSampleCount: number;
    currentRatePercent: number | null;
    currentSampleCount: number;
    regressionPercentagePoints: number | null;
  };
  capacity: ReturnType<typeof localInferenceScheduler.snapshot>;
}

function readHostMemoryPressure(): {
  memoryAvailableBytes: number | null;
  swapUsedBytes: number | null;
  evidenceSource: string;
} {
  try {
    const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
    const values = new Map<string, number>();
    for (const match of meminfo.matchAll(/^([A-Za-z_()]+):\s+(\d+)\s+kB$/gmu)) {
      values.set(match[1]!, Number(match[2]) * 1024);
    }
    const swapTotal = values.get('SwapTotal');
    const swapFree = values.get('SwapFree');
    return {
      memoryAvailableBytes: values.get('MemAvailable') ?? null,
      swapUsedBytes: swapTotal === undefined || swapFree === undefined
        ? null
        : Math.max(0, swapTotal - swapFree),
      evidenceSource: 'proc_meminfo_host_view',
    };
  } catch {
    return {
      memoryAvailableBytes: null,
      swapUsedBytes: null,
      evidenceSource: 'unavailable',
    };
  }
}

export function buildLocalInferenceSummary(
  windowHours = 24,
  db: Database.Database = getDb(),
): LocalInferenceSummary {
  const hours = Math.min(24 * 90, Math.max(1, Math.floor(windowHours)));
  const startsAt = new Date(Date.now() - hours * 60 * 60 * 1_000).toISOString();
  const generatedAt = new Date().toISOString();
  const runtimeControl = getLocalInferenceRuntimeControl(db);
  const nonAiCurrent = getNonAiLatencySnapshot(runtimeControl.nonAiBaselineCapturedAt);
  const endUserErrorCurrent = getEndUserApiErrorSnapshot(runtimeControl.nonAiBaselineCapturedAt);
  const nonAiRegressionPercent = runtimeControl.nonAiP95BaselineMs != null
    && runtimeControl.nonAiP95BaselineMs > 0
    && nonAiCurrent.p95Ms != null
    ? Number((((nonAiCurrent.p95Ms - runtimeControl.nonAiP95BaselineMs)
      / runtimeControl.nonAiP95BaselineMs) * 100).toFixed(2))
    : null;
  const endUserErrorRegressionPoints = runtimeControl.endUserErrorRateBaselinePercent != null
    && endUserErrorCurrent.serverErrorRatePercent != null
    ? Number((endUserErrorCurrent.serverErrorRatePercent
      - runtimeControl.endUserErrorRateBaselinePercent).toFixed(3))
    : null;
  const hostPressure = readHostMemoryPressure();
  const manifestLoad = tryGetLocalModelManifest({ fresh: true });
  const manifest = manifestLoad.ok ? manifestLoad.manifest : null;
  const durableRuntime = db.prepare(`SELECT model_manifest_version, active_model_digest,
                                            skill_profile_version
    FROM local_inference_runtime_control WHERE environment = ?`)
    .get(runtimeControl.environment) as {
      model_manifest_version: string | null;
      active_model_digest: string | null;
      skill_profile_version: string | null;
    } | undefined;
  const activeManifestModel = manifest?.models.find((model) => model.id === manifest.activeModelId);
  const manifestVersionMatchesControl = manifest !== null
    && durableRuntime?.model_manifest_version === manifest.manifestVersion;
  const modelDigestMatchesControl = activeManifestModel?.digest != null
    && durableRuntime?.active_model_digest === activeManifestModel.digest;
  const profileVersionMatchesControl = durableRuntime?.skill_profile_version
    === SKILL_INFERENCE_PROFILE_VERSION;
  const runtimeContractMatchesControl = manifestVersionMatchesControl
    && modelDigestMatchesControl
    && profileVersionMatchesControl;
  const minimumMemoryAvailableBytes = manifest?.productionEnvelope.minimumHostAvailableBytes
    ?? 6 * 1024 ** 3;
  const providerWorkloads = db.prepare(`
    SELECT COALESCE(provider, 'unknown') AS provider,
           COALESCE(base_category, category) AS base_category,
           request_source,
           COUNT(*) AS completions,
           SUM(CASE WHEN lower(category) LIKE '%fallback%' THEN 1 ELSE 0 END) AS fallback_completions,
           COUNT(DISTINCT CASE WHEN user_id > 0 THEN user_id END) AS active_users,
           COALESCE(SUM(input_tokens), 0) AS input_tokens,
           COALESCE(SUM(output_tokens), 0) AS output_tokens,
           COALESCE(SUM(CASE WHEN COALESCE(provider, '') <> 'ollama'
             THEN MAX(cost_usd - provider_tool_cost_usd, 0) ELSE 0 END), 0) AS model_cost,
           COALESCE(SUM(provider_tool_cost_usd), 0) AS tool_cost,
           COALESCE(AVG(duration_ms), 0) AS average_duration_ms
      FROM api_usage
     WHERE julianday(ts) >= julianday(?)
       AND COALESCE(job_name, '') NOT IN (?, ?)
       AND instr(COALESCE(base_category, category), ?) <> 1
       AND COALESCE(base_category, category) <> ?
     GROUP BY COALESCE(provider, 'unknown'), COALESCE(base_category, category), request_source
     ORDER BY completions DESC, provider, base_category, request_source
  `).all(
    startsAt,
    LOCAL_PRIMARY_SHADOW_JOB_NAME,
    CLASSIFIER_SHADOW_JOB_NAME,
    LOCAL_PRIMARY_SHADOW_CATEGORY_PREFIX,
    CLASSIFIER_SHADOW_JOB_NAME,
  ) as Array<{
    provider: string;
    base_category: string;
    request_source: string;
    completions: number;
    fallback_completions: number;
    active_users: number;
    input_tokens: number;
    output_tokens: number;
    model_cost: number;
    tool_cost: number;
    average_duration_ms: number;
  }>;
  const providerCompletionCount = providerWorkloads.reduce((sum, row) => sum + Number(row.completions), 0);
  const activeProviderUsers = (db.prepare(`SELECT COUNT(DISTINCT user_id) AS count
    FROM api_usage WHERE julianday(ts) >= julianday(?) AND user_id > 0
      AND COALESCE(job_name, '') NOT IN (?, ?)
      AND instr(COALESCE(base_category, category), ?) <> 1
      AND COALESCE(base_category, category) <> ?`)
    .get(
      startsAt,
      LOCAL_PRIMARY_SHADOW_JOB_NAME,
      CLASSIFIER_SHADOW_JOB_NAME,
      LOCAL_PRIMARY_SHADOW_CATEGORY_PREFIX,
      CLASSIFIER_SHADOW_JOB_NAME,
    ) as { count: number }).count;
  const scriptBaseline = db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN validation_status = 'passed' THEN 1 ELSE 0 END) AS passed,
           SUM(CASE WHEN fallback_used = 1 THEN 1 ELSE 0 END) AS fallbacks
      FROM script_generation_runs
     WHERE ts >= ?
  `).get(Math.floor(Date.parse(startsAt) / 1_000)) as { total: number; passed: number; fallbacks: number };
  const specialistBaseline = db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
      FROM content_agent_jobs
     WHERE julianday(created_at) >= julianday(?)
  `).get(startsAt) as { total: number; completed: number; failed: number };
  const rows = db.prepare(`
    SELECT run_id, operation_id, tenant_id, user_id, plan_id, skill_id, task_type,
           evaluation_mode, risk_class, execution_class, schema_id,
           profile_version,
           status, final_route,
           fallback_reason, validation_status, queue_wait_ms, first_token_ms,
           generation_tokens_per_second, duration_ms, created_at
      FROM skill_inference_runs
     WHERE julianday(created_at) >= julianday(?) AND evaluation_mode = 'production'
     ORDER BY created_at, rowid
  `).all(startsAt) as RunMetricRow[];
  const attempts = db.prepare(`
    SELECT a.run_id, a.route, a.outcome, a.failure_reason, a.model_digest
      FROM skill_inference_attempts a
      JOIN skill_inference_runs r ON r.run_id = a.run_id
     WHERE julianday(r.created_at) >= julianday(?) AND r.evaluation_mode = 'production'
  `).all(startsAt) as AttemptMetricRow[];
  const allOperations = groupOperations(rows, attempts);
  const specialistWorkflowRows = db.prepare(`
    SELECT j.job_key, j.status,
           COUNT(s.id) AS step_count,
           SUM(CASE WHEN s.status = 'completed' THEN 1 ELSE 0 END) AS completed_steps,
           SUM(CASE WHEN s.status = 'completed'
                     AND json_valid(s.output_summary_json)
                     AND json_extract(s.output_summary_json, '$.basis') = 'provider_routed'
                     AND json_extract(s.output_summary_json, '$.provider') = 'ollama'
                    THEN 1 ELSE 0 END) AS local_provider_steps
      FROM content_agent_jobs j
      LEFT JOIN content_agent_job_steps s
        ON s.job_id = j.id
       AND s.tenant_id = j.tenant_id
       AND s.owner_user_id = j.owner_user_id
     WHERE julianday(j.created_at) >= julianday(?)
        OR julianday(j.completed_at) >= julianday(?)
     GROUP BY j.id, j.job_key, j.status
  `).all(startsAt, startsAt) as Array<{
    job_key: string;
    status: string;
    step_count: number;
    completed_steps: number;
    local_provider_steps: number;
  }>;
  const fullyLocalSpecialistOperations = new Set(specialistWorkflowRows.flatMap((row) => (
    row.status === 'completed'
      && Number(row.step_count) === 7
      && Number(row.completed_steps) === 7
      && Number(row.local_provider_steps) === 7
      ? [row.job_key]
      : []
  )));
  const isLocallyCompletedOperation = (operation: OperationMetric): boolean => (
    operation.primary.status === 'completed'
    && operation.primary.final_route === 'local'
    && operation.locallyAttempted
    && !operation.cloudAttempted
    && (!operation.primary.task_type.startsWith('content_specialist_group')
      || fullyLocalSpecialistOperations.has(operation.primary.operation_id))
  );
  // Durable long-form scripts are one user-visible operation per job. Their
  // outline/section/repair runs remain available for runtime and quality
  // diagnostics but are excluded from ordinary operation/economics counters.
  const operations = allOperations.filter((operation) => !operation.primary.task_type.startsWith('script_'));
  const completed = operations.filter((operation) => operation.primary.status === 'completed');
  const localCompleted = completed.filter(isLocallyCompletedOperation);
  const cloudCompleted = completed.filter((operation) => (
    operation.primary.final_route === 'cloud' || operation.cloudFallbackSucceeded
  ));
  // Shadow rows are excluded by the production-only query above. They never
  // serve an answer and cannot enter rollout, pricing, or fallback metrics.
  const locallyAttempted = operations.filter((operation) => operation.locallyAttempted);
  const localRoutingDecisions = operations.filter((operation) => (
    operation.locallyAttempted || operation.automaticCloudFallback
  ));
  const cloudFallbacks = operations.filter((operation) => operation.automaticCloudFallback);
  const reliabilityCloudFallbacks = cloudFallbacks.filter((operation) => (
    operation.cloudFallbackReliabilityEligible
  ));
  const successfulCloudFallbacks = cloudFallbacks.filter((operation) => operation.cloudFallbackSucceeded);
  const eligibleCompleted = completed.filter((operation) => (
    isLocallyEligibleOperation(operation.primary)
  ));
  const scriptStages = rows.filter((row) => row.task_type.startsWith('script_'));
  const ordinaryChatEligible = operations.filter((operation) => (
    operation.primary.task_type === 'chat_read_only_generation'
    && operation.locallyAttempted
  ));
  const ordinaryChatLocal = ordinaryChatEligible.filter((operation) => (
    operation.primary.status === 'completed' && operation.primary.final_route === 'local'
  ));
  // The 4 token/s gate measures the resident local model. A fast cloud repair
  // must never conceal a slow or failed local script stage.
  const scriptThroughputs = scriptStages.flatMap((row) => (
    row.status === 'completed'
      && row.final_route === 'local'
      && row.generation_tokens_per_second != null
      ? [row.generation_tokens_per_second]
      : []
  ));
  const scriptJobs = db.prepare(`
    SELECT plan_id, owner_user_id, status, route, target_duration_seconds,
           warning_codes_json,
           created_at, completed_at
      FROM content_script_jobs
     WHERE julianday(created_at) >= julianday(?)
        OR julianday(completed_at) >= julianday(?)
  `).all(startsAt, startsAt) as Array<{
    plan_id: string;
    owner_user_id: number;
    status: string;
    route: string | null;
    target_duration_seconds: number;
    warning_codes_json: string;
    created_at: string;
    completed_at: string | null;
  }>;
  const eligibleScriptJobs = scriptJobs.filter((row) => (
    row.status === 'completed' || row.status === 'failed'
  ));
  const completedScriptJobs = scriptJobs.filter((row) => row.status === 'completed');
  const qualityAcceptedScriptJobs = completedScriptJobs.filter((row) => (
    !hasScriptQualityWarnings(row.warning_codes_json)
  ));
  const completedLongFormScriptJobs = qualityAcceptedScriptJobs.filter((row) => (
    isLongFormScriptDuration(row.target_duration_seconds)
  ));
  const localScripts = qualityAcceptedScriptJobs.filter((row) => row.route === 'local');
  const scriptJobDurations = completedScriptJobs.flatMap((row) => {
    if (!row.completed_at) return [];
    const duration = parseSqliteTimestamp(row.completed_at) - parseSqliteTimestamp(row.created_at);
    return Number.isFinite(duration) && duration >= 0 ? [duration] : [];
  });
  const runById = new Map(rows.map((row) => [row.run_id, row]));
  const schemaFailurePattern = /(?:invalid_json|schema.*invalid|INFERENCE_SCHEMA_VALUE_INVALID)/iu;
  // Score local structured outputs, not the run's final provider. Otherwise a
  // successful cloud fallback would overwrite and hide an invalid local JSON
  // attempt. Transport failures produced no schema-bearing output and are not
  // part of this denominator.
  const structuredAttempts = attempts.filter((attempt) => {
    if (attempt.route !== 'local') return false;
    const run = runById.get(attempt.run_id);
    if (!run || run.schema_id === 'text' || run.schema_id == null) return false;
    return attempt.outcome === 'success'
      || schemaFailurePattern.test(attempt.failure_reason ?? '');
  });
  const validStructuredAttempts = structuredAttempts.filter((attempt) => (
    attempt.outcome === 'success'
      && runById.get(attempt.run_id)?.validation_status === 'valid'
  ));
  const rejectionCounts = new Map<string, number>();
  for (const attempt of attempts) {
    if (attempt.outcome !== 'failure') continue;
    const reason = attempt.failure_reason || 'unknown_failure';
    rejectionCounts.set(reason, (rejectionCounts.get(reason) ?? 0) + 1);
  }
  // Application validators can reject a provider-successful response after
  // the attempt ledger is written. Include those run-level rejection reasons
  // so safety/tenant failures remain visible to the immediate rollback guard.
  for (const row of rows) {
    if (row.status !== 'failed' || !row.fallback_reason) continue;
    rejectionCounts.set(
      row.fallback_reason,
      (rejectionCounts.get(row.fallback_reason) ?? 0) + 1,
    );
  }
  const fallbackCounts = new Map<string, number>();
  for (const operation of completed) {
    const reason = operation.primary.fallback_reason;
    if (!reason) continue;
    fallbackCounts.set(reason, (fallbackCounts.get(reason) ?? 0) + 1);
  }
  const spend = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN COALESCE(provider, '') <> 'ollama'
        THEN MAX(cost_usd - provider_tool_cost_usd, 0) ELSE 0 END), 0) AS cloud,
      COALESCE(SUM(provider_tool_cost_usd), 0) AS tools
      FROM api_usage WHERE julianday(ts) >= julianday(?)
        AND COALESCE(job_name, '') NOT IN (?, ?)
        AND instr(COALESCE(base_category, category), ?) <> 1
        AND COALESCE(base_category, category) <> ?
  `).get(
    startsAt,
    LOCAL_PRIMARY_SHADOW_JOB_NAME,
    CLASSIFIER_SHADOW_JOB_NAME,
    LOCAL_PRIMARY_SHADOW_CATEGORY_PREFIX,
    CLASSIFIER_SHADOW_JOB_NAME,
  ) as { cloud: number; tools: number };
  const inferenceCloudUsage = db.prepare(`
    SELECT a.run_id,
           SUM(CASE WHEN a.cost_usd > a.provider_tool_cost_usd
             THEN a.cost_usd - a.provider_tool_cost_usd ELSE 0 END) AS cost
      FROM api_usage a
      JOIN skill_inference_runs r ON r.run_id = a.run_id
     WHERE julianday(r.created_at) >= julianday(?) AND r.evaluation_mode = 'production'
       AND COALESCE(a.provider, '') <> 'ollama'
     GROUP BY a.run_id
  `).all(startsAt) as Array<{ run_id: string; cost: number }>;
  const operationByRunId = new Map<string, OperationMetric>();
  for (const operation of operations) {
    for (const run of operation.runs) operationByRunId.set(run.run_id, operation);
  }
  const cloudSpendByOperation = new Map<string, number>();
  for (const usage of inferenceCloudUsage) {
    const operation = operationByRunId.get(usage.run_id);
    if (!operation) continue;
    cloudSpendByOperation.set(
      operation.key,
      (cloudSpendByOperation.get(operation.key) ?? 0) + Number(usage.cost),
    );
  }
  const averageCloudOperationCost = cloudCompleted.length > 0
    ? cloudCompleted.reduce(
      (sum, operation) => sum + (cloudSpendByOperation.get(operation.key) ?? 0),
      0,
    ) / cloudCompleted.length
    : null;
  const estimatedCounterfactual = averageCloudOperationCost === null
    ? null
    : Number((averageCloudOperationCost * localCompleted.length).toFixed(6));

  const planSpend = db.prepare(`
    SELECT COALESCE(r.plan_id, s.plan, CASE WHEN a.user_id > 0 THEN 'unattributed' ELSE 'system' END) AS plan_id,
           COALESCE(SUM(CASE WHEN COALESCE(a.provider, '') <> 'ollama'
             THEN MAX(a.cost_usd - a.provider_tool_cost_usd, 0) ELSE 0 END), 0) AS cloud,
           COALESCE(SUM(a.provider_tool_cost_usd), 0) AS tools
      FROM api_usage a
      LEFT JOIN skill_inference_runs r ON r.run_id = a.run_id
      LEFT JOIN subscriptions s ON s.user_id = a.user_id
     WHERE julianday(a.ts) >= julianday(?)
       AND COALESCE(a.job_name, '') NOT IN (?, ?)
       AND instr(COALESCE(a.base_category, a.category), ?) <> 1
       AND COALESCE(a.base_category, a.category) <> ?
     GROUP BY COALESCE(r.plan_id, s.plan, CASE WHEN a.user_id > 0 THEN 'unattributed' ELSE 'system' END)
  `).all(
    startsAt,
    LOCAL_PRIMARY_SHADOW_JOB_NAME,
    CLASSIFIER_SHADOW_JOB_NAME,
    LOCAL_PRIMARY_SHADOW_CATEGORY_PREFIX,
    CLASSIFIER_SHADOW_JOB_NAME,
  ) as Array<{ plan_id: string; cloud: number; tools: number }>;
  const planCounts = new Map<string, {
    operations: number;
    localCompleted: number;
    activeTesterDays: Set<string>;
    scriptOperations: number;
    locallyCompletedScripts: number;
    actualCloudSpendUsd: number;
    actualSearchToolSpendUsd: number;
  }>();
  for (const operation of operations) {
    const row = operation.primary;
    const plan = row.plan_id;
    const current = planCounts.get(plan) ?? {
      operations: 0,
      localCompleted: 0,
      activeTesterDays: new Set<string>(),
      scriptOperations: 0,
      locallyCompletedScripts: 0,
      actualCloudSpendUsd: 0,
      actualSearchToolSpendUsd: 0,
    };
    current.operations += 1;
    if (isLocallyCompletedOperation(operation)) current.localCompleted += 1;
    current.activeTesterDays.add(`${row.user_id}:${row.created_at.slice(0, 10)}`);
    planCounts.set(plan, current);
  }
  for (const job of scriptJobs) {
    const current = planCounts.get(job.plan_id) ?? {
      operations: 0,
      localCompleted: 0,
      activeTesterDays: new Set<string>(),
      scriptOperations: 0,
      locallyCompletedScripts: 0,
      actualCloudSpendUsd: 0,
      actualSearchToolSpendUsd: 0,
    };
    current.scriptOperations += 1;
    if (job.status === 'completed'
        && job.route === 'local'
        && !hasScriptQualityWarnings(job.warning_codes_json)) current.locallyCompletedScripts += 1;
    // A durable script can be queued before the reporting window and finish
    // inside it. Attribute that activity to the in-window completion date so
    // pricing proof does not manufacture an out-of-window tester-day.
    const activityAt = parseSqliteTimestamp(job.created_at) >= parseSqliteTimestamp(startsAt)
      ? job.created_at
      : job.completed_at ?? job.created_at;
    current.activeTesterDays.add(`${job.owner_user_id}:${activityAt.slice(0, 10)}`);
    planCounts.set(job.plan_id, current);
  }
  for (const spendRow of planSpend) {
    const current = planCounts.get(spendRow.plan_id) ?? {
      operations: 0,
      localCompleted: 0,
      activeTesterDays: new Set<string>(),
      scriptOperations: 0,
      locallyCompletedScripts: 0,
      actualCloudSpendUsd: 0,
      actualSearchToolSpendUsd: 0,
    };
    current.actualCloudSpendUsd = Number(Number(spendRow.cloud).toFixed(6));
    current.actualSearchToolSpendUsd = Number(Number(spendRow.tools).toFixed(6));
    planCounts.set(spendRow.plan_id, current);
  }
  const planSummaries = [...planCounts].map(([plan, counts]) => ({
    plan,
    operations: counts.operations,
    localCompleted: counts.localCompleted,
    activeTesterDays: counts.activeTesterDays.size,
    scriptOperations: counts.scriptOperations,
    locallyCompletedScripts: counts.locallyCompletedScripts,
    actualCloudSpendUsd: counts.actualCloudSpendUsd,
    actualSearchToolSpendUsd: counts.actualSearchToolSpendUsd,
  })).sort((left, right) => left.plan.localeCompare(right.plan));
  const tierConfigurationRows = db.prepare(`SELECT plan_id, updated_at
    FROM plan_configs WHERE plan_id IN ('pro', 'max') AND active = 1`)
    .all() as Array<{ plan_id: string; updated_at: string }>;
  const tierConfigurationStablePass = tierConfigurationRows.length === 2
    && new Set(tierConfigurationRows.map((row) => row.plan_id)).size === 2
    && tierConfigurationRows.every((row) => {
      const changedAt = parseSqliteTimestamp(row.updated_at);
      return Number.isFinite(changedAt) && changedAt <= parseSqliteTimestamp(startsAt);
    });
  // Eligibility is profile-specific. In particular, Finance is local-primary
  // only at low risk, while other read-only skills may admit medium risk. A
  // generic low/medium check would count explicitly cloud-required Finance
  // work against local-served share and corrupt rollout/pricing evidence.
  const localEligibleOperations = operations.filter((operation) => (
    isLocallyEligibleOperation(operation.primary)
  ));
  const locallyCompletedEligibleOperations = localEligibleOperations.filter(isLocallyCompletedOperation);
  const localServedPercent = rate(
    locallyCompletedEligibleOperations.length,
    localEligibleOperations.length,
  );
  // Count every automatic cloud attempt, including failed fallbacks. Using
  // only cloud-completed operations would make a provider outage look like a
  // lower fallback rate and could incorrectly pass the rollout/pricing gate.
  const eligibleFallbackPercent = rate(cloudFallbacks.length, localRoutingDecisions.length);
  const localScriptPercent = rate(localScripts.length, eligibleScriptJobs.length);
  const proActiveTesterDays = planSummaries.find((plan) => plan.plan === 'pro')?.activeTesterDays ?? 0;
  const maxActiveTesterDays = planSummaries.find((plan) => plan.plan === 'max')?.activeTesterDays ?? 0;
  const localSuccessPercent = rate(localCompleted.length, localRoutingDecisions.length);
  const cloudFallbackSuccessPercent = rate(
    successfulCloudFallbacks.length,
    reliabilityCloudFallbacks.length,
  );
  const schemaValidityPercent = rate(validStructuredAttempts.length, structuredAttempts.length);
  const ordinaryChatFirstTokenSamples = ordinaryChatLocal.flatMap((operation) => (
    operation.primary.first_token_ms == null ? [] : [operation.primary.first_token_ms]
  ));
  const ordinaryChatTotalSamples = ordinaryChatEligible.flatMap((operation) => (
    operation.primary.duration_ms != null ? [operation.primary.duration_ms] : []
  ));
  const ordinaryChatFirstTokenP95Ms = percentile(ordinaryChatFirstTokenSamples, 0.95);
  const ordinaryChatTotalP95Ms = percentile(ordinaryChatTotalSamples, 0.95);
  const scriptThroughputAverageTokensPerSecond = scriptThroughputs.length === 0
    ? null
    : Number((scriptThroughputs.reduce((sum, value) => sum + value, 0) / scriptThroughputs.length).toFixed(3));
  const scriptJobP95DurationMs = percentile(scriptJobDurations, 0.95);
  const activeModel = activeManifestModel;
  const observedProfileVersions = new Set(rows.map((row) => row.profile_version));
  const successfulLocalDigests = new Set(attempts.flatMap((attempt) => (
    attempt.route === 'local' && attempt.outcome === 'success' && attempt.model_digest
      ? [attempt.model_digest]
      : []
  )));
  const modelDigestObservationCount = attempts.filter((attempt) => (
    attempt.route === 'local'
      && attempt.outcome === 'success'
      && typeof attempt.model_digest === 'string'
      && attempt.model_digest.length > 0
  )).length;
  const profileVersionStablePass = observedProfileVersions.size === 1
    && observedProfileVersions.has(SKILL_INFERENCE_PROFILE_VERSION);
  const modelDigestStablePass = activeModel?.digest != null
    && successfulLocalDigests.size === 1
    && successfulLocalDigests.has(activeModel.digest);
  const runtimeControlUpdatedAt = runtimeControl.updatedAt === null
    ? Number.NaN
    : parseSqliteTimestamp(runtimeControl.updatedAt);
  const stableActiveConfigurationPass = runtimeControl.mode === 'active'
    && runtimeContractMatchesControl
    && Number.isFinite(runtimeControlUpdatedAt)
    && runtimeControlUpdatedAt <= parseSqliteTimestamp(startsAt)
    && profileVersionStablePass
    && modelDigestStablePass;
  const measuredReliabilityAndCapacityPass = localSuccessPercent != null && localSuccessPercent >= 95
    && (reliabilityCloudFallbacks.length === 0
      || (cloudFallbackSuccessPercent != null && cloudFallbackSuccessPercent >= 99))
    && structuredAttempts.length >= 100
    && schemaValidityPercent != null && schemaValidityPercent >= 99
    && ordinaryChatFirstTokenSamples.length >= 20
    && ordinaryChatTotalSamples.length >= 20
    && ordinaryChatFirstTokenP95Ms != null && ordinaryChatFirstTokenP95Ms <= 12_000
    && ordinaryChatTotalP95Ms != null && ordinaryChatTotalP95Ms <= 45_000
    && scriptThroughputs.length >= 20
    && scriptThroughputAverageTokensPerSecond != null && scriptThroughputAverageTokensPerSecond >= 4
    && scriptJobDurations.length >= 20
    && scriptJobP95DurationMs != null && scriptJobP95DurationMs <= 12 * 60 * 1_000
    && hostPressure.memoryAvailableBytes != null
    && hostPressure.memoryAvailableBytes >= minimumMemoryAvailableBytes
    && hostPressure.swapUsedBytes === 0
    && nonAiCurrent.sampleCount >= 20
    && nonAiRegressionPercent != null && nonAiRegressionPercent <= 5
    && endUserErrorCurrent.sampleCount >= 20
    && endUserErrorRegressionPoints != null && endUserErrorRegressionPoints <= 0.5;

  return {
    window: { hours, startsAt, generatedAt },
    baseline: {
      providerCompletions: providerCompletionCount,
      activeUsers: Number(activeProviderUsers),
      contentScriptRuns: Number(scriptBaseline.total),
      contentScriptValidationPassed: Number(scriptBaseline.passed ?? 0),
      contentScriptFallbacks: Number(scriptBaseline.fallbacks ?? 0),
      contentSpecialistJobs: Number(specialistBaseline.total),
      contentSpecialistJobsCompleted: Number(specialistBaseline.completed ?? 0),
      contentSpecialistJobsFailed: Number(specialistBaseline.failed ?? 0),
      providerWorkloads: providerWorkloads.map((row) => ({
        provider: row.provider,
        baseCategory: row.base_category,
        requestSource: row.request_source,
        completions: Number(row.completions),
        fallbackCompletions: Number(row.fallback_completions),
        activeUsers: Number(row.active_users),
        inputTokens: Number(row.input_tokens),
        outputTokens: Number(row.output_tokens),
        modelCostUsd: Number(Number(row.model_cost).toFixed(6)),
        searchToolCostUsd: Number(Number(row.tool_cost).toFixed(6)),
        averageDurationMs: Number(Number(row.average_duration_ms).toFixed(2)),
      })),
    },
    operations: {
      total: operations.length,
      completed: completed.length,
      failed: operations.filter((operation) => operation.primary.status === 'failed').length,
      cancelled: operations.filter((operation) => operation.primary.status === 'cancelled').length,
      localCompleted: localCompleted.length,
      cloudCompleted: cloudCompleted.length,
      locallyAttempted: locallyAttempted.length,
      localRoutingDecisions: localRoutingDecisions.length,
      eligibleCompleted: eligibleCompleted.length,
      localServedPercent,
      localSuccessPercent,
      eligibleFallbackPercent,
      cloudFallbackAttempts: cloudFallbacks.length,
      cloudFallbackReliabilityAttempts: reliabilityCloudFallbacks.length,
      cloudFallbackSuccessPercent,
      scriptOperations: scriptJobs.length,
      completedScriptOperations: completedScriptJobs.length,
      locallyCompletedScripts: localScripts.length,
      localScriptPercent,
      ordinaryChatOperations: ordinaryChatEligible.length,
    },
    latency: {
      queueWaitP95Ms: percentile(rows.flatMap((row) => row.queue_wait_ms == null ? [] : [row.queue_wait_ms]), 0.95),
      firstTokenP95Ms: percentile(localCompleted.flatMap((operation) => (
        operation.primary.first_token_ms == null ? [] : [operation.primary.first_token_ms]
      )), 0.95),
      ordinaryChatFirstTokenP95Ms,
      ordinaryChatTotalP95Ms,
      scriptThroughputP50TokensPerSecond: percentile(scriptThroughputs, 0.5),
      scriptThroughputAverageTokensPerSecond,
      scriptJobP95DurationMs,
      ordinaryChatFirstTokenSampleCount: ordinaryChatFirstTokenSamples.length,
      ordinaryChatTotalSampleCount: ordinaryChatTotalSamples.length,
      scriptThroughputSampleCount: scriptThroughputs.length,
      scriptJobDurationSampleCount: scriptJobDurations.length,
    },
    quality: {
      structuredRuns: structuredAttempts.length,
      invalidRuns: structuredAttempts.length - validStructuredAttempts.length,
      schemaValidityPercent,
      rejectionReasons: [...rejectionCounts].map(([reason, count]) => ({ reason, count }))
        .sort((left, right) => right.count - left.count),
      fallbackReasons: [...fallbackCounts].map(([reason, count]) => ({ reason, count }))
        .sort((left, right) => right.count - left.count),
    },
    economics: {
      actualCloudSpendUsd: Number(Number(spend.cloud).toFixed(6)),
      actualSearchToolSpendUsd: Number(Number(spend.tools).toFixed(6)),
      estimatedCounterfactualCloudSpendUsd: estimatedCounterfactual,
      estimatedAvoidedCloudSpendUsd: estimatedCounterfactual,
      estimateMethod: averageCloudOperationCost === null
        ? 'unavailable: no successful governed cloud comparison in this window'
        : 'estimate: local completions multiplied by observed average governed cloud-operation cost',
    },
    plans: planSummaries,
    pricingProof: {
      repositoryMeasurementsPass: hours >= 24 * 30
        && stableActiveConfigurationPass
        && tierConfigurationStablePass
        && eligibleCompleted.length >= 500
        && completedLongFormScriptJobs.length >= 100
        && proActiveTesterDays >= 30
        && maxActiveTesterDays >= 30
        && localServedPercent != null && localServedPercent >= 80
        && localScriptPercent != null && localScriptPercent >= 85
        && eligibleFallbackPercent != null && eligibleFallbackPercent <= 15
        && measuredReliabilityAndCapacityPass,
      stableActiveConfigurationPass,
      tierConfigurationStablePass,
      profileVersionStablePass,
      modelDigestStablePass,
      profileVersionObservationCount: rows.length,
      modelDigestObservationCount,
      observedLongFormScripts: completedLongFormScriptJobs.length,
      observedWindowDays: Number((hours / 24).toFixed(2)),
      minimumEligibleCompletions: 500,
      minimumLongFormScripts: 100,
      minimumActiveTesterDaysPerTier: 30,
      proActiveTesterDays,
      maxActiveTesterDays,
      externalEvidenceRequired: [
        'blind_quality_and_safety_acceptance',
        'host_memory_swap_and_non_ai_latency_evidence',
        'allocated_vps_cost_and_payment_store_fees',
        'pro_contribution_margin_at_least_65_percent',
        'max_contribution_margin_at_least_70_percent',
        'live_stripe_and_app_store_price_verification',
        'owner_authorized_price_activation_transaction',
      ],
    },
    host: {
      ...hostPressure,
      manifestAvailable: manifestLoad.ok,
      manifestVersionMatchesControl,
      modelDigestMatchesControl,
      profileVersionMatchesControl,
      runtimeContractMatchesControl,
      minimumMemoryAvailableBytes,
      memoryHeadroomPass: hostPressure.memoryAvailableBytes == null
        ? (runtimeControl.environment === 'production' ? false : null)
        : hostPressure.memoryAvailableBytes >= minimumMemoryAvailableBytes,
      zeroSwapPass: hostPressure.swapUsedBytes == null
        ? (runtimeControl.environment === 'production' ? false : null)
        : hostPressure.swapUsedBytes === 0,
    },
    nonAiApiLatency: {
      baselineP95Ms: runtimeControl.nonAiP95BaselineMs,
      baselineSampleCount: runtimeControl.nonAiBaselineSampleCount,
      baselineCapturedAt: runtimeControl.nonAiBaselineCapturedAt,
      currentP95Ms: nonAiCurrent.p95Ms,
      currentSampleCount: nonAiCurrent.sampleCount,
      regressionPercent: nonAiRegressionPercent,
    },
    endUserApiErrors: {
      baselineRatePercent: runtimeControl.endUserErrorRateBaselinePercent,
      baselineSampleCount: runtimeControl.endUserErrorBaselineSampleCount,
      currentRatePercent: endUserErrorCurrent.serverErrorRatePercent,
      currentSampleCount: endUserErrorCurrent.sampleCount,
      regressionPercentagePoints: endUserErrorRegressionPoints,
    },
    capacity: localInferenceScheduler.snapshot(),
  };
}
