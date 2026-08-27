#!/usr/bin/env tsx
// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Milestone 14 — offline routing-confidence calibration. ZERO LLM calls.
 *
 * Replays the labeled routing corpus through the routing surfaces via
 * routing-accuracy's replay machinery and emits
 * config/routing-calibration.json:
 *
 *   - per surface+branch empirical precision (orchestrator resolveConfidence
 *     branches grouped by their stated confidence; LLM classify surface
 *     replayed ONLY from the routing_llm_classify_cache table)
 *   - intent-resolver rawScore buckets → empirical precision
 *   - clarify epsilon (policy constant) + actionable floor (reuses
 *     routing-accuracy's recommendClarifyThreshold math)
 *
 * Corpus mode fails closed when the database is missing or has no labeled
 * rows. The documented BOOTSTRAP table is emitted only with explicit
 * --bootstrap authorization. Provenance is embedded:
 * {source: 'bootstrap'|'corpus', corpusSize, generatedAt}.
 *
 * Flags:
 *   --db=<path>     SQLite database (default ./data/bot.db)
 *   --baseline=<path>
 *                   Separate reviewed calibration used for sparse-bucket
 *                   priors; required in corpus mode and never overwritten
 *   --out=<path>    Output path (default ./config/routing-calibration.json)
 *   --generated-at=<canonical ISO>
 *                   Required for corpus-mode output so a reviewed timestamp
 *                   can be reused and the tracked artifact is reproducible
 *   --export-plan=<path>
 *   --export-evidence=<path>
 *   --export-receipt=<path>
 *   --ack-plan=sha256:<hex>
 *                   Required private, receipt-bound export contract in
 *                   corpus mode. The acknowledgement must match the
 *                   validated plan digest.
 *   --bootstrap     Force the bootstrap table even when labels exist
 *   --dry-run       Print the table without writing the file
 */

import fs from 'fs';
import path from 'path';
import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import dotenv from 'dotenv';

dotenv.config({ quiet: true });
dotenv.config({ path: '.env.local', override: false, quiet: true });

// This offline, zero-provider tool never starts or exercises the iOS API.
// Keep its later database-module import independent from unrelated runtime
// secrets that may be enabled in the operator's ambient application config.
process.env.IOS_API_ENABLED = 'false';
process.env.IOS_API_JWT_SECRET = '';
process.env.APPLE_APP_ACCOUNT_TOKEN_HMAC_SECRET = '';

function readArg(name: string): string | undefined {
  const match = process.argv.find((arg) => arg === name || arg.startsWith(`${name}=`));
  if (!match) return undefined;
  return match === name ? '' : match.slice(name.length + 1);
}

function hasFlag(name: string): boolean {
  return process.argv.some((arg) => arg === name || arg.startsWith(`${name}=`));
}

const dbPath = readArg('--db') || process.env.DATABASE_PATH || './data/bot.db';
const baselinePath = readArg('--baseline');
const outPath = readArg('--out') || './config/routing-calibration.json';
const forceBootstrap = hasFlag('--bootstrap');
const dryRun = hasFlag('--dry-run');
const generatedAtRaw = readArg('--generated-at');
const exportPlanPath = readArg('--export-plan');
const exportEvidencePath = readArg('--export-evidence');
const exportReceiptPath = readArg('--export-receipt');
const acknowledgedPlanDigest = readArg('--ack-plan');

function parseGeneratedAt(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(raw)
    || Number.isNaN(Date.parse(raw))
    || new Date(raw).toISOString() !== raw
  ) {
    throw new Error(
      '--generated-at must be a canonical UTC ISO timestamp with milliseconds',
    );
  }
  return raw;
}

const PRIVATE_FILE_MODE = 0o600;
const TRACKED_CONFIG_MODE = 0o644;
const MAXIMUM_BASELINE_BYTES = 1024 * 1024;
const MAXIMUM_EXPORT_ARTIFACT_BYTES = 1024 * 1024;
const MAXIMUM_CORPUS_BYTES = 64 * 1024 * 1024;
const EXPECTED_CORPUS_ROWS = 300;

interface ReviewedExportIdentity {
  runtimeSha: string;
  artifactDigest: string;
  transactionId: string;
  planDigest: string;
  receiptDigest: string;
  inputSha256: string;
  corpusRows: number;
  corpusIdentityDigest: string;
  cacheRowsDigest: string;
  cacheRows: number;
  providerCalls: number;
}

interface FileIdentity {
  dev: number;
  ino: number;
}

interface HeldPrivateFile {
  requestedPath: string;
  resolvedPath: string;
  descriptor: number;
  stat: fs.Stats;
  sha256: string;
  bytes: Buffer;
  parentPath: string;
  parentDescriptor: number;
  parentStat: fs.Stats;
}

interface TrackedOutputSnapshot {
  stat: fs.Stats;
  sha256: string;
}

interface TrackedOutputTransaction {
  requestedOutput: string;
  canonicalOutput: string;
  parent: { resolved: string; stat: fs.Stats };
  outputBefore: TrackedOutputSnapshot | null;
  lockPath: string;
  lockDescriptor: number;
  lockStat: fs.Stats;
}

function sha256Bytes(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function sha256Descriptor(descriptor: number, size: number): string {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let offset = 0;
  while (offset < size) {
    const read = fs.readSync(
      descriptor,
      buffer,
      0,
      Math.min(buffer.length, size - offset),
      offset,
    );
    if (read === 0) throw new Error('Governed file became unreadable while hashing');
    hash.update(buffer.subarray(0, read));
    offset += read;
  }
  return hash.digest('hex');
}

function readDescriptorBytes(
  descriptor: number,
  size: number,
  maximumBytes: number,
  label: string,
): Buffer {
  if (size <= 0 || size > maximumBytes) {
    throw new Error(`${label} has an invalid size`);
  }
  const bytes = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < size) {
    const read = fs.readSync(descriptor, bytes, offset, size - offset, offset);
    if (read === 0) throw new Error(`${label} became unreadable while opening`);
    offset += read;
  }
  return bytes;
}

function assertCurrentOwner(stat: fs.Stats, label: string): void {
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`${label} must be owned by the current operator`);
  }
}

function assertNoSQLiteSidecars(databasePath: string): void {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    try {
      fs.lstatSync(`${databasePath}${suffix}`);
      throw new Error(
        `Routing calibration corpus has a SQLite sidecar not covered by inputSha256: ${suffix}`,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

function openHeldPrivateFile(
  requestedPath: string,
  label: string,
  maximumBytes: number,
  safePrivateDirectory: (
    directory: string,
    label: string,
  ) => { resolved: string; stat: fs.Stats },
  safePrivateFile: (filename: string, label: string) => { resolved: string; stat: fs.Stats },
  sameFileIdentity: (left: FileIdentity, right: FileIdentity) => boolean,
): HeldPrivateFile {
  const parent = safePrivateDirectory(path.dirname(requestedPath), `${label} parent`);
  const parentDescriptor = fs.openSync(parent.resolved, fs.constants.O_RDONLY);
  const parentOpened = fs.fstatSync(parentDescriptor);
  if (!parentOpened.isDirectory() || !sameFileIdentity(parentOpened, parent.stat)) {
    fs.closeSync(parentDescriptor);
    throw new Error(`${label} parent changed while its anchor opened`);
  }
  const { resolved, stat } = safePrivateFile(requestedPath, label);
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(
      resolved,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.nlink !== 1
        || (opened.mode & 0o777) !== PRIVATE_FILE_MODE
        || !sameFileIdentity(opened, stat)) {
      throw new Error(`${label} changed while its read-only anchor opened`);
    }
    const bytes = readDescriptorBytes(descriptor, opened.size, maximumBytes, label);
    return {
      requestedPath: path.resolve(requestedPath),
      resolvedPath: resolved,
      descriptor,
      stat: opened,
      sha256: sha256Bytes(bytes),
      bytes,
      parentPath: path.dirname(path.resolve(requestedPath)),
      parentDescriptor,
      parentStat: parentOpened,
    };
  } catch (error) {
    if (descriptor !== null) fs.closeSync(descriptor);
    fs.closeSync(parentDescriptor);
    throw error;
  }
}

function assertHeldPrivateFileUnchanged(
  held: HeldPrivateFile,
  label: string,
  sameFileIdentity: (left: FileIdentity, right: FileIdentity) => boolean,
): void {
  const parentAnchorNow = fs.fstatSync(held.parentDescriptor);
  const parentPathNow = fs.lstatSync(held.parentPath);
  const anchorNow = fs.fstatSync(held.descriptor);
  const pathNow = fs.lstatSync(held.requestedPath);
  if (!parentAnchorNow.isDirectory() || !parentPathNow.isDirectory()
      || parentPathNow.isSymbolicLink()
      || !sameFileIdentity(parentAnchorNow, held.parentStat)
      || !sameFileIdentity(parentAnchorNow, parentPathNow)
      || (parentAnchorNow.mode & 0o077) !== 0
      || (parentPathNow.mode & 0o077) !== 0
      || !anchorNow.isFile() || !pathNow.isFile() || pathNow.isSymbolicLink()
      || anchorNow.nlink !== 1 || pathNow.nlink !== 1
      || (anchorNow.mode & 0o777) !== PRIVATE_FILE_MODE
      || (pathNow.mode & 0o777) !== PRIVATE_FILE_MODE
      || !sameFileIdentity(anchorNow, held.stat)
      || !sameFileIdentity(anchorNow, pathNow)
      || anchorNow.size !== held.stat.size
      || sha256Descriptor(held.descriptor, anchorNow.size) !== held.sha256) {
    throw new Error(`${label} changed while calibration was running`);
  }
}

function closeHeldPrivateFile(held: HeldPrivateFile): void {
  try {
    fs.closeSync(held.descriptor);
  } finally {
    fs.closeSync(held.parentDescriptor);
  }
}

function assertAndCloseHeldPrivateFiles(
  heldFiles: Array<{ anchor: HeldPrivateFile; label: string }>,
  sameFileIdentity: (left: FileIdentity, right: FileIdentity) => boolean,
): void {
  let firstError: unknown;
  for (const { anchor, label } of heldFiles) {
    try {
      assertHeldPrivateFileUnchanged(anchor, label, sameFileIdentity);
    } catch (error) {
      firstError ??= error;
    } finally {
      try {
        closeHeldPrivateFile(anchor);
      } catch (error) {
        firstError ??= error;
      }
    }
  }
  heldFiles.length = 0;
  if (firstError) throw firstError;
}

function createPrivateSQLiteReplayCopy(held: HeldPrivateFile): string {
  const replayPath = path.join(
    held.parentPath,
    `.${path.basename(held.resolvedPath)}.calibration-replay-${process.pid}-${randomUUID()}`,
  );
  const descriptor = fs.openSync(
    replayPath,
    fs.constants.O_CREAT
      | fs.constants.O_EXCL
      | fs.constants.O_WRONLY
      | (fs.constants.O_NOFOLLOW ?? 0),
    PRIVATE_FILE_MODE,
  );
  try {
    fs.fchmodSync(descriptor, PRIVATE_FILE_MODE);
    fs.writeFileSync(descriptor, held.bytes);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  const copied = fs.lstatSync(replayPath);
  if (!copied.isFile() || copied.isSymbolicLink() || copied.nlink !== 1
      || (copied.mode & 0o777) !== PRIVATE_FILE_MODE
      || sha256Bytes(fs.readFileSync(replayPath)) !== held.sha256) {
    throw new Error('Private routing calibration replay copy failed verification');
  }
  return replayPath;
}

function removePrivateSQLiteReplayCopy(replayPath: string): void {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    try {
      fs.unlinkSync(`${replayPath}${suffix}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

function inspectTrackedOutput(outputPath: string): TrackedOutputSnapshot | null {
  let before: fs.Stats;
  try {
    before = fs.lstatSync(outputPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
      || (before.mode & 0o777) !== TRACKED_CONFIG_MODE) {
    throw new Error('Routing calibration output path is unsafe');
  }
  assertCurrentOwner(before, 'Routing calibration output');
  const descriptor = fs.openSync(
    outputPath,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.nlink !== 1
        || opened.dev !== before.dev || opened.ino !== before.ino
        || opened.size !== before.size) {
      throw new Error('Routing calibration output path is unsafe');
    }
    return { stat: opened, sha256: sha256Descriptor(descriptor, opened.size) };
  } finally {
    fs.closeSync(descriptor);
  }
}

function assertTrackedOutputUnchanged(
  outputPath: string,
  expected: TrackedOutputSnapshot | null,
): void {
  const observed = inspectTrackedOutput(outputPath);
  if (expected === null) {
    if (observed !== null) throw new Error('Routing calibration output changed before publication');
    return;
  }
  if (observed === null
      || observed.stat.dev !== expected.stat.dev
      || observed.stat.ino !== expected.stat.ino
      || observed.stat.size !== expected.stat.size
      || observed.sha256 !== expected.sha256) {
    throw new Error('Routing calibration output changed before publication');
  }
}

function beginTrackedOutputTransaction(
  outputPath: string,
  safeOwnerControlledDirectory: (
    directory: string,
    label: string,
  ) => { resolved: string; stat: fs.Stats },
  sameFileIdentity: (left: FileIdentity, right: FileIdentity) => boolean,
): TrackedOutputTransaction {
  const requestedOutput = path.resolve(outputPath);
  const parent = safeOwnerControlledDirectory(
    path.dirname(requestedOutput),
    'Routing calibration output parent',
  );
  const canonicalOutput = path.join(parent.resolved, path.basename(requestedOutput));
  const outputBefore = inspectTrackedOutput(canonicalOutput);
  const lockPath = path.join(
    parent.resolved,
    `.${path.basename(canonicalOutput)}.calibration.lock`,
  );
  let lockDescriptor: number;
  try {
    lockDescriptor = fs.openSync(
      lockPath,
      fs.constants.O_CREAT
        | fs.constants.O_EXCL
        | fs.constants.O_RDWR
        | (fs.constants.O_NOFOLLOW ?? 0),
      PRIVATE_FILE_MODE,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error('Routing calibration output is already locked by another calibration transaction');
    }
    throw error;
  }
  try {
    fs.fchmodSync(lockDescriptor, PRIVATE_FILE_MODE);
    fs.writeFileSync(lockDescriptor, `pid=${process.pid}\n`, 'utf8');
    fs.fsyncSync(lockDescriptor);
    const lockStat = fs.fstatSync(lockDescriptor);
    const parentAfter = safeOwnerControlledDirectory(
      path.dirname(requestedOutput),
      'Routing calibration output parent',
    );
    if (!sameFileIdentity(parent.stat, parentAfter.stat)) {
      throw new Error('Routing calibration output parent changed while locking');
    }
    assertTrackedOutputUnchanged(canonicalOutput, outputBefore);
    return {
      requestedOutput,
      canonicalOutput,
      parent,
      outputBefore,
      lockPath,
      lockDescriptor,
      lockStat,
    };
  } catch (error) {
    fs.closeSync(lockDescriptor);
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // Preserve the primary locking failure.
    }
    throw error;
  }
}

function endTrackedOutputTransaction(
  transaction: TrackedOutputTransaction,
  sameFileIdentity: (left: FileIdentity, right: FileIdentity) => boolean,
): void {
  const anchored = fs.fstatSync(transaction.lockDescriptor);
  const atPath = fs.lstatSync(transaction.lockPath);
  if (!anchored.isFile() || !atPath.isFile() || atPath.isSymbolicLink()
      || anchored.nlink !== 1 || atPath.nlink !== 1
      || (anchored.mode & 0o777) !== PRIVATE_FILE_MODE
      || (atPath.mode & 0o777) !== PRIVATE_FILE_MODE
      || !sameFileIdentity(anchored, transaction.lockStat)
      || !sameFileIdentity(anchored, atPath)) {
    fs.closeSync(transaction.lockDescriptor);
    throw new Error('Routing calibration output lock changed during the transaction');
  }
  fs.closeSync(transaction.lockDescriptor);
  fs.unlinkSync(transaction.lockPath);
  const parentDescriptor = fs.openSync(transaction.parent.resolved, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(parentDescriptor);
  } finally {
    fs.closeSync(parentDescriptor);
  }
}

function assertOutputSeparateFromBaseline(
  transaction: TrackedOutputTransaction,
  baseline: HeldPrivateFile | null,
  sameFileIdentity: (left: FileIdentity, right: FileIdentity) => boolean,
): void {
  if (baseline && (
    transaction.canonicalOutput === baseline.resolvedPath
    || (transaction.outputBefore
      && sameFileIdentity(transaction.outputBefore.stat, baseline.stat))
  )) {
    throw new Error('Corpus-mode calibration baseline must be separate from --out');
  }
}

function publishTrackedCalibration(
  transaction: TrackedOutputTransaction,
  bytes: Buffer,
  baseline: HeldPrivateFile | null,
  helpers: {
    safeOwnerControlledDirectory: (
      directory: string,
      label: string,
    ) => { resolved: string; stat: fs.Stats };
    sameFileIdentity: (left: FileIdentity, right: FileIdentity) => boolean;
  },
): string {
  const { requestedOutput, canonicalOutput, outputBefore } = transaction;
  const parentBefore = transaction.parent;
  assertOutputSeparateFromBaseline(transaction, baseline, helpers.sameFileIdentity);

  const temporaryPath = path.join(
    parentBefore.resolved,
    `.${path.basename(canonicalOutput)}.tmp-${process.pid}-${randomUUID()}`,
  );
  let descriptor: number | null = null;
  let renamed = false;
  try {
    descriptor = fs.openSync(
      temporaryPath,
      fs.constants.O_CREAT
        | fs.constants.O_EXCL
        | fs.constants.O_WRONLY
        | (fs.constants.O_NOFOLLOW ?? 0),
      TRACKED_CONFIG_MODE,
    );
    fs.fchmodSync(descriptor, TRACKED_CONFIG_MODE);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;

    if (baseline) {
      assertHeldPrivateFileUnchanged(
        baseline,
        'Reviewed routing calibration baseline',
        helpers.sameFileIdentity,
      );
    }
    const parentAfter = helpers.safeOwnerControlledDirectory(
      path.dirname(requestedOutput),
      'Routing calibration output parent',
    );
    if (!helpers.sameFileIdentity(parentBefore.stat, parentAfter.stat)) {
      throw new Error('Routing calibration output parent changed before publication');
    }
    assertTrackedOutputUnchanged(canonicalOutput, outputBefore);
    fs.renameSync(temporaryPath, canonicalOutput);
    renamed = true;

    const parentDescriptor = fs.openSync(parentAfter.resolved, fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(parentDescriptor);
    } finally {
      fs.closeSync(parentDescriptor);
    }
    const published = inspectTrackedOutput(canonicalOutput);
    const expectedSha256 = sha256Bytes(bytes);
    if (!published || published.sha256 !== expectedSha256
        || published.stat.size !== bytes.length) {
      throw new Error('Published routing calibration bytes failed verification');
    }
    return expectedSha256;
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
    if (!renamed) {
      try {
        fs.unlinkSync(temporaryPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
}

async function main(): Promise<void> {
  const {
    BOOTSTRAP_ROUTING_CALIBRATION,
    buildCorpusRoutingCalibration,
    deriveClassifierFloorCalibration,
    parseRoutingCalibrationForCorpusBaseline,
    withRoutingCalibrationForOfflineReplayAsync,
  } = await import('../src/services/intent-resolution/confidence');
  const {
    assertSanitizedSchema,
    routingCalibrationCacheRowsDigest,
    routingCalibrationCorpusIdentityDigest,
    safeOwnerControlledDirectory,
    safePrivateDirectory,
    safePrivateFile,
    sameFileIdentity,
    validateRoutingCalibrationExportPlan,
    validateRoutingCalibrationExportReceipt,
    verifyRoutingCalibrationExport,
  } = await import('./lib/routing-calibration-export.mjs');
  const generatedAt = parseGeneratedAt(generatedAtRaw);
  const resolvedOut = path.resolve(process.cwd(), outPath);
  if (!forceBootstrap && !fs.existsSync(dbPath)) {
    throw new Error(
      'Routing corpus database does not exist; use --bootstrap only for explicit bootstrap emission',
    );
  }

  // Bootstrap emissions keep the PINNED provenance.generatedAt from the
  // BOOTSTRAP constants so the emitted file is byte-for-byte reproducible
  // (the golden test compares the generated file against the constants,
  // timestamp included). Corpus-mode emissions stamp the real run time.
  let table = BOOTSTRAP_ROUTING_CALIBRATION;
  let labeledCount = 0;
  let llmCoveredCount = 0;
  let classifierFloorCalibrated = false;
  let baselineProvenance = BOOTSTRAP_ROUTING_CALIBRATION.provenance;
  let baselineSha256: string | null = null;
  let inputSha256: string | null = null;
  let baselineAnchor: HeldPrivateFile | null = null;
  let inputAnchor: HeldPrivateFile | null = null;
  const reviewedArtifactAnchors: Array<{
    anchor: HeldPrivateFile;
    label: string;
  }> = [];
  let reviewedExportIdentity: ReviewedExportIdentity | null = null;
  let outputTransaction: TrackedOutputTransaction | null = null;

  try {
    outputTransaction = beginTrackedOutputTransaction(
      resolvedOut,
      safeOwnerControlledDirectory,
      sameFileIdentity,
    );
    if (!forceBootstrap) {
      inputAnchor = openHeldPrivateFile(
        path.resolve(process.cwd(), dbPath),
        'Routing calibration corpus database',
        MAXIMUM_CORPUS_BYTES,
        safePrivateDirectory,
        safePrivateFile,
        sameFileIdentity,
      );
      inputSha256 = inputAnchor.sha256;
      assertNoSQLiteSidecars(inputAnchor.resolvedPath);
      let db: Database.Database | null = null;
      let replayCopyPath: string | null = null;
      try {
        replayCopyPath = createPrivateSQLiteReplayCopy(inputAnchor);
        db = new Database(replayCopyPath, { readonly: true, fileMustExist: true });
        db.pragma('query_only = ON');
        assertNoSQLiteSidecars(inputAnchor.resolvedPath);
        assertNoSQLiteSidecars(replayCopyPath);
        const journalMode = String(db.pragma('journal_mode', { simple: true })).toLowerCase();
        if (journalMode !== 'delete') {
          throw new Error(
            `Routing calibration corpus journal mode must be delete, found ${journalMode}`,
          );
        }
        db.exec('BEGIN');
        try {
          assertSanitizedSchema(db, Database);
        } catch (error) {
          throw new Error(
            `Routing corpus database does not match the required routing calibration corpus schema: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
        const integrity = db.pragma('integrity_check') as Array<{ integrity_check?: string }>;
        if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
          throw new Error('Routing calibration corpus database integrity check failed');
        }
        if ((db.pragma('foreign_key_check') as unknown[]).length !== 0) {
          throw new Error('Routing calibration corpus database foreign-key check failed');
        }
        const acceptedSnapshots = db.prepare(
          'SELECT COUNT(*) AS count FROM accepted_accuracy_snapshots',
        ).get() as { count: number };
        if (Number(acceptedSnapshots.count) !== 0) {
          throw new Error('Routing calibration corpus database contains forbidden snapshot rows');
        }

        const { withStandaloneToolDatabaseAsync } = await import('../src/services/standalone-tool-database');
        await withStandaloneToolDatabaseAsync(db, async () => {
          const { listLabeledRoutingCorpusItems } = await import('../src/services/routing-corpus');
          const items = listLabeledRoutingCorpusItems(db!, { ensureTables: false })
            .filter((item) => item.labelDomain !== null);
          labeledCount = items.length;
          if (labeledCount === 0) {
            throw new Error(
              'Routing corpus database has no labeled items; use --bootstrap only for explicit bootstrap emission',
            );
          }
          if (!generatedAt) {
            throw new Error(
              'Corpus-mode calibration requires --generated-at=<canonical UTC ISO timestamp>',
            );
          }
          if (!baselinePath) {
            throw new Error(
              'Corpus-mode calibration requires --baseline=<reviewed-calibration-json>',
            );
          }
          try {
            baselineAnchor = openHeldPrivateFile(
              path.resolve(process.cwd(), baselinePath),
              'Reviewed routing calibration baseline',
              MAXIMUM_BASELINE_BYTES,
              safePrivateDirectory,
              safePrivateFile,
              sameFileIdentity,
            );
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (message.includes('must have exact mode 0600')) {
              throw new Error('Reviewed routing calibration baseline permissions must be 0600');
            }
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
              throw new Error('Reviewed routing calibration baseline does not exist');
            }
            throw error;
          }
          baselineSha256 = baselineAnchor.sha256;
          let rawBaseline: unknown;
          try {
            rawBaseline = JSON.parse(baselineAnchor.bytes.toString('utf8'));
          } catch {
            throw new Error('Reviewed routing calibration baseline is unreadable');
          }
          const baseline = parseRoutingCalibrationForCorpusBaseline(rawBaseline);
          if (!baseline) {
            throw new Error('Reviewed routing calibration baseline is invalid');
          }
          if (!exportPlanPath || !exportEvidencePath || !exportReceiptPath
              || !acknowledgedPlanDigest) {
            throw new Error(
              'Corpus-mode calibration requires private --export-plan, '
              + '--export-evidence, --export-receipt, and --ack-plan artifacts',
            );
          }
          for (const [artifactPath, label] of [
            [exportPlanPath, 'Reviewed routing calibration export plan'],
            [exportEvidencePath, 'Reviewed routing calibration export evidence'],
            [exportReceiptPath, 'Reviewed routing calibration export receipt'],
          ] as const) {
            reviewedArtifactAnchors.push({
              anchor: openHeldPrivateFile(
                path.resolve(process.cwd(), artifactPath),
                label,
                MAXIMUM_EXPORT_ARTIFACT_BYTES,
                safePrivateDirectory,
                safePrivateFile,
                sameFileIdentity,
              ),
              label,
            });
          }
          let exportPlan: any;
          let exportEvidence: any;
          let exportReceipt: any;
          try {
            [exportPlan, exportEvidence, exportReceipt] = reviewedArtifactAnchors.map(
              ({ anchor }) => JSON.parse(anchor.bytes.toString('utf8')),
            );
          } catch {
            throw new Error('Reviewed routing calibration export artifacts are unreadable');
          }
          const validatedPlan = validateRoutingCalibrationExportPlan(exportPlan);
          const validatedReceipt = validateRoutingCalibrationExportReceipt(
            exportReceipt,
            validatedPlan,
            exportEvidence,
          );
          if (acknowledgedPlanDigest !== validatedPlan.planDigest) {
            throw new Error(
              'Acknowledged routing calibration export plan digest does not match the validated plan',
            );
          }
          const observedExport = verifyRoutingCalibrationExport({
            plan: validatedPlan,
            evidence: exportEvidence,
            releaseDir: process.cwd(),
            outputPath: replayCopyPath!,
            copiedEvidence: true,
          });
          if (observedExport.providerCalls !== 0
              || observedExport.providerCalled !== false
              || observedExport.externalCallPerformed !== false
              || validatedReceipt.providerCalls !== 0
              || validatedReceipt.providerCalled !== false
              || validatedReceipt.externalCallPerformed !== false) {
            throw new Error('Reviewed routing calibration export performed provider work');
          }
          reviewedExportIdentity = {
            runtimeSha: validatedPlan.runtimeSha,
            artifactDigest: validatedPlan.artifactDigest,
            transactionId: validatedPlan.transactionId,
            planDigest: validatedPlan.planDigest,
            receiptDigest: validatedReceipt.receiptDigest,
            inputSha256: observedExport.outputSha256.slice('sha256:'.length),
            corpusRows: observedExport.corpusRows,
            corpusIdentityDigest: observedExport.corpusIdentityDigest,
            cacheRowsDigest: observedExport.cacheRowsDigest,
            cacheRows: observedExport.cacheRows,
            providerCalls: observedExport.providerCalls,
          };
          if (inputAnchor!.sha256 !== reviewedExportIdentity.inputSha256) {
            throw new Error('Routing calibration input SHA-256 differs from the reviewed export receipt');
          }
          const totalCorpusRows = Number((db!.prepare(
            'SELECT COUNT(*) AS count FROM routing_corpus_items',
          ).get() as { count: number }).count);
          if (reviewedExportIdentity.corpusRows !== EXPECTED_CORPUS_ROWS
              || totalCorpusRows !== EXPECTED_CORPUS_ROWS
              || items.length !== EXPECTED_CORPUS_ROWS
              || items.some((item) => (
                item.tenantId !== 0
                || item.userId !== null
                || !['bilingual_fixture', 'manual'].includes(item.source)
                || item.suggestedDomain !== null
                || item.suggestedSkill !== null
                || item.labelStatus !== 'labeled'
                || item.labelDomain === null
                || item.labeledAt === null
                || item.utteranceText === null
              ))) {
            throw new Error('Routing calibration corpus differs from the reviewed 300-row export');
          }
          const corpusIdentityDigest = routingCalibrationCorpusIdentityDigest(items);
          if (corpusIdentityDigest !== reviewedExportIdentity.corpusIdentityDigest) {
            throw new Error('Routing calibration corpus identity differs from the reviewed export receipt');
          }
          const cacheRows = db!.prepare(`
            SELECT utterance_hash AS utteranceHash, domain, confidence,
                   model, created_at AS createdAt
            FROM routing_llm_classify_cache
            ORDER BY utterance_hash ASC
          `).all() as Array<{
            utteranceHash: string;
            domain: string;
            confidence: number;
            model: string | null;
            createdAt: string;
          }>;
          if (cacheRows.length !== reviewedExportIdentity.cacheRows
              || cacheRows.some((row) => row.model !== null)
              || routingCalibrationCacheRowsDigest(cacheRows)
                !== reviewedExportIdentity.cacheRowsDigest) {
            throw new Error('Routing calibration cache differs from the reviewed export receipt');
          }
          await withRoutingCalibrationForOfflineReplayAsync(baseline, async () => {
            const { predictRoutingSurfaces } = await import('../src/services/routing-accuracy');
            const { resolveIntentAgainst } = await import('../src/services/intent-resolution/intent-resolver');
            const { getCompiledIntentVocabulary } = await import('../src/services/intent-resolution/vocabulary');
            const vocabulary = getCompiledIntentVocabulary();
            const orchestrator: Array<{ statedConfidence: number; correct: boolean }> = [];
            const llmClassifier: Array<{ statedConfidence: number; correct: boolean }> = [];
            const resolver: Array<{ rawScore: number; correct: boolean }> = [];
            for (const item of items) {
              const label = item.labelDomain as string;
              const predictions = predictRoutingSurfaces(item, { db: db!, vocabulary });
              for (const prediction of predictions) {
                if (!prediction.covered || typeof prediction.confidence !== 'number') continue;
                if (prediction.surface === 'orchestrator_analyze') {
                  orchestrator.push({ statedConfidence: prediction.confidence, correct: prediction.domain === label });
                } else if (prediction.surface === 'llm_classify_cache') {
                  llmClassifier.push({ statedConfidence: prediction.confidence, correct: prediction.domain === label });
                }
              }
              const topCandidate = resolveIntentAgainst(vocabulary, item.utteranceText ?? '')[0];
              resolver.push({
                rawScore: topCandidate?.rawScore ?? 0,
                correct: (topCandidate?.domain ?? 'none') === label,
              });
            }
            baselineProvenance = baseline.provenance;
            llmCoveredCount = llmClassifier.length;
            const classifierFloor = deriveClassifierFloorCalibration({
              observations: llmClassifier,
              corpusSize: labeledCount,
              baselineFloor: baseline.classifier.lowConfidenceFloor,
            });
            classifierFloorCalibrated = classifierFloor.calibrated;
            table = buildCorpusRoutingCalibration({
              orchestrator,
              resolver,
              llmClassifier,
              corpusSize: labeledCount,
              generatedAt,
              // Group branches by the same explicit table that drove replay.
              baseline,
            });
          });
        });
      } finally {
        if (db) {
          if (db.inTransaction) db.exec('ROLLBACK');
          db.close();
        }
        if (replayCopyPath) {
          let replaySafetyError: unknown;
          try {
            assertNoSQLiteSidecars(replayCopyPath);
            if (sha256Bytes(fs.readFileSync(replayCopyPath)) !== inputAnchor.sha256) {
              throw new Error('Private routing calibration replay copy changed during replay');
            }
          } catch (error) {
            replaySafetyError = error;
          }
          removePrivateSQLiteReplayCopy(replayCopyPath);
          if (replaySafetyError) throw replaySafetyError;
        }
        assertNoSQLiteSidecars(inputAnchor.resolvedPath);
        assertHeldPrivateFileUnchanged(
          inputAnchor,
          'Routing calibration corpus database',
          sameFileIdentity,
        );
      }
    }

    const outputBytes = Buffer.from(`${JSON.stringify(table, null, 2)}\n`, 'utf8');
    assertOutputSeparateFromBaseline(
      outputTransaction,
      baselineAnchor,
      sameFileIdentity,
    );
    if (inputAnchor) {
      assertNoSQLiteSidecars(inputAnchor.resolvedPath);
      assertHeldPrivateFileUnchanged(
        inputAnchor,
        'Routing calibration corpus database',
        sameFileIdentity,
      );
    }
    for (const { anchor, label } of reviewedArtifactAnchors) {
      assertHeldPrivateFileUnchanged(anchor, label, sameFileIdentity);
    }
    if (dryRun) {
      assertTrackedOutputUnchanged(
        outputTransaction.canonicalOutput,
        outputTransaction.outputBefore,
      );
    }
    const outputSha256 = dryRun
      ? sha256Bytes(outputBytes)
      : publishTrackedCalibration(outputTransaction, outputBytes, baselineAnchor, {
        safeOwnerControlledDirectory,
        sameFileIdentity,
      });
    console.log(JSON.stringify({
      schemaVersion: 'routing_calibration_run.v1',
      dbPath,
      inputSha256,
      baselineSha256,
      reviewedExportIdentity,
      outPath: resolvedOut,
      outputSha256,
      dryRun,
      mode: table.provenance.source,
      labeledCorpusItems: labeledCount,
      llmCoverage: {
        covered: llmCoveredCount,
        total: labeledCount,
        complete: labeledCount > 0 && llmCoveredCount === labeledCount,
        classifierFloorCalibrated,
      },
      baselineProvenance,
      providerCalls: 0,
      table,
    }, null, 2));
  } finally {
    try {
      if (inputAnchor) {
        try {
          assertNoSQLiteSidecars(inputAnchor.resolvedPath);
          assertHeldPrivateFileUnchanged(
            inputAnchor,
            'Routing calibration corpus database',
            sameFileIdentity,
          );
        } finally {
          closeHeldPrivateFile(inputAnchor);
        }
      }
    } finally {
      try {
        if (baselineAnchor) closeHeldPrivateFile(baselineAnchor);
      } finally {
        try {
          assertAndCloseHeldPrivateFiles(
            reviewedArtifactAnchors,
            sameFileIdentity,
          );
        } finally {
          if (outputTransaction) {
            endTrackedOutputTransaction(outputTransaction, sameFileIdentity);
          }
        }
      }
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
});
