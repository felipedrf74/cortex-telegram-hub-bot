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
import {
  contractTestsForGroups,
  loadTestGroups,
} from './lib/test-groups.mjs';

const args = process.argv.slice(2);
const valueOf = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1];
};
const base = valueOf('--base');
const classifierPath = valueOf('--classifier');
const sourceRoot = path.resolve(valueOf('--source-root') ?? root);
const json = args.includes('--json');
const outputPath = valueOf('--output');

if (!base || !classifierPath) {
  console.error('Usage: select-vitest-files.mjs --base <sha> --classifier <json> [--source-root <dir>] [--coverage] [--json]');
  process.exit(64);
}

const classifier = JSON.parse(fs.readFileSync(classifierPath, 'utf8'));
const policy = loadTestPolicy();
const groupPolicy = loadTestGroups(sourceRoot);
const discoveredFiles = walkTestFiles(sourceRoot);
const allFiles = partitionTestFiles(discoveredFiles, policy).deterministic;
const dependencyImpact = staticTestDependencyImpact(
  sourceRoot,
  base,
  classifier.changedFiles,
);
const changed = dependencyImpact.tests.filter((file) => allFiles.includes(file));
const changedTests = dependencyImpact.changedFiles.filter((file) => allFiles.includes(file));
const removed = dependencyImpact.removedTestFiles;
const removedDigest = createHash('sha256').update(JSON.stringify(removed)).digest('hex');
const groups = classifier.vitest?.groups ?? classifier.testGroups?.selected ?? [];
const contracts = classifier.vitest?.mode === 'skip'
  ? []
  : contractTestsForGroups(groups, groupPolicy, allFiles);
const groupTests = classifier.vitest?.mode === 'skip'
  ? []
  : groups.flatMap((name) => matchFiles(allFiles, groupPolicy.groups[name]?.tests ?? []));
const unresolved = dependencyImpact.unresolvedProductionFiles;
const selected = classifier.vitest?.mode === 'skip'
  ? []
  : [...new Set([...contracts, ...groupTests, ...changed, ...changedTests])]
  .filter((file) => allFiles.includes(file))
  .sort();
const selection = {
  schema: 'nexus.test-selection.v2',
  base,
  policyVersion: groupPolicy.version,
  policyDigest: groupPolicy.digest,
  docsOnly: classifier.flags?.docsOnly === true,
  groups: [...groups].sort(),
  core: groupPolicy.core.tests.filter((file) => allFiles.includes(file)).sort(),
  contracts,
  groupTests: [...new Set(groupTests)].sort(),
  dependents: [...changed].sort(),
  changedTests: [...changedTests].sort(),
  removed,
  removedDigest,
  unresolved,
  unresolvedDigest: createHash('sha256').update(JSON.stringify(unresolved)).digest('hex'),
  impactResolved: classifier.flags?.impactResolved === true && removed.length === 0,
  selected,
};

if (outputPath) {
  const absolute = path.resolve(sourceRoot, outputPath);
  const localRoot = path.join(sourceRoot, '.local');
  const relative = path.relative(localRoot, absolute);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    throw new Error('--output must stay below .local/');
  }
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, `${JSON.stringify(selection, null, 2)}\n`, { mode: 0o600 });
}

if (json) {
  process.stdout.write(`${JSON.stringify(selection, null, 2)}\n`);
} else {
  process.stdout.write(selected.length ? `${selected.join('\n')}\n` : '');
}
