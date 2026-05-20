// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { getModelPricingTable, resolveModelPricing } from '../services/model-pricing';

const dbPath = path.resolve(process.env.DATABASE_PATH || './data/bot.db');
const priceTable = getModelPricingTable();
const unknownSeenModels: string[] = [];
const usageCounts = new Map<string, number>();

if (fs.existsSync(dbPath)) {
  const db = new Database(dbPath, { readonly: true });
  try {
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
  pricesUsdPerMillionTokens: priceTable,
  unknownModelsSeenInApiUsage: unknownSeenModels,
  unused_registry_entries: unusedRegistryEntries,
}, null, 2));
