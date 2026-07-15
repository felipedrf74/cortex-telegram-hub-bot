#!/usr/bin/env node
// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyChangedFiles,
  formatClassifierMarkdown,
} from './lib/changed-area-classifier.mjs';
import { cleanGitEnv } from './lib/git-ref.mjs';

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(process.env.NEXUS_CLASSIFIER_REPO_ROOT || scriptRoot);
const policyPath = process.env.NEXUS_TEST_POLICY_PATH
  ? path.resolve(process.env.NEXUS_TEST_POLICY_PATH)
  : path.join(root, 'config/test-policy.json');

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
  return git(['rev-parse', '--verify', `${ref}^{commit}`], { allowFailure: true }) !== null;
}

function resolveBase(requested) {
  if (requested) {
    if (resolves(requested)) return requested;
    throw new Error(`Base ref '${requested}' does not resolve`);
  }
  for (const candidate of ['origin/main', 'main', 'HEAD~1']) {
    if (resolves(candidate)) return candidate;
  }
  throw new Error('Could not resolve any base ref');
}

function statusFiles() {
  const status = git(['status', '--porcelain', '--untracked-files=all'], { allowFailure: true }) ?? '';
  return status.split(/\r?\n/).filter(Boolean).map((line) => line.slice(3).replace(/^"|"$/g, ''));
}

function collectGitChanges(baseRef) {
  const diff = git(['diff', '--name-only', `${baseRef}...HEAD`], { allowFailure: true }) ?? '';
  return [...diff.split(/\r?\n/), ...statusFiles()].filter(Boolean);
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
  const files = explicit ? options.explicitFiles : collectGitChanges(baseRef);
  const head = git(['rev-parse', '--short', 'HEAD'], { allowFailure: true }) ?? 'unknown';
  const result = classifyChangedFiles({
    files,
    root,
    policyPath,
    baseRef,
    head,
    impactResolved,
  });
  process.stdout.write(options.format === 'json'
    ? `${JSON.stringify(result, null, 2)}\n`
    : formatClassifierMarkdown(result));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
