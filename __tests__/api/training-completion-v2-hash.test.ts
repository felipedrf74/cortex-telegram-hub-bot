/**
 * R4 P2 — CompletionFeedbackV2 idempotency hash is canonical-value-based.
 *
 * Codex caught (R4 P2 #1) that the prior `v2Summary` hash basis only
 * fingerprinted *presence* of fields. So two distinct logged completions
 * with the same shape but different numeric values collapsed to the
 * same outbox idempotency key, and the second event was dropped.
 *
 * These tests pin the new contract:
 *
 *   - Identical canonical values  → identical hash.
 *   - Distinct numeric values     → distinct hashes.
 *   - Distinct string content     → distinct hashes (within length budget).
 *   - NaN/Infinity coerced to null (defensive — validator rejects upstream).
 *   - String fingerprint never leaks the raw value (length-bounded byte
 *     fingerprint only).
 */
import { describe, expect, it } from 'vitest';
import {
  buildV2CanonicalSummary,
  computeV2IdempotencyHashHex,
} from '../../src/api/routes/training-completion-v2-hash';

describe('R4 P2 — V2 completion idempotency hash', () => {
  it('returns identical hex for identical canonical inputs', () => {
    const a = computeV2IdempotencyHashHex({
      rir: 2,
      painScore: 1,
      externalTrainingDeclared: false,
    });
    const b = computeV2IdempotencyHashHex({
      rir: 2,
      painScore: 1,
      externalTrainingDeclared: false,
    });
    expect(a).toBe(b);
  });

  it('two payloads with same presence shape but different numeric values produce different hashes', () => {
    // The exact scenario Codex flagged in R4 P2 #1.
    const a = computeV2IdempotencyHashHex({ painScore: 1, rir: 2 });
    const b = computeV2IdempotencyHashHex({ painScore: 9, rir: 0 });
    expect(a).not.toBe(b);
  });

  it('distinct rir values produce distinct hashes (granular numeric distinctness)', () => {
    const seen = new Set<string>();
    for (let rir = 0; rir <= 10; rir++) {
      seen.add(computeV2IdempotencyHashHex({ rir }));
    }
    // 11 distinct integer rir values → 11 distinct hash outputs.
    expect(seen.size).toBe(11);
  });

  it('distinct painScore values produce distinct hashes', () => {
    const seen = new Set<string>();
    for (let painScore = 0; painScore <= 10; painScore++) {
      seen.add(computeV2IdempotencyHashHex({ painScore }));
    }
    expect(seen.size).toBe(11);
  });

  it('distinct completedDurationSec values produce distinct hashes', () => {
    const a = computeV2IdempotencyHashHex({ completedDurationSec: 1800 });
    const b = computeV2IdempotencyHashHex({ completedDurationSec: 3600 });
    expect(a).not.toBe(b);
  });

  it('distinct painLocation strings produce distinct hashes', () => {
    const a = computeV2IdempotencyHashHex({ painLocation: 'left achilles' });
    const b = computeV2IdempotencyHashHex({ painLocation: 'right knee' });
    expect(a).not.toBe(b);
  });

  it('externalTrainingDeclared toggles the hash', () => {
    const off = computeV2IdempotencyHashHex({ externalTrainingDeclared: false });
    const on = computeV2IdempotencyHashHex({ externalTrainingDeclared: true });
    expect(off).not.toBe(on);
  });

  it('NaN/Infinity numeric fields coerce to null in canonical summary', () => {
    const summary = buildV2CanonicalSummary({
      rir: Number.NaN,
      painScore: Number.POSITIVE_INFINITY,
      completedDurationSec: Number.NEGATIVE_INFINITY,
    });
    expect(summary.rir).toBeNull();
    expect(summary.painScore).toBeNull();
    expect(summary.completedDurationSec).toBeNull();
  });

  it('NaN-bearing payload hashes equal to the null-bearing payload (NaN never propagates as a distinct value)', () => {
    const nan = computeV2IdempotencyHashHex({ rir: Number.NaN });
    const nullish = computeV2IdempotencyHashHex({ rir: null });
    const omitted = computeV2IdempotencyHashHex({});
    expect(nan).toBe(nullish);
    expect(nan).toBe(omitted);
  });

  it('canonical string fingerprint is length-bounded and never echoes the raw value', () => {
    const summary = buildV2CanonicalSummary({
      painLocation: 'left achilles tendon — sharp pain after intervals',
    });
    expect(typeof summary.painLocation).toBe('string');
    const value = summary.painLocation as string;
    expect(value).toMatch(/^l\d+h[0-9a-f]+$/);
    // The fingerprint does not contain the raw string content (privacy).
    expect(value.includes('achilles')).toBe(false);
    expect(value.includes('pain')).toBe(false);
  });

  it('non-string painLocation collapses to empty fingerprint (parity with omitted)', () => {
    // Validator at call site rejects non-strings, but the helper is total.
    const summary = buildV2CanonicalSummary({
      painLocation: 42 as unknown as string,
    });
    expect(summary.painLocation).toBe('');
  });

  it('empty completed*Json strings collapse to empty fingerprint', () => {
    const a = computeV2IdempotencyHashHex({
      completedSetsJson: '',
      completedRepsJson: '',
      completedLoadJson: '',
    });
    const b = computeV2IdempotencyHashHex({});
    expect(a).toBe(b);
  });

  it('two completedSetsJson payloads of same length but different content hash differently', () => {
    const a = computeV2IdempotencyHashHex({
      completedSetsJson: '[{"reps":10,"load":50}]',
    });
    const b = computeV2IdempotencyHashHex({
      completedSetsJson: '[{"reps":12,"load":48}]',
    });
    expect(a).not.toBe(b);
  });

  it('all string-empty + all numeric-null + externalTrainingDeclared=false produces a stable baseline hex', () => {
    const baseline = computeV2IdempotencyHashHex({});
    // Sanity: the helper always returns lowercase hex.
    expect(baseline).toMatch(/^[0-9a-f]+$/);
    // Stable across runs (no time-based input).
    expect(computeV2IdempotencyHashHex({})).toBe(baseline);
  });
});

describe('R5 P2 — SHA-256 upgrade closes the 32-bit FNV collision', () => {
  it('Codex-found collision pair "3gdr5fzx" vs "5bp434lq" produces DISTINCT hashes', () => {
    // Codex's R4 verification showed these two strings collided under
    // the previous FNV-1a 32-bit fingerprint (both → 790060a4).
    // SHA-256 should give them different fingerprints.
    const a = computeV2IdempotencyHashHex({ painLocation: '3gdr5fzx' });
    const b = computeV2IdempotencyHashHex({ painLocation: '5bp434lq' });
    expect(a).not.toBe(b);
  });

  it('hash output is exactly 16 hex chars (64 bits of SHA-256)', () => {
    expect(computeV2IdempotencyHashHex({})).toMatch(/^[0-9a-f]{16}$/);
    expect(computeV2IdempotencyHashHex({ rir: 5 })).toMatch(/^[0-9a-f]{16}$/);
  });

  it('1000 distinct rir+painScore+painLocation triples all produce distinct hashes (probabilistic regression)', () => {
    const seen = new Set<string>();
    for (let r = 0; r <= 10; r += 1) {
      for (let p = 0; p <= 10; p += 1) {
        for (let s = 0; s < 9; s += 1) {
          const loc = `loc-${r}-${p}-${s}`;
          seen.add(computeV2IdempotencyHashHex({ rir: r, painScore: p, painLocation: loc }));
        }
      }
    }
    // 11 * 11 * 9 = 1089 distinct inputs should all map to distinct
    // 64-bit hashes (birthday bound ~2^32, well above 1k).
    expect(seen.size).toBe(11 * 11 * 9);
  });

  it('string-fingerprint output never contains the raw string content', () => {
    const sensitive = 'left achilles tendon — sharp pain after intervals';
    const summary = buildV2CanonicalSummary({ painLocation: sensitive });
    const fingerprint = summary.painLocation as string;
    expect(fingerprint).toMatch(/^l\d+h[0-9a-f]+$/);
    expect(fingerprint.includes('achilles')).toBe(false);
    expect(fingerprint.includes('pain')).toBe(false);
    expect(fingerprint.includes('sharp')).toBe(false);
  });

  it('string-fingerprint length prefix distinguishes 0-length from short non-empty', () => {
    const empty = buildV2CanonicalSummary({ painLocation: '' }).painLocation;
    const single = buildV2CanonicalSummary({ painLocation: 'x' }).painLocation;
    expect(empty).toBe('');
    expect(single).toMatch(/^l1h[0-9a-f]+$/);
  });
});
