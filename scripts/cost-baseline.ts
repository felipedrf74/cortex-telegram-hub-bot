#!/usr/bin/env npx tsx
/**
 * Cost Baseline Capture — records current daily/weekly costs as pre-migration snapshot.
 * Run: npx tsx scripts/cost-baseline.ts
 * Output: docs/cost-baseline-YYYY-MM-DD.json
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DB_PATH = process.env.DATABASE_PATH || './data/bot.db';
const db = new Database(path.resolve(DB_PATH), { readonly: true });

interface UsageRow {
  date: string;
  category: string;
  model: string;
  total_cost: number;
  total_input: number;
  total_output: number;
  api_calls: number;
}

// Query last 30 days grouped by date, category (domain), model
const rows = db.prepare(`
  SELECT
    date(ts) as date,
    category,
    model,
    ROUND(SUM(cost_usd), 6) as total_cost,
    SUM(input_tokens) as total_input,
    SUM(output_tokens) as total_output,
    COUNT(*) as api_calls
  FROM api_usage
  WHERE ts >= date('now', '-30 days')
  GROUP BY date(ts), category, model
  ORDER BY date(ts) DESC, total_cost DESC
`).all() as UsageRow[];

// Aggregate totals
const totals = {
  totalCostUsd: rows.reduce((s, r) => s + r.total_cost, 0),
  totalInputTokens: rows.reduce((s, r) => s + r.total_input, 0),
  totalOutputTokens: rows.reduce((s, r) => s + r.total_output, 0),
  totalApiCalls: rows.reduce((s, r) => s + r.api_calls, 0),
  avgCostPerDay: 0,
  avgCostPerMessage: 0,
  days: 0,
};

const uniqueDays = new Set(rows.map(r => r.date));
totals.days = uniqueDays.size;
totals.avgCostPerDay = totals.days > 0 ? totals.totalCostUsd / totals.days : 0;
totals.avgCostPerMessage = totals.totalApiCalls > 0 ? totals.totalCostUsd / totals.totalApiCalls : 0;

// Per-domain breakdown
const byDomain: Record<string, { cost: number; calls: number; tokens: number }> = {};
for (const row of rows) {
  const domain = row.category.replace(/^(domain_|gemini_domain_|openai_domain_)/, '').replace(/_.*/, '');
  if (!byDomain[domain]) byDomain[domain] = { cost: 0, calls: 0, tokens: 0 };
  byDomain[domain].cost += row.total_cost;
  byDomain[domain].calls += row.api_calls;
  byDomain[domain].tokens += row.total_input + row.total_output;
}

// Per-model breakdown
const byModel: Record<string, { cost: number; calls: number }> = {};
for (const row of rows) {
  if (!byModel[row.model]) byModel[row.model] = { cost: 0, calls: 0 };
  byModel[row.model].cost += row.total_cost;
  byModel[row.model].calls += row.api_calls;
}

const baseline = {
  capturedAt: new Date().toISOString(),
  periodDays: 30,
  totals,
  byDomain,
  byModel,
  rawRows: rows,
};

// Print summary
console.log('\n═══ COST BASELINE (Last 30 Days) ═══\n');
console.log(`Total cost:         $${totals.totalCostUsd.toFixed(4)}`);
console.log(`Total API calls:    ${totals.totalApiCalls}`);
console.log(`Total tokens:       ${(totals.totalInputTokens + totals.totalOutputTokens).toLocaleString()}`);
console.log(`Days captured:      ${totals.days}`);
console.log(`Avg cost/day:       $${totals.avgCostPerDay.toFixed(4)}`);
console.log(`Avg cost/call:      $${totals.avgCostPerMessage.toFixed(6)}`);

console.log('\n── By Domain ──');
for (const [domain, data] of Object.entries(byDomain).sort((a, b) => b[1].cost - a[1].cost)) {
  console.log(`  ${domain.padEnd(20)} $${data.cost.toFixed(4).padStart(8)}  (${data.calls} calls)`);
}

console.log('\n── By Model ──');
for (const [model, data] of Object.entries(byModel).sort((a, b) => b[1].cost - a[1].cost)) {
  console.log(`  ${model.padEnd(30)} $${data.cost.toFixed(4).padStart(8)}  (${data.calls} calls)`);
}

// Write to file
const today = new Date().toISOString().slice(0, 10);
const outPath = path.resolve(`docs/cost-baseline-${today}.json`);
fs.writeFileSync(outPath, JSON.stringify(baseline, null, 2));
console.log(`\n✅ Baseline saved to: ${outPath}`);

db.close();
