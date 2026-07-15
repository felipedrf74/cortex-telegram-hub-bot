#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { root, walkTestFiles } from './lib/test-policy.mjs';

const FULL_MIGRATION_CALL = /\b(?:runMigrationsForTest|applyMigrations)\s*\(|readdirSync\s*\(\s*MIGRATIONS_DIR/;
const HOOK_START = /\bbeforeEach\s*\(/;

function findHookEnd(lines, start) {
  let depth = 0;
  let opened = false;
  for (let index = start; index < lines.length; index += 1) {
    for (const character of lines[index]) {
      if (character === '(' || character === '{' || character === '[') {
        depth += 1;
        opened = true;
      } else if (character === ')' || character === '}' || character === ']') {
        depth -= 1;
      }
    }
    if (opened && depth <= 0) return index;
  }
  return lines.length - 1;
}

const failures = [];
for (const file of walkTestFiles()) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  const lines = source.split('\n');
  const replayHelpers = new Set();
  for (const match of source.matchAll(/function\s+([A-Za-z0-9_]+)\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/g)) {
    if (FULL_MIGRATION_CALL.test(match[2])) replayHelpers.add(match[1]);
  }
  let added = true;
  while (added) {
    added = false;
    for (const match of source.matchAll(/function\s+([A-Za-z0-9_]+)\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/g)) {
      if (!replayHelpers.has(match[1]) && [...replayHelpers].some((name) => new RegExp(`\\b${name}\\s*\\(`).test(match[2]))) {
        replayHelpers.add(match[1]);
        added = true;
      }
    }
  }
  for (let index = 0; index < lines.length; index += 1) {
    if (!HOOK_START.test(lines[index])) continue;
    const end = findHookEnd(lines, index);
    for (let cursor = index; cursor <= end; cursor += 1) {
      if (FULL_MIGRATION_CALL.test(lines[cursor])
        || [...replayHelpers].some((name) => new RegExp(`\\b${name}\\s*\\(`).test(lines[cursor]))) {
        failures.push(`${file}:${cursor + 1}: full migration replay inside beforeEach`);
      }
    }
    index = end;
  }
}

if (failures.length > 0) {
  console.error(failures.join('\n'));
  console.error(`\nUse createMigratedTestDatabase() or a transaction rollback fixture (${failures.length} violation(s)).`);
  process.exit(1);
}

console.log('Migration hook guard passed: zero full migration replays inside beforeEach.');
