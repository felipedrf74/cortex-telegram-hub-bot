// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Field-Level Encryption Service
 *
 * Provides AES-256-GCM authenticated encryption for sensitive database fields.
 * Used by the data isolation layer to encrypt financial data (invoice amounts,
 * invoice numbers, vendor info) and other PII at rest.
 *
 * Key derivation: HKDF from a master key (DATA_ENCRYPTION_KEY env var)
 * with per-owner salt for multi-user isolation.
 */

import crypto from 'crypto';
import { logger } from '../utils/logger';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;       // GCM standard: 96-bit IV
const TAG_LENGTH = 16;      // GCM auth tag: 128-bit
const KEY_LENGTH = 32;      // AES-256: 256-bit key
const HKDF_HASH = 'sha256';

// Versioned format: v1:<iv_hex>:<tag_hex>:<ciphertext_hex>
const FORMAT_PREFIX = 'v1';

let _masterKey: Buffer | null = null;

/**
 * Initialize encryption with a master key.
 * Must be called before any encrypt/decrypt operations.
 * In production, the key comes from DATA_ENCRYPTION_KEY env var.
 */
export function initEncryption(masterKeyHex?: string): void {
  const keyHex = masterKeyHex || process.env.DATA_ENCRYPTION_KEY;

  if (!keyHex) {
    logger.warn('DATA_ENCRYPTION_KEY not set — encryption disabled (plaintext mode)');
    _masterKey = null;
    return;
  }

  if (keyHex.length !== 64) {
    throw new Error('DATA_ENCRYPTION_KEY must be 64 hex characters (256 bits)');
  }

  _masterKey = Buffer.from(keyHex, 'hex');
  logger.info('Field-level encryption initialized');
}

/**
 * Check whether encryption is currently enabled.
 */
export function isEncryptionEnabled(): boolean {
  return _masterKey !== null;
}

/**
 * Derive a per-owner encryption key using HKDF.
 * Each owner gets a unique derived key so data cannot be cross-decrypted.
 */
function deriveKey(ownerId: string): Buffer {
  if (!_masterKey) {
    throw new Error('Encryption not initialized');
  }
  return Buffer.from(crypto.hkdfSync(HKDF_HASH, _masterKey, ownerId, 'nexushub-field-enc', KEY_LENGTH));
}

/**
 * Encrypt a plaintext string for a specific owner.
 * Returns a versioned encoded string: v1:<iv>:<tag>:<ciphertext>
 * Returns the plaintext unchanged if encryption is disabled.
 */
export function encryptField(plaintext: string, ownerId: string): string {
  if (!_masterKey) return plaintext;
  if (!plaintext) return plaintext;

  const key = deriveKey(ownerId);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return `${FORMAT_PREFIX}:${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypt an encrypted field for a specific owner.
 * If the value doesn't match the encrypted format, returns it as-is
 * (supports reading legacy plaintext data).
 */
export function decryptField(encrypted: string, ownerId: string): string {
  if (!_masterKey) return encrypted;
  if (!encrypted) return encrypted;

  // Legacy plaintext — not in our encrypted format
  if (!encrypted.startsWith(`${FORMAT_PREFIX}:`)) {
    return encrypted;
  }

  const parts = encrypted.split(':');
  if (parts.length !== 4) {
    logger.warn({ field: encrypted.slice(0, 20) }, 'Malformed encrypted field');
    return encrypted;
  }

  const [, ivHex, tagHex, ciphertextHex] = parts;

  try {
    const key = deriveKey(ownerId);
    const iv = Buffer.from(ivHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');
    const ciphertext = Buffer.from(ciphertextHex, 'hex');

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
    decipher.setAuthTag(tag);

    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);

    return decrypted.toString('utf8');
  } catch (err) {
    logger.error({ err }, 'Failed to decrypt field');
    throw new Error('Decryption failed — wrong key or corrupted data');
  }
}

/**
 * Generate a new random 256-bit master key (hex-encoded).
 * Utility for initial setup — prints to stdout for the admin to save.
 */
export function generateMasterKey(): string {
  return crypto.randomBytes(KEY_LENGTH).toString('hex');
}

/**
 * Clear encryption state (for tests).
 */
export function clearEncryption(): void {
  _masterKey = null;
}
