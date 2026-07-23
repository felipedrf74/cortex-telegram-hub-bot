#!/usr/bin/env node
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  loadTestPolicy,
  matchFiles,
  partitionTestFiles,
  root,
  walkTestFiles,
} from './lib/test-policy.mjs';
import { staticTestDependencyImpact } from './lib/static-test-dependency-map.mjs';

const args = process.argv.slice(2);
const valueOf = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1];
};
const base = valueOf('--base');
const classifierPath = valueOf('--classifier');
const sourceRoot = path.resolve(valueOf('--source-root') ?? root);
const json = args.includes('--json');
const coverageSelection = args.includes('--coverage');

if (!base || !classifierPath) {
  console.error('Usage: select-vitest-files.mjs --base <sha> --classifier <json> [--source-root <dir>] [--coverage] [--json]');
  process.exit(64);
}

const classifier = JSON.parse(fs.readFileSync(classifierPath, 'utf8'));
const policy = loadTestPolicy();
const discoveredFiles = walkTestFiles(sourceRoot);
const allFiles = partitionTestFiles(discoveredFiles, policy).deterministic;
const focused = matchFiles(allFiles, classifier.vitest?.globs ?? []);
const critical = matchFiles(allFiles, policy.tiers.critical.include);
const dependencyImpact = staticTestDependencyImpact(sourceRoot, base);
const changed = dependencyImpact.tests.filter((file) => allFiles.includes(file));
const removed = dependencyImpact.removedTestFiles;
const removedDigest = createHash('sha256').update(JSON.stringify(removed)).digest('hex');

// Shared fixtures, test policy/configuration, package infrastructure, and
// unresolved high-fan-in changes are deliberately fail-closed. Do not reduce
// a classifier-mandated full run back to a changed/critical subset.
if (classifier.vitest?.mode === 'full' && !coverageSelection) {
  if (json) {
    process.stdout.write(`${JSON.stringify({
      base,
      changed: [],
      focused: [],
      cannotSkip: [],
      critical,
      removed,
      removedDigest,
      unresolved: [],
      unresolvedDigest: createHash('sha256').update('[]').digest('hex'),
      impactResolved: classifier.flags?.impactResolved === true && removed.length === 0,
      selected: allFiles,
      escalated: 'classifier-full',
    }, null, 2)}\n`);
  } else {
    process.stdout.write(`${allFiles.join('\n')}\n`);
  }
  // Do not call process.exit() immediately after a large write: when stdout is
  // a pipe, Node can otherwise discard bytes still buffered beyond 64 KiB.
  process.exitCode = 0;
} else {
// This selection runs inside the protected signer as well as RC planning.
// Candidate files are inert data: build a transitive graph from literal local
// imports and Git history without loading Vitest, setup files, or test modules.
// Unresolved impact is per changed production file. One domain's focused globs
// must never mask an unrelated unmapped module in the same release diff.
// A future governed per-file fallback map may resolve individual paths; until
// then static unresolved paths deliberately escalate the RC to full.
const unresolved = dependencyImpact.unresolvedProductionFiles;
const selected = [...new Set([...changed, ...focused, ...critical])]
  .filter((file) => allFiles.includes(file))
  .sort();

if (json) {
  process.stdout.write(`${JSON.stringify({
    base,
    changed: [...changed].sort(),
    focused: [...focused].sort(),
    cannotSkip: [...focused].sort(),
    critical: [...critical].sort(),
    removed,
    removedDigest,
    unresolved,
    unresolvedDigest: createHash('sha256').update(JSON.stringify(unresolved)).digest('hex'),
    impactResolved: classifier.flags?.impactResolved === true
      && unresolved.length === 0
      && removed.length === 0,
    selected,
  }, null, 2)}\n`);
} else {
  // Correctness escalation and coverage measurement are different jobs. A
  // shared-fixture or classifier change still forces the separately sharded
  // full correctness suite, while the coverage lane measures the dependency,
  // critical, and cannot-skip union. Uncovered changed lines still fail the
  // ratchet, so this does not turn unresolved production impact into success.
  const plainSelection = coverageSelection
    ? selected
    : (unresolved.length > 0 || removed.length > 0 ? allFiles : selected);
  process.stdout.write(plainSelection.length ? `${plainSelection.join('\n')}\n` : '');
}
}
