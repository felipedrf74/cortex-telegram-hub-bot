#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {
  buildReleaseArtifactManifest,
  verifyReleaseBundle,
  verifyInstalledReleaseSource,
} from './lib/release-artifact-manifest.mjs';

const args = process.argv.slice(2);

function readArg(name, fallback = '') {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  return args[index + 1] || fallback;
}

const root = path.resolve(readArg('--root', process.cwd()));
const output = readArg('--format', args.includes('--digest') ? 'digest' : 'json');
const writePath = readArg('--write', '');
const verifyBundlePath = readArg('--verify-bundle', '');
const verifyInstalledSourcePath = readArg('--verify-installed-source', '');
const requiredDeclaredFile = readArg('--require-declared-file', '');
const expectedRuntimeSha = readArg('--expected-runtime-sha', '');
const expectedDigest = readArg('--expected-digest', '');

let body;
if (verifyBundlePath && verifyInstalledSourcePath) {
  throw new Error('choose only one release verification mode');
}
if (requiredDeclaredFile && !verifyInstalledSourcePath) {
  throw new Error('--require-declared-file is valid only with --verify-installed-source');
}
if (verifyBundlePath || verifyInstalledSourcePath) {
  if (expectedRuntimeSha && !/^[0-9a-f]{40}$/.test(expectedRuntimeSha)) {
    throw new Error('--expected-runtime-sha must be a full lowercase Git SHA');
  }
  if (expectedDigest && !/^[0-9a-f]{64}$/.test(expectedDigest)) {
    throw new Error('--expected-digest must be a full lowercase SHA-256 digest');
  }
  const verificationRoot = verifyBundlePath || verifyInstalledSourcePath;
  const verified = verifyBundlePath
    ? verifyReleaseBundle(verificationRoot, expectedRuntimeSha)
    : verifyInstalledReleaseSource(verificationRoot, expectedRuntimeSha);
  if (expectedDigest && verified.digest !== expectedDigest) {
    throw new Error('verified release bundle digest does not match --expected-digest');
  }
  if (requiredDeclaredFile
      && !verified.manifest.files.some((entry) => entry.path === requiredDeclaredFile)) {
    throw new Error(
      `required installed release file is not declared by artifact manifest: ${requiredDeclaredFile}`,
    );
  }
  body = `${JSON.stringify({
    schema: verifyBundlePath
      ? 'nexus.release-bundle-verification.v1'
      : 'nexus.release-installed-source-verification.v1',
    status: 'passed',
    runtimeSha: verified.marker.runtimeSha,
    artifactDigest: verified.digest,
    fileCount: verified.manifest.fileCount,
    ...(verifyBundlePath
      ? { bundleRoot: verified.bundleRoot }
      : { releaseRoot: verified.bundleRoot }),
  }, null, 2)}\n`;
} else {
  const manifest = buildReleaseArtifactManifest(root);
  body = output === 'digest' ? `${manifest.digest}\n` : `${JSON.stringify(manifest, null, 2)}\n`;
}

if (writePath) {
  fs.mkdirSync(path.dirname(path.resolve(writePath)), { recursive: true });
  fs.writeFileSync(path.resolve(writePath), body);
} else {
  process.stdout.write(body);
}
