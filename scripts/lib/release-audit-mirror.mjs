import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import { defaultExec } from './release-registry.mjs';
import { assertReleaseReceiptShape, sanitizeDetail } from './release-state-store.mjs';
import { sha256 } from './release-canonical.mjs';

/**
 * Receipt mirror to a separate root-owned audit account.
 *
 * The mirror exists so release history survives loss of the deployment host's
 * state directory. It is explicitly **not** a gate: a mirror failure alerts, but
 * it can never change the deployment verdict. Coupling the two would mean an
 * unreachable audit host could roll back a healthy production release, which
 * inverts the point of having an independent audit copy.
 *
 * Delivery is durably queued rather than best-effort-once. `scp` is synchronous
 * and can die mid-transfer — including after the immutable receipt exists but
 * before any failure notification — so a receipt is enqueued *first* and only
 * dequeued once it is confirmed delivered. Later polls drain the queue, which is
 * what makes a transient network outage self-healing instead of a permanently
 * missing audit record.
 */

export const MIRROR_QUEUE_SCHEMA = 'nexus.release-mirror-queue-entry.v1';
export const MIRROR_DELIVERY_SCHEMA = 'nexus.release-mirror-delivery.v1';
export const MIRROR_REMOTE_PROOF_SCHEMA = 'nexus.release-mirror-remote-proof.v1';
const RELEASE_ID = /^[0-9a-f]{32}$/;
const HEX_SHA256 = /^[0-9a-f]{64}$/;

const REMOTE_FINALIZE_SCRIPT = String.raw`set -eu
directory=$1
temporary_name=$2
final_name=$3
expected_digest=$4
release_id=$5
cd "$directory"
resolved_directory=$(pwd -P)
if [ "$resolved_directory" != "$directory" ]; then
  exit 70
fi
if [ ! -f "$temporary_name" ] || [ -L "$temporary_name" ]; then
  exit 71
fi
temporary_links=$(stat -c '%h' -- "$temporary_name")
if [ "$temporary_links" != "1" ]; then
  exit 78
fi
observed_digest=$(sha256sum -- "$temporary_name" | cut -d ' ' -f 1)
if [ "$observed_digest" != "$expected_digest" ]; then
  exit 72
fi
sync -f -- "$temporary_name"
if [ -e "$final_name" ] || [ -L "$final_name" ]; then
  if [ ! -f "$final_name" ] || [ -L "$final_name" ]; then
    exit 73
  fi
  final_digest=$(sha256sum -- "$final_name" | cut -d ' ' -f 1)
  if [ "$final_digest" != "$expected_digest" ]; then
    exit 74
  fi
else
  if ! ln -- "$temporary_name" "$final_name"; then
    if [ ! -f "$final_name" ] || [ -L "$final_name" ]; then
      exit 75
    fi
    final_digest=$(sha256sum -- "$final_name" | cut -d ' ' -f 1)
    if [ "$final_digest" != "$expected_digest" ]; then
      exit 76
    fi
  fi
fi
sync -f -- "$final_name"
rm -f -- "$temporary_name"
sync -f -- .
final_links=$(stat -c '%h' -- "$final_name")
if [ "$final_links" != "1" ]; then
  exit 79
fi
readback_digest=$(sha256sum -- "$final_name" | cut -d ' ' -f 1)
if [ "$readback_digest" != "$expected_digest" ]; then
  exit 77
fi
printf '{"schema":"nexus.release-mirror-remote-proof.v1","releaseId":"%s","remoteFinalPath":"%s/%s","receiptDigest":"%s"}\n' \
  "$release_id" "$directory" "$final_name" "$readback_digest"
`;

const REMOTE_CLEANUP_SCRIPT = String.raw`set -eu
directory=$1
release_id=$2
receipt_digest=$3
cd "$directory"
resolved_directory=$(pwd -P)
if [ "$resolved_directory" != "$directory" ]; then
  exit 80
fi
release_id_length=$(printf '%s' "$release_id" | wc -c | tr -d ' ')
if [ "$release_id_length" -ne 32 ]; then
  exit 81
fi
case "$release_id" in
  ''|*[!0-9a-f]*) exit 81 ;;
esac
receipt_digest_length=$(printf '%s' "$receipt_digest" | wc -c | tr -d ' ')
if [ "$receipt_digest_length" -ne 64 ]; then
  exit 82
fi
case "$receipt_digest" in
  ''|*[!0-9a-f]*) exit 82 ;;
esac

upload_prefix=".$release_id.$receipt_digest."
upload_suffix='.upload'
for candidate in "$upload_prefix"*"$upload_suffix"; do
  if [ ! -e "$candidate" ] && [ ! -L "$candidate" ]; then
    continue
  fi
  case "$candidate" in
    "$upload_prefix"*"$upload_suffix") ;;
    *) continue ;;
  esac
  nonce=$(printf '%s' "$candidate" | cut -c 100-131)
  nonce_length=$(printf '%s' "$nonce" | wc -c | tr -d ' ')
  if [ "$nonce_length" -ne 32 ]; then
    continue
  fi
  case "$nonce" in
    ''|*[!0-9a-f]*) continue ;;
  esac
  if [ "$candidate" != ".$release_id.$receipt_digest.$nonce.upload" ]; then
    continue
  fi
  if [ "$candidate" = "$release_id.json" ]; then
    exit 83
  fi
  if [ -f "$candidate" ] || [ -L "$candidate" ]; then
    rm -f -- "$candidate"
  fi
done
sync -f -- .
`;

function hasExactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((entry, index) => entry === wanted[index]);
}

function isQueueEntry(
  value,
  expectedReleaseId = null,
  expectedReceiptPath = null,
  expectedReceiptDigest = null,
  expectedRemoteFinalPath = null,
  { exhausted = false } = {},
) {
  const keys = [
    'schema', 'releaseId', 'receiptPath', 'receiptDigest', 'remoteFinalPath',
    'attempts', 'lastAttemptAt',
  ];
  if (exhausted) keys.push('exhaustedAt');
  return hasExactKeys(value, keys)
    && value.schema === MIRROR_QUEUE_SCHEMA
    && typeof value.releaseId === 'string'
    && RELEASE_ID.test(value.releaseId)
    && (expectedReleaseId === null || value.releaseId === expectedReleaseId)
    && typeof value.receiptPath === 'string'
    && path.isAbsolute(value.receiptPath)
    && (expectedReceiptPath === null || value.receiptPath === expectedReceiptPath)
    && typeof value.receiptDigest === 'string'
    && HEX_SHA256.test(value.receiptDigest)
    && (expectedReceiptDigest === null || value.receiptDigest === expectedReceiptDigest)
    && typeof value.remoteFinalPath === 'string'
    && path.posix.isAbsolute(value.remoteFinalPath)
    && (expectedRemoteFinalPath === null || value.remoteFinalPath === expectedRemoteFinalPath)
    && Number.isSafeInteger(value.attempts)
    && value.attempts >= 0
    && (value.lastAttemptAt === null || (
      typeof value.lastAttemptAt === 'string'
      && Number.isFinite(Date.parse(value.lastAttemptAt))
    ))
    && (!exhausted || (
      typeof value.exhaustedAt === 'string'
      && Number.isFinite(Date.parse(value.exhaustedAt))
    ));
}

function isDeliveryAcknowledgement(value, expected) {
  return hasExactKeys(value, [
    'schema', 'releaseId', 'receiptPath', 'receiptDigest', 'remoteHost',
    'remoteUser', 'remoteFinalPath', 'remoteReceiptDigest', 'deliveredAt',
  ])
    && value.schema === MIRROR_DELIVERY_SCHEMA
    && value.releaseId === expected.releaseId
    && typeof value.receiptPath === 'string'
    && path.isAbsolute(value.receiptPath)
    && value.receiptPath === expected.receiptPath
    && value.receiptDigest === expected.receiptDigest
    && value.remoteHost === expected.remoteHost
    && value.remoteUser === expected.remoteUser
    && value.remoteFinalPath === expected.remoteFinalPath
    && value.remoteReceiptDigest === expected.receiptDigest
    && typeof value.deliveredAt === 'string'
    && Number.isFinite(Date.parse(value.deliveredAt));
}

function isRemoteProof(value, entry) {
  return hasExactKeys(value, [
    'schema', 'releaseId', 'remoteFinalPath', 'receiptDigest',
  ])
    && value.schema === MIRROR_REMOTE_PROOF_SCHEMA
    && value.releaseId === entry.releaseId
    && value.remoteFinalPath === entry.remoteFinalPath
    && value.receiptDigest === entry.receiptDigest;
}

export function createReleaseAuditMirror({
  policy,
  exec = defaultExec,
  env = process.env,
  scpBin = process.env.NEXUS_RELEASE_SCP_BIN || 'scp',
  sshBin = process.env.NEXUS_RELEASE_SSH_BIN || 'ssh',
  now = () => Date.now(),
  log = () => {},
}) {
  const queueDir = policy.auditMirror?.queueDir;
  const failedDir = queueDir ? path.join(queueDir, 'failed') : null;
  const deliveredDir = queueDir ? path.join(queueDir, 'delivered') : null;
  const quarantineDir = queueDir ? path.join(queueDir, 'quarantine') : null;
  const maxAttempts = Number(policy.auditMirror?.maxAttempts ?? 5);

  function target() {
    const config = policy.auditMirror;
    if (!config?.enabled) return { enabled: false, reason: 'disabled' };
    const host = env[config.hostEnvVar];
    if (!host) return { enabled: false, reason: 'host_not_configured' };
    if (!config.knownHostsFile) {
      // Without a pinned known_hosts, strict checking would fail every time or,
      // worse, be silently relaxed. Refusing is the safe answer, and the mirror is
      // non-gating anyway.
      return { enabled: false, reason: 'known_hosts_not_configured' };
    }
    return {
      enabled: true,
      host,
      user: config.user,
      path: config.path,
      identityFile: config.identityFile,
      knownHostsFile: config.knownHostsFile,
      timeoutSeconds: Number(config.timeoutSeconds ?? 30),
    };
  }

  function queuePath(releaseId) {
    return path.join(queueDir, `${releaseId}.json`);
  }

  function deliveredPath(releaseId) {
    return path.join(deliveredDir, `${releaseId}.json`);
  }

  function remoteFinalPath(releaseId) {
    return path.posix.join(policy.auditMirror.path, `${releaseId}.json`);
  }

  function queueEntryFor({ releaseId, receiptPath }) {
    if (!RELEASE_ID.test(String(releaseId ?? ''))) {
      throw new Error('audit mirror release id is invalid');
    }
    if (typeof receiptPath !== 'string' || !path.isAbsolute(receiptPath)) {
      throw new Error('audit mirror receipt path must be absolute');
    }
    const receiptDigest = sha256(fs.readFileSync(receiptPath));
    return {
      schema: MIRROR_QUEUE_SCHEMA,
      releaseId,
      receiptPath,
      receiptDigest,
      remoteFinalPath: remoteFinalPath(releaseId),
      attempts: 0,
      lastAttemptAt: null,
    };
  }

  function expectedDelivery(entry, resolved) {
    return {
      releaseId: entry.releaseId,
      receiptPath: entry.receiptPath,
      receiptDigest: entry.receiptDigest,
      remoteHost: resolved.host,
      remoteUser: resolved.user,
      remoteFinalPath: entry.remoteFinalPath,
    };
  }

  /**
   * Durability is claimed for this queue, so it must actually be provided: the
   * entry is written to a temp file, fsynced, renamed, and the parent directory
   * fsynced. A plain writeFileSync survives a process crash but not a power loss,
   * and an entry lost that way is a receipt that silently never reaches the audit
   * host.
   */
  function writeDurable(file, value) {
    const directory = path.dirname(file);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = `${file}.next-${process.pid}`;
    fs.rmSync(temporary, { force: true });
    const descriptor = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(temporary, file);
    const parent = fs.openSync(directory, 'r');
    try {
      fs.fsyncSync(parent);
    } finally {
      fs.closeSync(parent);
    }
  }

  function fsyncDirectory(directory) {
    const descriptor = fs.openSync(
      directory,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY,
    );
    try {
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
  }

  /**
   * A corrupt queue entry is quarantined, never discarded and never trusted.
   * Silently skipping it would drop a receipt from the audit trail with no
   * record that it ever existed — the exact failure the audit mirror exists to
   * make impossible.
   */
  function quarantine(name, reason) {
    if (!queueDir || !quarantineDir) {
      throw new Error('audit mirror quarantine is not configured');
    }
    if (typeof name !== 'string'
        || name.length === 0
        || name === '.'
        || name === '..'
        || name.includes('\0')
        || path.basename(name) !== name
        || !/^[a-z][a-z0-9-]{0,31}$/.test(reason)) {
      throw new Error('audit mirror quarantine request is invalid');
    }
    const source = path.join(queueDir, name);
    fs.mkdirSync(quarantineDir, { recursive: true, mode: 0o700 });
    const quarantineStat = fs.lstatSync(quarantineDir);
    if (!quarantineStat.isDirectory() || quarantineStat.isSymbolicLink()) {
      throw new Error('audit mirror quarantine root is not a directory');
    }

    // A fresh exclusive directory supplies rename-no-replace semantics even for
    // directories and symlinks, which cannot use a hard-link based publication.
    // The original basename remains inside the bundle for operator inspection.
    let bundleName = null;
    let bundlePath = null;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = `${reason}-${sha256(name).slice(0, 16)}-${randomBytes(16).toString('hex')}`;
      const candidatePath = path.join(quarantineDir, candidate);
      try {
        fs.mkdirSync(candidatePath, { mode: 0o700 });
        bundleName = candidate;
        bundlePath = candidatePath;
        break;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
      }
    }
    if (!bundlePath || !bundleName) {
      throw new Error('audit mirror could not allocate unique quarantine evidence');
    }

    const target = path.join(bundlePath, name);
    try {
      fs.renameSync(source, target);
      // Cross-directory rename durability requires both namespace sides. The
      // bundle directory persists the target entry; queueDir persists removal
      // of the source; quarantineDir persists creation of the unique bundle.
      fsyncDirectory(bundlePath);
      fsyncDirectory(queueDir);
      fsyncDirectory(quarantineDir);
    } catch (error) {
      if (!fs.existsSync(target)) {
        try {
          fs.rmdirSync(bundlePath);
        } catch {
          // Leave the exclusively-created bundle for operator inspection.
        }
      }
      throw new Error(`audit mirror could not quarantine ${reason} queue evidence`, {
        cause: error,
      });
    }
    const relativeTarget = path.join(bundleName, name);
    log(`release audit mirror quarantined queue evidence in ${bundleName}`);
    return relativeTarget;
  }

  function enqueue({ releaseId, receiptPath }) {
    if (!queueDir) return null;
    fs.mkdirSync(queueDir, { recursive: true, mode: 0o700 });
    const file = queuePath(releaseId);
    let entry = queueEntryFor({ releaseId, receiptPath });
    if (fs.existsSync(file)) {
      let existing = null;
      try {
        existing = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        existing = null;
      }
      if (isQueueEntry(
        existing,
        releaseId,
        receiptPath,
        entry.receiptDigest,
        entry.remoteFinalPath,
      )) {
        entry = existing;
      } else {
        // Preserve the unreadable bytes before replacing them.
        quarantine(`${releaseId}.json`, 'corrupt');
      }
    }
    writeDurable(file, entry);
    return entry;
  }

  function dequeue(releaseId) {
    if (!queueDir) return;
    fs.rmSync(queuePath(releaseId), { force: true });
    try {
      const parent = fs.openSync(queueDir, 'r');
      try {
        fs.fsyncSync(parent);
      } finally {
        fs.closeSync(parent);
      }
    } catch {
      // A durable acknowledgement already outranks a stale queue entry. Failure
      // to fsync this cleanup can cause a harmless retry check, never evidence loss.
    }
  }

  function readDelivered(releaseId, receiptPath = null, expectedEntry = null, resolved = target()) {
    if (!deliveredDir) return null;
    if (!resolved.enabled || receiptPath === null) return null;
    let currentEntry;
    try {
      currentEntry = queueEntryFor({ releaseId, receiptPath });
    } catch {
      return null;
    }
    if (expectedEntry && !isQueueEntry(
      expectedEntry,
      releaseId,
      receiptPath,
      currentEntry.receiptDigest,
      currentEntry.remoteFinalPath,
    )) return null;
    let value;
    try {
      value = JSON.parse(fs.readFileSync(deliveredPath(releaseId), 'utf8'));
    } catch (error) {
      if (error && error.code === 'ENOENT') return null;
      log(`release audit mirror delivery acknowledgement is unreadable for ${releaseId}`);
      return null;
    }
    if (!isDeliveryAcknowledgement(value, expectedDelivery(currentEntry, resolved))) {
      log(`release audit mirror delivery acknowledgement is invalid for ${releaseId}`);
      return null;
    }
    return value;
  }

  function readExhausted(releaseId, receiptPath = null, expectedEntry = null) {
    if (!failedDir) return null;
    let value;
    try {
      value = JSON.parse(fs.readFileSync(path.join(failedDir, `${releaseId}.json`), 'utf8'));
    } catch (error) {
      if (error && error.code === 'ENOENT') return null;
      return null;
    }
    return isQueueEntry(
      value,
      releaseId,
      receiptPath,
      expectedEntry?.receiptDigest ?? null,
      expectedEntry?.remoteFinalPath ?? null,
      { exhausted: true },
    ) ? value : null;
  }

  function acknowledgeDelivery(entry, resolved, proof) {
    if (!deliveredDir) return false;
    writeDurable(deliveredPath(entry.releaseId), {
      schema: MIRROR_DELIVERY_SCHEMA,
      releaseId: entry.releaseId,
      receiptPath: entry.receiptPath,
      receiptDigest: entry.receiptDigest,
      remoteHost: resolved.host,
      remoteUser: resolved.user,
      remoteFinalPath: proof.remoteFinalPath,
      remoteReceiptDigest: proof.receiptDigest,
      deliveredAt: new Date(now()).toISOString(),
    });
    return true;
  }

  function readQueue() {
    if (!queueDir) return [];
    const resolved = target();
    let names;
    try {
      names = fs.readdirSync(queueDir).sort();
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
    const entries = [];
    for (const name of names) {
      if (name === 'failed' || name === 'delivered' || name === 'quarantine') {
        const controlPath = path.join(queueDir, name);
        const controlStat = fs.lstatSync(controlPath);
        if (controlStat.isDirectory() && !controlStat.isSymbolicLink()) continue;
        if (name === 'quarantine') {
          throw new Error('audit mirror quarantine root is not a directory');
        }
        quarantine(name, 'invalid-name');
        continue;
      }
      if (!/^[0-9a-f]{32}\.json$/.test(name)) {
        quarantine(name, 'invalid-name');
        continue;
      }
      let entry = null;
      try {
        entry = JSON.parse(fs.readFileSync(path.join(queueDir, name), 'utf8'));
      } catch {
        entry = null;
      }
      if (isQueueEntry(entry, name.slice(0, -'.json'.length))) {
        // A process or host crash can happen after the durable delivery marker
        // is written but before the queue entry is removed. The marker outranks
        // that stale work item, so recovery cleans it up without retransferring.
        if (readDelivered(entry.releaseId, entry.receiptPath, entry, resolved)) {
          dequeue(entry.releaseId);
          continue;
        }
        entries.push(entry);
        continue;
      }
      // Never silently skipped: quarantined, logged, and surfaced by drainQueue
      // so the failure is visible rather than inferred from a missing receipt.
      quarantine(name, 'corrupt');
    }
    return entries.sort((left, right) => left.releaseId.localeCompare(right.releaseId));
  }

  function transportOptions(resolved) {
    return [
      '-o', 'BatchMode=yes',
      '-o', 'IdentitiesOnly=yes',
      '-o', 'StrictHostKeyChecking=yes',
      '-o', `UserKnownHostsFile=${resolved.knownHostsFile}`,
      '-o', `ConnectTimeout=${resolved.timeoutSeconds}`,
      '-i', resolved.identityFile,
    ];
  }

  function cleanupTemporaryUploads({ entry, resolved }) {
    // Cleanup is intentionally narrower than the immutable final name and is
    // never allowed to affect delivery, retry, or exhaustion outcomes. The
    // remote script repeats the identity validation before expanding its exact
    // release+digest prefix and accepts only a 32-hex nonce plus `.upload`.
    if (!RELEASE_ID.test(entry.releaseId) || !HEX_SHA256.test(entry.receiptDigest)) return;
    try {
      exec(sshBin, [
        ...transportOptions(resolved),
        `${resolved.user}@${resolved.host}`,
        '/bin/sh', '-s', '--',
        resolved.path,
        entry.releaseId,
        entry.receiptDigest,
      ], {
        timeoutMs: resolved.timeoutSeconds * 1000,
        input: REMOTE_CLEANUP_SCRIPT,
      });
    } catch {
      // The queue remains the durable obligation. A later retry invokes the
      // same cleanup after transport recovers; cleanup itself is never gating.
    }
  }

  function transfer({ entry, resolved }) {
    // StrictHostKeyChecking=yes needs a known_hosts the poller can read. The
    // default lives under $HOME/.ssh, which the unit's ProtectHome=yes hides, so
    // the pinned file is explicit and sits with the other release trust material.
    const nonce = randomBytes(16).toString('hex');
    const temporaryName = `.${entry.releaseId}.${entry.receiptDigest}.${nonce}.upload`;
    const finish = (result) => {
      cleanupTemporaryUploads({ entry, resolved });
      return result;
    };
    let upload;
    try {
      upload = exec(scpBin, [
        '-B',
        ...transportOptions(resolved),
        entry.receiptPath,
        `${resolved.user}@${resolved.host}:${resolved.path}/${temporaryName}`,
      ], { timeoutMs: resolved.timeoutSeconds * 1000 });
    } catch {
      return finish({ status: 1, stdout: '', stderr: 'upload transport failed' });
    }
    if (upload.status !== 0) return finish(upload);

    // scp exit zero proves only that a remote process accepted the stream. The
    // audit obligation settles only after the remote host hashes the bytes,
    // fsyncs them, performs a no-replace atomic finalize, fsyncs the directory,
    // and returns an exact readback proof for the final identity.
    let finalize;
    try {
      finalize = exec(sshBin, [
        ...transportOptions(resolved),
        `${resolved.user}@${resolved.host}`,
        '/bin/sh', '-s', '--',
        resolved.path,
        temporaryName,
        `${entry.releaseId}.json`,
        entry.receiptDigest,
        entry.releaseId,
      ], {
        timeoutMs: resolved.timeoutSeconds * 1000,
        input: REMOTE_FINALIZE_SCRIPT,
      });
    } catch {
      return finish({ status: 1, stdout: '', stderr: 'finalize transport failed' });
    }
    if (finalize.status !== 0) return finish(finalize);

    let proof;
    try {
      const text = finalize.stdout.trim();
      if (text.length === 0 || text.includes('\n')) throw new Error('ambiguous proof');
      proof = JSON.parse(text);
    } catch {
      return finish({ status: 1, stdout: finalize.stdout, stderr: 'remote proof is invalid' });
    }
    if (!isRemoteProof(proof, entry)) {
      return finish({
        status: 1,
        stdout: finalize.stdout,
        stderr: 'remote proof does not match receipt',
      });
    }
    return finish({ status: 0, stdout: finalize.stdout, stderr: finalize.stderr, proof });
  }

  /**
   * Persist durable failure evidence, and only then stop retrying.
   *
   * The ordering is the point: dequeuing first would delete the only record that
   * a receipt was owed to the audit host. If the evidence cannot be written the
   * entry stays queued, so the next poll tries again rather than losing it.
   */
  function recordExhausted(entry) {
    if (!failedDir) return false;
    try {
      writeDurable(
        path.join(failedDir, `${entry.releaseId}.json`),
        { ...entry, exhaustedAt: new Date(now()).toISOString() },
      );
    } catch {
      log(`release audit mirror could not persist failure evidence for ${entry.releaseId}`);
      return false;
    }
    dequeue(entry.releaseId);
    return true;
  }

  function attempt(entry, resolved) {
    if (readDelivered(entry.releaseId, entry.receiptPath, entry, resolved)) {
      dequeue(entry.releaseId);
      return { releaseId: entry.releaseId, result: 'passed', detail: null };
    }
    const result = transfer({
      entry,
      resolved,
    });
    if (result.status === 0) {
      try {
        // The acknowledgement is durable before dequeue. If the process dies
        // between those operations, readQueue() sees it and removes the stale
        // entry without repeating a successful transfer.
        acknowledgeDelivery(entry, resolved, result.proof);
        dequeue(entry.releaseId);
        return { releaseId: entry.releaseId, result: 'passed', detail: null };
      } catch {
        log(`release audit mirror could not persist delivery acknowledgement for ${entry.releaseId}`);
        return {
          releaseId: entry.releaseId,
          result: 'deferred',
          detail: sanitizeDetail('delivery succeeded but acknowledgement could not be persisted'),
        };
      }
    }
    const attempts = Number(entry.attempts ?? 0) + 1;
    const next = { ...entry, attempts, lastAttemptAt: new Date(now()).toISOString() };
    if (queueDir) {
      try {
        writeDurable(queuePath(entry.releaseId), next);
      } catch {
        // Only the separately durable exhausted marker may settle this attempt.
      }
    }
    if (attempts >= maxAttempts) {
      if (!recordExhausted(next)) {
        return {
          releaseId: entry.releaseId,
          result: 'deferred',
          detail: sanitizeDetail('mirror failure evidence unavailable will retry'),
        };
      }
      return {
        releaseId: entry.releaseId,
        result: 'failed',
        detail: sanitizeDetail(`mirror exhausted after ${attempts} attempts`),
      };
    }
    return {
      releaseId: entry.releaseId,
      result: 'deferred',
      detail: sanitizeDetail(`mirror attempt ${attempts} failed; will retry`),
    };
  }

  /**
   * Enqueue then attempt once. A `deferred` result is not a failure to report — a
   * later poll retries it — so only exhaustion raises an alert.
   */
  function mirrorReceipt({ receiptPath, releaseId }) {
    const resolved = target();
    if (!resolved.enabled) {
      log(`release audit mirror skipped: ${resolved.reason}`);
      return { result: 'skipped', detail: sanitizeDetail(resolved.reason) };
    }
    const entry = enqueue({ releaseId, receiptPath })
      ?? queueEntryFor({ releaseId, receiptPath });
    if (readDelivered(releaseId, receiptPath, entry, resolved)) {
      dequeue(releaseId);
      return { result: 'passed', detail: null };
    }
    const outcome = attempt(entry, resolved);
    if (outcome.result === 'failed') {
      log(`release audit mirror exhausted for ${releaseId}; deployment verdict unchanged`);
    }
    return { result: outcome.result, detail: outcome.detail };
  }

  /**
   * Rebuild queue obligations from immutable local receipts.
   *
   * Receipt publication and mirror enqueue cannot be one atomic filesystem
   * transaction. A crash in that gap is recovered by scanning the authoritative
   * receipt directory on the next poll. Delivered and exhausted evidence are
   * durable terminal states, so reconciliation never resets the retry budget or
   * repeats a transfer that already has a success acknowledgement.
   */
  function reconcileReceipts({ receiptDir = policy.paths?.receiptDir } = {}) {
    const result = {
      examined: 0,
      enqueued: 0,
      queued: 0,
      delivered: 0,
      exhausted: 0,
      invalid: 0,
    };
    if (!policy.auditMirror?.enabled || !queueDir || !receiptDir) return result;
    const resolved = target();

    let names;
    try {
      names = fs.readdirSync(receiptDir)
        .filter((name) => /^[0-9a-f]{32}\.json$/.test(name))
        .sort();
    } catch (error) {
      if (error && error.code === 'ENOENT') return result;
      throw error;
    }

    for (const name of names) {
      result.examined += 1;
      const releaseId = name.slice(0, -'.json'.length);
      const receiptPath = path.join(receiptDir, name);
      try {
        const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
        assertReleaseReceiptShape(receipt);
        if (receipt.releaseId !== releaseId) throw new Error('receipt identity does not match filename');
      } catch {
        result.invalid += 1;
        log(`release audit mirror skipped invalid local receipt ${releaseId}`);
        continue;
      }

      const expectedEntry = queueEntryFor({ releaseId, receiptPath });

      if (readDelivered(releaseId, receiptPath, expectedEntry, resolved)) {
        dequeue(releaseId);
        result.delivered += 1;
        continue;
      }
      if (readExhausted(releaseId, receiptPath, expectedEntry)) {
        dequeue(releaseId);
        result.exhausted += 1;
        continue;
      }

      const alreadyQueued = fs.existsSync(queuePath(releaseId));
      enqueue({ releaseId, receiptPath });
      if (alreadyQueued) result.queued += 1;
      else result.enqueued += 1;
    }
    return result;
  }

  /** Drain queued receipts. Called on every poll; always non-gating. */
  function drainQueue() {
    const resolved = target();
    const entries = readQueue();
    if (!resolved.enabled) {
      return {
        attempted: 0,
        delivered: 0,
        exhausted: [],
        quarantined: listQuarantined(),
      };
    }
    let delivered = 0;
    const exhausted = [];
    for (const entry of entries) {
      const outcome = attempt(entry, resolved);
      if (outcome.result === 'passed') delivered += 1;
      if (outcome.result === 'failed') exhausted.push(entry.releaseId);
    }
    return {
      attempted: entries.length,
      delivered,
      exhausted,
      quarantined: listQuarantined(),
    };
  }

  function listQuarantined() {
    if (!quarantineDir) return [];
    let names;
    try {
      names = fs.readdirSync(quarantineDir).sort();
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
    const evidence = [];
    for (const name of names) {
      const candidate = path.join(quarantineDir, name);
      const stat = fs.lstatSync(candidate);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        // Preserve visibility for legacy flat quarantine evidence.
        evidence.push(name);
        continue;
      }
      for (const entry of fs.readdirSync(candidate).sort()) {
        evidence.push(path.join(name, entry));
      }
    }
    return evidence;
  }

  return {
    target,
    mirrorReceipt,
    reconcileReceipts,
    drainQueue,
    readQueue,
    readDelivered,
    listQuarantined,
  };
}
