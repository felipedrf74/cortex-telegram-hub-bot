// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import {
  formatChatEvaluationResultsMarkdown,
  runChatEvaluationSuite,
  type ChatEvalMode,
  type ChatEvaluationSuiteResult,
} from '../src/services/chat-evaluation-harness';
import { HttpExecutor } from '../src/services/chat-eval-executor';
import {
  chatEvalEvidenceRawTextFindings,
  redactChatEvalEvidence,
} from '../src/services/chat-eval-evidence-redaction';
import {
  persistChatEvalRun,
  type ChatEvalRunCostAttestation,
} from '../src/services/chat-eval-history';
import {
  CHAT_LIVE_EVAL_CONTRACT_VERSION,
  CHAT_LIVE_EVAL_LOCAL_BUDGET,
  CHAT_LIVE_EVAL_REAL_BUDGET,
  type ChatLiveEvalRunEvidence,
} from '../src/services/chat-live-evaluation-contract';
import type { ChatEvalJudgeUsageAttestation } from '../src/services/chat-eval-judge-runtime';
import {
  postChatEvalHistoryWithRecovery,
  postChatEvalPortalPayload,
} from '../src/services/chat-eval-portal-retry';

export interface CliOptions {
  mode: ChatEvalMode;
  outDir: string;
  json: boolean;
  markdown: boolean;
  persistDbPath?: string;
  portalUrl?: string;
  portalToken?: string;
  budgetUsd?: number;
  /** Live modes only: base URL of the real backend to replay against. */
  baseUrl?: string;
  /** Name of the env var holding the eval Bearer token (never the token itself). */
  authTokenEnv?: string;
}

export const DEFAULT_AUTH_TOKEN_ENV = 'CHAT_EVAL_AUTH_TOKEN';

export interface EvidenceCheckout {
  gitBranch?: string;
  gitCommit: string;
}

export interface EvidenceGitReader {
  /** Read a required git command. Empty stdout is valid; command failure throws. */
  read(args: string[]): string;
  /** Return whether an exact git ref exists without treating absence as an error. */
  hasRef(ref: string): boolean;
}

const defaultEvidenceGitReader: EvidenceGitReader = {
  read(args) {
    return execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  },
  hasRef(ref) {
    try {
      execFileSync('git', ['rev-parse', '--verify', '--quiet', ref], {
        encoding: 'utf8',
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      return true;
    } catch {
      return false;
    }
  },
};

/**
 * Release evidence must describe committed bytes, never a mutable working
 * tree. Every live run is evidence-bearing, as is a fixture run explicitly
 * persisted to SQLite or the portal. Refuse staged, unstaged, untracked, and
 * in-progress merge state before any evaluator/provider work begins.
 */
export function attestEvidenceCheckout(
  options: CliOptions,
  git: EvidenceGitReader = defaultEvidenceGitReader,
): EvidenceCheckout | undefined {
  const evidenceBearing = options.mode !== 'fixture'
    || Boolean(options.persistDbPath)
    || Boolean(options.portalUrl);
  if (!evidenceBearing) return undefined;

  let insideWorktree: string;
  let status: string;
  let gitCommit: string;
  let gitBranch: string;
  try {
    insideWorktree = git.read(['rev-parse', '--is-inside-work-tree']);
    if (git.hasRef('MERGE_HEAD')) {
      throw new Error('chat eval evidence refuses an in-progress merge; finish or abort the merge first');
    }
    status = git.read(['status', '--porcelain=v1', '--untracked-files=all']);
    gitCommit = git.read(['rev-parse', 'HEAD']);
    gitBranch = git.read(['branch', '--show-current']);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/chat eval evidence refuses/.test(message)) throw error;
    throw new Error(`chat eval evidence requires a readable git checkout: ${message}`);
  }

  if (insideWorktree !== 'true') {
    throw new Error('chat eval evidence requires a git worktree');
  }
  if (status.trim()) {
    throw new Error(
      'chat eval evidence requires a clean checkout with no staged, unstaged, or untracked files',
    );
  }
  if (!/^[0-9a-f]{40}$/.test(gitCommit)) {
    throw new Error('chat eval evidence requires the full 40-character lowercase git SHA');
  }

  return {
    ...(gitBranch ? { gitBranch } : {}),
    gitCommit,
  };
}

export interface LiveRunPlan {
  /** Present only for live modes; replays turns against the real backend. */
  executor?: HttpExecutor;
  /** Armed ONLY when mode is real_provider AND the live executor exists. */
  judgeOptions?: { maxUsd: number };
}

/**
 * Guard for live runs: local_engine and real_provider REQUIRE --base-url so
 * the suite replays the REAL /message pipeline — without it the suite would
 * fall back to the FixtureExecutor and (in real_provider mode) spend judge
 * budget scoring canned synthetic strings. Tokens are read from an env var
 * named via --auth-token-env; they never appear in argv.
 */
export function buildRunPlan(
  options: CliOptions,
  env: NodeJS.ProcessEnv = process.env,
  runId = 'chat-eval-plan-validation',
): LiveRunPlan {
  if (options.mode === 'fixture') return {};
  if (!options.baseUrl) {
    throw new Error(`${options.mode} eval requires --base-url <backend url>: without it the suite would replay synthetic fixtures, not the real /message pipeline`);
  }
  const tokenEnv = options.authTokenEnv ?? DEFAULT_AUTH_TOKEN_ENV;
  if (!env[tokenEnv]) {
    throw new Error(`${options.mode} eval requires an auth token in env ${tokenEnv} (set --auth-token-env to use a different variable; never pass tokens in argv)`);
  }
  const executor = new HttpExecutor({
    mode: options.mode,
    baseUrl: options.baseUrl,
    authToken: () => env[tokenEnv] ?? '',
    runContract: {
      version: CHAT_LIVE_EVAL_CONTRACT_VERSION,
      runId,
      budget: options.mode === 'local_engine'
        ? CHAT_LIVE_EVAL_LOCAL_BUDGET
        : CHAT_LIVE_EVAL_REAL_BUDGET,
    },
  });
  const judgeOptions = options.mode === 'real_provider'
    ? { maxUsd: CHAT_LIVE_EVAL_REAL_BUDGET.judgeCeilingUsd }
    : undefined;
  return { executor, ...(judgeOptions ? { judgeOptions } : {}) };
}

export async function runChatEvalLiveCli(
  args: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const options = parseArgs(args, env);
  if (
    options.mode === 'real_provider'
    && env.NEXUS_CONTENT_LIVE_EVAL_VERIFIER_RUNTIME !== '1'
  ) {
    throw new Error(
      'real_provider eval requires the pre-import verifier bootstrap; run scripts/run-chat-eval-live.ts',
    );
  }
  const checkout = attestEvidenceCheckout(options);
  // Judge cost law composes with the CLI refusals: real_provider requires a
  // positive budget AND a live --base-url executor (buildRunPlan throws
  // otherwise), and that same budget is the judge's hard USD ceiling — the
  // judge aborts remaining scenario calls once its projected spend would
  // exceed it. Fixture/local_engine runs pass no judge options and therefore
  // make zero judge LLM calls.
  const generatedAt = new Date().toISOString();
  const runId = `chat-eval-${generatedAt.replace(/[:.]/g, '-')}`;
  const plan = buildRunPlan(options, env, runId);
  const preflight = plan.executor ? await plan.executor.preflight() : undefined;
  mkdirSync(options.outDir, { recursive: true });

  const executeSuite = () => runChatEvaluationSuite({
    mode: options.mode,
    generatedAt,
    ...(plan.executor ? { executor: plan.executor } : {}),
    ...(plan.judgeOptions ? { judgeOptions: plan.judgeOptions } : {}),
  });
  let result: ChatEvaluationSuiteResult;
  let judgeUsage: ChatEvalJudgeUsageAttestation | undefined;
  let judgeLedgerPath: string | undefined;
  if (options.mode === 'real_provider') {
    const { runWithChatEvalJudgeRuntime } = await import('../src/services/chat-eval-judge-runtime');
    const governed = await runWithChatEvalJudgeRuntime({
      runId,
      judgeBudgetUsd: CHAT_LIVE_EVAL_REAL_BUDGET.judgeCeilingUsd,
      execute: executeSuite,
    });
    result = governed.result;
    judgeUsage = governed.judgeUsage;
    judgeLedgerPath = governed.ledgerPath;
    console.log(
      `[chat-eval-live] judge-ledger runId=${runId} path=${governed.ledgerPath} sha256=${governed.judgeUsage.usageDatabaseSha256}`,
    );
  } else {
    result = await executeSuite();
  }
  const targetEvidence = plan.executor ? await plan.executor.readRunEvidence() : undefined;
  const costAttestation = targetEvidence
    ? buildRunCostAttestation(result, targetEvidence, judgeUsage)
    : undefined;
  if (targetEvidence && costAttestation) {
    assertCompleteLiveRunEvidence(result, targetEvidence, costAttestation);
  }
  const reportBase = path.join(options.outDir, runId);
  const jsonReportPath = options.json ? `${reportBase}.json` : undefined;
  const markdownReportPath = options.markdown ? `${reportBase}.md` : undefined;
  const packageVersion = readPackageVersion();
  const finalCheckout = attestEvidenceCheckout(options);
  if (checkout && finalCheckout && (
    checkout.gitCommit !== finalCheckout.gitCommit
    || checkout.gitBranch !== finalCheckout.gitBranch
  )) {
    throw new Error('chat eval evidence checkout identity changed during the run; rerun from a stable clean checkout');
  }
  const gitBranch = checkout?.gitBranch ?? readGit(['branch', '--show-current']);
  const gitCommit = checkout?.gitCommit ?? readGit(['rev-parse', 'HEAD']);
  const persistOptions = {
    runId,
    packageVersion,
    gitBranch,
    gitCommit,
    jsonReportPath,
    markdownReportPath,
    budgetUsd: costAttestation?.totalCeilingUsd ?? options.budgetUsd ?? null,
    costAttestation: costAttestation ?? null,
    preflightAttestation: preflight ?? null,
    productionDataUsed: false,
    // Judge runs report their actual provider-call count; without a judge the
    // historical boolean (1 for real_provider, 0 otherwise) is preserved.
    realProviderCalls: result.judge ? result.judge.calls : result.mode === 'real_provider',
  };

  if (jsonReportPath) {
    const rawReport = {
      ...result,
      ...(preflight ? { preflightAttestation: preflight } : {}),
      ...(costAttestation ? { costAttestation } : {}),
    };
    // The full report carries raw user turns, model responses and judge
    // rationales. Keep those private and publish only the redacted projection:
    // `docs/release/eval-evidence/` is committed, and repository law forbids
    // raw provider payloads or user content in Git.
    const rawBody = `${JSON.stringify(rawReport, null, 2)}\n`;
    const privateDir = path.join('.local', 'chat-eval', runId);
    mkdirSync(privateDir, { recursive: true, mode: 0o700 });
    const rawPath = path.join(privateDir, 'raw-report.json');
    writeFileSync(rawPath, rawBody, { mode: 0o600 });

    const sourceSha256 = createHash('sha256').update(rawBody).digest('hex');
    const { redacted, manifest } = redactChatEvalEvidence(rawReport, sourceSha256);
    const publishable = { ...(redacted as Record<string, unknown>), redaction: manifest };
    const findings = chatEvalEvidenceRawTextFindings(publishable);
    if (findings.length > 0) {
      throw new Error(
        'chat eval evidence refuses to publish unclassified free text at: '
        + findings.map((finding) => `${finding.path} x${finding.occurrences}`).join(', '),
      );
    }
    writeFileSync(jsonReportPath, `${JSON.stringify(publishable, null, 2)}\n`);
    console.log(`[chat-eval-live] private-raw-report path=${rawPath} sha256=${sourceSha256}`);
  }
  if (markdownReportPath) {
    writeFileSync(markdownReportPath, formatChatEvaluationResultsMarkdown(result));
  }
  if (options.persistDbPath) {
    mkdirSync(path.dirname(options.persistDbPath), { recursive: true });
    persistChatEvalRun(result, {
      databasePath: options.persistDbPath,
      ...persistOptions,
    });
  }
  if (options.portalUrl && options.portalToken) {
    const portalPayload = { result, ...persistOptions };
    if (result.mode === 'real_provider') {
      if (!judgeLedgerPath) {
        throw new Error('real_provider portal evidence is missing its private judge run directory');
      }
      const recovery = await postChatEvalHistoryWithRecovery({
        runDirectory: path.dirname(judgeLedgerPath),
        portalUrl: options.portalUrl,
        portalToken: options.portalToken,
        payload: portalPayload,
      });
      console.log(
        `[chat-eval-live] portal-retry-payload path=${recovery.payloadPath} sha256=${recovery.sha256}`,
      );
    } else {
      await postChatEvalPortalPayload({
        portalUrl: options.portalUrl,
        portalToken: options.portalToken,
        rawBody: JSON.stringify(portalPayload),
      });
    }
  }

  const status = result.passed ? 'PASS' : 'FAIL';
  console.log(`[chat-eval-live] ${status} mode=${result.mode} runId=${runId} average=${result.averageScore.toFixed(2)} scenarios=${result.scenarioCount}`);
  console.log(`[chat-eval-live] statusCounts pass=${result.statusCounts.pass} partial=${result.statusCounts.partial} fail=${result.statusCounts.fail} blocked=${result.statusCounts.blocked}`);
  if (result.judge) {
    console.log(`[chat-eval-live] judge model=${result.judge.model} calls=${result.judge.calls}/${result.judge.callBudget} estimatedSpendUsd=${result.judge.estimatedSpendUsd.toFixed(6)} maxUsd=${result.judge.maxUsd} aborted=${result.judge.aborted}`);
    if (result.judge.abortReason) {
      console.error(`[chat-eval-live] JUDGE ABORTED: ${result.judge.abortReason} — every judge scenario was blocked (provider outage or malformed output); llm_judge dims were skipped honestly`);
    }
  }
  if (jsonReportPath) console.log(`[chat-eval-live] json=${jsonReportPath}`);
  if (markdownReportPath) console.log(`[chat-eval-live] markdown=${markdownReportPath}`);
  if (options.persistDbPath) console.log(`[chat-eval-live] db=${options.persistDbPath}`);

  if (!result.passed) {
    process.exitCode = 1;
  }
}

export function parseArgs(args: string[], env: NodeJS.ProcessEnv = process.env): CliOptions {
  const options: CliOptions = {
    // Safe default: bare invocation runs the zero-cost fixture suite; live
    // modes must be requested explicitly.
    mode: parseMode(env.CHAT_EVAL_MODE) ?? 'fixture',
    outDir: env.CHAT_EVAL_OUT_DIR || 'reports/chat-eval',
    json: true,
    markdown: true,
    persistDbPath: env.CHAT_EVAL_PERSIST_DB === '1'
      ? (env.CHAT_EVAL_DB_PATH || 'reports/chat-eval/chat-eval-history.sqlite')
      : undefined,
    portalUrl: env.CHAT_EVAL_PORTAL_URL,
    portalToken: env.CHAT_EVAL_PORTAL_TOKEN,
    budgetUsd: parseNumber(env.EVAL_MAX_USD_PER_RUN),
    baseUrl: env.CHAT_EVAL_BASE_URL,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];
    if (arg === '--mode') {
      const mode = parseMode(next);
      if (!mode) throw new Error(`Unsupported --mode ${next ?? ''}`);
      options.mode = mode;
      index += 1;
    } else if (arg === '--out-dir') {
      options.outDir = requireValue(arg, next);
      index += 1;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--no-json') {
      options.json = false;
    } else if (arg === '--markdown') {
      options.markdown = true;
    } else if (arg === '--no-markdown') {
      options.markdown = false;
    } else if (arg === '--persist-db') {
      if (next && !next.startsWith('--')) {
        options.persistDbPath = next;
        index += 1;
      } else {
        options.persistDbPath = env.CHAT_EVAL_DB_PATH || 'reports/chat-eval/chat-eval-history.sqlite';
      }
    } else if (arg === '--portal-url') {
      options.portalUrl = requireValue(arg, next);
      index += 1;
    } else if (arg === '--budget-usd') {
      options.budgetUsd = parseNumber(requireValue(arg, next));
      index += 1;
    } else if (arg === '--base-url') {
      options.baseUrl = requireValue(arg, next);
      index += 1;
    } else if (arg === '--auth-token-env') {
      options.authTokenEnv = requireValue(arg, next);
      index += 1;
    } else {
      throw new Error(`Unknown argument ${arg}`);
    }
  }

  if (options.mode === 'real_provider' && options.budgetUsd !== CHAT_LIVE_EVAL_REAL_BUDGET.totalCeilingUsd) {
    throw new Error('real_provider eval requires --budget-usd exactly 0.50 (or EVAL_MAX_USD_PER_RUN=0.50)');
  }
  if (Boolean(options.portalUrl) !== Boolean(options.portalToken)) {
    throw new Error(
      'portal reporting requires CHAT_EVAL_PORTAL_TOKEN plus CHAT_EVAL_PORTAL_URL or --portal-url',
    );
  }
  return options;
}

export function buildRunCostAttestation(
  result: ChatEvaluationSuiteResult,
  targetEvidence: ChatLiveEvalRunEvidence,
  judgeUsage?: ChatEvalJudgeUsageAttestation,
): ChatEvalRunCostAttestation {
  const judgeEstimatedSpendUsd = Number(result.judge?.estimatedSpendUsd ?? 0);
  if (result.mode === 'real_provider' && !judgeUsage) {
    throw new Error('real_provider eval requires a durable judge usage attestation');
  }
  if (result.mode !== 'real_provider' && judgeUsage) {
    throw new Error('judge usage evidence is allowed only for real_provider evals');
  }

  const judgeActualSpendUsd = Number(judgeUsage?.actualSpendUsd ?? 0);
  const judgeReservedAttemptCeilingUsd = Number(
    judgeUsage?.reservedAttemptCeilingUsd ?? 0,
  );
  const judgeCommittedCeilingUsd = Number(judgeUsage?.committedCeilingUsd ?? 0);
  const totalActualSpendUsd = roundUsd(
    targetEvidence.target.actualSpendUsd + judgeActualSpendUsd,
  );
  const totalConservativeCommitmentUsd = Number(
    (targetEvidence.target.committedCeilingUsd + judgeCommittedCeilingUsd).toFixed(8),
  );
  const attestation: ChatEvalRunCostAttestation = {
    contractVersion: targetEvidence.version,
    attested: targetEvidence.attested,
    reasons: targetEvidence.reasons,
    totalCeilingUsd: targetEvidence.totalCeilingUsd,
    targetCeilingUsd: targetEvidence.target.ceilingUsd,
    judgeCeilingUsd: targetEvidence.judgeCeilingUsd,
    targetActualSpendUsd: targetEvidence.target.actualSpendUsd,
    targetReservedAttemptCeilingUsd: targetEvidence.target.reservedAttemptCeilingUsd,
    targetCommittedCeilingUsd: targetEvidence.target.committedCeilingUsd,
    judgeEstimatedSpendUsd,
    judgeActualSpendUsd,
    judgeReservedAttemptCeilingUsd,
    judgeCommittedCeilingUsd,
    judgeUsageCallCount: judgeUsage?.usageCallCount ?? 0,
    judgeProviderAttemptCount: judgeUsage?.providerAttemptCount ?? 0,
    judgeProviders: judgeUsage?.providers ?? [],
    judgeModels: judgeUsage?.models ?? [],
    judgeUnresolvedPricingCount: judgeUsage?.unresolvedPricingCount ?? 0,
    judgeUsageDatabaseSha256: judgeUsage?.usageDatabaseSha256 ?? null,
    totalActualSpendUsd,
    // Preserve the flattened historical column name while reporting the
    // durable actual total instead of treating an estimate as actual spend.
    totalEstimatedActualSpendUsd: totalActualSpendUsd,
    totalConservativeCommitmentUsd,
    targetUsageCallCount: targetEvidence.target.usageCallCount,
    targetProviderAttemptCount: targetEvidence.target.providerAttemptCount,
    targetProviders: targetEvidence.target.providers,
    unresolvedPricingCount: targetEvidence.target.unresolvedPricingCount,
    preparation: targetEvidence.preparation,
  };
  assertCoherentJudgeUsage(result, attestation);
  return attestation;
}

function assertCompleteLiveRunEvidence(
  result: ChatEvaluationSuiteResult,
  evidence: ChatLiveEvalRunEvidence,
  cost: ChatEvalRunCostAttestation,
): void {
  if (!evidence.attested) {
    throw new Error(`Chat eval target evidence failed attestation: ${evidence.reasons.join(', ') || 'unknown'}`);
  }
  const expectedScenarios = result.dayToDay.scenarios.map((scenario) => scenario.scenarioId).sort();
  const preparedScenarios = [...evidence.preparation.scenarioIds].sort();
  if (JSON.stringify(expectedScenarios) !== JSON.stringify(preparedScenarios)) {
    throw new Error(`Chat eval scenario preparation evidence mismatch: expected ${expectedScenarios.join(',')} got ${preparedScenarios.join(',')}`);
  }
  const judgeSpend = Number(result.judge?.estimatedSpendUsd ?? 0);
  if (judgeSpend > evidence.judgeCeilingUsd + Number.EPSILON) {
    throw new Error('Chat eval judge estimated spend exceeded the governed judge split');
  }
  if (
    cost.totalActualSpendUsd > evidence.totalCeilingUsd + Number.EPSILON
    || cost.totalConservativeCommitmentUsd > evidence.totalCeilingUsd + Number.EPSILON
    || cost.targetCommittedCeilingUsd > evidence.targetCeilingUsd + Number.EPSILON
    || cost.judgeCommittedCeilingUsd > evidence.judgeCeilingUsd + Number.EPSILON
  ) {
    throw new Error('Chat eval actual or conservative committed spend exceeded a governed ceiling');
  }
}

function assertCoherentJudgeUsage(
  result: ChatEvaluationSuiteResult,
  cost: ChatEvalRunCostAttestation,
): void {
  if (result.mode !== 'real_provider') {
    if (
      cost.judgeEstimatedSpendUsd !== 0
      || cost.judgeActualSpendUsd !== 0
      || cost.judgeReservedAttemptCeilingUsd !== 0
      || cost.judgeCommittedCeilingUsd !== 0
      || cost.judgeUsageCallCount !== 0
      || cost.judgeProviderAttemptCount !== 0
      || cost.judgeProviders.length !== 0
      || cost.judgeModels.length !== 0
      || cost.judgeUsageDatabaseSha256 !== null
    ) {
      throw new Error('non-provider eval unexpectedly contained judge usage evidence');
    }
    return;
  }

  const scenarioCount = result.scenarioCount;
  if (
    !result.judge
    || result.judge.aborted
    || result.judge.calls !== scenarioCount
    || cost.judgeUsageCallCount !== scenarioCount
    || cost.judgeProviderAttemptCount !== scenarioCount
    || JSON.stringify(cost.judgeProviders) !== JSON.stringify(['gemini'])
    || JSON.stringify(cost.judgeModels) !== JSON.stringify(['gemini-2.5-flash-lite'])
    || cost.judgeUnresolvedPricingCount !== 0
    || !/^[a-f0-9]{64}$/.test(cost.judgeUsageDatabaseSha256 ?? '')
    || cost.judgeActualSpendUsd <= 0
    || cost.judgeReservedAttemptCeilingUsd <= 0
    || !sameUsd(cost.judgeReservedAttemptCeilingUsd, cost.judgeEstimatedSpendUsd)
    || !sameUsd(
      cost.judgeCommittedCeilingUsd,
      cost.judgeActualSpendUsd + cost.judgeReservedAttemptCeilingUsd,
    )
    || cost.judgeActualSpendUsd > cost.judgeReservedAttemptCeilingUsd + Number.EPSILON
  ) {
    throw new Error('real_provider judge usage evidence is incomplete or incoherent');
  }
}

function roundUsd(value: number): number {
  return Number(value.toFixed(8));
}

function sameUsd(left: number, right: number): boolean {
  return Math.abs(left - right) <= 1e-8;
}

function parseMode(raw: string | undefined): ChatEvalMode | null {
  return raw === 'fixture' || raw === 'local_engine' || raw === 'real_provider' ? raw : null;
}

function parseNumber(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function requireValue(flag: string, value: string | undefined): string {
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function readPackageVersion(): string | undefined {
  try {
    const packageJson = JSON.parse(readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8')) as { version?: string };
    return packageJson.version;
  } catch {
    return undefined;
  }
}

function readGit(args: string[]): string | undefined {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined;
  } catch {
    return undefined;
  }
}
