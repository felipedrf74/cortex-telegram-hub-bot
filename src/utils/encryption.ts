// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Field-level encryption utilities for sensitive financial data.
 *
 * Uses AES-256-GCM with per-user key derivation (HKDF) from a master key.
 * Each encrypted value has its own random IV and authentication tag.
 */

import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96-bit IV recommended for GCM
const TAG_LENGTH = 16; // 128-bit auth tag
const KEY_LENGTH = 32; // 256-bit key

/** Packed format: IV (12) + authTag (16) + ciphertext → hex string */
export interface EncryptedField {
  /** Hex-encoded packed blob: iv + tag + ciphertext */
  encrypted: string;
}

/**
 * Derive a per-user 256-bit encryption key from the master key using HKDF.
 * The userId is used as the "info" parameter so each user gets a unique key.
 */
export function deriveUserKey(masterKey: string, userId: number): Buffer {
  const ikm = Buffer.from(masterKey, 'utf-8');
  const salt = Buffer.from('nexushub-finance-v1', 'utf-8');
  const info = Buffer.from(`user:${userId}`, 'utf-8');
  return Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, KEY_LENGTH));
}

/**
 * Encrypt a string value using AES-256-GCM with a per-user derived key.
 * Returns a hex-encoded packed blob: IV (12 bytes) + authTag (16 bytes) + ciphertext.
 */
export function encryptValue(plaintext: string, masterKey: string, userId: number): string {
  const key = deriveUserKey(masterKey, userId);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });

  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Pack: IV + tag + ciphertext
  return Buffer.concat([iv, tag, encrypted]).toString('hex');
}

/**
 * Decrypt a hex-encoded packed blob back to the original plaintext.
 * Throws if the data has been tampered with (GCM auth tag verification).
 */
export function decryptValue(packed: string, masterKey: string, userId: number): string {
  const key = deriveUserKey(masterKey, userId);
  const buf = Buffer.from(packed, 'hex');

  if (buf.length < IV_LENGTH + TAG_LENGTH) {
    throw new Error('Invalid encrypted data: too short');
  }

  const iv = buf.subarray(0, IV_LENGTH);
  const tag = buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = buf.subarray(IV_LENGTH + TAG_LENGTH);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
  decipher.setAuthTag(tag);

  return decipher.update(ciphertext) + decipher.final('utf8');
}

/**
 * Encrypt a numeric value. Stores the number as a string internally.
 */
export function encryptNumber(value: number, masterKey: string, userId: number): string {
  return encryptValue(String(value), masterKey, userId);
}

/**
 * Decrypt back to a number.
 */
export function decryptNumber(packed: string, masterKey: string, userId: number): number {
  const str = decryptValue(packed, masterKey, userId);
  const num = parseFloat(str);
  if (isNaN(num)) throw new Error('Decrypted value is not a valid number');
  return num;
}
