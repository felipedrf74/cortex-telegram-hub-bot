#!/usr/bin/env tsx
// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { spawnSync } from 'child_process';
import dotenv from 'dotenv';
import {
  buildChatV2ReadinessAlertInputs,
  buildChatV2ReadinessDashboard,
  recordChatV2ReadinessOperatorAlerts,
  type ChatV2CompletionReadinessReportLike,
} from '../src/services/chatv2-readiness-alerts';

dotenv.config({ quiet: true });

const dbPath = readArg('--db') ?? process.env.DATABASE_PATH ?? './data/bot.db';
const limit = parsePositiveInt(readArg('--limit')) ?? 500;
const sources = readArg('--source') ?? readArg('--sources');
const writeAlerts = hasFlag('--write-alerts');
const failOnAlerts = hasFlag('--fail-on-alerts');
const jsonOnly = hasFlag('--json');

main().catch((err) => {
  process.stderr.write(`chatv2 readiness alerts failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

async function main(): Promise<void> {
  const readinessArgs = [
    'tsx',
    'scripts/chatv2-completion-readiness.ts',
    '--db',
    dbPath,
    '--limit',
    String(limit),
  ];
  if (sources) readinessArgs.push('--source', sources);

  const readiness = spawnSync('npx', readinessArgs, {
    cwd: process.cwd(),
    encoding: 'utf8',
  });

  if (readiness.status !== 0) {
    if (readiness.stdout.trim()) process.stdout.write(readiness.stdout);
    if (readiness.stderr.trim()) process.stderr.write(readiness.stderr);
    process.exit(readiness.status ?? 1);
  }

  let report: ChatV2CompletionReadinessReportLike;
  try {
    report = JSON.parse(readiness.stdout) as ChatV2CompletionReadinessReportLike;
  } catch (err) {
    process.stderr.write(`Failed to parse readiness report JSON: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  const dashboard = buildChatV2ReadinessDashboard(report);
  const alertInputs = buildChatV2ReadinessAlertInputs(report);
  let recordResults: unknown[] = [];

  if (writeAlerts && alertInputs.length > 0) {
    process.env.DATABASE_PATH = dbPath;
    const { initDatabase, closeDatabase } = await import('../src/services/database');
    try {
      initDatabase();
      recordResults = (await recordChatV2ReadinessOperatorAlerts(report)).results;
    } finally {
      try {
        closeDatabase();
      } catch {
        // The process is exiting; a missing initialized DB should not mask alert results.
      }
    }
  }

  const output = {
    schemaVersion: 'chat_v2_readiness_alerts_report.v1',
    generatedAt: new Date().toISOString(),
    dbPath,
    limit,
    sources: sources ?? 'runtime_route',
    dashboard,
    alertCount: alertInputs.length,
    alerts: alertInputs.map((alert) => ({
      severity: alert.severity,
      source: alert.source,
      dedupeKey: alert.dedupeKey,
      title: alert.title,
      detail: alert.detail ?? null,
      metadata: alert.metadata ?? null,
      owner: alert.owner ?? null,
      suspectedArea: alert.suspectedArea ?? null,
      userImpact: alert.userImpact ?? null,
      runbookUrl: alert.runbookUrl ?? null,
    })),
    writeAlerts,
    recordResults,
  };

  if (jsonOnly) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log(JSON.stringify(output, null, 2));
  }

  if (failOnAlerts && alertInputs.length > 0) {
    process.exitCode = 1;
  }
}

function readArg(name: string): string | null {
  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1] ?? null;
  return null;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function parsePositiveInt(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
