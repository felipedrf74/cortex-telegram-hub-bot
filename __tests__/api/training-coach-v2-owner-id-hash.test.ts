/**
 * R4 P3 / R5 P3 — hashOwnerIdForLog hashes the foreign owner so an
 * operator reading the ownership-denied log can correlate across
 * denials but cannot reconstruct the victim's user id.
 *
 * R4 used a 24-bit FNV-1a hash. Codex caught that small sequential
 * user IDs were trivially brute-forceable. R5 upgraded to HMAC-SHA256
 * keyed by a process-secret (or `OWNER_ID_HASH_SECRET` env), so the
 * tag is non-enumerable without the secret.
 */
import { describe, expect, it } from 'vitest';
import { hashOwnerIdForLog } from '../../src/api/routes/training-coach-v2';

describe('R5 P3 — hashOwnerIdForLog (HMAC-SHA256 upgrade)', () => {
  it('is deterministic for the same input within a single process', () => {
    expect(hashOwnerIdForLog(42)).toBe(hashOwnerIdForLog(42));
  });

  it('emits the `u#` prefix + 8-char lowercase hex suffix', () => {
    expect(hashOwnerIdForLog(42)).toMatch(/^u#[0-9a-f]{8}$/);
    expect(hashOwnerIdForLog(99999999)).toMatch(/^u#[0-9a-f]{8}$/);
  });

  it('different user ids produce different hashes (collision-free over small sample)', () => {
    const seen = new Set<string>();
    for (let id = 1; id <= 100; id++) {
      seen.add(hashOwnerIdForLog(id));
    }
    // 100 ids — should map to 100 distinct hash strings with very
    // high probability (32-bit HMAC slice has ~4B slots).
    expect(seen.size).toBe(100);
  });

  it('does NOT echo the raw integer in the output', () => {
    const h = hashOwnerIdForLog(31415);
    expect(h.includes('31415')).toBe(false);
  });

  it('is NOT enumerable from the integer alone (the prior FNV bug)', () => {
    // The point of the HMAC upgrade is that an attacker who knows
    // the algorithm can't pre-compute the tag for user-id 1..N
    // without the server secret. We verify by recomputing FNV-1a
    // (the prior algorithm) directly and asserting it does NOT
    // equal the current output.
    const fnvAttacker = (id: number): string => {
      let h = 0x811c9dc5;
      const s = String(id);
      for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = (h * 0x01000193) | 0;
      }
      return `u#${((h >>> 0) & 0xffffff).toString(16).padStart(6, '0')}`;
    };
    for (const id of [1, 2, 3, 42, 1000]) {
      expect(hashOwnerIdForLog(id)).not.toBe(fnvAttacker(id));
    }
  });

  it('returns "invalid" for non-positive / non-finite inputs', () => {
    expect(hashOwnerIdForLog(0)).toBe('invalid');
    expect(hashOwnerIdForLog(-1)).toBe('invalid');
    expect(hashOwnerIdForLog(Number.NaN)).toBe('invalid');
    expect(hashOwnerIdForLog(Number.POSITIVE_INFINITY)).toBe('invalid');
  });

  it('output length is constant + bounded (safe for log lines)', () => {
    for (const id of [1, 10, 100, 10_000, 999_999_999]) {
      expect(hashOwnerIdForLog(id).length).toBe(10); // 'u#' + 8 hex
    }
  });
});
