import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createObservationFixture,
  OLLAMA_RETAINED,
  writeMode600,
} from './helpers/ollama-observation-fixture';

const INSTALLER = path.resolve('scripts/install-ollama.sh');
const CHECKER = path.resolve('scripts/ollama-service-envelope-check.mjs');
const TRANSITION = path.resolve('scripts/ollama-zero-swap-transition.mjs');
const RETAINED = OLLAMA_RETAINED;
const RETAINED_DIGEST = `sha256:${'a'.repeat(64)}`;
const ENVELOPE_VARIABLES = [
  'OLLAMA_CONTEXT_LENGTH',
  'OLLAMA_MAX_QUEUE',
  'OLLAMA_NUM_PARALLEL',
  'OLLAMA_MAX_LOADED_MODELS',
  'OLLAMA_MEMORY_HIGH',
  'OLLAMA_MEMORY_MAX',
  'OLLAMA_MEMORY_SWAP_MAX',
  'OLLAMA_CPU_QUOTA',
];

function cleanEnvironment() {
  const env = { ...process.env };
  for (const name of ENVELOPE_VARIABLES) delete env[name];
  return env;
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv = cleanEnvironment()) {
  return spawnSync(command, args, {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
    timeout: 15_000,
  });
}

function iso(hoursBeforeNow: number) {
  return new Date(Date.now() - hoursBeforeNow * 60 * 60 * 1000).toISOString();
}

describe('fixed Ollama systemd envelope and zero-swap transition', () => {
  let tempDir: string;
  let dropInDir: string;
  let dropInPath: string;
  let fakeSystemctl: string;
  let fakeState: string;
  let fakeLog: string;
  let cleanupResultPath: string;
  let evidencePath: string;

  function baseEnv(extra: NodeJS.ProcessEnv = {}) {
    return {
      ...cleanEnvironment(),
      NEXUS_OLLAMA_SYSTEMD_TEST_MODE: '1',
      NEXUS_OLLAMA_COLLECTOR_TEST_MODE: '1',
      FAKE_SYSTEMD_STATE: fakeState,
      FAKE_SYSTEMD_LOG: fakeLog,
      FAKE_OLLAMA_DROP_IN: dropInPath,
      ...extra,
    };
  }

  function cleanupResult() {
    return {
      schema: 'nexus.ollama-large-model-cleanup-result.v1',
      host: 'serverdominguez',
      status: 'complete',
      startedAt: iso(24.4),
      completedAt: iso(24.3),
      plan: {
        schema: 'nexus.ollama-large-model-cleanup-plan.v1',
        host: 'serverdominguez',
        evidenceDigest: `sha256:${'e'.repeat(64)}`,
        inventoryFingerprint: `sha256:${'f'.repeat(64)}`,
        retained: { tag: RETAINED, digest: RETAINED_DIGEST },
        delete: [
          { tag: 'gemma2:2b-instruct-q4_K_M', digest: `sha256:${'b'.repeat(64)}` },
          { tag: 'qwen3.6:27b-q4_K_M', digest: `sha256:${'c'.repeat(64)}` },
          { tag: 'qwen3.6:35b-a3b-q4_K_M', digest: `sha256:${'d'.repeat(64)}` },
        ],
        ackPlan: `sha256:${'1'.repeat(64)}`,
      },
      finalInventory: [{ tag: RETAINED, digest: RETAINED_DIGEST }],
      retainedDigestVerifiedBeforeAndAfter: true,
    };
  }

  function writeObservation(shortObservation = false) {
    const cleanupReference = writeMode600(cleanupResultPath, cleanupResult());
    const durationSeconds = (shortObservation ? 23 : 24) * 60 * 60;
    const fixture = createObservationFixture({
      root: tempDir,
      phase: 'zero_swap',
      startedAt: iso(shortObservation ? 23.2 : 24.2),
      durationSeconds,
      intervalSeconds: 60 * 60,
      subject: cleanupReference,
    });
    evidencePath = fixture.resultPath;
    return fixture;
  }

  function transitionArgs(extra: string[] = []) {
    return [
      '--cleanup-result', cleanupResultPath,
      '--evidence', evidencePath,
      '--systemctl-bin', fakeSystemctl,
      '--drop-in-path', dropInPath,
      ...extra,
    ];
  }

  beforeEach(() => {
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-ollama-systemd-')));
    fs.chmodSync(tempDir, 0o700);
    dropInDir = path.join(tempDir, 'dropins');
    fs.mkdirSync(dropInDir, { mode: 0o700 });
    dropInPath = path.join(dropInDir, 'zz-nexus-zero-swap.conf');
    fakeSystemctl = path.join(tempDir, 'systemctl');
    fakeState = path.join(tempDir, 'state');
    fakeLog = path.join(tempDir, 'systemctl.log');
    cleanupResultPath = path.join(tempDir, 'cleanup-result.json');
    fs.writeFileSync(fakeState, 'baseline\n', { mode: 0o600 });
    writeObservation();

    fs.writeFileSync(fakeSystemctl, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_SYSTEMD_LOG, JSON.stringify(args) + '\\n');
const statePath = process.env.FAKE_SYSTEMD_STATE;
const dropIn = process.env.FAKE_OLLAMA_DROP_IN;
if (args[0] === 'show') {
  const state = fs.readFileSync(statePath, 'utf8').trim();
  const swap = state === 'zero' ? 0 : 536870912;
  const queue = process.env.FAKE_MAX_QUEUE || '4';
  process.stdout.write([
    'Environment=OLLAMA_CONTEXT_LENGTH=4096 OLLAMA_MAX_QUEUE=' + queue + ' OLLAMA_NUM_PARALLEL=1 OLLAMA_MAX_LOADED_MODELS=1',
    'MemoryHigh=4294967296',
    'MemoryMax=6442450944',
    'MemorySwapMax=' + swap,
    'CPUQuotaPerSecUSec=2s',
    '',
  ].join('\\n'));
  process.exit(0);
}
if (args[0] === 'daemon-reload') process.exit(0);
if (args[0] === 'restart') {
  const zeroRequested = fs.existsSync(dropIn);
  if (zeroRequested && process.env.FAKE_FAIL_ZERO_RESTART === '1') process.exit(2);
  fs.writeFileSync(statePath, zeroRequested ? 'zero\\n' : 'baseline\\n');
  process.exit(0);
}
if (args[0] === 'is-active') process.exit(process.env.FAKE_INACTIVE === '1' ? 3 : 0);
process.exit(64);
`, { mode: 0o755 });
    fs.chmodSync(fakeSystemctl, 0o755);
  });

  afterEach(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it('executes the installer policy check and rejects every envelope environment override', () => {
    const valid = run('bash', [INSTALLER, '--verify-envelope-only']);
    expect(valid.status, valid.stderr).toBe(0);
    expect(JSON.parse(valid.stdout)).toEqual({
      contextLength: 4096,
      maxQueue: 4,
      numParallel: 1,
      maxLoadedModels: 1,
      memoryHigh: '4G',
      memoryMax: '6G',
      cpuQuota: '200%',
      memorySwapMax: '512M',
    });

    for (const name of ENVELOPE_VARIABLES) {
      const rejected = run('bash', [INSTALLER, '--verify-envelope-only'], {
        ...cleanEnvironment(),
        [name]: name === 'OLLAMA_CPU_QUOTA' ? '200%' : '1',
      });
      expect(rejected.status).toBe(8);
      expect(rejected.stderr).toContain(`environment override is forbidden for ${name}`);
    }
    const source = fs.readFileSync(INSTALLER, 'utf8');
    expect(source.indexOf('systemctl restart ollama'))
      .toBeLessThan(source.lastIndexOf('nexus-ollama-service-envelope-check.mjs'));
  });

  it('does not send the privileged model pull through a predictable temporary path', () => {
    const source = fs.readFileSync(INSTALLER, 'utf8');
    const pullStart = source.indexOf('log "Pulling small-only model:');
    const pullEnd = source.indexOf('# ── Warm-load + smoke', pullStart);

    expect(pullStart).toBeGreaterThan(0);
    expect(pullEnd).toBeGreaterThan(pullStart);

    const pullBlock = source.slice(pullStart, pullEnd);
    expect(pullBlock).toContain('if ! ollama pull "${PRIMARY_MODEL}"; then');
    expect(pullBlock).toContain('inspect the Ollama output above');
    expect(pullBlock).not.toMatch(/\btee\b/);
    expect(pullBlock).not.toMatch(/\/(?:var\/)?tmp\//);
    expect(source).not.toContain('/tmp/ollama-pull-primary.log');
  });

  it('accepts only the exact effective 4G/6G/512M/200% one-model baseline', () => {
    const valid = run(process.execPath, [
      CHECKER,
      '--systemctl-bin', fakeSystemctl,
      '--expected-swap-bytes', '536870912',
    ], baseEnv());
    expect(valid.status, valid.stderr).toBe(0);
    expect(JSON.parse(valid.stdout).observed).toMatchObject({
      contextLength: 4096,
      maxQueue: 4,
      numParallel: 1,
      maxLoadedModels: 1,
      memoryHighBytes: 4294967296,
      memoryMaxBytes: 6442450944,
      memorySwapMaxBytes: 536870912,
      cpuQuotaUsecPerSec: 2000000,
    });

    const drift = run(process.execPath, [
      CHECKER,
      '--systemctl-bin', fakeSystemctl,
      '--expected-swap-bytes', '536870912',
    ], baseEnv({ FAKE_MAX_QUEUE: '5' }));
    expect(drift.status).not.toBe(0);
    expect(drift.stderr).toContain('OLLAMA_MAX_QUEUE must be exactly 4');
  });

  it('requires an additional healthy 24h and explicit owner acknowledgment before changing only swap to zero', () => {
    const dryRun = run(process.execPath, [TRANSITION, ...transitionArgs(['--dry-run'])], baseEnv());
    expect(dryRun.status, dryRun.stderr).toBe(0);
    const plan = JSON.parse(dryRun.stdout);
    expect(plan.mutationAttempted).toBe(false);
    expect(plan.executionMode).toBe('test');
    expect(plan.dropInPath).toBe(dropInPath);
    expect(plan.transition.memorySwapMaxBytes).toEqual({ from: 536870912, to: 0 });
    expect(plan.ackPlan).toMatch(/^sha256:[0-9a-f]{64}$/);

    const resultPath = path.join(tempDir, 'zero-swap-result.json');
    const apply = run(process.execPath, [TRANSITION, ...transitionArgs([
      '--apply',
      '--owner-authorized',
      '--ack-plan', plan.ackPlan,
      '--result', resultPath,
    ])], baseEnv());
    expect(apply.status, apply.stderr).toBe(0);
    expect(fs.readFileSync(dropInPath, 'utf8')).toBe('[Service]\nMemorySwapMax=0\n');
    expect(fs.readFileSync(fakeState, 'utf8').trim()).toBe('zero');
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    expect(result.status).toBe('complete');
    expect(result.finalEnvelope.memorySwapMaxBytes).toBe(0);
    expect(fs.statSync(resultPath).mode & 0o777).toBe(0o600);
  });

  it('rejects missing authorization, short observations, and baseline envelope drift without mutation', () => {
    const dryRun = run(process.execPath, [TRANSITION, ...transitionArgs()], baseEnv());
    const token = JSON.parse(dryRun.stdout).ackPlan;
    const noOwner = run(process.execPath, [TRANSITION, ...transitionArgs([
      '--apply', '--ack-plan', token, '--result', path.join(tempDir, 'result.json'),
    ])], baseEnv());
    expect(noOwner.status).not.toBe(0);
    expect(noOwner.stderr).toContain('--owner-authorized is required');

    writeObservation(true);
    const short = run(process.execPath, [TRANSITION, ...transitionArgs()], baseEnv());
    expect(short.status).not.toBe(0);
    expect(short.stderr).toContain('at least 24 hours');

    writeObservation();
    const drift = run(process.execPath, [TRANSITION, ...transitionArgs()], baseEnv({ FAKE_MAX_QUEUE: '5' }));
    expect(drift.status).not.toBe(0);
    expect(drift.stderr).toContain('OLLAMA_MAX_QUEUE must be exactly 4');
    expect(fs.existsSync(dropInPath)).toBe(false);
  });

  it('removes its new drop-in and verifies the 512 MiB baseline when transition restart fails', () => {
    const dryRun = run(process.execPath, [TRANSITION, ...transitionArgs()], baseEnv());
    const token = JSON.parse(dryRun.stdout).ackPlan;
    const resultPath = path.join(tempDir, 'failed-result.json');
    const apply = run(process.execPath, [TRANSITION, ...transitionArgs([
      '--apply', '--owner-authorized', '--ack-plan', token, '--result', resultPath,
    ])], baseEnv({ FAKE_FAIL_ZERO_RESTART: '1' }));

    expect(apply.status).not.toBe(0);
    expect(apply.stderr).toContain('512 MiB baseline was restored');
    expect(fs.existsSync(dropInPath)).toBe(false);
    expect(fs.readFileSync(fakeState, 'utf8').trim()).toBe('baseline');
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    expect(result.status).toBe('failed');
    expect(result.rollbackSucceeded).toBe(true);
  });

  it('documents the operation as separate, evidence-gated, and owner-authorized', () => {
    const runbook = fs.readFileSync('ops/ollama/LARGE_MODEL_CLEANUP.md', 'utf8');
    const transition = fs.readFileSync(TRANSITION, 'utf8');
    expect(runbook).toContain('Separate zero-swap transition');
    expect(runbook).toContain('additional healthy 24 hours');
    expect(runbook).toContain('--owner-authorized');
    expect(runbook).toContain('zz-nexus-zero-swap.conf');
    expect(transition).toContain('/zz-nexus-zero-swap.conf');
    expect(['override.conf', 'zz-nexus-zero-swap.conf'].sort()).toEqual([
      'override.conf', 'zz-nexus-zero-swap.conf',
    ]);
    expect(runbook).toContain('--phase zero_swap');
    expect(runbook).toContain('--cleanup-result');
    expect(runbook).not.toContain('zero-swap-evidence.example.json');
  });
});
