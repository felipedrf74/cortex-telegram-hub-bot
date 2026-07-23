#!/usr/bin/env node
// Build and verify the identity descriptor for an encrypted current-candidate
// recovery runtime. The descriptor binds the signed ReleaseManifestV2, signed
// staging attestation, exact artifact bytes, and locked offline dependency
// payload. Installed dependency trees are deliberately not duplicated: an
// isolated restore recreates them and must reproduce the signed relocatable
// recovery digest. Production data and runtime links remain separate.
import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const command = args.shift() ?? '';
const valueOf = (name, fallback = '') => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1] || fallback;
};
const root = path.resolve(valueOf('--root', process.cwd()));
const SHA = /^[a-f0-9]{40}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const CURRENT_SIGNING_KEY_ID = 'github-environment-release-signing-2026-07';
const MAX_EVIDENCE_BYTES = 16 * 1024 * 1024;
const MAX_DESCRIPTOR_BYTES = 32 * 1024 * 1024;
const MAX_DESCRIPTOR_ENTRIES = 100_000;
const MAX_FILE_BYTES = 1024 * 1024 * 1024;
const MAX_TOTAL_FILE_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_DEPENDENCY_ENTRIES = 250_000;
const CONTROL_FILES = Object.freeze([
  'artifact-manifest.json',
  '.complete.json',
]);

function fail(message) {
  throw new Error(message);
}

function assertUnprivilegedExecution() {
  const testOverride = process.env.NODE_ENV === 'test' && args.includes('--allow-test-root');
  if (typeof process.getuid === 'function' && process.getuid() === 0 && !testOverride) {
    fail('application recovery runtime verification must run as an unprivileged user');
  }
}

function canonicalJson(input) {
  if (input === null || typeof input !== 'object') return JSON.stringify(input);
  if (Array.isArray(input)) return `[${input.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(input).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(input[key])}`
  )).join(',')}}`;
}

function sha256(input) {
  return createHash('sha256').update(input).digest('hex');
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || canonicalJson(Object.keys(value).sort()) !== canonicalJson([...keys].sort())) {
    fail(`${label} fields do not match the governed schema`);
  }
}

function safeRelative(relative) {
  return typeof relative === 'string'
    && relative.length > 0
    && relative.length <= 4096
    && !path.posix.isAbsolute(relative)
    && !relative.includes('\\')
    && !/[\u0000-\u001f\u007f]/u.test(relative)
    && path.posix.normalize(relative) === relative
    && relative.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

function canonicalDirectory(directory, label) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory) {
    fail(`${label} must be a canonical non-symlink directory`);
  }
}

function regularFile(absolute, label, maxBytes = Number.MAX_SAFE_INTEGER) {
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) {
    fail(`${label} must be a bounded non-symlink regular file`);
  }
  return stat;
}

function rootFile(relative, label = relative, maxBytes = MAX_FILE_BYTES) {
  if (!safeRelative(relative)) fail(`unsafe runtime path: ${relative}`);
  const absolute = path.join(root, relative);
  regularFile(absolute, label, maxBytes);
  return absolute;
}

function readJsonFile(absolute, label, maxBytes = MAX_EVIDENCE_BYTES) {
  regularFile(absolute, label, maxBytes);
  return JSON.parse(fs.readFileSync(absolute, 'utf8'));
}

function fileDigest(relative) {
  return sha256(fs.readFileSync(rootFile(relative)));
}

function publicKey() {
  const publicKeyPath = path.resolve(valueOf('--public-key'));
  regularFile(publicKeyPath, 'release evidence public key', 64 * 1024);
  const body = fs.readFileSync(publicKeyPath);
  const key = createPublicKey(body);
  if (key.asymmetricKeyType !== 'ed25519') fail('release evidence public key is not Ed25519');
  return key;
}

function verifyEnvelope(envelope, schema, label, key) {
  if (envelope?.schema !== schema
      || envelope?.keyId !== CURRENT_SIGNING_KEY_ID
      || envelope?.signatureAlgorithm !== 'ed25519'
      || typeof envelope?.payload !== 'object'
      || typeof envelope?.signature !== 'string') {
    fail(`${label} envelope identity is invalid`);
  }
  let signature;
  try {
    signature = Buffer.from(envelope.signature, 'base64');
  } catch {
    fail(`${label} signature encoding is invalid`);
  }
  if (signature.length !== 64
      || signature.toString('base64') !== envelope.signature
      || !verifySignature(
    null,
    Buffer.from(canonicalJson(envelope.payload)),
    key,
    signature,
  )) fail(`${label} signature is invalid`);
}

function artifactIdentity(expectedRuntimeSha, expectedArtifactDigest) {
  const artifact = readJsonFile(
    rootFile('artifact-manifest.json'),
    'artifact manifest',
  );
  const marker = readJsonFile(rootFile('.complete.json'), 'release marker');
  if (artifact.schema !== 'nexus.release-artifact-manifest.v1'
      || !Array.isArray(artifact.files)
      || artifact.files.length > MAX_DESCRIPTOR_ENTRIES) fail('artifact manifest schema is invalid');
  const files = [];
  let previous = null;
  const declared = new Set();
  let totalBytes = 0;
  for (const entry of artifact.files) {
    if (!safeRelative(entry?.path) || declared.has(entry.path)
        || (previous !== null && previous >= entry.path)
        || !Number.isSafeInteger(entry?.size) || entry.size < 0 || entry.size > MAX_FILE_BYTES
        || !DIGEST.test(entry?.sha256 ?? '')) {
      fail(`unsafe artifact declaration: ${String(entry?.path)}`);
    }
    previous = entry.path;
    declared.add(entry.path);
    totalBytes += entry.size;
    if (totalBytes > MAX_TOTAL_FILE_BYTES) fail('artifact inventory exceeds the aggregate byte limit');
    const body = fs.readFileSync(rootFile(
      entry.path,
      `artifact ${entry.path}`,
      MAX_FILE_BYTES,
    ));
    const observed = sha256(body);
    if (body.length !== entry.size || observed !== entry.sha256) {
      fail(`artifact byte mismatch: ${entry.path}`);
    }
    files.push({ path: entry.path, size: body.length, sha256: observed });
  }
  const digest = sha256(Buffer.from(JSON.stringify({
    schema: artifact.schema,
    files,
  })));
  if (artifact.digest !== digest || artifact.fileCount !== files.length
      || digest !== expectedArtifactDigest
      || artifact.git?.sha !== expectedRuntimeSha
      || marker.schema !== 'nexus.release-bundle.v1'
      || marker.runtimeSha !== expectedRuntimeSha
      || marker.artifactDigest !== expectedArtifactDigest
      || marker.fileCount !== files.length) {
    fail('artifact aggregate identity mismatch');
  }
  return { artifact, files, declared };
}

function treeIdentity(relativeRoot) {
  const absoluteRoot = path.join(root, relativeRoot);
  canonicalDirectory(absoluteRoot, `installed dependency tree ${relativeRoot}`);
  const entries = [];
  let totalBytes = 0;
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(absoluteRoot, absolute).split(path.sep).join('/');
      const stat = fs.lstatSync(absolute);
      if (stat.isDirectory()) walk(absolute);
      else if (stat.isSymbolicLink()) {
        entries.push({
          path: relative,
          type: 'symlink',
          target: fs.readlinkSync(absolute),
        });
      } else if (stat.isFile()) {
        if (stat.size > MAX_FILE_BYTES) {
          fail(`installed dependency file exceeds the size limit: ${relativeRoot}/${relative}`);
        }
        totalBytes += stat.size;
        if (totalBytes > MAX_TOTAL_FILE_BYTES) {
          fail(`installed dependency tree exceeds the aggregate byte limit: ${relativeRoot}`);
        }
        const body = fs.readFileSync(absolute);
        entries.push({
          path: relative,
          type: 'file',
          size: body.length,
          executable: Boolean(stat.mode & 0o111),
          sha256: sha256(body),
        });
      } else fail(`unsupported installed dependency entry: ${relativeRoot}/${relative}`);
      if (entries.length > MAX_DEPENDENCY_ENTRIES) {
        fail(`installed dependency tree contains too many entries: ${relativeRoot}`);
      }
    }
  };
  walk(absoluteRoot);
  entries.sort((left, right) => compareCodeUnits(left.path, right.path));
  return {
    path: relativeRoot,
    digest: sha256(canonicalJson(entries)),
    entryCount: entries.length,
    totalBytes,
  };
}

function networkIdentity() {
  const evidencePath = rootFile(
    '.network-independent-install.json',
    'network-independent install evidence',
    MAX_EVIDENCE_BYTES,
  );
  const evidenceBytes = fs.readFileSync(evidencePath);
  const evidence = JSON.parse(evidenceBytes.toString('utf8'));
  const lock = readJsonFile(
    rootFile('dist/runtime-dependencies/lock.json'),
    'runtime dependency lock',
  );
  const dependencyLockDigest = sha256(canonicalJson(lock));
  if (evidence.schema !== 'nexus.network-independent-install.v1'
      || evidence.status !== 'passed'
      || evidence.dependencyLockDigest !== dependencyLockDigest
      || evidence.packageLockSha256 !== fileDigest('package-lock.json')
      || evidence.pythonRequirementsSha256 !== fileDigest('content-engine/requirements.txt')
      || !Number.isFinite(Date.parse(evidence.installedAt ?? ''))) {
    fail('network-independent install evidence is invalid');
  }
  return {
    schema: evidence.schema,
    status: evidence.status,
    dependencyLockDigest,
    evidenceSha256: sha256(evidenceBytes),
  };
}

function installedIdentity(expectedRuntimeSha, expectedArtifactDigest) {
  const packageJson = readJsonFile(rootFile('package.json'), 'package manifest');
  return {
    schema: 'nexus.installed-runtime-identity.v1',
    runtimeSha: expectedRuntimeSha,
    artifactDigest: expectedArtifactDigest,
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
    networkIndependentInstall: networkIdentity(),
    trees: [treeIdentity('node_modules'), treeIdentity('content-engine/.venv')],
  };
}

function recoveryIdentity(expectedRuntimeSha, expectedArtifactDigest, expectedRecoveryDigest) {
  const helperPath = path.resolve(valueOf('--recovery-identity-helper'));
  regularFile(helperPath, 'recovery runtime identity helper', 2 * 1024 * 1024);
  const raw = execFileSync(process.execPath, [
    helperPath,
    'compute',
    '--root', root,
    '--runtime-sha', expectedRuntimeSha,
    '--artifact-digest', expectedArtifactDigest,
    '--expect-digest', expectedRecoveryDigest,
    ...(process.env.NODE_ENV === 'test' && args.includes('--allow-test-root')
      ? ['--allow-test-root']
      : []),
  ], { encoding: 'utf8' });
  const attestation = JSON.parse(raw);
  if (attestation.schema !== 'nexus.recovery-runtime-attestation.v1'
      || attestation.identity?.schema !== 'nexus.recovery-installed-runtime-identity.v1'
      || attestation.aggregateDigest !== expectedRecoveryDigest) {
    fail('relocatable recovery runtime identity is invalid');
  }
  return attestation;
}

function verifyInstalled(expectedRuntimeSha, expectedArtifactDigest, expectedInstalledDigest) {
  const attestation = readJsonFile(
    rootFile('.nexus-installed-runtime.json'),
    'installed runtime attestation',
  );
  const identity = installedIdentity(expectedRuntimeSha, expectedArtifactDigest);
  const aggregateDigest = sha256(canonicalJson(identity));
  if (attestation.schema !== 'nexus.installed-runtime-attestation.v1'
      || canonicalJson(attestation.identity) !== canonicalJson(identity)
      || attestation.aggregateDigest !== aggregateDigest
      || aggregateDigest !== expectedInstalledDigest) {
    fail('installed runtime identity mismatch');
  }
  return identity;
}

function validateEvidence(
  manifestPath,
  stagingPath,
  expectedRuntimeSha,
  expectedArtifactDigest,
  expectedInstalledDigest,
  expectedRecoveryDigest,
) {
  regularFile(manifestPath, 'signed release manifest', MAX_EVIDENCE_BYTES);
  regularFile(stagingPath, 'signed staging attestation', MAX_EVIDENCE_BYTES);
  const manifestBytes = fs.readFileSync(manifestPath);
  const stagingBytes = fs.readFileSync(stagingPath);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const staging = JSON.parse(stagingBytes.toString('utf8'));
  const key = publicKey();
  verifyEnvelope(manifest, 'nexus.release-manifest.v2', 'release manifest', key);
  verifyEnvelope(staging, 'nexus.staging-attestation.v1', 'staging attestation', key);
  if (manifest.payload?.runtimeSha !== expectedRuntimeSha
      || manifest.payload?.artifact?.digest !== expectedArtifactDigest
      || staging.payload?.runtimeSha !== expectedRuntimeSha
      || staging.payload?.artifactDigest !== expectedArtifactDigest
      || staging.payload?.installedRuntimeDigest !== expectedInstalledDigest
      || staging.payload?.recoveryRuntimeDigest !== expectedRecoveryDigest
      || staging.payload?.releaseManifestSha256 !== sha256(manifestBytes)) {
    fail('signed release evidence identity mismatch');
  }
  return {
    manifest,
    staging,
    manifestSha256: sha256(manifestBytes),
    stagingSha256: sha256(stagingBytes),
  };
}

function collectRuntimeEntries(artifactFiles) {
  const paths = new Set([...artifactFiles.map((entry) => entry.path), ...CONTROL_FILES]);
  if (paths.size > MAX_DESCRIPTOR_ENTRIES) {
    fail('recovery runtime contains too many descriptor entries');
  }
  let totalBytes = 0;
  const entries = [...paths].sort(compareCodeUnits).map((relative) => {
    if (!safeRelative(relative)) fail(`unsafe recovery runtime path: ${relative}`);
    const absolute = path.join(root, relative);
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) {
      fail(`recovery runtime entry is not a bounded regular file: ${relative}`);
    }
    if (fs.realpathSync(absolute) !== absolute) {
      fail(`recovery runtime entry traverses a symlink: ${relative}`);
    }
    totalBytes += stat.size;
    if (totalBytes > MAX_TOTAL_FILE_BYTES) {
      fail('recovery runtime entries exceed the aggregate byte limit');
    }
    const body = fs.readFileSync(absolute);
    return {
      path: relative,
      type: 'file',
      size: body.length,
      executable: Boolean(stat.mode & 0o111),
      sha256: sha256(body),
    };
  });
  return entries;
}

function identityArgs() {
  const runtimeSha = valueOf('--runtime-sha');
  const artifactDigest = valueOf('--artifact-digest');
  const installedRuntimeDigest = valueOf('--installed-runtime-digest');
  const recoveryRuntimeDigest = valueOf('--recovery-runtime-digest');
  if (!SHA.test(runtimeSha) || !DIGEST.test(artifactDigest)
      || !DIGEST.test(installedRuntimeDigest)
      || !DIGEST.test(recoveryRuntimeDigest)) fail('expected recovery runtime identity is invalid');
  return {
    runtimeSha,
    artifactDigest,
    installedRuntimeDigest,
    recoveryRuntimeDigest,
  };
}

function buildDescriptor(
  manifestOverride = '',
  stagingOverride = '',
  { requireExactInstalled = true } = {},
) {
  canonicalDirectory(root, 'recovery runtime root');
  const identity = identityArgs();
  const manifestPath = path.resolve(
    manifestOverride || valueOf('--manifest', path.join(root, '.nexus-recovery/release-manifest.json')),
  );
  const stagingPath = path.resolve(
    stagingOverride || valueOf(
      '--staging-attestation',
      path.join(root, '.nexus-recovery/staging-attestation.json'),
    ),
  );
  const evidence = validateEvidence(
    manifestPath,
    stagingPath,
    identity.runtimeSha,
    identity.artifactDigest,
    identity.installedRuntimeDigest,
    identity.recoveryRuntimeDigest,
  );
  const artifact = artifactIdentity(identity.runtimeSha, identity.artifactDigest);
  const packageJson = readJsonFile(rootFile('package.json'), 'package manifest');
  const installed = requireExactInstalled
    ? verifyInstalled(
      identity.runtimeSha,
      identity.artifactDigest,
      identity.installedRuntimeDigest,
    )
    : { packageVersion: packageJson.version };
  recoveryIdentity(
    identity.runtimeSha,
    identity.artifactDigest,
    identity.recoveryRuntimeDigest,
  );
  const manifestFiles = evidence.manifest.payload?.artifact?.files;
  if (!Array.isArray(manifestFiles)
      || canonicalJson(manifestFiles) !== canonicalJson(artifact.files)
      || evidence.manifest.payload?.artifact?.fileCount !== artifact.files.length
      || evidence.manifest.payload?.packageVersion !== installed.packageVersion) {
    fail('signed release manifest artifact inventory mismatch');
  }
  return {
    schema: 'nexus.current-recovery-runtime.v1',
    identity: {
      ...identity,
      packageVersion: installed.packageVersion,
      releaseManifestSha256: evidence.manifestSha256,
      stagingAttestationSha256: evidence.stagingSha256,
    },
    entries: collectRuntimeEntries(artifact.files),
  };
}

function readDescriptor(descriptorPath) {
  const descriptor = readJsonFile(
    descriptorPath,
    'recovery runtime descriptor',
    MAX_DESCRIPTOR_BYTES,
  );
  exactKeys(descriptor, ['schema', 'identity', 'entries'], 'recovery runtime descriptor');
  exactKeys(descriptor.identity, [
    'runtimeSha',
    'artifactDigest',
    'installedRuntimeDigest',
    'recoveryRuntimeDigest',
    'packageVersion',
    'releaseManifestSha256',
    'stagingAttestationSha256',
  ], 'recovery runtime descriptor identity');
  if (descriptor.schema !== 'nexus.current-recovery-runtime.v1'
      || !SHA.test(descriptor.identity.runtimeSha ?? '')
      || !DIGEST.test(descriptor.identity.artifactDigest ?? '')
      || !DIGEST.test(descriptor.identity.installedRuntimeDigest ?? '')
      || !DIGEST.test(descriptor.identity.recoveryRuntimeDigest ?? '')
      || !DIGEST.test(descriptor.identity.releaseManifestSha256 ?? '')
      || !DIGEST.test(descriptor.identity.stagingAttestationSha256 ?? '')
      || !/^[A-Za-z0-9.+-]{1,128}$/u.test(descriptor.identity.packageVersion ?? '')
      || !Array.isArray(descriptor.entries)
      || descriptor.entries.length > MAX_DESCRIPTOR_ENTRIES) {
    fail('recovery runtime descriptor identity is invalid');
  }
  let previous = null;
  let totalBytes = 0;
  for (const entry of descriptor.entries) {
    exactKeys(entry, ['path', 'type', 'size', 'executable', 'sha256'], 'recovery runtime entry');
    if (!safeRelative(entry.path)
        || entry.type !== 'file'
        || (previous !== null && previous >= entry.path)
        || !Number.isSafeInteger(entry.size)
        || entry.size < 0
        || entry.size > MAX_FILE_BYTES
        || typeof entry.executable !== 'boolean'
        || !DIGEST.test(entry.sha256 ?? '')) {
      fail('recovery runtime descriptor entry is invalid');
    }
    previous = entry.path;
    totalBytes += entry.size;
    if (totalBytes > MAX_TOTAL_FILE_BYTES) {
      fail('recovery runtime descriptor exceeds the aggregate byte limit');
    }
  }
  return descriptor;
}

function prepare() {
  const descriptor = buildDescriptor();
  const body = `${JSON.stringify(descriptor, null, 2)}\n`;
  if (Buffer.byteLength(body) > MAX_DESCRIPTOR_BYTES) {
    fail('recovery runtime descriptor exceeds the bounded size limit');
  }
  const outputValue = valueOf('--output');
  const outputFdValue = valueOf('--output-fd');
  if (Boolean(outputValue) === Boolean(outputFdValue)) {
    fail('exactly one recovery descriptor output path or inherited fd is required');
  }
  let output = '';
  let outputFd = null;
  if (outputFdValue) {
    if (!/^[0-9]+$/u.test(outputFdValue)) {
      fail('recovery runtime descriptor output fd is invalid');
    }
    outputFd = Number(outputFdValue);
    if (!Number.isSafeInteger(outputFd) || outputFd < 3 || outputFd > 1024) {
      fail('recovery runtime descriptor output fd is invalid');
    }
    const outputStat = fs.fstatSync(outputFd);
    if (!outputStat.isFile()
        || outputStat.size !== 0
        || outputStat.nlink !== 1
        || (outputStat.mode & 0o777) !== 0o600) {
      fail('recovery runtime descriptor output fd must be a new mode-0600 regular file');
    }
    const bytes = Buffer.from(body);
    let written = 0;
    while (written < bytes.length) {
      const count = fs.writeSync(
        outputFd,
        bytes,
        written,
        bytes.length - written,
        written,
      );
      if (count <= 0) {
        fail('recovery runtime descriptor output fd write was incomplete');
      }
      written += count;
    }
    if (fs.fstatSync(outputFd).size !== bytes.length) {
      fail('recovery runtime descriptor output fd write was incomplete');
    }
    fs.fsyncSync(outputFd);
  } else {
    output = path.resolve(outputValue);
    canonicalDirectory(path.dirname(output), 'recovery runtime descriptor output parent');
    if (fs.existsSync(output)) {
      fail('recovery runtime descriptor output must be new below a non-symlink parent');
    }
    fs.writeFileSync(output, body, {
      mode: 0o600,
      flag: 'wx',
    });
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    descriptor: output || null,
    descriptorFd: outputFd,
    descriptorSha256: sha256(body),
    identity: descriptor.identity,
    entryCount: descriptor.entries.length,
  })}\n`);
}

function verifyExtracted() {
  const descriptorPath = path.resolve(
    valueOf('--descriptor', path.join(root, '.nexus-recovery/descriptor.json')),
  );
  const descriptor = readDescriptor(descriptorPath);
  const expected = identityArgs();
  const manifestPath = path.resolve(
    valueOf('--manifest', path.join(root, '.nexus-recovery/release-manifest.json')),
  );
  const stagingPath = path.resolve(
    valueOf('--staging-attestation', path.join(root, '.nexus-recovery/staging-attestation.json')),
  );
  const observed = buildDescriptor(
    manifestPath,
    stagingPath,
    { requireExactInstalled: false },
  );
  if (canonicalJson(observed) !== canonicalJson(descriptor)
      || descriptor.identity.runtimeSha !== expected.runtimeSha
      || descriptor.identity.artifactDigest !== expected.artifactDigest
      || descriptor.identity.installedRuntimeDigest !== expected.installedRuntimeDigest
      || manifestPath !== path.join(root, '.nexus-recovery/release-manifest.json')
      || stagingPath !== path.join(root, '.nexus-recovery/staging-attestation.json')) {
    fail('extracted recovery runtime identity mismatch');
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    status: 'passed',
    identity: descriptor.identity,
    descriptorSha256: sha256(fs.readFileSync(descriptorPath)),
    entryCount: descriptor.entries.length,
  })}\n`);
}

try {
  if (command === 'prepare') {
    assertUnprivilegedExecution();
    prepare();
  } else if (command === 'verify') {
    assertUnprivilegedExecution();
    verifyExtracted();
  }
  else fail('Usage: application-dr-recovery-runtime.mjs <prepare|verify> --root <runtime> --manifest <signed manifest> --staging-attestation <signed attestation> --public-key <Ed25519 public key> --recovery-identity-helper <root-owned helper> --runtime-sha <sha> --artifact-digest <sha256> --installed-runtime-digest <sha256> --recovery-runtime-digest <sha256> [--output <descriptor> | --output-fd <inherited-fd>]');
} catch (error) {
  process.stderr.write(`application_dr_recovery_runtime_failed:${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
