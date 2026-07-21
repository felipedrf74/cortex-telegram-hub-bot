// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Milestone 22 — weekly chat-quality digest.
 *
 * Builds a compact text digest of the production quality signals (eval runs,
 * online-eval sampler captures, routing-corpus labeling progress, finalizer
 * gate outcomes, ChatV2 readiness) with deltas vs the previous week where
 * durable history allows, and delivers it through the EXISTING operator-alert
 * channel (recordOperatorAlert → operator_alert_delivery cron → webhook).
 *
 * Alert-vs-digest routing:
 *   - the digest itself is ONE info-severity alert per week (dedupe key
 *     chat-quality-digest:<week-end-date>);
 *   - parity/fallback readiness regressions are emitted individually at
 *     their own (warning/critical) severity via the additive
 *     recordChatV2ParityFallbackRegressionAlerts path — never downgraded
 *     into the info digest.
 *
 * No LLM calls, no network, deterministic given the DB + clock.
 */

import type Database from 'better-sqlite3';
import {
  ensureChatEvalHistoryTables,
} from './chat-eval-history';
import {
  getChatQualityGateOutcomeCounters,
  type ChatQualityGateOutcome,
} from './chat-hybrid-metrics';
import { ensureRoutingCorpusTables, getRoutingCorpusProgress } from './routing-corpus';
import { ensureChatCoreV2OnlineEvalTables } from './chat-core-v2/online-eval-sampler';
import {
  buildChatV2ReadinessAlertInputs,
  buildChatV2ReadinessDashboard,
  recordChatV2ParityFallbackRegressionAlerts,
  selectChatV2ParityFallbackRegressionAlerts,
  type ChatV2CompletionReadinessReportLike,
} from './chatv2-readiness-alerts';
import {
  loadChatV2ReadinessReportFromFile,
} from './chat-quality-dashboard';
import type { RecordOperatorAlertInput, RecordOperatorAlertResult } from './operator-alerts';

export const CHAT_QUALITY_DIGEST_VERSION = 'chat-quality-digest@1.0.0';
export const CHAT_QUALITY_DIGEST_SOURCE = 'chat_quality_digest';
export const CHAT_QUALITY_DIGEST_RUNBOOK = 'docs/release/chat-quality-operations.md';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export interface ChatQualityDigestEvalModeWindow {
  runCount: number;
  averageScore: number | null;
  passRate: number | null;
  spendUsd: number;
}

export interface ChatQualityDigestEvalWindow extends ChatQualityDigestEvalModeWindow {
  /**
   * Mode split (M22): real_provider vs everything else, so fixture/local
   * runs cannot mask live-provider regressions inside the aggregate.
   */
  byMode: {
    realProvider: ChatQualityDigestEvalModeWindow;
    other: ChatQualityDigestEvalModeWindow;
  };
}

export interface ChatQualityDigestSamplerWindow {
  sampledCount: number;
  byReason: Record<string, number>;
}

export interface ChatQualityWeeklyDigest {
  version: string;
  generatedAt: string;
  weekStart: string;
  weekEnd: string;
  eval: {
    current: ChatQualityDigestEvalWindow;
    previous: ChatQualityDigestEvalWindow;
    deltas: {
      averageScore: number | null;
      passRate: number | null;
      spendUsd: number | null;
    };
  };
  sampler: {
    current: ChatQualityDigestSamplerWindow;
    previous: ChatQualityDigestSamplerWindow;
    delta: number | null;
  };
  corpus: {
    labeledThisWeek: number;
    labeledPreviousWeek: number;
    totalLabeled: number;
    totalPending: number;
  };
  /** Process-local counters since boot — no durable weekly history yet. */
  gateOutcomes: Readonly<Record<ChatQualityGateOutcome, number>>;
  readiness: {
    available: boolean;
    reason: string | null;
    blockedGateCount: number;
    parityFallbackRegressionCount: number;
  };
  text: string;
}

export interface BuildChatQualityWeeklyDigestOptions {
  now?: Date;
  readinessReport?: ChatV2CompletionReadinessReportLike | null;
  readinessUnavailableReason?: string;
}

export function buildChatQualityWeeklyDigest(
  db: Database.Database,
  options: BuildChatQualityWeeklyDigestOptions = {},
): ChatQualityWeeklyDigest {
  const now = options.now ?? new Date();
  ensureChatEvalHistoryTables(db);
  ensureRoutingCorpusTables(db);
  ensureChatCoreV2OnlineEvalTables(db);

  const weekEnd = now.toISOString();
  const weekStart = new Date(now.getTime() - WEEK_MS).toISOString();
  const prevStart = new Date(now.getTime() - 2 * WEEK_MS).toISOString();

  const evalCurrent = readEvalWindow(db, weekStart, weekEnd);
  const evalPrevious = readEvalWindow(db, prevStart, weekStart);
  const samplerCurrent = readSamplerWindow(db, weekStart, weekEnd);
  const samplerPrevious = readSamplerWindow(db, prevStart, weekStart);
  const corpus = readCorpusWindows(db, prevStart, weekStart, weekEnd);
  const gateOutcomes = getChatQualityGateOutcomeCounters();
  const readiness = summarizeReadiness(options);

  const digest: ChatQualityWeeklyDigest = {
    version: CHAT_QUALITY_DIGEST_VERSION,
    generatedAt: now.toISOString(),
    weekStart,
    weekEnd,
    eval: {
      current: evalCurrent,
      previous: evalPrevious,
      deltas: {
        averageScore: delta(evalCurrent.averageScore, evalPrevious.averageScore),
        passRate: delta(evalCurrent.passRate, evalPrevious.passRate),
        spendUsd: evalPrevious.runCount > 0 || evalCurrent.runCount > 0
          ? round4(evalCurrent.spendUsd - evalPrevious.spendUsd)
          : null,
      },
    },
    sampler: {
      current: samplerCurrent,
      previous: samplerPrevious,
      delta: samplerPrevious.sampledCount > 0 || samplerCurrent.sampledCount > 0
        ? samplerCurrent.sampledCount - samplerPrevious.sampledCount
        : null,
    },
    corpus,
    gateOutcomes,
    readiness,
    text: '',
  };
  digest.text = renderDigestText(digest);
  return digest;
}

/**
 * The single weekly info alert carrying the digest text.
 *
 * The operator-alert sanitizer flattens all whitespace (newlines included),
 * so the detail is rendered as a compact ' | '-separated summary that stays
 * readable after sanitization, while the full section lines ride in
 * metadata.sections (array-of-strings — same shape as sibling metadata usage
 * like the readiness alerts' evidenceSources; each line stays well under the
 * 300-char per-string metadata cap).
 */
export function buildChatQualityDigestAlertInput(
  digest: ChatQualityWeeklyDigest,
): RecordOperatorAlertInput {
  const sections = digest.text.split('\n');
  return {
    severity: 'info',
    source: CHAT_QUALITY_DIGEST_SOURCE,
    dedupeKey: `chat-quality-digest:${digest.weekEnd.slice(0, 10)}`,
    title: `Chat quality weekly digest (${digest.weekStart.slice(0, 10)} → ${digest.weekEnd.slice(0, 10)})`,
    detail: sections.join(' | '),
    metadata: {
      sections,
      version: digest.version,
      weekStart: digest.weekStart,
      weekEnd: digest.weekEnd,
      evalRunCount: digest.eval.current.runCount,
      evalAverageScore: digest.eval.current.averageScore,
      evalPassRate: digest.eval.current.passRate,
      evalSpendUsd: digest.eval.current.spendUsd,
      sampledCount: digest.sampler.current.sampledCount,
      labeledThisWeek: digest.corpus.labeledThisWeek,
      readinessBlockedGateCount: digest.readiness.blockedGateCount,
      parityFallbackRegressionCount: digest.readiness.parityFallbackRegressionCount,
    },
    owner: 'ai-quality',
    suspectedArea: 'chat_quality',
    userImpact: 'Informational weekly quality summary; no direct user impact.',
    runbookUrl: CHAT_QUALITY_DIGEST_RUNBOOK,
  };
}

export interface RunChatQualityWeeklyDigestOptions {
  db?: Database.Database;
  now?: Date;
  /** Explicit report wins; undefined falls back to the artifact file. */
  readinessReport?: ChatV2CompletionReadinessReportLike | null;
  readinessReportPath?: string;
}

export interface RunChatQualityWeeklyDigestResult {
  digest: ChatQualityWeeklyDigest;
  digestRecorded: boolean;
  regressionAlertCount: number;
  regressionResults: RecordOperatorAlertResult[];
}

/**
 * Scheduler entry point: build the digest, record it as one info operator
 * alert, and immediately record any parity/fallback readiness regressions at
 * their own severity. Delivery itself stays with the existing
 * operator_alert_delivery job.
 */
export async function runChatQualityWeeklyDigest(
  options: RunChatQualityWeeklyDigestOptions = {},
): Promise<RunChatQualityWeeklyDigestResult> {
  // Lazy DB/alert imports keep this module loadable in dry-run/test contexts
  // without backend config (same pattern as chatv2-readiness-alerts).
  const db = options.db ?? (await import('./database')).getDb();
  const readiness = options.readinessReport !== undefined
    ? { report: options.readinessReport, reason: options.readinessReport ? null : 'no readiness report provided' }
    : loadChatV2ReadinessReportFromFile(options.readinessReportPath);

  const digest = buildChatQualityWeeklyDigest(db, {
    now: options.now,
    readinessReport: readiness.report,
    readinessUnavailableReason: readiness.reason ?? undefined,
  });

  const { recordOperatorAlert } = await import('./operator-alerts');
  const digestResult = recordOperatorAlert(buildChatQualityDigestAlertInput(digest));

  // Regression recording flows through the EXPORTED wrapper (single path,
  // no dead export) — it selects the parity/fallback subset and records it.
  let regressionResults: RecordOperatorAlertResult[] = [];
  if (readiness.report) {
    const recorded = await recordChatV2ParityFallbackRegressionAlerts(readiness.report);
    regressionResults = recorded.results;
  }

  return {
    digest,
    digestRecorded: digestResult.ok === true,
    regressionAlertCount: regressionResults.length,
    regressionResults,
  };
}

// ─── Window readers ───────────────────────────────────────────────

function readEvalWindow(
  db: Database.Database,
  startIso: string,
  endIso: string,
): ChatQualityDigestEvalWindow {
  const rows = db.prepare(`
    SELECT CASE WHEN mode = 'real_provider' THEN 'real_provider' ELSE 'other' END AS modeGroup,
           COUNT(*) AS runCount,
           AVG(average_score) AS averageScore,
           AVG(passed) AS passRate,
           SUM(COALESCE(budget_usd, 0)) AS spendUsd
    FROM chat_eval_runs
    WHERE generated_at >= ? AND generated_at < ?
    GROUP BY modeGroup
  `).all(startIso, endIso) as Array<{
    modeGroup: 'real_provider' | 'other';
    runCount: number;
    averageScore: number | null;
    passRate: number | null;
    spendUsd: number | null;
  }>;

  const toModeWindow = (row?: (typeof rows)[number]): ChatQualityDigestEvalModeWindow => {
    const runCount = Number(row?.runCount) || 0;
    return {
      runCount,
      averageScore: runCount > 0 && row?.averageScore != null ? round4(Number(row.averageScore)) : null,
      passRate: runCount > 0 && row?.passRate != null ? round4(Number(row.passRate)) : null,
      spendUsd: round4(Number(row?.spendUsd) || 0),
    };
  };

  const realProvider = toModeWindow(rows.find((row) => row.modeGroup === 'real_provider'));
  const other = toModeWindow(rows.find((row) => row.modeGroup === 'other'));
  const runCount = realProvider.runCount + other.runCount;
  const weighted = (left: ChatQualityDigestEvalModeWindow, right: ChatQualityDigestEvalModeWindow, key: 'averageScore' | 'passRate'): number | null => {
    if (runCount === 0) return null;
    return round4(
      (((left[key] ?? 0) * left.runCount) + ((right[key] ?? 0) * right.runCount)) / runCount,
    );
  };
  return {
    runCount,
    averageScore: weighted(realProvider, other, 'averageScore'),
    passRate: weighted(realProvider, other, 'passRate'),
    spendUsd: round4(realProvider.spendUsd + other.spendUsd),
    byMode: { realProvider, other },
  };
}

function readSamplerWindow(
  db: Database.Database,
  startIso: string,
  endIso: string,
): ChatQualityDigestSamplerWindow {
  const rows = db.prepare(`
    SELECT reason, COUNT(*) AS count
    FROM chat_v2_online_eval_samples
    WHERE status = 'sampled' AND created_at >= ? AND created_at < ?
    GROUP BY reason
    ORDER BY count DESC, reason ASC
  `).all(startIso, endIso) as Array<{ reason: string; count: number }>;
  const byReason: Record<string, number> = {};
  let sampledCount = 0;
  for (const row of rows) {
    byReason[row.reason] = row.count;
    sampledCount += row.count;
  }
  return { sampledCount, byReason };
}

function readCorpusWindows(
  db: Database.Database,
  prevStartIso: string,
  weekStartIso: string,
  weekEndIso: string,
): ChatQualityWeeklyDigest['corpus'] {
  // labeled_at is stored in SQLite datetime('now') format
  // ('YYYY-MM-DD HH:MM:SS'); normalize the ISO boundaries to compare
  // lexically in the same space.
  const labeledInWindow = db.prepare(`
    SELECT COUNT(*) AS count
    FROM routing_corpus_items
    WHERE label_status = 'labeled' AND labeled_at >= ? AND labeled_at < ?
  `);
  const progress = getRoutingCorpusProgress(db);
  return {
    labeledThisWeek: Number((labeledInWindow.get(toSqlUtc(weekStartIso), toSqlUtc(weekEndIso)) as { count: number }).count) || 0,
    labeledPreviousWeek: Number((labeledInWindow.get(toSqlUtc(prevStartIso), toSqlUtc(weekStartIso)) as { count: number }).count) || 0,
    totalLabeled: progress.labeled,
    totalPending: progress.pending,
  };
}

function summarizeReadiness(
  options: BuildChatQualityWeeklyDigestOptions,
): ChatQualityWeeklyDigest['readiness'] {
  const report = options.readinessReport ?? null;
  if (!report) {
    return {
      available: false,
      reason: options.readinessUnavailableReason ?? 'no readiness report provided',
      blockedGateCount: 0,
      parityFallbackRegressionCount: 0,
    };
  }
  const rows = buildChatV2ReadinessDashboard(report);
  const blockedGateCount = rows.reduce((sum, row) => sum + row.blockedGateCount, 0);
  const parityFallbackRegressionCount = selectChatV2ParityFallbackRegressionAlerts(
    buildChatV2ReadinessAlertInputs(report),
  ).length;
  return { available: true, reason: null, blockedGateCount, parityFallbackRegressionCount };
}

// ─── Rendering ────────────────────────────────────────────────────

function renderDigestText(digest: ChatQualityWeeklyDigest): string {
  const lines: string[] = [];
  lines.push(`Chat quality digest ${digest.weekStart.slice(0, 10)} → ${digest.weekEnd.slice(0, 10)}.`);

  const evalWindow = digest.eval.current;
  if (evalWindow.runCount === 0) {
    lines.push('Evals: no runs recorded this week.');
  } else {
    const parts = [
      `Evals: ${evalWindow.runCount} run(s)`,
      `avg score ${formatNumber(evalWindow.averageScore)}${formatDelta(digest.eval.deltas.averageScore)}`,
      `pass rate ${formatNumber(evalWindow.passRate)}${formatDelta(digest.eval.deltas.passRate)}`,
      `spend $${formatNumber(evalWindow.spendUsd)}${formatDelta(digest.eval.deltas.spendUsd, '$')}`,
    ];
    lines.push(`${parts.join(', ')}.`);
    lines.push(
      `Evals by mode: ${formatModeWindow('real_provider', evalWindow.byMode.realProvider)}; `
      + `${formatModeWindow('other', evalWindow.byMode.other)}.`,
    );
  }

  const sampler = digest.sampler.current;
  if (sampler.sampledCount === 0) {
    lines.push('Sampler: no captures this week.');
  } else {
    const topReasons = Object.entries(sampler.byReason)
      .sort((left, right) => right[1] - left[1])
      .slice(0, 3)
      .map(([reason, count]) => `${reason}=${count}`)
      .join(' ');
    const deltaText = digest.sampler.delta == null ? '' : ` (${signed(digest.sampler.delta)} vs prev week)`;
    lines.push(`Sampler: ${sampler.sampledCount} capture(s)${deltaText}; top reasons ${topReasons}.`);
  }

  lines.push(
    `Corpus: ${digest.corpus.labeledThisWeek} labeled this week `
    + `(prev ${digest.corpus.labeledPreviousWeek}); `
    + `${digest.corpus.totalLabeled} labeled / ${digest.corpus.totalPending} pending total.`,
  );

  const outcomes = Object.entries(digest.gateOutcomes)
    .filter(([, count]) => count > 0)
    .map(([outcome, count]) => `${outcome}=${count}`)
    .join(' ');
  lines.push(`Finalizer gate outcomes since boot: ${outcomes || 'none recorded'}.`);

  if (!digest.readiness.available) {
    lines.push(`Readiness: unavailable (${digest.readiness.reason}).`);
  } else if (digest.readiness.blockedGateCount === 0) {
    lines.push('Readiness: all reported gates passing.');
  } else {
    lines.push(
      `Readiness: ${digest.readiness.blockedGateCount} blocked gate(s), `
      + `${digest.readiness.parityFallbackRegressionCount} parity/fallback regression(s) `
      + '(regressions alerted separately at their own severity).',
    );
  }

  return lines.join('\n');
}

function formatModeWindow(label: string, window: ChatQualityDigestEvalModeWindow): string {
  if (window.runCount === 0) return `${label} none`;
  return `${label} ${window.runCount} run(s) `
    + `(avg ${formatNumber(window.averageScore)}, pass ${formatNumber(window.passRate)}, `
    + `spend $${formatNumber(window.spendUsd)})`;
}

function formatNumber(value: number | null): string {
  if (value == null) return 'n/a';
  return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

function formatDelta(value: number | null, prefix = ''): string {
  if (value == null) return '';
  return ` (${signed(value, prefix)} vs prev week)`;
}

function signed(value: number, prefix = ''): string {
  const rendered = `${prefix}${formatNumber(Math.abs(round4(value)))}`;
  return value >= 0 ? `+${rendered}` : `-${rendered}`;
}

function delta(current: number | null, previous: number | null): number | null {
  if (current == null || previous == null) return null;
  return round4(current - previous);
}

function toSqlUtc(iso: string): string {
  return iso.slice(0, 19).replace('T', ' ');
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}
