#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  gitMergeBaseArgs,
  gitNameStatusDiffArgs,
  parseGitNameStatusRecordsZ,
} from './lib/git-changed-paths.mjs';
import {
  loadTestGroups,
  resolveRetirementMapping,
  retirementOwnerCandidates,
} from './lib/test-groups.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function git(args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
}

function sourceAt(base, file) {
  try {
    return git(['show', `${base}:${file}`]);
  } catch {
    return '';
  }
}

export function classifyDeletedTests(
  records,
  readAtBase,
  retirementMappings = [],
  existsCurrent = (file) => fs.existsSync(path.join(root, file)),
  _readCurrent = (file) => (
    existsCurrent(file) ? fs.readFileSync(path.join(root, file), 'utf8') : ''
  ),
  baseSha = null,
) {
  const removed = new Set(records
    .filter((record) => record.status.startsWith('D'))
    .flatMap((record) => record.paths));
  const changed = new Set(records
    .filter((record) => !record.status.startsWith('D'))
    .flatMap((record) => record.status.startsWith('R') ? record.paths.slice(1) : record.paths));
  const tests = [];
  for (const record of records) {
    const previousFile = record.paths[0];
    const currentFile = record.status.startsWith('R') ? record.paths[1] : previousFile;
    if (!/^[DMR]/.test(record.status)
      || !/^__tests__\/.+\.test\.ts$/.test(previousFile)
      || !currentFile) continue;
    const previous = readAtBase(previousFile);
    // This classifier deliberately runs before npm ci. Treat every surviving
    // modification, deletion, and rename as a conservative mutation-lane
    // candidate without importing the TypeScript AST runtime. The mutation
    // job installs dependencies and performs exact evidence comparison; it
    // exits successfully without Stryker when the modification only adds or
    // preserves evidence.
    const ownerPaths = retirementOwnerCandidates(previousFile, previous);
    const owners = ownerPaths.filter((owner) => removed.has(owner) || readAtBase(owner).length > 0);
    const removedOwners = owners.filter((owner) => removed.has(owner));
    const retirement = resolveRetirementMapping({
      baseSha,
      testFile: previousFile,
      mappings: retirementMappings,
      removedPaths: removed,
      changedPaths: changed,
      ownerPaths,
      existsCurrent,
    });
    tests.push({
      file: previousFile,
      currentFile,
      status: record.status,
      owners,
      removedOwners,
      retiredWithOwner: retirement !== null,
      retirement: retirement ? {
        reason: retirement.reason,
        replacementTests: retirement.replacementTests,
      } : null,
      requiresMutation: retirement === null,
    });
  }
  return {
    schema: 'nexus.test-cleanup-classification.v1',
    requiresMutation: tests.some((test) => test.requiresMutation),
    tests,
  };
}

function main() {
  const args = process.argv.slice(2);
  const baseIndex = args.indexOf('--base');
  const fieldIndex = args.indexOf('--field');
  const base = baseIndex < 0 ? '' : args[baseIndex + 1];
  const field = fieldIndex < 0 ? '' : args[fieldIndex + 1];
  if (!/^[0-9a-f]{40}$/.test(base)) {
    console.error('Usage: test-cleanup-classifier.mjs --base <exact-sha> [--field requiresMutation]');
    process.exit(64);
  }
  const diffBase = git(gitMergeBaseArgs(base)).trim();
  if (!/^[0-9a-f]{40}$/.test(diffBase)) {
    console.error(`Unable to resolve merge base for ${base}...HEAD`);
    process.exit(2);
  }
  const records = parseGitNameStatusRecordsZ(git(gitNameStatusDiffArgs(diffBase)));
  const groupPolicy = loadTestGroups();
  const result = classifyDeletedTests(
    records,
    (file) => sourceAt(diffBase, file),
    groupPolicy.retirementMappings ?? [],
    (file) => fs.existsSync(path.join(root, file)),
    (file) => {
      try {
        return fs.readFileSync(path.join(root, file), 'utf8');
      } catch {
        return '';
      }
    },
    diffBase,
  );
  if (field === 'requiresMutation') {
    process.stdout.write(`${result.requiresMutation}\n`);
  } else if (field) {
    console.error(`Unknown field: ${field}`);
    process.exit(64);
  } else {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
