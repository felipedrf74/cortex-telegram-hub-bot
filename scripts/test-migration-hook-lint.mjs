#!/usr/bin/env node
// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { root, walkTestFiles } from './lib/test-policy.mjs';

export const approvedDirectMigrationReplays = new Map([
  ['__tests__/migrations/decision-flow-v1.test.ts', { expectedCalls: 2, reason: 'One readiness-before-227 rehearsal and one historical 227-before-226 recovery rehearsal.' }],
  ['__tests__/migrations/training-plan-revision-v1.test.ts', { expectedCalls: 1, reason: 'One empty-database production-runner rehearsal for migration 228.' }],
  ['__tests__/migrations/training-exercise-media-v1.test.ts', { expectedCalls: 1, reason: 'One empty-database production-runner rehearsal for migration 229.' }],
  ['__tests__/migrations/training-adaptation-proposals-v1.test.ts', { expectedCalls: 1, reason: 'One empty-database production-runner rehearsal for migration 230.' }],
  ['__tests__/migrations/training-m4-capacity-snapshots.test.ts', { expectedCalls: 1, reason: 'One empty-database production-runner rehearsal for migration 231.' }],
  ['__tests__/services/database.test.ts', { expectedCalls: 5, reason: 'Canonical raw-SQL, production-runner, and registered SQL-function migration integrity rehearsals.' }],
  ['__tests__/services/paid-ai-cost-controls-migration-runner.test.ts', { expectedCalls: 3, reason: 'Historical edge-row, target migration, and second-pass idempotency rehearsal for migration 226.' }],
  ['__tests__/services/external-migrations-mode.test.ts', { expectedCalls: 5, reason: 'One empty-database production-runner rehearsal, two fail-closed external-mode source probes, and two rollback-plan v3 checks proving the exact signed forward suffix is admitted while an unknown successor row is rejected.' }],
]);

function functionName(node) {
  if (node.name && ts.isIdentifier(node.name)) return node.name.text;
  if (ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) return node.parent.name.text;
  return null;
}

function callName(node) {
  if (ts.isIdentifier(node.expression)) return node.expression.text;
  if (ts.isPropertyAccessExpression(node.expression)) return node.expression.name.text;
  return null;
}

function lineOf(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function enclosingFunction(node) {
  let cursor = node.parent;
  while (cursor) {
    if (ts.isFunctionDeclaration(cursor) || ts.isFunctionExpression(cursor) || ts.isArrowFunction(cursor)
      || ts.isMethodDeclaration(cursor)) return cursor;
    cursor = cursor.parent;
  }
  return null;
}

function enclosingHook(node) {
  let cursor = node.parent;
  while (cursor) {
    if (ts.isCallExpression(cursor) && ['beforeEach', 'afterEach'].includes(callName(cursor) ?? '')) return callName(cursor);
    cursor = cursor.parent;
  }
  return null;
}

const canonicalRunnerNames = new Set([
  'runMigrationsForTest',
  'applyPendingMigrations',
  'applyMigrations',
]);

function importedRunnerNames(sourceFile) {
  const names = new Set(canonicalRunnerNames);
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) continue;
    const bindings = statement.importClause.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      const importedName = element.propertyName?.text ?? element.name.text;
      if (canonicalRunnerNames.has(importedName)) names.add(element.name.text);
    }
  }
  return names;
}

function directReplayKind(call, runnerNames) {
  const name = callName(call);
  if (name && runnerNames.has(name)) return name;
  return null;
}

function collectFunctions(sourceFile) {
  const functions = new Map();
  const visit = (node) => {
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node)) {
      const name = functionName(node);
      if (name) functions.set(name, node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return functions;
}

function callsAny(node, sourceFile, names) {
  let found = false;
  const visit = (child) => {
    if (found) return;
    if (ts.isCallExpression(child)) {
      const name = callName(child);
      if (name && names.has(name)) {
        found = true;
        return;
      }
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

function hasMigrationDirectoryRead(node, sourceFile) {
  let found = false;
  const visit = (child) => {
    if (found) return;
    if (ts.isCallExpression(child) && callName(child) === 'readdirSync'
      && child.arguments.some((argument) => /MIGRATIONS_DIR|migrations/.test(argument.getText(sourceFile)))) {
      found = true;
      return;
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

function containsDirectRunner(node, runnerNames) {
  let found = false;
  const visit = (child) => {
    if (found) return;
    if (ts.isCallExpression(child) && directReplayKind(child, runnerNames)) {
      found = true;
      return;
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

function collectRawReplayOwners(sourceFile) {
  const owners = new Set();
  const visit = (node) => {
    if (ts.isCallExpression(node) && callName(node) === 'readdirSync'
      && node.arguments.some((argument) => /MIGRATIONS_DIR|migrations/.test(argument.getText(sourceFile)))) {
      const owner = enclosingFunction(node);
      if (owner
        && callsAny(owner, sourceFile, new Set(['readFileSync']))
        && callsAny(owner, sourceFile, new Set(['exec']))) {
        owners.add(owner);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return owners;
}

export function findMigrationReplayViolations(
  file,
  source,
  approvals = approvedDirectMigrationReplays,
) {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const runnerNames = importedRunnerNames(sourceFile);
  const functions = collectFunctions(sourceFile);
  const rawReplayOwners = collectRawReplayOwners(sourceFile);
  const migrationListHelpers = new Set([...functions]
    .filter(([, node]) => rawReplayOwners.has(node) || hasMigrationDirectoryRead(node, sourceFile))
    .map(([name]) => name));
  const replayHelpers = new Set(
    [...functions].filter(([, node]) => {
      if (containsDirectRunner(node, runnerNames) || rawReplayOwners.has(node)) return true;
      return callsAny(node, sourceFile, new Set(['readdirSync', ...migrationListHelpers]))
        && callsAny(node, sourceFile, new Set(['readFileSync']))
        && callsAny(node, sourceFile, new Set(['exec']));
    }).map(([name]) => name),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, node] of functions) {
      if (!replayHelpers.has(name) && callsAny(node, sourceFile, replayHelpers)) {
        replayHelpers.add(name);
        changed = true;
      }
    }
  }

  const replayCalls = [];
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const name = callName(node);
      const kind = directReplayKind(node, runnerNames) ?? (name && replayHelpers.has(name) ? `helper:${name}` : null);
      if (kind) {
        const owner = enclosingFunction(node);
        const ownerName = owner ? functionName(owner) : null;
        // A helper's internal runner/directory scan is represented by each
        // call to that helper, not double-counted at its definition.
        if (!(ownerName && replayHelpers.has(ownerName))) {
          replayCalls.push({ line: lineOf(sourceFile, node), kind, hook: enclosingHook(node) });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  for (const owner of rawReplayOwners) {
    const ownerName = functionName(owner);
    if (!ownerName && !containsDirectRunner(owner, runnerNames)) {
      replayCalls.push({
        line: lineOf(sourceFile, owner),
        kind: 'inline-raw-migration-loop',
        hook: enclosingHook(owner),
      });
    }
  }

  const failures = [];
  for (const replay of replayCalls) {
    if (replay.hook) failures.push(`${file}:${replay.line}: full migration replay inside ${replay.hook}`);
  }
  const approval = approvals.get(file);
  if (!approval && replayCalls.length > 0) {
    for (const replay of replayCalls) {
      failures.push(`${file}:${replay.line}: unapproved full migration replay (${replay.kind}); use createMigratedTestDatabase()`);
    }
  } else if (approval && replayCalls.length !== approval.expectedCalls) {
    failures.push(`${file}: approved direct migration replay count is ${replayCalls.length}; expected ${approval.expectedCalls} (${approval.reason})`);
  }
  return failures;
}

export function auditMigrationReplays({ files = walkTestFiles(), baseRoot = root } = {}) {
  const failures = [];
  for (const file of files) {
    const source = fs.readFileSync(path.join(baseRoot, file), 'utf8');
    failures.push(...findMigrationReplayViolations(file, source));
  }
  return failures;
}

function main() {
  const failures = auditMigrationReplays();
  if (failures.length > 0) {
    console.error(failures.join('\n'));
    console.error(`\nUse createMigratedTestDatabase() or an explicitly governed migration rehearsal (${failures.length} violation(s)).`);
    process.exit(1);
  }
  console.log(`Migration replay guard passed: zero hook replays and ${approvedDirectMigrationReplays.size} exact rehearsal allowances.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
