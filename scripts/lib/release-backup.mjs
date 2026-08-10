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
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const HEX_SHA256 = /^[0-9a-f]{64}$/;

export function createReleaseBackup({
  policy,
  exec = defaultExec,
  systemctlBin = process.env.NEXUS_RELEASE_SYSTEMCTL_BIN || '/usr/bin/systemctl',
  now = () => Date.now(),
  log = () => {},
  fileSystem = fs,
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

    let rootFd;
    try {
      rootFd = fileSystem.openSync(
        backupRoot,
        fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
      );
    } catch (error) {
      if (error?.code === 'ELOOP' || error?.code === 'ENOTDIR') {
        return { ok: false, detail: 'governed backup root is not a non-symlink directory' };
      }
      return { ok: false, detail: 'governed backup root could not be opened' };
    }

    try {
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
          || !sameFileIdentity(rootPathStat, rootStat)) {
        return { ok: false, detail: 'governed backup root identity is invalid' };
      }

      const artifactPath = expected.artifactPath;
      let artifactFd;
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

        // Refuse mutation or namespace replacement of either side. BigInt stats
        // retain nanosecond mtime/ctime where Node exposes them; the second digest
        // remains the content proof on injected/macOS filesystems that return
        // ordinary Stats instead.
        let currentArtifactDescriptorStat;
        let currentArtifactPathStat;
        let currentRootDescriptorStat;
        let currentRootPathStat;
        try {
          currentArtifactDescriptorStat = fileSystem.fstatSync(artifactFd, { bigint: true });
          currentArtifactPathStat = fileSystem.lstatSync(artifactPath, { bigint: true });
          currentRootDescriptorStat = fileSystem.fstatSync(rootFd, { bigint: true });
          currentRootPathStat = fileSystem.lstatSync(backupRoot, { bigint: true });
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

        return { ok: true, detail: null, ...expected };
      } finally {
        try {
          fileSystem.closeSync(artifactFd);
        } catch {
          // Verification is already bound to the descriptor identity and bytes.
        }
      }
    } finally {
      try {
        fileSystem.closeSync(rootFd);
      } catch {
        // Closing cannot redirect the root identity used for the completed proof.
      }
    }
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
    let stat;
    try {
      stat = fileSystem.lstatSync(receiptPath);
    } catch {
      return { ok: false, detail: 'backup receipt is missing' };
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0 || stat.size > MAX_RECEIPT_BYTES) {
      return { ok: false, detail: 'backup receipt is not a bounded regular file' };
    }

    let receipt;
    try {
      receipt = JSON.parse(fileSystem.readFileSync(receiptPath, 'utf8'));
    } catch {
      return { ok: false, detail: 'backup receipt is not valid json' };
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

    if (!CANONICAL_TIMESTAMP.test(String(receipt.startedAt ?? ''))) {
      return { ok: false, detail: 'backup receipt start time is not canonical' };
    }
    const startedAtMs = Date.parse(receipt.startedAt);
    if (!Number.isFinite(startedAtMs)) {
      return { ok: false, detail: 'backup receipt start time is unparseable' };
    }
    if (!CANONICAL_TIMESTAMP.test(String(receipt.completedAt ?? ''))) {
      return { ok: false, detail: 'backup receipt completion time is not canonical' };
    }
    const completedAtMs = Date.parse(receipt.completedAt);
    if (!Number.isFinite(completedAtMs)) {
      return { ok: false, detail: 'backup receipt completion time is unparseable' };
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

    if (!HEX_SHA256.test(String(receipt.encryptedSha256 ?? ''))) {
      return { ok: false, detail: 'backup receipt has no encrypted digest' };
    }
    if (!Number.isSafeInteger(receipt.encryptedSizeBytes) || receipt.encryptedSizeBytes <= 0) {
      return { ok: false, detail: 'backup receipt has no encrypted size' };
    }

    const installed = receipt.installed;
    if (!installed || typeof installed !== 'object' || Array.isArray(installed)) {
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
