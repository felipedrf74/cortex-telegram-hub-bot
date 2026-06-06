// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import crypto from 'crypto';
import { getDb } from './database';

const NONCE_REPLAY_TTL_MS = 24 * 60 * 60 * 1000;

export class AppleSignInNonceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppleSignInNonceError';
  }
}

export function hashAppleRawNonce(rawNonce: string): string {
  return crypto.createHash('sha256').update(rawNonce).digest('hex');
}

function ensureAppleNonceTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS apple_sign_in_nonces (
      nonce_hash TEXT PRIMARY KEY,
      apple_user_id TEXT NOT NULL,
      consumed_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_apple_sign_in_nonces_consumed_at
      ON apple_sign_in_nonces(consumed_at_ms);
  `);
}

export function consumeAppleSignInNonce(input: {
  rawNonce: unknown;
  tokenNonce: unknown;
  appleUserId: string;
  nowMs?: number;
}): void {
  if (typeof input.rawNonce !== 'string' || input.rawNonce.length < 16) {
    throw new AppleSignInNonceError('Apple Sign In rawNonce is required');
  }
  if (typeof input.tokenNonce !== 'string' || input.tokenNonce.length === 0) {
    throw new AppleSignInNonceError('Apple Sign In token nonce is missing');
  }

  const nonceHash = hashAppleRawNonce(input.rawNonce);
  if (nonceHash !== input.tokenNonce) {
    throw new AppleSignInNonceError('Apple Sign In nonce mismatch');
  }

  ensureAppleNonceTable();
  const db = getDb();
  const nowMs = input.nowMs ?? Date.now();
  db.prepare('DELETE FROM apple_sign_in_nonces WHERE consumed_at_ms < ?')
    .run(nowMs - NONCE_REPLAY_TTL_MS);

  const result = db.prepare(`
    INSERT OR IGNORE INTO apple_sign_in_nonces (nonce_hash, apple_user_id, consumed_at_ms)
    VALUES (?, ?, ?)
  `).run(nonceHash, input.appleUserId, nowMs);

  if (result.changes !== 1) {
    throw new AppleSignInNonceError('Apple Sign In nonce was already used');
  }
}
