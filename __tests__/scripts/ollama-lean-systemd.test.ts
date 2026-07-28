import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const INSTALLER = path.resolve('scripts/install-ollama.sh');
const ENVELOPE_CHECKER = path.resolve('scripts/ollama-service-envelope-check.mjs');
const TRANSACTION = path.resolve('scripts/ollama-systemd-dropin-transaction.mjs');
const INSTALL_STATE = path.resolve('scripts/ollama-install-state-check.mjs');
const RETAINED_MODEL = 'qwen2.5:3b-instruct-q4_K_M';
const RETAINED_DIGEST =
  '357c53fb659c5076de1d65ccb0b397446227b71a42be9d1603d46168015c9e4b';
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

function executable(file: string, source: string) {
  fs.writeFileSync(file, source, { mode: 0o755 });
  fs.chmodSync(file, 0o755);
}

function runNode(file: string, args: string[], env: NodeJS.ProcessEnv) {
  const activeMutant = (
    globalThis as typeof globalThis & { __stryker__?: { activeMutant?: string } }
  ).__stryker__?.activeMutant;
  return spawnSync(process.execPath, [file, ...args], {
    cwd: process.cwd(),
    env: activeMutant === undefined
      ? env
      : { ...env, __STRYKER_ACTIVE_MUTANT__: activeMutant },
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
}

function cleanEnvironment() {
  const environment = { ...process.env };
  for (const variable of ENVELOPE_VARIABLES) delete environment[variable];
  return environment;
}

describe('lean Ollama installer and fixed systemd envelope', () => {
  let root: string;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-ollama-envelope-')));
    fs.chmodSync(root, 0o700);
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('rejects every envelope override and reports the one approved policy', () => {
    const valid = spawnSync('bash', [INSTALLER, '--verify-envelope-only'], {
      cwd: process.cwd(),
      env: cleanEnvironment(),
      encoding: 'utf8',
      timeout: 15_000,
    });
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

    for (const variable of ENVELOPE_VARIABLES) {
      const rejected = spawnSync('bash', [INSTALLER, '--verify-envelope-only'], {
        cwd: process.cwd(),
        env: { ...cleanEnvironment(), [variable]: '1' },
        encoding: 'utf8',
        timeout: 15_000,
      });
      expect(rejected.status).toBe(8);
      expect(rejected.stderr).toContain(`environment override is forbidden for ${variable}`);
    }
  });

  it('checks the effective loopback, memory, CPU, queue, and single-model limits', () => {
    const systemctl = path.join(root, 'systemctl');
    executable(systemctl, `#!/usr/bin/env node
const host = process.env.FAKE_OLLAMA_HOST || '127.0.0.1:11434';
const queue = process.env.FAKE_OLLAMA_QUEUE || '4';
const memoryHigh = process.env.FAKE_MEMORY_HIGH || '4294967296';
const memoryMax = process.env.FAKE_MEMORY_MAX || '6442450944';
const memorySwap = process.env.FAKE_MEMORY_SWAP || '536870912';
const cpuQuota = process.env.FAKE_CPU_QUOTA || '2s';
process.stdout.write([
  'Environment=OLLAMA_HOST=' + host + ' OLLAMA_CONTEXT_LENGTH=4096 OLLAMA_MAX_QUEUE=' + queue + ' OLLAMA_NUM_PARALLEL=1 OLLAMA_MAX_LOADED_MODELS=1',
  'MemoryHigh=' + memoryHigh,
  'MemoryMax=' + memoryMax,
  'MemorySwapMax=' + memorySwap,
  'CPUQuotaPerSecUSec=' + cpuQuota,
  '',
].join('\\n'));
`);
    const environment = {
      ...cleanEnvironment(),
      NEXUS_OLLAMA_SYSTEMD_TEST_MODE: '1',
    };
    const valid = runNode(
      ENVELOPE_CHECKER,
      ['--systemctl-bin', systemctl, '--expected-swap-bytes', '536870912'],
      environment,
    );
    expect(valid.status, valid.stderr).toBe(0);
    expect(JSON.parse(valid.stdout)).toMatchObject({
      ok: true,
      expectedSwapBytes: 536870912,
      observed: {
        contextLength: 4096,
        maxQueue: 4,
        numParallel: 1,
        maxLoadedModels: 1,
        memoryHighBytes: 4294967296,
        memoryMaxBytes: 6442450944,
        memorySwapMaxBytes: 536870912,
        cpuQuotaUsecPerSec: 2000000,
      },
    });

    const publicBind = runNode(
      ENVELOPE_CHECKER,
      ['--systemctl-bin', systemctl],
      { ...environment, FAKE_OLLAMA_HOST: '0.0.0.0:11434' },
    );
    expect(publicBind.status).not.toBe(0);
    expect(publicBind.stderr).toContain('OLLAMA_HOST must be exactly 127.0.0.1:11434');

    const queueDrift = runNode(
      ENVELOPE_CHECKER,
      ['--systemctl-bin', systemctl],
      { ...environment, FAKE_OLLAMA_QUEUE: '5' },
    );
    expect(queueDrift.status).not.toBe(0);
    expect(queueDrift.stderr).toContain('OLLAMA_MAX_QUEUE must be exactly 4');

    const memoryHighDrift = runNode(
      ENVELOPE_CHECKER,
      ['--systemctl-bin', systemctl],
      { ...environment, FAKE_MEMORY_HIGH: '5368709120' },
    );
    expect(memoryHighDrift.status).not.toBe(0);
    expect(memoryHighDrift.stderr).toContain('MemoryHigh must be exactly 4 GiB');

    const memoryDrift = runNode(
      ENVELOPE_CHECKER,
      ['--systemctl-bin', systemctl],
      { ...environment, FAKE_MEMORY_MAX: '7516192768' },
    );
    expect(memoryDrift.status).not.toBe(0);
    expect(memoryDrift.stderr).toContain('MemoryMax must be exactly 6 GiB');

    const memorySwapDrift = runNode(
      ENVELOPE_CHECKER,
      ['--systemctl-bin', systemctl],
      { ...environment, FAKE_MEMORY_SWAP: '0' },
    );
    expect(memorySwapDrift.status).not.toBe(0);
    expect(memorySwapDrift.stderr).toContain('MemorySwapMax must be exactly 536870912 bytes');

    const cpuDrift = runNode(
      ENVELOPE_CHECKER,
      ['--systemctl-bin', systemctl],
      { ...environment, FAKE_CPU_QUOTA: '3s' },
    );
    expect(cpuDrift.status).not.toBe(0);
    expect(cpuDrift.stderr).toContain('CPUQuota must be exactly 200%');

    const zeroSwap = runNode(
      ENVELOPE_CHECKER,
      ['--systemctl-bin', systemctl, '--expected-swap-bytes', '0'],
      environment,
    );
    expect(zeroSwap.status).toBe(64);
    expect(zeroSwap.stderr).toContain('--expected-swap-bytes must be 536870912');
  });

  it('keeps provenance verification and all post-replacement checks inside rollback', () => {
    const source = fs.readFileSync(INSTALLER, 'utf8');
    expect(source).toContain('archive.pax_headers.get("comment") != source_sha');
    expect(source).toContain('bootstrap source archive digest does not match');
    expect(source).toContain('source drift for');
    expect(source).not.toContain('curl -fsSL https://ollama.com/install.sh');
    expect(source).not.toMatch(/\bollama pull\b/u);
    expect(source).not.toContain('chown -R /var/lib/ollama');

    const begin = source.indexOf('"$transaction_helper" begin');
    const authorize = source.indexOf('"$transaction_helper" authorize-restart');
    const restart = source.indexOf('systemctl restart ollama');
    const envelope = source.indexOf('nexus-ollama-service-envelope-check.mjs');
    const smoke = source.indexOf('smoke_response=');
    const lastIdentityCheck = source.lastIndexOf('verify_retained_model_identity');
    const commit = source.indexOf('"$transaction_helper" commit');
    const rollbackBoundary = [
      begin,
      authorize,
      restart,
      envelope,
      smoke,
      lastIdentityCheck,
      commit,
    ];
    expect(rollbackBoundary.every((position) => position >= 0)).toBe(true);
    expect(rollbackBoundary).toEqual([...rollbackBoundary].sort((left, right) => left - right));
    expect(source).toContain('trap transaction_cleanup EXIT');
  });
});

describe('lean Ollama systemd install transaction', () => {
  let root: string;
  let stateRoot: string;
  let dropIn: string;
  let systemctl: string;
  let activeState: string;
  let enabledState: string;
  let systemctlLog: string;
  let candidate: string;
  let procRoot: string;
  let tagsResponse: string;
  let tagsUrl: string;
  let tagsServer: ReturnType<typeof spawn> | null;

  function provenanceArgs() {
    return [
      '--source-root', root,
      '--source-sha', 'c'.repeat(40),
      '--archive-sha256', 'd'.repeat(64),
      '--ollama-binary', systemctl,
      '--ollama-binary-sha256', 'e'.repeat(64),
      '--ollama-version', 'ollama version is 0.24.0',
      '--service-fragment', candidate,
      '--service-fragment-sha256', 'f'.repeat(64),
      '--retained-model', RETAINED_MODEL,
      '--retained-model-digest', RETAINED_DIGEST,
    ];
  }

  function environment(extra: NodeJS.ProcessEnv = {}) {
    return {
      ...process.env,
      NEXUS_OLLAMA_INSTALL_TEST_MODE: '1',
      NEXUS_OLLAMA_INSTALL_STATE_ROOT: stateRoot,
      NEXUS_OLLAMA_DROP_IN_PATH: dropIn,
      NEXUS_OLLAMA_SYSTEMCTL_BIN: systemctl,
      NEXUS_OLLAMA_PROC_ROOT: procRoot,
      NEXUS_OLLAMA_INSTALL_TEST_PROCESS_START_TICKS: '888',
      NEXUS_OLLAMA_TAGS_URL: tagsUrl,
      FAKE_ACTIVE_STATE: activeState,
      FAKE_ENABLED_STATE: enabledState,
      FAKE_SYSTEMCTL_LOG: systemctlLog,
      FAKE_INSTALL_STATE_CHECK: INSTALL_STATE,
      NEXUS_OLLAMA_INSTALL_JOURNAL: path.join(stateRoot, 'install-in-progress.v1.json'),
      ...extra,
    };
  }

  function begin(extraEnvironment: NodeJS.ProcessEnv = {}) {
    return runNode(TRANSACTION, [
      'begin',
      '--candidate', candidate,
      '--installer-pid', String(process.pid),
      ...provenanceArgs(),
    ], environment(extraEnvironment));
  }

  function authorize() {
    return runNode(TRANSACTION, [
      'authorize-restart',
      '--installer-pid', String(process.pid),
    ], environment());
  }

  beforeEach(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-ollama-install-')));
    fs.chmodSync(root, 0o700);
    stateRoot = path.join(root, 'state');
    const dropInDirectory = path.join(root, 'drop-in');
    dropIn = path.join(dropInDirectory, 'override.conf');
    systemctl = path.join(root, 'systemctl');
    activeState = path.join(root, 'active');
    enabledState = path.join(root, 'enabled');
    systemctlLog = path.join(root, 'systemctl.log');
    candidate = path.join(root, 'candidate.conf');
    procRoot = path.join(root, 'proc');
    tagsResponse = path.join(root, 'tags-response.json');
    const tagsReady = path.join(root, 'tags-ready.json');
    tagsServer = null;

    fs.mkdirSync(dropInDirectory, { mode: 0o700 });
    fs.mkdirSync(path.join(procRoot, 'sys', 'kernel', 'random'), { recursive: true });
    fs.mkdirSync(path.join(procRoot, String(process.pid)), { recursive: true });
    fs.writeFileSync(
      path.join(procRoot, 'sys', 'kernel', 'random', 'boot_id'),
      '11111111-2222-3333-4444-555555555555\n',
    );
    fs.writeFileSync(
      path.join(procRoot, String(process.pid), 'stat'),
      `${process.pid} (vitest worker) S ${Array(18).fill('0').join(' ')} 777\n`,
    );
    fs.writeFileSync(activeState, 'active\n', { mode: 0o600 });
    fs.writeFileSync(enabledState, 'enabled\n', { mode: 0o600 });
    fs.writeFileSync(candidate, '[Service]\nMemoryMax=6G\n', { mode: 0o600 });
    fs.chmodSync(candidate, 0o600);
    fs.writeFileSync(tagsResponse, `${JSON.stringify({
      models: [
        { name: RETAINED_MODEL, digest: RETAINED_DIGEST },
        { name: 'unrelated:model', digest: '1'.repeat(64) },
      ],
    })}\n`, { mode: 0o600 });

    tagsServer = spawn(process.execPath, ['-e', `
const fs = require('node:fs');
const http = require('node:http');
const server = http.createServer((request, response) => {
  if (request.url !== '/api/tags') {
    response.writeHead(404);
    response.end();
    return;
  }
  const body = fs.readFileSync(process.env.FAKE_TAGS_RESPONSE);
  response.writeHead(200, {'content-type':'application/json','content-length':body.length});
  response.end(body);
});
server.listen(0, '127.0.0.1', () => {
  const stage = process.env.FAKE_TAGS_READY + '.next-' + process.pid;
  fs.writeFileSync(stage, JSON.stringify(server.address()) + '\\n', {flag:'wx',mode:0o600});
  fs.renameSync(stage, process.env.FAKE_TAGS_READY);
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`], {
      env: {
        ...process.env,
        FAKE_TAGS_RESPONSE: tagsResponse,
        FAKE_TAGS_READY: tagsReady,
      },
      stdio: 'ignore',
    });
    for (let attempt = 0; attempt < 200 && !fs.existsSync(tagsReady); attempt += 1) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    expect(fs.existsSync(tagsReady)).toBe(true);
    const address = JSON.parse(fs.readFileSync(tagsReady, 'utf8'));
    tagsUrl = `http://127.0.0.1:${address.port}/api/tags`;

    executable(systemctl, `#!/usr/bin/env node
const fs = require('node:fs');
const {spawnSync} = require('node:child_process');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_SYSTEMCTL_LOG, JSON.stringify(args) + '\\n');
const active = process.env.FAKE_ACTIVE_STATE;
const enabled = process.env.FAKE_ENABLED_STATE;
if (args[0] === 'show') {
  process.stdout.write(fs.readFileSync(active, 'utf8').trim() + '\\n');
  process.exit(0);
}
if (args[0] === 'is-enabled') {
  const value = fs.readFileSync(enabled, 'utf8').trim();
  process.stdout.write(value + '\\n');
  process.exit(value === 'enabled' ? 0 : 1);
}
if (args[0] === 'daemon-reload') process.exit(0);
if (args[0] === 'enable') {
  fs.writeFileSync(enabled, 'enabled\\n');
  process.exit(0);
}
if (args[0] === 'disable') {
  fs.writeFileSync(enabled, 'disabled\\n');
  process.exit(0);
}
if (args[0] === 'restart' || args[0] === 'start') {
  if (args[0] === 'restart') {
    const check = spawnSync(process.execPath, [process.env.FAKE_INSTALL_STATE_CHECK], {
      env: process.env,
      encoding: 'utf8',
    });
    if (check.status !== 0) {
      process.stderr.write(check.stderr || 'install-state check failed');
      process.exit(9);
    }
  }
  fs.writeFileSync(active, 'active\\n');
  process.exit(0);
}
if (args[0] === 'stop') {
  fs.writeFileSync(active, 'inactive\\n');
  process.exit(0);
}
process.exit(64);
`);
  });

  afterEach(async () => {
    if (tagsServer && tagsServer.exitCode === null) {
      const exited = new Promise<void>((resolveExit) => {
        tagsServer?.once('exit', () => resolveExit());
      });
      tagsServer.kill('SIGTERM');
      await exited;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('commits a SHA-bound receipt only after active and enabled validation', () => {
    const started = begin();
    expect(started.status, started.stderr).toBe(0);
    expect(authorize().status).toBe(0);

    fs.writeFileSync(activeState, 'inactive\n');
    const refused = runNode(TRANSACTION, ['commit'], environment());
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain('service is not active and enabled');
    fs.writeFileSync(activeState, 'active\n');

    fs.writeFileSync(enabledState, 'disabled\n');
    const disabled = runNode(TRANSACTION, ['commit'], environment());
    expect(disabled.status).not.toBe(0);
    expect(disabled.stderr).toContain('service is not active and enabled');
    fs.writeFileSync(enabledState, 'enabled\n');

    const committed = runNode(TRANSACTION, ['commit'], environment());
    expect(committed.status, committed.stderr).toBe(0);
    const receiptPath = path.join(stateRoot, 'install-receipt.v1.json');
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    expect(receipt).toMatchObject({
      schema: 'nexus.ollama-systemd-install-receipt.v1',
      status: 'complete',
      candidateSha256: createHash('sha256').update(fs.readFileSync(candidate)).digest('hex'),
      sourceProvenance: {
        sourceRoot: root,
        sourceSha: 'c'.repeat(40),
        archiveSha256: 'd'.repeat(64),
      },
      runtimeIdentity: {
        retainedModel: RETAINED_MODEL,
        retainedModelDigest: RETAINED_DIGEST,
      },
      retainedModelObservation: {
        endpoint: 'http://127.0.0.1:11434/api/tags',
        tag: RETAINED_MODEL,
        digest: RETAINED_DIGEST,
      },
      service: { activeState: 'active', enabledState: 'enabled' },
    });
    expect(fs.statSync(receiptPath).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(path.join(stateRoot, 'install-in-progress.v1.json'))).toBe(false);
  });

  it('restores exact predecessor bytes, receipt, service state, and operational assets', () => {
    const predecessor = '[Service]\nMemoryMax=9G\n';
    fs.writeFileSync(dropIn, predecessor, { mode: 0o640 });
    fs.chmodSync(dropIn, 0o640);
    fs.mkdirSync(stateRoot, { mode: 0o700 });
    const priorReceipt = '{"schema":"prior"}\n';
    fs.writeFileSync(
      path.join(stateRoot, 'install-receipt.v1.json'),
      priorReceipt,
      { mode: 0o600 },
    );
    const assetSource = path.join(root, 'lean-finalizer-source');
    const assetTarget = path.join(root, 'lean-finalizer-target');
    fs.writeFileSync(assetSource, 'candidate lean finalizer\n', { mode: 0o600 });
    fs.writeFileSync(assetTarget, 'predecessor finalizer\n', { mode: 0o640 });
    fs.chmodSync(assetTarget, 0o640);

    const started = begin({
      NEXUS_OLLAMA_INSTALL_ASSET_LAYOUT_JSON: JSON.stringify([
        ['lean-finalizer-source', assetTarget, 0o700],
      ]),
    });
    expect(started.status, started.stderr).toBe(0);
    expect(fs.readFileSync(assetTarget, 'utf8')).toBe('candidate lean finalizer\n');
    expect(authorize().status).toBe(0);

    fs.writeFileSync(activeState, 'inactive\n');
    fs.writeFileSync(enabledState, 'disabled\n');
    const rollback = runNode(
      TRANSACTION,
      ['rollback', '--reason', 'candidate_validation_failed'],
      environment(),
    );
    expect(rollback.status, rollback.stderr).toBe(0);
    expect(fs.readFileSync(dropIn, 'utf8')).toBe(predecessor);
    expect(fs.statSync(dropIn).mode & 0o777).toBe(0o640);
    expect(fs.readFileSync(assetTarget, 'utf8')).toBe('predecessor finalizer\n');
    expect(fs.statSync(assetTarget).mode & 0o777).toBe(0o640);
    expect(fs.readFileSync(path.join(stateRoot, 'install-receipt.v1.json'), 'utf8'))
      .toBe(priorReceipt);
    expect(fs.readFileSync(activeState, 'utf8').trim()).toBe('active');
    expect(fs.readFileSync(enabledState, 'utf8').trim()).toBe('enabled');
    expect(JSON.parse(fs.readFileSync(path.join(stateRoot, 'last-rollback.v1.json'), 'utf8')))
      .toMatchObject({ status: 'complete', reason: 'candidate_validation_failed' });
    expect(fs.existsSync(path.join(stateRoot, 'install-in-progress.v1.json'))).toBe(false);
  });

  it('fails closed if the retained-model digest changes before commit', () => {
    expect(begin().status).toBe(0);
    expect(authorize().status).toBe(0);
    fs.writeFileSync(tagsResponse, `${JSON.stringify({
      models: [{ name: RETAINED_MODEL, digest: '0'.repeat(64) }],
    })}\n`, { mode: 0o600 });

    const raced = runNode(TRANSACTION, ['commit'], environment());
    expect(raced.status).not.toBe(0);
    expect(raced.stderr).toContain('retained Ollama model changed before transaction commit');
    expect(fs.existsSync(path.join(stateRoot, 'install-receipt.v1.json'))).toBe(false);
    expect(fs.existsSync(path.join(stateRoot, 'install-in-progress.v1.json'))).toBe(true);

    const rollback = runNode(
      TRANSACTION,
      ['rollback', '--reason', 'retained_model_identity_race'],
      environment(),
    );
    expect(rollback.status, rollback.stderr).toBe(0);
    expect(fs.existsSync(path.join(stateRoot, 'install-in-progress.v1.json'))).toBe(false);
  });

  it('does not activate or enable an inactive and disabled predecessor during rollback', () => {
    fs.writeFileSync(activeState, 'inactive\n');
    fs.writeFileSync(enabledState, 'disabled\n');
    expect(begin().status).toBe(0);
    expect(authorize().status).toBe(0);
    fs.writeFileSync(activeState, 'active\n');
    fs.writeFileSync(enabledState, 'enabled\n');

    const rollback = runNode(
      TRANSACTION,
      ['rollback', '--reason', 'inactive_predecessor'],
      environment(),
    );
    expect(rollback.status, rollback.stderr).toBe(0);
    expect(fs.readFileSync(activeState, 'utf8').trim()).toBe('inactive');
    expect(fs.readFileSync(enabledState, 'utf8').trim()).toBe('disabled');
    const calls = fs.readFileSync(systemctlLog, 'utf8');
    expect(calls).toContain('["disable","ollama.service"]');
    expect(calls).toContain('["stop","ollama.service"]');
  });
});
