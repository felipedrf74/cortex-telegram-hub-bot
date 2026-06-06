#!/usr/bin/env tsx
// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Imports human/QA labels for existing runtime answer-canary evidence rows.
 *
 * This script intentionally does not insert evidence rows and does not persist
 * raw prompt/response text from the review artifact. It only updates HMAC-
 * addressed `chat_v2_completion_evidence` rows that were already produced by
 * the runtime route.
 */

import Database from 'better-sqlite3';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '..', '.env.local'), quiet: true });
dotenv.config({ quiet: true });

type LabelRow = {
  messageHmac?: unknown;
  answerAccepted?: unknown;
  unsupportedClaimCaught?: unknown;
};

const inputPath = readRequiredArg('--input');
const dbPath = readArg('--db') ?? process.env.CHATV2_RUNTIME_DB ?? process.env.DATABASE_PATH ?? './data/local.db';
const dryRun = hasFlag('--dry-run');

const db = new Database(dbPath);
const importRows = readJsonl(inputPath);
const summary = importRows.reduce(
  (acc, row, index) => importLabel(acc, row, index + 1),
  {
    schemaVersion: 'chat_v2_answer_canary_label_import_result.v1',
    inputPath: path.resolve(inputPath),
    dbPath: path.resolve(dbPath),
    dryRun,
    rowsRead: importRows.length,
    rowsUpdated: 0,
    rowsSkipped: 0,
    rowsMissing: 0,
    unsupportedProbeRowsUpdated: 0,
  },
);

console.log(JSON.stringify(summary, null, 2));

function importLabel<T extends {
  rowsUpdated: number;
  rowsSkipped: number;
  rowsMissing: number;
  unsupportedProbeRowsUpdated: number;
}>(acc: T, row: LabelRow, lineNumber: number): T {
  const messageHmac = parseMessageHmac(row.messageHmac);
  if (!messageHmac) {
    throw new Error(`Line ${lineNumber}: messageHmac must be an hmac:message token`);
  }
  const answerAccepted = parseOptionalBoolean(row.answerAccepted, `Line ${lineNumber}: answerAccepted`);
  const unsupportedClaimCaught = parseOptionalBoolean(row.unsupportedClaimCaught, `Line ${lineNumber}: unsupportedClaimCaught`);
  if (answerAccepted == null && unsupportedClaimCaught == null) {
    acc.rowsSkipped += 1;
    return acc;
  }

  const existing = db.prepare(`
    SELECT id, safe_metadata_json
    FROM chat_v2_completion_evidence
    WHERE evidence_kind = 'answer_canary'
      AND evidence_source = 'runtime_route'
      AND message_hmac = ?
    ORDER BY datetime(created_at) DESC, id DESC
  `).all(messageHmac) as Array<{ id: number; safe_metadata_json: string }>;
  if (existing.length === 0) {
    acc.rowsMissing += 1;
    return acc;
  }

  if (unsupportedClaimCaught != null && !existing.some((record) => isUnsupportedClaimProbe(record.safe_metadata_json))) {
    throw new Error(`Line ${lineNumber}: unsupportedClaimCaught can only be imported for rows marked unsupportedClaimProbe=true`);
  }

  if (!dryRun) {
    const assignments: string[] = [];
    const values: unknown[] = [];
    if (answerAccepted != null) {
      assignments.push('answer_accepted = ?');
      values.push(answerAccepted ? 1 : 0);
    }
    if (unsupportedClaimCaught != null) {
      assignments.push('unsupported_claim_caught = ?');
      values.push(unsupportedClaimCaught ? 1 : 0);
    }
    db.prepare(`
      UPDATE chat_v2_completion_evidence
      SET ${assignments.join(', ')}
      WHERE evidence_kind = 'answer_canary'
        AND evidence_source = 'runtime_route'
        AND message_hmac = ?
    `).run(...values, messageHmac);
  }

  acc.rowsUpdated += existing.length;
  if (unsupportedClaimCaught != null) acc.unsupportedProbeRowsUpdated += existing.length;
  return acc;
}

function readJsonl(filePath: string): LabelRow[] {
  const raw = fs.readFileSync(path.resolve(filePath), 'utf8');
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line) as LabelRow;
      } catch (err) {
        throw new Error(`Line ${index + 1}: invalid JSONL row (${err instanceof Error ? err.message : String(err)})`);
      }
    });
}

function parseMessageHmac(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return /^hmac:message:[a-f0-9]{64}$/i.test(trimmed) ? trimmed : null;
}

function parseOptionalBoolean(value: unknown, label: string): boolean | null {
  if (value == null || value === '') return null;
  if (typeof value === 'boolean') return value;
  throw new Error(`${label} must be boolean when present`);
}

function isUnsupportedClaimProbe(safeMetadataJson: string): boolean {
  try {
    const parsed = JSON.parse(safeMetadataJson);
    return parsed?.unsupportedClaimProbe === true;
  } catch {
    return false;
  }
}

function readRequiredArg(name: string): string {
  const value = readArg(name);
  if (!value) throw new Error(`${name}=<path> is required`);
  return value;
}

function readArg(name: string): string | undefined {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1];
  return undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}
