#!/usr/bin/env tsx
// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
//
// Chat M20 — offline ChatV2 legacy-route retirement campaign report.
//
// Prints the per-route campaign table in campaign order from the persisted
// chat_v2_route_exit_samples evidence. Parity samples/rates (known
// legacy-vs-v2 comparisons only) drive the gate; parity_unknown counts and
// v2-health capture counts are shown as context. Routes below the
// 50-known-parity-sample floor report INSUFFICIENT honestly instead of a
// judged FAIL. Use --json for the machine-readable report and --sync to
// convert/refresh source rows (shadow replay bundles, online-eval captures)
// before reading.
//
// This CLI NEVER flips route flags. Flag flipping is owner-gated production
// work; this report only shows whether the parity evidence floor is met.
//
// Usage:
//   npx tsx scripts/chatv2-retirement-campaign.ts [--db ./data/bot.db] [--json] [--sync]

import Database from 'better-sqlite3';
import dotenv from 'dotenv';
import {
  NEXUS_CHAT_ROUTE_EXIT_SAMPLER_VERSION,
  buildChatV2RetirementCampaign,
  isChatRouteExitSamplerMigrationApplied,
  syncChatRouteExitSamples,
  type ChatV2RetirementCampaignRow,
} from '../src/services/chat-route-exit-sampler';

dotenv.config({ quiet: true });

export interface ChatV2RetirementCampaignReport {
  schemaVersion: 'chat_v2_retirement_campaign_report.v1';
  samplerVersion: typeof NEXUS_CHAT_ROUTE_EXIT_SAMPLER_VERSION;
  generatedAt: string;
  /**
   * 'migration_257_not_applied' on a readonly database that predates
   * migration 257: the evidence table cannot be created on a readonly
   * connection, so the report is honestly empty instead of throwing.
   */
  status: 'ok' | 'migration_257_not_applied';
  rows: ChatV2RetirementCampaignRow[];
  totals: {
    routes: number;
    passedRoutes: number;
    failedRoutes: number;
    insufficientRoutes: number;
    paritySamples: number;
    parityUnknown: number;
    healthSamples: number;
    missingSamples: number;
  };
}

export function buildChatV2RetirementCampaignReport(
  db: Database.Database,
  options: { now?: Date } = {},
): ChatV2RetirementCampaignReport {
  const generatedAt = (options.now ?? new Date()).toISOString();
  if (!isChatRouteExitSamplerMigrationApplied(db) && db.readonly) {
    return {
      schemaVersion: 'chat_v2_retirement_campaign_report.v1',
      samplerVersion: NEXUS_CHAT_ROUTE_EXIT_SAMPLER_VERSION,
      generatedAt,
      status: 'migration_257_not_applied',
      rows: [],
      totals: {
        routes: 0,
        passedRoutes: 0,
        failedRoutes: 0,
        insufficientRoutes: 0,
        paritySamples: 0,
        parityUnknown: 0,
        healthSamples: 0,
        missingSamples: 0,
      },
    };
  }
  const rows = buildChatV2RetirementCampaign(db);
  return {
    schemaVersion: 'chat_v2_retirement_campaign_report.v1',
    samplerVersion: NEXUS_CHAT_ROUTE_EXIT_SAMPLER_VERSION,
    generatedAt,
    status: 'ok',
    rows,
    totals: {
      routes: rows.length,
      passedRoutes: rows.filter((row) => row.verdict === 'pass').length,
      failedRoutes: rows.filter((row) => row.verdict === 'fail').length,
      insufficientRoutes: rows.filter((row) => row.verdict === 'insufficient_evidence').length,
      paritySamples: rows.reduce((sum, row) => sum + row.paritySamples, 0),
      parityUnknown: rows.reduce((sum, row) => sum + row.parityUnknown, 0),
      healthSamples: rows.reduce((sum, row) => sum + row.healthSamples, 0),
      missingSamples: rows.reduce((sum, row) => sum + row.missingSamples, 0),
    },
  };
}

const VERDICT_LABELS: Record<ChatV2RetirementCampaignRow['verdict'], string> = {
  pass: 'PASS',
  fail: 'FAIL',
  insufficient_evidence: 'INSUFFICIENT',
};

export function renderChatV2RetirementCampaignTable(report: ChatV2RetirementCampaignReport): string {
  if (report.status === 'migration_257_not_applied') {
    return [
      `ChatV2 legacy-route retirement campaign (${report.generatedAt})`,
      'migration 257 not applied on this database (readonly connection — evidence table missing).',
      'Run the migration (or re-run with --sync on a writable connection) to collect evidence.',
    ].join('\n');
  }
  const header = ['#', 'stage', 'route', 'parity', 'rate', 'unknown', 'health', 'verdict', 'missing'];
  const body = report.rows.map((row) => [
    String(row.position),
    row.campaignStage,
    row.routeId,
    String(row.paritySamples),
    row.paritySamples > 0 ? row.parityRate.toFixed(4) : '-',
    String(row.parityUnknown),
    row.healthSamples > 0 ? `${row.healthSamples - row.healthFailures}/${row.healthSamples} ok` : '-',
    VERDICT_LABELS[row.verdict],
    String(row.missingSamples),
  ]);
  const widths = header.map((_, column) =>
    Math.max(header[column]!.length, ...body.map((cells) => cells[column]!.length)),
  );
  const renderLine = (cells: string[]): string =>
    cells.map((cell, column) => cell.padEnd(widths[column]!)).join('  ').trimEnd();
  const separator = widths.map((width) => '-'.repeat(width)).join('  ');
  const lines = [
    `ChatV2 legacy-route retirement campaign (${report.generatedAt})`,
    renderLine(header),
    separator,
    ...body.map(renderLine),
    separator,
    `routes ${report.totals.routes} | PASS ${report.totals.passedRoutes} | FAIL ${report.totals.failedRoutes}`
      + ` | INSUFFICIENT ${report.totals.insufficientRoutes} | parity samples ${report.totals.paritySamples}`
      + ` | unknown ${report.totals.parityUnknown} | health ${report.totals.healthSamples}`
      + ` | missing ${report.totals.missingSamples}`,
    'Gate input: known legacy-vs-v2 parity samples only. parity_unknown and health rows are context.',
    'Route flag flipping stays owner-gated; this report is evidence only.',
  ];
  return lines.join('\n');
}

function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

if (require.main === module) {
  const dbPath = readArg('--db') ?? process.env.DATABASE_PATH ?? './data/bot.db';
  const sync = hasFlag('--sync');
  const db = new Database(dbPath, { readonly: !sync, fileMustExist: true });
  try {
    if (sync) {
      const result = syncChatRouteExitSamples(db);
      if (!hasFlag('--json')) {
        for (const [source, stats] of Object.entries(result.sources)) {
          console.log(`sync ${source}: scanned=${stats.scanned} converted=${stats.converted} refreshed=${stats.refreshed} skipped=${stats.skipped}`);
        }
      }
    }
    const report = buildChatV2RetirementCampaignReport(db);
    if (hasFlag('--json')) console.log(JSON.stringify(report, null, 2));
    else console.log(renderChatV2RetirementCampaignTable(report));
  } finally {
    db.close();
  }
}
