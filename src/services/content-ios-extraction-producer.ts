// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  createContentIosExtractionArtifactFromXcresultDocuments,
  CONTENT_IOS_EXTRACTION_TEST_IDENTIFIERS,
  CONTENT_IOS_TEST_EVIDENCE_ATTACHMENT_NAME,
  normalizeContentIosTestIdentifier,
  validateContentIosExtractionArtifact,
  type ContentIosExtractionArtifact,
} from './content-ios-extraction-artifact';
import { contentLiveEvalAttestationKeyFingerprint } from './content-live-evaluation-artifact';

const XCRUN_PATH = '/usr/bin/xcrun';
const GIT_PATH = '/usr/bin/git';
const XCRESULTTOOL_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const CONTENT_IOS_ATTACHMENT_MAX_BYTES = 64 * 1024;

export interface ContentIosSourceIdentity {
  gitCommit: string;
  sourceTreeDigest: string;
}

export interface ContentIosXcresultEvidence {
  xcresultDigest: string;
  testsJson: string;
  summaryJson: string;
  attachmentsJson: string;
}

export interface ProducedContentIosExtraction {
  artifact: ContentIosExtractionArtifact;
  sourceIdentity: ContentIosSourceIdentity;
  testsJson: string;
  summaryJson: string;
  attachmentsJson: string;
}

export type ContentIosExtractionCommandRunner = (
  executable: string,
  args: readonly string[],
  cwd?: string,
) => string;

export function readContentIosAttachmentEvidenceFromExportDirectory(exportDirectory: string): string {
  const requestedExportDirectory = path.resolve(exportDirectory);
  const rootStat = fs.lstatSync(requestedExportDirectory);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('CONTENT_IOS_EXTRACTION_ATTACHMENT_EXPORT_INVALID');
  }
  const resolvedExportDirectory = fs.realpathSync(requestedExportDirectory);
  const manifestPath = path.join(resolvedExportDirectory, 'manifest.json');
  const manifestStat = fs.lstatSync(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > CONTENT_IOS_ATTACHMENT_MAX_BYTES) {
    throw new Error('CONTENT_IOS_EXTRACTION_ATTACHMENT_MANIFEST_INVALID');
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as unknown;
  if (!Array.isArray(manifest)) throw new Error('CONTENT_IOS_EXTRACTION_ATTACHMENT_MANIFEST_INVALID');
  const payloads = CONTENT_IOS_EXTRACTION_TEST_IDENTIFIERS.map((requiredIdentifier) => {
    const required = normalizeContentIosTestIdentifier(requiredIdentifier);
    const matchingTests = manifest.filter((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
      const identifier = (entry as Record<string, unknown>).testIdentifier;
      if (typeof identifier !== 'string') return false;
      const normalized = normalizeContentIosTestIdentifier(identifier);
      return normalized === required || normalized.endsWith(`/${required}`);
    }) as Array<Record<string, unknown>>;
    const matchingAttachments = matchingTests.flatMap((entry) => {
      const attachments = entry.attachments;
      return Array.isArray(attachments) ? attachments : [];
    }).filter((attachment) => (
      attachment
      && typeof attachment === 'object'
      && !Array.isArray(attachment)
      && (attachment as Record<string, unknown>).suggestedHumanReadableName === CONTENT_IOS_TEST_EVIDENCE_ATTACHMENT_NAME
    )) as Array<Record<string, unknown>>;
    if (matchingAttachments.length !== 1) throw new Error('CONTENT_IOS_EXTRACTION_ATTACHMENT_COUNT_INVALID');
    const attachment = matchingAttachments[0];
    if (attachment.isAssociatedWithFailure !== false || typeof attachment.exportedFileName !== 'string') {
      throw new Error('CONTENT_IOS_EXTRACTION_ATTACHMENT_METADATA_INVALID');
    }
    const exportedFileName = attachment.exportedFileName;
    if (path.basename(exportedFileName) !== exportedFileName) {
      throw new Error('CONTENT_IOS_EXTRACTION_ATTACHMENT_PATH_INVALID');
    }
    const attachmentPath = path.join(resolvedExportDirectory, exportedFileName);
    const attachmentStat = fs.lstatSync(attachmentPath);
    if (!attachmentStat.isFile() || attachmentStat.isSymbolicLink() || attachmentStat.size > CONTENT_IOS_ATTACHMENT_MAX_BYTES) {
      throw new Error('CONTENT_IOS_EXTRACTION_ATTACHMENT_FILE_INVALID');
    }
    return JSON.parse(fs.readFileSync(attachmentPath, 'utf8')) as unknown;
  });
  return JSON.stringify(payloads);
}

function execUtf8(executable: string, args: readonly string[], cwd?: string): string {
  return execFileSync(executable, [...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: XCRESULTTOOL_MAX_OUTPUT_BYTES,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function updateFramed(hash: crypto.Hash, value: string): void {
  const bytes = Buffer.from(value, 'utf8');
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  hash.update(length);
  hash.update(bytes);
}

/** Deterministic SHA-256 over names, node kinds, and bytes in a result bundle. */
export function digestContentIosXcresultBundle(bundlePath: string): string {
  const requested = path.resolve(bundlePath);
  const rootStat = fs.lstatSync(requested);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('CONTENT_IOS_EXTRACTION_XCRESULT_NOT_REGULAR_DIRECTORY');
  }
  const resolved = fs.realpathSync(requested);
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);

  const visit = (absolutePath: string, relativePath: string): void => {
    const stat = fs.lstatSync(absolutePath);
    if (stat.isSymbolicLink()) throw new Error('CONTENT_IOS_EXTRACTION_XCRESULT_SYMLINK_REJECTED');
    if (stat.isDirectory()) {
      updateFramed(hash, `directory:${relativePath}`);
      for (const entry of fs.readdirSync(absolutePath).sort()) {
        visit(path.join(absolutePath, entry), relativePath ? `${relativePath}/${entry}` : entry);
      }
      return;
    }
    if (!stat.isFile()) throw new Error('CONTENT_IOS_EXTRACTION_XCRESULT_SPECIAL_FILE_REJECTED');
    updateFramed(hash, `file:${relativePath}`);
    const fd = fs.openSync(absolutePath, 'r');
    try {
      let bytesRead = 0;
      do {
        bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
        if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
      } while (bytesRead > 0);
    } finally {
      fs.closeSync(fd);
    }
  };
  visit(resolved, '');
  return hash.digest('hex');
}

/**
 * Resolve a release identity from a clean iOS Git worktree. The SHA-256 tree
 * digest deliberately covers Git's full recursive tree listing; uncommitted
 * or untracked files are rejected rather than silently omitted.
 */
export function resolveContentIosSourceIdentity(iosRepoPath: string): ContentIosSourceIdentity {
  const requested = fs.realpathSync(path.resolve(iosRepoPath));
  const repoRoot = fs.realpathSync(execUtf8(GIT_PATH, ['-C', requested, 'rev-parse', '--show-toplevel']).trim());
  const status = execUtf8(GIT_PATH, ['-C', repoRoot, 'status', '--porcelain=v1', '--untracked-files=all']);
  if (status.length > 0) throw new Error('CONTENT_IOS_EXTRACTION_IOS_TREE_NOT_CLEAN');
  const gitCommit = execUtf8(GIT_PATH, ['-C', repoRoot, 'rev-parse', 'HEAD']).trim();
  if (!/^[a-f0-9]{40}$/.test(gitCommit)) throw new Error('CONTENT_IOS_EXTRACTION_IOS_COMMIT_INVALID');
  const treeListing = execUtf8(GIT_PATH, ['-C', repoRoot, 'ls-tree', '-r', '--full-tree', 'HEAD']);
  return {
    gitCommit,
    sourceTreeDigest: crypto.createHash('sha256').update(treeListing).digest('hex'),
  };
}

/**
 * Obtain both Apple JSON documents directly from the same `.xcresult`. There
 * is intentionally no production option for supplying caller-authored test
 * statuses, metric counts, or timestamps.
 */
export function extractContentIosXcresultEvidence(
  bundlePath: string,
  dependencies: { exec?: ContentIosExtractionCommandRunner } = {},
): ContentIosXcresultEvidence {
  const requested = path.resolve(bundlePath);
  const stat = fs.lstatSync(requested);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('CONTENT_IOS_EXTRACTION_XCRESULT_NOT_REGULAR_DIRECTORY');
  }
  const resolved = fs.realpathSync(requested);
  const runCommand = dependencies.exec ?? execUtf8;
  const xcresultDigestBeforeExtraction = digestContentIosXcresultBundle(resolved);
  const testsJson = runCommand(XCRUN_PATH, [
    'xcresulttool', 'get', 'test-results', 'tests', '--path', resolved, '--compact',
  ]);
  const summaryJson = runCommand(XCRUN_PATH, [
    'xcresulttool', 'get', 'test-results', 'summary', '--path', resolved, '--compact',
  ]);
  const exportDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-content-ios-attachments-'));
  fs.chmodSync(exportDirectory, 0o700);
  let attachmentsJson: string;
  try {
    runCommand(XCRUN_PATH, [
      'xcresulttool', 'export', 'attachments', '--path', resolved, '--output-path', exportDirectory,
    ]);
    attachmentsJson = readContentIosAttachmentEvidenceFromExportDirectory(exportDirectory);
  } finally {
    fs.rmSync(exportDirectory, { recursive: true, force: true });
  }
  const xcresultDigestAfterExtraction = digestContentIosXcresultBundle(resolved);
  if (xcresultDigestAfterExtraction !== xcresultDigestBeforeExtraction) {
    throw new Error('CONTENT_IOS_EXTRACTION_XCRESULT_MUTATED_DURING_EXTRACTION');
  }
  return {
    xcresultDigest: xcresultDigestAfterExtraction,
    testsJson,
    summaryJson,
    attachmentsJson,
  };
}

export function produceContentIosExtractionArtifact(input: {
  xcresultPath: string;
  iosRepoPath: string;
  attestationKey: Buffer;
  now?: Date;
}, dependencies: {
  resolveSourceIdentity?: typeof resolveContentIosSourceIdentity;
  extractEvidence?: typeof extractContentIosXcresultEvidence;
} = {}): ProducedContentIosExtraction {
  const resolveSourceIdentity = dependencies.resolveSourceIdentity ?? resolveContentIosSourceIdentity;
  const extractEvidence = dependencies.extractEvidence ?? extractContentIosXcresultEvidence;
  const sourceIdentity = resolveSourceIdentity(input.iosRepoPath);
  const evidence = extractEvidence(input.xcresultPath);
  const sourceIdentityAfterExtraction = resolveSourceIdentity(input.iosRepoPath);
  if (
    sourceIdentityAfterExtraction.gitCommit !== sourceIdentity.gitCommit
    || sourceIdentityAfterExtraction.sourceTreeDigest !== sourceIdentity.sourceTreeDigest
  ) {
    throw new Error('CONTENT_IOS_EXTRACTION_IOS_SOURCE_MUTATED_DURING_EXTRACTION');
  }
  const artifact = createContentIosExtractionArtifactFromXcresultDocuments({
    ...evidence,
    iosGitCommit: sourceIdentity.gitCommit,
    iosSourceTreeDigest: sourceIdentity.sourceTreeDigest,
    attestationKey: input.attestationKey,
  });
  const validation = validateContentIosExtractionArtifact(artifact, {
    attestationKey: input.attestationKey,
    trustedAttestationKeyFingerprint: contentLiveEvalAttestationKeyFingerprint(input.attestationKey),
    expectedIosGitCommit: sourceIdentity.gitCommit,
    expectedIosSourceTreeDigest: sourceIdentity.sourceTreeDigest,
    now: input.now,
  });
  if (!validation.valid || !validation.releaseQualified) {
    throw new Error(`CONTENT_IOS_EXTRACTION_ARTIFACT_NOT_RELEASE_QUALIFIED:${validation.reason ?? 'score'}`);
  }
  return {
    artifact,
    sourceIdentity,
    testsJson: evidence.testsJson,
    summaryJson: evidence.summaryJson,
    attachmentsJson: evidence.attachmentsJson,
  };
}
