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
import { persistChatEvalRun } from '../src/services/chat-eval-history';

interface CliOptions {
  mode: ChatEvalMode;
  outDir: string;
  json: boolean;
  markdown: boolean;
  persistDbPath?: string;
  portalUrl?: string;
  portalToken?: string;
  budgetUsd?: number;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  mkdirSync(options.outDir, { recursive: true });

  const generatedAt = new Date().toISOString();
  const result = runChatEvaluationSuite({ mode: options.mode, generatedAt });
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
    realProviderCalls: result.mode === 'real_provider',
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
  if (jsonReportPath) console.log(`[chat-eval-live] json=${jsonReportPath}`);
  if (markdownReportPath) console.log(`[chat-eval-live] markdown=${markdownReportPath}`);
  if (options.persistDbPath) console.log(`[chat-eval-live] db=${options.persistDbPath}`);

  if (!result.passed) {
    process.exitCode = 1;
  }
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    mode: parseMode(process.env.CHAT_EVAL_MODE) ?? 'real_provider',
    outDir: process.env.CHAT_EVAL_OUT_DIR || 'reports/chat-eval',
    json: true,
    markdown: true,
    persistDbPath: process.env.CHAT_EVAL_PERSIST_DB === '1'
      ? (process.env.CHAT_EVAL_DB_PATH || 'reports/chat-eval/chat-eval-history.sqlite')
      : undefined,
    portalUrl: process.env.CHAT_EVAL_PORTAL_URL,
    portalToken: process.env.CHAT_EVAL_PORTAL_TOKEN,
    budgetUsd: parseNumber(process.env.EVAL_MAX_USD_PER_RUN),
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

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
