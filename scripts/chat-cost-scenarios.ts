#!/usr/bin/env npx tsx
/**
 * Chat Cost Scenario Report
 *
 * Recomputes last-30-day api_usage spend with current model-rate matching
 * and estimates the approved Nexus Chat routing scenarios. This script is
 * read-only against SQLite and does not call any model provider.
 *
 * Run: DATABASE_PATH=/path/to/bot.db npx tsx scripts/chat-cost-scenarios.ts
 * Optional: COST_REPORT_START=2026-04-01 COST_REPORT_END=2026-05-01
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

interface UsageRow {
  provider: string;
  category: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  stored_cost_usd: number;
  calls: number;
}

interface ModelRate {
  input: number;
  output: number;
  batchDiscount?: number;
}

const DB_PATH = path.resolve(process.env.DATABASE_PATH || './data/bot.db');
const DEFAULT_END = new Date();
const DEFAULT_START = new Date(DEFAULT_END.getTime() - 30 * 24 * 60 * 60 * 1000);
const REPORT_START = process.env.COST_REPORT_START || formatSqlDateTime(DEFAULT_START);
const REPORT_END = process.env.COST_REPORT_END || formatSqlDateTime(DEFAULT_END);
const MODEL_RATES: Record<string, ModelRate> = {
  'gemini-2.5-flash-lite': { input: 0.10, output: 0.40, batchDiscount: 0.5 },
  'gemini-2.5-flash': { input: 0.30, output: 2.50, batchDiscount: 0.5 },
  'gpt-5.4-nano': { input: 0.20, output: 1.25, batchDiscount: 0.5 },
  'gpt-5.4-mini': { input: 0.75, output: 4.50, batchDiscount: 0.5 },
  'gpt-5-nano': { input: 0.05, output: 0.40, batchDiscount: 0.5 },
  'gpt-5-mini': { input: 0.25, output: 2.00, batchDiscount: 0.5 },
  'claude-haiku-4-5': { input: 1.00, output: 5.00 },
  'claude-haiku-4-5-20251001': { input: 1.00, output: 5.00 },
  'claude-sonnet-4-6': { input: 3.00, output: 15.00 },
};
const unmatchedModels = new Set<string>();

if (!fs.existsSync(DB_PATH)) {
  console.error(`Database not found: ${DB_PATH}`);
  process.exit(1);
}

const db = new Database(DB_PATH, { readonly: true });
const rows = db.prepare(`
  SELECT
    COALESCE(provider, 'anthropic') AS provider,
    COALESCE(category, 'unknown') AS category,
    COALESCE(model, 'unknown') AS model,
    SUM(COALESCE(input_tokens, 0)) AS input_tokens,
    SUM(COALESCE(output_tokens, 0)) AS output_tokens,
    SUM(COALESCE(cost_usd, 0)) AS stored_cost_usd,
    COUNT(*) AS calls
  FROM api_usage
  WHERE ts >= ? AND ts < ?
  GROUP BY provider, category, model
  ORDER BY stored_cost_usd DESC
`).all(REPORT_START, REPORT_END) as UsageRow[];
db.close();

const currentCorrected = total(rows, (row) => rateFor(row.model));
const classifierRouterFlashLite = total(rows, (row) => (
  isClassifierLike(row) ? rateFor('gemini-2.5-flash-lite') : rateFor(row.model)
));
const structuredNano = total(rows, (row) => {
  if (isClassifierLike(row)) return rateFor(row.model);
  if (isEligibleStructuredChat(row)) return rateFor('gpt-5.4-nano');
  return rateFor(row.model);
});
const scopedContextTrim = total(rows, (row) => {
  const inputMultiplier = isEligibleStructuredChat(row) || isSecretaryLike(row) ? 0.85 : 1;
  return rateFor(row.model, inputMultiplier);
});
const genericNoLocalReadTrim = total(rows, (row) => {
  const inputMultiplier = isGenericNoLocalReadEligible(row) ? 0.70 : 1;
  return rateFor(row.model, inputMultiplier);
});
const offlineBatch = total(rows, (row) => {
  const rate = rateFor(row.model);
  if (!isOfflineBatchEligible(row) || !rate.batchDiscount) return rate;
  return {
    input: rate.input * rate.batchDiscount,
    output: rate.output * rate.batchDiscount,
  };
});

const report = {
  generatedAt: new Date().toISOString(),
  databasePath: DB_PATH,
  window: {
    start: REPORT_START,
    end: REPORT_END,
  },
  rows: rows.length,
  calls: rows.reduce((sum, row) => sum + row.calls, 0),
  unmatched_models: [...unmatchedModels].sort(),
  storedCostUsd: round(rows.reduce((sum, row) => sum + row.stored_cost_usd, 0)),
  scenarios: {
    currentCorrected,
    classifierRouterKeptFlashLite: withSavings(classifierRouterFlashLite, currentCorrected.costUsd),
    eligibleStructuredChatToNano: withSavings(structuredNano, currentCorrected.costUsd),
    scopedContextTrim15PercentOnEligibleChat: withSavings(scopedContextTrim, currentCorrected.costUsd),
    genericNoLocalReadContextRemoved: withSavings(genericNoLocalReadTrim, currentCorrected.costUsd),
    offlineBatchOnlyForEvalAndBackfill: withSavings(offlineBatch, currentCorrected.costUsd),
  },
  notes: [
    'Batch/Flex estimates are intentionally restricted to eval/backfill categories, not live chat.',
    'Context trimming is a conservative 15% input-token scenario for eligible chat categories; real savings should use compiler telemetry.',
    'Generic no-local-read context removal models a 30% input reduction only for low-risk structured chat categories where the turn contract says local grounding is not needed.',
    'classifierRouterKeptFlashLite forces classifier/router-like rows to Gemini Flash-Lite pricing to make the cheap routing path explicit.',
    'Stored api_usage.cost_usd is shown separately because historical rows may contain old or prefix-matched pricing.',
  ],
};

console.log(JSON.stringify(report, null, 2));

function total(inputRows: UsageRow[], selectRate: (row: UsageRow) => ModelRate): { costUsd: number; inputTokens: number; outputTokens: number } {
  const inputTokens = inputRows.reduce((sum, row) => sum + row.input_tokens, 0);
  const outputTokens = inputRows.reduce((sum, row) => sum + row.output_tokens, 0);
  const costUsd = inputRows.reduce((sum, row) => {
    const rate = selectRate(row);
    return sum + (row.input_tokens / 1_000_000) * rate.input + (row.output_tokens / 1_000_000) * rate.output;
  }, 0);
  return { costUsd: round(costUsd), inputTokens, outputTokens };
}

function withSavings(scenario: { costUsd: number; inputTokens: number; outputTokens: number }, baselineCostUsd: number) {
  const savingsUsd = round(baselineCostUsd - scenario.costUsd);
  return {
    ...scenario,
    savingsUsd,
    savingsPct: baselineCostUsd > 0 ? round((savingsUsd / baselineCostUsd) * 100) : 0,
  };
}

function rateFor(model: string, inputMultiplier = 1): ModelRate {
  const key = Object.keys(MODEL_RATES)
    .sort((a, b) => b.length - a.length)
    .find((candidate) => model.startsWith(candidate));
  if (!key && !unmatchedModels.has(model)) {
    unmatchedModels.add(model);
    console.warn(`Unmatched model "${model}" priced as gemini-2.5-flash`);
  }
  const rate = key ? MODEL_RATES[key] : MODEL_RATES['gemini-2.5-flash'];
  return { ...rate, input: rate.input * inputMultiplier };
}

function isClassifierLike(row: UsageRow): boolean {
  return /classif|router|tier1/i.test(`${row.category} ${row.model}`)
    || row.model.startsWith('gemini-2.5-flash-lite');
}

function isEligibleStructuredChat(row: UsageRow): boolean {
  return /(?:^|_)(cooking|finance|content)(?:_|$)/i.test(row.category)
    && !/creative|script|hook|research|web|training|triathlon/i.test(row.category);
}

function isGenericNoLocalReadEligible(row: UsageRow): boolean {
  return isEligibleStructuredChat(row)
    && !isSecretaryLike(row)
    && !/local|read|action|tool|calendar|task|notification|decision|connection|crud|write|mutat/i.test(row.category);
}

function isSecretaryLike(row: UsageRow): boolean {
  return /secretary|calendar|tasks|notification|decision|connection/i.test(row.category);
}

function isOfflineBatchEligible(row: UsageRow): boolean {
  return /eval|bakeoff|bake-off|backfill|label|regression/i.test(row.category);
}

function round(value: number): number {
  return Number(value.toFixed(6));
}

function formatSqlDateTime(date: Date): string {
  return date.toISOString().replace('T', ' ').slice(0, 19);
}
