#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import {
  chmodSync,
  chownSync,
  closeSync,
  copyFileSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const PRODUCTION_STATE_ROOT = '/var/lib/nexus-release/ollama-install';
const PRODUCTION_DROP_IN = '/etc/systemd/system/ollama.service.d/override.conf';
const PRODUCTION_SYSTEMCTL = '/usr/bin/systemctl';
const JOURNAL_NAME = 'install-in-progress.v1.json';
const RECEIPT_NAME = 'install-receipt.v1.json';
const ROLLBACK_NAME = 'last-rollback.v1.json';
const JOURNAL_SCHEMA = 'nexus.ollama-systemd-install-journal.v1';
const RECEIPT_SCHEMA = 'nexus.ollama-systemd-install-receipt.v1';
const ROLLBACK_SCHEMA = 'nexus.ollama-systemd-install-rollback.v1';
const TERMINAL_STATUSES = new Set(['commit_complete', 'rollback_complete']);
const MAX_BYTES = 1024 * 1024;
const MAX_SYSTEMCTL_EXECUTABLE_BYTES = 4 * 1024 * 1024;
const MAX_RUNTIME_BINARY_BYTES = 256 * 1024 * 1024;
const PRODUCTION_TAGS_URL = 'http://127.0.0.1:11434/api/tags';
const PRODUCTION_RUNTIME_CORE_IDENTITY = Object.freeze({
  binaryPath: '/usr/local/bin/ollama',
  binarySha256: 'b2e45ade9cb754a079f74645e1183d613f582d98f7354b05f4f9a5bd81f8e0c9',
  version: 'ollama version is 0.24.0',
  serviceFragment: '/etc/systemd/system/ollama.service',
  serviceFragmentSha256: '72b23db27bcd69aa9c05226285a928ae8520dac108736072a33cea35bbcccdda',
});
const PRODUCTION_ASSET_LAYOUT = Object.freeze([
  ['scripts/ollama-lean-finalize.mjs', '/usr/local/sbin/nexus-ollama-lean-finalize.mjs', 0o700],
  ['scripts/ollama-service-envelope-check.mjs', '/usr/local/sbin/nexus-ollama-service-envelope-check.mjs', 0o700],
  ['scripts/lib/ollama-service-envelope.mjs', '/usr/local/sbin/lib/ollama-service-envelope.mjs', 0o700],
  ['scripts/ollama-systemd-dropin-transaction.mjs', '/usr/local/sbin/nexus-ollama-systemd-dropin-transaction.mjs', 0o700],
  ['scripts/ollama-install-state-check.mjs', '/usr/local/sbin/nexus-ollama-install-state-check.mjs', 0o700],
  ['scripts/local-inference-socket-transaction.mjs', '/usr/local/sbin/nexus-local-inference-socket-transaction.mjs', 0o700],
  ['scripts/local-model-benchmark-envelope-transaction.mjs', '/usr/local/sbin/nexus-local-model-benchmark-envelope-transaction.mjs', 0o700],
  ['config/local-model-manifest.json', '/usr/local/sbin/nexus-local-model-manifest.json', 0o644],
  ['scripts/systemd/00-nexus-ollama-install-guard.conf', '/etc/systemd/system/ollama.service.d/00-nexus-ollama-install-guard.conf', 0o644],
  ['scripts/systemd/nexus-local-inference-sockets.conf', '/usr/local/sbin/nexus-local-inference-sockets.conf', 0o644],
]);

function fail(message, exitCode = 1) {
  const error = new Error(message);
  error.exitCode = exitCode;
  throw error;
}

function testMode() {
  return process.env.NEXUS_OLLAMA_INSTALL_TEST_MODE === '1';
}

function injectFault(point) {
  if (!testMode() || process.env.NEXUS_OLLAMA_INSTALL_FAULT_POINT !== point) return;
  if (process.env.NEXUS_OLLAMA_INSTALL_FAULT_MODE === 'throw') {
    fail(`injected Ollama install fault at ${point}`);
  }
  process.kill(process.pid, 'SIGKILL');
}

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function sha256File(path) {
  return sha256Bytes(readFileSync(path));
}

function pathEntryExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function validateTrustedPathChain(path, label, expectedType) {
  if (!isAbsolute(path) || path === '/' || resolve(path) !== path) {
    fail(`${label} path is not canonical`);
  }
  const info = lstatSync(path);
  if ((expectedType === 'file' && (!info.isFile() || info.isSymbolicLink()))
      || (expectedType === 'directory' && (!info.isDirectory() || info.isSymbolicLink()))) {
    fail(`${label} has the wrong type`);
  }
  if (realpathSync.native(path) !== path) fail(`${label} path traverses a symlink`);
  if (testMode()) {
    if (Number.isInteger(expectedUid()) && info.uid !== expectedUid()) fail(`${label} has the wrong owner`);
    if ((info.mode & 0o022) !== 0) fail(`${label} is writable by another account`);
    return;
  }
  let current = path;
  for (;;) {
    const component = lstatSync(current);
    if (component.isSymbolicLink() || component.uid !== 0 || (component.mode & 0o022) !== 0) {
      fail(`${label} path chain is not root-trusted: ${current}`);
    }
    if (current === '/') break;
    current = dirname(current);
  }
}

function fsyncPath(path) {
  const descriptor = openSync(path, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function durableRemove(path, faultScope = null) {
  rmSync(path, { force: true });
  if (faultScope) injectFault(`${faultScope}_after_unlink_before_parent_fsync`);
  fsyncPath(dirname(path));
  if (faultScope) injectFault(`${faultScope}_after_parent_fsync`);
}

function atomicWrite(path, bytes, mode, uid, gid) {
  const parent = dirname(path);
  const temporary = join(parent, `.nexus-ollama.${process.pid}.${randomUUID()}.tmp`);
  writeFileSync(temporary, bytes, { flag: 'wx', mode });
  chmodSync(temporary, mode);
  chownSync(temporary, uid, gid);
  fsyncPath(temporary);
  renameSync(temporary, path);
  fsyncPath(parent);
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) {
    fail(`${label} has an unexpected schema`);
  }
}

function expectedUid() {
  return testMode() ? process.getuid?.() : 0;
}

function expectedGid() {
  return testMode() ? process.getgid?.() : 0;
}

function validateSecureDirectory(path, label, mode) {
  if (!isAbsolute(path) || path === '/' || resolve(path) !== path) {
    fail(`${label} path is not canonical`);
  }
  const canonical = realpathSync.native(path);
  if (canonical !== path) fail(`${label} path traverses a symlink`);
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) fail(`${label} is not a directory`);
  if (Number.isInteger(expectedUid()) && info.uid !== expectedUid()) fail(`${label} has the wrong owner`);
  if ((info.mode & 0o777) !== mode) fail(`${label} must have mode ${mode.toString(8)}`);
}

function validateTargetParent(path) {
  const parent = dirname(path);
  validateSecureDirectory(parent, 'Ollama systemd drop-in parent', testMode() ? 0o700 : 0o755);
}

function validateRegular(path, label, { mode = null, owner = expectedUid(), maximum = MAX_BYTES } = {}) {
  if (!isAbsolute(path) || resolve(path) !== path) fail(`${label} path is not canonical`);
  const canonical = realpathSync.native(path);
  if (canonical !== path) fail(`${label} path traverses a symlink`);
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) fail(`${label} is not a regular file`);
  if (Number.isInteger(owner) && info.uid !== owner) fail(`${label} has the wrong owner`);
  if (mode !== null && (info.mode & 0o777) !== mode) fail(`${label} has the wrong mode`);
  if (info.size > maximum) fail(`${label} is too large`);
  return info;
}

function command(options, args, label, accepted = [0]) {
  const result = spawnSync(options.systemctl, args, {
    encoding: 'utf8',
    shell: false,
    timeout: 30_000,
    maxBuffer: MAX_BYTES,
  });
  if (result.error || result.signal || !accepted.includes(result.status)) {
    fail(`${label} failed`);
  }
  return (result.stdout || '').trim();
}

function selectedManifestModel(sourceRoot) {
  if (!isAbsolute(sourceRoot || '') || resolve(sourceRoot) !== sourceRoot) {
    fail('signed local-model manifest source root is invalid');
  }
  const manifestPath = join(sourceRoot, 'config/local-model-manifest.json');
  validateTrustedPathChain(manifestPath, 'signed local-model manifest', 'file');
  validateRegular(manifestPath, 'signed local-model manifest', { owner: expectedUid() });
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    fail('signed local-model manifest is malformed');
  }
  const active = Array.isArray(manifest?.models)
    ? manifest.models.find((model) => model?.id === manifest.activeModelId)
    : null;
  const winners = Array.isArray(manifest?.models)
    ? manifest.models.filter((model) => model?.role === 'winner')
    : [];
  const digest = String(active?.digest || '');
  const evidence = manifest?.selectionEvidence;
  const productionEvidenceValid = manifest?.selectionStatus !== 'production_selected' || (
    evidence && typeof evidence === 'object' && !Array.isArray(evidence)
    && evidence.winningCandidateId === manifest.activeModelId
    && /^sha256:[0-9a-f]{64}$/u.test(evidence.benchmarkReportDigest || '')
    && typeof evidence.benchmarkCompletedAt === 'string'
    && !Number.isNaN(Date.parse(evidence.benchmarkCompletedAt))
    && new Date(evidence.benchmarkCompletedAt).toISOString() === evidence.benchmarkCompletedAt
    && /^sha256:[0-9a-f]{64}$/u.test(evidence.benchmarkHostRollbackReceiptDigest || '')
    && [
      'corpusReference',
      'licenseReviewReference',
      'ownerApprovalReference',
    ]
      .every((field) => typeof evidence[field] === 'string'
        && evidence[field].trim().length > 0
        && evidence[field].trim().length <= 512)
  );
  if (manifest?.schemaVersion !== 'nexus.local-model-manifest.v1'
      || !['control_only', 'production_selected'].includes(manifest.selectionStatus)
      || (manifest.selectionStatus === 'control_only' && manifest.selectionEvidence !== null)
      || (manifest.selectionStatus === 'control_only'
        ? winners.length !== 0
        : winners.length !== 1 || winners[0]?.id !== active?.id)
      || !productionEvidenceValid
      || active?.productionEligible !== true
      || active?.evidenceStatus !== 'verified'
      || typeof active?.ollamaTag !== 'string'
      || active.ollamaTag.length < 1
      || !/^sha256:[0-9a-f]{64}$/u.test(digest)
      || (manifest.selectionStatus === 'production_selected' && active.role !== 'winner')) {
    fail('signed local-model manifest has no verified digest-pinned active model');
  }
  return {
    retainedModel: active.ollamaTag,
    retainedModelDigest: digest.slice('sha256:'.length),
  };
}

function validateRuntimeIdentity(identity, {
  verifyFiles = true,
  verifyVersion = false,
  sourceRoot = null,
} = {}) {
  exactKeys(identity, [
    'binaryPath',
    'binarySha256',
    'version',
    'serviceFragment',
    'serviceFragmentSha256',
    'retainedModel',
    'retainedModelDigest',
  ], 'Ollama runtime identity');
  if (!isAbsolute(identity.binaryPath || '') || resolve(identity.binaryPath) !== identity.binaryPath
      || !/^[0-9a-f]{64}$/u.test(identity.binarySha256 || '')
      || typeof identity.version !== 'string' || identity.version.length < 1
      || !isAbsolute(identity.serviceFragment || '')
      || resolve(identity.serviceFragment) !== identity.serviceFragment
      || !/^[0-9a-f]{64}$/u.test(identity.serviceFragmentSha256 || '')
      || typeof identity.retainedModel !== 'string' || identity.retainedModel.length < 1
      || !/^[0-9a-f]{64}$/u.test(identity.retainedModelDigest || '')) {
    fail('Ollama runtime identity is invalid');
  }
  if (!testMode()) {
    const expectedIdentity = {
      ...PRODUCTION_RUNTIME_CORE_IDENTITY,
      ...selectedManifestModel(sourceRoot),
    };
    for (const [key, expected] of Object.entries(expectedIdentity)) {
      if (identity[key] !== expected) fail(`Ollama runtime identity changed: ${key}`);
    }
  }
  if (!verifyFiles || testMode()) return;
  validateTrustedPathChain(identity.binaryPath, 'reviewed Ollama binary', 'file');
  const binaryInfo = validateRegular(identity.binaryPath, 'reviewed Ollama binary', {
    mode: 0o755,
    owner: 0,
    maximum: MAX_RUNTIME_BINARY_BYTES,
  });
  if (binaryInfo.gid !== 0 || sha256File(identity.binaryPath) !== identity.binarySha256) {
    fail('reviewed Ollama binary identity changed');
  }
  if (verifyVersion) {
    const version = spawnSync(identity.binaryPath, ['--version'], {
      encoding: 'utf8',
      shell: false,
      timeout: 30_000,
      maxBuffer: MAX_BYTES,
    });
    if (version.error || version.signal || version.status !== 0
        || `${version.stdout || ''}${version.stderr || ''}`.trim() !== identity.version) {
      fail('reviewed Ollama version changed');
    }
  }
  validateTrustedPathChain(identity.serviceFragment, 'reviewed Ollama service fragment', 'file');
  const fragmentInfo = validateRegular(
    identity.serviceFragment,
    'reviewed Ollama service fragment',
    { mode: 0o644, owner: 0 },
  );
  if (fragmentInfo.gid !== 0
      || sha256File(identity.serviceFragment) !== identity.serviceFragmentSha256) {
    fail('reviewed Ollama service fragment identity changed');
  }
}

function observeRetainedModel(options, identity) {
  const url = new URL(options.tagsUrl);
  if (url.protocol !== 'http:' || url.username || url.password || url.hash
      || (testMode()
        ? url.hostname !== '127.0.0.1'
        : url.href !== PRODUCTION_TAGS_URL)) {
    fail('Ollama tags endpoint is not the reviewed loopback URL');
  }
  return new Promise((resolveObservation, rejectObservation) => {
    const request = httpRequest(url, {
      method: 'GET',
      headers: { accept: 'application/json', connection: 'close' },
    }, (response) => {
      const declaredLength = Number(response.headers['content-length']);
      if (response.statusCode !== 200
          || (Number.isFinite(declaredLength) && declaredLength > MAX_BYTES)) {
        response.resume();
        rejectObservation(new Error('Ollama tags endpoint returned an invalid bounded response'));
        return;
      }
      const chunks = [];
      let bytes = 0;
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_BYTES) {
          request.destroy(new Error('Ollama tags response exceeded the bounded size'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        try {
          const raw = Buffer.concat(chunks);
          let value;
          try {
            value = JSON.parse(raw);
          } catch {
            fail('Ollama tags response is malformed');
          }
          const matches = Array.isArray(value?.models)
            ? value.models.filter(
              (model) => model?.name === identity.retainedModel
                || model?.model === identity.retainedModel,
            )
            : [];
          const observedDigest = String(matches[0]?.digest || '').trim().toLowerCase().replace(/^sha256:/u, '');
          if (matches.length !== 1 || observedDigest !== identity.retainedModelDigest) {
            fail('retained Ollama model changed before transaction commit');
          }
          resolveObservation({
            endpoint: PRODUCTION_TAGS_URL,
            tag: identity.retainedModel,
            digest: observedDigest,
            responseSha256: sha256Bytes(raw),
            observedAt: new Date().toISOString(),
          });
        } catch (error) {
          rejectObservation(error);
        }
      });
    });
    request.setTimeout(5_000, () => {
      request.destroy(new Error('Ollama tags endpoint timed out'));
    });
    request.on('error', rejectObservation);
    request.end();
  });
}

function serviceState(options) {
  const active = command(
    options,
    ['show', 'ollama.service', '--property=ActiveState', '--value', '--no-pager'],
    'Ollama ActiveState query',
  );
  if (!['active', 'inactive'].includes(active)) {
    fail(`Ollama service is in an unsupported transitional state: ${active || 'unknown'}`);
  }
  const enabled = command(options, ['is-enabled', 'ollama.service'], 'Ollama enablement query', [0, 1]);
  if (!['enabled', 'disabled'].includes(enabled)) {
    fail(`Ollama service enablement is ambiguous: ${enabled || 'unknown'}`);
  }
  return { activeState: active, enabledState: enabled };
}

function readJournal(options) {
  validateRegular(options.journal, 'Ollama install journal', { mode: 0o600 });
  const bytes = readFileSync(options.journal);
  let value;
  try {
    value = JSON.parse(bytes);
  } catch {
    fail('Ollama install journal is malformed');
  }
  exactKeys(value, [
    'schema',
    'status',
    'transactionId',
    'target',
    'candidateSha256',
    'sourceProvenance',
    'runtimeIdentity',
    'assets',
    'backup',
    'priorService',
    'priorReceipt',
    'startedAt',
    'restartAuthorization',
    'terminalResult',
  ], 'Ollama install journal');
  if (value.schema !== JOURNAL_SCHEMA
      || ![
        'dropin_replaced',
        'restart_authorized',
        'rollback_authorized',
        'rollback_absent_authorized',
        'rollback_absent_consumed',
        ...TERMINAL_STATUSES,
      ].includes(value.status)
      || !/^[0-9a-f-]{36}$/u.test(value.transactionId || '')
      || value.target !== options.dropIn
      || !/^[0-9a-f]{64}$/u.test(value.candidateSha256 || '')) {
    fail('Ollama install journal identity is invalid');
  }
  exactKeys(
    value.sourceProvenance,
    ['sourceRoot', 'sourceSha', 'archiveSha256'],
    'Ollama source provenance',
  );
  if (!isAbsolute(value.sourceProvenance.sourceRoot || '')
      || resolve(value.sourceProvenance.sourceRoot) !== value.sourceProvenance.sourceRoot
      || !/^[0-9a-f]{40}$/u.test(value.sourceProvenance.sourceSha || '')
      || !/^[0-9a-f]{64}$/u.test(value.sourceProvenance.archiveSha256 || '')
      || !Array.isArray(value.assets)) {
    fail('Ollama install journal source provenance is invalid');
  }
  if (!testMode() && value.sourceProvenance.sourceRoot
      !== `/var/lib/nexus-release-bootstrap/${value.sourceProvenance.sourceSha}/source`) {
    fail('Ollama install journal source root is not SHA-bound');
  }
  validateRuntimeIdentity(value.runtimeIdentity, {
    sourceRoot: value.sourceProvenance.sourceRoot,
  });
  for (const [index, asset] of value.assets.entries()) {
    exactKeys(
      asset,
      ['source', 'target', 'sourceSha256', 'targetMode', 'prior'],
      `Ollama asset ${index}`,
    );
    exactKeys(
      asset.prior,
      ['existed', 'path', 'sha256', 'mode', 'uid', 'gid'],
      `Ollama asset ${index} predecessor`,
    );
    if (!isAbsolute(asset.source || '') || resolve(asset.source) !== asset.source
        || !isAbsolute(asset.target || '') || resolve(asset.target) !== asset.target
        || !/^[0-9a-f]{64}$/u.test(asset.sourceSha256 || '')
        || ![0o644, 0o700].includes(asset.targetMode)
        || typeof asset.prior.existed !== 'boolean') {
      fail(`Ollama asset ${index} identity is invalid`);
    }
    if (asset.prior.existed) {
      if (!isAbsolute(asset.prior.path || '') || resolve(asset.prior.path) !== asset.prior.path
          || !/^[0-9a-f]{64}$/u.test(asset.prior.sha256 || '')
          || !Number.isSafeInteger(asset.prior.mode) || asset.prior.mode < 0
          || asset.prior.mode > 0o777 || (asset.prior.mode & 0o022) !== 0
          || !Number.isSafeInteger(asset.prior.uid) || !Number.isSafeInteger(asset.prior.gid)) {
        fail(`Ollama asset ${index} predecessor identity is invalid`);
      }
    } else if ([
      asset.prior.path,
      asset.prior.sha256,
      asset.prior.mode,
      asset.prior.uid,
      asset.prior.gid,
    ].some((field) => field !== null)) {
      fail(`Ollama asset ${index} absent predecessor is ambiguous`);
    }
  }
  if (!testMode()) {
    const expectedAssets = PRODUCTION_ASSET_LAYOUT.map(([relative, target, targetMode]) => ({
      source: join(value.sourceProvenance.sourceRoot, relative),
      target,
      targetMode,
    }));
    if (value.assets.length !== expectedAssets.length
        || value.assets.some((asset, index) => (
          asset.source !== expectedAssets[index].source
          || asset.target !== expectedAssets[index].target
          || asset.targetMode !== expectedAssets[index].targetMode
        ))) {
      fail('Ollama operational asset set differs from the reviewed layout');
    }
  }
  exactKeys(value.backup, ['existed', 'path', 'sha256', 'mode', 'uid', 'gid'], 'drop-in backup');
  exactKeys(value.priorService, ['activeState', 'enabledState'], 'prior service state');
  exactKeys(value.priorReceipt, ['existed', 'path', 'sha256'], 'prior receipt backup');
  if (typeof value.backup.existed !== 'boolean'
      || typeof value.priorReceipt.existed !== 'boolean'
      || !['active', 'inactive'].includes(value.priorService.activeState)
      || !['enabled', 'disabled'].includes(value.priorService.enabledState)) {
    fail('Ollama install journal rollback state is invalid');
  }
  if (value.status === 'dropin_replaced') {
    if (value.restartAuthorization !== null) {
      fail('unstarted Ollama transaction declares restart authorization');
    }
  } else if (!TERMINAL_STATUSES.has(value.status)) {
    exactKeys(value.restartAuthorization, [
      'purpose',
      'transactionId',
      'bootId',
      'installerPid',
      'installerStartTicks',
      'candidateSha256',
      'target',
      'consumptionPath',
      'authorizedAt',
      'consumedAt',
    ], 'Ollama restart authorization');
    exactKeys(
      value.restartAuthorization.target,
      ['existed', 'sha256', 'mode'],
      'Ollama authorized restart target',
    );
    if (value.restartAuthorization.transactionId !== value.transactionId
        || value.restartAuthorization.candidateSha256 !== value.candidateSha256
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
          .test(value.restartAuthorization.bootId || '')
        || !Number.isSafeInteger(value.restartAuthorization.installerPid)
        || value.restartAuthorization.installerPid < 1
        || !/^(?:0|[1-9][0-9]*)$/u.test(
          String(value.restartAuthorization.installerStartTicks ?? ''),
        )
        || typeof value.restartAuthorization.target.existed !== 'boolean'
        || !Number.isFinite(Date.parse(value.restartAuthorization.authorizedAt || ''))) {
      fail('Ollama restart authorization identity is invalid');
    }
    if (value.restartAuthorization.target.existed) {
      if (!/^[0-9a-f]{64}$/u.test(value.restartAuthorization.target.sha256 || '')
          || !Number.isSafeInteger(value.restartAuthorization.target.mode)
          || value.restartAuthorization.target.mode < 0
          || value.restartAuthorization.target.mode > 0o777
          || (value.restartAuthorization.target.mode & 0o022) !== 0) {
        fail('Ollama authorized restart target is invalid');
      }
    } else if (value.restartAuthorization.target.sha256 !== null
        || value.restartAuthorization.target.mode !== null) {
      fail('absent Ollama restart target is ambiguous');
    }
    const expectedPurpose = {
      restart_authorized: 'install_candidate',
      rollback_authorized: 'rollback_present_predecessor',
      rollback_absent_authorized: 'rollback_absent_predecessor',
      rollback_absent_consumed: 'rollback_absent_predecessor',
    }[value.status];
    const expectedConsumptionPath = expectedPurpose === 'rollback_absent_predecessor'
      ? join(options.stateRoot, `${value.transactionId}.rollback-absent-restart-consumed.v1.json`)
      : null;
    if (value.restartAuthorization.purpose !== expectedPurpose
        || value.restartAuthorization.consumptionPath !== expectedConsumptionPath
        || (value.status === 'rollback_absent_consumed'
          ? !Number.isFinite(Date.parse(value.restartAuthorization.consumedAt || ''))
          : value.restartAuthorization.consumedAt !== null)) {
      fail('Ollama restart authorization phase is invalid');
    }
  } else if (value.restartAuthorization !== null) {
    fail('terminal Ollama journal retained a live restart authorization');
  }
  if (TERMINAL_STATUSES.has(value.status)) {
    exactKeys(
      value.terminalResult,
      ['kind', 'path', 'sha256', 'completedAt'],
      'Ollama terminal result',
    );
    const expectedKind = value.status === 'commit_complete' ? 'commit' : 'rollback';
    const expectedPath = expectedKind === 'commit' ? options.receipt : options.rollback;
    if (value.terminalResult.kind !== expectedKind
        || value.terminalResult.path !== expectedPath
        || !/^[0-9a-f]{64}$/u.test(value.terminalResult.sha256 || '')
        || !Number.isFinite(Date.parse(value.terminalResult.completedAt || ''))) {
      fail('Ollama terminal result identity is invalid');
    }
  } else if (value.terminalResult !== null) {
    fail('non-terminal Ollama journal declares a terminal result');
  }
  return value;
}

function replaceDropIn(options, bytes, mode = 0o644, uid = expectedUid(), gid = expectedGid()) {
  validateTargetParent(options.dropIn);
  if (pathEntryExists(options.dropIn)) {
    validateRegular(options.dropIn, 'existing Ollama systemd drop-in', { owner: expectedUid() });
  }
  atomicWrite(options.dropIn, bytes, mode, uid, gid);
  validateRegular(options.dropIn, 'installed Ollama systemd drop-in', { mode, owner: uid });
}

function copyProtected(source, target) {
  copyFileSync(source, target);
  chmodSync(target, 0o600);
  chownSync(target, expectedUid(), expectedGid());
  fsyncPath(target);
  fsyncPath(dirname(target));
}

function configuredAssetLayout() {
  if (!testMode()) return PRODUCTION_ASSET_LAYOUT;
  if (!process.env.NEXUS_OLLAMA_INSTALL_ASSET_LAYOUT_JSON) return [];
  let value;
  try {
    value = JSON.parse(process.env.NEXUS_OLLAMA_INSTALL_ASSET_LAYOUT_JSON);
  } catch {
    fail('test Ollama asset layout is malformed');
  }
  if (!Array.isArray(value)) fail('test Ollama asset layout must be an array');
  return value.map((row, index) => {
    if (!Array.isArray(row) || row.length !== 3
        || typeof row[0] !== 'string' || typeof row[1] !== 'string'
        || !Number.isSafeInteger(row[2])) {
      fail(`test Ollama asset layout row ${index} is invalid`);
    }
    return row;
  });
}

function prepareAssets(options, sourceRoot, transactionId) {
  validateTrustedPathChain(sourceRoot, 'Ollama bootstrap source root', 'directory');
  const seenSources = new Set();
  const seenTargets = new Set();
  return configuredAssetLayout().map(([relative, target, targetMode], index) => {
    if (!/^[A-Za-z0-9._@/-]+$/u.test(relative)
        || relative.startsWith('/') || relative.split('/').includes('..')
        || !isAbsolute(target) || resolve(target) !== target
        || ![0o644, 0o700].includes(targetMode)
        || seenSources.has(relative) || seenTargets.has(target)) {
      fail(`Ollama asset layout row ${index} is unsafe`);
    }
    seenSources.add(relative);
    seenTargets.add(target);
    const source = join(sourceRoot, relative);
    if (!source.startsWith(`${sourceRoot}/`)) fail(`Ollama asset source ${index} escaped its root`);
    validateTrustedPathChain(source, `Ollama asset source ${relative}`, 'file');
    const sourceInfo = validateRegular(source, `Ollama asset source ${relative}`, {
      owner: expectedUid(),
    });
    if ((sourceInfo.mode & 0o022) !== 0) fail(`Ollama asset source ${relative} is writable by another account`);
    validateTrustedPathChain(dirname(target), `Ollama asset target parent ${target}`, 'directory');
    const priorPath = join(options.backups, `${transactionId}.asset.${String(index).padStart(2, '0')}`);
    let prior;
    if (pathEntryExists(target)) {
      const info = validateRegular(target, `existing Ollama asset ${target}`, {
        owner: expectedUid(),
      });
      if ((info.mode & 0o022) !== 0) fail(`existing Ollama asset is writable by another account: ${target}`);
      copyProtected(target, priorPath);
      prior = {
        existed: true,
        path: priorPath,
        sha256: sha256File(priorPath),
        mode: info.mode & 0o777,
        uid: info.uid,
        gid: info.gid,
      };
    } else {
      prior = { existed: false, path: null, sha256: null, mode: null, uid: null, gid: null };
    }
    return {
      source,
      target,
      sourceSha256: sha256File(source),
      targetMode,
      prior,
    };
  });
}

function installAssets(assets) {
  for (const asset of assets) {
    validateRegular(asset.source, `Ollama asset source ${asset.source}`, {
      owner: expectedUid(),
    });
    if (sha256File(asset.source) !== asset.sourceSha256) {
      fail(`Ollama asset source changed before installation: ${asset.source}`);
    }
    atomicWrite(
      asset.target,
      readFileSync(asset.source),
      asset.targetMode,
      expectedUid(),
      expectedGid(),
    );
    validateRegular(asset.target, `installed Ollama asset ${asset.target}`, {
      mode: asset.targetMode,
      owner: expectedUid(),
    });
    if (sha256File(asset.target) !== asset.sourceSha256) {
      fail(`installed Ollama asset digest mismatch: ${asset.target}`);
    }
  }
}

function restoreAssets(assets) {
  for (const asset of [...assets].reverse()) {
    if (asset.prior.existed) {
      validateRegular(asset.prior.path, `Ollama asset backup ${asset.target}`, { mode: 0o600 });
      if (sha256File(asset.prior.path) !== asset.prior.sha256) {
        fail(`Ollama asset predecessor digest changed: ${asset.target}`);
      }
      atomicWrite(
        asset.target,
        readFileSync(asset.prior.path),
        asset.prior.mode,
        asset.prior.uid,
        asset.prior.gid,
      );
      if (sha256File(asset.target) !== asset.prior.sha256) {
        fail(`Ollama asset predecessor was not restored: ${asset.target}`);
      }
    } else if (pathEntryExists(asset.target)) {
      validateRegular(asset.target, `new Ollama asset ${asset.target}`, {
        mode: asset.targetMode,
        owner: expectedUid(),
      });
      if (sha256File(asset.target) !== asset.sourceSha256) {
        fail(`new Ollama asset changed before rollback: ${asset.target}`);
      }
      durableRemove(asset.target);
    }
  }
}

function restoreReceipt(options, journal) {
  if (journal.priorReceipt.existed) {
    validateRegular(journal.priorReceipt.path, 'prior receipt backup', { mode: 0o600 });
    if (sha256File(journal.priorReceipt.path) !== journal.priorReceipt.sha256) {
      fail('prior receipt backup digest changed');
    }
    atomicWrite(
      options.receipt,
      readFileSync(journal.priorReceipt.path),
      0o600,
      expectedUid(),
      expectedGid(),
    );
  } else if (pathEntryExists(options.receipt)) {
    validateRegular(options.receipt, 'new Ollama install receipt', { mode: 0o600 });
    const value = JSON.parse(readFileSync(options.receipt, 'utf8'));
    if (value?.schema !== RECEIPT_SCHEMA || value.transactionId !== journal.transactionId) {
      fail('new receipt does not belong to the interrupted Ollama transaction');
    }
    durableRemove(options.receipt);
  }
}

function restartAuthorization(options, journal, purpose, target, installerPid = process.pid) {
  return {
    purpose,
    transactionId: journal.transactionId,
    bootId: readBootId(options.procRoot),
    installerPid,
    installerStartTicks: procStartTicks(options.procRoot, installerPid),
    candidateSha256: journal.candidateSha256,
    target,
    consumptionPath: purpose === 'rollback_absent_predecessor'
      ? join(options.stateRoot, `${journal.transactionId}.rollback-absent-restart-consumed.v1.json`)
      : null,
    authorizedAt: new Date().toISOString(),
    consumedAt: null,
  };
}

function clearAbsentConsumption(options, journal) {
  const token = join(
    options.stateRoot,
    `${journal.transactionId}.rollback-absent-restart-consumed.v1.json`,
  );
  if (!pathEntryExists(token)) return;
  validateRegular(token, 'absent-predecessor restart consumption token', { mode: 0o600 });
  let value;
  try {
    value = JSON.parse(readFileSync(token, 'utf8'));
  } catch {
    fail('absent-predecessor restart consumption token is malformed');
  }
  if (value?.schema !== 'nexus.ollama-rollback-absent-restart-consumption.v1'
      || value.transactionId !== journal.transactionId
      || value.candidateSha256 !== journal.candidateSha256) {
    fail('absent-predecessor restart consumption token identity changed');
  }
  durableRemove(token);
}

function validateTerminalState(options, journal) {
  if (!TERMINAL_STATUSES.has(journal.status)) fail('Ollama journal is not terminal');
  const result = validateRegular(
    journal.terminalResult.path,
    `Ollama ${journal.terminalResult.kind} terminal result`,
    { mode: 0o600 },
  );
  if (result.size < 2 || sha256File(journal.terminalResult.path) !== journal.terminalResult.sha256) {
    fail(`Ollama ${journal.terminalResult.kind} terminal result changed`);
  }
  let value;
  try {
    value = JSON.parse(readFileSync(journal.terminalResult.path, 'utf8'));
  } catch {
    fail(`Ollama ${journal.terminalResult.kind} terminal result is malformed`);
  }
  if (journal.status === 'commit_complete') {
    if (value?.schema !== RECEIPT_SCHEMA
        || value.status !== 'complete'
        || value.transactionId !== journal.transactionId
        || value.target !== options.dropIn
        || value.candidateSha256 !== journal.candidateSha256) {
      fail('terminal Ollama receipt does not match its transaction');
    }
    validateRegular(options.dropIn, 'terminal committed Ollama drop-in', {
      mode: 0o644,
      owner: expectedUid(),
    });
    if (sha256File(options.dropIn) !== journal.candidateSha256) {
      fail('terminal committed Ollama drop-in changed');
    }
  } else {
    if (value?.schema !== ROLLBACK_SCHEMA
        || value.status !== 'complete'
        || value.transactionId !== journal.transactionId) {
      fail('terminal Ollama rollback result does not match its transaction');
    }
    if (journal.backup.existed) {
      validateRegular(options.dropIn, 'terminal restored Ollama drop-in', {
        mode: journal.backup.mode,
        owner: journal.backup.uid,
      });
      if (sha256File(options.dropIn) !== journal.backup.sha256) {
        fail('terminal restored Ollama drop-in changed');
      }
    } else if (pathEntryExists(options.dropIn)) {
      fail('terminal absent Ollama predecessor unexpectedly exists');
    }
  }
  return value;
}

function terminalize(options, journal, status, resultPath) {
  const kind = status === 'commit_complete' ? 'commit' : 'rollback';
  injectFault(`${kind}_before_terminal_journal`);
  journal.status = status;
  journal.restartAuthorization = null;
  journal.terminalResult = {
    kind,
    path: resultPath,
    sha256: sha256File(resultPath),
    completedAt: new Date().toISOString(),
  };
  atomicWrite(
    options.journal,
    Buffer.from(`${JSON.stringify(journal)}\n`),
    0o600,
    expectedUid(),
    expectedGid(),
  );
  validateTerminalState(options, journal);
  injectFault(`${kind}_after_terminal_journal`);
  return journal;
}

function garbageCollectTerminal(options, journal) {
  validateTerminalState(options, journal);
  const scope = journal.status === 'commit_complete' ? 'commit' : 'rollback';
  injectFault(`${scope}_before_backup_gc`);
  let complete = true;
  const remove = (path) => {
    if (!path || !pathEntryExists(path)) return;
    try {
      durableRemove(path, `${scope}_backup_gc`);
    } catch {
      complete = false;
    }
  };
  for (const asset of journal.assets) {
    if (asset.prior.existed) remove(asset.prior.path);
  }
  if (journal.backup.existed) remove(journal.backup.path);
  if (journal.priorReceipt.existed) remove(journal.priorReceipt.path);
  remove(join(
    options.stateRoot,
    `${journal.transactionId}.rollback-absent-restart-consumed.v1.json`,
  ));
  injectFault(`${scope}_after_backup_gc`);
  if (complete) {
    try {
      durableRemove(options.journal, `${scope}_journal`);
    } catch {
      complete = false;
    }
  }
  return complete;
}

function restore(options, { reason = 'operator_or_failure_rollback' } = {}) {
  const journal = readJournal(options);
  if (TERMINAL_STATUSES.has(journal.status)) {
    return {
      transactionId: journal.transactionId,
      restoredState: journal.status === 'rollback_complete' ? journal.priorService : null,
      terminalStatus: journal.status,
      garbageCollected: garbageCollectTerminal(options, journal),
    };
  }
  clearAbsentConsumption(options, journal);
  if (journal.backup.existed) {
    validateRegular(journal.backup.path, 'prior drop-in backup', { mode: 0o600 });
    if (sha256File(journal.backup.path) !== journal.backup.sha256) {
      fail('prior drop-in backup digest changed');
    }
    replaceDropIn(
      options,
      readFileSync(journal.backup.path),
      journal.backup.mode,
      journal.backup.uid,
      journal.backup.gid,
    );
    journal.status = 'rollback_authorized';
    journal.restartAuthorization = restartAuthorization(
      options,
      journal,
      'rollback_present_predecessor',
      {
        existed: true,
        sha256: journal.backup.sha256,
        mode: journal.backup.mode,
      },
    );
  } else if (pathEntryExists(options.dropIn)) {
    validateRegular(options.dropIn, 'candidate Ollama systemd drop-in', { owner: expectedUid() });
    durableRemove(options.dropIn);
    journal.status = 'rollback_absent_authorized';
    journal.restartAuthorization = restartAuthorization(
      options,
      journal,
      'rollback_absent_predecessor',
      { existed: false, sha256: null, mode: null },
    );
  } else {
    journal.status = 'rollback_absent_authorized';
    journal.restartAuthorization = restartAuthorization(
      options,
      journal,
      'rollback_absent_predecessor',
      { existed: false, sha256: null, mode: null },
    );
  }
  atomicWrite(
    options.journal,
    Buffer.from(`${JSON.stringify(journal)}\n`),
    0o600,
    expectedUid(),
    expectedGid(),
  );
  if (!journal.backup.existed) injectFault('rollback_absent_after_authorization');

  command(options, ['daemon-reload'], 'systemd daemon reload during Ollama rollback');
  if (journal.priorService.enabledState === 'enabled') {
    command(options, ['enable', 'ollama.service'], 'Ollama enablement rollback');
  } else {
    command(options, ['disable', 'ollama.service'], 'Ollama disablement rollback');
  }
  if (journal.priorService.activeState === 'active') {
    command(options, ['restart', 'ollama.service'], 'Ollama active-state rollback');
    if (!journal.backup.existed) {
      const consumed = readJournal(options);
      if (consumed.status !== 'rollback_absent_consumed'
          || consumed.restartAuthorization.consumedAt === null) {
        fail('absent-predecessor rollback restart authorization was not consumed');
      }
    }
  } else {
    command(options, ['stop', 'ollama.service'], 'Ollama inactive-state rollback');
  }
  const restoredState = serviceState(options);
  if (JSON.stringify(restoredState) !== JSON.stringify(journal.priorService)) {
    fail('Ollama service state did not return to its exact predecessor');
  }
  restoreReceipt(options, journal);
  restoreAssets(journal.assets);
  const rollbackResult = {
    schema: ROLLBACK_SCHEMA,
    status: 'complete',
    transactionId: journal.transactionId,
    reason: String(reason).slice(0, 128),
    restoredDropIn: journal.backup.existed,
    restoredService: restoredState,
    completedAt: new Date().toISOString(),
  };
  atomicWrite(
    options.rollback,
    Buffer.from(`${JSON.stringify(rollbackResult)}\n`),
    0o600,
    expectedUid(),
    expectedGid(),
  );
  const terminal = terminalize(options, journal, 'rollback_complete', options.rollback);
  const garbageCollected = garbageCollectTerminal(options, terminal);
  return {
    transactionId: journal.transactionId,
    restoredState,
    terminalStatus: terminal.status,
    garbageCollected,
  };
}

function begin(options, candidate, installerPid, provenance, runtimeIdentity) {
  if (pathEntryExists(options.journal)) {
    restore(options, { reason: 'interrupted_transaction_recovery' });
    if (pathEntryExists(options.journal)) {
      fail('prior terminal Ollama transaction garbage collection is incomplete');
    }
  }
  if (!provenance
      || !isAbsolute(provenance.sourceRoot || '')
      || resolve(provenance.sourceRoot) !== provenance.sourceRoot
      || !/^[0-9a-f]{40}$/u.test(provenance.sourceSha || '')
      || !/^[0-9a-f]{64}$/u.test(provenance.archiveSha256 || '')) {
    fail('exact Ollama source provenance is required', 64);
  }
  if (!testMode()
      && provenance.sourceRoot
        !== `/var/lib/nexus-release-bootstrap/${provenance.sourceSha}/source`) {
    fail('Ollama source root is not bound to its exact SHA');
  }
  validateRuntimeIdentity(runtimeIdentity, {
    verifyVersion: true,
    sourceRoot: provenance.sourceRoot,
  });
  validateRegular(candidate, 'candidate Ollama systemd drop-in', {
    mode: 0o600,
    owner: expectedUid(),
  });
  const candidateBytes = readFileSync(candidate);
  const candidateSha256 = sha256Bytes(candidateBytes);
  const transactionId = randomUUID();
  const priorService = serviceState(options);
  const assets = prepareAssets(options, provenance.sourceRoot, transactionId);
  const backupPath = join(options.backups, `${transactionId}.dropin`);
  const receiptBackupPath = join(options.backups, `${transactionId}.receipt`);
  let backup;
  if (pathEntryExists(options.dropIn)) {
    const info = validateRegular(options.dropIn, 'existing Ollama systemd drop-in', {
      owner: expectedUid(),
    });
    if ((info.mode & 0o022) !== 0) fail('existing Ollama systemd drop-in is writable by group or other');
    copyProtected(options.dropIn, backupPath);
    backup = {
      existed: true,
      path: backupPath,
      sha256: sha256File(backupPath),
      mode: info.mode & 0o777,
      uid: info.uid,
      gid: info.gid,
    };
  } else {
    backup = { existed: false, path: null, sha256: null, mode: null, uid: null, gid: null };
  }
  let priorReceipt;
  if (pathEntryExists(options.receipt)) {
    validateRegular(options.receipt, 'existing Ollama install receipt', { mode: 0o600 });
    copyProtected(options.receipt, receiptBackupPath);
    priorReceipt = {
      existed: true,
      path: receiptBackupPath,
      sha256: sha256File(receiptBackupPath),
    };
  } else {
    priorReceipt = { existed: false, path: null, sha256: null };
  }
  const journal = {
    schema: JOURNAL_SCHEMA,
    status: 'dropin_replaced',
    transactionId,
    target: options.dropIn,
    candidateSha256,
    sourceProvenance: provenance,
    runtimeIdentity,
    assets,
    backup,
    priorService,
    priorReceipt,
    startedAt: new Date().toISOString(),
    restartAuthorization: null,
    terminalResult: null,
  };
  atomicWrite(
    options.journal,
    Buffer.from(`${JSON.stringify(journal)}\n`),
    0o600,
    expectedUid(),
    expectedGid(),
  );
  // Publish the journal-aware drop-in before any operational asset. A reboot
  // during the remaining replacements therefore either executes the reviewed
  // state checker or fails because that checker is absent; it cannot start
  // Ollama while silently ignoring the durable incomplete transaction.
  replaceDropIn(options, candidateBytes);
  if (sha256File(options.dropIn) !== candidateSha256) fail('installed Ollama drop-in digest mismatch');
  const stateChecker = assets.find(
    (asset) => asset.target === '/usr/local/sbin/nexus-ollama-install-state-check.mjs'
      || (testMode() && asset.target.endsWith('/nexus-ollama-install-state-check.mjs')),
  );
  if (!testMode() && !stateChecker) fail('reviewed Ollama state checker asset is missing');
  if (stateChecker) installAssets([stateChecker]);
  installAssets(assets.filter((asset) => asset !== stateChecker));
  return { transactionId, candidateSha256, installerPid };
}

function procStartTicks(procRoot, pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) fail('installer PID is invalid');
  let raw;
  try {
    raw = readFileSync(join(procRoot, String(pid), 'stat'), 'utf8');
  } catch (error) {
    if (!testMode() || error?.code !== 'ENOENT') throw error;
    const synthetic = process.env.NEXUS_OLLAMA_INSTALL_TEST_PROCESS_START_TICKS;
    if (!/^(?:0|[1-9][0-9]*)$/u.test(synthetic || '')) throw error;
    process.kill(pid, 0);
    return synthetic;
  }
  const close = raw.lastIndexOf(')');
  if (close < 1) fail('installer process identity is malformed');
  const fields = raw.slice(close + 2).trim().split(/\s+/u);
  const value = fields[19];
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value || '')) fail('installer process start ticks are malformed');
  return value;
}

function readBootId(procRoot) {
  const value = readFileSync(join(procRoot, 'sys/kernel/random/boot_id'), 'utf8').trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value)) {
    fail('Linux boot ID is malformed');
  }
  return value;
}

function authorize(options, installerPid) {
  const journal = readJournal(options);
  if (journal.status !== 'dropin_replaced') fail('Ollama transaction is not ready for restart authorization');
  validateRegular(options.dropIn, 'candidate Ollama systemd drop-in', { mode: 0o644 });
  if (sha256File(options.dropIn) !== journal.candidateSha256) fail('candidate Ollama drop-in changed');
  journal.status = 'restart_authorized';
  journal.restartAuthorization = restartAuthorization(
    options,
    journal,
    'install_candidate',
    { existed: true, sha256: journal.candidateSha256, mode: 0o644 },
    installerPid,
  );
  atomicWrite(
    options.journal,
    Buffer.from(`${JSON.stringify(journal)}\n`),
    0o600,
    expectedUid(),
    expectedGid(),
  );
  return { transactionId: journal.transactionId };
}

async function commit(options) {
  const journal = readJournal(options);
  if (journal.status !== 'restart_authorized') fail('Ollama transaction lacks restart authorization');
  validateRuntimeIdentity(journal.runtimeIdentity, {
    verifyVersion: true,
    sourceRoot: journal.sourceProvenance.sourceRoot,
  });
  validateRegular(options.dropIn, 'candidate Ollama systemd drop-in', { mode: 0o644 });
  if (sha256File(options.dropIn) !== journal.candidateSha256) fail('candidate Ollama drop-in changed');
  const state = serviceState(options);
  if (state.activeState !== 'active' || state.enabledState !== 'enabled') {
    fail('Ollama service is not active and enabled at commit');
  }
  for (const asset of journal.assets) {
    validateRegular(asset.target, `installed Ollama asset ${asset.target}`, {
      mode: asset.targetMode,
      owner: expectedUid(),
    });
    if (sha256File(asset.target) !== asset.sourceSha256) {
      fail(`installed Ollama asset changed before commit: ${asset.target}`);
    }
  }
  const retainedModelObservation = await observeRetainedModel(options, journal.runtimeIdentity);
  const receipt = {
    schema: RECEIPT_SCHEMA,
    status: 'complete',
    transactionId: journal.transactionId,
    target: options.dropIn,
    candidateSha256: journal.candidateSha256,
    sourceProvenance: journal.sourceProvenance,
    runtimeIdentity: journal.runtimeIdentity,
    retainedModelObservation,
    assets: journal.assets.map((asset) => ({
      target: asset.target,
      sha256: asset.sourceSha256,
      mode: asset.targetMode,
    })),
    service: state,
    completedAt: new Date().toISOString(),
  };
  atomicWrite(
    options.receipt,
    Buffer.from(`${JSON.stringify(receipt)}\n`),
    0o600,
    expectedUid(),
    expectedGid(),
  );
  const terminal = terminalize(options, journal, 'commit_complete', options.receipt);
  garbageCollectTerminal(options, terminal);
  return receipt;
}

function options() {
  const stateRoot = testMode() && process.env.NEXUS_OLLAMA_INSTALL_STATE_ROOT
    ? resolve(process.env.NEXUS_OLLAMA_INSTALL_STATE_ROOT)
    : PRODUCTION_STATE_ROOT;
  const dropIn = testMode() && process.env.NEXUS_OLLAMA_DROP_IN_PATH
    ? resolve(process.env.NEXUS_OLLAMA_DROP_IN_PATH)
    : PRODUCTION_DROP_IN;
  const systemctl = testMode() && process.env.NEXUS_OLLAMA_SYSTEMCTL_BIN
    ? resolve(process.env.NEXUS_OLLAMA_SYSTEMCTL_BIN)
    : PRODUCTION_SYSTEMCTL;
  const procRoot = testMode() && process.env.NEXUS_OLLAMA_PROC_ROOT
    ? resolve(process.env.NEXUS_OLLAMA_PROC_ROOT)
    : '/proc';
  const tagsUrl = testMode() && process.env.NEXUS_OLLAMA_TAGS_URL
    ? process.env.NEXUS_OLLAMA_TAGS_URL
    : PRODUCTION_TAGS_URL;
  if (!testMode() && (typeof process.getuid !== 'function' || process.getuid() !== 0)) {
    fail('Ollama systemd transaction must run as root', 77);
  }
  if (!pathEntryExists(stateRoot)) {
    mkdirSync(stateRoot, { mode: 0o700 });
    chmodSync(stateRoot, 0o700);
    chownSync(stateRoot, expectedUid(), expectedGid());
  }
  validateSecureDirectory(stateRoot, 'Ollama install state root', 0o700);
  const backups = join(stateRoot, 'backups');
  if (!pathEntryExists(backups)) {
    mkdirSync(backups, { mode: 0o700 });
    chmodSync(backups, 0o700);
    chownSync(backups, expectedUid(), expectedGid());
  }
  validateSecureDirectory(backups, 'Ollama install backup directory', 0o700);
  validateTargetParent(dropIn);
  validateRegular(systemctl, 'systemctl executable', {
    owner: null,
    maximum: MAX_SYSTEMCTL_EXECUTABLE_BYTES,
  });
  return {
    stateRoot,
    backups,
    dropIn,
    systemctl,
    procRoot,
    tagsUrl,
    journal: join(stateRoot, JOURNAL_NAME),
    receipt: join(stateRoot, RECEIPT_NAME),
    rollback: join(stateRoot, ROLLBACK_NAME),
  };
}

function parse(argv) {
  const commandName = argv.shift();
  const values = new Map();
  while (argv.length > 0) {
    const key = argv.shift();
    if (![
      '--candidate',
      '--installer-pid',
      '--reason',
      '--source-root',
      '--source-sha',
      '--archive-sha256',
      '--ollama-binary',
      '--ollama-binary-sha256',
      '--ollama-version',
      '--service-fragment',
      '--service-fragment-sha256',
      '--retained-model',
      '--retained-model-digest',
    ].includes(key || '') || values.has(key)) {
      fail(`unknown or repeated argument: ${key || ''}`, 64);
    }
    const value = argv.shift();
    if (!value || value.startsWith('--')) fail(`missing value for ${key}`, 64);
    values.set(key, value);
  }
  if (!['begin', 'authorize-restart', 'commit', 'rollback', 'recover'].includes(commandName || '')) {
    fail('command must be begin, authorize-restart, commit, rollback, or recover', 64);
  }
  return { commandName, values };
}

try {
  const parsed = parse(process.argv.slice(2));
  const opts = options();
  let result;
  if (parsed.commandName === 'begin') {
    const candidate = resolve(parsed.values.get('--candidate') || '');
    const pid = Number(parsed.values.get('--installer-pid'));
    if (!Number.isSafeInteger(pid) || pid < 1) fail('--installer-pid is required', 64);
    result = begin(
      opts,
      candidate,
      pid,
      {
        sourceRoot: resolve(parsed.values.get('--source-root') || ''),
        sourceSha: parsed.values.get('--source-sha'),
        archiveSha256: parsed.values.get('--archive-sha256'),
      },
      {
        binaryPath: resolve(parsed.values.get('--ollama-binary') || ''),
        binarySha256: parsed.values.get('--ollama-binary-sha256'),
        version: parsed.values.get('--ollama-version'),
        serviceFragment: resolve(parsed.values.get('--service-fragment') || ''),
        serviceFragmentSha256: parsed.values.get('--service-fragment-sha256'),
        retainedModel: parsed.values.get('--retained-model'),
        retainedModelDigest: parsed.values.get('--retained-model-digest'),
      },
    );
  } else if (parsed.commandName === 'authorize-restart') {
    const pid = Number(parsed.values.get('--installer-pid'));
    if (!Number.isSafeInteger(pid) || pid < 1) fail('--installer-pid is required', 64);
    result = authorize(opts, pid);
  } else if (parsed.commandName === 'commit') {
    result = await commit(opts);
  } else {
    result = restore(opts, { reason: parsed.values.get('--reason') || parsed.commandName });
  }
  process.stdout.write(`${JSON.stringify({ ok: true, command: parsed.commandName, ...result })}\n`);
} catch (error) {
  process.stderr.write(`ollama_systemd_transaction_blocked: ${error?.message || 'unknown error'}\n`);
  process.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
}
