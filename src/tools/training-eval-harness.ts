// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { runTrainingCoachBenchmark, renderTrainingEvalMarkdown } from '../services/coach-kernel/evaluation';

interface CliOptions {
  json?: string;
  markdown?: string;
  outDir?: string;
  weekStart?: string;
  failUnder?: number;
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

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--json' && next) {
      options.json = next;
      i++;
    } else if (arg === '--markdown' && next) {
      options.markdown = next;
      i++;
    } else if (arg === '--out-dir' && next) {
      options.outDir = next;
      i++;
    } else if (arg === '--week-start' && next) {
      options.weekStart = next;
      i++;
    } else if (arg === '--fail-under' && next) {
      const parsed = Number(next);
      if (Number.isFinite(parsed)) options.failUnder = parsed;
      i++;
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
  const outDir = options.outDir ?? 'reports/training-eval';
  const baseName = `training-eval-${timestamp()}`;
  const jsonPath = options.json ?? path.join(outDir, `${baseName}.json`);
  const markdownPath = options.markdown ?? path.join(outDir, `${baseName}.md`);

  const result = runTrainingCoachBenchmark({
    weekStart: options.weekStart,
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
  fs.writeFileSync(markdownPath, renderTrainingEvalMarkdown(result), 'utf8');

  console.log(`Training eval score: ${result.aggregate.overallScore}/100`);
  console.log(`Cases: ${result.aggregate.caseCount}`);
  console.log(`JSON: ${jsonPath}`);
  console.log(`Markdown: ${markdownPath}`);

  if (options.failUnder != null && result.aggregate.overallScore < options.failUnder) {
    console.error(`Training eval score ${result.aggregate.overallScore} is below threshold ${options.failUnder}.`);
    process.exitCode = 1;
  }
}

main();

