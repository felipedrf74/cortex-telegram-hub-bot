#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  buildReleaseTestPartition,
} from './lib/release-test-partition.mjs';
import { root } from './lib/test-policy.mjs';

const args = process.argv.slice(2);
const command = args.shift() ?? '';

function valueOf(name) {
  const index = args.indexOf(name);
  return index === -1 ? '' : args[index + 1] ?? '';
}

function readSelection(filename) {
  if (!filename) throw new Error('--selection is required');
  const resolved = path.resolve(filename);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0 || stat.size > 8 * 1024 * 1024) {
    throw new Error('protected-main test selection must be a bounded regular file');
  }
  return JSON.parse(fs.readFileSync(resolved, 'utf8'));
}

if (command !== 'run') {
  throw new Error(
    'Usage: release-test-remainder.mjs run --selection <json> --shard <1/4> --output <.local/result.json>',
  );
}

const shard = valueOf('--shard');
if (!/^[1-4]\/4$/.test(shard)) throw new Error('--shard must be one of 1/4, 2/4, 3/4, 4/4');
const output = valueOf('--output');
if (!output) throw new Error('--output is required');

const partition = buildReleaseTestPartition(readSelection(valueOf('--selection')), root);
const child = spawnSync(process.execPath, [
  'scripts/run-test-tier.mjs',
  'deterministic',
  '--shard',
  shard,
  '--reporter',
  'json',
  '--json-output',
  output,
  '--',
  ...partition.remaining,
], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    NODE_ENV: 'test',
  },
});

if (child.error) throw child.error;
if (child.status !== 0) process.exit(child.status ?? 1);
