import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { defaultExec } from './release-registry.mjs';
import { assertBackupEvidenceShape, sanitizeDetail } from './release-state-store.mjs';

/**
 * Pre-migration backup.
 *
 * This reuses the existing root-owned `nexus-local-backup-pre-promotion.service`
 * rather than introducing a second backup implementation: it already produces an
 * encrypted artifact with the retention and restore-verification the security
 * runbook describes.
 *
   * Verification is receipt-based, not directory-based. The backup unit publishes
   * `<backupRoot>/state/last-success.json` describing exactly what it wrote — the
   * source database, the tier, the encrypted artifact, its SHA-256, its size and
   * the producer start/completion times. Scanning a directory and taking the
   * newest filename cannot distinguish an encrypted artifact from a checksum
   * sidecar or a stale file from an unrelated tier, and it cannot prove the backup
   * covers the database this release is about to migrate.
 *
 * The backup is operator recovery evidence. It is deliberately **not** an
 * automatic rollback input — a rollback restores the predecessor images and
 * leaves the database alone, because reinstating an older database would discard
 * writes users made after the migration. So a missing or failed backup stops the
 * release *before* production is touched.
 */

export const PRE_MIGRATION_BACKUP_UNIT = 'nexus-local-backup-pre-promotion.service';
export const BACKUP_RECEIPT_SCHEMA = 'nexus.local-backup.v1';
export const PRE_MIGRATION_BACKUP_KIND = 'pre-promotion';

const MAX_RECEIPT_BYTES = 64 * 1024;
const BACKUP_HASH_CHUNK_BYTES = 1024 * 1024;
const CANONICAL_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/;
const HEX_SHA256 = /^[0-9a-f]{64}$/;
const BACKUP_RECEIPT_FIELDS = Object.freeze([
  'schema', 'status', 'kind', 'database', 'backupRoot', 'startedAt', 'completedAt',
  'encryptedSha256', 'encryptedSizeBytes', 'installed', 'retention',
  'plaintextSha256', 'plaintextSizeBytes', 'integrityCheck', 'foreignKeyCheck',
]);
const PRODUCER_RETENTION = Object.freeze({
  hourly: 24,
  daily: 30,
  weekly: 4,
  'pre-promotion': 10,
});

function exactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function strictTimestamp(value) {
  if (typeof value !== 'string') return null;
  const match = CANONICAL_TIMESTAMP.exec(value);
  if (!match) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  const date = new Date(parsed);
  const expected = match.slice(1, 7).map(Number);
  const actual = [
    date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(),
    date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(),
  ];
  return actual.every((part, index) => part === expected[index]) ? parsed : null;
}

function producerPrePromotionPath(root, startedAt) {
  const parsed = strictTimestamp(startedAt);
  if (parsed === null) return null;
  const value = new Date(parsed).toISOString();
  const name = `nexus-db-${value.slice(0, 10).replaceAll('-', '')}T${value
    .slice(11, 19).replaceAll(':', '')}Z.sqlite.age`;
  return path.join(root, PRE_MIGRATION_BACKUP_KIND, name);
}

export function createReleaseBackup({
  policy,
  exec = defaultExec,
  systemctlBin = process.env.NEXUS_RELEASE_SYSTEMCTL_BIN || '/usr/bin/systemctl',
  now = () => Date.now(),
  log = () => {},
  fileSystem = fs,
  expectedUid = 0,
  expectedGid = 0,
  backupTrustAnchor = '/',
}) {
  const backupRoot = policy.backup?.root;
  const receiptPath = policy.backup?.receiptPath;
  const maxAgeSeconds = Number(policy.backup?.maxReceiptAgeSeconds ?? 900);

  if (typeof backupRoot !== 'string' || !path.isAbsolute(backupRoot)) {
    throw new Error('backup root must be an absolute path');
  }
  if (typeof receiptPath !== 'string' || !path.isAbsolute(receiptPath)) {
    throw new Error('backup receipt path must be an absolute path');
  }

  function sameStatValue(left, right) {
    return String(left) === String(right);
  }

  function sameFileIdentity(left, right) {
    return sameStatValue(left.dev, right.dev) && sameStatValue(left.ino, right.ino);
  }

  function statTimestamp(stat, nanosecondField, millisecondField) {
    if (stat[nanosecondField] !== undefined) return String(stat[nanosecondField]);
    return String(stat[millisecondField]);
  }

  function sameArtifactSnapshot(left, right) {
    return sameFileIdentity(left, right)
      && sameStatValue(left.size, right.size)
      && sameStatValue(left.nlink, right.nlink)
      && statTimestamp(left, 'mtimeNs', 'mtimeMs')
        === statTimestamp(right, 'mtimeNs', 'mtimeMs')
      && statTimestamp(left, 'ctimeNs', 'ctimeMs')
        === statTimestamp(right, 'ctimeNs', 'ctimeMs');
  }

  function permissionBits(metadata) {
    return Number(metadata.mode) & 0o777;
  }

  function assertDirectoryAuthority(metadata, { privateDirectory }) {
    if (!metadata.isDirectory() || metadata.isSymbolicLink?.() || Number(metadata.nlink) < 1) {
      throw new Error('unsafe directory type');
    }
    if (privateDirectory) {
      if (!sameStatValue(metadata.uid, expectedUid)
          || !sameStatValue(metadata.gid, expectedGid)
          || permissionBits(metadata) !== 0o700) {
        throw new Error('unsafe private directory metadata');
      }
    } else if (![0, expectedUid].some((uid) => sameStatValue(metadata.uid, uid))
        || (permissionBits(metadata) & 0o022) !== 0) {
      throw new Error('unsafe ancestor directory metadata');
    }
  }

  function bindDirectoryAuthority(anchor, target, privateDirectories) {
    const normalizedAnchor = path.resolve(anchor);
    const normalizedTarget = path.resolve(target);
    const relative = path.relative(normalizedAnchor, normalizedTarget);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('directory authority escapes anchor');
    }
    const paths = [normalizedAnchor];
    let current = normalizedAnchor;
    if (relative) {
      for (const component of relative.split(path.sep)) {
        current = path.join(current, component);
        paths.push(current);
      }
    }
    const bindings = [];
    try {
      for (const candidate of paths) {
        const descriptor = fileSystem.openSync(
          candidate,
          fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
        );
        const opened = fileSystem.fstatSync(descriptor, { bigint: true });
        const named = fileSystem.lstatSync(candidate, { bigint: true });
        const privateDirectory = privateDirectories.includes(path.resolve(candidate));
        assertDirectoryAuthority(opened, { privateDirectory });
        assertDirectoryAuthority(named, { privateDirectory });
        if (!sameFileIdentity(opened, named)) throw new Error('directory path and fd disagree');
        bindings.push({ candidate, descriptor, metadata: opened, privateDirectory });
      }
      return bindings;
    } catch (error) {
      for (const binding of bindings.reverse()) fileSystem.closeSync(binding.descriptor);
      throw error;
    }
  }

  function reassertDirectoryAuthority(bindings) {
    for (const binding of bindings) {
      const opened = fileSystem.fstatSync(binding.descriptor, { bigint: true });
      const named = fileSystem.lstatSync(binding.candidate, { bigint: true });
      assertDirectoryAuthority(opened, binding);
      assertDirectoryAuthority(named, binding);
      if (!sameFileIdentity(opened, binding.metadata)
          || !sameFileIdentity(named, binding.metadata)) {
        throw new Error('directory authority changed');
      }
    }
  }

  function closeDirectoryAuthority(bindings) {
    for (const binding of [...bindings].reverse()) fileSystem.closeSync(binding.descriptor);
  }

  function isWithinRoot(candidate, root) {
    const relative = path.relative(root, candidate);
    return relative === '' || (
      relative !== '..'
      && !path.isAbsolute(relative)
      && !relative.startsWith(`..${path.sep}`)
    );
  }

  /**
   * Linux exposes the canonical name of an already-open file through procfs.
   * That binds containment to the descriptor being hashed instead of resolving
   * the attacker-controlled receipt path a second time. The identity-checked
   * fallback keeps local macOS verification fail-closed without weakening the
   * Linux host path.
   */
  function resolveOpenedPath(fd, namespacePath, openedStat) {
    const descriptorPath = `/proc/self/fd/${fd}`;
    try {
      const resolved = fileSystem.realpathSync(descriptorPath);
      const descriptorStat = fileSystem.statSync(descriptorPath, {
        bigint: typeof openedStat.dev === 'bigint',
      });
      if (!sameFileIdentity(descriptorStat, openedStat)) {
        throw new Error('descriptor identity mismatch');
      }
      return resolved;
    } catch (error) {
      // The production host is Linux. If procfs cannot prove descriptor
      // identity there, do not downgrade to a pathname-based decision.
      if (process.platform !== 'darwin') throw error;
      // macOS has no procfs-backed descriptor pathname. Resolve the namespace
      // entry only as a fallback, then prove that it still names this exact fd.
      const resolved = fileSystem.realpathSync(namespacePath);
      const resolvedStat = fileSystem.statSync(resolved, {
        bigint: typeof openedStat.dev === 'bigint',
      });
      if (!sameFileIdentity(resolvedStat, openedStat)) {
        throw new Error('opened path identity mismatch');
      }
      return resolved;
    }
  }

  function expectedDatabase(environment) {
    const target = policy.environments[environment];
    return target ? path.join(target.dataDir, 'bot.db') : null;
  }

  /** Hash the already-open artifact without allocating its full database size. */
  function hashOpenedArtifact(fd, artifactSize) {
    const digest = createHash('sha256');
    const chunk = Buffer.allocUnsafe(Math.min(BACKUP_HASH_CHUNK_BYTES, artifactSize));
    let position = 0;
    while (position < artifactSize) {
      const wanted = Math.min(chunk.length, artifactSize - position);
      const bytesRead = fileSystem.readSync(fd, chunk, 0, wanted, position);
      if (!Number.isSafeInteger(bytesRead) || bytesRead <= 0 || bytesRead > wanted) {
        throw new Error('backup artifact ended during verification');
      }
      digest.update(chunk.subarray(0, bytesRead));
      position += bytesRead;
    }
    return digest.digest('hex');
  }

  /**
   * Verify the exact immutable artifact identity already persisted in release
   * write-ahead state. This deliberately does not read `last-success.json`: that
   * pointer may legitimately advance to an hourly backup while crash recovery
   * still needs the pre-migration artifact accepted by the interrupted release.
   *
   * Freshness and pre-promotion kind remain admission properties enforced by
   * `readBackupReceipt`; this recovery verifier proves that the exact admitted
   * path and bytes still exist without reinterpreting a mutable pointer.
   */
  function verifyBackupEvidence({ environment, evidence }) {
    let expected;
    try {
      expected = assertBackupEvidenceShape(evidence, 'persisted backup evidence');
    } catch {
      return { ok: false, detail: 'persisted backup evidence is incomplete' };
    }

    const wanted = expectedDatabase(environment);
    if (!wanted) {
      return { ok: false, detail: sanitizeDetail(`unknown environment ${environment}`) };
    }
    if (path.resolve(expected.database) !== path.resolve(wanted)) {
      return {
        ok: false,
        detail: sanitizeDetail(`backup covers a different database than ${wanted}`),
      };
    }

    let rootBindings = [];
    try {
      rootBindings = bindDirectoryAuthority(
        backupTrustAnchor,
        backupRoot,
        [path.resolve(backupRoot)],
      );
    } catch {
      return { ok: false, detail: 'governed backup root ancestor chain is unsafe' };
    }
    let rootFd;
    let tierFd;
    try {
      rootFd = fileSystem.openSync(
        backupRoot,
        fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
      );
    } catch (error) {
      try {
        closeDirectoryAuthority(rootBindings);
      } catch {
        // The verification verdict is already fail-closed; cleanup must not
        // turn an unavailable root into an accepted proof.
      }
      if (error?.code === 'ELOOP' || error?.code === 'ENOTDIR') {
        return { ok: false, detail: 'governed backup root is not a non-symlink directory' };
      }
      return { ok: false, detail: 'governed backup root could not be opened' };
    }

    let verificationResult;
    let finalAuthorityChanged = false;
    let tierIdentity;
    try {
      verificationResult = (() => {
        let rootStat;
      let rootPathStat;
      let resolvedRoot;
      try {
        rootStat = fileSystem.fstatSync(rootFd, { bigint: true });
        rootPathStat = fileSystem.lstatSync(backupRoot, { bigint: true });
        resolvedRoot = resolveOpenedPath(rootFd, backupRoot, rootStat);
      } catch {
        return { ok: false, detail: 'governed backup root identity could not be resolved' };
      }
      if (!rootStat.isDirectory()
          || rootPathStat.isSymbolicLink()
          || !rootPathStat.isDirectory()
          || !sameFileIdentity(rootPathStat, rootStat)
          || !sameStatValue(rootStat.nlink, rootPathStat.nlink)
          || !sameStatValue(rootStat.uid, expectedUid)
          || !sameStatValue(rootStat.gid, expectedGid)
          || permissionBits(rootStat) !== 0o700
          || permissionBits(rootPathStat) !== 0o700) {
        return { ok: false, detail: 'governed backup root identity is invalid' };
      }

      const artifactPath = expected.artifactPath;
      const expectedArtifactPath = producerPrePromotionPath(backupRoot, expected.startedAt);
      if (expectedArtifactPath === null || path.resolve(artifactPath) !== path.resolve(expectedArtifactPath)) {
        return { ok: false, detail: 'backup artifact path does not match producer topology' };
      }
      const tierPath = path.join(backupRoot, PRE_MIGRATION_BACKUP_KIND);
      try {
        tierFd = fileSystem.openSync(
          tierPath,
          fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
        );
        const tierStat = fileSystem.fstatSync(tierFd, { bigint: true });
        const tierPathStat = fileSystem.lstatSync(tierPath, { bigint: true });
        if (!tierStat.isDirectory() || tierPathStat.isSymbolicLink()
            || !tierPathStat.isDirectory() || !sameFileIdentity(tierStat, tierPathStat)
            || !sameStatValue(tierStat.uid, rootStat.uid)
            || !sameStatValue(tierStat.gid, rootStat.gid)
            || permissionBits(tierStat) !== 0o700
            || permissionBits(tierPathStat) !== 0o700) {
          return { ok: false, detail: 'backup pre-promotion tier identity is invalid' };
        }
        tierIdentity = tierStat;
      } catch {
        return { ok: false, detail: 'backup pre-promotion tier could not be descriptor-bound' };
      }
      let artifactFd;
      let checksumFd;
      try {
        artifactFd = fileSystem.openSync(
          artifactPath,
          fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
        );
      } catch (error) {
        if (error?.code === 'ELOOP') {
          return { ok: false, detail: 'backup artifact is not a regular file' };
        }
        return { ok: false, detail: 'backup artifact named by the evidence is missing' };
      }
      try {
        let artifactStat;
        try {
          artifactStat = fileSystem.fstatSync(artifactFd, { bigint: true });
        } catch {
          return { ok: false, detail: 'backup artifact descriptor could not be inspected' };
        }
        if (!artifactStat.isFile()) {
          return { ok: false, detail: 'backup artifact is not a regular file' };
        }
        if (!sameStatValue(artifactStat.nlink, 1)) {
          return { ok: false, detail: 'backup artifact link count must be exactly one' };
        }
        if (!sameStatValue(artifactStat.uid, rootStat.uid)
            || !sameStatValue(artifactStat.gid, rootStat.gid)
            || permissionBits(artifactStat) !== 0o600) {
          return { ok: false, detail: 'backup artifact ownership or mode is unsafe' };
        }
        if (!sameStatValue(artifactStat.size, expected.encryptedSizeBytes)) {
          return { ok: false, detail: 'backup artifact size does not match its evidence' };
        }

        // Resolve both sides from descriptors held for the whole verification.
        // A mutable root pathname can no longer redefine the trust boundary after
        // the artifact has been opened.
        let resolvedArtifact;
        try {
          resolvedArtifact = resolveOpenedPath(artifactFd, artifactPath, artifactStat);
        } catch {
          return { ok: false, detail: 'backup artifact descriptor identity could not be resolved' };
        }
        if (!isWithinRoot(resolvedArtifact, resolvedRoot)) {
          return { ok: false, detail: 'backup artifact resolves outside the governed backup root' };
        }

        const checksumPath = `${artifactPath}.sha256`;
        try {
          checksumFd = fileSystem.openSync(
            checksumPath,
            fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
          );
        } catch (error) {
          if (error?.code === 'ELOOP') {
            return { ok: false, detail: 'backup checksum is not a regular file' };
          }
          return { ok: false, detail: 'backup checksum companion is missing' };
        }
        let checksumStat;
        let resolvedChecksum;
        try {
          checksumStat = fileSystem.fstatSync(checksumFd, { bigint: true });
          resolvedChecksum = resolveOpenedPath(checksumFd, checksumPath, checksumStat);
        } catch {
          return { ok: false, detail: 'backup checksum identity could not be resolved' };
        }
        const expectedChecksum = Buffer.from(
          `${expected.encryptedSha256}  ${path.basename(artifactPath)}\n`,
          'ascii',
        );
        if (!checksumStat.isFile() || !sameStatValue(checksumStat.nlink, 1)
            || !sameStatValue(checksumStat.uid, rootStat.uid)
            || !sameStatValue(checksumStat.gid, rootStat.gid)
            || permissionBits(checksumStat) !== 0o600
            || !sameStatValue(checksumStat.size, expectedChecksum.length)) {
          return { ok: false, detail: 'backup checksum metadata is unsafe' };
        }
        if (!isWithinRoot(resolvedChecksum, resolvedRoot)
            || path.dirname(resolvedChecksum) !== path.dirname(resolvedArtifact)) {
          return { ok: false, detail: 'backup checksum resolves outside its artifact directory' };
        }

        let observedSha256;
        let confirmedSha256;
        try {
          // Two complete positioned passes close the already-hashed-chunk race:
          // a writer cannot change earlier bytes in place and leave a stale first
          // digest as the only content proof.
          observedSha256 = hashOpenedArtifact(artifactFd, expected.encryptedSizeBytes);
          confirmedSha256 = hashOpenedArtifact(artifactFd, expected.encryptedSizeBytes);
        } catch {
          return { ok: false, detail: 'backup artifact could not be read for verification' };
        }
        if (observedSha256 !== expected.encryptedSha256) {
          return { ok: false, detail: 'backup artifact digest does not match its evidence' };
        }
        if (confirmedSha256 !== observedSha256) {
          return { ok: false, detail: 'backup artifact changed during verification' };
        }
        try {
          const checksumBytes = Buffer.alloc(expectedChecksum.length);
          const bytesRead = fileSystem.readSync(
            checksumFd,
            checksumBytes,
            0,
            checksumBytes.length,
            0,
          );
          if (bytesRead !== expectedChecksum.length || !checksumBytes.equals(expectedChecksum)) {
            return { ok: false, detail: 'backup checksum is not canonical' };
          }
        } catch {
          return { ok: false, detail: 'backup checksum could not be read for verification' };
        }

        // Refuse mutation or namespace replacement of either side. BigInt stats
        // retain nanosecond mtime/ctime where Node exposes them; the second digest
        // remains the content proof on injected/macOS filesystems that return
        // ordinary Stats instead.
        let currentArtifactDescriptorStat;
        let currentArtifactPathStat;
        let currentRootDescriptorStat;
        let currentRootPathStat;
        let currentChecksumDescriptorStat;
        let currentChecksumPathStat;
        try {
          currentArtifactDescriptorStat = fileSystem.fstatSync(artifactFd, { bigint: true });
          currentArtifactPathStat = fileSystem.lstatSync(artifactPath, { bigint: true });
          currentRootDescriptorStat = fileSystem.fstatSync(rootFd, { bigint: true });
          currentRootPathStat = fileSystem.lstatSync(backupRoot, { bigint: true });
          currentChecksumDescriptorStat = fileSystem.fstatSync(checksumFd, { bigint: true });
          currentChecksumPathStat = fileSystem.lstatSync(checksumPath, { bigint: true });
        } catch {
          return { ok: false, detail: 'backup artifact or governed root identity changed during verification' };
        }
        if (!sameArtifactSnapshot(currentArtifactDescriptorStat, artifactStat)
            || currentArtifactPathStat.isSymbolicLink()
            || !currentArtifactPathStat.isFile()
            || !sameArtifactSnapshot(currentArtifactPathStat, artifactStat)
            || !sameStatValue(currentArtifactDescriptorStat.nlink, 1)
            || !sameStatValue(currentArtifactPathStat.nlink, 1)
            || !sameFileIdentity(currentRootDescriptorStat, rootStat)
            || !currentRootDescriptorStat.isDirectory()
            || currentRootPathStat.isSymbolicLink()
            || !currentRootPathStat.isDirectory()
            || !sameFileIdentity(currentRootPathStat, rootStat)) {
          return { ok: false, detail: 'backup artifact or governed root identity changed during verification' };
        }
        if (!sameArtifactSnapshot(currentChecksumDescriptorStat, checksumStat)
            || currentChecksumPathStat.isSymbolicLink()
            || !currentChecksumPathStat.isFile()
            || !sameArtifactSnapshot(currentChecksumPathStat, checksumStat)
            || !sameStatValue(currentChecksumDescriptorStat.nlink, 1)
            || !sameStatValue(currentChecksumPathStat.nlink, 1)) {
          return { ok: false, detail: 'backup checksum identity changed during verification' };
        }
        try {
          reassertDirectoryAuthority(rootBindings);
          const currentTierDescriptor = fileSystem.fstatSync(tierFd, { bigint: true });
          const currentTierPath = fileSystem.lstatSync(tierPath, { bigint: true });
          assertDirectoryAuthority(currentTierDescriptor, { privateDirectory: true });
          assertDirectoryAuthority(currentTierPath, { privateDirectory: true });
          if (!sameFileIdentity(currentTierDescriptor, currentTierPath)) {
            throw new Error('tier descriptor and path disagree');
          }
        } catch {
          return { ok: false, detail: 'backup directory authority changed during verification' };
        }

        return { ok: true, detail: null, ...expected };
      } finally {
        if (checksumFd !== undefined) {
          try {
            fileSystem.closeSync(checksumFd);
          } catch {
            // Verification already failed closed on the bound checksum identity.
          }
        }
        try {
          fileSystem.closeSync(artifactFd);
        } catch {
          // Verification is already bound to the descriptor identity and bytes.
        }
      }
      })();
      try {
        // This is deliberately outside the result-producing body. A mutation
        // after its last in-scope check must replace a pending success verdict,
        // while descriptor cleanup below must not replace either verdict.
        reassertDirectoryAuthority(rootBindings);
        if (tierFd !== undefined && tierIdentity !== undefined) {
          const currentTierDescriptor = fileSystem.fstatSync(tierFd, { bigint: true });
          const tierPath = path.join(backupRoot, PRE_MIGRATION_BACKUP_KIND);
          const currentTierPath = fileSystem.lstatSync(tierPath, { bigint: true });
          assertDirectoryAuthority(currentTierDescriptor, { privateDirectory: true });
          assertDirectoryAuthority(currentTierPath, { privateDirectory: true });
          if (!sameFileIdentity(currentTierDescriptor, tierIdentity)
              || !sameFileIdentity(currentTierPath, tierIdentity)) {
            throw new Error('tier authority changed');
          }
        }
      } catch {
        finalAuthorityChanged = true;
      }
    } finally {
      if (tierFd !== undefined) {
        try {
          fileSystem.closeSync(tierFd);
        } catch {
          // The tier identity is rechecked through the retained root/artifact proof.
        }
      }
      try {
        fileSystem.closeSync(rootFd);
      } catch {
        // Closing cannot redirect the root identity used for the completed proof.
      }
      try {
        closeDirectoryAuthority(rootBindings);
      } catch {
        // Closing retained descriptors cannot strengthen or weaken the proof.
      }
    }
    if (finalAuthorityChanged) {
      return { ok: false, detail: 'backup directory authority changed during verification' };
    }
    return verificationResult;
  }

  /**
   * Read and fully validate the backup receipt. Every field the release depends
   * on is checked, and the artifact is confirmed to exist with the recorded size
   * and digest — a receipt that describes a file that is gone is not evidence.
   */
  function readBackupReceipt({ environment, notBeforeMs }) {
    if (!receiptPath) {
      return { ok: false, detail: 'backup receipt path is not configured' };
    }
    if (path.resolve(receiptPath) !== path.resolve(
      path.join(backupRoot, 'state', 'last-success.json'),
    )) {
      return { ok: false, detail: 'backup receipt path does not match producer topology' };
    }
    let stateBindings = [];
    try {
      stateBindings = bindDirectoryAuthority(
        backupTrustAnchor,
        path.dirname(receiptPath),
        [path.resolve(backupRoot), path.resolve(path.dirname(receiptPath))],
      );
    } catch {
      return { ok: false, detail: 'backup receipt directory authority is unsafe' };
    }
    let receiptFd;
    let receipt;
    try {
      receiptFd = fileSystem.openSync(
        receiptPath,
        fs.constants.O_RDONLY | fs.constants.O_CLOEXEC | fs.constants.O_NOFOLLOW,
      );
      const opened = fileSystem.fstatSync(receiptFd, { bigint: true });
      const named = fileSystem.lstatSync(receiptPath, { bigint: true });
      if (!opened.isFile() || named.isSymbolicLink() || !named.isFile()
          || !sameArtifactSnapshot(opened, named)
          || !sameStatValue(opened.nlink, 1) || !sameStatValue(named.nlink, 1)
          || !sameStatValue(opened.uid, expectedUid) || !sameStatValue(named.uid, expectedUid)
          || !sameStatValue(opened.gid, expectedGid) || !sameStatValue(named.gid, expectedGid)
          || permissionBits(opened) !== 0o600 || permissionBits(named) !== 0o600
          || Number(opened.size) <= 0 || Number(opened.size) > MAX_RECEIPT_BYTES) {
        return { ok: false, detail: 'backup receipt is not a private bounded regular file' };
      }
      receipt = JSON.parse(fileSystem.readFileSync(receiptFd, 'utf8'));
      const afterDescriptor = fileSystem.fstatSync(receiptFd, { bigint: true });
      const afterPath = fileSystem.lstatSync(receiptPath, { bigint: true });
      if (!sameArtifactSnapshot(opened, afterDescriptor)
          || !sameArtifactSnapshot(opened, afterPath)) {
        return { ok: false, detail: 'backup receipt changed during verification' };
      }
      reassertDirectoryAuthority(stateBindings);
    } catch (error) {
      if (error instanceof SyntaxError) {
        return { ok: false, detail: 'backup receipt is not valid json' };
      }
      return { ok: false, detail: 'backup receipt is missing' };
    } finally {
      if (receiptFd !== undefined) fileSystem.closeSync(receiptFd);
      closeDirectoryAuthority(stateBindings);
    }

    if (!exactKeys(receipt, BACKUP_RECEIPT_FIELDS)) {
      return { ok: false, detail: 'backup receipt fields are not the closed producer schema' };
    }
    if (receipt?.schema !== BACKUP_RECEIPT_SCHEMA) {
      return { ok: false, detail: 'backup receipt schema is unsupported' };
    }
    if (receipt.status !== 'passed') {
      return { ok: false, detail: sanitizeDetail(`backup receipt status ${receipt.status}`) };
    }
    // A pre-promotion release must consume a pre-promotion backup, not whatever
    // hourly snapshot happens to be newest.
    if (receipt.kind !== PRE_MIGRATION_BACKUP_KIND) {
      return { ok: false, detail: sanitizeDetail(`backup receipt kind ${receipt.kind}`) };
    }

    const wanted = expectedDatabase(environment);
    if (!wanted) {
      return { ok: false, detail: sanitizeDetail(`unknown environment ${environment}`) };
    }
    // The backup must cover the exact database this release migrates. The retained
    // unit historically pointed at the pre-container path, so this mismatch is a
    // real, expected failure mode rather than a theoretical one.
    if (path.resolve(String(receipt.database ?? '')) !== path.resolve(wanted)) {
      return {
        ok: false,
        detail: sanitizeDetail(`backup covers a different database than ${wanted}`),
      };
    }
    if (path.resolve(String(receipt.backupRoot ?? '')) !== path.resolve(backupRoot)) {
      return { ok: false, detail: 'backup receipt root does not match policy' };
    }

    const startedAtMs = strictTimestamp(receipt.startedAt);
    if (startedAtMs === null) {
      return { ok: false, detail: 'backup receipt start time is not canonical' };
    }
    const completedAtMs = strictTimestamp(receipt.completedAt);
    if (completedAtMs === null) {
      return { ok: false, detail: 'backup receipt completion time is not canonical' };
    }
    // `systemctl start` succeeds when a oneshot is already activating. Completion
    // freshness alone would therefore admit a snapshot whose producer invocation
    // began before this release request. Bind both ends of the producer interval.
    if (Number.isFinite(notBeforeMs) && startedAtMs < notBeforeMs) {
      return { ok: false, detail: 'backup receipt invocation predates this release request' };
    }
    if (completedAtMs < startedAtMs) {
      return { ok: false, detail: 'backup receipt completion predates its invocation' };
    }
    // Freshness relative to this release attempt, not just wall-clock age: a
    // receipt completed before we requested the backup is a previous backup.
    if (Number.isFinite(notBeforeMs) && completedAtMs < notBeforeMs) {
      return { ok: false, detail: 'backup receipt predates this release attempt' };
    }
    if (now() - completedAtMs > maxAgeSeconds * 1000) {
      return { ok: false, detail: 'backup receipt is stale' };
    }
    if (completedAtMs > now()) {
      return { ok: false, detail: 'backup receipt is future-dated' };
    }

    if (!HEX_SHA256.test(String(receipt.encryptedSha256 ?? ''))) {
      return { ok: false, detail: 'backup receipt has no encrypted digest' };
    }
    if (!Number.isSafeInteger(receipt.encryptedSizeBytes) || receipt.encryptedSizeBytes <= 0) {
      return { ok: false, detail: 'backup receipt has no encrypted size' };
    }
    if (!HEX_SHA256.test(receipt.plaintextSha256)
        || !Number.isSafeInteger(receipt.plaintextSizeBytes)
        || receipt.plaintextSizeBytes <= 0
        || receipt.integrityCheck !== 'ok'
        || receipt.foreignKeyCheck !== 'ok') {
      return { ok: false, detail: 'backup receipt recovery claims are invalid' };
    }
    if (!exactKeys(receipt.retention, Object.keys(PRODUCER_RETENTION))
        || !Object.entries(PRODUCER_RETENTION).every(
          ([tier, count]) => receipt.retention[tier] === count,
        )) {
      return { ok: false, detail: 'backup receipt retention is invalid' };
    }

    const installed = receipt.installed;
    if (!exactKeys(installed, [PRE_MIGRATION_BACKUP_KIND])) {
      return { ok: false, detail: 'backup receipt has no installed artifacts' };
    }
    const artifactPath = installed[PRE_MIGRATION_BACKUP_KIND];
    if (typeof artifactPath !== 'string' || artifactPath.length === 0) {
      return { ok: false, detail: 'backup receipt has no pre-promotion artifact' };
    }
    // Only the encrypted artifact counts. A checksum sidecar or a directory would
    // satisfy a filename scan but restores nothing.
    if (!artifactPath.endsWith('.age')) {
      return { ok: false, detail: 'backup artifact is not an encrypted .age file' };
    }
    return verifyBackupEvidence({
      environment,
      evidence: {
        artifact: path.basename(artifactPath),
        artifactPath,
        encryptedSha256: receipt.encryptedSha256,
        encryptedSizeBytes: receipt.encryptedSizeBytes,
        database: receipt.database,
        startedAt: receipt.startedAt,
        completedAt: receipt.completedAt,
      },
    });
  }

  function createPreMigrationBackup({ environment = 'production' } = {}) {
    const startedAtMs = now();
    const timeoutMs = Number(policy.timing.backupTimeoutSeconds ?? 900) * 1000;

    const started = exec(systemctlBin, ['start', PRE_MIGRATION_BACKUP_UNIT], { timeoutMs });
    if (started.status !== 0) {
      return {
        result: 'failed',
        artifact: null,
        detail: sanitizeDetail(`backup unit start exit ${started.status}`),
      };
    }
    const shown = exec(systemctlBin, [
      'show', PRE_MIGRATION_BACKUP_UNIT, '--property=Result', '--value',
    ], { timeoutMs: 30_000 });
    const unitResult = shown.stdout.trim();
    if (shown.status !== 0 || unitResult !== 'success') {
      return {
        result: 'failed',
        artifact: null,
        detail: sanitizeDetail(`backup unit result ${unitResult || 'unknown'}`),
      };
    }

    // A unit that exits zero still has to have published a fresh receipt for this
    // database. Trusting the exit code alone would migrate unprotected.
    const receipt = readBackupReceipt({ environment, notBeforeMs: startedAtMs });
    if (!receipt.ok) {
      log(`pre-migration backup receipt rejected: ${receipt.detail}`);
      return { result: 'failed', artifact: null, detail: receipt.detail };
    }
    // Carry the exact freshly admitted identity across the deployment boundary.
    // `last-success.json` is a mutable pointer: an hourly backup may replace it
    // immediately after this return, so the caller must never reconstruct or
    // re-read the admission decision from that path.
    const evidence = assertBackupEvidenceShape({
      artifact: receipt.artifact,
      artifactPath: receipt.artifactPath,
      encryptedSha256: receipt.encryptedSha256,
      encryptedSizeBytes: receipt.encryptedSizeBytes,
      database: receipt.database,
      startedAt: receipt.startedAt,
      completedAt: receipt.completedAt,
    }, 'fresh backup evidence');
    return {
      result: 'passed',
      artifact: evidence.artifact,
      evidence,
      detail: null,
    };
  }

  return { readBackupReceipt, verifyBackupEvidence, createPreMigrationBackup };
}
