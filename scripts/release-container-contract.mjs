#!/usr/bin/env node
// Fast pinned-Debian sandbox contract. The trusted Ubuntu RC job already
// performs typecheck, build, science-policy, migration, and the selected/full
// suites. This smokes the compiled tree against dependencies freshly installed
// from the lockfile/requirements in the pinned sandbox. It is not evidence for
// the archived Ubuntu production dependency payload.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(import.meta.dirname, '..');

function fail(message) {
  process.stderr.write(`release container contract: ${message}\n`);
  process.exit(1);
}

function requireRegular(relativePath) {
  const target = path.join(root, relativePath);
  let metadata;
  try {
    metadata = fs.lstatSync(target);
  } catch {
    fail(`trusted build output is missing: ${relativePath}`);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0) {
    fail(`trusted build output is unsafe or empty: ${relativePath}`);
  }
}

function required(command, args, label) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    if (result.stdout) process.stderr.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    fail(`${label} failed`);
  }
}

if (process.env.CI !== '1') fail('CI=1 is required');
if (process.version !== 'v22.23.1') {
  fail(`Node toolchain differs: ${process.version}`);
}
const osRelease = fs.readFileSync('/etc/os-release', 'utf8');
if (!/^ID=debian$/m.test(osRelease) || !/^VERSION_ID="?12"?$/m.test(osRelease)) {
  fail('sandbox platform differs from pinned Debian 12 policy');
}

for (const relativePath of [
  'dist/index.js',
  'dist/boot.js',
  'dist/portal/portal.html',
  'dist/portal/landing.html',
  'dist/portal/user-login.html',
  'dist/portal/auth/password-reset.html',
  'dist/portal/auth/forgot-password.html',
  'dist/portal/assets/nexus-mark.png',
]) {
  requireRegular(relativePath);
}

// Exercise both native Node dependencies that are most sensitive to the
// runner/container ABI. No application state or network is touched.
const [{ default: Database }, { default: sharp }] = await Promise.all([
  import('better-sqlite3'),
  import('sharp'),
]);
const database = new Database(':memory:');
try {
  const row = database.prepare('SELECT 1 AS ok').get();
  if (row?.ok !== 1) fail('better-sqlite3 in-memory probe returned an invalid value');
} finally {
  database.close();
}
const image = await sharp({
  create: {
    width: 1,
    height: 1,
    channels: 4,
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  },
}).png().toBuffer();
if (!Buffer.isBuffer(image) || image.length === 0) fail('sharp native probe returned no bytes');

required('python', ['-c', [
  'import sqlite3',
  'import fastapi',
  'import pydantic',
  'import uvicorn',
  'assert sqlite3.connect(":memory:").execute("select 1").fetchone()[0] == 1',
].join(';')], 'Python runtime dependency probe');

required('bash', ['scripts/notification-release-gate.sh'], 'notification release gate');

process.stdout.write(`${JSON.stringify({
  ok: true,
  schema: 'nexus.release-container-contract.v2',
  node: process.version,
  sandbox: {
    os: 'debian',
    osVersion: '12',
    compiledTreeSmokePassed: true,
    nodeLockfileNativeCompatibilityPassed: true,
    pythonRequirementsCompatibilityPassed: true,
  },
  notificationGateVerified: true,
})}\n`);
