import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';

const MAX_EVIDENCE_BYTES = 128 * 1024;
const BACKUP_SCHEMA = 'nexus.local-backup.v1';
const RESTORE_SCHEMA = 'nexus.local-backup-restore-verification.v1';
const SHA256 = /^[0-9a-f]{64}$/u;
const CANONICAL_UTC = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3,6}))?Z$/u;
const BACKUP_RECEIPT_FIELDS = Object.freeze([
  'schema',
  'status',
  'kind',
  'database',
  'backupRoot',
  'startedAt',
  'completedAt',
  'encryptedSha256',
  'encryptedSizeBytes',
  'installed',
  'retention',
  'plaintextSha256',
  'plaintextSizeBytes',
  'integrityCheck',
  'foreignKeyCheck',
]);
const RESTORE_RECEIPT_FIELDS = Object.freeze([
  'schema',
  'status',
  'backup',
  'encryptedSha256',
  'verifiedAt',
  'plaintextSha256',
  'plaintextSizeBytes',
  'integrityCheck',
  'foreignKeyCheck',
]);
const RETENTION = Object.freeze({
  hourly: 24,
  daily: 30,
  weekly: 4,
  'pre-promotion': 10,
});
const BACKUP_CONFIG_KEYS = Object.freeze([
  'NEXUS_LOCAL_BACKUP_DATABASE_PATH',
  'NEXUS_LOCAL_BACKUP_ROOT',
  'NEXUS_LOCAL_BACKUP_AGE_RECIPIENT',
  'NEXUS_LOCAL_BACKUP_AGE_IDENTITY',
]);
export const BACKUP_HEARTBEAT_MAX_AGE_SECONDS = 2 * 60 * 60;
export const RESTORE_HEARTBEAT_MAX_AGE_SECONDS = 8 * 24 * 60 * 60;

export class BackupLivenessError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BackupLivenessError';
    this.code = code;
  }
}

function refuse(code, message) {
  throw new BackupLivenessError(code, message);
}

function assertPathBelow(root, candidate, label) {
  const normalizedRoot = path.resolve(root);
  const normalized = path.resolve(candidate);
  if (normalizedRoot === '/' || normalized === normalizedRoot
      || !normalized.startsWith(`${normalizedRoot}${path.sep}`)) {
    refuse('backup_evidence_invalid', `${label} is outside the governed backup root`);
  }
  return normalized;
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameSnapshot(left, right) {
  return sameIdentity(left, right)
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function reassertPathSnapshot(binding, {
  fsImpl = fs,
} = {}) {
  try {
    const current = fsImpl.lstatSync(binding.file);
    if (!sameSnapshot(binding.metadata, current)) {
      refuse('backup_evidence_invalid', `${binding.label} changed during relational proof`);
    }
  } catch (error) {
    if (error instanceof BackupLivenessError) throw error;
    refuse('backup_evidence_invalid', `${binding.label} could not be rechecked safely`);
  }
}

function hasExactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function assertDirectoryMetadata(metadata, label, expectedUid, expectedGid) {
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.nlink < 1
      || metadata.uid !== expectedUid || metadata.gid !== expectedGid
      || (metadata.mode & 0o777) !== 0o700) {
    refuse('backup_evidence_invalid', `${label} has unsafe directory metadata`);
  }
}

function bindTrustedDirectoryChain(anchor, directory, label, {
  fsImpl = fs,
  expectedUid = 0,
  expectedGid = 0,
  finalMode = 0o700,
} = {}) {
  const normalizedAnchor = path.resolve(anchor);
  const normalizedDirectory = path.resolve(directory);
  const relative = path.relative(normalizedAnchor, normalizedDirectory);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    refuse('backup_policy_invalid', `${label} escapes its trusted anchor`);
  }
  const paths = [normalizedAnchor];
  let current = normalizedAnchor;
  if (relative) {
    for (const component of relative.split(path.sep)) {
      current = path.join(current, component);
      paths.push(current);
    }
  }
  try {
    return paths.map((candidate, index) => {
      const metadata = fsImpl.lstatSync(candidate);
      if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.nlink < 1
          || metadata.uid !== expectedUid || metadata.gid !== expectedGid
          || (metadata.mode & 0o022) !== 0
          || (finalMode !== null && index === paths.length - 1
            && (metadata.mode & 0o777) !== finalMode)) {
        refuse('backup_evidence_invalid', `${label} has an unsafe ancestor`);
      }
      return { directory: candidate, metadata };
    });
  } catch (error) {
    if (error instanceof BackupLivenessError) throw error;
    refuse('backup_evidence_invalid', `${label} could not be bound safely`);
  }
}

function reassertTrustedDirectoryChain(bindings, label, {
  fsImpl = fs,
  expectedUid = 0,
  expectedGid = 0,
  finalMode = 0o700,
} = {}) {
  try {
    for (const [index, binding] of bindings.entries()) {
      const metadata = fsImpl.lstatSync(binding.directory);
      if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.nlink < 1
          || metadata.uid !== expectedUid || metadata.gid !== expectedGid
          || (metadata.mode & 0o022) !== 0
          || (finalMode !== null && index === bindings.length - 1
            && (metadata.mode & 0o777) !== finalMode)
          || !sameIdentity(binding.metadata, metadata)) {
        refuse('backup_evidence_invalid', `${label} changed during proof`);
      }
    }
  } catch (error) {
    if (error instanceof BackupLivenessError) throw error;
    refuse('backup_evidence_invalid', `${label} could not be rechecked safely`);
  }
}

function directoryChain(root, parent, label) {
  const normalizedRoot = path.resolve(root);
  const normalizedParent = path.resolve(parent);
  const relative = path.relative(normalizedRoot, normalizedParent);
  if (normalizedRoot === '/' || relative === '..' || relative.startsWith(`..${path.sep}`)
      || path.isAbsolute(relative)) {
    refuse('backup_evidence_invalid', `${label} parent is outside the governed backup root`);
  }
  const directories = [normalizedRoot];
  if (relative !== '') {
    let current = normalizedRoot;
    for (const component of relative.split(path.sep)) {
      current = path.join(current, component);
      directories.push(current);
    }
  }
  return directories;
}

function bindDirectoryChains(root, parents, label, {
  fsImpl = fs,
  expectedUid = 0,
  expectedGid = 0,
} = {}) {
  const directories = [...new Set(
    parents.flatMap((parent) => directoryChain(root, parent, label)),
  )];
  try {
    return directories.map((directory) => {
      const metadata = fsImpl.lstatSync(directory);
      assertDirectoryMetadata(metadata, `${label} directory`, expectedUid, expectedGid);
      return { directory, metadata };
    });
  } catch (error) {
    if (error instanceof BackupLivenessError) throw error;
    refuse('backup_evidence_invalid', `${label} directory chain could not be bound safely`);
  }
}

function reassertDirectoryChains(bindings, label, {
  fsImpl = fs,
  expectedUid = 0,
  expectedGid = 0,
} = {}) {
  try {
    for (const binding of bindings) {
      const metadata = fsImpl.lstatSync(binding.directory);
      assertDirectoryMetadata(metadata, `${label} directory`, expectedUid, expectedGid);
      if (!sameIdentity(binding.metadata, metadata)) {
        refuse('backup_evidence_invalid', `${label} directory changed during read`);
      }
    }
  } catch (error) {
    if (error instanceof BackupLivenessError) throw error;
    refuse('backup_evidence_invalid', `${label} directory chain could not be rechecked safely`);
  }
}

function assertEvidenceMetadata(metadata, label, expectedUid, expectedGid) {
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
      || metadata.uid !== expectedUid || metadata.gid !== expectedGid
      || (metadata.mode & 0o777) !== 0o600
      || metadata.size <= 0 || metadata.size > MAX_EVIDENCE_BYTES) {
    refuse('backup_evidence_invalid', `${label} has unsafe metadata`);
  }
}

function bindHeldBackupLock(root, descriptor, {
  fsImpl = fs,
  expectedUid = 0,
  expectedGid = 0,
} = {}) {
  if (!Number.isSafeInteger(descriptor) || descriptor < 3) {
    refuse('backup_evidence_invalid', 'held backup lock descriptor is absent');
  }
  const lockPath = path.join(root, '.backup.lock');
  try {
    const held = fsImpl.fstatSync(descriptor);
    const named = fsImpl.lstatSync(lockPath);
    for (const metadata of [held, named]) {
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
          || metadata.uid !== expectedUid || metadata.gid !== expectedGid
          || (metadata.mode & 0o777) !== 0o600 || metadata.size !== 0) {
        refuse('backup_evidence_invalid', 'backup lock has unsafe metadata');
      }
    }
    if (!sameSnapshot(held, named)) {
      refuse('backup_evidence_invalid', 'held backup lock and path disagree');
    }
    return { path: lockPath, metadata: held };
  } catch (error) {
    if (error instanceof BackupLivenessError) throw error;
    refuse('backup_evidence_invalid', 'backup lock could not be descriptor-bound');
  }
}

function reassertHeldBackupLock(binding, descriptor, options) {
  const current = bindHeldBackupLock(path.dirname(binding.path), descriptor, options);
  if (!sameSnapshot(binding.metadata, current.metadata)) {
    refuse('backup_evidence_invalid', 'held backup lock changed during proof');
  }
}

function readBoundJson(file, label, {
  fsImpl = fs,
  expectedUid = 0,
  expectedGid = 0,
} = {}) {
  let descriptor;
  try {
    descriptor = fsImpl.openSync(
      file,
      fs.constants.O_RDONLY | fs.constants.O_CLOEXEC | fs.constants.O_NOFOLLOW,
    );
    const opened = fsImpl.fstatSync(descriptor);
    const before = fsImpl.lstatSync(file);
    assertEvidenceMetadata(opened, label, expectedUid, expectedGid);
    assertEvidenceMetadata(before, label, expectedUid, expectedGid);
    if (!sameSnapshot(opened, before)) {
      refuse('backup_evidence_invalid', `${label} changed identity before read`);
    }
    const body = fsImpl.readFileSync(descriptor, 'utf8');
    const after = fsImpl.lstatSync(file);
    assertEvidenceMetadata(after, label, expectedUid, expectedGid);
    if (!sameSnapshot(opened, after)) {
      refuse('backup_evidence_invalid', `${label} changed identity during read`);
    }
    try {
      return {
        value: JSON.parse(body),
        binding: { file, metadata: opened, label },
      };
    } catch {
      refuse('backup_evidence_invalid', `${label} is not valid JSON`);
    }
  } catch (error) {
    if (error instanceof BackupLivenessError) throw error;
    refuse('backup_evidence_invalid', `${label} could not be read safely`);
  } finally {
    if (descriptor !== undefined) fsImpl.closeSync(descriptor);
  }
}

function readBoundDigest(file, label, {
  fsImpl = fs,
  expectedUid = 0,
  expectedGid = 0,
} = {}) {
  let descriptor;
  try {
    descriptor = fsImpl.openSync(
      file,
      fs.constants.O_RDONLY | fs.constants.O_CLOEXEC | fs.constants.O_NOFOLLOW,
    );
    const opened = fsImpl.fstatSync(descriptor);
    const before = fsImpl.lstatSync(file);
    if (!opened.isFile() || opened.isSymbolicLink() || opened.nlink !== 1
        || opened.uid !== expectedUid || opened.gid !== expectedGid
        || (opened.mode & 0o777) !== 0o600 || opened.size <= 0
        || !before.isFile() || before.isSymbolicLink() || before.nlink !== 1
        || before.uid !== expectedUid || before.gid !== expectedGid
        || (before.mode & 0o777) !== 0o600
        || !sameSnapshot(opened, before)) {
      refuse('backup_evidence_invalid', `${label} has unsafe metadata`);
    }
    const digest = crypto.createHash('sha256');
    const block = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (offset < opened.size) {
      const read = fsImpl.readSync(
        descriptor,
        block,
        0,
        Math.min(block.length, opened.size - offset),
        offset,
      );
      if (read <= 0) refuse('backup_evidence_invalid', `${label} ended during read`);
      digest.update(block.subarray(0, read));
      offset += read;
    }
    const after = fsImpl.lstatSync(file);
    if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1
        || after.uid !== expectedUid || after.gid !== expectedGid
        || (after.mode & 0o777) !== 0o600 || after.size !== opened.size
        || !sameSnapshot(opened, after)) {
      refuse('backup_evidence_invalid', `${label} changed during read`);
    }
    return {
      digest: digest.digest('hex'),
      size: opened.size,
      binding: { file, metadata: opened, label },
    };
  } catch (error) {
    if (error instanceof BackupLivenessError) throw error;
    refuse('backup_evidence_invalid', `${label} could not be read safely`);
  } finally {
    if (descriptor !== undefined) fsImpl.closeSync(descriptor);
  }
}

function readBoundChecksum(file, artifact, artifactDigest, label, {
  fsImpl = fs,
  expectedUid = 0,
  expectedGid = 0,
} = {}) {
  const expected = Buffer.from(`${artifactDigest}  ${path.basename(artifact)}\n`, 'ascii');
  let descriptor;
  try {
    descriptor = fsImpl.openSync(
      file,
      fs.constants.O_RDONLY | fs.constants.O_CLOEXEC | fs.constants.O_NOFOLLOW,
    );
    const opened = fsImpl.fstatSync(descriptor);
    const before = fsImpl.lstatSync(file);
    for (const metadata of [opened, before]) {
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
          || metadata.uid !== expectedUid || metadata.gid !== expectedGid
          || (metadata.mode & 0o777) !== 0o600 || metadata.size !== expected.length) {
        refuse('backup_evidence_invalid', `${label} has unsafe metadata`);
      }
    }
    if (!sameSnapshot(opened, before)) {
      refuse('backup_evidence_invalid', `${label} changed identity before read`);
    }
    const body = fsImpl.readFileSync(descriptor);
    const after = fsImpl.lstatSync(file);
    if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1
        || after.uid !== expectedUid || after.gid !== expectedGid
        || (after.mode & 0o777) !== 0o600 || after.size !== expected.length
        || !sameSnapshot(opened, after)) {
      refuse('backup_evidence_invalid', `${label} changed during read`);
    }
    if (!Buffer.isBuffer(body) || !body.equals(expected)) {
      refuse('backup_evidence_invalid', `${label} is not the canonical artifact checksum`);
    }
    return { file, metadata: opened, label };
  } catch (error) {
    if (error instanceof BackupLivenessError) throw error;
    refuse('backup_evidence_invalid', `${label} could not be read safely`);
  } finally {
    if (descriptor !== undefined) fsImpl.closeSync(descriptor);
  }
}

function readBoundPrivateBytes(file, label, {
  fsImpl = fs,
  expectedUid = 0,
  expectedGid = 0,
  maxBytes = 16 * 1024,
} = {}) {
  let descriptor;
  try {
    descriptor = fsImpl.openSync(
      file,
      fs.constants.O_RDONLY | fs.constants.O_CLOEXEC | fs.constants.O_NOFOLLOW,
    );
    const opened = fsImpl.fstatSync(descriptor);
    const before = fsImpl.lstatSync(file);
    for (const metadata of [opened, before]) {
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
          || metadata.uid !== expectedUid || metadata.gid !== expectedGid
          || (metadata.mode & 0o777) !== 0o600
          || metadata.size <= 0 || metadata.size > maxBytes) {
        refuse('backup_evidence_invalid', `${label} has unsafe metadata`);
      }
    }
    if (!sameSnapshot(opened, before)) {
      refuse('backup_evidence_invalid', `${label} changed identity before read`);
    }
    const body = fsImpl.readFileSync(descriptor);
    const after = fsImpl.lstatSync(file);
    if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1
        || after.uid !== expectedUid || after.gid !== expectedGid
        || (after.mode & 0o777) !== 0o600
        || after.size !== opened.size || !sameSnapshot(opened, after)) {
      refuse('backup_evidence_invalid', `${label} changed during read`);
    }
    return { body: Buffer.isBuffer(body) ? body : Buffer.from(body), metadata: opened };
  } catch (error) {
    if (error instanceof BackupLivenessError) throw error;
    refuse('backup_evidence_invalid', `${label} could not be read safely`);
  } finally {
    if (descriptor !== undefined) fsImpl.closeSync(descriptor);
  }
}

function parseBackupConfig(bytes) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    refuse('backup_evidence_invalid', 'backup config is not UTF-8');
  }
  const result = {};
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) refuse('backup_evidence_invalid', 'backup config is malformed');
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (!BACKUP_CONFIG_KEYS.includes(key) || Object.hasOwn(result, key) || value.length === 0) {
      refuse('backup_evidence_invalid', 'backup config has unsupported fields');
    }
    result[key] = value;
  }
  if (!hasExactKeys(result, BACKUP_CONFIG_KEYS)) {
    refuse('backup_evidence_invalid', 'backup config is incomplete');
  }
  return result;
}

function proveAgeIdentity({
  backupConfigPath,
  ageIdentityPath,
  ageKeygenBin,
  backupRoot,
  expectedDatabase,
  fsImpl,
  expectedUid,
  expectedGid,
  execImpl,
  credentialTrustAnchor,
  ageKeygenTrustAnchor,
}) {
  if (path.basename(backupConfigPath) !== 'backup.env'
      || path.basename(ageIdentityPath) !== 'age-identity.txt'
      || path.dirname(backupConfigPath) !== path.dirname(ageIdentityPath)
      || !path.isAbsolute(ageKeygenBin)) {
    refuse('backup_policy_invalid', 'backup credential proof paths are invalid');
  }
  const credentialRoot = path.dirname(backupConfigPath);
  const directoryOptions = { fsImpl, expectedUid, expectedGid };
  const credentialDirectories = bindTrustedDirectoryChain(
    credentialTrustAnchor,
    credentialRoot,
    'backup credential evidence',
    directoryOptions,
  );
  const configBinding = readBoundPrivateBytes(backupConfigPath, 'backup config', {
    ...directoryOptions,
  });
  const config = parseBackupConfig(configBinding.body);
  if (config.NEXUS_LOCAL_BACKUP_DATABASE_PATH !== expectedDatabase
      || config.NEXUS_LOCAL_BACKUP_ROOT !== backupRoot
      || config.NEXUS_LOCAL_BACKUP_AGE_IDENTITY !== ageIdentityPath
      || !/^age1[0-9a-z]{20,100}$/u.test(config.NEXUS_LOCAL_BACKUP_AGE_RECIPIENT)) {
    refuse('backup_evidence_invalid', 'backup config does not match governed recovery policy');
  }
  let identityDescriptor;
  let binaryDescriptor;
  const binaryDirectoryOptions = {
    ...directoryOptions,
    finalMode: null,
  };
  const binaryDirectories = bindTrustedDirectoryChain(
    ageKeygenTrustAnchor,
    path.dirname(ageKeygenBin),
    'age-keygen executable path',
    binaryDirectoryOptions,
  );
  let identitySnapshot;
  let binarySnapshot;
  try {
    identityDescriptor = fsImpl.openSync(
      ageIdentityPath,
      fs.constants.O_RDONLY | fs.constants.O_CLOEXEC | fs.constants.O_NOFOLLOW,
    );
    const openedIdentity = fsImpl.fstatSync(identityDescriptor);
    const namedIdentity = fsImpl.lstatSync(ageIdentityPath);
    for (const identity of [openedIdentity, namedIdentity]) {
      if (!identity.isFile() || identity.isSymbolicLink() || identity.nlink !== 1
          || identity.uid !== expectedUid || identity.gid !== expectedGid
          || (identity.mode & 0o777) !== 0o600
          || identity.size <= 0 || identity.size > 16 * 1024) {
        refuse('backup_evidence_invalid', 'age identity is unsafe');
      }
    }
    if (!sameSnapshot(openedIdentity, namedIdentity)) {
      refuse('backup_evidence_invalid', 'age identity is unsafe');
    }
    identitySnapshot = openedIdentity;
    binaryDescriptor = fsImpl.openSync(
      ageKeygenBin,
      fs.constants.O_RDONLY | fs.constants.O_CLOEXEC | fs.constants.O_NOFOLLOW,
    );
    const openedBinary = fsImpl.fstatSync(binaryDescriptor);
    const namedBinary = fsImpl.lstatSync(ageKeygenBin);
    for (const binary of [openedBinary, namedBinary]) {
      if (!binary.isFile() || binary.isSymbolicLink() || binary.nlink !== 1
          || binary.uid !== expectedUid || binary.gid !== expectedGid
          || (binary.mode & 0o022) !== 0 || (binary.mode & 0o111) === 0) {
        refuse('backup_evidence_invalid', 'age-keygen binary is unsafe');
      }
    }
    if (!sameSnapshot(openedBinary, namedBinary)) {
      refuse('backup_evidence_invalid', 'age-keygen binary is unsafe');
    }
    binarySnapshot = openedBinary;
    const derivation = execImpl('/proc/self/fd/4', ['-y', '/proc/self/fd/3'], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', HOME: '/var/lib/nexus-release/home' },
      stdio: ['ignore', 'pipe', 'pipe', identityDescriptor, binaryDescriptor],
      timeout: 10_000,
      maxBuffer: 4096,
    });
    const derivedRecipient = typeof derivation?.stdout === 'string'
      ? derivation.stdout.trim()
      : '';
    const boundedStderr = typeof derivation?.stderr === 'string' && derivation.stderr.length <= 4096;
    if (derivation?.status !== 0 || !boundedStderr || derivedRecipient.length > 256
        || derivedRecipient.includes('\n')
        || derivedRecipient.includes('\r')
        || derivedRecipient !== config.NEXUS_LOCAL_BACKUP_AGE_RECIPIENT) {
      refuse('backup_evidence_invalid', 'age identity does not match the configured recipient');
    }
    const afterConfig = fsImpl.lstatSync(backupConfigPath);
    const afterIdentityPath = fsImpl.lstatSync(ageIdentityPath);
    const afterIdentityDescriptor = fsImpl.fstatSync(identityDescriptor);
    const afterBinaryPath = fsImpl.lstatSync(ageKeygenBin);
    const afterBinaryDescriptor = fsImpl.fstatSync(binaryDescriptor);
    if (!sameSnapshot(configBinding.metadata, afterConfig)
        || !identitySnapshot
        || !sameSnapshot(identitySnapshot, afterIdentityPath)
        || !sameSnapshot(identitySnapshot, afterIdentityDescriptor)
        || !binarySnapshot
        || !sameSnapshot(binarySnapshot, afterBinaryPath)
        || !sameSnapshot(binarySnapshot, afterBinaryDescriptor)) {
      refuse('backup_evidence_invalid', 'age identity changed during recipient derivation');
    }
    reassertTrustedDirectoryChain(
      credentialDirectories,
      'backup credential evidence',
      directoryOptions,
    );
    reassertTrustedDirectoryChain(
      binaryDirectories,
      'age-keygen executable path',
      binaryDirectoryOptions,
    );
  } catch (error) {
    if (error instanceof BackupLivenessError) throw error;
    refuse('backup_evidence_invalid', 'age identity recipient derivation failed');
  } finally {
    if (identityDescriptor !== undefined) fsImpl.closeSync(identityDescriptor);
    if (binaryDescriptor !== undefined) fsImpl.closeSync(binaryDescriptor);
  }
}

function timestampMilliseconds(timestamp, label) {
  if (typeof timestamp !== 'string') {
    refuse('backup_evidence_invalid', `${label} timestamp is not canonical UTC`);
  }
  const match = CANONICAL_UTC.exec(timestamp);
  if (!match) refuse('backup_evidence_invalid', `${label} timestamp is not canonical UTC`);
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) {
    refuse('backup_evidence_invalid', `${label} timestamp is invalid`);
  }
  const observed = new Date(parsed);
  const expected = match.slice(1, 7).map(Number);
  const actual = [
    observed.getUTCFullYear(),
    observed.getUTCMonth() + 1,
    observed.getUTCDate(),
    observed.getUTCHours(),
    observed.getUTCMinutes(),
    observed.getUTCSeconds(),
  ];
  if (actual.some((value, index) => value !== expected[index])) {
    refuse('backup_evidence_invalid', `${label} timestamp has an impossible calendar date`);
  }
  return parsed;
}

function ageSeconds(timestamp, nowMs, maximum, staleCode, label) {
  const parsed = timestampMilliseconds(timestamp, label);
  const age = Math.floor((nowMs - parsed) / 1000);
  if (age < 0) refuse('backup_evidence_invalid', `${label} is future-dated`);
  if (age > maximum) refuse(staleCode, `${label} is stale`);
  return age;
}

function exactRetention(value) {
  return hasExactKeys(value, Object.keys(RETENTION))
    && Object.entries(RETENTION).every(([tier, count]) => value[tier] === count);
}

function producerArtifactNames(startedAt) {
  const date = new Date(timestampMilliseconds(startedAt, 'backup startedAt'));
  const compactDate = date.toISOString().slice(0, 10).replaceAll('-', '');
  const compactTime = date.toISOString().slice(11, 19).replaceAll(':', '');
  const thursday = new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
  ));
  const day = thursday.getUTCDay() || 7;
  thursday.setUTCDate(thursday.getUTCDate() + 4 - day);
  const isoYear = thursday.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.ceil((((thursday - yearStart) / 86_400_000) + 1) / 7);
  return {
    hourly: `nexus-db-${compactDate}T${compactTime}Z.sqlite.age`,
    daily: `nexus-db-${compactDate}.sqlite.age`,
    weekly: `nexus-db-${isoYear}-W${String(week).padStart(2, '0')}.sqlite.age`,
    'pre-promotion': `nexus-db-${compactDate}T${compactTime}Z.sqlite.age`,
  };
}

function installedPaths(receipt, root) {
  const tiers = receipt.kind === 'pre-promotion'
    ? ['pre-promotion']
    : ['hourly', 'daily', 'weekly'];
  if (!hasExactKeys(receipt.installed, tiers)) {
    refuse('backup_evidence_invalid', 'backup receipt installed tiers are invalid');
  }
  const patterns = {
    hourly: /^nexus-db-\d{8}T\d{6}Z\.sqlite\.age$/u,
    daily: /^nexus-db-\d{8}\.sqlite\.age$/u,
    weekly: /^nexus-db-\d{4}-W\d{2}\.sqlite\.age$/u,
    'pre-promotion': /^nexus-db-\d{8}T\d{6}Z\.sqlite\.age$/u,
  };
  const governed = {};
  const expectedNames = producerArtifactNames(receipt.startedAt);
  for (const tier of tiers) {
    if (typeof receipt.installed[tier] !== 'string') {
      refuse('backup_evidence_invalid', 'backup receipt installed path is invalid');
    }
    const candidate = assertPathBelow(root, receipt.installed[tier], `${tier} backup artifact`);
    if (path.dirname(candidate) !== path.join(root, tier)
        || !patterns[tier].test(path.basename(candidate))
        || path.basename(candidate) !== expectedNames[tier]) {
      refuse('backup_evidence_invalid', 'backup receipt installed path has the wrong tier shape');
    }
    governed[tier] = candidate;
  }
  return governed;
}

function pathExistsWithoutFollowing(file, label, { fsImpl = fs } = {}) {
  try {
    fsImpl.lstatSync(file);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return false;
    refuse('backup_evidence_invalid', `${label} could not be inspected safely`);
  }
}

export function inspectBackupLiveness({
  policy,
  now = () => Date.now(),
  fsImpl = fs,
  expectedUid = 0,
  expectedGid = 0,
  backupConfigPath = '/etc/nexus-local-backup/backup.env',
  ageIdentityPath = '/etc/nexus-local-backup/age-identity.txt',
  ageKeygenBin = '/usr/bin/age-keygen',
  execImpl = spawnSync,
  credentialTrustAnchor = '/',
  ageKeygenTrustAnchor = '/',
  backupTrustAnchor = '/',
  backupLockDescriptor = Number(process.env.NEXUS_RELEASE_BACKUP_LOCK_FD),
} = {}) {
  const backup = policy?.backup;
  if (!backup || typeof backup !== 'object') {
    refuse('backup_policy_invalid', 'backup policy is missing');
  }
  const {
    root,
    receiptPath,
    expectedDatabase,
  } = backup;
  if (![root, receiptPath, expectedDatabase]
    .every((value) => typeof value === 'string' && path.isAbsolute(value))) {
    refuse('backup_policy_invalid', 'backup liveness paths must be absolute');
  }
  const governedReceipt = assertPathBelow(root, receiptPath, 'backup receipt');
  const restoreVerificationReceiptPath = path.join(
    root,
    'state',
    'last-restore-verification.json',
  );
  const governedRestore = assertPathBelow(
    root,
    restoreVerificationReceiptPath,
    'restore verification receipt',
  );
  const directoryOptions = { fsImpl, expectedUid, expectedGid };
  const backupLockBinding = bindHeldBackupLock(
    root,
    backupLockDescriptor,
    directoryOptions,
  );
  const backupRootDirectories = bindTrustedDirectoryChain(
    backupTrustAnchor,
    root,
    'governed backup root',
    directoryOptions,
  );
  const stateDirectories = bindDirectoryChains(
    root,
    [path.dirname(governedReceipt), path.dirname(governedRestore)],
    'backup state evidence',
    directoryOptions,
  );
  const backupReceiptRead = readBoundJson(governedReceipt, 'backup receipt', {
    fsImpl,
    expectedUid,
    expectedGid,
  });
  const backupReceipt = backupReceiptRead.value;
  reassertDirectoryChains(
    stateDirectories,
    'backup state evidence',
    directoryOptions,
  );
  if (!hasExactKeys(backupReceipt, BACKUP_RECEIPT_FIELDS)
      || backupReceipt.schema !== BACKUP_SCHEMA || backupReceipt.status !== 'passed'
      || !['backup', 'pre-promotion'].includes(backupReceipt.kind)
      || backupReceipt.database !== expectedDatabase
      || backupReceipt.backupRoot !== root
      || typeof backupReceipt.encryptedSha256 !== 'string'
      || !SHA256.test(backupReceipt.encryptedSha256)
      || !isPositiveInteger(backupReceipt.encryptedSizeBytes)
      || typeof backupReceipt.plaintextSha256 !== 'string'
      || !SHA256.test(backupReceipt.plaintextSha256)
      || !isPositiveInteger(backupReceipt.plaintextSizeBytes)
      || backupReceipt.integrityCheck !== 'ok'
      || backupReceipt.foreignKeyCheck !== 'ok'
      || !exactRetention(backupReceipt.retention)) {
    refuse('backup_evidence_invalid', 'backup receipt shape is invalid');
  }
  const startedAt = timestampMilliseconds(backupReceipt.startedAt, 'backup startedAt');
  const completedAt = timestampMilliseconds(backupReceipt.completedAt, 'backup completedAt');
  if (completedAt < startedAt) {
    refuse('backup_evidence_invalid', 'backup completedAt predates startedAt');
  }
  proveAgeIdentity({
    backupConfigPath,
    ageIdentityPath,
    ageKeygenBin,
    backupRoot: root,
    expectedDatabase,
    fsImpl,
    expectedUid,
    expectedGid,
    execImpl,
    credentialTrustAnchor,
    ageKeygenTrustAnchor,
  });
  const governedInstalled = installedPaths(backupReceipt, root);
  const selectedTier = backupReceipt.kind === 'pre-promotion' ? 'pre-promotion' : 'hourly';
  const selectedBackup = governedInstalled[selectedTier];
  const selectedChecksum = `${selectedBackup}.sha256`;
  const backupDirectories = bindDirectoryChains(
    root,
    [path.dirname(selectedBackup), path.dirname(selectedChecksum)],
    'backup artifact evidence',
    directoryOptions,
  );
  const backupArtifact = readBoundDigest(selectedBackup, 'backup artifact', {
    fsImpl,
    expectedUid,
    expectedGid,
  });
  const backupChecksumBinding = readBoundChecksum(
    selectedChecksum,
    selectedBackup,
    backupArtifact.digest,
    'backup artifact checksum',
    { fsImpl, expectedUid, expectedGid },
  );
  reassertDirectoryChains(
    backupDirectories,
    'backup artifact evidence',
    directoryOptions,
  );
  reassertDirectoryChains(
    stateDirectories,
    'backup state evidence',
    directoryOptions,
  );
  if (backupArtifact.digest !== backupReceipt.encryptedSha256
      || backupArtifact.size !== backupReceipt.encryptedSizeBytes) {
    refuse('backup_evidence_invalid', 'backup artifact digest does not match its receipt');
  }

  const restoreReceiptRead = readBoundJson(governedRestore, 'restore verification receipt', {
    fsImpl,
    expectedUid,
    expectedGid,
  });
  const restoreReceipt = restoreReceiptRead.value;
  reassertDirectoryChains(
    stateDirectories,
    'backup state evidence',
    directoryOptions,
  );
  if (!hasExactKeys(restoreReceipt, RESTORE_RECEIPT_FIELDS)
      || restoreReceipt.schema !== RESTORE_SCHEMA || restoreReceipt.status !== 'passed'
      || typeof restoreReceipt.encryptedSha256 !== 'string'
      || !SHA256.test(restoreReceipt.encryptedSha256)
      || typeof restoreReceipt.plaintextSha256 !== 'string'
      || !SHA256.test(restoreReceipt.plaintextSha256)
      || !isPositiveInteger(restoreReceipt.plaintextSizeBytes)
      || restoreReceipt.integrityCheck !== 'ok'
      || restoreReceipt.foreignKeyCheck !== 'ok'
      || typeof restoreReceipt.backup !== 'string') {
    refuse('backup_evidence_invalid', 'restore verification receipt shape is invalid');
  }
  const restoredBackup = assertPathBelow(root, restoreReceipt.backup, 'verified backup artifact');
  if (path.dirname(restoredBackup) !== path.join(root, 'hourly')
      || !/^nexus-db-\d{8}T\d{6}Z\.sqlite\.age$/u.test(path.basename(restoredBackup))) {
    refuse('backup_evidence_invalid', 'restore verification is not for a governed hourly backup');
  }
  const restoreDirectories = bindDirectoryChains(
    root,
    [path.dirname(restoredBackup)],
    'restore artifact evidence',
    directoryOptions,
  );
  // Hourly retention may legitimately prune the artifact that a still-fresh
  // weekly restore verification inspected. The immutable verification receipt
  // remains the liveness authority in that case. If the artifact is still
  // present, however, bind and hash it so drift cannot hide behind the receipt.
  let restoredDigest = restoreReceipt.encryptedSha256;
  let restoredArtifactBinding = null;
  let restoredChecksumBinding = null;
  const restoredChecksum = `${restoredBackup}.sha256`;
  const restoredArtifactExists = pathExistsWithoutFollowing(
    restoredBackup,
    'verified backup artifact',
    { fsImpl },
  );
  const restoredChecksumExists = pathExistsWithoutFollowing(
    restoredChecksum,
    'verified backup artifact checksum',
    { fsImpl },
  );
  const restorePairWasAbsent = !restoredArtifactExists;
  if (restoredArtifactExists !== restoredChecksumExists) {
    refuse('backup_evidence_invalid', 'verified backup artifact/checksum pair is incomplete');
  }
  if (restoredArtifactExists) {
    const restoredArtifact = readBoundDigest(restoredBackup, 'verified backup artifact', {
      fsImpl,
      expectedUid,
      expectedGid,
    });
    restoredArtifactBinding = restoredArtifact.binding;
    restoredDigest = restoredArtifact.digest;
    restoredChecksumBinding = readBoundChecksum(
      restoredChecksum,
      restoredBackup,
      restoredDigest,
      'verified backup artifact checksum',
      { fsImpl, expectedUid, expectedGid },
    );
    if (restoredDigest !== restoreReceipt.encryptedSha256) {
      refuse('backup_evidence_invalid', 'verified backup digest does not match its receipt');
    }
  }
  reassertDirectoryChains(
    restoreDirectories,
    'restore artifact evidence',
    directoryOptions,
  );
  reassertDirectoryChains(
    backupDirectories,
    'backup artifact evidence',
    directoryOptions,
  );
  reassertDirectoryChains(
    stateDirectories,
    'backup state evidence',
    directoryOptions,
  );
  reassertTrustedDirectoryChain(
    backupRootDirectories,
    'governed backup root',
    directoryOptions,
  );
  reassertHeldBackupLock(
    backupLockBinding,
    backupLockDescriptor,
    directoryOptions,
  );
  for (const binding of [
    backupReceiptRead.binding,
    backupArtifact.binding,
    backupChecksumBinding,
    restoreReceiptRead.binding,
    restoredArtifactBinding,
    restoredChecksumBinding,
  ]) {
    if (binding) reassertPathSnapshot(binding, { fsImpl });
  }
  if (restorePairWasAbsent && (pathExistsWithoutFollowing(
    restoredBackup,
    'verified backup artifact',
    { fsImpl },
  ) || pathExistsWithoutFollowing(
    restoredChecksum,
    'verified backup artifact checksum',
    { fsImpl },
  ))) {
    refuse('backup_evidence_invalid', 'pruned restore evidence changed during proof');
  }

  const observedAt = now();
  if (!Number.isFinite(observedAt)) refuse('backup_policy_invalid', 'clock is invalid');
  return {
    schema: 'nexus.release-backup-liveness.v1',
    backup: {
      ageSeconds: ageSeconds(
        backupReceipt.completedAt,
        observedAt,
        BACKUP_HEARTBEAT_MAX_AGE_SECONDS,
        'backup_receipt_stale',
        'last successful backup',
      ),
      completedAt: backupReceipt.completedAt,
      encryptedSha256: backupArtifact.digest,
    },
    restoreVerification: {
      ageSeconds: ageSeconds(
        restoreReceipt.verifiedAt,
        observedAt,
        RESTORE_HEARTBEAT_MAX_AGE_SECONDS,
        'restore_verification_stale',
        'last restore verification',
      ),
      verifiedAt: restoreReceipt.verifiedAt,
      encryptedSha256: restoredDigest,
    },
  };
}
