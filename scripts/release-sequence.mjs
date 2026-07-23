#!/usr/bin/env node
// Resumable local coordinator for the canonical exact-artifact release path.
// It never grants production authorization and never promotes without two
// explicit, contemporaneous owner signals.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const args = process.argv.slice(2);
const value = (name, fallback = '') => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1] || fallback;
};
const has = (name) => args.includes(name);
const root = path.resolve(value('--root', path.join(import.meta.dirname, '..')));

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

for (let index = 0; index < args.length; index += 1) {
  const argument = args[index];
  const withValue = new Set([
    '--root', '--checkpoint', '--rc-run', '--manifest', '--staging-attestation',
    '--ios-attestation', '--ios-distribution-attestation',
  ]);
  const flags = new Set(['--backend-only', '--includes-ios', '--owner-authorized', '--promote', '--status']);
  if (withValue.has(argument)) {
    if (!args[index + 1] || args[index + 1].startsWith('--')) fail(`missing value for ${argument}`, 64);
    index += 1;
  } else if (!flags.has(argument)) {
    fail(`unknown release resume argument: ${argument}`, 64);
  }
}

function run(command, commandArgs, options = {}) {
  return spawnSync(command, commandArgs, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
}

function required(command, commandArgs, label) {
  const result = run(command, commandArgs);
  if (result.error || result.status !== 0) {
    if (result.stderr) process.stderr.write(result.stderr);
    fail(`${label} failed`, result.status || 1);
  }
  return result.stdout.trim();
}

const runtimeSha = required('git', ['rev-parse', 'HEAD'], 'release worktree identity');
if (!/^[a-f0-9]{40}$/u.test(runtimeSha)) fail('release resume runtime SHA is invalid', 1);
const branch = required('git', ['branch', '--show-current'], 'release branch identity');
if (branch !== 'main') fail('release resume requires the checked-out protected main branch');
const dirty = required('git', ['status', '--porcelain=v1', '--untracked-files=all'], 'release clean-tree check');
if (dirty) fail('release resume requires a clean exact origin/main checkout');
required('git', ['fetch', '--quiet', 'origin', 'main'], 'origin/main fetch');
const originMainSha = required('git', ['rev-parse', 'origin/main^{commit}'], 'origin/main identity');
if (originMainSha !== runtimeSha) fail('release resume HEAD must equal the freshly fetched origin/main');

let packageJson;
try { packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); } catch {
  fail('release resume package.json is missing or invalid');
}
const packageVersion = String(packageJson.version || '');
if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u.test(packageVersion)) {
  fail('release resume package version is invalid');
}
const originPackage = JSON.parse(required('git', ['show', 'origin/main:package.json'], 'origin/main package identity'));
if (originPackage.version !== packageVersion) fail('release resume package version differs from origin/main');

const localRoot = path.join(root, '.local', 'release');
const checkpointPath = path.resolve(value(
  '--checkpoint',
  path.join(localRoot, 'checkpoints', `${runtimeSha}.json`),
));
const checkpointRelative = path.relative(localRoot, checkpointPath);
if (checkpointRelative.startsWith('..') || path.isAbsolute(checkpointRelative)) {
  fail('release checkpoint must stay under .local/release', 64);
}
const checkpointDirectory = path.dirname(checkpointPath);
fs.mkdirSync(checkpointDirectory, { recursive: true, mode: 0o700 });
function fsyncDirectory(directory) {
  const descriptor = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}
let durableDirectory = checkpointDirectory;
while (true) {
  fsyncDirectory(durableDirectory);
  if (durableDirectory === root) break;
  const parent = path.dirname(durableDirectory);
  const parentRelative = path.relative(root, parent);
  if (parent === durableDirectory || parentRelative.startsWith('..')
    || path.isAbsolute(parentRelative)) {
    fail('release checkpoint directory ancestry is invalid', 64);
  }
  durableDirectory = parent;
}

const lockPath = `${checkpointPath}.lock`;
let lockHeld = false;
function acquireLock() {
  try {
    fs.mkdirSync(lockPath, { mode: 0o700 });
    fs.writeFileSync(path.join(lockPath, 'owner.json'), `${JSON.stringify({
      pid: process.pid,
      host: os.hostname(),
      createdAt: new Date().toISOString(),
    })}\n`, { mode: 0o600, flag: 'wx' });
    lockHeld = true;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    let owner = null;
    try { owner = JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8')); } catch {}
    const sameHost = owner?.host === os.hostname();
    let alive = false;
    if (sameHost && Number.isInteger(owner?.pid) && owner.pid > 1) {
      try { process.kill(owner.pid, 0); alive = true; } catch {}
    }
    const createdMs = Date.parse(owner?.createdAt || '');
    const stale = sameHost
      ? !alive
      : !Number.isFinite(createdMs) || Date.now() - createdMs > 60 * 60 * 1000;
    if (!stale) fail('another release resume process owns this checkpoint', 73);
    fs.rmSync(lockPath, { recursive: true, force: true });
    acquireLock();
  }
}
function releaseLock() {
  if (lockHeld) fs.rmSync(lockPath, { recursive: true, force: true });
  lockHeld = false;
}
process.on('exit', releaseLock);
process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));
acquireLock();

function readCheckpoint() {
  if (!fs.existsSync(checkpointPath)) return null;
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(checkpointPath, 'utf8')); } catch { fail('release checkpoint is invalid JSON'); }
  if (parsed?.schema !== 'nexus.release-sequence-checkpoint.v1') fail('release checkpoint schema is invalid');
  if (parsed.runtimeSha !== runtimeSha) fail('release checkpoint runtime identity mismatch');
  return parsed;
}

function writeCheckpoint(state) {
  const temporary = `${checkpointPath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const next = { ...state, updatedAt: new Date().toISOString() };
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
    const descriptor = fs.openSync(temporary, 'r');
    try {
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(temporary, checkpointPath);
    fsyncDirectory(checkpointDirectory);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return next;
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function productionEvidenceMatches(production, expected) {
  const digest = (input) => /^[a-f0-9]{64}$/u.test(input || '');
  const timestamp = (input) => Number.isFinite(Date.parse(input || ''));
  const safeKey = (input) => typeof input === 'string' && input.length > 0
    && input.length <= 1024 && !input.includes('..') && !input.includes('//');
  const controls = production?.drStorageControls;
  const aws = controls?.provider === 'aws-s3' && controls?.controlMode === 'versioned-s3';
  const r2 = controls?.provider === 'cloudflare-r2'
    && controls?.controlMode === 'r2-approved-variance';
  if (!aws && !r2) return false;
  if (controls?.releasePrefixLockVerified !== true) return false;

  const version = (input) => /^[A-Za-z0-9._~+=:/-]{1,1024}$/u.test(input || '');
  const retainedObject = (item) => {
    const confirmed = Date.parse(item?.confirmedAt || '');
    if (!Number.isFinite(confirmed) || item?.provider !== controls.provider
        || !safeKey(item?.objectKey) || !digest(item?.encryptedSha256)
        || !Number.isSafeInteger(item?.encryptedSizeBytes) || item.encryptedSizeBytes <= 0) {
      return false;
    }
    if (aws) {
      const retained = Date.parse(item?.retainUntil || '');
      return version(item?.objectVersionId)
        && Number.isFinite(retained) && retained >= confirmed + 90 * 86_400_000;
    }
    return item?.objectVersionId === null && item?.retainUntil === null;
  };
  const databaseObject = (item) => {
    if (item?.status !== 'passed' || item?.provider !== controls.provider
        || !safeKey(item?.objectKey)
        || !/\/database\/hourly\/nexus-db-\d{8}T\d{6}Z\.sqlite\.age$/u.test(item.objectKey)
        || !digest(item?.plaintextSha256) || !digest(item?.encryptedSha256)
        || !Number.isSafeInteger(item?.encryptedSizeBytes) || item.encryptedSizeBytes <= 0
        || !timestamp(item?.confirmedAt)) return false;
    return aws
      ? version(item?.objectVersionId)
        && item?.retentionVariance === null
        && item?.approvedUnversionedVariance === false
      : item?.objectVersionId === null
        && item?.retentionVariance === 'r2-approved-variance'
        && item?.approvedUnversionedVariance === true;
  };
  const recoveryObject = (item, phase) => item?.status === 'passed'
    && item?.escrowId === production.transactionId
    && item?.escrowPhase === phase
    && item?.runtimeSha === expected.runtimeSha
    && item?.artifactDigest === expected.artifactDigest
    && item?.installedRuntimeDigest === expected.installedRuntimeDigest
    && item?.recoveryRuntimeDigest === expected.recoveryRuntimeDigest
    && digest(item?.plaintextSha256)
    && safeKey(item?.objectKey)
    && item.objectKey.endsWith(
      `+escrow-${production.transactionId}+phase-${phase}.tar.gz.${item.plaintextSha256}.age`,
    )
    && item?.evidenceSha256 === production.rollbackEscrow?.evidenceSha256
    && retainedObject(item);
  const readiness = (item) => item?.schema === 'nexus.candidate-readiness-refresh.v1'
    && item?.status === 'passed'
    && item?.transactionId === production.transactionId
    && item?.runtimeSha === expected.runtimeSha
    && item?.packageVersion === expected.packageVersion
    && timestamp(item?.verifiedAt)
    && Object.keys(item?.checks || {}).sort().join(',')
      === 'authenticatedSnapshot,contentEngine,loopbackBackend,pm2Identity,publicHealth'
    && Object.values(item.checks).every((check) => check === true);

  const rollback = production?.rollbackEscrow;
  const beforeRecovery = production?.preMutationCurrentRecoveryEscrow;
  const currentRecovery = production?.currentRecoveryEscrow;
  const beforeDatabase = production?.preMutationDatabaseRecoveryPoint;
  const currentDatabase = production?.currentDatabaseRecoveryPoint;
  const beforeReadiness = production?.candidateReadinessRefresh?.beforeEscrow;
  const afterReadiness = production?.candidateReadinessRefresh?.afterEscrow;
  if (production?.schema !== 'nexus.production-promotion-evidence.v1'
      || production?.status !== 'passed'
      || production?.runtimeSha !== expected.runtimeSha
      || production?.artifactDigest !== expected.artifactDigest
      || production?.installedRuntimeDigest !== expected.installedRuntimeDigest
      || production?.recoveryRuntimeDigest !== expected.recoveryRuntimeDigest
      || production?.releaseManifestSha256 !== expected.releaseManifestSha256
      || production?.stagingAttestationSha256 !== expected.stagingAttestationSha256
      || production?.packageVersion !== expected.packageVersion
      || production?.sentryRelease !== expected.runtimeSha
      || production?.transactionMode !== 'systemd_oneshot'
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/u.test(production?.transactionId || '')
      || !digest(production?.backupSha256)
      || typeof production?.exactBackup !== 'string'
      || !production.exactBackup.endsWith('.tar.gz')
      || rollback?.status !== 'passed'
      || rollback?.provider !== controls.provider
      || rollback?.objectKey?.endsWith(`.${production.backupSha256}.age`) !== true
      || !digest(rollback?.evidenceSha256)
      || !retainedObject(rollback)
      || !recoveryObject(beforeRecovery, 'pre-mutation')
      || !recoveryObject(currentRecovery, 'post-soak')
      || beforeRecovery.plaintextSha256 !== currentRecovery.plaintextSha256
      || beforeRecovery.objectKey === currentRecovery.objectKey
      || beforeRecovery.encryptedSha256 === currentRecovery.encryptedSha256
      || (aws && beforeRecovery.objectVersionId === currentRecovery.objectVersionId)
      || !databaseObject(beforeDatabase) || !databaseObject(currentDatabase)
      || beforeDatabase.encryptedSha256 === currentDatabase.encryptedSha256
      || (aws && beforeDatabase.objectKey === currentDatabase.objectKey
        && beforeDatabase.objectVersionId === currentDatabase.objectVersionId)
      || !readiness(beforeReadiness) || !readiness(afterReadiness)) {
    return false;
  }

  const times = {
    started: Date.parse(production.startedAt),
    unavailable: Date.parse(production.serviceUnavailableStartedAt),
    soak: Date.parse(production.soakCompletedAt),
    beforeRecovery: Date.parse(beforeRecovery.confirmedAt),
    currentRecovery: Date.parse(currentRecovery.confirmedAt),
    beforeDatabase: Date.parse(beforeDatabase.confirmedAt),
    currentDatabase: Date.parse(currentDatabase.confirmedAt),
    rollback: Date.parse(rollback.confirmedAt),
    beforeReadiness: Date.parse(beforeReadiness.verifiedAt),
    afterReadiness: Date.parse(afterReadiness.verifiedAt),
    dr: Date.parse(production.drEscrowConfirmedAt),
    completed: Date.parse(production.completedAt),
  };
  if (!Object.values(times).every(Number.isFinite)
      || times.beforeRecovery > times.started || times.beforeRecovery > times.unavailable
      || times.beforeDatabase > times.started || times.beforeDatabase > times.unavailable
      || times.currentRecovery < times.soak || times.currentDatabase < times.soak
      || times.beforeReadiness < times.soak
      || times.rollback < times.beforeReadiness
      || times.currentRecovery < times.beforeReadiness
      || times.currentDatabase < times.beforeReadiness
      || times.afterReadiness < Math.max(
        times.beforeReadiness, times.rollback, times.currentRecovery, times.currentDatabase,
      )
      || times.dr !== Math.max(times.rollback, times.currentRecovery, times.currentDatabase)
      || production.completedAt !== afterReadiness.verifiedAt
      || times.completed !== times.afterReadiness) return false;

  const afterChecks = afterReadiness.checks;
  return production?.verification?.loopbackBackend === afterChecks.loopbackBackend
    && production?.verification?.contentEngineHealth === afterChecks.contentEngine
    && production?.verification?.authenticatedContentEngine === afterChecks.authenticatedSnapshot
    && production?.verification?.pm2AndCurrentIdentity === afterChecks.pm2Identity
    && production?.verification?.publicHealth?.status
      === (afterChecks.publicHealth ? 'healthy' : 'failed')
    && production?.verification?.publicHealth?.database
      === (afterChecks.publicHealth ? 'connected' : 'unknown')
    && production?.verification?.publicSnapshotVersion
      === (afterChecks.authenticatedSnapshot ? expected.packageVersion : null);
}

function ghJson(commandArgs, label) {
  const raw = required('gh', commandArgs, label);
  try { return JSON.parse(raw); } catch { fail(`${label} returned invalid JSON`); }
}

function validateProtectedRepository() {
  const repository = ghJson(['repo', 'view', '--json', 'nameWithOwner'], 'GitHub repository identity');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository.nameWithOwner || '')) {
    fail('GitHub repository identity is invalid');
  }
  const protection = ghJson(['api', `repos/${repository.nameWithOwner}/branches/main`], 'protected main lookup');
  if (protection.protected !== true || protection.name !== 'main') {
    fail('origin/main is not protected according to GitHub');
  }
  return repository.nameWithOwner;
}

function validateWorkflowRun(runId, { workflowName, requireCodeql = false } = {}) {
  const runView = ghJson(['run', 'view', String(runId), '--json',
    'databaseId,headSha,headBranch,event,status,conclusion,workflowName,url,jobs'], `GitHub workflow run ${runId}`);
  if (String(runView.databaseId) !== String(runId) || runView.headSha !== runtimeSha
      || runView.headBranch !== 'main' || runView.event !== (requireCodeql ? 'push' : 'workflow_dispatch')
      || runView.status !== 'completed' || runView.conclusion !== 'success'
      || runView.workflowName !== workflowName) {
    fail(`GitHub workflow run ${runId} is not a successful exact origin/main run`);
  }
  let codeqlJob = null;
  if (requireCodeql) {
    codeqlJob = (runView.jobs || []).find((job) => job.name === 'CodeQL JavaScript/TypeScript');
    if (!codeqlJob || codeqlJob.status !== 'completed' || codeqlJob.conclusion !== 'success') {
      fail('exact origin/main CodeQL job is missing or failed');
    }
    if (!/^\d+$/u.test(String(codeqlJob.databaseId || codeqlJob.id || ''))) {
      fail('exact origin/main CodeQL job identity is invalid');
    }
  }
  return { runView, codeqlJob };
}

function existingSecurityEvidence() {
  const runs = ghJson(['run', 'list', '--workflow', 'security.yml', '--branch', 'main', '--event', 'push',
    '--limit', '50', '--json', 'databaseId,headSha,status,conclusion,createdAt'], 'security workflow lookup');
  const exact = runs.find((candidate) => candidate.headSha === runtimeSha
    && candidate.status === 'completed' && candidate.conclusion === 'success');
  if (!exact) fail('successful security.yml evidence for exact origin/main is missing');
  const { runView, codeqlJob } = validateWorkflowRun(exact.databaseId, {
    workflowName: 'Security — supply chain and static analysis',
    requireCodeql: true,
  });
  return {
    workflow: 'security.yml',
    workflowSha256: sha256File(path.join(root, '.github', 'workflows', 'security.yml')),
    runId: String(runView.databaseId),
    runUrl: runView.url,
    headSha: runView.headSha,
    codeqlJobId: String(codeqlJob.databaseId || codeqlJob.id || ''),
    codeqlConclusion: codeqlJob.conclusion,
  };
}

function revalidateCheckpointTrust(state) {
  const repository = validateProtectedRepository();
  if (repository !== state.repository || repository !== state.sourceIntent?.repository) {
    fail('release checkpoint repository identity no longer matches protected main', 64);
  }

  const recorded = state.workflows?.security;
  const workflowSha256 = sha256File(path.join(root, '.github', 'workflows', 'security.yml'));
  if (recorded?.workflow !== 'security.yml'
      || !/^[0-9]+$/u.test(String(recorded.runId || ''))
      || !/^[0-9]+$/u.test(String(recorded.codeqlJobId || ''))
      || recorded.headSha !== runtimeSha
      || recorded.codeqlConclusion !== 'success'
      || recorded.workflowSha256 !== workflowSha256
      || typeof recorded.runUrl !== 'string'
      || recorded.runUrl.length === 0) {
    fail('release checkpoint security evidence identity is invalid', 64);
  }

  const { runView, codeqlJob } = validateWorkflowRun(recorded.runId, {
    workflowName: 'Security — supply chain and static analysis',
    requireCodeql: true,
  });
  const codeqlJobId = String(codeqlJob.databaseId || codeqlJob.id || '');
  if (String(runView.databaseId) !== String(recorded.runId)
      || runView.headSha !== recorded.headSha
      || runView.url !== recorded.runUrl
      || codeqlJobId !== String(recorded.codeqlJobId)
      || codeqlJob.conclusion !== recorded.codeqlConclusion) {
    fail('release checkpoint CodeQL evidence no longer matches the exact stored run and job', 64);
  }

  if (state.phase === 'promoted') {
    const identity = state.productionEvidenceIdentity;
    const expectedPath = path.join(
      root,
      '.local',
      'release',
      'production',
      `${runtimeSha}-${state.artifactDigest}.json`,
    );
    let production;
    try {
      if (path.resolve(identity?.path || '') !== expectedPath
          || !fs.lstatSync(expectedPath).isFile()
          || fs.lstatSync(expectedPath).isSymbolicLink()
          || sha256File(expectedPath) !== identity?.sha256) {
        fail('production promotion evidence identity drifted after it was checkpointed');
      }
      production = JSON.parse(fs.readFileSync(expectedPath, 'utf8'));
    } catch {
      fail('production promotion evidence identity drifted after it was checkpointed');
    }
    if (!productionEvidenceMatches(production, {
      runtimeSha,
      artifactDigest: identity.artifactDigest,
      installedRuntimeDigest: identity.installedRuntimeDigest,
      recoveryRuntimeDigest: identity.recoveryRuntimeDigest,
      releaseManifestSha256: identity.releaseManifestSha256,
      stagingAttestationSha256: identity.stagingAttestationSha256,
      packageVersion: state.packageVersion,
    })) {
      fail('production promotion evidence no longer proves the exact checkpoint identity');
    }
  }
}

function releaseCandidateDispatchArgs(scope, iosEvidence) {
  const dispatchArgs = ['workflow', 'run', 'release-candidate-evidence.yml', '--ref', 'main',
    '-f', `contract_scope=${scope}`, '-f', 'force_full=false'];
  if (scope === 'shared_backend_ios') {
    let attestation;
    try { attestation = JSON.parse(fs.readFileSync(iosEvidence.compatibilityPath, 'utf8')); } catch {
      fail('iOS compatibility attestation is missing or invalid');
    }
    const iosSha = attestation?.payload?.ios?.sha;
    const iosBuildNumber = String(attestation?.payload?.ios?.buildNumber || '');
    if (!/^[a-f0-9]{40}$/u.test(iosSha || '') || !/^[1-9][0-9]*$/u.test(iosBuildNumber)) {
      fail('iOS compatibility attestation source identity is invalid');
    }
    dispatchArgs.push('-f', `ios_sha=${iosSha}`, '-f', `ios_build_number=${iosBuildNumber}`, '-f', 'ios_contract_result=passed');
  }
  return dispatchArgs;
}

function releaseCandidateRuns() {
  return ghJson(['run', 'list', '--workflow', 'release-candidate-evidence.yml', '--branch', 'main',
    '--event', 'workflow_dispatch', '--limit', '50', '--json',
    'databaseId,headSha,status,conclusion,createdAt'], 'release-candidate workflow lookup');
}

function correlatedReleaseCandidate(intent) {
  const baseline = new Set((intent.baselineRunIds || []).map(String));
  const notBefore = Date.parse(intent.candidateNotBefore || '');
  if (!Number.isFinite(notBefore)) fail('release-candidate dispatch intent timestamp is invalid');
  const candidates = releaseCandidateRuns().filter((candidate) => {
    const createdAt = Date.parse(candidate.createdAt || '');
    return candidate.headSha === runtimeSha
      && !baseline.has(String(candidate.databaseId))
      && Number.isFinite(createdAt)
      && createdAt >= notBefore;
  });
  if (candidates.length > 1) {
    fail('release-candidate dispatch correlation is ambiguous; refusing to select a run');
  }
  return candidates[0] || null;
}

function publicState(state, extra = {}) {
  return {
    ok: state.phase === 'promoted',
    schema: state.schema,
    runtimeSha: state.runtimeSha,
    packageVersion: state.packageVersion,
    rcRunId: state.rcRunId,
    workflows: state.workflows,
    contractScope: state.contractScope,
    phase: state.phase,
    nextAction: state.nextAction,
    checkpoint: path.relative(root, checkpointPath),
    ...extra,
  };
}

function emit(state, extra = {}, code = 0) {
  process.stdout.write(`${JSON.stringify(publicState(state, extra), null, 2)}\n`);
  process.exit(code);
}

function runStep(state, label, command, commandArgs, env = process.env) {
  const attempt = {
    step: label,
    startedAt: new Date().toISOString(),
    commandSha256: crypto.createHash('sha256').update(JSON.stringify([command, commandArgs])).digest('hex'),
  };
  state = writeCheckpoint({
    ...state,
    inProgressStep: label,
    lastError: null,
    attempts: [...(state.attempts || []), attempt],
  });
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    encoding: 'utf8',
    env,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.stdout) process.stderr.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error || result.status !== 0) {
    const attempts = [...state.attempts];
    attempts[attempts.length - 1] = {
      ...attempts.at(-1), completedAt: new Date().toISOString(), status: result.status ?? 1,
      stdoutSha256: crypto.createHash('sha256').update(result.stdout || '').digest('hex'),
      stderrSha256: crypto.createHash('sha256').update(result.stderr || '').digest('hex'),
    };
    writeCheckpoint({
      ...state,
      attempts,
      inProgressStep: null,
      lastError: { step: label, status: result.status ?? 1, failedAt: new Date().toISOString() },
      nextAction: `retry_${label}`,
    });
    fail(`release resume step failed: ${label}`, result.status || 1);
  }
  const attempts = [...state.attempts];
  attempts[attempts.length - 1] = {
    ...attempts.at(-1), completedAt: new Date().toISOString(), status: 0,
    stdoutSha256: crypto.createHash('sha256').update(result.stdout || '').digest('hex'),
    stderrSha256: crypto.createHash('sha256').update(result.stderr || '').digest('hex'),
  };
  return writeCheckpoint({ ...state, attempts, inProgressStep: null, lastError: null });
}

function dispatchCommandDigest(commandArgs) {
  return crypto.createHash('sha256').update(JSON.stringify(['gh', commandArgs])).digest('hex');
}

function runReleaseCandidateDispatch(state, commandArgs) {
  const label = 'dispatch_release_candidate';
  const attempt = {
    step: label,
    startedAt: new Date().toISOString(),
    commandSha256: dispatchCommandDigest(commandArgs),
  };
  state = writeCheckpoint({
    ...state,
    inProgressStep: label,
    lastError: null,
    attempts: [...(state.attempts || []), attempt],
  });
  const result = run('gh', commandArgs);
  if (result.stdout) process.stderr.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  const attempts = [...state.attempts];
  attempts[attempts.length - 1] = {
    ...attempts.at(-1),
    completedAt: new Date().toISOString(),
    status: result.status ?? 1,
    stdoutSha256: crypto.createHash('sha256').update(result.stdout || '').digest('hex'),
    stderrSha256: crypto.createHash('sha256').update(result.stderr || '').digest('hex'),
  };
  if (result.error || result.status !== 0) {
    writeCheckpoint({
      ...state,
      attempts,
      inProgressStep: null,
      lastError: { step: label, status: result.status ?? 1, failedAt: new Date().toISOString() },
      nextAction: 'reconcile_dispatched_rc_without_redispatch',
    });
    fail('release-candidate dispatch outcome is uncertain; resume will reconcile without redispatch', result.status || 1);
  }
  return writeCheckpoint({
    ...state,
    attempts,
    inProgressStep: null,
    lastError: null,
    nextAction: 'identify_dispatched_release_candidate',
    rcDispatch: {
      ...state.rcDispatch,
      status: 'dispatch_accepted',
      dispatchAcceptedAt: new Date().toISOString(),
    },
  });
}

function continueReleaseCandidate(state) {
  const intent = state.rcDispatch;
  const dispatchArgs = releaseCandidateDispatchArgs(state.contractScope, state.iosEvidence);
  const workflowSha256 = sha256File(path.join(root, '.github', 'workflows', 'release-candidate-evidence.yml'));
  if (intent?.schema !== 'nexus.release-candidate-dispatch-intent.v1'
      || intent.workflow !== 'release-candidate-evidence.yml'
      || intent.workflowSha256 !== workflowSha256
      || intent.headSha !== runtimeSha
      || intent.contractScope !== state.contractScope
      || intent.commandSha256 !== dispatchCommandDigest(dispatchArgs)
      || !/^[0-9a-f-]{36}$/u.test(intent.correlationNonce || '')
      || !Array.isArray(intent.baselineRunIds)) {
    fail('release-candidate dispatch intent identity mismatch', 64);
  }
  if (state.rcDispatch?.status === 'completed') {
    if (!/^[0-9]+$/u.test(state.rcRunId || '')
        || state.workflows?.releaseCandidate?.runId !== state.rcRunId
        || state.rcDispatch?.runId !== state.rcRunId) {
      fail('completed release-candidate checkpoint identity is invalid', 64);
    }
    return state;
  }

  if (!state.rcRunId) {
    if (intent.status === 'intent_persisted') {
      state = writeCheckpoint({
        ...state,
        phase: 'rc_dispatch_started',
        nextAction: 'dispatch_release_candidate_once',
        rcDispatch: {
          ...intent,
          status: 'dispatch_started',
          dispatchStartedAt: new Date().toISOString(),
        },
      });
      state = runReleaseCandidateDispatch(state, dispatchArgs);
    } else if (!['dispatch_started', 'dispatch_accepted'].includes(intent.status)) {
      fail('release-candidate dispatch state is invalid', 64);
    }

    let candidate = null;
    for (let attempt = 0; attempt < 30 && !candidate; attempt += 1) {
      candidate = correlatedReleaseCandidate(state.rcDispatch);
      if (!candidate && attempt < 29) spawnSync('sleep', ['2']);
    }
    if (!candidate || !/^[0-9]+$/u.test(String(candidate.databaseId || ''))) {
      writeCheckpoint({
        ...state,
        nextAction: 'manual_rc_dispatch_reconciliation_required',
        lastError: {
          step: 'identify_dispatched_release_candidate',
          failedAt: new Date().toISOString(),
          reason: 'no_unique_correlated_run',
        },
      });
      fail('dispatched release-candidate workflow run was not uniquely found; refusing automatic redispatch');
    }
    const runId = String(candidate.databaseId);
    state = writeCheckpoint({
      ...state,
      rcRunId: runId,
      phase: 'rc_run_identified',
      nextAction: 'watch_identified_release_candidate',
      lastError: null,
      rcDispatch: {
        ...state.rcDispatch,
        status: 'run_identified',
        runId,
        runCreatedAt: candidate.createdAt,
        identifiedAt: new Date().toISOString(),
      },
      workflows: {
        ...state.workflows,
        releaseCandidate: {
          workflow: 'release-candidate-evidence.yml',
          workflowSha256,
          runId,
          headSha: runtimeSha,
          correlationNonce: state.rcDispatch.correlationNonce,
          runCreatedAt: candidate.createdAt,
        },
      },
    });
  } else if (state.rcDispatch?.runId !== state.rcRunId
      || state.workflows?.releaseCandidate?.runId !== state.rcRunId) {
    fail('release-candidate run identity differs from its persisted dispatch intent', 64);
  }

  state = runStep(state, 'watch_release_candidate', 'gh', [
    'run', 'watch', state.rcRunId, '--exit-status',
  ]);
  const { runView } = validateWorkflowRun(state.rcRunId, { workflowName: 'RC — Release Evidence' });
  return writeCheckpoint({
    ...state,
    phase: 'rc_complete',
    nextAction: 'request_trusted_signing',
    rcDispatch: {
      ...state.rcDispatch,
      status: 'completed',
      completedAt: new Date().toISOString(),
    },
    workflows: {
      ...state.workflows,
      releaseCandidate: {
        ...state.workflows.releaseCandidate,
        runUrl: runView.url,
        headSha: runView.headSha,
        conclusion: runView.conclusion,
      },
    },
  });
}

const suppliedScope = has('--backend-only') ? 'backend_only' : has('--includes-ios') ? 'shared_backend_ios' : '';
if (has('--backend-only') && has('--includes-ios')) fail('release contract scope may be specified only once', 64);
const suppliedRcRun = value('--rc-run');
if (suppliedRcRun && !/^[0-9]+$/u.test(suppliedRcRun)) fail('release RC run id is invalid', 64);

let state = readCheckpoint();
if (!state) {
  if (suppliedRcRun) fail('a new release sequence dispatches its own RC; --rc-run is resume-only', 64);
  if (!suppliedScope) fail('first release resume requires --backend-only or --includes-ios', 64);
  const iosAttestation = value('--ios-attestation');
  const iosDistributionAttestation = value('--ios-distribution-attestation');
  if (suppliedScope === 'shared_backend_ios' && (!iosAttestation || !iosDistributionAttestation)) {
    fail('shared release resume requires both signed iOS attestations', 64);
  }
  if (suppliedScope === 'backend_only' && (iosAttestation || iosDistributionAttestation)) {
    fail('backend-only release resume must not include iOS evidence', 64);
  }
  const iosEvidence = suppliedScope === 'shared_backend_ios' ? {
    compatibilityPath: path.resolve(root, iosAttestation),
    distributionPath: path.resolve(root, iosDistributionAttestation),
  } : null;
  const repository = validateProtectedRepository();
  const security = existingSecurityEvidence();
  const baselineRunIds = releaseCandidateRuns().map((candidate) => String(candidate.databaseId));
  const intentCreatedAt = new Date();
  const dispatchArgs = releaseCandidateDispatchArgs(suppliedScope, iosEvidence);
  state = writeCheckpoint({
    schema: 'nexus.release-sequence-checkpoint.v1',
    runtimeSha,
    originMainSha,
    packageVersion,
    repository,
    sourceIntent: { runtimeSha, originMainSha, packageVersion, repository },
    rcRunId: null,
    contractScope: suppliedScope,
    phase: 'rc_dispatch_intent',
    nextAction: 'dispatch_release_candidate_once',
    createdAt: intentCreatedAt.toISOString(),
    inProgressStep: null,
    lastError: null,
    attempts: [],
    iosEvidence,
    workflows: { security },
    rcDispatch: {
      schema: 'nexus.release-candidate-dispatch-intent.v1',
      status: 'intent_persisted',
      workflow: 'release-candidate-evidence.yml',
      workflowSha256: sha256File(path.join(root, '.github', 'workflows', 'release-candidate-evidence.yml')),
      headSha: runtimeSha,
      contractScope: suppliedScope,
      correlationNonce: crypto.randomUUID(),
      correlationMode: 'baseline_run_ids_and_created_at',
      baselineRunIds,
      intentCreatedAt: intentCreatedAt.toISOString(),
      candidateNotBefore: new Date(intentCreatedAt.getTime() - 60_000).toISOString(),
      commandSha256: dispatchCommandDigest(dispatchArgs),
    },
  });
} else {
  if (state.originMainSha !== originMainSha || state.packageVersion !== packageVersion) {
    fail('release checkpoint source or package version identity mismatch', 64);
  }
  if (state.sourceIntent?.runtimeSha !== runtimeSha
      || state.sourceIntent?.originMainSha !== originMainSha
      || state.sourceIntent?.packageVersion !== packageVersion
      || state.sourceIntent?.repository !== state.repository
      || state.workflows?.security?.headSha !== runtimeSha
      || state.workflows?.security?.workflowSha256
        !== sha256File(path.join(root, '.github', 'workflows', 'security.yml'))) {
    fail('release checkpoint source or security intent identity mismatch', 64);
  }
  revalidateCheckpointTrust(state);
  if (suppliedRcRun && suppliedRcRun !== state.rcRunId) fail('release checkpoint RC run identity mismatch', 64);
  if (suppliedScope && suppliedScope !== state.contractScope) fail('release checkpoint contract scope mismatch', 64);
}

state = continueReleaseCandidate(state);
if (has('--status')) emit(state);

const suppliedManifestPath = value('--manifest');
const recordedManifestIdentity = state.signedManifestIdentity || null;
const manifestPath = path.resolve(root, suppliedManifestPath
  || recordedManifestIdentity?.path
  || path.join('.local', 'release', 'manifests', `${runtimeSha}.json`));
if (recordedManifestIdentity && manifestPath !== path.resolve(recordedManifestIdentity.path)) {
  fail('signed release manifest path differs from the checkpoint identity', 64);
}
if (recordedManifestIdentity) {
  if (!fs.existsSync(manifestPath)
      || sha256File(manifestPath) !== recordedManifestIdentity.sha256
      || recordedManifestIdentity.artifactDigest !== state.artifactDigest
      || recordedManifestIdentity.sha256 !== state.signedManifestSha256) {
    fail('signed release manifest identity drifted after it was checkpointed');
  }
}

if (!fs.existsSync(manifestPath)) {
  const signArgs = [
    path.join(root, 'scripts', 'request-release-manifest-signature.sh'),
    runtimeSha,
    state.rcRunId,
    root,
  ];
  if (state.contractScope === 'backend_only') {
    signArgs.push('--backend-only');
  } else {
    const compatibilityPath = value('--ios-attestation', state.iosEvidence?.compatibilityPath || '');
    const distributionPath = value('--ios-distribution-attestation', state.iosEvidence?.distributionPath || '');
    if (!compatibilityPath || !distributionPath) fail('checkpoint iOS evidence paths are unavailable', 64);
    signArgs.push(
      '--includes-ios',
      '--ios-attestation', compatibilityPath,
      '--ios-distribution-attestation', distributionPath,
    );
  }
  state = runStep(state, 'trusted_signing', 'bash', signArgs);
}

state = runStep(state, 'validate_signed_manifest', 'bash', [
  path.join(root, 'scripts', 'release-operator.sh'),
  'status',
  '--manifest', manifestPath,
]);

let manifest;
try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { fail('signed release manifest is invalid JSON'); }
const artifactDigest = manifest?.payload?.artifact?.digest;
if (!/^[a-f0-9]{64}$/u.test(artifactDigest || '')) fail('signed release manifest artifact digest is invalid');
if (manifest?.payload?.runtimeSha !== runtimeSha || manifest?.payload?.packageVersion !== packageVersion) {
  fail('signed release manifest source or package version identity mismatch');
}
const signedManifestSha256 = sha256File(manifestPath);
if (recordedManifestIdentity
    && (recordedManifestIdentity.sha256 !== signedManifestSha256
      || recordedManifestIdentity.artifactDigest !== artifactDigest)) {
  fail('signed release manifest identity drifted after it was checkpointed');
}
state = writeCheckpoint({
  ...state,
  phase: 'signed',
  nextAction: 'stage_exact_artifact',
  signedManifest: path.relative(root, manifestPath),
  signedManifestIdentity: recordedManifestIdentity || {
    path: manifestPath,
    sha256: signedManifestSha256,
    artifactDigest,
  },
  signedManifestSha256,
  artifactDigest,
});
const suppliedStagingAttestationPath = value('--staging-attestation');
const recordedStagingIdentity = state.stagingAttestationIdentity || null;
const stagingAttestationPath = path.resolve(root, suppliedStagingAttestationPath
  || recordedStagingIdentity?.path
  || path.join('.local', 'release', 'staging', `${runtimeSha}-${artifactDigest}.signed.json`));
if (recordedStagingIdentity && stagingAttestationPath !== path.resolve(recordedStagingIdentity.path)) {
  fail('staging attestation path differs from the checkpoint identity', 64);
}
if (recordedStagingIdentity) {
  if (!fs.existsSync(stagingAttestationPath)
      || sha256File(stagingAttestationPath) !== recordedStagingIdentity.sha256
      || recordedStagingIdentity.installedRuntimeDigest !== state.installedRuntimeDigest
      || recordedStagingIdentity.sha256 !== state.stagingAttestationSha256) {
    fail('staging attestation identity drifted after it was checkpointed');
  }
}

if (!fs.existsSync(stagingAttestationPath)) {
  state = runStep(state, 'stage_exact_artifact', 'bash', [
    path.join(root, 'scripts', 'release-operator.sh'),
    'staging',
    '--manifest', manifestPath,
  ]);
}
state = runStep(state, 'validate_staging_attestation', 'bash', [
  path.join(root, 'scripts', 'release-operator.sh'),
  'status',
  '--manifest', manifestPath,
  '--staging-attestation', stagingAttestationPath,
], { ...process.env, NEXUS_RELEASE_STATUS_REQUIRE_STAGING: '1' });
let stagingAttestation;
try { stagingAttestation = JSON.parse(fs.readFileSync(stagingAttestationPath, 'utf8')); } catch {
  fail('signed staging attestation is invalid JSON');
}
const installedRuntimeDigest = stagingAttestation?.payload?.installedRuntimeDigest;
const recoveryRuntimeDigest = stagingAttestation?.payload?.recoveryRuntimeDigest;
if (!/^[a-f0-9]{64}$/u.test(installedRuntimeDigest || '')
    || !/^[a-f0-9]{64}$/u.test(recoveryRuntimeDigest || '')
    || stagingAttestation?.payload?.runtimeSha !== runtimeSha
    || stagingAttestation?.payload?.artifactDigest !== artifactDigest
    || stagingAttestation?.payload?.releaseManifestSha256 !== signedManifestSha256) {
  fail('signed staging attestation installed-tree identity is invalid');
}
const stagingAttestationSha256 = sha256File(stagingAttestationPath);
if (recordedStagingIdentity
    && (recordedStagingIdentity.sha256 !== stagingAttestationSha256
      || recordedStagingIdentity.installedRuntimeDigest !== installedRuntimeDigest
      || recordedStagingIdentity.recoveryRuntimeDigest !== recoveryRuntimeDigest)) {
  fail('staging attestation identity drifted after it was checkpointed');
}
state = writeCheckpoint({
  ...state,
  phase: 'owner_stop',
  nextAction: 'explicit_owner_authorization_required',
  stagingAttestation: path.relative(root, stagingAttestationPath),
  stagingAttestationIdentity: recordedStagingIdentity || {
    path: stagingAttestationPath,
    sha256: stagingAttestationSha256,
    installedRuntimeDigest,
    recoveryRuntimeDigest,
  },
  stagingAttestationSha256,
  installedRuntimeDigest,
  recoveryRuntimeDigest,
  ownerStopReachedAt: state.ownerStopReachedAt || new Date().toISOString(),
});

if (!has('--owner-authorized')) {
  emit(state, { manualRequired: true, reason: 'owner_authorization_not_automatic' }, 3);
}
if (process.env.NEXUS_RELEASE_OWNER_AUTHORIZED !== '1') {
  fail('--owner-authorized also requires NEXUS_RELEASE_OWNER_AUTHORIZED=1 in the current invocation');
}
state = writeCheckpoint({
  ...state,
  phase: 'owner_authorized_for_current_invocation',
  nextAction: 'explicit_promote_flag_required',
  ownerAuthorizationObservedAt: new Date().toISOString(),
});
if (!has('--promote')) {
  emit(state, { manualRequired: true, reason: 'promotion_not_requested' }, 3);
}

const productionEvidence = path.join(
  root,
  '.local',
  'release',
  'production',
  `${runtimeSha}-${artifactDigest}.json`,
);
state = runStep(state, 'promote_exact_artifact', 'bash', [
  path.join(root, 'scripts', 'release-operator.sh'),
  'promote',
  '--manifest', manifestPath,
  '--staging-attestation', stagingAttestationPath,
], process.env);
let production;
try { production = JSON.parse(fs.readFileSync(productionEvidence, 'utf8')); } catch {
  fail('production promotion evidence is missing or invalid after promotion');
}
if (!productionEvidenceMatches(production, {
  runtimeSha,
  artifactDigest,
  installedRuntimeDigest,
  recoveryRuntimeDigest,
  releaseManifestSha256: signedManifestSha256,
  stagingAttestationSha256,
  packageVersion,
})) {
  fail('production promotion evidence does not match the checkpoint identity');
}
state = writeCheckpoint({
  ...state,
  phase: 'promoted',
  nextAction: null,
  productionEvidence: path.relative(root, productionEvidence),
  productionEvidenceIdentity: {
    path: productionEvidence,
    sha256: sha256File(productionEvidence),
    runtimeSha,
    artifactDigest,
    installedRuntimeDigest,
    recoveryRuntimeDigest,
    releaseManifestSha256: signedManifestSha256,
    stagingAttestationSha256,
    backupSha256: production.backupSha256,
    rollbackEscrowEvidenceSha256: production.rollbackEscrow.evidenceSha256,
  },
  promotedAt: production.completedAt || new Date().toISOString(),
});
emit(state);
