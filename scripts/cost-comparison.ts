#!/usr/bin/env npx tsx
/**
 * Post-migration cost comparison — compares current costs against baseline.
 * Run: npx tsx scripts/cost-comparison.ts
 * Output: docs/cost-comparison-YYYY-MM-DD.md
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { readdirSync } from 'fs';

const DB_PATH = process.env.DATABASE_PATH || './data/bot.db';
const db = new Database(path.resolve(DB_PATH), { readonly: true });

// Find most recent baseline
const docsDir = path.resolve('docs');
const baselines = readdirSync(docsDir).filter(f => f.startsWith('cost-baseline-')).sort().reverse();
if (baselines.length === 0) {
  console.error('❌ No baseline found. Run: npx tsx scripts/cost-baseline.ts first.');
  process.exit(1);
}

const baseline = JSON.parse(fs.readFileSync(path.join(docsDir, baselines[0]), 'utf-8'));
const baselineDays = baseline.totals.days || 30;

console.log(`\n📊 Comparing against baseline: ${baselines[0]} (${baselineDays} days)\n`);

// Query current period (same number of days as baseline)
const rows = db.prepare(`
  SELECT
    COALESCE(provider, 'anthropic') as provider,
    category,
    model,
    ROUND(SUM(cost_usd), 6) as total_cost,
    SUM(input_tokens) as total_input,
    SUM(output_tokens) as total_output,
    COUNT(*) as api_calls
  FROM api_usage
  WHERE ts >= date('now', '-${baselineDays} days')
  GROUP BY provider, category
  ORDER BY total_cost DESC
`).all() as any[];

// Current totals
const currentTotal = rows.reduce((s: number, r: any) => s + r.total_cost, 0);
const currentCalls = rows.reduce((s: number, r: any) => s + r.api_calls, 0);
const baselineTotal = baseline.totals.totalCostUsd;
const savings = ((baselineTotal - currentTotal) / baselineTotal * 100).toFixed(1);

// Per-provider breakdown
const byProvider: Record<string, number> = {};
for (const row of rows) {
  byProvider[row.provider] = (byProvider[row.provider] || 0) + row.total_cost;
}

// Build markdown report
const today = new Date().toISOString().slice(0, 10);
let report = `# Cost Comparison Report — ${today}\n\n`;
report += `## Summary\n\n`;
report += `| Metric | Before | After | Change |\n|--------|--------|-------|--------|\n`;
report += `| Total cost | $${baselineTotal.toFixed(4)} | $${currentTotal.toFixed(4)} | ${Number(savings) > 0 ? '⬇️' : '⬆️'} ${savings}% |\n`;
report += `| API calls | ${baseline.totals.totalApiCalls} | ${currentCalls} | |\n`;
report += `| Avg cost/call | $${baseline.totals.avgCostPerMessage.toFixed(6)} | $${currentCalls > 0 ? (currentTotal / currentCalls).toFixed(6) : '0'} | |\n\n`;

report += `## Per-Provider Breakdown\n\n`;
report += `| Provider | Cost |\n|----------|------|\n`;
for (const [provider, cost] of Object.entries(byProvider).sort((a, b) => b[1] - a[1])) {
  report += `| ${provider} | $${cost.toFixed(4)} |\n`;
}

report += `\n## Notes\n\n- Baseline period: ${baselineDays} days\n- Comparison period: ${baselineDays} days from today\n`;

const outPath = path.join(docsDir, `cost-comparison-${today}.md`);
fs.writeFileSync(outPath, report);

console.log(`Total cost: $${baselineTotal.toFixed(4)} → $${currentTotal.toFixed(4)} (${savings}% savings)`);
console.log(`\nPer-provider:`);
for (const [p, c] of Object.entries(byProvider)) {
  console.log(`  ${p.padEnd(12)} $${c.toFixed(4)}`);
}
console.log(`\n✅ Report saved to: ${outPath}`);

db.close();
