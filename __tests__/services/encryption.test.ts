import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import {
  initEncryption,
  clearEncryption,
  encryptField,
  decryptField,
  isEncryptionEnabled,
  generateMasterKey,
} from '../../src/services/encryption';

// A deterministic test key (64 hex chars = 256 bits)
const TEST_KEY = crypto.randomBytes(32).toString('hex');
const OWNER_A = 'owner-alice';
const OWNER_B = 'owner-bob';

describe('encryption service', () => {
  afterEach(() => {
    clearEncryption();
    delete process.env.DATA_ENCRYPTION_KEY;
  });

  describe('initEncryption', () => {
    it('initializes with explicit hex key', () => {
      initEncryption(TEST_KEY);
      expect(isEncryptionEnabled()).toBe(true);
    });

    it('initializes from DATA_ENCRYPTION_KEY env var', () => {
      process.env.DATA_ENCRYPTION_KEY = TEST_KEY;
      initEncryption();
      expect(isEncryptionEnabled()).toBe(true);
    });

    it('stays disabled when no key provided', () => {
      initEncryption();
      expect(isEncryptionEnabled()).toBe(false);
    });

    it('throws on invalid key length', () => {
      expect(() => initEncryption('tooshort')).toThrow('64 hex characters');
    });
  });

  describe('encrypt/decrypt round-trip', () => {
    beforeEach(() => {
      initEncryption(TEST_KEY);
    });

    it('encrypts and decrypts back to original', () => {
      const plaintext = 'Invoice #12345 — €1,234.56';
      const encrypted = encryptField(plaintext, OWNER_A);
      const decrypted = decryptField(encrypted, OWNER_A);

      expect(encrypted).not.toBe(plaintext);
      expect(encrypted).toMatch(/^v1:/);
      expect(decrypted).toBe(plaintext);
    });

    it('produces different ciphertext each time (random IV)', () => {
      const plaintext = 'same input';
      const a = encryptField(plaintext, OWNER_A);
      const b = encryptField(plaintext, OWNER_A);

      expect(a).not.toBe(b); // random IV → different output
      expect(decryptField(a, OWNER_A)).toBe(plaintext);
      expect(decryptField(b, OWNER_A)).toBe(plaintext);
    });

    it('handles empty string as no-op', () => {
      expect(encryptField('', OWNER_A)).toBe('');
      expect(decryptField('', OWNER_A)).toBe('');
    });

    it('handles unicode and special characters', () => {
      const text = '🇵🇹 Fatura nº 2025/0042 — €99,00';
      const encrypted = encryptField(text, OWNER_A);
      expect(decryptField(encrypted, OWNER_A)).toBe(text);
    });

    it('handles very long strings', () => {
      const longText = 'A'.repeat(10_000);
      const encrypted = encryptField(longText, OWNER_A);
      expect(decryptField(encrypted, OWNER_A)).toBe(longText);
    });
  });

  describe('per-owner isolation', () => {
    beforeEach(() => {
      initEncryption(TEST_KEY);
    });

    it('different owners produce different ciphertext', () => {
      const plaintext = 'shared secret';
      const encA = encryptField(plaintext, OWNER_A);
      const encB = encryptField(plaintext, OWNER_B);

      // Both decrypt correctly with their own owner
      expect(decryptField(encA, OWNER_A)).toBe(plaintext);
      expect(decryptField(encB, OWNER_B)).toBe(plaintext);
    });

    it('cannot decrypt with wrong owner key', () => {
      const plaintext = 'owner-A secret';
      const encrypted = encryptField(plaintext, OWNER_A);

      expect(() => decryptField(encrypted, OWNER_B)).toThrow('Decryption failed');
    });
  });

  describe('plaintext fallback (encryption disabled)', () => {
    beforeEach(() => {
      clearEncryption(); // no key loaded
    });

    it('encryptField returns plaintext when disabled', () => {
      const text = 'some value';
      expect(encryptField(text, OWNER_A)).toBe(text);
    });

    it('decryptField returns plaintext when disabled', () => {
      const text = 'some value';
      expect(decryptField(text, OWNER_A)).toBe(text);
    });
  });

  describe('legacy plaintext handling', () => {
    beforeEach(() => {
      initEncryption(TEST_KEY);
    });

    it('decryptField returns unencrypted strings as-is', () => {
      const legacy = 'plain-old-vendor-name';
      expect(decryptField(legacy, OWNER_A)).toBe(legacy);
    });

    it('decryptField returns malformed encrypted strings as-is', () => {
      const malformed = 'v1:onlytwoparts';
      expect(decryptField(malformed, OWNER_A)).toBe(malformed);
    });
  });

  describe('generateMasterKey', () => {
    it('produces a 64-character hex string', () => {
      const key = generateMasterKey();
      expect(key).toHaveLength(64);
      expect(key).toMatch(/^[0-9a-f]{64}$/);
    });

    it('produces unique keys each time', () => {
      const a = generateMasterKey();
      const b = generateMasterKey();
      expect(a).not.toBe(b);
    });
  });
});
