#!/usr/bin/env node
// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyChangedFiles,
  formatClassifierMarkdown,
} from './lib/changed-area-classifier.mjs';
import { cleanGitEnv } from './lib/git-ref.mjs';
import {
  parseGitNameStatusRecordsZ,
  parseGitPathsZ,
} from './lib/git-changed-paths.mjs';

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(process.env.NEXUS_CLASSIFIER_REPO_ROOT || scriptRoot);
const policyPath = process.env.NEXUS_TEST_POLICY_PATH
  ? path.resolve(process.env.NEXUS_TEST_POLICY_PATH)
  : path.join(root, 'config/test-policy.json');
const irreversiblePolicyPath = process.env.NEXUS_IRREVERSIBLE_MIGRATIONS_PATH
  ? path.resolve(process.env.NEXUS_IRREVERSIBLE_MIGRATIONS_PATH)
  : path.join(root, 'config/irreversible-migrations.json');

function usage() {
  return `changed-area-classifier — map a Git diff to release tiers and gates

Usage:
  scripts/changed-area-classifier.sh [--base <ref>] [--format json|markdown]
                                     [--files <comma-separated paths>]
  scripts/changed-area-classifier.sh --json
`;
}

function parseArgs(argv) {
  const options = { baseRef: '', format: 'markdown', explicitFiles: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--base') options.baseRef = argv[++index] ?? '';
    else if (argument === '--format') options.format = argv[++index] ?? '';
    else if (argument === '--files') options.explicitFiles = (argv[++index] ?? '').split(',').filter(Boolean);
    else if (argument === '--json') options.format = 'json';
    else if (argument === '--markdown') options.format = 'markdown';
    else if (argument === '--quiet') {
      // Compatibility flag: JSON/markdown output remains machine-readable.
    } else if (argument === '-h' || argument === '--help') {
      process.stdout.write(usage());
      process.exit(0);
    } else {
      process.stderr.write(`Unknown arg: ${argument}\n`);
      process.exit(64);
    }
  }
  if (!['json', 'markdown', 'md'].includes(options.format)) {
    process.stderr.write(`Unknown format: ${options.format}\n`);
    process.exit(64);
  }
  return options;
}

function git(args, { allowFailure = false } = {}) {
  try {
    return execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      env: cleanGitEnv(),
      stdio: ['ignore', 'pipe', allowFailure ? 'ignore' : 'pipe'],
    }).trimEnd();
  } catch (error) {
    if (allowFailure) return null;
    throw error;
  }
}

function resolves(ref) {
  return git(
    ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`],
    { allowFailure: true },
  );
}

function resolveBase(requested) {
  if (requested) {
    const resolved = resolves(requested);
    if (resolved) return resolved;
    throw new Error(`Base ref '${requested}' does not resolve`);
  }
  for (const candidate of ['origin/main', 'main', 'HEAD~1']) {
    const resolved = resolves(candidate);
    if (resolved) return resolved;
  }
  throw new Error('Could not resolve any base ref');
}

function collectGitChanges(baseRef) {
  const committed = parseGitNameStatusRecordsZ(
    git(['diff', '--name-status', '-z', `${baseRef}...HEAD`], { allowFailure: true }) ?? '',
  );
  const staged = parseGitNameStatusRecordsZ(
    git(['diff', '--cached', '--name-status', '-z'], { allowFailure: true }) ?? '',
  );
  const unstaged = parseGitNameStatusRecordsZ(
    git(['diff', '--name-status', '-z'], { allowFailure: true }) ?? '',
  );
  const untracked = parseGitPathsZ(
    git(['ls-files', '--others', '--exclude-standard', '-z'], { allowFailure: true }) ?? '',
  );
  const records = [...committed, ...staged, ...unstaged];
  const testTopologyChanged = records.some((record) => /^[DR]/.test(record.status)
    && record.paths.some((file) => /^__tests__\/.+\.test\.ts$/.test(file)));
  return {
    files: [...records.flatMap((record) => record.paths), ...untracked],
    testTopologyChanged,
  };
}

function isAncestor(baseRef) {
  return git(['merge-base', '--is-ancestor', baseRef, 'HEAD'], { allowFailure: true }) !== null;
}

const options = parseArgs(process.argv.slice(2));
try {
  // Preserve the shell classifier's contract: an empty --files value falls
  // back to the Git diff instead of classifying an artificial empty change.
  const explicit = (options.explicitFiles?.length ?? 0) > 0;
  const baseRef = explicit
    ? (options.baseRef || 'explicit-files')
    : resolveBase(options.baseRef);
  const impactResolved = explicit ? true : isAncestor(baseRef);
  const changes = explicit
    ? {
      files: options.explicitFiles,
      testTopologyChanged: options.explicitFiles.some((file) => /^__tests__\/.+\.test\.ts$/.test(file)
        && !fs.existsSync(path.join(root, file))),
    }
    : collectGitChanges(baseRef);
  const head = git(['rev-parse', '--short', 'HEAD'], { allowFailure: true }) ?? 'unknown';
  const result = classifyChangedFiles({
    files: changes.files,
    root,
    policyPath,
    irreversiblePolicyPath,
    baseRef,
    head,
    impactResolved,
    testTopologyChanged: changes.testTopologyChanged,
  });
  process.stdout.write(options.format === 'json'
    ? `${JSON.stringify(result, null, 2)}\n`
    : formatClassifierMarkdown(result));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
