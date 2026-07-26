#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import {
  BACKEND_IOS_CONTRACT_FIXTURE_PATH,
  validateBackendIosContractFixtureBytes,
} from './lib/backend-ios-contract-fixture.mjs';
import { verifyReleaseBundle } from './lib/release-artifact-manifest.mjs';

const args = process.argv.slice(2);
const valueOf = (name, fallback = '') => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1] || fallback;
};
const root = path.resolve(valueOf('--root', process.cwd()));
const require = createRequire(import.meta.url);
const fixtureModulePath = path.join(root, 'dist/release/backend-ios-contract-fixture.js');
if (!fs.existsSync(fixtureModulePath)) {
  throw new Error('compiled backend/iOS contract fixture builder is missing; build the exact runtime first');
}
const fixtureModule = require(fixtureModulePath);
if (typeof fixtureModule.buildBackendIosContractFixture !== 'function') {
  throw new Error('compiled backend/iOS contract fixture builder is invalid');
}
const fixtureOutputPath = path.join(root, BACKEND_IOS_CONTRACT_FIXTURE_PATH);
fs.mkdirSync(path.dirname(fixtureOutputPath), { recursive: true });
const fixtureBytes = Buffer.from(`${JSON.stringify(fixtureModule.buildBackendIosContractFixture())}\n`);
validateBackendIosContractFixtureBytes(fixtureBytes);
fs.writeFileSync(fixtureOutputPath, fixtureBytes, { mode: 0o600 });
const artifact = JSON.parse(execFileSync(process.execPath, [
  path.join(root, 'scripts/release-artifact-manifest.mjs'), '--root', root, '--format', 'json',
], { cwd: root, encoding: 'utf8' }));
if (!artifact.files.some((entry) => entry.path === 'dist/index.js')) {
  throw new Error('dist/index.js is missing; build the exact runtime before creating a bundle');
}

const runtimeSha = valueOf('--runtime-sha', artifact.git.sha || 'unknown');
const outputRoot = path.resolve(valueOf(
  '--output',
  path.join(root, '.local/release/bundles', runtimeSha, artifact.digest),
));
const completeMarker = path.join(outputRoot, '.complete.json');
if (fs.existsSync(completeMarker)) {
  const existing = JSON.parse(fs.readFileSync(completeMarker, 'utf8'));
  if (existing.artifactDigest !== artifact.digest || existing.runtimeSha !== runtimeSha) {
    throw new Error('existing immutable bundle identity does not match requested runtime');
  }
  const verified = verifyReleaseBundle(outputRoot, runtimeSha);
  if (verified.digest !== artifact.digest) {
    throw new Error('existing immutable bundle bytes do not match requested artifact');
  }
  process.stdout.write(`${JSON.stringify({ reused: true, outputRoot, ...existing }, null, 2)}\n`);
  process.exit(0);
}

fs.mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
for (const entry of artifact.files) {
  const source = path.join(root, entry.path);
  const destination = path.join(outputRoot, entry.path);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  // Hosted runners and local APFS worktrees may support copy-on-write clones.
  // COPYFILE_FICLONE falls back to an ordinary copy when cloning is
  // unavailable; COPYFILE_EXCL preserves the immutable no-overwrite contract.
  fs.copyFileSync(
    source,
    destination,
    fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE,
  );
}
fs.writeFileSync(
  path.join(outputRoot, 'artifact-manifest.json'),
  `${JSON.stringify({ ...artifact, root: '.' }, null, 2)}\n`,
  { mode: 0o600 },
);
const marker = {
  schema: 'nexus.release-bundle.v1',
  runtimeSha,
  packageVersion: JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version,
  artifactDigest: artifact.digest,
  fileCount: artifact.fileCount,
  createdAt: new Date().toISOString(),
};
fs.writeFileSync(completeMarker, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
fs.chmodSync(outputRoot, 0o500);
verifyReleaseBundle(outputRoot, runtimeSha);
process.stdout.write(`${JSON.stringify({ reused: false, outputRoot, ...marker }, null, 2)}\n`);
