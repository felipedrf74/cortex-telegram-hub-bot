#!/usr/bin/env node
// Complete high-volume vi.mock factories for logger/database without changing
// their local test-specific stubs. This keeps existing behavior while dropping
// the partial-mock lint baseline.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TESTS_DIR = path.join(ROOT, '__tests__');

const targets = [
  {
    suffix: '/src/utils/logger',
    keys: [
      "  LOGGER_REDACTION_PATHS: [],\n",
    ],
  },
  {
    suffix: '/src/services/database',
    keys: [
      "  initDatabase: vi.fn(),\n",
      "  closeDatabase: vi.fn(),\n",
      "  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),\n",
    ],
  },
];

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (/\.test\.tsx?$|\.spec\.tsx?$/.test(entry.name)) files.push(full);
  }
  return files;
}

function matchClosing(src, openIdx, openChar, closeChar) {
  let depth = 0;
  let inString = null;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (inString) {
      if (c === '\\') {
        i++;
        continue;
      }
      if (c === inString) inString = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      inString = c;
      continue;
    }
    if (c === openChar) depth++;
    if (c === closeChar) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function findTopLevelComma(src) {
  let depth = 0;
  let inString = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inString) {
      if (c === '\\') {
        i++;
        continue;
      }
      if (c === inString) inString = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      inString = c;
      continue;
    }
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth--;
    else if (c === ',' && depth === 0) return i;
  }
  return -1;
}

function findFactoryObject(src) {
  const callStart = src.indexOf('vi.mock(');
  if (callStart < 0) return null;
  const openParen = callStart + 'vi.mock'.length;
  const closeParen = matchClosing(src, openParen, '(', ')');
  if (closeParen < 0) return null;

  const inside = src.slice(openParen + 1, closeParen);
  const comma = findTopLevelComma(inside);
  if (comma < 0) return null;

  const pathArg = inside.slice(0, comma).trim();
  const pathMatch = pathArg.match(/^(['"`])([^'"`]+)\1$/);
  if (!pathMatch) return null;

  const factoryStart = openParen + 1 + comma + 1;
  const factoryRaw = src.slice(factoryStart, closeParen);
  const directObject = factoryRaw.indexOf('({');
  const returnObject = factoryRaw.indexOf('return {');
  let objectOpenRel = -1;
  if (directObject >= 0 && (returnObject < 0 || directObject < returnObject)) {
    objectOpenRel = directObject + 1;
  } else if (returnObject >= 0) {
    objectOpenRel = returnObject + 'return '.length;
  }
  if (objectOpenRel < 0) return null;

  const objectOpen = factoryStart + objectOpenRel;
  const objectClose = matchClosing(src, objectOpen, '{', '}');
  if (objectClose < 0 || objectClose > closeParen) return null;

  return { mockPath: pathMatch[2], objectOpen, objectClose };
}

function processFile(file) {
  let src = fs.readFileSync(file, 'utf8');
  let changed = false;
  let cursor = 0;

  while (true) {
    const next = src.indexOf('vi.mock(', cursor);
    if (next < 0) break;
    const parsed = findFactoryObject(src.slice(next));
    if (!parsed) {
      cursor = next + 'vi.mock('.length;
      continue;
    }

    const objectOpen = next + parsed.objectOpen;
    const objectClose = next + parsed.objectClose;
    const normalizedPath = parsed.mockPath.replace(/\\/g, '/');
    const target = targets.find((candidate) => normalizedPath.endsWith(candidate.suffix));
    if (!target) {
      cursor = objectClose + 1;
      continue;
    }

    const objectBody = src.slice(objectOpen + 1, objectClose);
    const additions = target.keys.filter((line) => {
      const key = line.trim().split(':')[0];
      return !new RegExp(`\\b${key}\\b`).test(objectBody);
    });
    if (additions.length > 0) {
      const beforeClose = src.slice(objectOpen + 1, objectClose);
      const needsComma = beforeClose.trim().length > 0 && !beforeClose.trimEnd().endsWith(',');
      const prefix = needsComma ? ',\n' : '';
      src = src.slice(0, objectClose) + prefix + additions.join('') + src.slice(objectClose);
      changed = true;
      cursor = objectClose + prefix.length + additions.join('').length + 1;
    } else {
      cursor = objectClose + 1;
    }
  }

  if (changed) fs.writeFileSync(file, src);
  return changed;
}

let changedCount = 0;
for (const file of walk(TESTS_DIR)) {
  if (processFile(file)) changedCount++;
}

console.log(`Completed logger/database mock factories in ${changedCount} test files.`);
