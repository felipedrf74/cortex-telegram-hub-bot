#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {
  buildReleaseArtifactManifest,
  verifyReleaseBundle,
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
const expectedRuntimeSha = readArg('--expected-runtime-sha', '');
const expectedDigest = readArg('--expected-digest', '');

let body;
if (verifyBundlePath) {
  if (expectedRuntimeSha && !/^[0-9a-f]{40}$/.test(expectedRuntimeSha)) {
    throw new Error('--expected-runtime-sha must be a full lowercase Git SHA');
  }
  if (expectedDigest && !/^[0-9a-f]{64}$/.test(expectedDigest)) {
    throw new Error('--expected-digest must be a full lowercase SHA-256 digest');
  }
  const verified = verifyReleaseBundle(verifyBundlePath, expectedRuntimeSha);
  if (expectedDigest && verified.digest !== expectedDigest) {
    throw new Error('verified release bundle digest does not match --expected-digest');
  }
  body = `${JSON.stringify({
    schema: 'nexus.release-bundle-verification.v1',
    status: 'passed',
    runtimeSha: verified.marker.runtimeSha,
    artifactDigest: verified.digest,
    fileCount: verified.manifest.fileCount,
    bundleRoot: verified.bundleRoot,
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
