// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { execFileSync } from 'child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import {
  formatChatEvaluationResultsMarkdown,
  runChatEvaluationSuite,
  type ChatEvalMode,
  type ChatEvaluationSuiteResult,
} from '../src/services/chat-evaluation-harness';
import { HttpExecutor } from '../src/services/chat-eval-executor';
import { persistChatEvalRun } from '../src/services/chat-eval-history';

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
export function buildRunPlan(options: CliOptions, env: NodeJS.ProcessEnv = process.env): LiveRunPlan {
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
  });
  const judgeOptions = options.mode === 'real_provider' && options.budgetUsd
    ? { maxUsd: options.budgetUsd }
    : undefined;
  return { executor, ...(judgeOptions ? { judgeOptions } : {}) };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  // Judge cost law composes with the CLI refusals: real_provider requires a
  // positive budget AND a live --base-url executor (buildRunPlan throws
  // otherwise), and that same budget is the judge's hard USD ceiling — the
  // judge aborts remaining scenario calls once its projected spend would
  // exceed it. Fixture/local_engine runs pass no judge options and therefore
  // make zero judge LLM calls.
  const plan = buildRunPlan(options);
  mkdirSync(options.outDir, { recursive: true });

  const generatedAt = new Date().toISOString();
  const result = await runChatEvaluationSuite({
    mode: options.mode,
    generatedAt,
    ...(plan.executor ? { executor: plan.executor } : {}),
    ...(plan.judgeOptions ? { judgeOptions: plan.judgeOptions } : {}),
  });
  const runId = `chat-eval-${generatedAt.replace(/[:.]/g, '-')}`;
  const reportBase = path.join(options.outDir, runId);
  const jsonReportPath = options.json ? `${reportBase}.json` : undefined;
  const markdownReportPath = options.markdown ? `${reportBase}.md` : undefined;
  const packageVersion = readPackageVersion();
  const gitBranch = readGit(['branch', '--show-current']);
  const gitCommit = readGit(['rev-parse', '--short=12', 'HEAD']);
  const persistOptions = {
    runId,
    packageVersion,
    gitBranch,
    gitCommit,
    jsonReportPath,
    markdownReportPath,
    budgetUsd: options.budgetUsd ?? null,
    productionDataUsed: false,
    // Judge runs report their actual provider-call count; without a judge the
    // historical boolean (1 for real_provider, 0 otherwise) is preserved.
    realProviderCalls: result.judge ? result.judge.calls : result.mode === 'real_provider',
  };

  if (jsonReportPath) {
    writeFileSync(jsonReportPath, JSON.stringify(result, null, 2));
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
    await postPortalEvalHistory(options.portalUrl, options.portalToken, result, persistOptions);
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
        options.persistDbPath = process.env.CHAT_EVAL_DB_PATH || 'reports/chat-eval/chat-eval-history.sqlite';
      }
    } else if (arg === '--portal-url') {
      options.portalUrl = requireValue(arg, next);
      index += 1;
    } else if (arg === '--portal-token') {
      options.portalToken = requireValue(arg, next);
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

  if (options.mode === 'real_provider' && (!options.budgetUsd || options.budgetUsd <= 0)) {
    throw new Error('real_provider eval requires EVAL_MAX_USD_PER_RUN or --budget-usd');
  }
  if (Boolean(options.portalUrl) !== Boolean(options.portalToken)) {
    throw new Error('portal reporting requires both --portal-url and --portal-token');
  }
  return options;
}

async function postPortalEvalHistory(
  portalUrl: string,
  portalToken: string,
  result: ChatEvaluationSuiteResult,
  options: Record<string, unknown>,
): Promise<void> {
  const endpoint = new URL('/api/portal/eval-history', portalUrl).toString();
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${portalToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ result, ...options }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Portal eval-history POST failed: ${response.status} ${text.slice(0, 200)}`);
  }
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

if (require.main === module) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
