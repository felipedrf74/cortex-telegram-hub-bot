#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
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
const baseRef = readArg('--base', '');
const explicitFiles = readArg('--files', '');
const changedOnly = hasArg('--changed-only');
const outputJson = hasArg('--json');

const knownHistoricalGaps = new Set([
  142,
  143,
  162,
  163,
  164,
  165,
  166,
  167,
  168,
  169,
  170,
  171,
  175,
  176,
]);
const legacyDuplicatePrefixes = new Map([
  ['008', ['008_api_cache.sql', '008_email_log.sql']],
  ['009', ['009_api_usage_provider.sql', '009_job_history.sql']],
  ['022', ['022_finance_tables.sql', '022_webhook_events.sql']],
  ['023', ['023_fitness_training_plans.sql', '023_onboarding.sql']],
  ['024', ['024_cooking_tables.sql', '024_usage_metering.sql']],
]);

function git(commandArgs) {
  return execFileSync('git', commandArgs, { cwd: root, encoding: 'utf8' }).trim();
}

function resolveBase() {
  if (baseRef) {
    git(['rev-parse', '--verify', `${baseRef}^{commit}`]);
    return baseRef;
  }
  for (const ref of ['origin/main', 'main', 'HEAD~1']) {
    try {
      git(['rev-parse', '--verify', `${ref}^{commit}`]);
      return ref;
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error('Could not resolve a base ref for changed-migration policy');
}

function migrationFiles() {
  const dir = path.join(root, 'migrations');
  return fs.readdirSync(dir)
    .filter((file) => /^\d{3}_.*\.sql$/.test(file))
    .sort();
}

function sameMembers(left, right) {
  const a = [...left].sort();
  const b = [...right].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function changedFiles() {
  if (explicitFiles) {
    return explicitFiles.split(',').map((file) => file.trim()).filter(Boolean);
  }
  const resolved = resolveBase();
  const committed = execFileSync(
    'git',
    ['diff', '--name-only', `${resolved}...HEAD`],
    { cwd: root, encoding: 'utf8' },
  ).trim();
  const dirty = execFileSync(
    'git',
    ['status', '--porcelain'],
    { cwd: root, encoding: 'utf8' },
  )
    .split('\n')
    .map((line) => line.replace(/^[ MADRCU?!]{2} /, '').replace(/^"|"$/g, ''))
    .filter(Boolean);
  return [...new Set([
    ...committed.split('\n').filter(Boolean),
    ...dirty,
  ])].sort();
}

function stripSqlComments(sql) {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
}

function irreversibleReason(sql) {
  const stripped = stripSqlComments(sql);
  const checks = [
    ['DROP TABLE', /\bDROP\s+TABLE\b/i],
    ['DROP COLUMN', /\bDROP\s+COLUMN\b/i],
    ['ALTER TABLE RENAME', /\bALTER\s+TABLE\b[^;]*\bRENAME\b/i],
    ['RENAME TO', /\bRENAME\s+TO\b/i],
  ];
  for (const [label, pattern] of checks) {
    if (pattern.test(stripped)) return label;
  }
  return null;
}

function verifySequence(files, errors) {
  const prefixes = [...new Set(files.map((file) => Number(file.slice(0, 3))))].sort((a, b) => a - b);
  let expected = 1;
  for (const prefix of prefixes) {
    while (knownHistoricalGaps.has(expected) && expected < prefix) {
      expected += 1;
    }
    if (prefix !== expected) {
      errors.push(`migration_sequence_gap:expected_${String(expected).padStart(3, '0')}:got_${String(prefix).padStart(3, '0')}`);
      return;
    }
    expected += 1;
  }
}

function verifyDuplicates(files, errors) {
  const groups = new Map();
  for (const file of files) {
    const prefix = file.slice(0, 3);
    groups.set(prefix, [...(groups.get(prefix) || []), file]);
  }
  for (const [prefix, members] of groups.entries()) {
    if (members.length <= 1) continue;
    if (!sameMembers(members, legacyDuplicatePrefixes.get(prefix) || [])) {
      errors.push(`migration_duplicate_prefix:${prefix}:${members.sort().join(',')}`);
    }
  }
}

function runCumulativeRehearsal(files, errors) {
  const dbPath = path.join(os.tmpdir(), `nexus-migration-rehearsal-${process.pid}-${Date.now()}.db`);
  try {
    for (const file of files) {
      const sqlPath = path.join(root, 'migrations', file);
      const result = spawnSync('sqlite3', [dbPath], {
        cwd: root,
        input: fs.readFileSync(sqlPath),
        encoding: 'utf8',
      });
      if (result.status !== 0) {
        const detail = (result.stderr || result.stdout || '').trim().replace(/\s+/g, ' ');
        errors.push(`migration_rehearsal_failed:${file}:${detail || `exit_${result.status}`}`);
        return;
      }
    }
  } finally {
    for (const suffix of ['', '-wal', '-shm']) {
      fs.rmSync(`${dbPath}${suffix}`, { force: true });
    }
  }
}

function checkChangedIrreversible(errors) {
  if (!changedOnly) {
    return [];
  }
  const changed = changedFiles()
    .filter((file) => /^migrations\/\d{3}_.*\.sql$/.test(file))
    .filter((file) => fs.existsSync(path.join(root, file)));
  const irreversible = [];
  for (const file of changed) {
    const reason = irreversibleReason(fs.readFileSync(path.join(root, file), 'utf8'));
    if (reason) {
      irreversible.push({ file, reason });
    }
  }
  if (irreversible.length === 0) {
    return irreversible;
  }

  const approver = process.env.NEXUS_MIGRATION_APPROVER || '';
  const backupEvidence = process.env.NEXUS_MIGRATION_BACKUP_EVIDENCE || '';
  if (!approver || !backupEvidence) {
    errors.push(
      `irreversible_migration_fast_path_blocked:${irreversible.map(({ file, reason }) => `${file}:${reason}`).join('|')}`,
    );
  }
  return irreversible;
}

const errors = [];
const files = migrationFiles();
verifySequence(files, errors);
verifyDuplicates(files, errors);
runCumulativeRehearsal(files, errors);
const irreversible = checkChangedIrreversible(errors);

const payload = {
  ok: errors.length === 0,
  generatedAt: new Date().toISOString(),
  migrationCount: files.length,
  checks: {
    sequence: !errors.some((error) => error.startsWith('migration_sequence_gap')),
    duplicates: !errors.some((error) => error.startsWith('migration_duplicate_prefix')),
    cumulativeRehearsal: !errors.some((error) => error.startsWith('migration_rehearsal_failed')),
    changedIrreversiblePolicy: !errors.some((error) => error.startsWith('irreversible_migration_fast_path_blocked')),
  },
  changedOnly,
  irreversibleChangedMigrations: irreversible,
  manualApproval: {
    approver: process.env.NEXUS_MIGRATION_APPROVER || null,
    backupEvidence: process.env.NEXUS_MIGRATION_BACKUP_EVIDENCE || null,
  },
  errors,
};

if (outputJson) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
} else if (payload.ok) {
  process.stdout.write(`✅ Migration safety checks passed (${files.length} migrations)\n`);
  if (irreversible.length > 0) {
    process.stdout.write(`   Irreversible migration approved by ${payload.manualApproval.approver}\n`);
  }
} else {
  for (const error of errors) {
    process.stderr.write(`❌ ${error}\n`);
  }
}

process.exit(payload.ok ? 0 : 1);
