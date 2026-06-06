// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHmac, randomBytes } from 'node:crypto';

/**
 * Opaque correlation tag for a non-actor user id.
 *
 * Ownership-denied logs must not include the foreign owner's raw user id.
 * This HMAC tag lets operators correlate denials without making small
 * sequential ids enumerable from logs.
 */
const OWNER_ID_HASH_SECRET = (() => {
  const fromEnv = process.env.OWNER_ID_HASH_SECRET;
  if (typeof fromEnv === 'string' && fromEnv.length >= 16) return fromEnv;
  return randomBytes(32).toString('hex');
})();

export function hashOwnerIdForLog(userId: number): string {
  if (!Number.isFinite(userId) || userId <= 0) return 'invalid';
  const mac = createHmac('sha256', OWNER_ID_HASH_SECRET).update(String(userId)).digest('hex');
  return `u#${mac.slice(0, 8)}`;
}
