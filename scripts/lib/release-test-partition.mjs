import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  loadTestPolicy,
  partitionTestFiles,
  root as repositoryRoot,
  walkTestFiles,
} from './test-policy.mjs';

function fail(message) {
  throw new Error(message);
}

function normalizeInventory(files, label) {
  if (!Array.isArray(files)) fail(`${label} must be an array`);
  const normalized = [...new Set(files.map((file) => String(file)))].sort();
  if (JSON.stringify(files) !== JSON.stringify(normalized)
      || normalized.some((file) => !/^__tests__\/.+\.test\.ts$/.test(file)
        || path.isAbsolute(file)
        || file.split('/').includes('..'))) {
    fail(`${label} must be a sorted, unique test-file inventory`);
  }
  return normalized;
}

export function testInventoryDigest(files) {
  return createHash('sha256')
    .update(files.length === 0 ? '' : `${files.join('\n')}\n`)
    .digest('hex');
}

export function deterministicTestInventory(sourceRoot = repositoryRoot) {
  return partitionTestFiles(
    walkTestFiles(sourceRoot),
    loadTestPolicy(sourceRoot),
  ).deterministic;
}

export function buildReleaseTestPartition(selection, sourceRoot = repositoryRoot) {
  if (!selection || typeof selection !== 'object' || Array.isArray(selection)
      || selection.schema !== 'nexus.test-selection.v2'
      || typeof selection.docsOnly !== 'boolean') {
    fail('protected-main test selection schema is invalid');
  }
  const deterministic = deterministicTestInventory(sourceRoot);
  const selected = normalizeInventory(selection.selected, 'protected-main selected tests');
  const deterministicSet = new Set(deterministic);
  const outside = selected.filter((file) => !deterministicSet.has(file));
  if (outside.length > 0) {
    fail(`protected-main selection is outside deterministic inventory: ${outside.join(', ')}`);
  }
  if (selection.docsOnly && selected.length !== 0) {
    fail('docs-only protected-main selection must not contain tests');
  }
  if (!selection.docsOnly && selected.length === 0) {
    fail('non-docs protected-main selection must contain tests');
  }
  const selectedSet = new Set(selected);
  const remaining = deterministic.filter((file) => !selectedSet.has(file));
  if (remaining.length === 0) {
    fail('release checkpoint has no deterministic remainder to execute');
  }
  return {
    deterministic,
    selected,
    remaining,
    proof: {
      deterministic: {
        files: deterministic.length,
        sha256: testInventoryDigest(deterministic),
      },
      selected: {
        files: selected.length,
        sha256: testInventoryDigest(selected),
      },
      remaining: {
        files: remaining.length,
        sha256: testInventoryDigest(remaining),
      },
      disjoint: true,
      complete: selected.length + remaining.length === deterministic.length,
    },
  };
}

export function vitestResultFiles(report, sourceRoot = repositoryRoot, label = 'Vitest result') {
  if (!report || typeof report !== 'object' || Array.isArray(report)
      || !Array.isArray(report.testResults)) {
    fail(`${label} does not contain a test-file result inventory`);
  }
  const normalized = report.testResults.map((entry) => {
    if (!entry || typeof entry !== 'object' || typeof entry.name !== 'string') {
      fail(`${label} contains an invalid test-file result`);
    }
    const absolute = path.isAbsolute(entry.name)
      ? path.normalize(entry.name)
      : path.resolve(sourceRoot, entry.name);
    const relative = path.relative(sourceRoot, absolute).split(path.sep).join('/');
    if (!relative
        || relative === '..'
        || relative.startsWith('../')
        || !/^__tests__\/.+\.test\.ts$/.test(relative)) {
      fail(`${label} contains a test outside the repository inventory`);
    }
    return relative;
  }).sort();
  if (new Set(normalized).size !== normalized.length) {
    fail(`${label} contains duplicate test-file results`);
  }
  return normalized;
}

export function verifyReleaseTestResults({
  partition,
  selectedReport = null,
  shardReports,
  sourceRoot = repositoryRoot,
}) {
  if (!partition || !Array.isArray(partition.deterministic)
      || !Array.isArray(partition.selected) || !Array.isArray(partition.remaining)) {
    fail('release test partition is invalid');
  }
  if (!Array.isArray(shardReports) || shardReports.length !== 4) {
    fail('release checkpoint requires exactly four shard reports');
  }
  if (partition.selected.length === 0) {
    if (selectedReport !== null) {
      fail('docs-only protected-main selection must not have a selected-test report');
    }
  } else {
    const actualSelected = vitestResultFiles(
      selectedReport,
      sourceRoot,
      'protected-main selected Vitest result',
    );
    if (JSON.stringify(actualSelected) !== JSON.stringify(partition.selected)) {
      fail('protected-main selected Vitest result does not match its exact selection');
    }
  }

  const shardFiles = shardReports.map((report, index) => vitestResultFiles(
    report,
    sourceRoot,
    `release checkpoint shard ${index + 1}`,
  ));
  const flattened = shardFiles.flat();
  const actualRemaining = [...new Set(flattened)].sort();
  if (actualRemaining.length !== flattened.length) {
    fail('release checkpoint shard results overlap');
  }
  if (JSON.stringify(actualRemaining) !== JSON.stringify(partition.remaining)) {
    fail('release checkpoint shard results do not exactly cover the deterministic remainder');
  }
  const actualSelected = new Set(partition.selected);
  if (actualRemaining.some((file) => actualSelected.has(file))) {
    fail('protected-main selected tests overlap release checkpoint shard results');
  }
  if (partition.selected.length + actualRemaining.length !== partition.deterministic.length) {
    fail('selected and remaining test results do not cover the deterministic inventory');
  }
  return shardFiles;
}
