#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const command = args[0] ?? 'validate';
const valueOf = (name, fallback = '') => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1] || fallback;
};
const root = path.resolve(valueOf('--root', process.cwd()));
const output = path.resolve(root, valueOf('--output', '.nexus-installed-runtime.json'));

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fileDigest(relative) {
  const file = path.join(root, relative);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new Error(`installed-runtime input is missing: ${relative}`);
  }
  return sha256(fs.readFileSync(file));
}

function treeIdentity(relativeRoot) {
  const absoluteRoot = path.join(root, relativeRoot);
  if (!fs.existsSync(absoluteRoot) || !fs.statSync(absoluteRoot).isDirectory()) {
    throw new Error(`installed dependency tree is missing: ${relativeRoot}`);
  }
  const entries = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(absoluteRoot, absolute).split(path.sep).join('/');
      const stat = fs.lstatSync(absolute);
      if (stat.isDirectory()) {
        walk(absolute);
      } else if (stat.isSymbolicLink()) {
        entries.push({ path: relative, type: 'symlink', target: fs.readlinkSync(absolute) });
      } else if (stat.isFile()) {
        const body = fs.readFileSync(absolute);
        entries.push({
          path: relative,
          type: 'file',
          size: body.length,
          executable: Boolean(stat.mode & 0o111),
          sha256: sha256(body),
        });
      } else {
        throw new Error(`unsupported installed dependency entry: ${relativeRoot}/${relative}`);
      }
    }
  };
  walk(absoluteRoot);
  entries.sort((a, b) => compareCodeUnits(a.path, b.path));
  const totalBytes = entries.reduce((sum, entry) => sum + (entry.size ?? 0), 0);
  return {
    path: relativeRoot,
    digest: sha256(canonicalJson(entries)),
    entryCount: entries.length,
    totalBytes,
  };
}

function networkIndependentInstallIdentity() {
  const evidenceRelative = '.network-independent-install.json';
  const lockRelative = 'dist/runtime-dependencies/lock.json';
  const evidencePath = path.join(root, evidenceRelative);
  const lockPath = path.join(root, lockRelative);
  if (!fs.existsSync(evidencePath) || !fs.statSync(evidencePath).isFile()) {
    throw new Error('network-independent install evidence is missing');
  }
  if (!fs.existsSync(lockPath) || !fs.statSync(lockPath).isFile()) {
    throw new Error('runtime dependency lock is missing');
  }
  const evidenceBytes = fs.readFileSync(evidencePath);
  const evidence = JSON.parse(evidenceBytes.toString('utf8'));
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  if (evidence.schema !== 'nexus.network-independent-install.v1'
      || evidence.status !== 'passed'
      || !/^[0-9a-f]{64}$/.test(evidence.dependencyLockDigest ?? '')
      || !/^[0-9a-f]{64}$/.test(evidence.packageLockSha256 ?? '')
      || !/^[0-9a-f]{64}$/.test(evidence.pythonRequirementsSha256 ?? '')
      || Number.isNaN(Date.parse(evidence.installedAt ?? ''))) {
    throw new Error('network-independent install evidence is invalid');
  }
  const dependencyLockDigest = sha256(canonicalJson(lock));
  if (evidence.dependencyLockDigest !== dependencyLockDigest
      || evidence.packageLockSha256 !== fileDigest('package-lock.json')
      || evidence.pythonRequirementsSha256 !== fileDigest('content-engine/requirements.txt')) {
    throw new Error('network-independent install evidence is not bound to release inputs');
  }
  return {
    schema: evidence.schema,
    status: evidence.status,
    dependencyLockDigest,
    evidenceSha256: sha256(evidenceBytes),
  };
}

function buildIdentity() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  return {
    schema: 'nexus.installed-runtime-identity.v1',
    runtimeSha: valueOf('--runtime-sha'),
    artifactDigest: valueOf('--artifact-digest'),
    packageVersion: packageJson.version,
    inputs: {
      packageLockSha256: fileDigest('package-lock.json'),
      requirementsSha256: fileDigest('content-engine/requirements.txt'),
      node: process.version,
      python: execFileSync(
        path.join(root, 'content-engine/.venv/bin/python3.12'),
        ['--version'],
        { encoding: 'utf8' },
      ).trim(),
    },
    networkIndependentInstall: networkIndependentInstallIdentity(),
    trees: [treeIdentity('node_modules'), treeIdentity('content-engine/.venv')],
  };
}

function assertIdentity(identity) {
  if (!/^[0-9a-f]{40}$/.test(identity.runtimeSha ?? '')) throw new Error('runtime SHA is invalid');
  if (!/^[0-9a-f]{64}$/.test(identity.artifactDigest ?? '')) throw new Error('artifact digest is invalid');
  const expectedSha = valueOf('--expect-runtime-sha');
  const expectedArtifact = valueOf('--expect-artifact-digest');
  if (expectedSha && identity.runtimeSha !== expectedSha) throw new Error('installed runtime SHA mismatch');
  if (expectedArtifact && identity.artifactDigest !== expectedArtifact) throw new Error('installed artifact digest mismatch');
}

if (command === 'write') {
  const identity = buildIdentity();
  assertIdentity(identity);
  const attestation = {
    schema: 'nexus.installed-runtime-attestation.v1',
    generatedAt: new Date().toISOString(),
    identity,
    aggregateDigest: sha256(canonicalJson(identity)),
  };
  fs.writeFileSync(output, `${JSON.stringify(attestation, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ ok: true, output, ...attestation }, null, 2)}\n`);
} else if (command === 'validate') {
  const attestation = JSON.parse(fs.readFileSync(output, 'utf8'));
  if (attestation.schema !== 'nexus.installed-runtime-attestation.v1') {
    throw new Error('installed runtime attestation schema is invalid');
  }
  assertIdentity(attestation.identity ?? {});
  const current = buildIdentity();
  assertIdentity(current);
  const expectedAggregate = valueOf('--expect-aggregate-digest');
  const aggregate = sha256(canonicalJson(current));
  if (canonicalJson(attestation.identity) !== canonicalJson(current)
      || attestation.aggregateDigest !== aggregate) {
    throw new Error('installed dependency tree attestation mismatch');
  }
  if (expectedAggregate && aggregate !== expectedAggregate) {
    throw new Error('installed dependency aggregate digest mismatch');
  }
  process.stdout.write(`${JSON.stringify({ ok: true, aggregateDigest: aggregate, identity: current }, null, 2)}\n`);
} else {
  throw new Error('Usage: release-installed-tree-attestation.mjs <write|validate> --root <release> --runtime-sha <sha> --artifact-digest <digest>');
}
