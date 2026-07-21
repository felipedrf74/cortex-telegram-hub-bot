#!/usr/bin/env node
// Milestone 4 — offline routing-divergence report.
//
// Summarizes the resolver-vs-surface divergence telemetry recorded by the
// Chat Core v2 shadow route hook (contextPack.routingDivergence inside
// chat_v2_replay_bundles rows with id `chatv2-shadow-replay:%`).
//
// Read-only, fully offline: SELECTs from a local SQLite file, no network.
//
// Usage:
//   node scripts/routing-divergence-report.mjs [--db path/to.db] [--json] [--top N]
//
// Defaults to DATABASE_PATH, then ./data/bot.db.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const args = process.argv.slice(2);
const readArg = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index !== -1 && args[index + 1] ? args[index + 1] : fallback;
};
const asJson = args.includes('--json');
const topN = Number.parseInt(readArg('--top', '15'), 10) || 15;
const dbPath = readArg('--db', process.env.DATABASE_PATH || path.join(process.cwd(), 'data', 'bot.db'));

if (!fs.existsSync(dbPath)) {
  console.error(`routing-divergence-report: database not found: ${dbPath}`);
  process.exit(1);
}

const db = new Database(dbPath, { readonly: true, fileMustExist: true });

const tableExists = db
  .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chat_v2_replay_bundles'")
  .get();
if (!tableExists) {
  console.error('routing-divergence-report: chat_v2_replay_bundles table not present — no shadow telemetry yet');
  process.exit(1);
}

const rows = db
  .prepare(`
    SELECT redacted_bundle_json, created_at
    FROM chat_v2_replay_bundles
    WHERE replay_bundle_id LIKE 'chatv2-shadow-replay:%'
    ORDER BY created_at ASC, id ASC
  `)
  .all();

const SURFACES = ['classifierKeyword', 'orchestratorPrimary', 'registrySubset', 'shadowRoute'];

let totalBundles = 0;
let withDivergence = 0;
let noTopCandidate = 0;
// surface -> skill -> { compared, agreed }
const agreementBySurfaceSkill = new Map();
// cluster key `surface|surfaceDecision|resolverDomain` -> count
const disagreementClusters = new Map();

for (const row of rows) {
  totalBundles += 1;
  let bundle;
  try {
    bundle = JSON.parse(row.redacted_bundle_json);
  } catch {
    continue;
  }
  const divergence = bundle?.contextPack?.routingDivergence;
  if (!divergence) continue;
  withDivergence += 1;
  const top = divergence.topCandidate;
  if (!top) {
    noTopCandidate += 1;
    continue;
  }
  const surfaces = divergence.surfaces ?? {};
  const surfaceDecision = {
    classifierKeyword: surfaces.classifierKeywordDomain ?? null,
    orchestratorPrimary: surfaces.orchestratorPrimaryDomain ?? null,
    registrySubset: Array.isArray(surfaces.registryActionSkills) && surfaces.registryActionSkills.length > 0
      ? surfaces.registryActionSkills.join('+')
      : null,
    shadowRoute: Array.isArray(surfaces.shadowRouteDomains) && surfaces.shadowRouteDomains.length > 0
      ? surfaces.shadowRouteDomains.join('+')
      : null,
  };
  for (const surface of SURFACES) {
    const verdict = divergence.agreement?.[surface];
    if (verdict === null || verdict === undefined) continue; // surface had no decision
    if (!agreementBySurfaceSkill.has(surface)) agreementBySurfaceSkill.set(surface, new Map());
    const bySkill = agreementBySurfaceSkill.get(surface);
    if (!bySkill.has(top.skill)) bySkill.set(top.skill, { compared: 0, agreed: 0 });
    const bucket = bySkill.get(top.skill);
    bucket.compared += 1;
    if (verdict === true) bucket.agreed += 1;
    else {
      const key = `${surface}|${surfaceDecision[surface] ?? 'none'}|${top.domain}`;
      disagreementClusters.set(key, (disagreementClusters.get(key) ?? 0) + 1);
    }
  }
}

const report = {
  generatedAt: new Date().toISOString(),
  dbPath,
  totalShadowBundles: totalBundles,
  bundlesWithDivergenceTelemetry: withDivergence,
  bundlesWithoutResolverCandidate: noTopCandidate,
  agreement: Object.fromEntries(
    [...agreementBySurfaceSkill.entries()].map(([surface, bySkill]) => [
      surface,
      Object.fromEntries(
        [...bySkill.entries()]
          .sort((a, b) => b[1].compared - a[1].compared)
          .map(([skill, { compared, agreed }]) => [
            skill,
            { compared, agreed, agreementRate: compared > 0 ? Number((agreed / compared).toFixed(4)) : null },
          ]),
      ),
    ]),
  ),
  topDisagreementClusters: [...disagreementClusters.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([key, count]) => {
      const [surface, surfaceDecision, resolverDomain] = key.split('|');
      return { surface, surfaceDecision, resolverDomain, count };
    }),
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`Routing divergence report — ${report.generatedAt}`);
  console.log(`DB: ${report.dbPath}`);
  console.log(`Shadow bundles: ${report.totalShadowBundles} (with divergence telemetry: ${report.bundlesWithDivergenceTelemetry}, no resolver candidate: ${report.bundlesWithoutResolverCandidate})`);
  for (const [surface, bySkill] of Object.entries(report.agreement)) {
    console.log(`\nSurface: ${surface}`);
    for (const [skill, stats] of Object.entries(bySkill)) {
      const pct = stats.agreementRate === null ? 'n/a' : `${(stats.agreementRate * 100).toFixed(1)}%`;
      console.log(`  ${skill.padEnd(18)} compared=${String(stats.compared).padStart(5)} agreed=${String(stats.agreed).padStart(5)} rate=${pct}`);
    }
  }
  console.log('\nTop disagreement clusters (surface decision vs resolver domain):');
  if (report.topDisagreementClusters.length === 0) console.log('  none recorded');
  for (const cluster of report.topDisagreementClusters) {
    console.log(`  [${cluster.surface}] surface=${cluster.surfaceDecision} resolver=${cluster.resolverDomain} count=${cluster.count}`);
  }
}

db.close();
