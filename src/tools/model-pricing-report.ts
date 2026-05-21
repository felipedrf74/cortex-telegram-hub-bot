// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { getModelPricingTable, resolveModelPricing } from '../services/model-pricing';

const dbPath = path.resolve(process.env.DATABASE_PATH || './data/bot.db');
const unresolvedOnly = process.argv.slice(2).includes('--unresolved-only');
const priceTable = getModelPricingTable();
const unknownSeenModels: string[] = [];
const usageCounts = new Map<string, number>();
let pricingStatusSummary: Array<{ pricing_status: string; rows: number; spend_usd: number; unresolved_spend_usd: number }> = [];
let unresolvedPricingRows: Array<{ provider: string; model: string; pricing_model_key: string | null; rows: number; spend_usd: number }> = [];

if (fs.existsSync(dbPath)) {
  const db = new Database(dbPath, { readonly: true });
  try {
    const columns = new Set((db.prepare('PRAGMA table_info(api_usage)').all() as Array<{ name: string }>).map((row) => row.name));
    const rows = db.prepare(`
      SELECT COALESCE(provider, '') AS provider, COALESCE(model, '') AS model, COUNT(*) AS calls
      FROM api_usage
      WHERE ts >= date('now', '-30 days')
      GROUP BY provider, model
      ORDER BY calls DESC
    `).all() as Array<{ provider: string; model: string; calls: number }>;
    for (const row of rows) {
      usageCounts.set(`${row.provider || ''}/${row.model || ''}`, row.calls);
      if (!resolveModelPricing(row.model, row.provider || null)) {
        unknownSeenModels.push(`${row.provider || 'unknown'}/${row.model || 'unknown'} (${row.calls} calls)`);
      }
    }

    if (columns.has('pricing_status')) {
      pricingStatusSummary = db.prepare(`
        SELECT
          COALESCE(pricing_status, 'legacy') AS pricing_status,
          COUNT(*) AS rows,
          COALESCE(SUM(cost_usd), 0) AS spend_usd,
          COALESCE(SUM(CASE WHEN pricing_status = 'unresolved' THEN cost_usd ELSE 0 END), 0) AS unresolved_spend_usd
        FROM api_usage
        WHERE ts >= date('now', '-30 days')
        GROUP BY COALESCE(pricing_status, 'legacy')
        ORDER BY unresolved_spend_usd DESC, spend_usd DESC
      `).all() as Array<{ pricing_status: string; rows: number; spend_usd: number; unresolved_spend_usd: number }>;
      unresolvedPricingRows = db.prepare(`
        SELECT
          COALESCE(provider, 'unknown') AS provider,
          COALESCE(model, 'unknown') AS model,
          pricing_model_key,
          COUNT(*) AS rows,
          COALESCE(SUM(cost_usd), 0) AS spend_usd
        FROM api_usage
        WHERE ts >= date('now', '-30 days')
          AND pricing_status = 'unresolved'
        GROUP BY provider, model, pricing_model_key
        ORDER BY spend_usd DESC, rows DESC
      `).all() as Array<{ provider: string; model: string; pricing_model_key: string | null; rows: number; spend_usd: number }>;
    }
  } finally {
    db.close();
  }
}

const unusedRegistryEntries = priceTable
  .filter((entry) => !usageCounts.has(`${entry.provider}/${entry.model}`))
  .map((entry) => `${entry.provider}/${entry.model}`)
  .sort();

for (const model of unknownSeenModels) {
  console.warn(`Unknown api_usage model pricing: ${model}`);
}

console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  databasePath: fs.existsSync(dbPath) ? dbPath : null,
  unresolvedOnly,
  pricesUsdPerMillionTokens: unresolvedOnly ? [] : priceTable,
  unknownModelsSeenInApiUsage: unresolvedOnly ? unknownSeenModels.filter((model) => unresolvedPricingRows.some((row) => model.startsWith(`${row.provider}/`) && model.includes(`/${row.model}`))) : unknownSeenModels,
  pricingStatusSummary,
  unresolvedPricingRows,
  unused_registry_entries: unresolvedOnly ? [] : unusedRegistryEntries,
}, null, 2));
