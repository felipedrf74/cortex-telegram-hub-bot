#!/usr/bin/env node
// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const instructionSchema = 'training-exercise-media-instruction-content.v1';
const accessibilitySchema = 'training-exercise-media-accessibility-content.v1';
const mode = process.argv[2];
const filenames = process.argv.slice(3);

if (!['--check', '--write'].includes(mode) || filenames.length === 0) {
  process.stderr.write('Usage: node scripts/hash-training-exercise-media-authored-content.mjs --check|--write <chunk.json> [...]\n');
  process.exit(2);
}

let mismatchCount = 0;
let rowCount = 0;
for (const filename of filenames) {
  if (!path.basename(filename).match(/^(instructions|accessibility)-\d{3}-\d{3}\.json$/)) {
    throw new Error(`Refusing non-authored-content chunk: ${filename}`);
  }
  const rows = JSON.parse(fs.readFileSync(filename, 'utf8'));
  if (!Array.isArray(rows)) throw new Error(`${filename} must contain a JSON array.`);
  const kind = path.basename(filename).startsWith('instructions-') ? 'instruction' : 'accessibility';
  const updated = rows.map((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error(`${filename}[${index}] must be an object.`);
    }
    const expected = kind === 'instruction' ? instructionHash(row) : accessibilityHash(row);
    if (row.contentHash !== expected) mismatchCount += 1;
    rowCount += 1;
    return { ...row, contentHash: expected };
  });
  if (mode === '--write') fs.writeFileSync(filename, `${JSON.stringify(updated, null, 2)}\n`);
}

process.stdout.write(`${JSON.stringify({
  mode,
  files: filenames.length,
  rows: rowCount,
  mismatches: mismatchCount,
  passed: mode === '--write' || mismatchCount === 0,
}, null, 2)}\n`);
if (mode === '--check' && mismatchCount > 0) process.exitCode = 1;

function instructionHash(row) {
  return sha256({
    schemaVersion: instructionSchema,
    exerciseId: row.exerciseId,
    locale: row.locale,
    displayName: row.displayName,
    steps: row.steps,
    cues: row.cues,
    cautions: row.cautions,
    textFallback: row.textFallback,
  });
}

function accessibilityHash(row) {
  return sha256({
    schemaVersion: accessibilitySchema,
    exerciseId: row.exerciseId,
    role: row.role,
    ordinal: row.ordinal,
    locale: row.locale,
    caption: row.caption,
    accessibilityDescription: row.accessibilityDescription,
  });
}

function sha256(value) {
  return crypto.createHash('sha256').update(stableJson(value)).digest('hex');
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
