/**
 * Tests for src/utils/encryption.ts
 *
 * Validates:
 * - AES-256-GCM encrypt/decrypt round-trips
 * - Per-user key derivation produces different keys
 * - Tamper detection (GCM auth tag)
 * - Number encrypt/decrypt
 * - Edge cases (empty strings, special characters)
 */

import { describe, it, expect } from 'vitest';
import {
  deriveUserKey,
  encryptValue,
  decryptValue,
  encryptNumber,
  decryptNumber,
} from '../../src/utils/encryption';

const MASTER_KEY = 'test-master-key-for-unit-tests-32chars!';

describe('deriveUserKey', () => {
  it('derives a 32-byte key', () => {
    const key = deriveUserKey(MASTER_KEY, 12345);
    expect(key).toBeInstanceOf(Buffer);
    expect(key.length).toBe(32);
  });

  it('derives different keys for different users', () => {
    const key1 = deriveUserKey(MASTER_KEY, 1);
    const key2 = deriveUserKey(MASTER_KEY, 2);
    expect(key1.equals(key2)).toBe(false);
  });

  it('derives same key for same user deterministically', () => {
    const key1 = deriveUserKey(MASTER_KEY, 42);
    const key2 = deriveUserKey(MASTER_KEY, 42);
    expect(key1.equals(key2)).toBe(true);
  });

  it('derives different keys for different master keys', () => {
    const key1 = deriveUserKey('master-a', 1);
    const key2 = deriveUserKey('master-b', 1);
    expect(key1.equals(key2)).toBe(false);
  });
});

describe('encryptValue / decryptValue', () => {
  it('round-trips a simple string', () => {
    const plain = 'Hello, Finance!';
    const encrypted = encryptValue(plain, MASTER_KEY, 1);
    const decrypted = decryptValue(encrypted, MASTER_KEY, 1);
    expect(decrypted).toBe(plain);
  });

  it('encrypted output is hex string', () => {
    const encrypted = encryptValue('test', MASTER_KEY, 1);
    expect(encrypted).toMatch(/^[0-9a-f]+$/);
  });

  it('produces different ciphertext each time (random IV)', () => {
    const e1 = encryptValue('same', MASTER_KEY, 1);
    const e2 = encryptValue('same', MASTER_KEY, 1);
    expect(e1).not.toBe(e2);
  });

  it('decrypts only with the correct user', () => {
    const encrypted = encryptValue('secret', MASTER_KEY, 1);
    expect(() => decryptValue(encrypted, MASTER_KEY, 2)).toThrow();
  });

  it('decrypts only with the correct master key', () => {
    const encrypted = encryptValue('secret', MASTER_KEY, 1);
    expect(() => decryptValue(encrypted, 'wrong-key', 1)).toThrow();
  });

  it('detects tampered ciphertext', () => {
    const encrypted = encryptValue('secret', MASTER_KEY, 1);
    // Flip a byte in the ciphertext portion
    const buf = Buffer.from(encrypted, 'hex');
    buf[buf.length - 1] ^= 0xff;
    const tampered = buf.toString('hex');
    expect(() => decryptValue(tampered, MASTER_KEY, 1)).toThrow();
  });

  it('throws on too-short data', () => {
    expect(() => decryptValue('abcd', MASTER_KEY, 1)).toThrow('too short');
  });

  it('handles empty string', () => {
    const encrypted = encryptValue('', MASTER_KEY, 1);
    const decrypted = decryptValue(encrypted, MASTER_KEY, 1);
    expect(decrypted).toBe('');
  });

  it('handles special characters and unicode', () => {
    const plain = 'R$ 1.234,56 — Pagamento de março 🇧🇷';
    const encrypted = encryptValue(plain, MASTER_KEY, 1);
    const decrypted = decryptValue(encrypted, MASTER_KEY, 1);
    expect(decrypted).toBe(plain);
  });

  it('handles long strings', () => {
    const plain = 'x'.repeat(10000);
    const encrypted = encryptValue(plain, MASTER_KEY, 1);
    const decrypted = decryptValue(encrypted, MASTER_KEY, 1);
    expect(decrypted).toBe(plain);
  });
});

describe('encryptNumber / decryptNumber', () => {
  it('round-trips an integer', () => {
    const encrypted = encryptNumber(5000, MASTER_KEY, 1);
    expect(decryptNumber(encrypted, MASTER_KEY, 1)).toBe(5000);
  });

  it('round-trips a decimal', () => {
    const encrypted = encryptNumber(1234.56, MASTER_KEY, 1);
    expect(decryptNumber(encrypted, MASTER_KEY, 1)).toBe(1234.56);
  });

  it('round-trips zero', () => {
    const encrypted = encryptNumber(0, MASTER_KEY, 1);
    expect(decryptNumber(encrypted, MASTER_KEY, 1)).toBe(0);
  });

  it('round-trips negative numbers', () => {
    const encrypted = encryptNumber(-42.5, MASTER_KEY, 1);
    expect(decryptNumber(encrypted, MASTER_KEY, 1)).toBe(-42.5);
  });

  it('preserves precision for typical currency amounts', () => {
    const amounts = [0.01, 0.10, 1.00, 99.99, 1234.56, 99999.99];
    for (const amt of amounts) {
      const encrypted = encryptNumber(amt, MASTER_KEY, 1);
      expect(decryptNumber(encrypted, MASTER_KEY, 1)).toBe(amt);
    }
  });

  it('different users get different ciphertext', () => {
    const e1 = encryptNumber(100, MASTER_KEY, 1);
    const e2 = encryptNumber(100, MASTER_KEY, 2);
    // Can't decrypt with wrong user
    expect(() => decryptNumber(e1, MASTER_KEY, 2)).toThrow();
    expect(() => decryptNumber(e2, MASTER_KEY, 1)).toThrow();
  });
});
