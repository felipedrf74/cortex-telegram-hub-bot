// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import {
  formatContentEvalResultsMarkdown,
  runContentDayToDayEvaluation,
  type ContentEvalMode,
} from '../services/content-day-to-day-evaluation';
import { persistContentEvalRun } from '../services/content-eval-history';

interface CliOptions {
  mode?: ContentEvalMode;
  json?: string;
  markdown?: string;
  outDir?: string;
  failUnder?: number;
  persistDb?: string;
}

function readPackageVersion(): string {
  try {
    const raw = fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? 'unknown';
  } catch {
    try {
      const raw = fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8');
      const parsed = JSON.parse(raw) as { version?: string };
      return parsed.version ?? 'unknown';
    } catch {
      return 'unknown';
    }
  }
}

function gitValue(command: string): string | undefined {
  try {
    return execSync(command, { cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function parseMode(raw: string | undefined): ContentEvalMode | undefined {
  if (raw === 'fixture' || raw === 'local_engine' || raw === 'real_provider') return raw;
  return undefined;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--mode' && next) {
      options.mode = parseMode(next);
      i++;
    } else if (arg === '--json' && next) {
      options.json = next;
      i++;
    } else if (arg === '--markdown' && next) {
      options.markdown = next;
      i++;
    } else if (arg === '--out-dir' && next) {
      options.outDir = next;
      i++;
    } else if (arg === '--fail-under' && next) {
      const parsed = Number(next);
      if (Number.isFinite(parsed)) options.failUnder = parsed;
      i++;
    } else if (arg === '--persist-db') {
      if (next && !next.startsWith('--')) {
        options.persistDb = next;
        i++;
      } else {
        options.persistDb = process.env.CONTENT_EVAL_DB_PATH || 'reports/content-eval/content-eval-history.sqlite';
      }
    }
  }
  return options;
}

function ensureParent(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const mode = options.mode ?? parseMode(process.env.CONTENT_EVAL_MODE) ?? 'fixture';
  const outDir = options.outDir ?? 'reports/content-eval';
  const baseName = `content-eval-${timestamp()}`;
  const jsonPath = options.json ?? path.join(outDir, `${baseName}.json`);
  const markdownPath = options.markdown ?? path.join(outDir, `${baseName}.md`);

  const result = runContentDayToDayEvaluation({
    mode,
    generatedAt: new Date().toISOString(),
    engine: {
      packageVersion: readPackageVersion(),
      gitBranch: gitValue('git branch --show-current'),
      gitCommit: gitValue('git rev-parse --short HEAD'),
    },
  });

  ensureParent(jsonPath);
  ensureParent(markdownPath);
  fs.writeFileSync(jsonPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  fs.writeFileSync(markdownPath, formatContentEvalResultsMarkdown(result), 'utf8');

  const persistDbPath = options.persistDb
    ?? (process.env.CONTENT_EVAL_PERSIST_DB === '1'
      ? process.env.CONTENT_EVAL_DB_PATH || 'reports/content-eval/content-eval-history.sqlite'
      : undefined);
  if (persistDbPath) {
    ensureParent(persistDbPath);
    const persisted = persistContentEvalRun(result, {
      databasePath: persistDbPath,
      packageVersion: readPackageVersion(),
      gitBranch: gitValue('git branch --show-current'),
      gitCommit: gitValue('git rev-parse --short HEAD'),
      jsonReportPath: jsonPath,
      markdownReportPath: markdownPath,
    });
    console.log(`Persisted eval run: ${persisted.runId} (${persisted.caseCount} cases)`);
    console.log(`Eval DB: ${persistDbPath}`);
  }

  console.log(`Content eval score: ${result.aggregate.overallScore}/100`);
  console.log(`Cases: ${result.aggregate.caseCount}`);
  console.log(`Release gate: ${result.aggregate.releaseGate}`);
  console.log(`JSON: ${jsonPath}`);
  console.log(`Markdown: ${markdownPath}`);

  if (options.failUnder != null && result.aggregate.overallScore < options.failUnder) {
    console.error(`Content eval score ${result.aggregate.overallScore} is below threshold ${options.failUnder}.`);
    process.exitCode = 1;
  }

  if (!result.passed) {
    process.exitCode = 1;
  }
}

main();
