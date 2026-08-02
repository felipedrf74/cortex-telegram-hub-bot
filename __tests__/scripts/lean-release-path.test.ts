import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  RELEASE_ARTIFACT_SCHEMA,
  releaseArtifactDigest,
} from '../../scripts/lib/release-artifact-manifest.mjs';
import {
  deterministicTestInventory,
} from '../../scripts/lib/release-test-partition.mjs';

const roots: string[] = [];
const manifestScript = path.resolve('scripts/release-checksum-manifest.mjs');

function sha256(body: Buffer | string) {
  return createHash('sha256').update(body).digest('hex');
}

function fixture(options: { docsOnly?: boolean; governanceReview?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-lean-release-'));
  roots.push(root);
  const bundle = path.join(root, 'bundle');
  const shards = path.join(root, 'shards');
  fs.mkdirSync(bundle);
  fs.mkdirSync(shards);
  const packageBody = Buffer.from('{"name":"fixture","version":"1.2.3"}\n');
  fs.writeFileSync(path.join(bundle, 'package.json'), packageBody);
  const files = [{
    path: 'package.json',
    size: packageBody.length,
    sha256: sha256(packageBody),
  }];
  const digest = releaseArtifactDigest(files);
  const runtimeSha = 'a'.repeat(40);
  const protectedReleaseState = JSON.parse(
    fs.readFileSync(path.resolve('docs/release/release-state.json'), 'utf8'),
  );
  const deployedSha = protectedReleaseState.backend.runtimeSha;
  const deployedDigest = protectedReleaseState.backend.artifactDigest;
  fs.writeFileSync(path.join(bundle, 'artifact-manifest.json'), `${JSON.stringify({
    schema: RELEASE_ARTIFACT_SCHEMA,
    generatedAt: new Date().toISOString(),
    root: '.',
    git: { sha: runtimeSha, shortSha: runtimeSha.slice(0, 7), branch: 'main' },
    digest,
    fileCount: files.length,
    files,
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(bundle, '.complete.json'), `${JSON.stringify({
    schema: 'nexus.release-bundle.v1',
    runtimeSha,
    packageVersion: '1.2.3',
    artifactDigest: digest,
    fileCount: files.length,
    createdAt: new Date().toISOString(),
  }, null, 2)}\n`);
  const deterministic = deterministicTestInventory();
  const selected = options.docsOnly ? [] : deterministic.slice(0, 2);
  const selectedSet = new Set(selected);
  const remaining = deterministic.filter((file) => !selectedSet.has(file));
  const shardFiles = [0, 1, 2, 3].map((offset) => (
    remaining.filter((_, index) => index % 4 === offset)
  ));
  shardFiles.forEach((files, index) => {
    fs.writeFileSync(path.join(shards, `vitest-results-${index + 1}.json`), JSON.stringify({
      numTotalTests: files.length,
      numPassedTests: files.length,
      numFailedTests: 0,
      success: true,
      testResults: files.map((name) => ({ name: path.resolve(name) })),
    }));
  });
  const selection = path.join(root, 'test-selection.json');
  const policy = path.join(root, 'test-policy.json');
  fs.writeFileSync(policy, '{"schema":"nexus.test-groups.v1"}\n');
  fs.writeFileSync(selection, JSON.stringify({
    schema: 'nexus.test-selection.v2',
    docsOnly: options.docsOnly === true,
    groups: options.docsOnly ? [] : ['chat-secretary', 'platform-security'],
    selected,
    policyDigest: sha256(fs.readFileSync(policy)),
  }));
  const selectedResult = path.join(root, 'vitest-results-selected.json');
  if (!options.docsOnly) {
    fs.writeFileSync(selectedResult, JSON.stringify({
      numTotalTests: selected.length,
      numPassedTests: selected.length,
      numFailedTests: 0,
      success: true,
      testResults: selected.map((name) => ({ name: path.resolve(name) })),
    }));
  }
  const migrations = path.join(root, 'migration-result.json');
  const governanceSubject = options.governanceReview ? 'd'.repeat(64) : null;
  fs.writeFileSync(migrations, JSON.stringify({
    ok: true,
    authorization: {
      approvalRequired: false,
      governanceReviewRequired: options.governanceReview === true,
    },
    requiredReviewSubject: governanceSubject ? { sha256: governanceSubject } : null,
  }));
  return {
    root, bundle, shards, selection, selectedResult, policy, migrations, digest, runtimeSha,
    deployedSha, deployedDigest, governanceSubject,
    deterministic,
    output: path.join(root, 'release-manifest.json'),
  };
}

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('lean exact-artifact release path', () => {
  it('writes a compact manifest bound to four complete shards and the original bundle', () => {
    const value = fixture({ governanceReview: true });
    execFileSync(process.execPath, [
      manifestScript, 'write',
      '--source-sha', value.runtimeSha,
      '--bundle', value.bundle,
      '--artifact-name', `release-bundle-${value.runtimeSha}-${value.digest}`,
      '--protected-run-id', '100',
      '--protected-run-attempt', '1',
      '--checkpoint-run-id', '200',
      '--checkpoint-run-attempt', '1',
      '--release-deployed-sha', value.deployedSha,
      '--release-groups-json', '["chat-secretary","platform-security"]',
      '--selection', value.selection,
      '--selected-result', value.selectedResult,
      '--policy-file', value.policy,
      '--shard-results', value.shards,
      '--python-required', 'false',
      '--python-status', 'skipped',
      '--migration-required', 'true',
      '--migration-status', 'passed',
      '--migration-result', value.migrations,
      '--migration-review-sha256', value.governanceSubject!,
      '--output', value.output,
    ]);

    const manifest = JSON.parse(fs.readFileSync(value.output, 'utf8'));
    expect(manifest).toMatchObject({
      schema: 'nexus.release-checksum-manifest.v1',
      sourceSha: value.runtimeSha,
      artifact: {
        name: `release-bundle-${value.runtimeSha}-${value.digest}`,
        sha256: value.digest,
      },
      protectedMain: {
        docsOnly: false,
        selectedTests: { status: 'passed', tests: 2 },
      },
      releaseImpact: {
        deployedSha: value.deployedSha,
        groups: ['chat-secretary', 'platform-security'],
      },
      selectedGroups: ['chat-secretary', 'platform-security'],
      fullSuite: {
        status: 'passed',
        execution: 'protected-main-selection-plus-checkpoint-remainder',
        tests: value.deterministic.length,
        files: value.deterministic.length,
        partition: {
          disjoint: true,
          complete: true,
          deterministic: { files: value.deterministic.length },
          selected: { files: 2 },
          remaining: { files: value.deterministic.length - 2 },
        },
      },
      python: { required: false, status: 'skipped' },
      migrations: {
        required: true,
        status: 'passed',
        approvalRequired: false,
        governanceReviewRequired: true,
        reviewSubjectSha256: null,
        governanceReviewSubjectSha256: value.governanceSubject,
      },
    });
    expect(manifest.fullSuite.shards.map((entry: { shard: string }) => entry.shard))
      .toEqual(['1/4', '2/4', '3/4', '4/4']);

    execFileSync(process.execPath, [
      manifestScript, 'validate',
      '--manifest', value.output,
      '--bundle', value.bundle,
      '--expect-source-sha', value.runtimeSha,
      '--expect-artifact-digest', value.digest,
    ]);

    const originalManifest = fs.readFileSync(value.output, 'utf8');
    const redownloadedManifest = path.join(value.root, 'redownloaded-release-manifest.json');
    fs.writeFileSync(redownloadedManifest, originalManifest);
    const manifestDigest = sha256(originalManifest);
    execFileSync(process.execPath, [
      manifestScript, 'verify-cache',
      '--manifest', value.output,
      '--downloaded-manifest', redownloadedManifest,
      '--expect-manifest-sha256', manifestDigest,
      '--expect-source-sha', value.runtimeSha,
      '--expect-artifact-digest', value.digest,
    ]);
    fs.appendFileSync(value.output, ' ');
    const tamperedCache = spawnSync(process.execPath, [
      manifestScript, 'verify-cache',
      '--manifest', value.output,
      '--downloaded-manifest', redownloadedManifest,
      '--expect-manifest-sha256', manifestDigest,
      '--expect-source-sha', value.runtimeSha,
      '--expect-artifact-digest', value.digest,
    ], { encoding: 'utf8' });
    expect(tamperedCache.status).toBe(1);
    expect(tamperedCache.stderr).toContain('cached release checksum manifest digest drifted');
    fs.writeFileSync(value.output, originalManifest);
    fs.appendFileSync(redownloadedManifest, ' ');
    const tamperedRedownload = spawnSync(process.execPath, [
      manifestScript, 'verify-cache',
      '--manifest', value.output,
      '--downloaded-manifest', redownloadedManifest,
      '--expect-manifest-sha256', manifestDigest,
      '--expect-source-sha', value.runtimeSha,
      '--expect-artifact-digest', value.digest,
    ], { encoding: 'utf8' });
    expect(tamperedRedownload.status).toBe(1);
    expect(tamperedRedownload.stderr).toContain(
      're-downloaded release checksum manifest does not exactly match',
    );
    fs.writeFileSync(redownloadedManifest, originalManifest);

    const invalidImpact = JSON.parse(originalManifest);
    delete invalidImpact.releaseImpact;
    fs.writeFileSync(value.output, JSON.stringify(invalidImpact));
    const missingImpact = spawnSync(process.execPath, [
      manifestScript, 'validate',
      '--manifest', value.output,
      '--expect-source-sha', value.runtimeSha,
      '--expect-artifact-digest', value.digest,
    ], { encoding: 'utf8' });
    expect(missingImpact.status).toBe(1);
    expect(missingImpact.stderr).toContain('release-impact deployed SHA');
    fs.writeFileSync(value.output, originalManifest);

    const wrongDeployed = JSON.parse(originalManifest);
    wrongDeployed.releaseImpact.deployedSha = 'b'.repeat(40);
    fs.writeFileSync(value.output, JSON.stringify(wrongDeployed));
    const nonCanonicalDeployed = spawnSync(process.execPath, [
      manifestScript, 'validate',
      '--manifest', value.output,
      '--expect-source-sha', value.runtimeSha,
      '--expect-artifact-digest', value.digest,
    ], { encoding: 'utf8' });
    expect(nonCanonicalDeployed.status).toBe(1);
    expect(nonCanonicalDeployed.stderr).toContain(
      'does not match canonical protected release state',
    );
    fs.writeFileSync(value.output, originalManifest);

    const wrongDigest = spawnSync(process.execPath, [
      manifestScript, 'validate',
      '--manifest', value.output,
      '--expect-source-sha', value.runtimeSha,
      '--expect-artifact-digest', 'c'.repeat(64),
    ], { encoding: 'utf8' });
    expect(wrongDigest.status).toBe(1);
    expect(wrongDigest.stderr).toContain('artifact digest mismatch');

    const stagingState = path.join(value.root, 'staging-state.json');
    fs.writeFileSync(stagingState, JSON.stringify({
      schema: 'nexus.lean-release-transaction.v1',
      role: 'staging',
      transactionId: `20260727T120000Z-${'b'.repeat(12)}`,
      runtimeSha: value.runtimeSha,
      artifactDigest: value.digest,
      releaseDir: `/home/dominguez/telegram-hub-bot-staging/releases/${value.runtimeSha}-${value.digest.slice(0, 12)}`,
      predecessor: '/home/dominguez/telegram-hub-bot-staging/releases/previous',
      predecessorSha: value.deployedSha,
      predecessorDigest: 'c'.repeat(64),
      phase: 'completed',
      status: 'passed',
      message: null,
      startedAt: '2026-07-27T12:00:00.000Z',
      completedAt: '2026-07-27T12:01:00.000Z',
      updatedAt: '2026-07-27T12:01:00.100Z',
      healthResult: 'passed',
      rollbackResult: 'not_required',
      rollbackDurationMs: null,
      stabilitySeconds: 15,
      soakStartedAt: '2026-07-27T12:00:30.000Z',
      soakCompletedAt: '2026-07-27T12:00:45.000Z',
      candidateHealthBudgetSeconds: 45,
      rollbackHealthBudgetSeconds: 45,
      rollbackObjectiveSeconds: 120,
      faultInjection: null,
      candidateRemoved: false,
      checks: {
        artifactParity: 'passed',
        migrationStartup: 'passed',
        authenticatedSmoke: 'passed',
        databaseIntegrity: 'passed',
        prePromotionBackup: 'skipped',
        rollbackReadiness: 'passed',
      },
    }));
    execFileSync(process.execPath, [
      manifestScript, 'validate-state',
      '--manifest', value.output,
      '--state', stagingState,
      '--role', 'staging',
    ]);

    const productionState = path.join(value.root, 'production-state.json');
    const staging = JSON.parse(fs.readFileSync(stagingState, 'utf8'));
    fs.writeFileSync(productionState, JSON.stringify({
      ...staging,
      role: 'production',
      releaseDir: `/home/dominguez/telegram-hub-bot/releases/${value.runtimeSha}-${value.digest.slice(0, 12)}`,
      predecessor: '/home/dominguez/telegram-hub-bot/releases/previous',
      predecessorSha: value.deployedSha,
      predecessorDigest: 'c'.repeat(64),
      stabilitySeconds: 60,
      soakStartedAt: '2026-07-27T12:00:00.000Z',
      soakCompletedAt: '2026-07-27T12:01:00.000Z',
      checks: { ...staging.checks, prePromotionBackup: 'passed' },
    }));
    execFileSync(process.execPath, [
      manifestScript, 'validate-state',
      '--manifest', value.output,
      '--state', productionState,
      '--role', 'production',
    ]);

    const wrongPredecessor = JSON.parse(fs.readFileSync(productionState, 'utf8'));
    wrongPredecessor.predecessorSha = 'd'.repeat(40);
    fs.writeFileSync(productionState, JSON.stringify(wrongPredecessor));
    const predecessorMismatch = spawnSync(process.execPath, [
      manifestScript, 'validate-state',
      '--manifest', value.output,
      '--state', productionState,
      '--role', 'production',
    ], { encoding: 'utf8' });
    expect(predecessorMismatch.status).toBe(1);
    expect(predecessorMismatch.stderr).toContain(
      'not completed for the exact manifest',
    );
    wrongPredecessor.predecessorSha = value.deployedSha;
    fs.writeFileSync(productionState, JSON.stringify(wrongPredecessor));

    fs.writeFileSync(productionState, JSON.stringify({
      ...JSON.parse(fs.readFileSync(productionState, 'utf8')),
      checks: { ...staging.checks, authenticatedSmoke: 'skipped', prePromotionBackup: 'passed' },
    }));
    const skippedProductionSmoke = spawnSync(process.execPath, [
      manifestScript, 'validate-state',
      '--manifest', value.output,
      '--state', productionState,
      '--role', 'production',
    ], { encoding: 'utf8' });
    expect(skippedProductionSmoke.status).toBe(1);
    expect(skippedProductionSmoke.stderr).toContain(
      'lean release transaction checks are incomplete',
    );
  });

  it('rejects a failed or incomplete full-suite shard', () => {
    const value = fixture();
    fs.writeFileSync(path.join(value.shards, 'vitest-results-3.json'), JSON.stringify({
      numTotalTests: 3,
      numPassedTests: 2,
      numFailedTests: 1,
    }));
    const failed = spawnSync(process.execPath, [
      manifestScript, 'write',
      '--source-sha', value.runtimeSha,
      '--bundle', value.bundle,
      '--artifact-name', `release-bundle-${value.runtimeSha}-${value.digest}`,
      '--protected-run-id', '100',
      '--protected-run-attempt', '1',
      '--checkpoint-run-id', '200',
      '--checkpoint-run-attempt', '1',
      '--release-deployed-sha', value.deployedSha,
      '--release-groups-json', '["chat-secretary"]',
      '--selection', value.selection,
      '--selected-result', value.selectedResult,
      '--policy-file', value.policy,
      '--shard-results', value.shards,
      '--python-required', 'false',
      '--python-status', 'skipped',
      '--migration-required', 'true',
      '--migration-status', 'passed',
      '--migration-result', value.migrations,
      '--output', value.output,
    ], { encoding: 'utf8' });

    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain('Vitest shard 3 result is not a complete passing result');
  });

  it('rejects any overlap or gap between protected-main and checkpoint tests', () => {
    const value = fixture();
    const shard = path.join(value.shards, 'vitest-results-1.json');
    const report = JSON.parse(fs.readFileSync(shard, 'utf8'));
    const selected = JSON.parse(fs.readFileSync(value.selection, 'utf8')).selected;
    report.testResults[0].name = path.resolve(selected[0]);
    fs.writeFileSync(shard, JSON.stringify(report));

    const failed = spawnSync(process.execPath, [
      manifestScript, 'write',
      '--source-sha', value.runtimeSha,
      '--bundle', value.bundle,
      '--artifact-name', `release-bundle-${value.runtimeSha}-${value.digest}`,
      '--protected-run-id', '100',
      '--protected-run-attempt', '1',
      '--checkpoint-run-id', '200',
      '--checkpoint-run-attempt', '1',
      '--release-deployed-sha', value.deployedSha,
      '--release-groups-json', '["chat-secretary"]',
      '--selection', value.selection,
      '--selected-result', value.selectedResult,
      '--policy-file', value.policy,
      '--shard-results', value.shards,
      '--python-required', 'false',
      '--python-status', 'skipped',
      '--migration-required', 'false',
      '--migration-status', 'skipped',
      '--migration-result', '',
      '--output', value.output,
    ], { encoding: 'utf8' });

    expect(failed.status).toBe(1);
    expect(failed.stderr).toMatch(/overlap|exactly cover/);
  });

  it('accepts an exact docs-only main selection without inventing a Vitest result', () => {
    const value = fixture({ docsOnly: true });
    execFileSync(process.execPath, [
      manifestScript, 'write',
      '--source-sha', value.runtimeSha,
      '--bundle', value.bundle,
      '--artifact-name', `release-bundle-${value.runtimeSha}-${value.digest}`,
      '--protected-run-id', '100',
      '--protected-run-attempt', '1',
      '--checkpoint-run-id', '200',
      '--checkpoint-run-attempt', '1',
      '--release-deployed-sha', value.deployedSha,
      '--release-groups-json', '[]',
      '--selection', value.selection,
      '--selected-result', '',
      '--policy-file', value.policy,
      '--shard-results', value.shards,
      '--python-required', 'false',
      '--python-status', 'skipped',
      '--migration-required', 'false',
      '--migration-status', 'skipped',
      '--migration-result', '',
      '--output', value.output,
    ]);

    expect(JSON.parse(fs.readFileSync(value.output, 'utf8'))).toMatchObject({
      protectedMain: {
        docsOnly: true,
        selectedTests: { status: 'skipped', tests: 0, resultSha256: null },
      },
      releaseImpact: { deployedSha: value.deployedSha, groups: [] },
      selectedGroups: [],
    });
  });

  it('derives the non-bypassable chat gate from cumulative release impact before SSH', () => {
    const value = fixture();
    execFileSync(process.execPath, [
      manifestScript, 'write',
      '--source-sha', value.runtimeSha,
      '--bundle', value.bundle,
      '--artifact-name', `release-bundle-${value.runtimeSha}-${value.digest}`,
      '--protected-run-id', '100',
      '--protected-run-attempt', '1',
      '--checkpoint-run-id', '200',
      '--checkpoint-run-attempt', '1',
      '--release-deployed-sha', value.deployedSha,
      '--release-groups-json', '["release-ops"]',
      '--selection', value.selection,
      '--selected-result', value.selectedResult,
      '--policy-file', value.policy,
      '--shard-results', value.shards,
      '--python-required', 'false',
      '--python-status', 'skipped',
      '--migration-required', 'false',
      '--migration-status', 'skipped',
      '--migration-result', '',
      '--output', value.output,
    ]);

    const fakeBin = path.join(value.root, 'bin');
    const sshCalls = path.join(value.root, 'ssh-calls');
    const transactionId = `20260728T100000Z-${'d'.repeat(12)}`;
    const transaction = JSON.stringify({
      schema: 'nexus.lean-release-transaction.v1',
      role: 'production',
      transactionId,
      runtimeSha: value.runtimeSha,
      artifactDigest: value.digest,
      phase: 'completed',
      status: 'passed',
      predecessorSha: value.deployedSha,
      predecessorDigest: value.deployedDigest,
    });
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(path.join(fakeBin, 'ssh'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${sshCalls}"
case "$*" in
  *"cat /home/dominguez/.local/state/nexus-release/production.json"*)
    printf '%s\\n' '${transaction}'
    ;;
esac
`, { mode: 0o755 });
    const promoteArgs = [
      'scripts/promote-exact-release.sh',
      'ServerDominguez',
      '/home/dominguez/.local/share/nexus-release/incoming/release-fixture',
      value.runtimeSha,
      value.digest,
      transactionId,
      value.output,
      sha256(fs.readFileSync(value.output)),
      value.deployedDigest,
    ];
    const environment = {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      CHAT_EVAL_DB_PATH: path.join(value.root, 'missing-chat-eval.sqlite'),
    };

    const unrelated = spawnSync('bash', promoteArgs, {
      cwd: path.resolve('.'),
      encoding: 'utf8',
      env: environment,
    });
    expect(unrelated.status, unrelated.stderr).toBe(0);
    expect(unrelated.stderr).toContain(
      'cumulative release impact does not include chat-secretary',
    );
    const callsBeforeChat = fs.readFileSync(sshCalls, 'utf8');

    const chatManifest = JSON.parse(fs.readFileSync(value.output, 'utf8'));
    chatManifest.releaseImpact.groups = ['chat-secretary'];
    fs.writeFileSync(value.output, `${JSON.stringify(chatManifest, null, 2)}\n`);
    promoteArgs[7] = sha256(fs.readFileSync(value.output));
    const chat = spawnSync('bash', promoteArgs, {
      cwd: path.resolve('.'),
      encoding: 'utf8',
      env: environment,
    });
    expect(chat.status).toBe(1);
    expect(chat.stderr).toContain('no chat-eval history database');
    expect(fs.readFileSync(sshCalls, 'utf8')).toBe(callsBeforeChat);

    const chatDatabase = environment.CHAT_EVAL_DB_PATH;
    execFileSync(process.execPath, ['-e', `
const {DatabaseSync}=require("node:sqlite");
const [file,sha]=process.argv.slice(1);
const db=new DatabaseSync(file);
db.exec("CREATE TABLE chat_eval_runs (id INTEGER PRIMARY KEY, run_id TEXT, mode TEXT, passed INTEGER, git_commit TEXT, generated_at TEXT, created_at TEXT)");
const insert=db.prepare("INSERT INTO chat_eval_runs (run_id,mode,passed,git_commit,generated_at,created_at) VALUES (?,?,?,?,?,?)");
insert.run("exact-pass","local_engine",1,sha,"2026-07-28T09:00:00Z","2026-07-28T09:00:00Z");
insert.run("other-sha-fail","local_engine",0,"${'e'.repeat(40)}","2026-07-28T09:01:00Z","2026-07-28T09:01:00Z");
db.close();
`, chatDatabase, value.runtimeSha], { cwd: path.resolve('.') });
    const exactPassing = spawnSync('bash', promoteArgs, {
      cwd: path.resolve('.'),
      encoding: 'utf8',
      env: environment,
    });
    expect(exactPassing.status, exactPassing.stderr).toBe(0);
    expect(exactPassing.stderr).toContain('exact-pass passed');

    execFileSync(process.execPath, ['-e', `
const {DatabaseSync}=require("node:sqlite");
const [file,sha]=process.argv.slice(1);
const db=new DatabaseSync(file);
db.prepare("INSERT INTO chat_eval_runs (run_id,mode,passed,git_commit,generated_at,created_at) VALUES (?,?,?,?,?,?)")
  .run("exact-latest-fail","local_engine",0,sha,"2026-07-28T09:02:00Z","2026-07-28T09:02:00Z");
db.close();
`, chatDatabase, value.runtimeSha], { cwd: path.resolve('.') });
    const callsBeforeFailedExact = fs.readFileSync(sshCalls, 'utf8');
    const exactFailing = spawnSync('bash', promoteArgs, {
      cwd: path.resolve('.'),
      encoding: 'utf8',
      env: environment,
    });
    expect(exactFailing.status).toBe(1);
    expect(exactFailing.stderr).toContain('exact-latest-fail');
    expect(exactFailing.stderr).toContain('FAILED');
    expect(fs.readFileSync(sshCalls, 'utf8')).toBe(callsBeforeFailedExact);
  });

  it('waits past a predecessor receipt while preserving poll fail-closed checks', () => {
    const operator = fs.readFileSync('scripts/release-operator.sh', 'utf8');
    const parser = operator.match(
      /poll_remote_transaction\(\) \{[\s\S]*?<<'NODE'\n([\s\S]*?)\nNODE\n\s+then/u,
    )?.[1];
    expect(parser).toBeDefined();

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-release-poll-'));
    roots.push(root);
    const state = path.join(root, 'staging.json');
    const role = 'staging';
    const expectedId = `20260802T010203Z-${'a'.repeat(12)}`;
    const staleId = `20260802T010102Z-${'b'.repeat(12)}`;
    const runtimeSha = 'c'.repeat(40);
    const artifactDigest = 'd'.repeat(64);
    const run = (value: Record<string, unknown>) => {
      fs.writeFileSync(state, JSON.stringify(value));
      return spawnSync(process.execPath, [
        '-', state, role, expectedId, runtimeSha, artifactDigest,
      ], {
        input: parser,
        encoding: 'utf8',
      });
    };
    const valid = {
      schema: 'nexus.lean-release-transaction.v1',
      role,
      transactionId: expectedId,
      runtimeSha,
      artifactDigest,
      status: 'running',
      phase: 'preparing',
    };

    expect(run({
      ...valid,
      transactionId: staleId,
      runtimeSha: 'e'.repeat(40),
      artifactDigest: 'f'.repeat(64),
      status: 'passed',
      phase: 'completed',
    }).status).toBe(4);
    expect(run(valid).status).toBe(3);
    expect(run({ ...valid, runtimeSha: 'e'.repeat(40) }).status).toBe(1);
    expect(run({ ...valid, schema: 'unexpected' }).status).toBe(1);
  });

  it('keeps promotion user-owned while requiring the narrow root backup service', () => {
    const operator = fs.readFileSync('scripts/release-operator.sh', 'utf8');
    const remote = fs.readFileSync('scripts/remote-user-release-transaction.sh', 'utf8');
    const promote = fs.readFileSync('scripts/promote-exact-release.sh', 'utf8');
    const manifestTool = fs.readFileSync('scripts/release-checksum-manifest.mjs', 'utf8');

    expect(operator).toContain('SERVER="${DEPLOY_SERVER:-ServerDominguez}"');
    expect(operator.match(
      /ssh "\$SERVER" cat "\/home\/dominguez\/\.local\/state\/nexus-release\/\$role\.json" > "\$output\.next"/g,
    )).toHaveLength(1);
    expect(operator).toContain(
      "const fs=require('node:fs');\n"
      + "const x=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));\n"
      + 'const [role,id,sha,digest]=process.argv.slice(3);',
    );
    expect(operator).toContain('systemd-run --user');
    expect(operator).toContain(
      '--verify-bundle "$REMOTE_BUNDLE"',
    );
    expect(operator).toContain(
      'REMOTE_QUARANTINE="/home/dominguez/.local/share/nexus-release/incoming/.${RELEASE_NAME}.corrupt-$UPLOAD_ID"',
    );
    expect(operator).toContain('mv -T "$bundle" "$quarantine"');
    expect(operator).toContain('[ "$REMOTE_BUNDLE_REUSED" != true ]');
    expect(promote).toContain('systemd-run --user');
    expect(manifestTool).toContain(
      'FROM chat_eval_runs WHERE mode = ? AND git_commit = ?',
    );
    expect(manifestTool).toContain('ORDER BY created_at DESC, id DESC LIMIT 1');
    expect(manifestTool).toContain(").get('local_engine', manifest.sourceSha)");
    expect(manifestTool).toContain('recordedCommit !== manifest.sourceSha');
    expect(promote).not.toContain('NEXUS_PROMOTE_SKIP_CHAT_EVAL');
    expect(manifestTool).not.toContain('NEXUS_PROMOTE_SKIP_CHAT_EVAL');
    expect(manifestTool).toContain(
      "manifest.releaseImpact.groups.includes('chat-secretary')",
    );
    expect(operator).toContain(
      '"$SERVER" "$REMOTE_BUNDLE" "$RUNTIME_SHA" "$ARTIFACT_DIGEST" "$TRANSACTION_ID" \\\n        "$MANIFEST" "$MANIFEST_SHA256"',
    );
    expect(promote.indexOf('preflight-chat')).toBeLessThan(
      promote.indexOf('ssh "$SERVER" systemd-run --user'),
    );
    const production = operator.indexOf('\n  promote)');
    const operatorGate = operator.indexOf('preflight-chat', production);
    const firstProductionSsh = operator.indexOf('REMOTE_PRODUCTION_STATE="$(ssh', production);
    expect(production).toBeGreaterThan(-1);
    expect(operatorGate).toBeGreaterThan(production);
    expect(operatorGate).toBeLessThan(firstProductionSsh);
    expect(operator.indexOf('validate_checkpoint_run', production)).toBeLessThan(operatorGate);
    expect(operator.indexOf('redownload_and_verify_manifest', production)).toBeLessThan(
      operatorGate,
    );
    expect(operator).toContain('manifestSha256');
    expect(operator).toContain('verify-cache');
    expect(operator).not.toContain('--manifest)');
    const arbitraryManifest = spawnSync('bash', [
      'scripts/release-operator.sh',
      'prepare',
      '--manifest',
      '/tmp/untrusted-release-manifest.json',
    ], { cwd: path.resolve('.'), encoding: 'utf8' });
    expect(arbitraryManifest.status).toBe(64);
    expect(arbitraryManifest.stderr).toContain('unknown release argument: --manifest');
    expect(remote).toContain(
      'sudo -n /usr/bin/systemctl start nexus-local-backup-pre-promotion.service',
    );
    expect(remote).toContain('mv -Tf "$temporary" "$CURRENT_LINK"');
    expect(remote).toContain('restore_predecessor');
    expect(remote).not.toContain('startOrReload');
    expect(remote).not.toContain('"$PM2_BIN" delete');
    expect(remote).not.toContain('local mode=');
    expect(remote).toContain(
      'start_runtime "$PREDECESSOR" "$predecessor_sha" "$predecessor_digest"',
    );
    expect(remote).toContain(
      'pm2_env "$runtime" "$sha" "$digest" delete "${APP_NAMES[@]}"',
    );
    expect(remote).toContain(
      'pm2_env "$runtime" "$sha" "$digest" start \\\n'
      + '    "$runtime/ecosystem.release.config.js" --only "$app_csv"',
    );
    expect(remote.match(/\bdelete "\$\{APP_NAMES\[@\]\}"/g)).toHaveLength(1);
    expect(remote).toContain(
      'PM2 reload commands can update environment variables while retaining the',
    );
    expect(remote).toContain(
      'start_runtime "$RELEASE_DIR" "$RUNTIME_SHA" "$ARTIFACT_DIGEST"',
    );
    expect(remote.indexOf(
      'start_runtime "$RELEASE_DIR" "$RUNTIME_SHA" "$ARTIFACT_DIGEST"',
    )).toBeGreaterThan(remote.indexOf('start_runtime()'));
    expect(remote).toContain('local budget_seconds="${4:-45}"');
    expect(remote).toContain(
      'wait_healthy "$PREDECESSOR" "$predecessor_sha" "$predecessor_digest" \\\n    "$ROLLBACK_HEALTH_BUDGET_SECONDS" allow-missing',
    );
    expect(remote).toContain('rollbackDurationMs');
    expect(remote).toContain('stabilitySeconds:Number(stabilitySeconds)');
    expect(remote).toContain('soakStartedAt:soakStartedAt||null');
    expect(remote).toContain('soakCompletedAt:soakCompletedAt||null');
    expect(remote).toContain(
      '[ "$ROLE" != production ] || [ "$STABILITY_SECONDS" -ge 60 ]',
    );
    expect(remote).toContain('ROLLBACK_OBJECTIVE_SECONDS=120');
    expect(remote).toContain('"$TIMEOUT_BIN" --foreground 30s env -i');
    expect(remote).toContain('"NEXUS_RELEASE_ARTIFACT_SHA256=$3"');
    expect(remote).toContain(
      "observedDigest!==undefined&&observedDigest!==digest",
    );
    expect(operator).toContain('--staging-fault-after-switch');
    expect(operator).toContain('--setenv=NEXUS_RELEASE_FAULT_AFTER_SWITCH=staging-health');
    expect(operator).toContain(
      'irreversible migrations are not promotable through the lean release path',
    );
    expect(operator).toContain("x.faultInjection!=='staging-health'");
    expect(operator).toContain("x.candidateRemoved!==true");
    expect(remote).toContain('die "explicit staging fault drill after runtime switch"');
    expect(remote).toContain('CANDIDATE_REMOVED=true');
    expect(remote).toContain('if ! snapshot="$(curl --fail');
    expect(remote).toContain('rm -f "$header_file"\n    return 1');
    expect(operator).toContain(
      'node scripts/release-checksum-manifest.mjs validate-state \\\n      --manifest "$MANIFEST" \\\n      --state "$PRODUCTION_STATE" \\\n      --role production',
    );
    expect(remote).toContain('MIGRATION_STARTUP=passed');
    expect(remote).toContain('ARTIFACT_PARITY=passed');
    expect(remote).toContain('ROLLBACK_READINESS=passed');
    expect(remote).toContain('predecessorSha:predecessorSha||null');
    expect(remote).toContain('predecessorDigest:predecessorDigest||null');
    expect(remote).toContain(
      '[ "$PREDECESSOR_SHA" = "$EXPECTED_PREDECESSOR_SHA" ]',
    );
    expect(remote).toContain(
      '[ "$PREDECESSOR_DIGEST" = "$EXPECTED_PREDECESSOR_DIGEST" ]',
    );
    expect(remote.indexOf(
      '[ "$PREDECESSOR_SHA" = "$EXPECTED_PREDECESSOR_SHA" ]',
    )).toBeLessThan(remote.indexOf('switch_current "$RELEASE_DIR"'));
    expect(promote).toContain(
      '"$STABILITY_SECONDS" "$EXPECTED_PREDECESSOR_SHA" "$EXPECTED_PREDECESSOR_DIGEST"',
    );
    expect(remote).toContain('read_installed_release_identity');
    expect(remote).toContain('verify_installed_runtime');
    expect(remote).toContain(
      'health_once "$PREDECESSOR" "$PREDECESSOR_SHA" "$PREDECESSOR_DIGEST"',
    );
    expect(remote).toContain(
      '--verify-installed-source "$runtime"',
    );
    expect(remote).toContain(
      '--require-declared-file scripts/release-installed-tree-attestation.mjs',
    );
    expect(remote).toContain(
      '"$runtime/scripts/release-installed-tree-attestation.mjs" validate',
    );
    expect(remote).toContain(
      '"$SOURCE_BUNDLE/scripts/release-runtime-dependencies.mjs" \\\n'
      + '      verify-extracted',
    );
    expect(operator).toContain('--chmod=Du=rwx,Dgo=,Fu=rw,Fgo=');
    expect(operator).toContain(
      'x.message==="transaction stopped before runtime mutation"',
    );
    expect(operator).toContain(
      'EXPECTED_STAGING_PREDECESSOR_SHA="$CANONICAL_DEPLOYED_SHA"',
    );
    expect(operator).toContain(
      'sha=x.runtimeSha;digest=x.artifactDigest',
    );
    expect(operator).toContain(
      'sha=x.predecessorSha;digest=x.predecessorDigest',
    );
    expect(operator).toContain(
      'x.rollbackDurationMs<=x.rollbackObjectiveSeconds*1000',
    );
    expect(remote).toContain('PRE_PROMOTION_BACKUP=passed');
    expect(remote).toContain('authenticated_runtime_smoke');
    expect(remote).toContain(
      '"$NODE_BIN" --env-file="$BASE_DIR/.env" \\\n'
      + '        dist/tools/portal-session-token.js',
    );
    expect(remote).not.toMatch(
      /(?:^|\n)\s*(?:source|\.)\s+["']?\$BASE_DIR\/\.env["']?/,
    );
    expect(remote).toContain('marker.packageVersion');
    expect(remote).toContain(
      '[ "$(readlink -f "$CURRENT_LINK")" = "$RELEASE_DIR" ] || return 1',
    );
    expect(remote).toContain('value.version!==process.argv[1]');
    expect(remote).toContain("database.pragma('integrity_check')");
    expect(remote).toContain("database.pragma('foreign_key_check')");
    expect(remote).not.toMatch(/\bnpm (?:ci|install|run)\b/);
    expect(remote).not.toMatch(/\b(?:pip|venv)\b/);
    expect(remote).not.toMatch(/\bvitest\b/);
    const candidateBudget = Number(
      remote.match(/local budget_seconds="\$\{4:-(\d+)\}"/)?.[1],
    );
    const recoveryBudget = Number(
      remote.match(/ROLLBACK_HEALTH_BUDGET_SECONDS=(\d+)/)?.[1],
    );
    expect(candidateBudget + recoveryBudget).toBeLessThanOrEqual(120);
  });

  it('refuses every first-install entry point before remote release work', () => {
    const remote = path.resolve('scripts/remote-user-release-transaction.sh');
    const remoteResult = spawnSync('bash', [remote], {
      cwd: path.resolve('.'),
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        NEXUS_RELEASE_ALLOW_FIRST_INSTALL: '1',
      },
    });

    expect(remoteResult.status).toBe(1);
    expect(remoteResult.stderr).toContain(
      'first install is unsupported; stage against a verified predecessor',
    );
    expect(remoteResult.stderr).not.toContain('usage:');

    const operatorResult = spawnSync('bash', [
      'scripts/release-operator.sh',
      'prepare',
      '--first-install',
    ], {
      cwd: path.resolve('.'),
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        NEXUS_RELEASE_OWNER_AUTHORIZED: '1',
      },
    });

    expect(operatorResult.status).toBe(64);
    expect(operatorResult.stderr).toContain('unknown release argument: --first-install');

    const transaction = fs.readFileSync(remote, 'utf8');
    const refusal = transaction.indexOf('first install is unsupported');
    expect(refusal).toBeGreaterThan(-1);
    expect(refusal).toBeLessThan(transaction.indexOf('case "$COMMAND"'));
    expect(refusal).toBeLessThan(transaction.indexOf('switch_current()'));
    expect(refusal).toBeLessThan(transaction.indexOf('start_runtime()'));
  });

  it('refuses release mutation while an interrupted chat capability env transaction exists', () => {
    const remote = fs.readFileSync('scripts/remote-user-release-transaction.sh', 'utf8');
    const guardDefinition = remote.indexOf(
      'assert_no_unresolved_chat_capability_transaction() {',
    );
    const guardCall = remote.lastIndexOf(
      '\nassert_no_unresolved_chat_capability_transaction\n',
    );
    const releaseLock = remote.indexOf(
      'flock -n 9 || die "another staging, production, or Sonar-sensitive release action is active"',
    );
    const firstDeploymentWork = remote.indexOf('\nverify_pristine_bundle\n');

    expect(guardDefinition).toBeGreaterThan(-1);
    expect(remote).toContain(
      "-name '.env.before-chat-capability-*' -print -quit",
    );
    expect(remote).toContain(
      'unresolved chat capability transaction blocks release; recover it first',
    );
    expect(guardCall).toBeGreaterThan(releaseLock);
    expect(guardCall).toBeLessThan(firstDeploymentWork);
    expect(guardCall).toBeLessThan(remote.indexOf('cp -a "$SOURCE_BUNDLE/."'));
    expect(guardCall).toBeLessThan(remote.indexOf('switch_current "$RELEASE_DIR"'));
  });

  it('refuses release mutation while a committed capability receipt is unpublished', () => {
    const remote = fs.readFileSync('scripts/remote-user-release-transaction.sh', 'utf8');
    const guardDefinition = remote.indexOf(
      'assert_no_unpublished_chat_capability_receipt() {',
    );
    const guardCall = remote.lastIndexOf(
      '\nassert_no_unpublished_chat_capability_receipt\n',
    );
    const releaseLock = remote.indexOf(
      'flock -n 9 || die "another staging, production, or Sonar-sensitive release action is active"',
    );
    const firstDeploymentWork = remote.indexOf('\nverify_pristine_bundle\n');

    expect(guardDefinition).toBeGreaterThan(-1);
    expect(remote).toContain('*.flag-receipt.json');
    expect(remote).toContain('*.secret-receipt.json');
    expect(remote).toContain(
      'unpublished chat capability receipt blocks release; recover it first',
    );
    expect(guardCall).toBeGreaterThan(releaseLock);
    expect(guardCall).toBeLessThan(firstDeploymentWork);
    expect(guardCall).toBeLessThan(remote.indexOf('cp -a "$SOURCE_BUNDLE/."'));
    expect(guardCall).toBeLessThan(remote.indexOf('switch_current "$RELEASE_DIR"'));
  });

  it('requires every release candidate boundary to start with all seven capabilities off', () => {
    const remote = fs.readFileSync('scripts/remote-user-release-transaction.sh', 'utf8');
    const match = remote.match(
      /assert_release_candidate_chat_capabilities_off\(\) \{[\s\S]*?"\$NODE_BIN" - "\$BASE_DIR\/\.env" <<'NODE'\n([\s\S]*?)\nNODE\n\}/u,
    );
    expect(match).not.toBeNull();
    const parser = match![1];
    const flags = [
      'AI_ROUTING_MANIFEST_CLASSIFIER',
      'AI_ROUTING_MANIFEST_ORCHESTRATOR',
      'AI_ROUTING_MANIFEST_SHADOW',
      'AI_ROUTING_MANIFEST_REGISTRY',
      'AI_ROUTING_CLARIFY',
      'AI_CLASSIFY_MANIFEST_PROMPT',
      'AI_CROSS_SKILL_EXECUTION',
    ];
    const run = (lines: string[]) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-release-flags-'));
      roots.push(root);
      const environment = path.join(root, '.env');
      fs.writeFileSync(environment, `${lines.join('\n')}\n`, { mode: 0o600 });
      return spawnSync(process.execPath, ['-', environment], {
        input: parser,
        encoding: 'utf8',
      });
    };
    const canonical = [...flags.map((flag) => `${flag}=false`), 'AI_ROUTING_MANIFEST_KILL=false'];
    expect(run([]).status).toBe(0);
    expect(run([`${flags[0]}=false`]).status).toBe(0);
    expect(run(canonical).status).toBe(0);
    expect(run(flags.map((flag) => `${flag}=false`)).status).toBe(0);
    expect(run(['AI_ROUTING_MANIFEST_KILL=true']).status).toBe(0);
    expect(run([...canonical.slice(0, -1), 'AI_ROUTING_MANIFEST_KILL=true']).status).toBe(0);
    for (const invalid of [
      [...canonical, `${flags[0]}=false`],
      canonical.map((line, index) => index === 0 ? `${flags[0]}=true` : line),
      canonical.map((line, index) => index === 0 ? `${flags[0]}=yes` : line),
      canonical.map((line, index) => index === 0 ? `export ${flags[0]}=false` : line),
      canonical.map((line, index) => index === 0 ? ` ${flags[0]}=false` : line),
      [...canonical.slice(0, -1), 'AI_ROUTING_MANIFEST_KILL=yes'],
      [...canonical, 'AI_ROUTING_MANIFEST_KILL=false'],
    ]) {
      expect(run(invalid).status).not.toBe(0);
    }

    const guardCall = remote.lastIndexOf('\nassert_release_candidate_chat_capabilities_off\n');
    const releaseLock = remote.indexOf(
      'flock -n 9 || die "another staging, production, or Sonar-sensitive release action is active"',
    );
    expect(guardCall).toBeGreaterThan(releaseLock);
    expect(guardCall).toBeLessThan(remote.indexOf('\nverify_pristine_bundle\n'));
    expect(guardCall).toBeLessThan(remote.indexOf('cp -a "$SOURCE_BUNDLE/."'));
    expect(guardCall).toBeLessThan(remote.indexOf('switch_current "$RELEASE_DIR"'));
    expect(remote).not.toMatch(/assert_release_candidate_chat_capabilities_off[\s\S]*?\$ROLE\s*=/u);
  });

  it('cleans a release lock when the checkout path contains spaces', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus release lock '));
    roots.push(root);
    const gate = path.resolve('scripts/lib/release-gates.sh');
    const result = spawnSync('/bin/bash', [
      '-s',
      '--',
      gate,
      root,
    ], {
      encoding: 'utf8',
      input: [
        'set -euo pipefail',
        'source "$1"',
        'release_acquire_local_lock "$2" release',
        'release_cleanup_all_locks',
        'test ! -e "$2/.local/release/locks/release.lock"',
      ].join('\n'),
    });

    expect(result.status, result.stderr).toBe(0);
  });

  it('cleans an empty release lock set under macOS Bash nounset semantics', () => {
    const gate = path.resolve('scripts/lib/release-gates.sh');
    const result = spawnSync('/bin/bash', [
      '-s',
      '--',
      gate,
    ], {
      encoding: 'utf8',
      input: [
        'set -euo pipefail',
        'source "$1"',
        'release_cleanup_all_locks',
      ].join('\n'),
    });

    expect(result.status, result.stderr).toBe(0);
  });

  it('reads protected release identity under macOS Bash errexit semantics', () => {
    const gate = path.resolve('scripts/lib/release-gates.sh');
    const state = path.resolve('docs/release/release-state.json');
    const result = spawnSync('/bin/bash', [
      '-s',
      '--',
      gate,
      state,
    ], {
      encoding: 'utf8',
      input: [
        'set -euo pipefail',
        'source "$1"',
        'read -r sha digest < <(release_read_deployed_identity "$2")',
        '[[ "$sha" =~ ^[0-9a-f]{40}$ ]]',
        '[[ "$digest" =~ ^[0-9a-f]{64}$ ]]',
      ].join('\n'),
    });

    expect(result.status, result.stderr).toBe(0);
  });

  it('runs only the deterministic remainder across four shards and reuses the main artifact', () => {
    const workflow = fs.readFileSync('.github/workflows/release-candidate-evidence.yml', 'utf8');

    expect(workflow).toContain('matrix:\n        shard: [1, 2, 3, 4]');
    expect(workflow).toContain('node scripts/release-test-remainder.mjs run');
    expect(workflow).toContain("--shard '${{ matrix.shard }}/4'");
    expect(workflow).not.toContain('npm run test:full:sharded');
    expect(workflow).toContain('run-id: ${{ needs.verify-main.outputs.protected_run_id }}');
    expect(workflow).toContain('name: ${{ needs.verify-main.outputs.artifact_name }}');
    expect(workflow).not.toContain('node scripts/release-bundle.mjs');
    expect(workflow).not.toContain('npm run build');
    expect(workflow).not.toContain('sign-release-manifest');
    expect(workflow).toContain('--policy-file config/test-groups.json');
    expect(workflow).toContain('node scripts/changed-area-classifier.mjs');
    expect(workflow).toContain('--base "$DEPLOYED_SHA"');
    expect(workflow).toContain(
      "jq -r '.flags.migration' .local/release/checkpoint/release-impact.json",
    );
    expect(workflow).toContain('release_groups: ${{ steps.impact.outputs.release_groups }}');
    expect(workflow).not.toContain('deployed_sha:\n        description:');
    expect(workflow).not.toContain('inputs.deployed_sha');
    expect(workflow).toContain(
      'deployed="$(node -e \'const x=require("./docs/release/release-state.json");process.stdout.write(x.backend.runtimeSha)\')"',
    );
    expect(workflow).toContain(
      "--release-deployed-sha '${{ needs.verify-main.outputs.deployed_sha }}'",
    );
    expect(workflow).toContain(
      'RELEASE_GROUPS_JSON: ${{ needs.verify-main.outputs.release_groups }}',
    );
    expect(workflow).toContain('--release-groups-json "$RELEASE_GROUPS_JSON"');
    expect(workflow).not.toContain(
      "--release-groups-json '${{ needs.verify-main.outputs.release_groups }}'",
    );
    expect(workflow).toContain('needs.verify-main.outputs.selected_result_artifact');
    expect(workflow).toContain('--selected-result "$selected_result"');
    expect(workflow).toContain("migration_required == 'true'");
    expect(workflow).toContain(
      'pip install -r content-engine/requirements.txt -r content-engine/requirements-dev.txt',
    );
    expect(workflow).toContain(
      'Irreversible migration SQL remains blocked in the lean release path',
    );
    expect(workflow).toContain(
      "test \"$APPROVED_REVIEW_SHA256\" = \"$required\"",
    );
    expect(workflow).toContain(
      "'.authorization.governanceReviewRequired'",
    );
  });

  it('uses one user-owned remote mutex for advisory Sonar and release work', () => {
    const scan = fs.readFileSync('scripts/quality-sonar-scan.sh', 'utf8');
    const remote = fs.readFileSync('scripts/remote-user-release-transaction.sh', 'utf8');

    expect(scan).toContain(
      'mutex="$state/.release.lock"',
    );
    expect(scan).toContain(
      'root_mutex=/run/lock/nexus-release-sonar.lock',
    );
    expect(scan).toContain('flock -n 8 && flock -n 7');
    expect(remote).toContain('LOCK_FILE="$STATE_ROOT/.release.lock"');
    expect(remote).toContain(
      'flock -n 9 || die "another staging, production, or Sonar-sensitive release action is active"',
    );
    expect(remote).toContain('ROOT_SONAR_LOCK=/run/lock/nexus-release-sonar.lock');
    expect(remote).toContain(
      'flock -n 8 || die "a Sonar backup, restore, or root maintenance action is active"',
    );
    expect(remote).toContain(
      'sudo -n "$SONAR_RELEASE_STATE_BIN" --project nexus-hub-backend --json',
    );
    expect(remote).toContain("value.activeTasks !== 0");
    expect(remote).toContain('[ "$old_release" = "$PREDECESSOR" ]');
    expect(remote).toContain('[ "$old_release" = "$CURRENT_TARGET" ]');
    expect(remote).toContain("marker?.schema!=='nexus.release-bundle.v1'");
  });

  it('prepares only the live ServerDominguez layouts and backup database path', () => {
    const installer = fs.readFileSync('scripts/lean-release-server-install.sh', 'utf8');
    const backup = fs.readFileSync('ops/local-backup/backup.env.example', 'utf8');

    expect(() => execFileSync('bash', ['-n', 'scripts/lean-release-server-install.sh']))
      .not.toThrow();
    expect(installer).toContain(
      'validate_and_normalize_base /home/dominguez/telegram-hub-bot',
    );
    expect(installer).toContain(
      'validate_and_normalize_base /home/dominguez/telegram-hub-bot-staging',
    );
    expect(installer).toContain('loginctl enable-linger "$DEPLOY_USER"');
    expect(installer).toContain(
      'chmod 0700 "$base/releases" "$base/data" "$base/logs"',
    );
    expect(installer).not.toContain('/srv/nexus-release');
    expect(backup).toContain(
      'NEXUS_LOCAL_BACKUP_DATABASE_PATH=/home/dominguez/telegram-hub-bot/data/bot.db',
    );
    expect(backup).not.toContain('/srv/nexus-release');
  });

  it('retires only audited legacy release machinery after an exact lean proof', () => {
    const retirement = fs.readFileSync('scripts/retire-legacy-release-machinery.sh', 'utf8');
    const releaseReadme = fs.readFileSync('docs/release/README.md', 'utf8');
    const retirementApply = releaseReadme.match(
      /```bash\nRETIREMENT_IDENTITY=[\s\S]*?\n```/,
    )?.[0] ?? '';

    expect(() => execFileSync('bash', ['-n', 'scripts/retire-legacy-release-machinery.sh']))
      .not.toThrow();
    expect(retirement).toContain('MODE=dry-run');
    expect(retirement).toContain('NEXUS_RELEASE_OWNER_AUTHORIZED');
    expect(retirement).toContain('--apply --confirm <sha>:<digest>');
    expect(retirement).toContain(
      'STATE_FILE=/home/dominguez/.local/state/nexus-release/production.json',
    );
    expect(retirement).toContain("prePromotionBackup:'passed'");
    expect(retirement).toContain('state.releaseDir!==currentTarget');
    expect(retirement).toContain(
      '"$SYSTEMCTL_BIN" is-active --quiet "$CANONICAL_PM2_UNIT"',
    );
    expect(retirement).toContain(
      '"$SYSTEMCTL_BIN" is-active --quiet "$TEMPORARY_PM2_UNIT"',
    );
    expect(retirement).toContain(
      'USER_RELEASE_LOCK=/home/dominguez/.local/state/nexus-release/.release.lock',
    );
    expect(retirement).toContain(
      'ROOT_SONAR_LOCK=/run/lock/nexus-release-sonar.lock',
    );
    expect(retirement).toContain('assert_detached_systemd_transaction');
    expect(retirement).toContain('assert_canonical_pm2_unit_ready');
    expect(retirement).toContain('handoff_pm2_authority');
    expect(retirement).toContain('/etc/systemd/system/pm2-dominguez.service.d/');
    expect(retirement).toContain('/usr/local/sbin/nexus-release-promotion-control');
    expect(retirement).toContain('/var/lib/nexus-release-promotion');
    expect(retirement).not.toContain('/var/lib/nexus-application-dr');
    expect(retirement).not.toContain('/etc/nexus-application-dr');
    expect(retirement).not.toMatch(/LEGACY_STATE=\([^)]*\/var\/lib\/nexus-release\s/m);
    expect(retirement).not.toContain('ollama rm');
    expect(retirement).not.toContain('docker compose');
    expect(retirementApply).toContain('sudo /usr/bin/systemd-run');
    expect(retirementApply).toContain('--no-block');
    expect(retirementApply).toContain('--property=RemainAfterExit=yes');
    expect(retirementApply).toContain('sudo /usr/bin/systemctl show');
    expect(retirementApply).toContain('sudo /usr/bin/journalctl');
    expect(retirementApply).toContain('set -euo pipefail');
    expect(retirementApply).toContain('RETIREMENT_TERMINAL=false');
    expect(retirementApply).toContain(
      'if [ "$RETIREMENT_TERMINAL" != true ]; then',
    );
    expect(retirementApply.indexOf('RETIREMENT_TERMINAL=false')).toBeLessThan(
      retirementApply.indexOf('sudo /usr/bin/systemctl stop'),
    );
    expect(retirementApply.indexOf('property=ExecMainStatus --value)" = 0')).toBeLessThan(
      retirementApply.indexOf('sudo /usr/bin/systemctl stop'),
    );
    expect(retirementApply).not.toContain('--wait');
    expect(retirementApply).not.toContain('--pipe');
    expect(releaseReadme).not.toContain(
      'sudo /usr/bin/env NEXUS_RELEASE_OWNER_AUTHORIZED=1',
    );
  });
});
