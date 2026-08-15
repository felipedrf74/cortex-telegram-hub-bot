#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  lstatSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const TEST_MODE = process.env.NEXUS_OLLAMA_PREDECESSOR_TEST_MODE === '1';
const TEST_ROOT = process.env.NEXUS_OLLAMA_PREDECESSOR_TEST_ROOT || '';
const PRODUCTION = Object.freeze({
  receipt: '/var/lib/nexus-release/ollama-install/install-receipt.v1.json',
  stateChecker: '/usr/local/sbin/nexus-ollama-install-state-check.mjs',
  installGuard: '/etc/systemd/system/ollama.service.d/00-nexus-ollama-install-guard.conf',
});

function fail(message, exitCode = 77) {
  const error = new Error(message);
  error.exitCode = exitCode;
  throw error;
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) {
    fail(`${label} has an unexpected schema`);
  }
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function expectedUid() {
  return TEST_MODE ? process.getuid?.() : 0;
}

function trustRoot() {
  if (!TEST_MODE) return '/';
  if (!isAbsolute(TEST_ROOT) || resolve(TEST_ROOT) !== TEST_ROOT) {
    fail('test predecessor trust root is not canonical', 64);
  }
  return realpathSync.native(TEST_ROOT);
}

function requireTrustedPath(path, label, kind, mode) {
  if (!isAbsolute(path) || path === '/' || resolve(path) !== path) {
    fail(`${label} path is not canonical`);
  }
  const root = trustRoot();
  const canonical = realpathSync.native(path);
  if (canonical !== path || (root !== '/' && path !== root && !path.startsWith(`${root}/`))) {
    fail(`${label} path escapes its trusted root`);
  }
  let current = path;
  while (true) {
    const info = lstatSync(current);
    if (info.isSymbolicLink() || info.uid !== expectedUid() || (info.mode & 0o022) !== 0) {
      fail(`${label} path chain is unsafe at ${current}`);
    }
    if (current === root) break;
    const parent = dirname(current);
    if (parent === current || (root !== '/' && !parent.startsWith(root))) {
      fail(`${label} path chain escaped its trusted root`);
    }
    current = parent;
  }
  const info = lstatSync(path);
  if ((kind === 'file' && (!info.isFile() || info.nlink !== 1))
      || (kind === 'directory' && !info.isDirectory())) {
    fail(`${label} has the wrong filesystem type`);
  }
  if (mode !== undefined && (info.mode & 0o777) !== mode) {
    fail(`${label} has the wrong mode`);
  }
  return info;
}

function resolvePaths(argv) {
  if (!TEST_MODE) {
    if (argv.length !== 2) fail('production predecessor proof accepts no path arguments', 64);
    return PRODUCTION;
  }
  if (argv.length !== 5) {
    fail('test usage: checker <receipt> <state-checker> <install-guard>', 64);
  }
  return {
    receipt: resolve(argv[2]),
    stateChecker: resolve(argv[3]),
    installGuard: resolve(argv[4]),
  };
}

function validateReceipt(paths) {
  requireTrustedPath(paths.receipt, 'prior Ollama install receipt', 'file', 0o600);
  let receipt;
  try {
    receipt = JSON.parse(readFileSync(paths.receipt, 'utf8'));
  } catch {
    fail('prior Ollama install receipt is malformed');
  }
  exactKeys(receipt, [
    'schema',
    'status',
    'transactionId',
    'target',
    'candidateSha256',
    'sourceProvenance',
    'runtimeIdentity',
    'retainedModelObservation',
    'assets',
    'service',
    'completedAt',
  ], 'prior Ollama install receipt');
  exactKeys(
    receipt.sourceProvenance,
    ['sourceRoot', 'sourceSha', 'archiveSha256'],
    'prior Ollama source provenance',
  );
  if (receipt.schema !== 'nexus.ollama-systemd-install-receipt.v1'
      || receipt.status !== 'complete'
      || !/^[0-9a-f-]{36}$/u.test(receipt.transactionId || '')
      || receipt.target !== '/etc/systemd/system/ollama.service.d/override.conf'
      || !/^[0-9a-f]{64}$/u.test(receipt.candidateSha256 || '')
      || !/^[0-9a-f]{40}$/u.test(receipt.sourceProvenance.sourceSha || '')
      || !/^[0-9a-f]{64}$/u.test(receipt.sourceProvenance.archiveSha256 || '')
      || !Array.isArray(receipt.assets)
      || !Number.isFinite(Date.parse(receipt.completedAt || ''))) {
    fail('prior Ollama install receipt identity is invalid');
  }
  const expectedSourceRoot = TEST_MODE
    ? join(trustRoot(), 'bootstrap', receipt.sourceProvenance.sourceSha, 'source')
    : `/var/lib/nexus-release-bootstrap/${receipt.sourceProvenance.sourceSha}/source`;
  if (receipt.sourceProvenance.sourceRoot !== expectedSourceRoot) {
    fail('prior Ollama source root is not bound to its receipt SHA');
  }
  requireTrustedPath(expectedSourceRoot, 'prior Ollama source root', 'directory');
  const archive = join(dirname(expectedSourceRoot), 'source.tar.gz');
  requireTrustedPath(archive, 'prior Ollama source archive', 'file', 0o600);
  if (sha256(archive) !== receipt.sourceProvenance.archiveSha256) {
    fail('prior Ollama source archive digest changed');
  }

  const seen = new Set();
  for (const [index, asset] of receipt.assets.entries()) {
    exactKeys(asset, ['target', 'sha256', 'mode'], `prior Ollama asset ${index}`);
    if (!isAbsolute(asset.target || '') || resolve(asset.target) !== asset.target
        || !/^[0-9a-f]{64}$/u.test(asset.sha256 || '')
        || ![0o644, 0o700].includes(asset.mode)
        || seen.has(asset.target)) {
      fail(`prior Ollama asset ${index} identity is invalid`);
    }
    seen.add(asset.target);
  }

  const required = [
    {
      target: paths.stateChecker,
      productionTarget: PRODUCTION.stateChecker,
      source: join(expectedSourceRoot, 'scripts/ollama-install-state-check.mjs'),
      mode: 0o700,
    },
    {
      target: paths.installGuard,
      productionTarget: PRODUCTION.installGuard,
      source: join(expectedSourceRoot, 'scripts/systemd/00-nexus-ollama-install-guard.conf'),
      mode: 0o644,
    },
  ];
  for (const item of required) {
    const receiptTarget = TEST_MODE ? item.target : item.productionTarget;
    const matches = receipt.assets.filter((asset) => asset.target === receiptTarget);
    if (matches.length !== 1 || matches[0].mode !== item.mode) {
      fail(`prior Ollama receipt does not attest ${receiptTarget}`);
    }
    requireTrustedPath(item.target, `installed predecessor ${receiptTarget}`, 'file', item.mode);
    requireTrustedPath(item.source, `prior source for ${receiptTarget}`, 'file');
    const installedDigest = sha256(item.target);
    if (installedDigest !== matches[0].sha256 || sha256(item.source) !== installedDigest) {
      fail(`installed predecessor differs from its prior receipt: ${receiptTarget}`);
    }
  }
  const guard = readFileSync(paths.installGuard, 'utf8').split(/\r?\n/u);
  if (!guard.includes('ExecStartPre=+/usr/local/sbin/nexus-ollama-install-state-check.mjs')) {
    fail('installed predecessor guard does not call the fixed state checker');
  }
  return {
    ok: true,
    sourceSha: receipt.sourceProvenance.sourceSha,
    receiptSha256: sha256(paths.receipt),
  };
}

try {
  const result = validateReceipt(resolvePaths(process.argv));
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`ollama_predecessor_blocked: ${error.message}\n`);
  process.exit(Number.isInteger(error.exitCode) ? error.exitCode : 77);
}
