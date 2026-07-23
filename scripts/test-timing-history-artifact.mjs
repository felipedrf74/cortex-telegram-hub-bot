#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const MAX_ARCHIVE_BYTES = 5 * 1024 * 1024;
const MAX_INVENTORY_BYTES = 2 * 1024 * 1024;
const MAX_METADATA_BYTES = 2 * 1024 * 1024;
const MAX_API_ARTIFACTS = 100;
const MAX_ARCHIVE_ENTRIES = 20;
// upload-artifact roots the two `.local/*` inputs at their common `.local`
// ancestor, so the archive carries this stable relative entry.
const INVENTORY_ENTRY = 'test-inventory/test-inventory.json';

function valueOf(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1] ?? null;
}

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

function readBoundedRegularFile(file, maximumBytes, label) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch {
    fail(`${label} does not exist.`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) fail(`${label} must be a regular file.`);
  if (stat.size < 1 || stat.size > maximumBytes) {
    fail(`${label} exceeds its bounded size.`);
  }
  return fs.readFileSync(file);
}

function writePrivateJson(outputPath, value) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(value, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
}

function selectArtifact({ runId, metadata }) {
  if (!/^[1-9]\d*$/.test(runId ?? '')) throw new Error('run ID must be a positive integer');
  if (!Array.isArray(metadata?.artifacts) || metadata.artifacts.length > MAX_API_ARTIFACTS) {
    throw new Error('run-artifacts response is invalid or exceeds 100 entries');
  }
  const namePrefix = `test-inventory-${runId}-`;
  const attemptFor = (name) => {
    if (typeof name !== 'string' || !name.startsWith(namePrefix)) return null;
    const attempt = name.slice(namePrefix.length);
    return /^[1-9]\d*$/.test(attempt) ? attempt : null;
  };
  const matches = metadata.artifacts.filter((artifact) => (
    artifact?.expired === false && attemptFor(artifact?.name) !== null
  ));
  if (matches.length !== 1) {
    throw new Error(`expected exactly one non-expired timing artifact for run ${runId}`);
  }
  const artifact = matches[0];
  const attempt = Number(attemptFor(artifact.name));
  if (!Number.isSafeInteger(artifact.id) || artifact.id < 1
      || !Number.isSafeInteger(artifact.size_in_bytes) || artifact.size_in_bytes < 1
      || artifact.size_in_bytes > MAX_ARCHIVE_BYTES
      || (artifact.workflow_run?.id !== undefined
        && String(artifact.workflow_run.id) !== runId)) {
    throw new Error(`timing artifact metadata for run ${runId} is invalid or oversized`);
  }
  return {
    artifactId: artifact.id,
    name: artifact.name,
    runId,
    runAttempt: attempt,
    archiveBytes: artifact.size_in_bytes,
  };
}

function selectCommand(args) {
  const runId = valueOf(args, '--run-id');
  const artifactsPath = valueOf(args, '--artifacts');
  const outputPath = valueOf(args, '--output');
  if (!runId || !artifactsPath || !outputPath) {
    fail('select requires --run-id, --artifacts, and --output.', 64);
  }
  let metadata;
  try {
    metadata = JSON.parse(readBoundedRegularFile(
      artifactsPath,
      MAX_METADATA_BYTES,
      'Run-artifacts metadata',
    ));
  } catch (error) {
    fail(`Run-artifacts metadata is invalid: ${error.message}`);
  }
  let selected;
  try {
    selected = selectArtifact({ runId, metadata });
  } catch (error) {
    fail(error.message);
  }
  writePrivateJson(outputPath, selected);
  console.log(String(selected.artifactId));
}

function safeArchiveEntries(archivePath) {
  const listing = spawnSync('unzip', ['-Z1', archivePath], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024,
  });
  if (listing.error || listing.status !== 0) throw new Error('artifact archive listing failed');
  const entries = listing.stdout.split(/\r?\n/).filter(Boolean);
  if (entries.length < 1 || entries.length > MAX_ARCHIVE_ENTRIES) {
    throw new Error('artifact archive entry count is invalid');
  }
  for (const entry of entries) {
    const normalized = entry.endsWith('/') ? entry.slice(0, -1) : entry;
    const segments = normalized.split('/');
    if (normalized.length < 1 || entry.length > 512
        || normalized.startsWith('/') || normalized.includes('\\')
        || segments.includes('..') || segments.includes('')) {
      throw new Error('artifact archive contains an unsafe entry path');
    }
  }
  if (entries.filter((entry) => entry === INVENTORY_ENTRY).length !== 1) {
    throw new Error('artifact archive must contain exactly one canonical inventory entry');
  }
}

function extractCommand(args) {
  const archivePath = valueOf(args, '--archive');
  const outputPath = valueOf(args, '--output');
  if (!archivePath || !outputPath) fail('extract requires --archive and --output.', 64);
  readBoundedRegularFile(archivePath, MAX_ARCHIVE_BYTES, 'Artifact archive');
  try {
    safeArchiveEntries(archivePath);
  } catch (error) {
    fail(error.message);
  }
  const extracted = spawnSync('unzip', ['-p', archivePath, INVENTORY_ENTRY], {
    encoding: null,
    maxBuffer: MAX_INVENTORY_BYTES + 1,
  });
  if (extracted.error || extracted.status !== 0
      || !Buffer.isBuffer(extracted.stdout)
      || extracted.stdout.length < 1
      || extracted.stdout.length > MAX_INVENTORY_BYTES) {
    fail('Extracted timing inventory is missing, invalid, or oversized.');
  }
  let inventory;
  try {
    inventory = JSON.parse(extracted.stdout.toString('utf8'));
  } catch {
    fail('Extracted timing inventory is not valid JSON.');
  }
  if (!inventory || typeof inventory !== 'object'
      || !inventory.summary || !Array.isArray(inventory.records)) {
    fail('Extracted timing inventory has an invalid document shape.');
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, extracted.stdout, { flag: 'wx', mode: 0o600 });
}

const [command, ...args] = process.argv.slice(2);
if (command === 'select') selectCommand(args);
else if (command === 'extract') extractCommand(args);
else fail('Usage: test-timing-history-artifact.mjs <select|extract> ...', 64);
