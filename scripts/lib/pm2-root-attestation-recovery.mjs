import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { canonicalJson, exactKeys, sha256 } from './release-canonical.mjs';
import {
  DEFAULT_PM2_FALLBACK_RETIREMENT_PATHS,
  acquirePm2FallbackRetirementLocks,
  inspectPm2ClosureForRetirement,
} from './pm2-fallback-retirement.mjs';

export const PM2_ROOT_RECOVERED_ATTESTATION_SCHEMA =
  'nexus.pm2-root-install-recovered.v1';
export const PM2_ROOT_ATTESTATION_RECOVERY_PLAN_SCHEMA =
  'nexus.pm2-root-attestation-recovery-plan.v1';

const HEX_64 = /^[0-9a-f]{64}$/u;
const VERSION = /^\d+\.\d+\.\d+$/u;

export class Pm2RootAttestationRecoveryRefusal extends Error {
  constructor(message, code = 'recovery_refused') {
    super(message);
    this.name = 'Pm2RootAttestationRecoveryRefusal';
    this.code = code;
  }
}

function refuse(message, code) {
  throw new Pm2RootAttestationRecoveryRefusal(message, code);
}

function modeOf(stat) {
  return stat.mode & 0o7777;
}

function requireAbsent(file, fsApi = fs) {
  try {
    fsApi.lstatSync(file);
    refuse(`recovery-conflicting evidence exists: ${file}`, 'conflicting_state');
  } catch (error) {
    if (error instanceof Pm2RootAttestationRecoveryRefusal) throw error;
    if (error?.code !== 'ENOENT') refuse(`recovery evidence is unreadable: ${file}`, 'unsafe_state');
  }
}

function readRegular(file, {
  fsApi = fs,
  ownerUid = 0,
  ownerGid = 0,
  mode,
  maxBytes = 64 * 1024 * 1024,
} = {}) {
  let stat;
  let descriptor;
  try {
    stat = fsApi.lstatSync(file);
  } catch {
    refuse(`required PM2 recovery file is missing: ${file}`, 'missing_evidence');
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
      || stat.uid !== ownerUid || stat.gid !== ownerGid || modeOf(stat) !== mode
      || stat.size < 1 || stat.size > maxBytes) {
    refuse(`required PM2 recovery file is unsafe: ${file}`, 'unsafe_state');
  }
  try {
    descriptor = fsApi.openSync(
      file,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const opened = fsApi.fstatSync(descriptor);
    if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.nlink !== 1
        || opened.uid !== ownerUid || opened.gid !== ownerGid
        || modeOf(opened) !== mode || opened.size !== stat.size) {
      refuse(`required PM2 recovery file changed while it was opened: ${file}`,
        'artifact_changed');
    }
    const bytes = fsApi.readFileSync(descriptor);
    const after = fsApi.fstatSync(descriptor);
    const pathAfter = fsApi.lstatSync(file);
    if (after.dev !== opened.dev || after.ino !== opened.ino
        || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs
        || after.ctimeMs !== opened.ctimeMs
        || pathAfter.dev !== opened.dev || pathAfter.ino !== opened.ino) {
      refuse(`required PM2 recovery file changed while it was read: ${file}`,
        'artifact_changed');
    }
    return bytes;
  } catch (error) {
    if (error instanceof Pm2RootAttestationRecoveryRefusal) throw error;
    refuse(`required PM2 recovery file could not be read safely: ${file}`,
      'artifact_changed');
  } finally {
    if (descriptor !== undefined) fsApi.closeSync(descriptor);
  }
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    refuse(`${label} is malformed`, 'malformed_evidence');
  }
}

function exact(value, keys, label) {
  try {
    return exactKeys(value, keys, label);
  } catch {
    refuse(`${label} fields do not match the governed schema`, 'malformed_evidence');
  }
}

function compare(left, right, message) {
  if (canonicalJson(left) !== canonicalJson(right)) refuse(message, 'artifact_changed');
}

function lockPackagesFrom(lock) {
  if (lock?.lockfileVersion !== 3 || !lock.packages || typeof lock.packages !== 'object') {
    refuse('PM2 trusted lock identity is invalid', 'malformed_evidence');
  }
  const packages = [];
  for (const [packagePath, identity] of Object.entries(lock.packages)) {
    if (!packagePath) continue;
    if (typeof identity !== 'object' || identity === null
        || (String(identity.resolved ?? '').startsWith('https://')
          && (!identity.version || !identity.integrity))) {
      refuse('PM2 trusted lock package identity is invalid', 'malformed_evidence');
    }
    packages.push({
      path: packagePath,
      version: identity.version ?? null,
      resolved: identity.resolved ?? null,
      integrity: identity.integrity ?? null,
    });
  }
  packages.sort((left, right) => left.path.localeCompare(right.path));
  return packages;
}

function inspectManifest({ closureRoot, inspection, trustedLockBytes, fsApi, ownerUid, ownerGid }) {
  const manifestPath = path.join(closureRoot, 'closure-manifest.json');
  const manifest = parseJson(readRegular(manifestPath, {
    fsApi, ownerUid, ownerGid, mode: 0o644,
  }), 'PM2 closure manifest');
  exact(manifest, [
    'schema', 'pm2Version', 'nodeVersion', 'npmVersion', 'packageLockSha256',
    'packageLockPackages', 'installedPackages', 'payloadDigest', 'fileCount', 'files',
  ], 'PM2 closure manifest');
  if (manifest.schema !== 'nexus.pm2-root-closure-manifest.v1'
      || !VERSION.test(manifest.pm2Version ?? '')
      || manifest.nodeVersion !== 'v22.23.1' || manifest.npmVersion !== '10.9.8'
      || manifest.packageLockSha256 !== sha256(trustedLockBytes)
      || !Array.isArray(manifest.files) || !Array.isArray(manifest.installedPackages)
      || !Number.isSafeInteger(manifest.fileCount) || manifest.fileCount < 1) {
    refuse('PM2 closure manifest identity is invalid', 'malformed_evidence');
  }
  const payloadFiles = inspection.entries
    .filter((entry) => entry.kind === 'file' && entry.path !== 'closure-manifest.json')
    .map(({ path: filePath, size, mode, sha256: digest }) => ({
      path: filePath, size, mode, sha256: digest,
    }));
  compare(manifest.files, payloadFiles, 'installed PM2 files differ from the exact closure manifest');
  const payloadDigest = sha256(canonicalJson({
    schema: 'nexus.pm2-root-closure-payload.v1', files: payloadFiles,
  }));
  if (manifest.fileCount !== payloadFiles.length || manifest.payloadDigest !== payloadDigest) {
    refuse('installed PM2 payload digest differs from its manifest', 'artifact_changed');
  }
  const trustedLock = parseJson(trustedLockBytes, 'PM2 trusted lock');
  const lockPackages = lockPackagesFrom(trustedLock);
  compare(manifest.packageLockPackages, lockPackages,
    'PM2 closure manifest differs from the trusted exact lock');
  const installedPackages = [];
  for (const identity of lockPackages) {
    const packageFile = path.join(closureRoot, identity.path, 'package.json');
    let bytes;
    try {
      bytes = readRegular(packageFile, { fsApi, ownerUid, ownerGid, mode: 0o644 });
    } catch (error) {
      if (trustedLock.packages[identity.path]?.optional === true
          && error?.code === 'missing_evidence') continue;
      throw error;
    }
    const installed = parseJson(bytes, 'PM2 installed package identity');
    if (installed.version !== identity.version) {
      refuse('PM2 installed package differs from the trusted exact lock', 'artifact_changed');
    }
    installedPackages.push({ path: identity.path, version: identity.version });
  }
  compare(manifest.installedPackages, installedPackages,
    'PM2 installed package set differs from the exact closure manifest');
  return { manifest, payloadDigest, fileCount: payloadFiles.length + 1 };
}

export function inspectPm2RootAttestationRecovery({
  paths = DEFAULT_PM2_FALLBACK_RETIREMENT_PATHS,
  fsApi = fs,
  ownerUid = 0,
  ownerGid = 0,
  nodePath = '/usr/bin/node',
  spawn = spawnSync,
} = {}) {
  for (const file of [
    paths.pm2Attestation, paths.pm2InstallJournal, paths.journal, paths.tombstone,
  ]) requireAbsent(file, fsApi);
  const prefix = fsApi.lstatSync(paths.pm2Prefix);
  if (!prefix.isDirectory() || prefix.isSymbolicLink()
      || prefix.uid !== ownerUid || prefix.gid !== ownerGid || modeOf(prefix) !== 0o755) {
    refuse('PM2 root package prefix is unsafe', 'unsafe_state');
  }
  const versions = fsApi.readdirSync(paths.pm2Prefix).sort();
  if (versions.length !== 1 || !VERSION.test(versions[0])) {
    refuse('PM2 root package prefix is not an exact single closure', 'unknown_pm2_authority');
  }
  const version = versions[0];
  const closureRoot = path.join(paths.pm2Prefix, version);
  const inspection = inspectPm2ClosureForRetirement(closureRoot, {
    fsApi, ownerUid, ownerGid,
  });
  const trustedLockBytes = readRegular(paths.pm2Lock, {
    fsApi, ownerUid, ownerGid, mode: 0o644,
  });
  const closureLockBytes = readRegular(path.join(closureRoot, 'package-lock.json'), {
    fsApi, ownerUid, ownerGid, mode: 0o644,
  });
  if (!trustedLockBytes.equals(closureLockBytes)) {
    refuse('installed PM2 package lock differs from the trusted exact lock', 'artifact_changed');
  }
  const { manifest, payloadDigest, fileCount } = inspectManifest({
    closureRoot, inspection, trustedLockBytes, fsApi, ownerUid, ownerGid,
  });
  if (manifest.pm2Version !== version) {
    refuse('installed PM2 version differs from the exact closure manifest', 'artifact_changed');
  }
  const pm2Package = parseJson(readRegular(
    path.join(closureRoot, 'node_modules/pm2/package.json'),
    { fsApi, ownerUid, ownerGid, mode: 0o644 },
  ), 'PM2 package identity');
  if (pm2Package.name !== 'pm2' || pm2Package.version !== version) {
    refuse('installed PM2 package identity is invalid', 'artifact_changed');
  }
  const entrypoint = `${closureRoot}/node_modules/pm2/bin/pm2`;
  readRegular(entrypoint, { fsApi, ownerUid, ownerGid, mode: 0o755 });
  const launcherBytes = readRegular(paths.pm2Launcher, {
    fsApi, ownerUid, ownerGid, mode: 0o755, maxBytes: 4096,
  });
  const expectedLauncher = Buffer.from(
    `#!/usr/bin/bash\nexec ${JSON.stringify(nodePath)} ${JSON.stringify(entrypoint)} "$@"\n`,
  );
  if (!launcherBytes.equals(expectedLauncher)) {
    refuse('PM2 root launcher differs from the governed exact launcher', 'artifact_changed');
  }
  const nodeBytes = readRegular(nodePath, {
    fsApi, ownerUid, ownerGid, mode: 0o755, maxBytes: 256 * 1024 * 1024,
  });
  const nodeVersion = spawn(nodePath, ['--version'], {
    encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
  });
  if (nodeVersion.status !== 0 || nodeVersion.stdout.trim() !== 'v22.23.1') {
    refuse('PM2 root Node runtime identity is invalid', 'artifact_changed');
  }
  const attestationCore = {
    version,
    recoveryMethod: 'exact-installed-closure',
    closureDigest: inspection.sha256,
    payloadDigest,
    packageLockSha256: sha256(trustedLockBytes),
    fileCount,
    closureRoot,
    launcher: paths.pm2Launcher,
    launcherSha256: sha256(launcherBytes),
    entrypoint,
    node: { path: nodePath, version: 'v22.23.1', sha256: sha256(nodeBytes) },
  };
  const plan = { schema: PM2_ROOT_ATTESTATION_RECOVERY_PLAN_SCHEMA, ...attestationCore };
  return {
    status: 'eligible',
    schema: PM2_ROOT_ATTESTATION_RECOVERY_PLAN_SCHEMA,
    confirmation: sha256(canonicalJson(plan)),
    plan,
  };
}

function fsyncDirectory(directory, fsApi = fs) {
  const descriptor = fsApi.openSync(directory, 'r');
  try { fsApi.fsyncSync(descriptor); } finally { fsApi.closeSync(descriptor); }
}

export function recoverPm2RootAttestation({
  confirm,
  ownerAuthorized = false,
  now = () => new Date(),
  paths = DEFAULT_PM2_FALLBACK_RETIREMENT_PATHS,
  fsApi = fs,
  ownerUid = 0,
  ownerGid = 0,
  nodePath = '/usr/bin/node',
  spawn = spawnSync,
  acquireLocks = acquirePm2FallbackRetirementLocks,
} = {}) {
  if (ownerAuthorized !== true) refuse('owner authorization is required', 'owner_authorization_required');
  const releaseLocks = acquireLocks({ paths });
  try {
    const inspected = inspectPm2RootAttestationRecovery({
      paths, fsApi, ownerUid, ownerGid, nodePath, spawn,
    });
    if (!HEX_64.test(confirm ?? '') || confirm !== inspected.confirmation) {
      refuse('PM2 attestation recovery confirmation does not match live state',
        'confirmation_mismatch');
    }
    const attestedAt = now().toISOString();
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(attestedAt)) {
      refuse('PM2 attestation recovery clock is invalid', 'clock_untrusted');
    }
    const attestation = {
      schema: PM2_ROOT_RECOVERED_ATTESTATION_SCHEMA,
      ...Object.fromEntries(Object.entries(inspected.plan).filter(([key]) => key !== 'schema')),
      attestedAt,
    };
    const directory = path.dirname(paths.pm2Attestation);
    const directoryStat = fsApi.lstatSync(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()
        || directoryStat.uid !== ownerUid || directoryStat.gid !== ownerGid
        || modeOf(directoryStat) !== 0o700) {
      refuse('PM2 attestation recovery directory is unsafe', 'unsafe_state');
    }
    const temporary = path.join(directory, `.pm2-root-attestation-recovery-${process.pid}`);
    const attestationBytes = Buffer.from(`${JSON.stringify(attestation, null, 2)}\n`);
    let descriptor;
    try {
      descriptor = fsApi.openSync(temporary, 'wx', 0o600);
      fsApi.writeFileSync(descriptor, attestationBytes);
      fsApi.fsyncSync(descriptor);
      fsApi.closeSync(descriptor);
      descriptor = undefined;
      fsApi.chownSync(temporary, ownerUid, ownerGid);
      fsApi.chmodSync(temporary, 0o600);
      fsApi.linkSync(temporary, paths.pm2Attestation);
      fsApi.unlinkSync(temporary);
      fsyncDirectory(directory, fsApi);
    } catch (error) {
      if (descriptor !== undefined) fsApi.closeSync(descriptor);
      try { fsApi.unlinkSync(temporary); } catch {}
      if (error?.code === 'EEXIST') {
        refuse('PM2 attestation recovery state changed', 'conflicting_state');
      }
      throw error;
    }
    return {
      status: 'recovered',
      schema: PM2_ROOT_RECOVERED_ATTESTATION_SCHEMA,
      version: attestation.version,
      attestationSha256: sha256(attestationBytes),
    };
  } finally {
    releaseLocks();
  }
}
