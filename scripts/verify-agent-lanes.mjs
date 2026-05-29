#!/usr/bin/env node
// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Lightweight Delivered-Means-Verified lane checker.
 *
 * This intentionally validates only local coordination invariants: the active
 * Work Order exists, declares ownership, and matches the current branch and
 * worktree; the registry exists and has well-formed active rows. It is
 * read-only and never inspects secrets or runtime data.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const args = parseArgs(process.argv.slice(2));
const failures = [];

if (!args.registry && !args.workOrder) {
  failures.push('usage: node scripts/verify-agent-lanes.mjs --registry <path> OR --work-order <path>');
}

if (args.registry) verifyRegistry(args.registry);
if (args.workOrder) verifyWorkOrder(args.workOrder);

if (failures.length > 0) {
  for (const failure of failures) console.error(`[verify-agent-lanes] FAIL ${failure}`);
  process.exit(1);
}

console.log('[verify-agent-lanes] OK');

function parseArgs(rawArgs) {
  const parsed = {};
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === '--registry') parsed.registry = rawArgs[index + 1];
    if (arg.startsWith('--registry=')) parsed.registry = arg.slice('--registry='.length);
    if (arg === '--work-order') parsed.workOrder = rawArgs[index + 1];
    if (arg.startsWith('--work-order=')) parsed.workOrder = arg.slice('--work-order='.length);
  }
  return parsed;
}

function verifyRegistry(registryPath) {
  const absolutePath = path.resolve(registryPath);
  if (!fs.existsSync(absolutePath)) {
    failures.push(`registry missing: ${registryPath}`);
    return;
  }
  const markdown = fs.readFileSync(absolutePath, 'utf8');
  const rows = markdown
    .split('\n')
    .filter((line) => line.trim().startsWith('|') && !/^\|\s*-+/.test(line.trim()));
  if (rows.length < 2) {
    failures.push(`registry has no table rows: ${registryPath}`);
    return;
  }
  const headers = splitMarkdownRow(rows[0]);
  const required = ['work_order_id', 'branch', 'worktree', 'mode', 'status'];
  for (const header of required) {
    if (!headers.includes(header)) failures.push(`registry missing column: ${header}`);
  }
  for (const row of rows.slice(1)) {
    const values = splitMarkdownRow(row);
    if (values.length !== headers.length) {
      failures.push(`registry row has ${values.length} cells, expected ${headers.length}: ${row}`);
      continue;
    }
    const record = Object.fromEntries(headers.map((header, index) => [header, values[index]]));
    for (const key of required) {
      if (!record[key]) failures.push(`registry row missing ${key}: ${row}`);
    }
  }
}

function verifyWorkOrder(workOrderPath) {
  const absolutePath = path.resolve(workOrderPath);
  if (!fs.existsSync(absolutePath)) {
    failures.push(`work order missing: ${workOrderPath}`);
    return;
  }
  const markdown = fs.readFileSync(absolutePath, 'utf8');
  const frontmatter = parseFrontmatter(markdown);
  const required = [
    'work_order_id',
    'mode',
    'branch',
    'worktree',
    'owned_paths',
    'status',
    'max_claim_level',
  ];
  for (const key of required) {
    if (!frontmatter[key] || (Array.isArray(frontmatter[key]) && frontmatter[key].length === 0)) {
      failures.push(`work order frontmatter missing ${key}`);
    }
  }

  const currentBranch = readGit(['branch', '--show-current']);
  if (currentBranch && frontmatter.branch && currentBranch !== frontmatter.branch) {
    failures.push(`current branch ${currentBranch} does not match work order branch ${frontmatter.branch}`);
  }

  const currentWorktree = process.cwd();
  if (frontmatter.worktree && path.resolve(frontmatter.worktree) !== currentWorktree) {
    failures.push(`current worktree ${currentWorktree} does not match work order worktree ${frontmatter.worktree}`);
  }

  const ownedPaths = frontmatter.owned_paths ?? [];
  const duplicateOwnedPaths = ownedPaths.filter((item, index) => ownedPaths.indexOf(item) !== index);
  if (duplicateOwnedPaths.length > 0) {
    failures.push(`work order has duplicate owned_paths: ${[...new Set(duplicateOwnedPaths)].join(', ')}`);
  }
}

function parseFrontmatter(markdown) {
  const lines = markdown.split('\n');
  if (lines[0]?.trim() !== '---') {
    failures.push('work order is missing YAML frontmatter start marker');
    return {};
  }
  const endIndex = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (endIndex < 0) {
    failures.push('work order is missing YAML frontmatter end marker');
    return {};
  }

  const result = {};
  let currentListKey = null;
  for (const line of lines.slice(1, endIndex)) {
    if (/^\s*-\s+/.test(line) && currentListKey) {
      result[currentListKey].push(cleanYamlScalar(line.replace(/^\s*-\s+/, '')));
      continue;
    }

    const match = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (rawValue.trim() === '') {
      result[key] = [];
      currentListKey = key;
    } else {
      result[key] = cleanYamlScalar(rawValue);
      currentListKey = null;
    }
  }
  return result;
}

function cleanYamlScalar(value) {
  return value.trim().replace(/^["']|["']$/g, '');
}

function splitMarkdownRow(row) {
  return row
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function readGit(argsForGit) {
  try {
    return execFileSync('git', argsForGit, { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}
