#!/usr/bin/env node
// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { produceContentIosExtractionArtifact } from '../src/services/content-ios-extraction-producer';
import { readContentLiveEvalAttestationKeyFile } from '../src/services/content-live-evaluation-artifact';

interface Options {
  xcresult?: string;
  iosRepo?: string;
  artifact?: string;
  testsOut?: string;
  summaryOut?: string;
  attachmentsOut?: string;
  attestationKeyFile?: string;
  help?: boolean;
}

const USAGE = `Usage:
  npx tsx scripts/create-content-ios-extraction-artifact.ts \\
    --xcresult /absolute/path/ContentExtraction.xcresult \\
    --ios-repo /absolute/path/to/clean/ios/repo \\
    --artifact /absolute/path/content-ios-extraction.json \\
    --tests-out /absolute/path/content-ios-tests.json \\
    --summary-out /absolute/path/content-ios-summary.json \\
    --attachments-out /absolute/path/content-ios-attachments.json \\
    --attestation-key-file /absolute/path/operator-key

The producer reads test status and duration directly from Apple's xcresulttool.
It does not accept caller-supplied scores, metrics, statuses, test IDs, or SHA.
`;

function parseArgs(argv: readonly string[]): Options {
  const options: Options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) throw new Error(`Missing value for ${arg}`);
    if (arg === '--xcresult') options.xcresult = next;
    else if (arg === '--ios-repo') options.iosRepo = next;
    else if (arg === '--artifact') options.artifact = next;
    else if (arg === '--tests-out') options.testsOut = next;
    else if (arg === '--summary-out') options.summaryOut = next;
    else if (arg === '--attachments-out') options.attachmentsOut = next;
    else if (arg === '--attestation-key-file') options.attestationKeyFile = next;
    else throw new Error(`Unknown Content iOS extraction argument: ${arg}`);
    index += 1;
  }
  return options;
}

function required(value: string | undefined, flag: string): string {
  if (!value?.trim()) throw new Error(`Missing required ${flag}`);
  return value;
}

function writeExclusive(filePath: string, value: string): void {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const fd = fs.openSync(resolved, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, value, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function writeContentIosExtractionOutputSet(
  outputs: ReadonlyArray<{ filePath: string; value: string }>,
  dependencies: { link?: typeof fs.linkSync } = {},
): void {
  if (outputs.length === 0) throw new Error('Content iOS extraction output set is empty');
  const resolvedOutputs = outputs.map((output) => ({
    filePath: path.resolve(output.filePath),
    value: output.value,
  }));
  if (new Set(resolvedOutputs.map((output) => output.filePath)).size !== resolvedOutputs.length) {
    throw new Error('Content iOS extraction output paths must be distinct');
  }
  const parent = path.dirname(resolvedOutputs[0].filePath);
  if (resolvedOutputs.some((output) => path.dirname(output.filePath) !== parent)) {
    throw new Error('Content iOS extraction outputs must share one directory');
  }
  fs.mkdirSync(parent, { recursive: true });
  if (resolvedOutputs.some((output) => fs.existsSync(output.filePath))) {
    throw new Error('Content iOS extraction output already exists');
  }
  const stagingDirectory = fs.mkdtempSync(path.join(parent, '.content-ios-extraction-staging.'));
  fs.chmodSync(stagingDirectory, 0o700);
  const staged = resolvedOutputs.map((output) => ({
    ...output,
    stagedPath: path.join(stagingDirectory, path.basename(output.filePath)),
  }));
  const committed: string[] = [];
  const link = dependencies.link ?? fs.linkSync;
  try {
    for (const output of staged) writeExclusive(output.stagedPath, output.value);
    for (const output of staged) {
      link(output.stagedPath, output.filePath);
      committed.push(output.filePath);
    }
    const parentFd = fs.openSync(parent, 'r');
    try {
      fs.fsyncSync(parentFd);
    } finally {
      fs.closeSync(parentFd);
    }
  } catch (error) {
    for (const committedPath of committed.reverse()) fs.rmSync(committedPath, { force: true });
    throw error;
  } finally {
    fs.rmSync(stagingDirectory, { recursive: true, force: true });
  }
}

export function main(): void {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(USAGE);
    return;
  }
  const xcresultPath = required(options.xcresult, '--xcresult');
  const iosRepoPath = required(options.iosRepo, '--ios-repo');
  const artifactPath = required(options.artifact, '--artifact');
  const testsOutPath = required(options.testsOut, '--tests-out');
  const summaryOutPath = required(options.summaryOut, '--summary-out');
  const attachmentsOutPath = required(options.attachmentsOut, '--attachments-out');
  const keyPath = required(options.attestationKeyFile, '--attestation-key-file');
  const attestationKey = readContentLiveEvalAttestationKeyFile(keyPath);
  const produced = produceContentIosExtractionArtifact({ xcresultPath, iosRepoPath, attestationKey });
  writeContentIosExtractionOutputSet([
    { filePath: testsOutPath, value: produced.testsJson },
    { filePath: summaryOutPath, value: produced.summaryJson },
    { filePath: attachmentsOutPath, value: produced.attachmentsJson },
    // The signed artifact is committed last and is the completion signal for
    // direct CLI consumers; the canonical release wrapper adds its own marker.
    { filePath: artifactPath, value: `${JSON.stringify(produced.artifact, null, 2)}\n` },
  ]);

  process.stdout.write(`Content iOS extraction artifact: ${path.resolve(artifactPath)}\n`);
  process.stdout.write(`Run ID: ${produced.artifact.runId}\n`);
  process.stdout.write(`iOS git commit: ${produced.sourceIdentity.gitCommit}\n`);
  process.stdout.write(`iOS source tree digest: ${produced.sourceIdentity.sourceTreeDigest}\n`);
  process.stdout.write(`Score: ${produced.artifact.score}/100\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
