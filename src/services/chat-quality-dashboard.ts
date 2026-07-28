// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Milestone 22 — production chat-quality dashboard aggregation.
 *
 * Pure read-model over signals that already exist locally:
 *
 *   - chat_eval_runs / chat_eval_scenario_results   (chat-eval-history)
 *   - day-to-day failure summaries                  (persisted per run)
 *   - quality-gate outcome counters                 (chat-hybrid-metrics, M8)
 *   - accepted routing-accuracy snapshot + corpus   (routing-accuracy, M7)
 *   - online-eval sampler capture counts            (chat-core-v2 sampler)
 *   - ChatV2 readiness rows                         (chatv2-readiness-alerts)
 *
 * No LLM calls, no network, no writes. Raw utterance/response text is never
 * included — sampler rows surface only status/reason counts and the locale
 * section is derived from per-scenario score dimensions.
 */

import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import {
  ensureChatEvalHistoryTables,
  listChatEvalRuns,
  readFrozenRealProviderBaselineState,
  type ChatEvalFrozenBaselineState,
  type ChatEvalHistoryRun,
} from './chat-eval-history';
import {
  getChatQualityGateOutcomeCounters,
  type ChatQualityGateOutcome,
} from './chat-hybrid-metrics';
import type { RoutingAccuracyReport } from './routing-accuracy';
import { ensureRoutingCorpusTables, getRoutingCorpusProgress, type RoutingCorpusProgress } from './routing-corpus';
import { ensureChatCoreV2OnlineEvalTables } from './chat-core-v2/online-eval-sampler';
import {
  buildChatV2ReadinessDashboard,
  type ChatV2CompletionReadinessReportLike,
  type ChatV2ReadinessDashboardRow,
} from './chatv2-readiness-alerts';
import {
  readChatRoutingClarifyBudget,
  type ChatRoutingClarifyBudget,
} from './chat-routing-clarify-metrics';
import {
  CHAT_V2_RETIREMENT_FALLBACK_WINDOW_HOURS,
  CHAT_V2_RETIREMENT_MAX_FALLBACK_RATE,
  buildChatV2RetirementCampaign,
  buildChatV2RetirementFallbackAlertInputs,
  type ChatV2RetirementCampaignRow,
} from './chat-route-exit-sampler';

export const CHAT_QUALITY_DASHBOARD_VERSION = 'chat-quality-dashboard@1.2.0';

/** Default artifact path written by the owner-run readiness CLI (see runbook). */
export const DEFAULT_CHAT_V2_READINESS_REPORT_PATH = 'reports/chatv2-readiness/latest.json';

const CHAT_V2_READINESS_PHASES = [
  'shadow',
  'answerCanary',
  'deterministicRead',
  'writePreview',
  'confirmedWrites',
  'cloudAllowlist',
  'legacyRetirement',
] as const;

/**
 * Fail-closed structural validation for the owner-produced readiness artifact.
 * A matching schema label alone is not evidence: all producer-owned phases
 * and every scalar gate field must be present before consumers may map gates.
 */
export function validateChatV2ReadinessReportStructure(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return 'readiness report artifact is not an object';
  }
  const report = value as Record<string, unknown>;
  const schema = typeof report.schemaVersion === 'string' ? report.schemaVersion : '';
  if (!schema.startsWith('chat_v2_completion_readiness_report')) {
    return `unexpected readiness schema: expected chat_v2_completion_readiness_report*, found ${schema || 'missing'}`
      + ' (produce the artifact with scripts/chatv2-completion-readiness.ts)';
  }
  if (typeof report.generatedAt !== 'string' || report.generatedAt.trim().length === 0) {
    return 'readiness report generatedAt must be a non-empty string';
  }
  if (
    !Array.isArray(report.evidenceSources)
    || report.evidenceSources.some((source) => typeof source !== 'string' || source.trim().length === 0)
  ) {
    return 'readiness report evidenceSources must be an array of non-empty strings';
  }
  for (const phaseName of CHAT_V2_READINESS_PHASES) {
    const phase = report[phaseName];
    if (!phase || typeof phase !== 'object' || Array.isArray(phase)) {
      return `readiness report phase ${phaseName} is missing or invalid`;
    }
    const phaseRecord = phase as Record<string, unknown>;
    if (typeof phaseRecord.passed !== 'boolean' || !Array.isArray(phaseRecord.gates)) {
      return `readiness report phase ${phaseName} requires boolean passed and a gates array`;
    }
    for (const gate of phaseRecord.gates) {
      if (!gate || typeof gate !== 'object' || Array.isArray(gate)) {
        return `readiness report phase ${phaseName} contains an invalid gate`;
      }
      const gateRecord = gate as Record<string, unknown>;
      if (
        typeof gateRecord.gateId !== 'string'
        || gateRecord.gateId.trim().length === 0
        || typeof gateRecord.passed !== 'boolean'
        || !Number.isInteger(gateRecord.sampleCount)
        || Number(gateRecord.sampleCount) < 0
        || !(
          gateRecord.observed === null
          || (typeof gateRecord.observed === 'number' && Number.isFinite(gateRecord.observed))
        )
        || typeof gateRecord.threshold !== 'number'
        || !Number.isFinite(gateRecord.threshold)
        || (gateRecord.reasonCode !== undefined && typeof gateRecord.reasonCode !== 'string')
      ) {
        return `readiness report phase ${phaseName} contains malformed gate scalars`;
      }
    }
  }
  return null;
}

export interface ChatQualityEvalTrendRow {
  runId: string;
  mode: ChatEvalHistoryRun['mode'];
  generatedAt: string;
  averageScore: number;
  passed: boolean;
  scenarioCount: number;
  passCount: number;
  partialCount: number;
  failCount: number;
  blockedCount: number;
  /** Estimated actual target + judge spend (null when no cost evidence exists). */
  estimatedActualSpendUsd: number | null;
  /** Hard run ceiling; never presented as actual spend. */
  budgetCeilingUsd: number | null;
  realProviderCalls: number;
}

export interface ChatQualityFailureTypeBreakdown {
  runsConsidered: number;
  /** DayToDayFailureType → summed count across the considered runs. */
  counts: Record<string, number>;
}

export interface ChatQualityLocaleLeakage {
  /**
   * Newest run whose persisted day-to-day summary carried locale evidence, preferring
   * real_provider runs over any other mode (fixture runs must not mask live
   * locale regressions). Falls back to any mode; `mode` labels which one won.
   */
  runId: string | null;
  mode: ChatEvalHistoryRun['mode'] | null;
  scenarioCount: number;
  leakedCount: number;
  unknownCount: number;
  rate: number | null;
}

export interface ChatQualityRoutingSurfaceRow {
  surface: string;
  covered: number;
  accuracy: number | null;
  perDomain: Array<{
    domain: string;
    support: number;
    precision: number | null;
    recall: number | null;
  }>;
}

export interface ChatQualityRoutingSection {
  snapshotGeneratedAt: string | null;
  surfaces: ChatQualityRoutingSurfaceRow[] | null;
  corpusProgress: RoutingCorpusProgress;
}

export interface ChatQualityReadinessSection {
  available: boolean;
  reason: string | null;
  generatedAt: string | null;
  rows: ChatV2ReadinessDashboardRow[] | null;
}

export interface ChatQualitySamplerSection {
  windowDays: number;
  total: number;
  byStatus: Record<string, number>;
  /** status/reason count rows only — NEVER raw text or metadata. */
  byReason: Array<{ status: string; reason: string; count: number }>;
}

export interface ChatQualityMonthlySpendRow {
  month: string;
  totalEstimatedActualSpendUsd: number;
  totalBudgetCeilingUsd: number;
  actualSpendEvidenceRunCount: number;
  runCount: number;
}

export interface ChatQualityRetirementCampaignSection {
  fallbackWindowHours: number;
  fallbackThreshold: number;
  alertRouteCount: number;
  candidateRouteCount: number;
  rows: ChatV2RetirementCampaignRow[];
}

export interface ChatQualityDashboard {
  version: string;
  generatedAt: string;
  evalTrend: ChatQualityEvalTrendRow[];
  frozenLiveBaseline: ChatEvalFrozenBaselineState;
  failureTypeBreakdown: ChatQualityFailureTypeBreakdown;
  localeLeakage: ChatQualityLocaleLeakage;
  /** Process-local counters since boot (unified finalizer gate outcomes). */
  qualityGateOutcomes: Readonly<Record<ChatQualityGateOutcome, number>>;
  /** Durable aggregate telemetry for the approved <=10% clarify budget. */
  routingClarifyBudget: ChatRoutingClarifyBudget;
  routingAccuracy: ChatQualityRoutingSection;
  readiness: ChatQualityReadinessSection;
  retirementCampaign: ChatQualityRetirementCampaignSection;
  samplerCaptures: ChatQualitySamplerSection;
  monthlyEvalSpend: {
    months: ChatQualityMonthlySpendRow[];
    currentMonthEstimatedActualSpendUsd: number;
    currentMonthBudgetCeilingUsd: number;
  };
}

export interface BuildChatQualityDashboardOptions {
  now?: Date;
  evalTrendLimit?: number;
  /** How many recent runs contribute to the failure-type breakdown. */
  failureRunLimit?: number;
  samplerWindowDays?: number;
  clarifyWindowDays?: number;
  /**
   * ChatV2 readiness report (chat_v2_completion_readiness_report.v1). Pass
   * null for "explicitly unavailable"; leave undefined to skip loading here
   * (callers that own file loading should pass loadChatV2ReadinessReportFromFile
   * output through this option).
   */
  readinessReport?: ChatV2CompletionReadinessReportLike | null;
  readinessUnavailableReason?: string;
}

export function buildChatQualityDashboard(
  db: Database.Database,
  options: BuildChatQualityDashboardOptions = {},
): ChatQualityDashboard {
  const now = options.now ?? new Date();
  ensureChatEvalHistoryTables(db);
  ensureRoutingCorpusTables(db);
  ensureChatCoreV2OnlineEvalTables(db);

  const evalTrendLimit = boundedInt(options.evalTrendLimit, 20, 1, 100);
  const failureRunLimit = boundedInt(options.failureRunLimit, 5, 1, 25);
  const samplerWindowDays = boundedInt(options.samplerWindowDays, 30, 1, 365);

  const runs = listChatEvalRuns(db, { limit: Math.max(evalTrendLimit, failureRunLimit) });

  return {
    version: CHAT_QUALITY_DASHBOARD_VERSION,
    generatedAt: now.toISOString(),
    evalTrend: runs.slice(0, evalTrendLimit).map(toTrendRow),
    frozenLiveBaseline: readFrozenRealProviderBaselineState(db),
    failureTypeBreakdown: buildFailureTypeBreakdown(runs.slice(0, failureRunLimit)),
    localeLeakage: buildLocaleLeakage(db),
    qualityGateOutcomes: getChatQualityGateOutcomeCounters(),
    routingClarifyBudget: readChatRoutingClarifyBudget(db, {
      now,
      windowDays: boundedInt(options.clarifyWindowDays, 30, 1, 365),
    }),
    routingAccuracy: buildRoutingSection(db),
    readiness: buildReadinessSection(options),
    retirementCampaign: buildRetirementCampaignSection(db, now),
    samplerCaptures: buildSamplerSection(db, now, samplerWindowDays),
    monthlyEvalSpend: buildMonthlySpend(db, now),
  };
}

/**
 * Fail-soft loader for the readiness report artifact produced by
 * `npx tsx scripts/chatv2-completion-readiness.ts` (owner-run; see
 * docs/release/chat-quality-operations.md). That is the ONLY producer of the
 * accepted `chat_v2_completion_readiness_report*` schema — the
 * chatv2-readiness-alerts CLI's --json output is an alerts report with a
 * different schema and is rejected here. Missing/invalid files are a reason
 * string, never a throw — the dashboard renders without the section.
 */
export function loadChatV2ReadinessReportFromFile(
  filePath?: string,
): { report: ChatV2CompletionReadinessReportLike | null; reason: string | null } {
  const resolved = path.resolve(
    process.cwd(),
    filePath
      ?? process.env.CHAT_V2_READINESS_REPORT_PATH
      ?? DEFAULT_CHAT_V2_READINESS_REPORT_PATH,
  );
  let raw: string;
  try {
    raw = fs.readFileSync(resolved, 'utf8');
  } catch {
    return { report: null, reason: 'readiness report artifact not found' };
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const structureError = validateChatV2ReadinessReportStructure(parsed);
    if (structureError) return { report: null, reason: structureError };
    return { report: parsed as ChatV2CompletionReadinessReportLike, reason: null };
  } catch {
    return { report: null, reason: 'readiness report artifact is not valid JSON' };
  }
}

// ─── Sections ─────────────────────────────────────────────────────

function toTrendRow(run: ChatEvalHistoryRun): ChatQualityEvalTrendRow {
  return {
    runId: run.runId,
    mode: run.mode,
    generatedAt: run.generatedAt,
    averageScore: run.averageScore,
    passed: run.passed,
    scenarioCount: run.scenarioCount,
    passCount: run.passCount,
    partialCount: run.partialCount,
    failCount: run.failCount,
    blockedCount: run.blockedCount,
    estimatedActualSpendUsd: run.totalEstimatedActualSpendUsd,
    budgetCeilingUsd: run.totalBudgetCeilingUsd ?? run.budgetUsd,
    realProviderCalls: run.realProviderCalls,
  };
}

function buildFailureTypeBreakdown(runs: ChatEvalHistoryRun[]): ChatQualityFailureTypeBreakdown {
  const counts: Record<string, number> = {};
  let considered = 0;
  for (const run of runs) {
    const summary = run.dayToDaySummary?.failureSummary;
    if (!summary || typeof summary !== 'object' || Array.isArray(summary)) continue;
    considered += 1;
    for (const [type, value] of Object.entries(summary as Record<string, unknown>)) {
      const count = typeof value === 'number' && Number.isFinite(value) ? value : 0;
      if (count <= 0) continue;
      counts[type] = (counts[type] ?? 0) + count;
    }
  }
  return { runsConsidered: considered, counts };
}

/**
 * Locale leakage from the aggregate-only day-to-day summary persisted by the
 * live scorer. Raw turns and text never enter the dashboard.
 *
 * Mode-aware (M22): prefers the newest run with mode='real_provider' so
 * fixture runs cannot mask live regressions; falls back to any mode and
 * labels the winning mode in the payload.
 */
function buildLocaleLeakage(db: Database.Database): ChatQualityLocaleLeakage {
  type LocaleEvidenceRow = {
    run_id: string;
    mode: ChatEvalHistoryRun['mode'];
    day_to_day_summary_json: string;
  };
  const leakageForRow = (row: LocaleEvidenceRow): ChatQualityLocaleLeakage | null => {
    let dayToDaySummary: Record<string, unknown>;
    try {
      const parsed = JSON.parse(row.day_to_day_summary_json) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      dayToDaySummary = parsed as Record<string, unknown>;
    } catch {
      return null;
    }
    const raw = dayToDaySummary.localeLeakage;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const summary = raw as Record<string, unknown>;
    const scenarioCount = nonNegativeCount(summary.observedTurnCount);
    const leakedCount = nonNegativeCount(summary.leakedTurnCount);
    const unknownCount = nonNegativeCount(summary.unknownTurnCount);
    if (scenarioCount === 0 && unknownCount === 0) return null;
    return {
      runId: row.run_id,
      mode: row.mode,
      scenarioCount,
      leakedCount,
      unknownCount,
      rate: scenarioCount > 0 ? round4(leakedCount / scenarioCount) : null,
    };
  };

  const findNewest = (mode?: 'real_provider'): ChatQualityLocaleLeakage | null => {
    const rows = db.prepare(`
      SELECT run_id, mode, day_to_day_summary_json
      FROM chat_eval_runs
      ${mode ? 'WHERE mode = ?' : ''}
      ORDER BY generated_at DESC, id DESC
    `).iterate(...(mode ? [mode] : [])) as Iterable<LocaleEvidenceRow>;
    for (const row of rows) {
      const leakage = leakageForRow(row);
      if (leakage) return leakage;
    }
    return null;
  };

  const live = findNewest('real_provider');
  if (live) return live;
  const fallback = findNewest();
  if (fallback) return fallback;
  return {
    runId: null,
    mode: null,
    scenarioCount: 0,
    leakedCount: 0,
    unknownCount: 0,
    rate: null,
  };
}

function nonNegativeCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : 0;
}

function buildRoutingSection(db: Database.Database): ChatQualityRoutingSection {
  const snapshot = readLatestAcceptedAccuracySnapshot(db);
  return {
    snapshotGeneratedAt: snapshot?.generatedAt ?? null,
    surfaces: snapshot
      ? snapshot.surfaces.map((surface) => ({
        surface: surface.surface,
        covered: surface.covered,
        accuracy: surface.accuracy,
        perDomain: surface.perDomain.map((domain) => ({
          domain: domain.domain,
          support: domain.support,
          precision: domain.precision,
          recall: domain.recall,
        })),
      }))
      : null,
    corpusProgress: getRoutingCorpusProgress(db),
  };
}

function buildReadinessSection(options: BuildChatQualityDashboardOptions): ChatQualityReadinessSection {
  const report = options.readinessReport ?? null;
  if (!report) {
    return {
      available: false,
      reason: options.readinessUnavailableReason ?? 'no readiness report provided',
      generatedAt: null,
      rows: null,
    };
  }
  return {
    available: true,
    reason: null,
    generatedAt: typeof report.generatedAt === 'string' ? report.generatedAt : null,
    rows: buildChatV2ReadinessDashboard(report),
  };
}

function buildRetirementCampaignSection(
  db: Database.Database,
  now: Date,
): ChatQualityRetirementCampaignSection {
  const rows = buildChatV2RetirementCampaign(db, { now });
  return {
    fallbackWindowHours: CHAT_V2_RETIREMENT_FALLBACK_WINDOW_HOURS,
    fallbackThreshold: CHAT_V2_RETIREMENT_MAX_FALLBACK_RATE,
    alertRouteCount: buildChatV2RetirementFallbackAlertInputs(rows, {
      generatedAt: now.toISOString(),
    }).length,
    candidateRouteCount: rows.filter((row) => row.candidate).length,
    rows,
  };
}

function buildSamplerSection(
  db: Database.Database,
  now: Date,
  windowDays: number,
): ChatQualitySamplerSection {
  const cutoff = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000).toISOString();
  const rows = db.prepare(`
    SELECT status, reason, COUNT(*) AS count
    FROM chat_v2_online_eval_samples
    WHERE created_at >= ?
    GROUP BY status, reason
    ORDER BY count DESC, status ASC, reason ASC
  `).all(cutoff) as Array<{ status: string; reason: string; count: number }>;

  const byStatus: Record<string, number> = {};
  let total = 0;
  for (const row of rows) {
    total += row.count;
    byStatus[row.status] = (byStatus[row.status] ?? 0) + row.count;
  }
  return {
    windowDays,
    total,
    byStatus,
    byReason: rows.map((row) => ({ status: row.status, reason: row.reason, count: row.count })),
  };
}

function buildMonthlySpend(db: Database.Database, now: Date): ChatQualityDashboard['monthlyEvalSpend'] {
  const rows = db.prepare(`
    SELECT substr(generated_at, 1, 7) AS month,
           SUM(COALESCE(total_estimated_actual_spend_usd, 0)) AS totalEstimatedActualSpendUsd,
           SUM(COALESCE(total_budget_ceiling_usd, budget_usd, 0)) AS totalBudgetCeilingUsd,
           SUM(CASE WHEN total_estimated_actual_spend_usd IS NOT NULL THEN 1 ELSE 0 END) AS actualSpendEvidenceRunCount,
           COUNT(*) AS runCount
    FROM chat_eval_runs
    GROUP BY substr(generated_at, 1, 7)
    ORDER BY month DESC
    LIMIT 12
  `).all() as Array<{
    month: string;
    totalEstimatedActualSpendUsd: number;
    totalBudgetCeilingUsd: number;
    actualSpendEvidenceRunCount: number;
    runCount: number;
  }>;
  const months = rows.map((row) => ({
    month: row.month,
    totalEstimatedActualSpendUsd: round4(Number(row.totalEstimatedActualSpendUsd) || 0),
    totalBudgetCeilingUsd: round4(Number(row.totalBudgetCeilingUsd) || 0),
    actualSpendEvidenceRunCount: Number(row.actualSpendEvidenceRunCount) || 0,
    runCount: Number(row.runCount) || 0,
  }));
  const currentMonth = now.toISOString().slice(0, 7);
  const current = months.find((row) => row.month === currentMonth);
  return {
    months,
    currentMonthEstimatedActualSpendUsd: current?.totalEstimatedActualSpendUsd ?? 0,
    currentMonthBudgetCeilingUsd: current?.totalBudgetCeilingUsd ?? 0,
  };
}

/**
 * Read-only mirror of routing-accuracy's getLatestAcceptedAccuracySnapshot.
 * Kept local on purpose: importing routing-accuracy pulls the live routing
 * surfaces (classifier → provider client construction) into the portal
 * server import chain, and this dashboard must stay loadable without
 * provider config. accepted_accuracy_snapshots is only ever written by
 * routing-accuracy's storeAcceptedAccuracySnapshot (owner-gated
 * --accept-snapshot); the schema lives in migration 256 /
 * ensureRoutingCorpusTables.
 */
function readLatestAcceptedAccuracySnapshot(db: Database.Database): RoutingAccuracyReport | null {
  const row = db.prepare(`
    SELECT snapshot_json AS snapshotJson FROM accepted_accuracy_snapshots
    WHERE accepted = 1
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `).get() as { snapshotJson: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.snapshotJson) as RoutingAccuracyReport;
  } catch {
    return null;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────

function boundedInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}
