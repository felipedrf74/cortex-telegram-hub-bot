#!/usr/bin/env node
// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { TEN_SCRIPT_ACCEPTANCE_SCENARIOS } from './content-ten-script-acceptance.mjs';

function fail(message, code = 1) {
  console.error(`content acceptance evidence refused: ${message}`);
  process.exit(code);
}

function option(name, required = false) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (required && (!value || value.startsWith('--'))) fail(`${name} requires a value`, 64);
  return value;
}

function assertPrivateRegularFile(filename, label) {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) {
    fail(`${label} must be a mode-0600, single-link regular file`, 77);
  }
}

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function p95(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
}

function atomicPrivateWrite(filename, bytes) {
  if (fs.existsSync(filename)) fail(`refusing to replace existing output ${filename}`, 73);
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
  fs.linkSync(temporary, filename);
  fs.unlinkSync(temporary);
  fs.chmodSync(filename, 0o600);
}

const statePath = path.resolve(option('--state', true));
const outputPath = path.resolve(option('--output', true));
const sourceSha = option('--source-sha', true);
if (!/^[0-9a-f]{40}$/u.test(sourceSha)) fail('--source-sha must be an exact 40-character commit', 64);
assertPrivateRegularFile(statePath, 'acceptance state');
const stateBytes = fs.readFileSync(statePath);
const state = JSON.parse(stateBytes.toString('utf8'));
if (state?.schemaVersion !== 'nexus.content-ten-script-acceptance.v1'
    || !Array.isArray(state.scenarios) || state.scenarios.length !== 10) {
  fail('acceptance state schema or inventory is invalid', 65);
}
if (state.scenarios.some((row, index) => {
  const expected = TEN_SCRIPT_ACCEPTANCE_SCENARIOS[index];
  return !expected || row.id !== expected.id || row.phase !== expected.phase
    || row.deliveryMode !== expected.deliveryMode || row.language !== expected.language
    || row.topicSha256 !== sha256(expected.topic);
})) fail('acceptance state differs from the immutable ten-scenario inventory', 65);
const ids = new Set(state.scenarios.map((row) => row.id));
const jobIds = new Set(state.scenarios.map((row) => row.jobId));
if (ids.size !== 10 || jobIds.size !== 10 || jobIds.has(null)
    || state.scenarios.some((row) => row.status !== 'completed'
      || row.output?.contractPass !== true || row.output?.sourceConsistent !== true)) {
  fail('all ten unique jobs must be completed and contract-valid', 78);
}
if (state.productionSmokeSourceSha !== sourceSha) {
  fail('production-smoke source identity does not match --source-sha', 78);
}
const databasePath = path.resolve(option('--database', false) || process.env.DATABASE_PATH || './data/bot.db');
const databaseStat = fs.lstatSync(databasePath);
if (!databaseStat.isFile() || databaseStat.isSymbolicLink()) fail('database path must be a regular file', 77);
const db = new Database(databasePath, { readonly: true, fileMustExist: true });

const jobQuery = db.prepare(`SELECT job_id, operation_id, status, delivery_mode,
    warning_codes_json, route, model_digest, created_at, completed_at
  FROM content_script_jobs WHERE job_id = ?`);
const usageQuery = db.prepare(`SELECT
    COALESCE(SUM(input_tokens), 0) AS input_tokens,
    COALESCE(SUM(output_tokens), 0) AS output_tokens,
    COALESCE(SUM(cost_usd), 0) AS cost_usd,
    COALESCE(SUM(provider_tool_cost_usd), 0) AS tool_cost_usd,
    COUNT(*) AS usage_rows
  FROM api_usage WHERE run_id = ?`);
const evidenceRows = [];
try {
  for (const scenario of state.scenarios) {
    const job = jobQuery.get(scenario.jobId);
    if (!job || job.status !== 'completed' || job.delivery_mode !== scenario.deliveryMode) {
      fail(`job identity/status mismatch for ${scenario.id}`, 78);
    }
    const warnings = JSON.parse(job.warning_codes_json);
    if (!Array.isArray(warnings) || warnings.length !== 0) fail(`job warnings are not empty for ${scenario.id}`, 78);
    const usage = usageQuery.get(job.operation_id);
    if (!usage || Number(usage.usage_rows) < 1 || Number(usage.input_tokens) < 1 || Number(usage.output_tokens) < 1) {
      fail(`attributed provider usage is missing for ${scenario.id}`, 78);
    }
    evidenceRows.push({
      id: scenario.id,
      phase: scenario.phase,
      deliveryMode: scenario.deliveryMode,
      language: scenario.language,
      topicSha256: scenario.topicSha256,
      jobId: scenario.jobId,
      scriptSha256: scenario.output.scriptSha256,
      wordCount: scenario.output.wordCount,
      sourceConsistent: scenario.output.sourceConsistent,
      route: job.route,
      modelDigest: job.model_digest,
      createdAt: job.created_at,
      completedAt: job.completed_at,
      inputTokens: Number(usage.input_tokens),
      outputTokens: Number(usage.output_tokens),
      providerCostUsd: Number(Number(usage.cost_usd).toFixed(6)),
      toolCostUsd: Number(Number(usage.tool_cost_usd).toFixed(6)),
    });
  }
} finally {
  db.close();
}

const delivery = Object.fromEntries(['standard', 'scheduled', 'priority'].map((mode) => [
  mode, evidenceRows.filter((row) => row.deliveryMode === mode).length,
]));
const languages = Object.fromEntries(['en', 'pt-BR'].map((language) => [
  language, evidenceRows.filter((row) => row.language === language).length,
]));
const acceptancePass = delivery.standard === 4 && delivery.scheduled === 3 && delivery.priority === 3
  && languages.en === 5 && languages['pt-BR'] === 5
  && evidenceRows.every((row) => row.wordCount >= 1900 && row.wordCount <= 2400)
  && evidenceRows.filter((row) => row.phase === 'pre-release').length === 9
  && evidenceRows.filter((row) => row.phase === 'production-smoke').length === 1;
if (!acceptancePass) fail('ten-script delivery/language/word-count contract failed', 78);

const artifact = {
  schemaVersion: 'nexus.content-ten-script-evidence.v1',
  generatedAt: new Date().toISOString(),
  sourceSha,
  stateSha256: sha256(stateBytes),
  acceptancePass,
  inventory: { count: 10, delivery, languages, preRelease: 9, productionSmoke: 1 },
  p95Tokens: {
    input: p95(evidenceRows.map((row) => row.inputTokens)),
    output: p95(evidenceRows.map((row) => row.outputTokens)),
  },
  totalProviderCostUsd: Number(evidenceRows.reduce((sum, row) => sum + row.providerCostUsd, 0).toFixed(6)),
  totalToolCostUsd: Number(evidenceRows.reduce((sum, row) => sum + row.toolCostUsd, 0).toFixed(6)),
  scripts: evidenceRows,
};
const bytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`);
atomicPrivateWrite(outputPath, bytes);
console.log(JSON.stringify({
  schemaVersion: artifact.schemaVersion,
  acceptancePass: artifact.acceptancePass,
  artifactSha256: sha256(bytes),
  p95Tokens: artifact.p95Tokens,
  totalProviderCostUsd: artifact.totalProviderCostUsd,
  totalToolCostUsd: artifact.totalToolCostUsd,
}, null, 2));
