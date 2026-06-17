#!/usr/bin/env node
// Copyright (c) 2026 Felipe Dominguez. MIT License. See LICENSE.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\b(?:API_KEY|SECRET|TOKEN|PASSWORD|PRIVATE_KEY)\s*=\s*['"]?[^'"\s]{8,}/i,
  /\b(?:access_token|refresh_token)\s*[:=]\s*['"]?[A-Za-z0-9._-]{20,}/i,
];

export function parseExportArgs(argv) {
  const parsed = {
    input: '.local/reward-runs',
    output: '.local/reward-runs/reward-dataset.jsonl',
    format: 'nexus-jsonl',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--input') parsed.input = argv[++index];
    else if (arg.startsWith('--input=')) parsed.input = arg.slice('--input='.length);
    else if (arg === '--output') parsed.output = argv[++index];
    else if (arg.startsWith('--output=')) parsed.output = arg.slice('--output='.length);
    else if (arg === '--format') parsed.format = argv[++index];
    else if (arg.startsWith('--format=')) parsed.format = arg.slice('--format='.length);
    else if (arg === '-h' || arg === '--help') parsed.help = true;
    else {
      parsed.unknown = parsed.unknown || [];
      parsed.unknown.push(arg);
    }
  }
  if (parsed.format !== 'nexus-jsonl') throw new Error('only --format nexus-jsonl is supported in v1');
  return parsed;
}

export function exportRewardDataset({ input, output, cwd = process.cwd() }) {
  const runs = loadRuns(path.resolve(cwd, input));
  const records = [];
  const skipped = [];

  for (const run of runs) {
    const eligibility = run.exportEligibility || { eligible: false, reason: 'missing export eligibility' };
    if (!eligibility.eligible) {
      skipped.push({ runId: run.runId || 'unknown', reason: eligibility.reason || 'export ineligible' });
      continue;
    }
    if (!/human[- ]reviewed|reviewed by human|manual review complete/i.test(eligibility.reason || '')) {
      skipped.push({ runId: run.runId || 'unknown', reason: 'human review marker missing' });
      continue;
    }
    const record = toDatasetRecord(run);
    const serialized = JSON.stringify(record);
    if (SECRET_PATTERNS.some((pattern) => pattern.test(serialized))) {
      skipped.push({ runId: run.runId || 'unknown', reason: 'secret-like content detected after sanitization' });
      continue;
    }
    records.push(record);
  }

  const destination = path.resolve(cwd, output);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, records.map((record) => JSON.stringify(record)).join('\n') + (records.length > 0 ? '\n' : ''));
  return { outputPath: destination, exported: records.length, skipped };
}

function loadRuns(inputPath) {
  if (!fs.existsSync(inputPath)) return [];
  const stats = fs.statSync(inputPath);
  const files = stats.isDirectory()
    ? fs.readdirSync(inputPath).filter((file) => file.endsWith('.json')).map((file) => path.join(inputPath, file))
    : [inputPath];
  const runs = [];
  for (const file of files) {
    try {
      runs.push(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch {
      // Invalid run files are ignored; reward-check validation owns run shape.
    }
  }
  return runs;
}

export function toDatasetRecord(run) {
  const signal = (id) => (run.signals || []).find((item) => item.id === id)?.details?.summary;
  const hardFailureLabels = (run.hardFailures || []).map((failure) => failure.label || failure.id);
  return {
    task: sanitize(signal('task-summary') || `${run.area || 'unknown'} deliverable reward review`),
    context: sanitize(`Policy ${run.policyVersion || 'unknown'}; area ${run.area || 'unknown'}; verdict ${run.verdict || 'unknown'}`),
    deliverableSummary: sanitize(signal('deliverable-summary') || summarizeChecks(run)),
    verifierInput: {
      area: run.area,
      changedFiles: (run.changedFiles || []).map((file) => sanitize(file)),
      mandatoryCheckIds: (run.mandatoryChecks || []).map((check) => check.id),
    },
    verifierOutput: {
      verdict: run.verdict,
      score: run.score,
      hardFailures: hardFailureLabels.map((label) => sanitize(label)),
      skippedChecks: (run.skippedChecks || []).map((check) => ({
        id: check.id,
        classification: check.skipClassification || check.verdictImpact,
        reason: sanitize(check.reason || ''),
      })),
      redactions: run.redactions || [],
    },
    humanLabel: humanLabelFor(run),
    lesson: sanitize(signal('lesson') || lessonFor(run)),
  };
}

function summarizeChecks(run) {
  const checks = [...(run.mandatoryChecks || []), ...(run.optionalChecks || [])];
  if (checks.length === 0) return 'No verifier checks recorded.';
  return checks.map((check) => `${check.id}: ${check.status}`).join('; ');
}

function humanLabelFor(run) {
  if (['good', 'bad', 'partial'].includes(run.humanLabel)) return run.humanLabel;
  if (run.verdict === 'PASS') return 'good';
  if (run.verdict === 'FAIL') return 'bad';
  return 'partial';
}

function lessonFor(run) {
  if (run.verdict === 'PASS') return 'Keep collecting explicit evidence and compact reward summaries.';
  if (run.verdict === 'FAIL') return 'Fix hard failures before relying on numeric score or handoff confidence.';
  if (run.verdict === 'MANUAL_REQUIRED') return 'Name missing manual evidence instead of claiming deterministic proof.';
  return 'Use warning/skipped-check details to improve the next verifier or prompt.';
}

function sanitize(value) {
  let output = String(value || '');
  output = output.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED:private-key]');
  output = output.replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, '[REDACTED:openai-key]');
  output = output.replace(/\b(?:API_KEY|SECRET|TOKEN|PASSWORD|PRIVATE_KEY)\s*=\s*['"]?[^'"\s]{8,}/gi, '[REDACTED:env-secret]');
  output = output.replace(/\b(?:access_token|refresh_token)\s*[:=]\s*['"]?[A-Za-z0-9._-]{20,}/gi, '[REDACTED:oauth-token]');
  return output.slice(0, 2000);
}

function usage() {
  return `Usage:
  node scripts/export-reward-dataset.mjs --input .local/reward-runs --output .local/reward-runs/reward-dataset.jsonl

Options:
  --input <file-or-dir>    Reward run JSON file or directory.
  --output <path>          Provider-neutral Nexus JSONL output.
  --format nexus-jsonl     Only supported v1 format.`;
}

async function main() {
  let args;
  try {
    args = parseExportArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[reward-export] ${error.message}`);
    console.error(usage());
    process.exit(64);
  }

  if (args.help) {
    console.log(usage());
    return;
  }

  const result = exportRewardDataset(args);
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[reward-export] ${error.stack || error.message}`);
    process.exit(1);
  });
}
