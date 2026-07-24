import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const INSTALLER = path.resolve('scripts/install-ollama.sh');
const TRANSACTION = path.resolve('scripts/ollama-systemd-dropin-transaction.mjs');
const INSTALL_STATE = path.resolve('scripts/ollama-install-state-check.mjs');
const OBSERVATION_CONTROL = path.resolve('scripts/ollama-observation-control.mjs');
const INSTALL_GUARD = path.resolve('scripts/systemd/00-nexus-ollama-install-guard.conf');
const OBSERVATION_UNIT = path.resolve('scripts/systemd/nexus-ollama-observation@.service');
const RUNTIME_SHA = 'a'.repeat(40);

function executable(file: string, source: string) {
  fs.writeFileSync(file, source, { mode: 0o755 });
  fs.chmodSync(file, 0o755);
}

function runNode(file: string, args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [file, ...args], {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
}

describe('reviewed Ollama bootstrap provenance', () => {
  it('binds exact archive digest, Git PAX commit, and source member bytes', () => {
    const installer = fs.readFileSync(INSTALLER, 'utf8');
    expect(installer).toContain('BOOTSTRAP_BASE=/var/lib/nexus-release-bootstrap');
    expect(installer).toContain('archive.pax_headers.get("comment") != source_sha');
    expect(installer).toContain('bootstrap source archive digest does not match');
    expect(installer).toContain('source drift for');
    expect(installer).toContain(
      'b2e45ade9cb754a079f74645e1183d613f582d98f7354b05f4f9a5bd81f8e0c9',
    );
    expect(installer).toContain(
      '357c53fb659c5076de1d65ccb0b397446227b71a42be9d1603d46168015c9e4b',
    );
    expect(installer).not.toContain('curl -fsSL https://ollama.com/install.sh');
    expect(installer).not.toContain('chown -R /var/lib/ollama');
    expect(installer).not.toContain('ollama pull');

    const verifier = installer.match(
      /# Prove the reviewed archive[\s\S]*?<<'PY'\n([\s\S]*?)\nPY/,
    )?.[1];
    expect(verifier).toBeTruthy();
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-ollama-archive-')));
    const sourceRoot = path.join(root, 'source');
    const scripts = path.join(sourceRoot, 'scripts');
    const archive = path.join(root, 'source.tar.gz');
    const verifierPath = path.join(root, 'verify.py');
    const sha = 'a'.repeat(40);
    try {
      fs.mkdirSync(scripts, { recursive: true });
      fs.writeFileSync(path.join(scripts, 'install-ollama.sh'), '#!/bin/sh\n');
      fs.writeFileSync(path.join(scripts, 'asset.mjs'), 'export const reviewed = true;\n');
      fs.writeFileSync(verifierPath, verifier!);
      const create = spawnSync('python3', [
        '-c',
        [
          'import pathlib,sys,tarfile',
          'archive,root,sha=sys.argv[1:]',
          'with tarfile.open(archive,"w:gz",format=tarfile.PAX_FORMAT,pax_headers={"comment":sha}) as output:',
          '  for item in sorted(pathlib.Path(root).rglob("*")):',
          '    output.add(item,arcname="source/"+item.relative_to(root).as_posix(),recursive=False)',
        ].join('\n'),
        archive,
        sourceRoot,
        sha,
      ], { encoding: 'utf8' });
      expect(create.status, create.stderr).toBe(0);
      const verify = () => spawnSync('python3', [
        verifierPath,
        archive,
        sourceRoot,
        sha,
        'install-ollama.sh',
        'asset.mjs',
      ], { encoding: 'utf8' });
      const accepted = verify();
      expect(accepted.status, accepted.stderr).toBe(0);
      fs.writeFileSync(path.join(scripts, 'asset.mjs'), 'export const reviewed = false;\n');
      const drifted = verify();
      expect(drifted.status).not.toBe(0);
      expect(drifted.stderr).toContain('source drift for scripts/asset.mjs');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('transactional Ollama systemd envelope installation', () => {
  let root: string;
  let stateRoot: string;
  let dropInDirectory: string;
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
      '--retained-model', 'qwen2.5:3b-instruct-q4_K_M',
      '--retained-model-digest',
      '357c53fb659c5076de1d65ccb0b397446227b71a42be9d1603d46168015c9e4b',
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
      FAKE_VALIDATE_OLLAMA_INSTALL_STATE: '1',
      FAKE_INSTALL_STATE_CHECK: INSTALL_STATE,
      NEXUS_OLLAMA_INSTALL_JOURNAL: path.join(stateRoot, 'install-in-progress.v1.json'),
      ...extra,
    };
  }

  beforeEach(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-ollama-install-')));
    fs.chmodSync(root, 0o700);
    stateRoot = path.join(root, 'state');
    dropInDirectory = path.join(root, 'drop-in');
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
        {
          name: 'qwen2.5:3b-instruct-q4_K_M',
          digest: '357c53fb659c5076de1d65ccb0b397446227b71a42be9d1603d46168015c9e4b',
        },
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
  fs.writeFileSync(process.env.FAKE_TAGS_READY, JSON.stringify(server.address()));
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
  const state = fs.readFileSync(enabled, 'utf8').trim();
  process.stdout.write(state + '\\n');
  process.exit(state === 'enabled' ? 0 : 1);
}
if (args[0] === 'daemon-reload') {
  process.exit(process.env.FAKE_FAIL_DAEMON_RELOAD === '1' ? 2 : 0);
}
if (args[0] === 'enable') {
  fs.writeFileSync(enabled, 'enabled\\n');
  process.exit(0);
}
if (args[0] === 'disable') {
  fs.writeFileSync(enabled, 'disabled\\n');
  process.exit(0);
}
if (args[0] === 'restart' || args[0] === 'start') {
  if (args[0] === 'restart' && process.env.FAKE_VALIDATE_OLLAMA_INSTALL_STATE === '1') {
    const attempts = process.env.FAKE_VALIDATE_OLLAMA_INSTALL_STATE_TWICE === '1' ? 2 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const check = spawnSync(process.execPath, [process.env.FAKE_INSTALL_STATE_CHECK], {
        env: process.env,
        encoding: 'utf8',
      });
      if (check.status !== 0) {
        process.stderr.write(check.stderr || 'install-state check failed');
        process.exit(9);
      }
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
      const exited = new Promise<void>((resolveExit) => tagsServer?.once('exit', () => resolveExit()));
      tagsServer.kill('SIGTERM');
      await exited;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('restores exact predecessor bytes, receipt, enablement, and active state after later validation fails', () => {
    const prior = '[Service]\nMemoryMax=9G\n';
    fs.writeFileSync(dropIn, prior, { mode: 0o640 });
    fs.chmodSync(dropIn, 0o640);
    fs.mkdirSync(stateRoot, { mode: 0o700 });
    const priorReceipt = '{"schema":"prior"}\n';
    fs.writeFileSync(path.join(stateRoot, 'install-receipt.v1.json'), priorReceipt, { mode: 0o600 });
    const assetSourceA = path.join(root, 'asset-source-a');
    const assetTargetA = path.join(root, 'asset-target-a');
    const assetSourceB = path.join(root, 'asset-source-b');
    const assetTargetB = path.join(root, 'asset-target-b');
    fs.writeFileSync(assetSourceA, 'candidate asset a\n', { mode: 0o600 });
    fs.writeFileSync(assetTargetA, 'predecessor asset a\n', { mode: 0o640 });
    fs.chmodSync(assetTargetA, 0o640);
    fs.writeFileSync(assetSourceB, 'candidate asset b\n', { mode: 0o600 });
    const assetEnvironment = {
      NEXUS_OLLAMA_INSTALL_ASSET_LAYOUT_JSON: JSON.stringify([
        ['asset-source-a', assetTargetA, 0o700],
        ['asset-source-b', assetTargetB, 0o644],
      ]),
    };

    const begin = runNode(TRANSACTION, [
      'begin', '--candidate', candidate, '--installer-pid', String(process.pid),
      ...provenanceArgs(),
    ], environment(assetEnvironment));
    expect(begin.status, begin.stderr).toBe(0);
    expect(fs.readFileSync(dropIn, 'utf8')).toContain('MemoryMax=6G');
    expect(fs.statSync(dropIn).mode & 0o777).toBe(0o644);
    expect(fs.readFileSync(assetTargetA, 'utf8')).toBe('candidate asset a\n');
    expect(fs.statSync(assetTargetA).mode & 0o777).toBe(0o700);
    expect(fs.readFileSync(assetTargetB, 'utf8')).toBe('candidate asset b\n');
    expect(fs.existsSync(path.join(stateRoot, 'install-in-progress.v1.json'))).toBe(true);

    const authorize = runNode(TRANSACTION, [
      'authorize-restart', '--installer-pid', String(process.pid),
    ], environment());
    expect(authorize.status, authorize.stderr).toBe(0);

    // Represent a successful candidate restart followed by an envelope/smoke
    // failure. Rollback must still restore the predecessor, not just the file.
    fs.writeFileSync(activeState, 'inactive\n');
    fs.writeFileSync(enabledState, 'disabled\n');
    const rollback = runNode(TRANSACTION, [
      'rollback', '--reason', 'post_replacement_validation_failed',
    ], environment({
      FAKE_VALIDATE_OLLAMA_INSTALL_STATE: '1',
      FAKE_INSTALL_STATE_CHECK: INSTALL_STATE,
      NEXUS_OLLAMA_INSTALL_JOURNAL: path.join(stateRoot, 'install-in-progress.v1.json'),
    }));
    expect(rollback.status, rollback.stderr).toBe(0);
    expect(fs.readFileSync(dropIn, 'utf8')).toBe(prior);
    expect(fs.statSync(dropIn).mode & 0o777).toBe(0o640);
    expect(fs.readFileSync(activeState, 'utf8').trim()).toBe('active');
    expect(fs.readFileSync(enabledState, 'utf8').trim()).toBe('enabled');
    expect(fs.readFileSync(path.join(stateRoot, 'install-receipt.v1.json'), 'utf8'))
      .toBe(priorReceipt);
    expect(fs.readFileSync(assetTargetA, 'utf8')).toBe('predecessor asset a\n');
    expect(fs.statSync(assetTargetA).mode & 0o777).toBe(0o640);
    expect(fs.existsSync(assetTargetB)).toBe(false);
    expect(fs.existsSync(path.join(stateRoot, 'install-in-progress.v1.json'))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(stateRoot, 'last-rollback.v1.json'), 'utf8')))
      .toMatchObject({ status: 'complete', reason: 'post_replacement_validation_failed' });
  });

  it('commits a durable receipt only after the candidate is active and enabled', () => {
    const begin = runNode(TRANSACTION, [
      'begin', '--candidate', candidate, '--installer-pid', String(process.pid),
      ...provenanceArgs(),
    ], environment());
    expect(begin.status, begin.stderr).toBe(0);
    const authorize = runNode(TRANSACTION, [
      'authorize-restart', '--installer-pid', String(process.pid),
    ], environment());
    expect(authorize.status, authorize.stderr).toBe(0);

    const commit = runNode(TRANSACTION, ['commit'], environment());
    expect(commit.status, commit.stderr).toBe(0);
    const receipt = JSON.parse(
      fs.readFileSync(path.join(stateRoot, 'install-receipt.v1.json'), 'utf8'),
    );
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
        version: 'ollama version is 0.24.0',
        retainedModelDigest:
          '357c53fb659c5076de1d65ccb0b397446227b71a42be9d1603d46168015c9e4b',
      },
      retainedModelObservation: {
        endpoint: 'http://127.0.0.1:11434/api/tags',
        tag: 'qwen2.5:3b-instruct-q4_K_M',
        digest: '357c53fb659c5076de1d65ccb0b397446227b71a42be9d1603d46168015c9e4b',
      },
      service: { activeState: 'active', enabledState: 'enabled' },
    });
    expect(receipt.retainedModelObservation.responseSha256).toBe(
      createHash('sha256').update(fs.readFileSync(tagsResponse)).digest('hex'),
    );
    expect(fs.existsSync(path.join(stateRoot, 'install-in-progress.v1.json'))).toBe(false);
  });

  it('refuses commit when the independently observed retained-model digest races the transaction', () => {
    const begin = runNode(TRANSACTION, [
      'begin', '--candidate', candidate, '--installer-pid', String(process.pid),
      ...provenanceArgs(),
    ], environment());
    expect(begin.status, begin.stderr).toBe(0);
    const authorize = runNode(TRANSACTION, [
      'authorize-restart', '--installer-pid', String(process.pid),
    ], environment());
    expect(authorize.status, authorize.stderr).toBe(0);

    fs.writeFileSync(tagsResponse, `${JSON.stringify({
      models: [
        {
          name: 'qwen2.5:3b-instruct-q4_K_M',
          digest: '0'.repeat(64),
        },
        { name: 'unrelated:model', digest: '1'.repeat(64) },
      ],
    })}\n`, { mode: 0o600 });
    const racedCommit = runNode(TRANSACTION, ['commit'], environment());

    expect(racedCommit.status).not.toBe(0);
    expect(racedCommit.stderr).toContain(
      'retained Ollama model changed before transaction commit',
    );
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

  it('restores an inactive and disabled predecessor without enabling it', () => {
    fs.writeFileSync(dropIn, '[Service]\nMemoryMax=8G\n', { mode: 0o644 });
    fs.writeFileSync(activeState, 'inactive\n');
    fs.writeFileSync(enabledState, 'disabled\n');
    const begin = runNode(TRANSACTION, [
      'begin', '--candidate', candidate, '--installer-pid', String(process.pid),
      ...provenanceArgs(),
    ], environment());
    expect(begin.status, begin.stderr).toBe(0);
    const authorize = runNode(TRANSACTION, [
      'authorize-restart', '--installer-pid', String(process.pid),
    ], environment());
    expect(authorize.status, authorize.stderr).toBe(0);
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

  it('restores an active and enabled absent predecessor through one live helper restart', () => {
    const begin = runNode(TRANSACTION, [
      'begin', '--candidate', candidate, '--installer-pid', String(process.pid),
      ...provenanceArgs(),
    ], environment());
    expect(begin.status, begin.stderr).toBe(0);
    const authorize = runNode(TRANSACTION, [
      'authorize-restart', '--installer-pid', String(process.pid),
    ], environment());
    expect(authorize.status, authorize.stderr).toBe(0);

    const rollback = runNode(
      TRANSACTION,
      ['rollback', '--reason', 'absent_active_predecessor'],
      environment(),
    );
    expect(rollback.status, rollback.stderr).toBe(0);
    expect(fs.existsSync(dropIn)).toBe(false);
    expect(fs.readFileSync(activeState, 'utf8').trim()).toBe('active');
    expect(fs.readFileSync(enabledState, 'utf8').trim()).toBe('enabled');
    expect(fs.readFileSync(systemctlLog, 'utf8')).toContain('["restart","ollama.service"]');
    expect(fs.existsSync(path.join(stateRoot, 'install-in-progress.v1.json'))).toBe(false);
    expect(
      fs.readdirSync(stateRoot).some((name) => name.includes('rollback-absent-restart-consumed')),
    ).toBe(false);
  });

  it('keeps absent-predecessor recovery fail-closed across reboot, then resumes exactly', () => {
    const begin = runNode(TRANSACTION, [
      'begin', '--candidate', candidate, '--installer-pid', String(process.pid),
      ...provenanceArgs(),
    ], environment());
    expect(begin.status, begin.stderr).toBe(0);
    const authorize = runNode(TRANSACTION, [
      'authorize-restart', '--installer-pid', String(process.pid),
    ], environment());
    expect(authorize.status, authorize.stderr).toBe(0);

    const interrupted = runNode(
      TRANSACTION,
      ['rollback', '--reason', 'pre_reboot_absent_recovery'],
      environment({ NEXUS_OLLAMA_INSTALL_FAULT_POINT: 'rollback_absent_after_authorization' }),
    );
    expect(interrupted.signal).toBe('SIGKILL');
    const journal = path.join(stateRoot, 'install-in-progress.v1.json');
    expect(JSON.parse(fs.readFileSync(journal, 'utf8')).status)
      .toBe('rollback_absent_authorized');
    expect(fs.existsSync(dropIn)).toBe(false);

    fs.writeFileSync(
      path.join(procRoot, 'sys', 'kernel', 'random', 'boot_id'),
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\n',
    );
    const rebootGuard = runNode(INSTALL_STATE, [], environment());
    expect(rebootGuard.status).not.toBe(0);
    expect(rebootGuard.stderr).toContain(
      'restart is not owned by the live installing process on this boot',
    );

    const recovered = runNode(
      TRANSACTION,
      ['recover', '--reason', 'post_reboot_absent_recovery'],
      environment(),
    );
    expect(recovered.status, recovered.stderr).toBe(0);
    expect(fs.existsSync(dropIn)).toBe(false);
    expect(fs.readFileSync(activeState, 'utf8').trim()).toBe('active');
    expect(fs.readFileSync(enabledState, 'utf8').trim()).toBe('enabled');
    expect(fs.existsSync(journal)).toBe(false);
  });

  it('consumes absent-predecessor restart authorization once and requires exact recovery', () => {
    expect(runNode(TRANSACTION, [
      'begin', '--candidate', candidate, '--installer-pid', String(process.pid),
      ...provenanceArgs(),
    ], environment()).status).toBe(0);
    expect(runNode(TRANSACTION, [
      'authorize-restart', '--installer-pid', String(process.pid),
    ], environment()).status).toBe(0);

    const replayed = runNode(
      TRANSACTION,
      ['rollback', '--reason', 'double_restart_guard_probe'],
      environment({ FAKE_VALIDATE_OLLAMA_INSTALL_STATE_TWICE: '1' }),
    );
    expect(replayed.status).not.toBe(0);
    expect(replayed.stderr).toContain('active-state rollback failed');
    const journal = path.join(stateRoot, 'install-in-progress.v1.json');
    expect(JSON.parse(fs.readFileSync(journal, 'utf8')).status)
      .toBe('rollback_absent_consumed');

    const recovered = runNode(
      TRANSACTION,
      ['recover', '--reason', 'single_use_restart_recovery'],
      environment(),
    );
    expect(recovered.status, recovered.stderr).toBe(0);
    expect(fs.existsSync(dropIn)).toBe(false);
    expect(fs.existsSync(journal)).toBe(false);
  });

  it.each([
    ['commit_before_terminal_journal', 'rollback'],
    ['commit_after_terminal_journal', 'commit'],
    ['commit_before_backup_gc', 'commit'],
    ['commit_after_backup_gc', 'commit'],
    ['commit_backup_gc_after_unlink_before_parent_fsync', 'commit'],
  ])('recovers commit safely after SIGKILL at %s', (faultPoint, expectedOutcome) => {
    const prior = '[Service]\nMemoryMax=9G\n';
    fs.writeFileSync(dropIn, prior, { mode: 0o640 });
    fs.chmodSync(dropIn, 0o640);
    const begin = runNode(TRANSACTION, [
      'begin', '--candidate', candidate, '--installer-pid', String(process.pid),
      ...provenanceArgs(),
    ], environment());
    expect(begin.status, begin.stderr).toBe(0);
    const authorize = runNode(TRANSACTION, [
      'authorize-restart', '--installer-pid', String(process.pid),
    ], environment());
    expect(authorize.status, authorize.stderr).toBe(0);

    const interrupted = runNode(
      TRANSACTION,
      ['commit'],
      environment({ NEXUS_OLLAMA_INSTALL_FAULT_POINT: faultPoint }),
    );
    expect(interrupted.signal).toBe('SIGKILL');
    const journal = path.join(stateRoot, 'install-in-progress.v1.json');
    expect(fs.existsSync(journal)).toBe(true);
    if (expectedOutcome === 'commit') {
      expect(JSON.parse(fs.readFileSync(journal, 'utf8')).status).toBe('commit_complete');
    }

    const recovered = runNode(
      TRANSACTION,
      ['recover', '--reason', `recover_${faultPoint}`],
      environment(),
    );
    expect(recovered.status, recovered.stderr).toBe(0);
    expect(fs.existsSync(journal)).toBe(false);
    expect(fs.readFileSync(dropIn, 'utf8')).toBe(
      expectedOutcome === 'commit' ? fs.readFileSync(candidate, 'utf8') : prior,
    );
  });

  it('keeps a durable exact commit when SIGKILL lands between journal unlink and fsync', () => {
    fs.writeFileSync(dropIn, '[Service]\nMemoryMax=9G\n', { mode: 0o640 });
    fs.chmodSync(dropIn, 0o640);
    expect(runNode(TRANSACTION, [
      'begin', '--candidate', candidate, '--installer-pid', String(process.pid),
      ...provenanceArgs(),
    ], environment()).status).toBe(0);
    expect(runNode(TRANSACTION, [
      'authorize-restart', '--installer-pid', String(process.pid),
    ], environment()).status).toBe(0);
    const interrupted = runNode(
      TRANSACTION,
      ['commit'],
      environment({
        NEXUS_OLLAMA_INSTALL_FAULT_POINT:
          'commit_journal_after_unlink_before_parent_fsync',
      }),
    );
    expect(interrupted.signal).toBe('SIGKILL');
    expect(fs.existsSync(path.join(stateRoot, 'install-receipt.v1.json'))).toBe(true);
    expect(fs.readFileSync(dropIn, 'utf8')).toBe(fs.readFileSync(candidate, 'utf8'));
  });

  it.each([
    'rollback_before_terminal_journal',
    'rollback_after_terminal_journal',
    'rollback_before_backup_gc',
    'rollback_after_backup_gc',
    'rollback_backup_gc_after_unlink_before_parent_fsync',
  ])('recovers rollback safely after SIGKILL at %s', (faultPoint) => {
    const prior = '[Service]\nMemoryMax=9G\n';
    fs.writeFileSync(dropIn, prior, { mode: 0o640 });
    fs.chmodSync(dropIn, 0o640);
    expect(runNode(TRANSACTION, [
      'begin', '--candidate', candidate, '--installer-pid', String(process.pid),
      ...provenanceArgs(),
    ], environment()).status).toBe(0);
    expect(runNode(TRANSACTION, [
      'authorize-restart', '--installer-pid', String(process.pid),
    ], environment()).status).toBe(0);

    const interrupted = runNode(
      TRANSACTION,
      ['rollback', '--reason', `fault_${faultPoint}`],
      environment({ NEXUS_OLLAMA_INSTALL_FAULT_POINT: faultPoint }),
    );
    expect(interrupted.signal).toBe('SIGKILL');
    const journal = path.join(stateRoot, 'install-in-progress.v1.json');
    expect(fs.existsSync(journal)).toBe(true);
    const recovered = runNode(
      TRANSACTION,
      ['recover', '--reason', `recover_${faultPoint}`],
      environment(),
    );
    expect(recovered.status, recovered.stderr).toBe(0);
    expect(fs.existsSync(journal)).toBe(false);
    expect(fs.readFileSync(dropIn, 'utf8')).toBe(prior);
  });

  it('keeps a durable exact rollback when SIGKILL lands between journal unlink and fsync', () => {
    const prior = '[Service]\nMemoryMax=9G\n';
    fs.writeFileSync(dropIn, prior, { mode: 0o640 });
    fs.chmodSync(dropIn, 0o640);
    expect(runNode(TRANSACTION, [
      'begin', '--candidate', candidate, '--installer-pid', String(process.pid),
      ...provenanceArgs(),
    ], environment()).status).toBe(0);
    expect(runNode(TRANSACTION, [
      'authorize-restart', '--installer-pid', String(process.pid),
    ], environment()).status).toBe(0);
    const interrupted = runNode(
      TRANSACTION,
      ['rollback', '--reason', 'journal_unlink_fault'],
      environment({
        NEXUS_OLLAMA_INSTALL_FAULT_POINT:
          'rollback_journal_after_unlink_before_parent_fsync',
      }),
    );
    expect(interrupted.signal).toBe('SIGKILL');
    expect(fs.existsSync(path.join(stateRoot, 'last-rollback.v1.json'))).toBe(true);
    expect(fs.readFileSync(dropIn, 'utf8')).toBe(prior);
  });

  it('leaves an ambiguous unsafe journal fail-closed and rejects a symlink target before replacement', () => {
    fs.mkdirSync(stateRoot, { mode: 0o700 });
    const journal = path.join(stateRoot, 'install-in-progress.v1.json');
    fs.writeFileSync(journal, '{"schema":"unknown"}\n', { mode: 0o600 });
    const ambiguous = runNode(TRANSACTION, [
      'begin', '--candidate', candidate, '--installer-pid', String(process.pid),
      ...provenanceArgs(),
    ], environment());
    expect(ambiguous.status).not.toBe(0);
    expect(ambiguous.stderr).toContain('unexpected schema');
    expect(fs.readFileSync(journal, 'utf8')).toContain('"unknown"');

    fs.rmSync(journal);
    fs.symlinkSync(candidate, dropIn);
    const symlink = runNode(TRANSACTION, [
      'begin', '--candidate', candidate, '--installer-pid', String(process.pid),
      ...provenanceArgs(),
    ], environment());
    expect(symlink.status).not.toBe(0);
    expect(symlink.stderr).toContain('traverses a symlink');
    expect(fs.realpathSync(dropIn)).toBe(fs.realpathSync(candidate));
  });

  it('authorizes restart only for the same live installer process and boot', () => {
    const begin = runNode(TRANSACTION, [
      'begin', '--candidate', candidate, '--installer-pid', String(process.pid),
      ...provenanceArgs(),
    ], environment());
    expect(begin.status, begin.stderr).toBe(0);
    const preAuthorization = runNode(INSTALL_STATE, [], {
      ...environment(),
      NEXUS_OLLAMA_INSTALL_JOURNAL: path.join(stateRoot, 'install-in-progress.v1.json'),
      NEXUS_OLLAMA_PROC_ROOT: procRoot,
    });
    expect(preAuthorization.status).not.toBe(0);
    expect(preAuthorization.stderr).toContain(
      'installation is incomplete or its candidate identity changed',
    );
    const authorize = runNode(TRANSACTION, [
      'authorize-restart', '--installer-pid', String(process.pid),
    ], environment());
    expect(authorize.status, authorize.stderr).toBe(0);
    const journal = path.join(stateRoot, 'install-in-progress.v1.json');
    const accepted = runNode(INSTALL_STATE, [], {
      ...environment(),
      NEXUS_OLLAMA_INSTALL_JOURNAL: journal,
      NEXUS_OLLAMA_PROC_ROOT: procRoot,
    });
    expect(accepted.status, accepted.stderr).toBe(0);

    const value = JSON.parse(fs.readFileSync(journal, 'utf8'));
    value.restartAuthorization.installerStartTicks = '0';
    fs.writeFileSync(journal, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    fs.chmodSync(journal, 0o600);
    const rejected = runNode(INSTALL_STATE, [], {
      ...environment(),
      NEXUS_OLLAMA_INSTALL_JOURNAL: journal,
      NEXUS_OLLAMA_PROC_ROOT: procRoot,
    });
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain('not owned by the live installing process');

    value.restartAuthorization.installerStartTicks = '777';
    value.restartAuthorization.bootId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    fs.writeFileSync(journal, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    fs.chmodSync(journal, 0o600);
    const wrongBoot = runNode(INSTALL_STATE, [], {
      ...environment(),
      NEXUS_OLLAMA_INSTALL_JOURNAL: journal,
      NEXUS_OLLAMA_PROC_ROOT: procRoot,
    });
    expect(wrongBoot.status).not.toBe(0);
    expect(wrongBoot.stderr).toContain('not owned by the live installing process');

    fs.rmSync(journal);
    fs.symlinkSync(path.join(stateRoot, 'missing-journal.json'), journal);
    const brokenJournalSymlink = runNode(INSTALL_STATE, [], {
      ...environment(),
      NEXUS_OLLAMA_INSTALL_JOURNAL: journal,
      NEXUS_OLLAMA_PROC_ROOT: procRoot,
    });
    expect(brokenJournalSymlink.status).not.toBe(0);
    expect(brokenJournalSymlink.stderr).toContain('not a regular file');
  });

  it('keeps all post-replacement work inside the installer rollback boundary', () => {
    const source = fs.readFileSync(INSTALLER, 'utf8');
    const transaction = fs.readFileSync(TRANSACTION, 'utf8');
    const transactionBegin = source.indexOf('"$transaction_helper" begin');
    const daemonReload = source.indexOf('systemctl daemon-reload', transactionBegin);
    const restartAuthorization = source.indexOf(
      '"$transaction_helper" authorize-restart',
      transactionBegin,
    );
    const restart = source.indexOf('systemctl restart ollama', transactionBegin);
    const envelope = source.indexOf('nexus-ollama-service-envelope-check.mjs', restart);
    const smoke = source.indexOf('smoke_response=', envelope);
    const identityRecheck = source.indexOf(
      'Re-verifying exact binary, service fragment, and retained model identities',
      smoke,
    );
    const commit = source.indexOf('"$transaction_helper" commit', identityRecheck);

    expect(source).toContain('validate_root_path_chain "$SCRIPT_DIR"');
    expect(fs.readFileSync(INSTALL_GUARD, 'utf8')).toContain(
      'ExecStartPre=+/usr/local/sbin/nexus-ollama-install-state-check.mjs',
    );
    expect(source.indexOf('installed_install_guard=', 0)).toBeLessThan(transactionBegin);
    expect(
      source.indexOf(
        'systemctl daemon-reload',
        source.indexOf('installed_install_guard=', 0),
      ),
    ).toBeLessThan(transactionBegin);
    expect(transaction).toContain('renameSync(temporary, path)');
    expect(transaction).toContain('restoreAssets(journal.assets)');
    expect(source).toContain('"$transaction_helper" rollback --reason installer_exit_');
    expect(transactionBegin).toBeGreaterThan(-1);
    expect(daemonReload).toBeGreaterThan(transactionBegin);
    expect(restartAuthorization).toBeGreaterThan(daemonReload);
    expect(restart).toBeGreaterThan(restartAuthorization);
    expect(envelope).toBeGreaterThan(restart);
    expect(smoke).toBeGreaterThan(envelope);
    expect(identityRecheck).toBeGreaterThan(smoke);
    expect(commit).toBeGreaterThan(identityRecheck);
    expect(source.indexOf('transaction_active=false', commit)).toBeGreaterThan(commit);
  });
});

describe('durable Ollama observation one-shot', () => {
  let root: string;
  let stateRoot: string;
  let observationRoot: string;
  let mutex: string;
  let rebootRequired: string;
  let bootId: string;
  let systemctl: string;
  let pm2: string;
  let collector: string;
  let flock: string;
  let sonar: string;
  let systemctlLog: string;
  let pm2Sha: string;

  function environment(extra: NodeJS.ProcessEnv = {}) {
    return {
      ...process.env,
      NEXUS_OLLAMA_OBSERVATION_CONTROL_TEST_MODE: '1',
      NEXUS_OLLAMA_OBSERVATION_STATE_ROOT: stateRoot,
      NEXUS_OLLAMA_OBSERVATION_ROOT: observationRoot,
      NEXUS_OLLAMA_SHARED_MUTEX: mutex,
      NEXUS_OLLAMA_REBOOT_REQUIRED_PATH: rebootRequired,
      NEXUS_OLLAMA_BOOT_ID_PATH: bootId,
      NEXUS_OLLAMA_SYSTEMCTL_BIN: systemctl,
      NEXUS_OLLAMA_PM2_BIN: pm2,
      NEXUS_OLLAMA_COLLECTOR_BIN: collector,
      NEXUS_OLLAMA_FLOCK_BIN: flock,
      NEXUS_OLLAMA_SONAR_STATE_BIN: sonar,
      FAKE_SYSTEMCTL_LOG: systemctlLog,
      FAKE_PM2_SHA_FILE: pm2Sha,
      FAKE_OBSERVATION_ROOT: observationRoot,
      ...extra,
    };
  }

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-ollama-observation-control-')));
    fs.chmodSync(root, 0o700);
    stateRoot = path.join(root, 'state');
    observationRoot = path.join(root, 'observations');
    mutex = path.join(root, 'shared.lock');
    rebootRequired = path.join(root, 'reboot-required');
    bootId = path.join(root, 'boot-id');
    systemctl = path.join(root, 'systemctl');
    pm2 = path.join(root, 'pm2');
    collector = path.join(root, 'collector');
    flock = path.join(root, 'flock');
    sonar = path.join(root, 'sonar-state');
    systemctlLog = path.join(root, 'systemctl.log');
    pm2Sha = path.join(root, 'pm2-sha');
    fs.mkdirSync(observationRoot, { mode: 0o700 });
    fs.writeFileSync(mutex, '', { mode: 0o660 });
    fs.chmodSync(mutex, 0o660);
    fs.writeFileSync(bootId, '11111111-2222-3333-4444-555555555555\n', { mode: 0o600 });
    fs.writeFileSync(pm2Sha, `${RUNTIME_SHA}\n`, { mode: 0o600 });

    executable(systemctl, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_SYSTEMCTL_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'list-jobs') {
  process.stdout.write(process.env.FAKE_SYSTEMD_JOBS || '');
  process.exit(0);
}
if (args[0] === 'start') process.exit(process.env.FAKE_START_FAIL === '1' ? 2 : 0);
if (args[0] === 'show') {
  process.stdout.write('inactive\\n');
  process.exit(0);
}
process.exit(64);
`);
    executable(pm2, `#!/usr/bin/env node
const fs = require('node:fs');
const sha = fs.readFileSync(process.env.FAKE_PM2_SHA_FILE, 'utf8').trim();
process.stdout.write(JSON.stringify([
  {name:'content-engine-staging',pm2_env:{status:'online',NEXUS_RELEASE_SHA:sha}},
  {name:'nexus-hub-staging',pm2_env:{status:'online',NEXUS_RELEASE_SHA:sha}},
  {name:'content-engine',pm2_env:{status:'online',NEXUS_RELEASE_SHA:sha}},
  {name:'nexus-hub',pm2_env:{status:'online',NEXUS_RELEASE_SHA:sha}}
]));
`);
    executable(sonar, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  schema:'nexus.sonarqube-release-state.v1',
  status:'passed',
  projectKey:'nexus-hub-backend',
  activeTasks:Number(process.env.FAKE_SONAR_TASKS || 0)
}));
`);
    executable(collector, `#!/usr/bin/env node
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const args = process.argv.slice(2);
const phase = args[args.indexOf('--phase') + 1];
const runtimeSha = args[args.indexOf('--expected-runtime-sha') + 1];
const requestId = args[args.indexOf('--control-request-id') + 1];
const requestSha256 = args[args.indexOf('--control-request-sha256') + 1];
const controlRequest = {requestId,requestSha256,runtimeSha};
let previousControlRequest = null;
if (phase === 'production') {
  const previous = JSON.parse(fs.readFileSync(args[args.indexOf('--previous-observation') + 1]));
  previousControlRequest = previous.controlRequest;
} else if (phase === 'zero_swap') {
  const cleanup = JSON.parse(fs.readFileSync(args[args.indexOf('--cleanup-result') + 1]));
  previousControlRequest = cleanup.plan.observationControl.production;
}
const run = path.join(process.env.FAKE_OBSERVATION_ROOT, phase + '-20260724T120000Z-aaaaaaaaaaaa');
fs.mkdirSync(run, {recursive:true,mode:0o700});
fs.chmodSync(run,0o700);
const result = path.join(run,'result.json');
const bytes = Buffer.from(JSON.stringify({
  schema:'nexus.ollama-observation-collector-result.v1',
  status:'complete',
  phase,
  controlRequest,
  previousControlRequest,
}) + '\\n');
fs.writeFileSync(result,bytes,{mode:0o600});
fs.chmodSync(result,0o600);
process.stdout.write(JSON.stringify({
  status:'complete',
  phase,
  result,
  sha256:'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex')
}));
`);
    executable(flock, `#!/usr/bin/env node
const {spawnSync} = require('node:child_process');
const args = process.argv.slice(2);
if (process.env.FAKE_FLOCK_BUSY === '1') process.exit(1);
if (args[0] !== '-n' || args.length < 3) process.exit(64);
const child = spawnSync(args[2], args.slice(3), {
  env: process.env,
  stdio: 'inherit',
  shell: false,
});
process.exit(child.status === null ? 1 : child.status);
`);
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('survives the launcher session and binds exact phase, SHA, boot, and result digest', () => {
    const launched = runNode(OBSERVATION_CONTROL, [
      'launch', '--phase', 'staging', '--runtime-sha', RUNTIME_SHA,
    ], environment());
    expect(launched.status, launched.stderr).toBe(0);
    const summary = JSON.parse(launched.stdout);
    const directory = path.join(stateRoot, 'requests', summary.requestId);
    expect(JSON.parse(fs.readFileSync(path.join(directory, 'request.json'), 'utf8')))
      .toMatchObject({ phase: 'staging', runtimeSha: RUNTIME_SHA, previousEvidence: null });
    expect(JSON.parse(fs.readFileSync(path.join(directory, 'journal.json'), 'utf8')))
      .toMatchObject({ status: 'pending', phase: 'submitted', runtimeSha: RUNTIME_SHA });
    expect(fs.readFileSync(systemctlLog, 'utf8')).toContain(
      `nexus-ollama-observation@${summary.requestId}.service`,
    );

    const completed = runNode(OBSERVATION_CONTROL, ['run', summary.requestId], environment({
      NEXUS_OLLAMA_SHARED_LOCK_HELD: '1',
      NEXUS_OLLAMA_OBSERVATION_SYSTEMD_REQUEST_ID: summary.requestId,
    }));
    expect(completed.status, completed.stderr).toBe(0);
    const result = JSON.parse(completed.stdout);
    expect(result).toMatchObject({ status: 'complete', runtimeSha: RUNTIME_SHA });
    const collectorResult = JSON.parse(fs.readFileSync(result.result.path, 'utf8'));
    const launchRequest = JSON.parse(
      fs.readFileSync(path.join(directory, 'request.json'), 'utf8'),
    );
    expect(collectorResult.controlRequest).toEqual({
      requestId: summary.requestId,
      requestSha256: summary.requestSha256,
      runtimeSha: RUNTIME_SHA,
    });
    expect(collectorResult.previousControlRequest).toBeNull();
    expect(
      `sha256:${createHash('sha256')
        .update(fs.readFileSync(path.join(directory, 'request.json')))
        .digest('hex')}`,
    ).toBe(summary.requestSha256);
    expect(launchRequest.runtimeSha).toBe(RUNTIME_SHA);
    const journal = JSON.parse(fs.readFileSync(path.join(directory, 'journal.json'), 'utf8'));
    expect(journal).toMatchObject({
      status: 'completed',
      phase: 'complete',
      bootId: '11111111-2222-3333-4444-555555555555',
      result: { path: result.result.path, sha256: result.result.sha256 },
    });
    expect(fs.existsSync(path.join(stateRoot, 'active.json'))).toBe(false);
  });

  it('fails before collection on PM2 SHA drift, active Sonar, lock contention, or pending reboot', async () => {
    const launch = () => runNode(OBSERVATION_CONTROL, [
      'launch', '--phase', 'staging', '--runtime-sha', RUNTIME_SHA,
    ], environment());

    fs.writeFileSync(rebootRequired, 'restart required\n', { mode: 0o600 });
    const reboot = launch();
    expect(reboot.status).not.toBe(0);
    expect(reboot.stderr).toContain('pending maintenance reboot');
    fs.rmSync(rebootRequired);

    const launched = launch();
    expect(launched.status, launched.stderr).toBe(0);
    const requestId = JSON.parse(launched.stdout).requestId;
    fs.writeFileSync(pm2Sha, `${'b'.repeat(40)}\n`);
    const drift = runNode(OBSERVATION_CONTROL, ['run', requestId], environment({
      NEXUS_OLLAMA_SHARED_LOCK_HELD: '1',
      NEXUS_OLLAMA_OBSERVATION_SYSTEMD_REQUEST_ID: requestId,
    }));
    expect(drift.status).not.toBe(0);
    expect(drift.stderr).toContain('does not match the requested exact runtime SHA');
    const journal = JSON.parse(
      fs.readFileSync(path.join(stateRoot, 'requests', requestId, 'journal.json'), 'utf8'),
    );
    expect(journal.status).toBe('failed');

    // A separate request proves the lock and Sonar checks independently.
    fs.writeFileSync(pm2Sha, `${RUNTIME_SHA}\n`);
    const next = launch();
    expect(next.status, next.stderr).toBe(0);
    const nextId = JSON.parse(next.stdout).requestId;
    const noLock = runNode(OBSERVATION_CONTROL, ['run', nextId], environment({
      FAKE_FLOCK_BUSY: '1',
    }));
    expect(noLock.status).not.toBe(0);
    expect(noLock.stderr).toContain('mutex is unavailable');

    const final = launch();
    expect(final.status, final.stderr).toBe(0);
    const finalId = JSON.parse(final.stdout).requestId;
    const sonarActive = runNode(OBSERVATION_CONTROL, ['run', finalId], environment({
      NEXUS_OLLAMA_SHARED_LOCK_HELD: '1',
      NEXUS_OLLAMA_OBSERVATION_SYSTEMD_REQUEST_ID: finalId,
      FAKE_SONAR_TASKS: '1',
    }));
    expect(sonarActive.status).not.toBe(0);
    expect(sonarActive.stderr).toContain('Sonar Compute Engine is active');
  });

  it('requires exact prior evidence and refuses a queued governed restart', () => {
    const stagingDirectory = path.join(observationRoot, 'staging-20260724T120000Z-bbbbbbbbbbbb');
    fs.mkdirSync(stagingDirectory, { mode: 0o700 });
    const previous = path.join(stagingDirectory, 'result.json');
    const previousBytes = Buffer.from(`${JSON.stringify({
      schema: 'nexus.ollama-observation-collector-result.v1',
      status: 'complete',
      phase: 'staging',
      controlRequest: {
        requestId: '11111111-2222-4333-8444-555555555555',
        requestSha256: `sha256:${'e'.repeat(64)}`,
        runtimeSha: RUNTIME_SHA,
      },
    })}\n`);
    fs.writeFileSync(previous, previousBytes, { mode: 0o600 });
    fs.chmodSync(previous, 0o600);
    const previousDigest = `sha256:${createHash('sha256').update(previousBytes).digest('hex')}`;

    const mismatch = runNode(OBSERVATION_CONTROL, [
      'launch',
      '--phase', 'production',
      '--runtime-sha', RUNTIME_SHA,
      '--previous-evidence', previous,
      '--previous-evidence-sha256', `sha256:${'0'.repeat(64)}`,
    ], environment());
    expect(mismatch.status).not.toBe(0);
    expect(mismatch.stderr).toContain('digest changed');

    const queued = runNode(OBSERVATION_CONTROL, [
      'launch',
      '--phase', 'production',
      '--runtime-sha', RUNTIME_SHA,
      '--previous-evidence', previous,
      '--previous-evidence-sha256', previousDigest,
    ], environment({
      FAKE_SYSTEMD_JOBS: '9 ollama.service restart waiting\\n',
    }));
    expect(queued.status).not.toBe(0);
    expect(queued.stderr).toContain('service transition is already queued');
  });

  it('is one explicit non-restarting systemd transaction, not a scheduler or release lane', () => {
    const unit = fs.readFileSync(OBSERVATION_UNIT, 'utf8');
    const control = fs.readFileSync(OBSERVATION_CONTROL, 'utf8');
    const bootstrap = fs.readFileSync('scripts/remote-promotion-systemd-install.sh', 'utf8');
    const sonarLayout = fs.readFileSync('ops/sonarqube/install-layout.tsv', 'utf8');

    expect(unit).toContain('Type=oneshot');
    expect(unit).toContain('Restart=no');
    expect(unit).toContain('Requisite=ollama.service');
    expect(unit).not.toContain('Requires=ollama.service');
    expect(unit).toContain('/usr/local/sbin/nexus-ollama-observation-control.mjs run %i');
    expect(unit).toContain('TimeoutStartSec=25h30min');
    expect(unit).not.toContain('[Timer]');
    expect(unit).not.toContain('[Install]');
    expect(control).toContain("['start', '--no-block', unit]");
    expect(control).toContain('pending maintenance reboot');
    expect(control).toContain('const child = spawnSync(options.flock');
    expect(control).toContain('NEXUS_OLLAMA_OBSERVATION_SYSTEMD_REQUEST_ID');
    expect(control).toContain("'--expected-runtime-sha', request.value.runtimeSha");
    expect(control).toContain("'--control-request-id', request.value.requestId");
    expect(control).toContain("'--control-request-sha256', request.digest");
    expect(bootstrap).toContain('scripts/systemd/nexus-ollama-observation@.service');
    expect(bootstrap).toContain('scripts/systemd/00-nexus-ollama-install-guard.conf');
    expect(bootstrap).toContain('install_compatible_operational_asset');
    expect(bootstrap).toContain('existing operational asset is not the exact compatible source');
    expect(sonarLayout).toContain(
      'scripts/ollama-observation-control.mjs\t/usr/local/sbin/nexus-ollama-observation-control.mjs',
    );
    expect(sonarLayout).toContain(
      'scripts/systemd/00-nexus-ollama-install-guard.conf\t/etc/systemd/system/ollama.service.d/00-nexus-ollama-install-guard.conf',
    );
  });
});
