#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { loadContinuousDeploymentPolicy } from './lib/release-manifest.mjs';

/**
 * Read-only readiness probe for the Raspberry Pi CI runner.
 *
 * The Pi is unverified hardware until this passes. It runs before the runner is
 * activated and answers one question: can this machine finish the risk-selected
 * suite inside its budget, with the memory and storage to do it?
 *
 * Every check is read-only. Nothing is installed, configured, or started, and no
 * secret is read — the probe must be safe to run on a machine that is not yet
 * trusted with anything.
 *
 * It also asserts the *negative* capabilities the plan requires: the runner must
 * not have a Docker socket, production secrets, a deploy key, or production
 * audit-receipt access. A test runner that can reach any of those is not
 * verification-only.
 *
 * Usage:
 *   node scripts/pi-runner-readiness.mjs [--json] [--skip-suite]
 *   node scripts/pi-runner-readiness.mjs --capabilities-only --json
 */

const args = process.argv.slice(2);
const outputJson = args.includes('--json');
const skipSuite = args.includes('--skip-suite');
// `--capabilities-only` is what CI runs on every job: it asserts the runner is
// still test-only, without re-measuring hardware or spending egress time.
const capabilitiesOnly = args.includes('--capabilities-only');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const policy = loadContinuousDeploymentPolicy(root);
const requirements = policy.piRunner;

const checks = [];
function record(name, ok, detail) {
  checks.push({ name, result: ok ? 'passed' : 'failed', detail: detail ?? null });
  return ok;
}

// ── hardware, runtime and egress ────────────────────────────────────────────
// Skipped under --capabilities-only: CI re-asserts the test-only posture on
// every job, but re-measuring hardware and egress on every job is waste.
async function probeHostCapacity() {
  const platform = os.platform();
  const arch = os.arch();
  const machine = os.machine ? os.machine() : arch;
  record('os_is_linux', platform === requirements.requiredOs, `platform ${platform}`);
  record(
    'arch_is_arm64',
    arch === 'arm64' || machine === requirements.requiredArch,
    `arch ${arch} machine ${machine}`,
  );

  // MemAvailable is what a build can actually use; total memory overstates it on
  // a board that is also running other services.
  let memoryGiB = os.freemem() / 1024 ** 3;
  try {
    const available = /^MemAvailable:\s+(\d+) kB$/m.exec(fs.readFileSync('/proc/meminfo', 'utf8'));
    if (available) memoryGiB = Number(available[1]) / 1024 / 1024;
  } catch {
    // keep the portable measurement
  }
  record(
    'usable_memory',
    memoryGiB >= requirements.minUsableMemoryGiB,
    `${memoryGiB.toFixed(2)} GiB usable, need ${requirements.minUsableMemoryGiB}`,
  );

  const df = spawnSync('df', ['-Pk', root], { encoding: 'utf8' });
  const availableKb = df.status === 0
    ? Number((df.stdout.trim().split('\n').pop() ?? '').split(/\s+/)[3])
    : Number.NaN;
  const storageGiB = Number.isFinite(availableKb) ? availableKb / 1024 / 1024 : null;
  record(
    'free_storage',
    storageGiB !== null && storageGiB >= requirements.minFreeStorageGiB,
    storageGiB === null
      ? 'could not measure free storage'
      : `${storageGiB.toFixed(2)} GiB free, need ${requirements.minFreeStorageGiB}`,
  );

  record(
    'node_version',
    process.versions.node === requirements.nodeVersion,
    `node ${process.versions.node}, need ${requirements.nodeVersion}`,
  );

  for (const host of requirements.requiredEgressHosts) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    let ok = false;
    try {
      const response = await fetch(`https://${host}/`, {
        method: 'HEAD',
        signal: controller.signal,
        redirect: 'manual',
      });
      ok = response.status > 0;
    } catch {
      ok = false;
    } finally {
      clearTimeout(timer);
    }
    record(`egress_${host.replace(/[^a-z0-9]+/gi, '_')}`, ok, `https://${host}`);
  }
}

if (!capabilitiesOnly) await probeHostCapacity();

// ── forbidden capabilities ──────────────────────────────────────────────────
// The Pi runs CI verification only. If it can reach the Docker socket it can
// build and deploy; if it can read production secrets or audit receipts, a test
// job is a production-credential job.
const forbiddenPaths = {
  'docker-socket': ['/var/run/docker.sock'],
  'production-secrets': [
    '/etc/nexus-release/production-backend.env',
    '/etc/nexus-release/production-content-engine.env',
    '/etc/nexus-release/staging-backend.env',
    '/etc/nexus-release/staging-content-engine.env',
  ],
  'deploy-key': ['/etc/nexus-release/trust/audit-mirror-id_ed25519'],
};
for (const capability of requirements.forbiddenCapabilities) {
  if (capability === 'production-audit-access') {
    const violations = [];
    if (fs.existsSync(policy.paths.stateDir)) {
      violations.push(`production state present: ${policy.paths.stateDir}`);
    }
    if (fs.existsSync(policy.auditMirror.path)) {
      const stat = fs.lstatSync(policy.auditMirror.path);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        violations.push(`audit path is not a canonical directory: ${policy.auditMirror.path}`);
      } else {
        const accessibleModes = [
          ['read', fs.constants.R_OK],
          ['write', fs.constants.W_OK],
          ['traverse', fs.constants.X_OK],
        ].filter(([, mode]) => {
          try {
            fs.accessSync(policy.auditMirror.path, mode);
            return true;
          } catch {
            return false;
          }
        }).map(([label]) => label);
        if (accessibleModes.length > 0) {
          violations.push(`audit receipts permit ${accessibleModes.join('/')} access`);
        }
      }
    }
    record(
      'absent_production_audit_access',
      violations.length === 0,
      violations.length === 0 ? 'no runner access' : violations.join('; '),
    );
    continue;
  }
  const paths = forbiddenPaths[capability] ?? [];
  const present = paths.filter((candidate) => fs.existsSync(candidate));
  record(
    `absent_${capability.replace(/[^a-z0-9]+/gi, '_')}`,
    present.length === 0,
    present.length === 0 ? 'not present' : `present: ${present.join(' ')}`,
  );
}

// ── focused-suite budget ────────────────────────────────────────────────────
if (skipSuite || capabilitiesOnly) {
  checks.push({
    name: 'focused_suite_budget',
    result: 'skipped',
    detail: capabilitiesOnly ? 'capabilities-only run' : 'suite skipped by flag',
  });
} else {
  // A fixed representative suite, not `test:changed`. Change-based selection on a
  // clean checkout selects nothing, so the budget check would "pass" in seconds
  // having measured no work at all — which is how unready hardware gets approved.
  const selectors = requirements.budgetSuite ?? [];
  if (selectors.length === 0) {
    record('focused_suite_budget', false, 'no representative budget suite configured');
  } else {
    const startedAt = Date.now();
    const result = spawnSync(
      'npx',
      ['vitest', 'run', '--reporter', 'json', '--outputFile', '.local/pi-readiness.json', ...selectors],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: (requirements.focusedSuiteBudgetSeconds + 180) * 1000,
        env: {
          ...process.env,
          NODE_ENV: 'test',
          DATABASE_PATH: ':memory:',
          TELEGRAM_BOT_TOKEN: 'test_token',
          TELEGRAM_ALLOWED_USER_IDS: '123456789',
        },
      },
    );
    const elapsedSeconds = (Date.now() - startedAt) / 1000;

    // Prove tests actually ran. An empty or all-skipped run measures nothing.
    let executed = 0;
    try {
      const report = JSON.parse(fs.readFileSync(path.join(root, '.local/pi-readiness.json'), 'utf8'));
      executed = Number(report.numPassedTests ?? 0) + Number(report.numFailedTests ?? 0);
    } catch {
      executed = 0;
    }
    if (executed === 0) {
      record('focused_suite_budget', false, 'representative suite executed zero tests');
    } else {
      record(
        'focused_suite_budget',
        result.status === 0 && elapsedSeconds <= requirements.focusedSuiteBudgetSeconds,
        `${executed} tests, exit ${result.status ?? 'timeout'} in ${elapsedSeconds.toFixed(0)}s, `
          + `budget ${requirements.focusedSuiteBudgetSeconds}s`,
      );
    }
  }
}

const failed = checks.filter((check) => check.result === 'failed');
const payload = {
  schema: 'nexus.pi-runner-readiness.v1',
  ok: failed.length === 0,
  expectedRunnerLabels: requirements.labels,
  checks,
};

if (outputJson) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
} else {
  for (const check of checks) {
    const mark = check.result === 'passed' ? '✅' : (check.result === 'skipped' ? '➖' : '❌');
    process.stdout.write(`${mark} ${check.name}${check.detail ? ` — ${check.detail}` : ''}\n`);
  }
  process.stdout.write(payload.ok
    ? `\nPi runner is ready. Register it with labels: ${requirements.labels.join(', ')}\n`
    : `\nPi runner is NOT ready: ${failed.length} check(s) failed. Use hosted CI until they pass.\n`);
}

process.exit(payload.ok ? 0 : 1);
