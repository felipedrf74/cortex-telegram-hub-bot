#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadTestPolicy, matchFiles, root, walkTestFiles } from './lib/test-policy.mjs';

const args = process.argv.slice(2);
const valueOf = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1];
};
const base = valueOf('--base');
const classifierPath = valueOf('--classifier');
const json = args.includes('--json');

if (!base || !classifierPath) {
  console.error('Usage: select-vitest-files.mjs --base <sha> --classifier <json> [--json]');
  process.exit(64);
}

const classifier = JSON.parse(fs.readFileSync(classifierPath, 'utf8'));
const policy = loadTestPolicy();
const allFiles = walkTestFiles();
const focused = matchFiles(allFiles, classifier.vitest?.globs ?? []);
const critical = matchFiles(allFiles, policy.tiers.critical.include);

// Shared fixtures, test policy/configuration, package infrastructure, and
// unresolved high-fan-in changes are deliberately fail-closed. Do not reduce
// a classifier-mandated full run back to a changed/critical subset.
if (classifier.vitest?.mode === 'full') {
  if (json) {
    process.stdout.write(`${JSON.stringify({ base, changed: [], focused: [], critical, selected: allFiles, escalated: 'classifier-full' }, null, 2)}\n`);
  } else {
    process.stdout.write(`${allFiles.join('\n')}\n`);
  }
  process.exit(0);
}

const listed = spawnSync(
  process.execPath,
  [
    path.join(root, 'node_modules/vitest/vitest.mjs'),
    'list',
    '--changed',
    base,
    '--filesOnly',
    '--json',
  ],
  { cwd: root, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test' } },
);
if (listed.status !== 0) {
  process.stderr.write(listed.stderr || listed.stdout);
  process.exit(listed.status ?? 1);
}

const changed = JSON.parse(listed.stdout).map((record) => (
  path.relative(root, record.file).split(path.sep).join('/')
));
const selected = [...new Set([...changed, ...focused, ...critical])]
  .filter((file) => allFiles.includes(file))
  .sort();

if (json) {
  process.stdout.write(`${JSON.stringify({ base, changed, focused, critical, selected }, null, 2)}\n`);
} else {
  process.stdout.write(selected.length ? `${selected.join('\n')}\n` : '');
}
