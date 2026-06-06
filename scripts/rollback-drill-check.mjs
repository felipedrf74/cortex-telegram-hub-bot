#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);

function readArg(name, fallback = '') {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  return args[index + 1] || fallback;
}

function hasArg(name) {
  return args.includes(name);
}

const root = path.resolve(readArg('--root', process.cwd()));
const evidencePath = path.resolve(
  root,
  readArg(
    '--evidence',
    process.env.NEXUS_ROLLBACK_DRILL_EVIDENCE_PATH || 'docs/release/evidence/rollback-drill-latest.json',
  ),
);
const maxAgeDays = Number(readArg('--max-age-days', process.env.NEXUS_ROLLBACK_DRILL_MAX_AGE_DAYS || '30'));
const outputJson = hasArg('--json');

function emit(payload, exitCode) {
  if (outputJson) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else if (payload.ok) {
    process.stdout.write(`rollback drill evidence OK: ${payload.evidencePath}\n`);
  } else {
    process.stderr.write(`rollback drill evidence invalid: ${payload.reasons.join('; ')}\n`);
  }
  process.exit(exitCode);
}

function isPassing(value) {
  return new Set(['pass', 'passed', 'success', 'succeeded']).has(String(value || '').toLowerCase());
}

function validateEvidence(evidence) {
  const reasons = [];
  if (evidence?.schema !== 'nexus.rollback-drill.v1') {
    reasons.push(`schema_unsupported:${evidence?.schema || 'missing'}`);
  }

  if (!isPassing(evidence?.result || evidence?.verdict)) {
    reasons.push(`result_not_passing:${evidence?.result || evidence?.verdict || 'missing'}`);
  }

  if (evidence?.restoreMode !== 'dry-run' && evidence?.dryRun !== true) {
    reasons.push('dry_run_restore_missing');
  }

  for (const key of ['sourceVersion', 'targetVersion', 'sourceSha', 'targetBackup', 'operator']) {
    if (!evidence?.[key] || typeof evidence[key] !== 'string') {
      reasons.push(`${key}_missing`);
    }
  }

  if (evidence?.databaseIntegrity !== 'ok') {
    reasons.push(`database_integrity_not_ok:${evidence?.databaseIntegrity || 'missing'}`);
  }
  if (evidence?.backupContainsDatabase !== true) {
    reasons.push('backup_database_proof_missing');
  }
  if (!isPassing(evidence?.healthCheck)) {
    reasons.push(`health_check_not_passing:${evidence?.healthCheck || 'missing'}`);
  }

  const drilledAt = evidence?.drilledAt || evidence?.generatedAt || null;
  if (!drilledAt) {
    reasons.push('drilled_at_missing');
  } else {
    const drilledMs = Date.parse(drilledAt);
    if (!Number.isFinite(drilledMs)) {
      reasons.push(`drilled_at_invalid:${drilledAt}`);
    } else {
      const ageMs = Date.now() - drilledMs;
      if (ageMs < -5 * 60 * 1000) {
        reasons.push(`drilled_at_in_future:${drilledAt}`);
      }
      if (maxAgeDays > 0 && ageMs > maxAgeDays * 24 * 60 * 60 * 1000) {
        reasons.push(`drill_stale:${Math.floor(ageMs / 86400000)}d>${maxAgeDays}d`);
      }
    }
  }

  return reasons;
}

if (!fs.existsSync(evidencePath)) {
  emit({
    ok: false,
    evidencePath,
    reasons: ['rollback_drill_evidence_missing'],
  }, 1);
}

let evidence;
try {
  evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
} catch (error) {
  emit({
    ok: false,
    evidencePath,
    reasons: [`rollback_drill_evidence_invalid_json:${error instanceof Error ? error.message : String(error)}`],
  }, 1);
}

const reasons = validateEvidence(evidence);
emit({
  ok: reasons.length === 0,
  evidencePath,
  reasons,
  evidence: {
    schema: evidence?.schema,
    drilledAt: evidence?.drilledAt || evidence?.generatedAt || null,
    sourceVersion: evidence?.sourceVersion || null,
    targetVersion: evidence?.targetVersion || null,
    targetBackup: evidence?.targetBackup || null,
    result: evidence?.result || evidence?.verdict || null,
  },
}, reasons.length === 0 ? 0 : 1);
