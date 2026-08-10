#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { loadContinuousDeploymentPolicy } from './lib/release-manifest.mjs';
import { parseGitNameStatusZ } from './lib/git-changed-paths.mjs';

/**
 * Changed-contract classification for the backend↔iOS contract tests.
 *
 * The old release path ran a broad iOS gate on every backend release. Under
 * continuous deployment that gate would block every deploy waiting on a human
 * holding a phone, so it is replaced by this: run the release-bound fixture test
 * only when a source that produces, packages, validates, or tests its exact bytes
 * changes. The fixture carries six examples: Dashboard Home, Training Home,
 * Content Home, Training plan created, Training plan needs-clarification, and
 * Training plan generation-attempt created.
 *
 * This classifier does not claim coverage for health, authentication, push/APNs,
 * or the capability manifest. Those surfaces have their own tests and release
 * controls; changing them alone does not trigger this fixture test.
 *
 * Broad iOS smoke belongs to app distribution, on the iOS repository's own
 * cadence. This check does not attempt to replace it, and it must not be
 * described as an iOS test run: it exercises backend contract fixtures.
 *
 * Usage:
 *   node scripts/ios-contract-change-check.mjs --base <ref> [--json]
 */

const args = process.argv.slice(2);
function arg(name, fallback = '') {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  return args[index + 1] ?? fallback;
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const policy = loadContinuousDeploymentPolicy(root);
const base = arg('--base');
const explicitFiles = arg('--files');
const outputJson = args.includes('--json');

function changedFiles() {
  if (explicitFiles) {
    return explicitFiles.split(',').map((file) => file.trim()).filter(Boolean);
  }
  if (!base) {
    process.stderr.write('--base <ref> or --files <csv> is required\n');
    process.exit(64);
  }
  const raw = execFileSync('git', ['diff', '--name-status', '-z', `${base}...HEAD`], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return parseGitNameStatusZ(raw);
}

const files = changedFiles();
const matched = files.filter((file) => policy.iosContractPaths.some((prefix) => (
  prefix.endsWith('/') ? file.startsWith(prefix) : file === prefix || file.startsWith(`${prefix}/`)
)));

const payload = {
  schema: 'nexus.ios-contract-change-check.v1',
  required: matched.length > 0,
  matchedPaths: [...new Set(matched)].sort(),
  watchedPrefixes: policy.iosContractPaths,
};

if (outputJson) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
} else {
  process.stdout.write(`${payload.required}\n`);
}
