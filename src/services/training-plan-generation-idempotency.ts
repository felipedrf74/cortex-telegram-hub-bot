// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHash } from 'crypto';
import { getDb } from './database';
import { logger } from '../utils/logger';

type TrainingPlanGenerationIdempotencyStatus = 'in_progress' | 'succeeded' | 'failed';

export type TrainingPlanGenerationIdempotencyClaim =
  | { kind: 'not_requested' }
  | { kind: 'claimed'; idempotencyKey: string; requestHash: string }
  | { kind: 'replay'; idempotencyKey: string; responseData: Record<string, unknown>; statusCode: number }
  | { kind: 'in_progress'; idempotencyKey: string }
  | { kind: 'conflict'; idempotencyKey: string };

type IdempotencyRow = {
  user_id: number;
  idempotency_key: string;
  request_hash: string;
  status: TrainingPlanGenerationIdempotencyStatus;
  response_json: string | null;
  status_code: number | null;
  updated_at: string | null;
};

const MEMORY_ROWS = new Map<string, IdempotencyRow>();

export function normalizeTrainingPlanGenerationIdempotencyKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, 160);
}

export function fingerprintTrainingPlanGenerationRequest(payload: Record<string, unknown>): string {
  return createHash('sha256')
    .update(stableStringify(payload))
    .digest('hex');
}

export function claimTrainingPlanGenerationIdempotency(
  userId: number,
  idempotencyKey: string | null,
  requestHash: string,
): TrainingPlanGenerationIdempotencyClaim {
  if (!idempotencyKey) return { kind: 'not_requested' };

  const db = getOptionalDb();
  if (!db) {
    return claimMemory(userId, idempotencyKey, requestHash);
  }

  ensureTrainingPlanGenerationIdempotencyTable(db);
  const existing = getRow(db, userId, idempotencyKey);
  if (existing) return claimFromExisting(existing, requestHash);

  db.prepare(`
    INSERT INTO training_plan_generation_idempotency (
      user_id, idempotency_key, request_hash, status, created_at, updated_at
    ) VALUES (?, ?, ?, 'in_progress', datetime('now'), datetime('now'))
  `).run(userId, idempotencyKey, requestHash);

  return { kind: 'claimed', idempotencyKey, requestHash };
}

export function completeTrainingPlanGenerationIdempotency(
  userId: number,
  idempotencyKey: string | null,
  requestHash: string,
  responseData: Record<string, unknown>,
  statusCode: number,
): void {
  if (!idempotencyKey) return;
  const responseJson = JSON.stringify(responseData);

  const db = getOptionalDb();
  if (!db) {
    const key = memoryKey(userId, idempotencyKey);
    MEMORY_ROWS.set(key, {
      user_id: userId,
      idempotency_key: idempotencyKey,
      request_hash: requestHash,
      status: 'succeeded',
      response_json: responseJson,
      status_code: statusCode,
      updated_at: new Date().toISOString(),
    });
    return;
  }

  ensureTrainingPlanGenerationIdempotencyTable(db);
  db.prepare(`
    UPDATE training_plan_generation_idempotency
       SET status = 'succeeded',
           response_json = ?,
           status_code = ?,
           updated_at = datetime('now')
     WHERE user_id = ?
       AND idempotency_key = ?
       AND request_hash = ?
  `).run(responseJson, statusCode, userId, idempotencyKey, requestHash);
}

export function failTrainingPlanGenerationIdempotency(
  userId: number,
  idempotencyKey: string | null,
  requestHash: string,
): void {
  if (!idempotencyKey) return;
  const db = getOptionalDb();
  if (!db) {
    const key = memoryKey(userId, idempotencyKey);
    const row = MEMORY_ROWS.get(key);
    if (row?.request_hash === requestHash) {
      MEMORY_ROWS.set(key, { ...row, status: 'failed', updated_at: new Date().toISOString() });
    }
    return;
  }

  ensureTrainingPlanGenerationIdempotencyTable(db);
  db.prepare(`
    UPDATE training_plan_generation_idempotency
       SET status = 'failed',
           updated_at = datetime('now')
     WHERE user_id = ?
       AND idempotency_key = ?
       AND request_hash = ?
       AND status = 'in_progress'
  `).run(userId, idempotencyKey, requestHash);
}

export function _resetTrainingPlanGenerationIdempotencyForTests(): void {
  MEMORY_ROWS.clear();
}

function claimFromExisting(row: IdempotencyRow, requestHash: string): TrainingPlanGenerationIdempotencyClaim {
  if (row.request_hash !== requestHash) {
    return { kind: 'conflict', idempotencyKey: row.idempotency_key };
  }

  if (row.status === 'succeeded' && row.response_json) {
    try {
      return {
        kind: 'replay',
        idempotencyKey: row.idempotency_key,
        responseData: JSON.parse(row.response_json),
        statusCode: row.status_code || 200,
      };
    } catch (err) {
      logger.warn(
        { err, userId: row.user_id, idempotencyKey: row.idempotency_key },
        'Training plan idempotency replay payload could not be parsed; treating as in-progress',
      );
    }
  }

  if (row.status === 'failed') {
    const db = getOptionalDb();
    if (db) {
      db.prepare(`
        UPDATE training_plan_generation_idempotency
           SET status = 'in_progress',
               response_json = NULL,
               status_code = NULL,
               updated_at = datetime('now')
         WHERE user_id = ? AND idempotency_key = ?
      `).run(row.user_id, row.idempotency_key);
    } else {
      MEMORY_ROWS.set(memoryKey(row.user_id, row.idempotency_key), {
        ...row,
        status: 'in_progress',
        response_json: null,
        status_code: null,
        updated_at: new Date().toISOString(),
      });
    }
    return { kind: 'claimed', idempotencyKey: row.idempotency_key, requestHash };
  }

  return { kind: 'in_progress', idempotencyKey: row.idempotency_key };
}

function claimMemory(userId: number, idempotencyKey: string, requestHash: string): TrainingPlanGenerationIdempotencyClaim {
  const key = memoryKey(userId, idempotencyKey);
  const existing = MEMORY_ROWS.get(key);
  if (existing) return claimFromExisting(existing, requestHash);

  MEMORY_ROWS.set(key, {
    user_id: userId,
    idempotency_key: idempotencyKey,
    request_hash: requestHash,
    status: 'in_progress',
    response_json: null,
    status_code: null,
    updated_at: new Date().toISOString(),
  });
  return { kind: 'claimed', idempotencyKey, requestHash };
}

function ensureTrainingPlanGenerationIdempotencyTable(db: any): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS training_plan_generation_idempotency (
      user_id INTEGER NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('in_progress', 'succeeded', 'failed')),
      response_json TEXT,
      status_code INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, idempotency_key)
    );
  `);
}

function getRow(db: any, userId: number, idempotencyKey: string): IdempotencyRow | null {
  return db.prepare(`
    SELECT user_id, idempotency_key, request_hash, status, response_json, status_code, updated_at
      FROM training_plan_generation_idempotency
     WHERE user_id = ? AND idempotency_key = ?
  `).get(userId, idempotencyKey) as IdempotencyRow | undefined ?? null;
}

function getOptionalDb(): any | null {
  try {
    return getDb();
  } catch {
    return null;
  }
}

function memoryKey(userId: number, idempotencyKey: string): string {
  return `${userId}:${idempotencyKey}`;
}

function stableStringify(value: unknown): string {
  if (typeof value === 'undefined') return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}
