#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const command = args.shift() ?? '';
const valueOf = (name) => {
  const index = args.indexOf(name);
  if (index === -1 || !args[index + 1]) throw new Error(`${name} is required`);
  return args[index + 1];
};
const has = (name) => args.includes(name);
const testMode = has('--allow-test-owner') && process.env.NODE_ENV === 'test';
const role = valueOf('--role');
const releaseRoot = path.resolve(valueOf('--release-root'));
const base = path.resolve(valueOf('--base'));
const runtime = path.resolve(valueOf('--runtime'));
const workerUid = Number(valueOf('--worker-uid'));
const workerGid = Number(valueOf('--worker-gid'));

if (!['staging', 'production'].includes(role)) throw new Error('release filesystem role is invalid');
if (!Number.isSafeInteger(workerUid) || workerUid < 0
    || !Number.isSafeInteger(workerGid) || workerGid < 0) {
  throw new Error('release filesystem worker identity is invalid');
}
if (base !== path.join(releaseRoot, role)
    || runtime === path.join(base, 'releases')
    || !runtime.startsWith(`${path.join(base, 'releases')}${path.sep}`)) {
  throw new Error('release filesystem path is outside the authoritative root');
}

const rootUid = testMode ? process.getuid() : 0;
const rootGid = testMode ? process.getgid() : 0;
const expected = [
  { name: 'releaseRoot', value: releaseRoot, uid: rootUid, gid: rootGid, mode: 0o755 },
  { name: 'base', value: base, uid: rootUid, gid: workerGid, mode: 0o1770 },
  { name: 'releases', value: path.join(base, 'releases'), uid: rootUid, gid: workerGid, mode: 0o750 },
  { name: 'runtime', value: runtime, uid: rootUid, gid: workerGid, mode: 0o550 },
];

function captureEntry(entry) {
  const stat = fs.lstatSync(entry.value, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`release filesystem ${entry.name} is not a non-symlink directory`);
  }
  if (fs.realpathSync.native(entry.value) !== entry.value) {
    throw new Error(`release filesystem ${entry.name} is not canonical`);
  }
  const uid = Number(stat.uid);
  const gid = Number(stat.gid);
  const mode = Number(stat.mode & 0o7777n);
  if (uid !== entry.uid || gid !== entry.gid || mode !== entry.mode) {
    throw new Error(`release filesystem ${entry.name} ownership or mode is unsafe`);
  }
  return {
    path: entry.value,
    dev: String(stat.dev),
    ino: String(stat.ino),
    uid,
    gid,
    mode,
  };
}

function capture() {
  const entries = Object.fromEntries(expected.map((entry) => [entry.name, captureEntry(entry)]));
  return {
    schema: 'nexus.release-filesystem-identity.v1',
    role,
    workerUid,
    workerGid,
    entries,
  };
}

function readNoFollow(file) {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  const descriptor = fs.openSync(file, flags);
  try {
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
      throw new Error('release filesystem binding is unsafe');
    }
    const body = fs.readFileSync(descriptor, 'utf8');
    const after = fs.fstatSync(descriptor);
    if (before.dev !== after.dev || before.ino !== after.ino
        || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error('release filesystem binding changed while it was read');
    }
    return JSON.parse(body);
  } finally {
    fs.closeSync(descriptor);
  }
}

const actual = capture();
if (command === 'capture') {
  process.stdout.write(`${JSON.stringify(actual, null, 2)}\n`);
} else if (command === 'verify') {
  const binding = readNoFollow(path.resolve(valueOf('--binding')));
  if (binding?.schema !== 'nexus.trusted-staging-runtime-binding.v1') {
    throw new Error('trusted staging runtime binding schema is invalid');
  }
  const serializedActual = JSON.stringify(actual);
  const serializedExpected = JSON.stringify(binding.filesystem);
  if (serializedActual !== serializedExpected) {
    throw new Error('authoritative release filesystem identity changed after sealing');
  }
  process.stdout.write(`${JSON.stringify(actual, null, 2)}\n`);
} else {
  throw new Error('Usage: trusted-release-filesystem-identity.mjs <capture|verify> --role <staging|production> --release-root <path> --base <path> --runtime <path> --worker-uid <uid> --worker-gid <gid> [--binding <file>] [--allow-test-owner]');
}
