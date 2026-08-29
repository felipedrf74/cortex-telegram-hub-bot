// @ts-nocheck
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  bindProductionSmokeSource,
  createSuccessorAcceptanceState,
  LEGACY_TEN_SCRIPT_ACCEPTANCE_SCHEMA,
  migrateLegacyAcceptanceState,
  TEN_SCRIPT_ACCEPTANCE_REVISION,
  TEN_SCRIPT_ACCEPTANCE_SCENARIOS,
} from '../../scripts/content-ten-script-acceptance.mjs';
import {
  assertPrivateRegularFile,
  EXPECTED_ACCEPTANCE_TOOL_SHA256,
  EXPECTED_PRODUCTION_SOURCE_SHA,
  resolveWorkloadReleaseView,
  runProductionSmoke,
  safeProductionSmokeCliFailureMessage,
  stageVerifiedAcceptanceTool,
  VERIFIED_TOOL_LOADER,
  validateBoundWorkloadReleaseView,
  validateReadyAcceptanceState,
  validateProductionBaseUrl,
  writeOncePrivateFile,
} from '../../scripts/content-ten-script-production-smoke.mjs';

const roots: string[] = [];

describe('production smoke CLI error privacy', () => {
  it('preserves controlled refusals and redacts unexpected exception details', () => {
    const controlled = Object.assign(new Error('controlled smoke refusal'), { exitCode: 78 });
    expect(safeProductionSmokeCliFailureMessage(controlled)).toBe('controlled smoke refusal');
    expect(safeProductionSmokeCliFailureMessage(new Error('PRIVATE-SMOKE-PATH-MARKER'))).toBe('Error');
    expect(safeProductionSmokeCliFailureMessage('PRIVATE-SMOKE-STRING-MARKER')).toBe('string');
  });
});

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function privateDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-smoke-launcher-'));
  fs.chmodSync(directory, 0o700);
  roots.push(directory);
  return directory;
}

function jobId(index: number): string {
  return `script_job_0000000${index}-0000-4000-8000-00000000000${index}`;
}

function completedOutput(index: number) {
  return {
    scriptSha256: `sha256:${String(index).padStart(64, '0')}`,
    wordCount: 2100,
    warnings: [],
    route: 'cloud',
    modelDigest: null,
    sourceConsistent: true,
    contractPass: true,
  };
}

function readyLegacyState() {
  return {
    schemaVersion: LEGACY_TEN_SCRIPT_ACCEPTANCE_SCHEMA,
    acceptanceRevision: TEN_SCRIPT_ACCEPTANCE_REVISION,
    createdAt: '2026-08-22T22:00:00Z',
    scenarios: TEN_SCRIPT_ACCEPTANCE_SCENARIOS.map(({ topic, ...scenario }, index) => (
      scenario.phase === 'pre-release'
        ? {
            ...scenario,
            topicSha256: `sha256:${crypto.createHash('sha256').update(topic).digest('hex')}`,
            status: 'completed',
            jobId: jobId(index),
            output: completedOutput(index + 1),
            stage: 'completed',
            progress: 100,
            submittedAt: '2026-08-22T22:05:00Z',
            updatedAt: '2026-08-22T23:00:00Z',
          }
        : {
            ...scenario,
            topicSha256: `sha256:${crypto.createHash('sha256').update(topic).digest('hex')}`,
            status: 'pending',
            jobId: null,
            output: null,
          }
    )),
  };
}

function completedReleaseView(sourceSha = 'a'.repeat(40)) {
  const releaseId = 'b'.repeat(32);
  const payloadDigest = `sha256:${'c'.repeat(64)}`;
  return {
    schema: 'nexus.release-state-view.v2',
    blocked: null,
    capturedAt: '2026-08-22T23:45:00Z',
    active: {
      status: 'completed',
      sourceSha,
      releaseId,
      releasePayloadDigest: payloadDigest,
      images: { backend: { digest: `sha256:${'d'.repeat(64)}` } },
    },
    effective: {
      source: 'receipt', provable: true, status: 'completed', stateStatus: 'completed',
      staleProjection: false, releaseId, releasePayloadDigest: payloadDigest,
    },
    activeReceipt: {
      schema: 'nexus.release-receipt.v3', outcome: 'completed', sourceSha, releaseId,
      releasePayloadDigest: payloadDigest, completedAt: '2026-08-22T23:30:00Z',
    },
  };
}

function writePrivate(filename: string, contents: string | Buffer): void {
  fs.writeFileSync(filename, contents, { mode: 0o600 });
  fs.chmodSync(filename, 0o600);
}

function launcherFixture(state = readyLegacyState()) {
  const directory = privateDirectory();
  const statePath = path.join(directory, 'state.json');
  const authPath = path.join(directory, 'auth.json');
  const toolPath = path.join(directory, 'acceptance-tool.mjs');
  const workloadReleaseView = path.join(directory, 'workload-release-view.json');
  const toolBytes = fs.readFileSync(path.join(process.cwd(), 'scripts/content-ten-script-acceptance.mjs'));
  const toolSha256 = crypto.createHash('sha256').update(toolBytes).digest('hex');
  const deployedSha = EXPECTED_PRODUCTION_SOURCE_SHA;
  expect(toolSha256).toBe(EXPECTED_ACCEPTANCE_TOOL_SHA256);
  writePrivate(statePath, JSON.stringify(state));
  writePrivate(authPath, 'test-only-token\n');
  writePrivate(toolPath, toolBytes);
  return {
    directory,
    statePath,
    authPath,
    toolPath,
    workloadReleaseView,
    toolBytes,
    toolSha256,
    deployedSha,
    argv: [
      'node', 'launcher',
      '--state', statePath,
      '--auth-file', authPath,
      '--acceptance-tool', toolPath,
      '--acceptance-tool-sha256', toolSha256,
      '--workload-release-view', workloadReleaseView,
      '--base-url', 'https://api.nexushub.me',
      '--deployed-sha', deployedSha,
    ],
  };
}

async function runActualAcceptance(
  fixture: ReturnType<typeof launcherFixture>,
  baseUrl: string,
  releaseViewBytes: Buffer,
) {
  const releaseViewPath = path.join(
    fixture.directory,
    `anonymous-release-view-${crypto.randomBytes(8).toString('hex')}.json`,
  );
  writePrivate(releaseViewPath, releaseViewBytes);
  const releaseViewDescriptor = fs.openSync(releaseViewPath, fs.constants.O_RDONLY);
  fs.unlinkSync(releaseViewPath);
  const authDescriptorPath = path.join(
    fixture.directory,
    `anonymous-auth-${crypto.randomBytes(8).toString('hex')}.token`,
  );
  writePrivate(authDescriptorPath, fs.readFileSync(fixture.authPath));
  const authDescriptor = fs.openSync(authDescriptorPath, fs.constants.O_RDONLY);
  fs.unlinkSync(authDescriptorPath);
  const toolDescriptor = stageVerifiedAcceptanceTool(
    fixture.toolPath,
    fixture.toolSha256,
    fixture.directory,
  );
  const lockPath = `${fixture.statePath}.lock`;
  if (!fs.existsSync(lockPath)) writePrivate(lockPath, '');
  const stateIdentity = fs.statSync(fixture.statePath, { bigint: true });
  const stateSha256 = crypto.createHash('sha256')
    .update(fs.readFileSync(fixture.statePath)).digest('hex');
  const nodeArguments = [
    '--input-type=module', '--eval', VERIFIED_TOOL_LOADER,
    '--',
    '--phase', 'production-smoke',
    '--state', fixture.statePath,
    '--state-expected-dev', stateIdentity.dev.toString(),
    '--state-expected-ino', stateIdentity.ino.toString(),
    '--state-expected-sha256', stateSha256,
    '--auth-file-fd', '5',
    '--workload-release-view-fd', '4',
    '--base-url', baseUrl,
    '--deployed-sha', fixture.deployedSha,
  ];
  const command = process.platform === 'linux' ? '/usr/bin/flock' : process.execPath;
  const args = process.platform === 'linux'
    ? ['-E', '75', '-n', '-x', '-F', lockPath, process.execPath, ...nodeArguments]
    : nodeArguments;
  let child;
  try {
    child = spawn(command, args, {
      stdio: [
        'ignore',
        'pipe',
        'pipe',
        toolDescriptor,
        releaseViewDescriptor,
        authDescriptor,
      ],
      env: { PATH: '/usr/bin:/bin' },
    });
  } finally {
    fs.closeSync(toolDescriptor);
    fs.closeSync(releaseViewDescriptor);
    fs.closeSync(authDescriptor);
  }
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const [status, signal] = await once(child, 'close');
  return { status, signal, stdout, stderr };
}

describe('content ten-script production smoke launcher', () => {
  it('pins the smoke workload to the isolated-Batch serving receipt', () => {
    expect(EXPECTED_PRODUCTION_SOURCE_SHA)
      .toBe('815582be8127bafb97d7edaae2a4eab96e37c4cf');
  });

  it('accepts only a complete legacy pre-release inventory with pristine smoke', () => {
    const ready = readyLegacyState();
    expect(validateReadyAcceptanceState(ready)).toBe(true);

    const incomplete = structuredClone(ready);
    incomplete.scenarios[0].status = 'queued';
    incomplete.scenarios[0].output = null;
    delete incomplete.scenarios[0].stage;
    delete incomplete.scenarios[0].progress;
    expect(validateReadyAcceptanceState(incomplete)).toBe(false);

    const submittedSmoke = structuredClone(ready);
    const smoke = submittedSmoke.scenarios.find((row) => row.phase === 'production-smoke')!;
    smoke.status = 'queued';
    smoke.jobId = jobId(9);
    smoke.stage = 'queued';
    smoke.progress = 0;
    smoke.submittedAt = '2026-08-22T23:05:00Z';
    smoke.updatedAt = '2026-08-22T23:05:00Z';
    expect(() => validateReadyAcceptanceState(submittedSmoke)).toThrow(/legacy acceptance state/);
  });

  it('accepts a completed digest-bound successor while preserving the pristine smoke', () => {
    const predecessor: any = readyLegacyState();
    const preRelease = predecessor.scenarios.filter((row) => row.phase === 'pre-release');
    for (const row of preRelease.slice(7)) {
      row.status = 'failed';
      row.stage = 'failed';
      row.progress = 0;
      row.output = null;
      row.errorCode = 'OPENAI_BATCH_FAILED';
    }
    const successor: any = createSuccessorAcceptanceState(
      Buffer.from(`${JSON.stringify(predecessor)}\n`),
      '2026-08-23T02:00:00Z',
    );
    successor.scenarios.filter((row) => row.phase === 'pre-release' && !row.carriedForward)
      .forEach((row, index) => {
        row.jobId = jobId(index + 20);
        row.status = 'completed';
        row.stage = 'completed';
        row.progress = 100;
        row.submittedAt = '2026-08-23T02:05:00Z';
        row.updatedAt = '2026-08-23T03:00:00Z';
        row.output = completedOutput(index + 20);
      });
    expect(validateReadyAcceptanceState(successor)).toBe(true);
  });

  it('stages the exact successor predecessor bytes for the reviewed smoke tool', () => {
    const predecessor: any = readyLegacyState();
    const preRelease = predecessor.scenarios.filter((row) => row.phase === 'pre-release');
    for (const row of preRelease.slice(7)) {
      row.status = 'failed';
      row.stage = 'failed';
      row.progress = 0;
      row.output = null;
      row.errorCode = 'OPENAI_BATCH_FAILED';
    }
    const predecessorBytes = Buffer.from(`${JSON.stringify(predecessor)}\n`);
    const successor: any = createSuccessorAcceptanceState(
      predecessorBytes,
      '2026-08-23T02:00:00Z',
    );
    successor.scenarios.filter((row) => row.phase === 'pre-release' && !row.carriedForward)
      .forEach((row, index) => {
        row.jobId = jobId(index + 20);
        row.status = 'completed';
        row.stage = 'completed';
        row.progress = 100;
        row.submittedAt = '2026-08-23T02:05:00Z';
        row.updatedAt = '2026-08-23T03:00:00Z';
        row.output = completedOutput(index + 20);
      });
    const fixture = launcherFixture(successor);
    const predecessorPath = path.join(fixture.directory, 'predecessor.json');
    writePrivate(predecessorPath, predecessorBytes);
    fixture.argv.push('--predecessor-state', predecessorPath);

    let childArguments: string[] = [];
    expect(runProductionSmoke({
      argv: fixture.argv,
      platform: 'linux',
      acceptanceToolIdentityPath: fixture.toolPath,
      existsSyncImpl: () => true,
      captureReleaseView: () => Buffer.from(JSON.stringify(completedReleaseView(fixture.deployedSha))),
      spawnSyncImpl: (_command, args, options) => {
        childArguments = args;
        expect(fs.readFileSync(options.stdio[6] as number)).toEqual(predecessorBytes);
        expect(fs.fstatSync(options.stdio[6] as number).nlink).toBe(0);
        return { status: 0, signal: null, error: undefined };
      },
    })).toBe(0);
    expect(childArguments).toEqual(expect.arrayContaining([
      '--predecessor-state-fd', '6',
    ]));
    expect(childArguments).not.toContain(predecessorPath);

    writePrivate(predecessorPath, Buffer.concat([predecessorBytes, Buffer.from(' ')]));
    expect(() => runProductionSmoke({
      argv: fixture.argv,
      platform: 'linux',
      acceptanceToolIdentityPath: fixture.toolPath,
      existsSyncImpl: () => true,
      captureReleaseView: () => Buffer.from(JSON.stringify(completedReleaseView(fixture.deployedSha))),
      spawnSyncImpl: () => ({ status: 0 }),
    })).toThrow(/predecessor bytes do not match/);
  });

  it('resumes only the existing smoke identity bound to the reviewed source', () => {
    const state: any = migrateLegacyAcceptanceState(readyLegacyState());
    const releaseView = completedReleaseView(EXPECTED_PRODUCTION_SOURCE_SHA);
    const releaseViewBytes = Buffer.from(JSON.stringify(releaseView));
    bindProductionSmokeSource(state, EXPECTED_PRODUCTION_SOURCE_SHA, {
      releaseView,
      releaseViewBytes,
      boundAt: '2026-08-22T23:50:00Z',
    });
    const smoke = state.scenarios.find((row: { phase: string }) => row.phase === 'production-smoke');
    smoke.jobId = jobId(9);
    smoke.status = 'queued';
    smoke.stage = 'queued';
    smoke.progress = 0;
    smoke.submittedAt = '2026-08-22T23:55:00Z';
    smoke.updatedAt = '2026-08-22T23:55:00Z';
    expect(validateReadyAcceptanceState(state)).toBe(true);

    const mismatched = structuredClone(state);
    mismatched.productionSmokeSource.sourceSha = 'd'.repeat(40);
    expect(() => validateReadyAcceptanceState(mismatched)).toThrow(/reviewed source/);
  });

  it('resumes only against the exact release-view bytes already bound in state', () => {
    const state: any = migrateLegacyAcceptanceState(readyLegacyState());
    const releaseView = completedReleaseView(EXPECTED_PRODUCTION_SOURCE_SHA);
    const releaseViewBytes = Buffer.from(JSON.stringify(releaseView));
    bindProductionSmokeSource(state, EXPECTED_PRODUCTION_SOURCE_SHA, {
      releaseView,
      releaseViewBytes,
      boundAt: '2026-08-22T23:50:00Z',
    });

    expect(() => validateBoundWorkloadReleaseView(
      state,
      releaseViewBytes,
      EXPECTED_PRODUCTION_SOURCE_SHA,
    )).not.toThrow();

    const laterView = structuredClone(releaseView);
    laterView.capturedAt = '2026-08-22T23:46:00Z';
    expect(() => validateBoundWorkloadReleaseView(
      state,
      Buffer.from(JSON.stringify(laterView)),
      EXPECTED_PRODUCTION_SOURCE_SHA,
    )).toThrow(/exact reviewed release view/);
  });

  it('writes immutable private bytes and refuses different existing evidence', () => {
    const directory = privateDirectory();
    const filename = path.join(directory, 'workload-release-view.json');
    const first = Buffer.from(JSON.stringify(completedReleaseView()));
    const second = Buffer.from(JSON.stringify(completedReleaseView('d'.repeat(40))));

    expect(writeOncePrivateFile(filename, first)).toEqual(first);
    expect(fs.statSync(filename).mode & 0o777).toBe(0o600);
    expect(fs.statSync(filename).nlink).toBe(1);
    expect(() => writeOncePrivateFile(filename, second)).toThrow(/differs from authoritative bytes/);
    expect(fs.readFileSync(filename)).toEqual(first);
  });

  it('removes a partially created write-once file when persistence fails', () => {
    const directory = privateDirectory();
    const filename = path.join(directory, 'workload-release-view.json');
    const bytes = Buffer.from(JSON.stringify(completedReleaseView()));
    const write = vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => {
      throw new Error('simulated write failure');
    });
    try {
      expect(() => writeOncePrivateFile(filename, bytes)).toThrow(/simulated write failure/);
      expect(fs.existsSync(filename)).toBe(false);
    } finally {
      write.mockRestore();
    }
  });

  it('reuses and validates the exact persisted release-view bytes', () => {
    const directory = privateDirectory();
    const filename = path.join(directory, 'workload-release-view.json');
    const sourceSha = 'a'.repeat(40);
    const bytes = Buffer.from(JSON.stringify(completedReleaseView(sourceSha)));
    let captures = 0;

    expect(resolveWorkloadReleaseView(filename, sourceSha, () => {
      captures += 1;
      return bytes;
    })).toEqual(bytes);
    expect(resolveWorkloadReleaseView(filename, sourceSha, () => {
      captures += 1;
      return Buffer.alloc(0);
    })).toEqual(bytes);
    expect(captures).toBe(1);
    expect(crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex'))
      .toBe(crypto.createHash('sha256').update(bytes).digest('hex'));
    expect(() => assertPrivateRegularFile(filename, 'view')).not.toThrow();
  });

  it('refuses symlinked or multiply-linked release-view paths before reuse', () => {
    const directory = privateDirectory();
    const sourceSha = 'a'.repeat(40);
    const target = path.join(directory, 'target.json');
    const symlink = path.join(directory, 'symlink.json');
    const hardlink = path.join(directory, 'hardlink.json');
    fs.writeFileSync(target, JSON.stringify(completedReleaseView(sourceSha)), { mode: 0o600 });
    fs.symlinkSync(target, symlink);
    fs.linkSync(target, hardlink);

    expect(() => resolveWorkloadReleaseView(symlink, sourceSha))
      .toThrow(/single-link|symbolic links/);
    expect(() => resolveWorkloadReleaseView(hardlink, sourceSha)).toThrow(/single-link/);
  });

  it('pins the bearer-token destination to the canonical production origin', () => {
    expect(validateProductionBaseUrl('https://api.nexushub.me')).toBe('https://api.nexushub.me');
    expect(validateProductionBaseUrl('https://api.nexushub.me/')).toBe('https://api.nexushub.me');
    expect(() => validateProductionBaseUrl('https://api.nexushub.me@collector.example'))
      .toThrow(/canonical production API origin/);
    expect(() => validateProductionBaseUrl('https://api.nexushub.me/api/v1'))
      .toThrow(/canonical production API origin/);
    expect(() => validateProductionBaseUrl('https://api.nexushub.me?redirect=collector.example'))
      .toThrow(/canonical production API origin/);
  });

  it('executes an unlinked descriptor containing the exact reviewed tool bytes', () => {
    const fixture = launcherFixture();
    let childArguments: string[] | undefined;
    let childCommand: string | undefined;
    let childOptions: { stdio: Array<string | number>; env: Record<string, string> } | undefined;

    const result = runProductionSmoke({
      argv: fixture.argv,
      platform: 'linux',
      acceptanceToolIdentityPath: fixture.toolPath,
      existsSyncImpl: () => true,
      captureReleaseView: () => Buffer.from(JSON.stringify(completedReleaseView(fixture.deployedSha))),
      spawnSyncImpl: (command: string, args: string[], options: typeof childOptions) => {
        childCommand = command;
        childArguments = args;
        childOptions = options;
        fs.renameSync(fixture.toolPath, `${fixture.toolPath}.replaced`);
        writePrivate(fixture.toolPath, 'throw new Error("unreviewed replacement");\n');
        expect(fs.readFileSync(options!.stdio[3] as number)).toEqual(fixture.toolBytes);
        const releaseView = JSON.parse(fs.readFileSync(options!.stdio[4] as number, 'utf8'));
        expect(releaseView.active.sourceSha).toBe(EXPECTED_PRODUCTION_SOURCE_SHA);
        expect(fs.readFileSync(options!.stdio[5] as number, 'utf8')).toBe('test-only-token\n');
        expect(fs.fstatSync(options!.stdio[5] as number).nlink).toBe(0);
        return { status: 0, signal: null, error: undefined };
      },
    });

    expect(result).toBe(0);
    expect(childCommand).toBe('/usr/bin/flock');
    expect(childArguments?.slice(0, 8)).toEqual([
      '-E', '75', '-n', '-x', '-F', `${fixture.statePath}.lock`,
      '/usr/bin/node',
      '--input-type=module',
    ]);
    expect(childArguments?.slice(8, 11)).toEqual([
      '--eval', expect.stringContaining('fs.readFileSync(3)'),
      '--',
    ]);
    expect(childArguments).not.toContain(fixture.toolPath);
    expect(childArguments).not.toContain(fixture.authPath);
    expect(childArguments).toEqual(expect.arrayContaining([
      '--state-expected-dev', expect.stringMatching(/^\d+$/u),
      '--state-expected-ino', expect.stringMatching(/^\d+$/u),
      '--state-expected-sha256', expect.stringMatching(/^[0-9a-f]{64}$/u),
      '--auth-file-fd', '5',
      '--workload-release-view-fd', '4',
      '--base-url', 'https://api.nexushub.me',
      '--deployed-sha', fixture.deployedSha,
    ]));
    expect(childOptions?.env).toEqual({ PATH: '/usr/bin:/bin' });
    expect(fs.existsSync(fixture.workloadReleaseView)).toBe(true);
    expect(fs.readdirSync(fixture.directory).some((name) => name.startsWith('.content-ten-script-acceptance-tool-')))
      .toBe(false);
    expect(fs.readdirSync(fixture.directory).some((name) => name.startsWith('.content-ten-script-release-view-')))
      .toBe(false);
    expect(fs.readdirSync(fixture.directory).some((name) => name.startsWith('.content-ten-script-auth-file-')))
      .toBe(false);
  });

  it('fails closed before capture or execution when the nine-script gate is incomplete', () => {
    const state = readyLegacyState();
    state.scenarios[0].status = 'queued';
    state.scenarios[0].output = null;
    delete state.scenarios[0].stage;
    delete state.scenarios[0].progress;
    const fixture = launcherFixture(state);
    let captures = 0;
    let executions = 0;

    expect(() => runProductionSmoke({
      argv: fixture.argv,
      platform: 'linux',
      acceptanceToolIdentityPath: fixture.toolPath,
      existsSyncImpl: () => true,
      captureReleaseView: () => {
        captures += 1;
        return Buffer.alloc(0);
      },
      spawnSyncImpl: () => {
        executions += 1;
        return { status: 0 };
      },
    })).toThrow(/nine pre-release scenarios/);
    expect(captures).toBe(0);
    expect(executions).toBe(0);
  });

  it('enforces the reviewed digest and propagates child failure', () => {
    const mismatch = launcherFixture();
    mismatch.argv[mismatch.argv.indexOf('--acceptance-tool-sha256') + 1] = 'f'.repeat(64);
    expect(() => runProductionSmoke({
      argv: mismatch.argv,
      platform: 'linux',
      acceptanceToolIdentityPath: mismatch.toolPath,
      existsSyncImpl: () => true,
      captureReleaseView: () => Buffer.from(JSON.stringify(completedReleaseView(mismatch.deployedSha))),
      spawnSyncImpl: () => ({ status: 0 }),
    })).toThrow(/reviewed identity/);

    const wrongPath = launcherFixture();
    expect(() => runProductionSmoke({
      argv: wrongPath.argv,
      platform: 'linux',
      existsSyncImpl: () => true,
      captureReleaseView: () => Buffer.from(JSON.stringify(completedReleaseView(wrongPath.deployedSha))),
      spawnSyncImpl: () => ({ status: 0 }),
    })).toThrow(/reviewed adjacent module/);

    const wrongSource = launcherFixture();
    wrongSource.argv[wrongSource.argv.indexOf('--deployed-sha') + 1] = 'd'.repeat(40);
    expect(() => runProductionSmoke({
      argv: wrongSource.argv,
      platform: 'linux',
      acceptanceToolIdentityPath: wrongSource.toolPath,
      existsSyncImpl: () => true,
      captureReleaseView: () => Buffer.from(JSON.stringify(completedReleaseView('d'.repeat(40)))),
      spawnSyncImpl: () => ({ status: 0 }),
    })).toThrow(/reviewed identity/);

    const failed = launcherFixture();
    expect(() => runProductionSmoke({
      argv: failed.argv,
      platform: 'linux',
      acceptanceToolIdentityPath: failed.toolPath,
      existsSyncImpl: () => true,
      captureReleaseView: () => Buffer.from(JSON.stringify(completedReleaseView(failed.deployedSha))),
      spawnSyncImpl: () => ({ status: 70, signal: null, error: undefined }),
    })).toThrow(/production smoke invocation failed/);
  });

  it('runs the real loader and lock path but refuses a noncanonical destination', async () => {
    const fixture = launcherFixture();
    const releaseViewBytes = Buffer.from(JSON.stringify(completedReleaseView(fixture.deployedSha)));
    const result = await runActualAcceptance(
      fixture,
      'http://127.0.0.1:1',
      releaseViewBytes,
    );
    expect(result.status).toBe(77);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/canonical production API origin/);
    const state = JSON.parse(fs.readFileSync(fixture.statePath, 'utf8'));
    expect(state.schemaVersion).toBe(LEGACY_TEN_SCRIPT_ACCEPTANCE_SCHEMA);
    expect(state).not.toHaveProperty('productionSmokeSource');
  });

  it('refuses direct production-smoke execution outside the receipt-bound loader', () => {
    const fixture = launcherFixture();
    const releaseViewBytes = Buffer.from(JSON.stringify(completedReleaseView(fixture.deployedSha)));
    writePrivate(fixture.workloadReleaseView, releaseViewBytes);
    const result = spawnSync(process.execPath, [
      'scripts/content-ten-script-acceptance.mjs',
      '--phase', 'production-smoke',
      '--state', fixture.statePath,
      '--auth-file', fixture.authPath,
      '--workload-release-view', fixture.workloadReleaseView,
      '--base-url', 'https://api.nexushub.me',
      '--deployed-sha', fixture.deployedSha,
    ], { encoding: 'utf8' });
    expect(result.status).toBe(77);
    expect(result.stderr).toMatch(/receipt-bound launcher/);
    expect(JSON.parse(fs.readFileSync(fixture.statePath, 'utf8')))
      .not.toHaveProperty('productionSmokeSource');
  });

  it('stages no executable when the acceptance tool is multiply linked', () => {
    const directory = privateDirectory();
    const tool = path.join(directory, 'tool.mjs');
    const link = path.join(directory, 'tool-link.mjs');
    const bytes = Buffer.from('process.exitCode = 0;\n');
    writePrivate(tool, bytes);
    fs.linkSync(tool, link);
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    expect(() => stageVerifiedAcceptanceTool(tool, digest, directory)).toThrow(/single-link/);
  });

  it('stages the actual adjacent owner-controlled repository tool', () => {
    const directory = privateDirectory();
    const tool = path.join(process.cwd(), 'scripts/content-ten-script-acceptance.mjs');
    const launcherSource = fs.readFileSync(
      path.join(process.cwd(), 'scripts/content-ten-script-production-smoke.mjs'),
      'utf8',
    );
    expect(fs.statSync(tool).mode & 0o777).toBe(0o644);
    expect(launcherSource)
      .not.toMatch(/from\s+['"]\.\/content-ten-script-acceptance\.mjs['"]/u);
    const descriptor = stageVerifiedAcceptanceTool(
      tool,
      EXPECTED_ACCEPTANCE_TOOL_SHA256,
      directory,
    );
    try {
      expect(fs.fstatSync(descriptor).nlink).toBe(0);
    } finally {
      fs.closeSync(descriptor);
    }
  });

  it('rejects a writable acceptance-tool source before staging it', () => {
    const directory = privateDirectory();
    const tool = path.join(directory, 'writable-tool.mjs');
    const bytes = Buffer.from('export async function runCliUnderStateLock() {}\n');
    fs.writeFileSync(tool, bytes, { mode: 0o664 });
    fs.chmodSync(tool, 0o664);
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');

    expect(() => stageVerifiedAcceptanceTool(tool, digest, directory))
      .toThrow(/owner-controlled non-writable source file/);
  });

  it('loads the exact descriptor bytes as ESM and preserves CLI arguments', () => {
    const directory = privateDirectory();
    const tool = path.join(directory, 'descriptor-tool.mjs');
    const bytes = Buffer.from([
      "import crypto from 'node:crypto';",
      'export async function runCliUnderStateLock(){',
      "process.stdout.write(JSON.stringify({args:process.argv.slice(1),digest:crypto.createHash('sha256').update('ok').digest('hex')}));",
      '}',
    ].join(''));
    writePrivate(tool, bytes);
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    const descriptor = stageVerifiedAcceptanceTool(tool, digest, directory);
    try {
      const result = spawnSync(process.execPath, [
        '--input-type=module', '--eval', VERIFIED_TOOL_LOADER,
        '--', '--phase', 'production-smoke',
      ], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe', descriptor],
        env: { PATH: '/usr/bin:/bin' },
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toEqual({
        args: ['--phase', 'production-smoke'],
        digest: crypto.createHash('sha256').update('ok').digest('hex'),
      });
    } finally {
      fs.closeSync(descriptor);
    }
  });
});
