// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * HMAC-SHA256 helper used by Option-3 shadow-eval (O3-A5, O3-A20).
 *
 * Short classify messages ("Schedule with Sarah", "Pago R$ 50") are
 * trivially dictionary-attackable under plain SHA-256 — there are only
 * so many ways to write "schedule a meeting" in Portuguese or English.
 * HMAC with a server-side secret prevents an attacker who reads the
 * `classify_shadow_runs` table (e.g., via a future DB-leak scenario)
 * from reversing message hashes by simply hashing a dictionary.
 *
 * The secret lives in `CLASSIFY_SHADOW_HASH_SECRET` and is generated
 * once at deploy time (Phase K Step 5 / Option-3 A20). It MUST NOT be
 * rotated on every deploy — that would break HMAC continuity and make
 * historical shadow rows uncorrelatable for diagnostics.
 *
 * Output is 64 lowercase hex chars (256 bits). Suitable for use as
 * a SQLite TEXT primary identifier per row.
 */
import { createHmac } from 'crypto';

export function hmacSha256(secret: string, message: string): string {
  return createHmac('sha256', secret).update(message, 'utf8').digest('hex');
}
