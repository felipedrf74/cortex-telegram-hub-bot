#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { loadTestPolicy, matchFiles, root, walkTestFiles } from './lib/test-policy.mjs';

const [tier, ...args] = process.argv.slice(2);
const policy = loadTestPolicy();
const allFiles = walkTestFiles();
const vitest = path.join(root, 'node_modules/vitest/vitest.mjs');
const valueOf = (name, fallback = null) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};

function runVitest(files, extra = [], envOverrides = {}) {
  if (files.length === 0) throw new Error(`No tests resolved for tier ${tier}`);
  const result = spawnSync(process.execPath, [vitest, 'run', '--reporter=dot', ...extra, ...files], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'test', ...envOverrides },
  });
  process.exit(result.status ?? 1);
}

if (tier === 'fast' || tier === 'critical' || tier === 'evaluate') {
  runVitest(matchFiles(allFiles, policy.tiers[tier].include));
}

if (tier === 'changed') {
  const base = valueOf('--base', 'origin/main');
  const classifierFile = path.join(root, '.local/test-selection-classifier.json');
  fs.mkdirSync(path.dirname(classifierFile), { recursive: true });
  const classifier = spawnSync('bash', ['scripts/changed-area-classifier.sh', '--json', '--base', base], {
    cwd: root,
    encoding: 'utf8',
  });
  if (classifier.status !== 0) {
    process.stderr.write(classifier.stderr);
    process.exit(classifier.status ?? 1);
  }
  fs.writeFileSync(classifierFile, classifier.stdout);
  const selection = spawnSync(process.execPath, [
    'scripts/select-vitest-files.mjs', '--base', base, '--classifier', classifierFile,
  ], { cwd: root, encoding: 'utf8' });
  if (selection.status !== 0) {
    process.stderr.write(selection.stderr);
    process.exit(selection.status ?? 1);
  }
  runVitest(selection.stdout.trim().split('\n').filter(Boolean));
}

if (tier === 'full-sharded') {
  const children = [1, 2, 3, 4].map((shard) => spawn(
    process.execPath,
    [vitest, 'run', '--reporter=dot', `--shard=${shard}/4`],
    { cwd: root, stdio: 'inherit', env: { ...process.env, NODE_ENV: 'test' } },
  ));
  const statuses = await Promise.all(children.map((child) => new Promise((resolve) => {
    child.on('exit', (code) => resolve(code ?? 1));
  })));
  process.exit(statuses.every((status) => status === 0) ? 0 : 1);
}

if (tier === 'profile') {
  const outputDir = path.join(root, '.local/test-profile');
  fs.mkdirSync(outputDir, { recursive: true });
  const output = path.join(outputDir, 'vitest-results.json');
  const result = spawnSync(process.execPath, [
    vitest, 'run', '--reporter=json', `--outputFile=${output}`,
  ], { cwd: root, stdio: 'inherit', env: { ...process.env, NODE_ENV: 'test' } });
  if (result.status !== 0) process.exit(result.status ?? 1);
  const inventory = spawnSync(process.execPath, ['scripts/test-inventory.mjs', '--timings', output], {
    cwd: root,
    stdio: 'inherit',
  });
  process.exit(inventory.status ?? 1);
}

if (tier === 'benchmark') {
  runVitest(
    ['__tests__/services/training-m4-capacity-snapshots.test.ts'],
    [],
    { NEXUS_BENCHMARKS: '1' },
  );
}

console.error(`Unknown test tier: ${tier ?? '<missing>'}`);
process.exit(64);
