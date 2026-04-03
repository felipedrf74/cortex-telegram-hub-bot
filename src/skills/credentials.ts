// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Skill Credential Manager — encrypted, skill-isolated credential storage.
 *
 * Security guarantees:
 * 1. Values are encrypted at rest (AES-256-GCM) using a per-install key
 * 2. Credentials are scoped by skill_id — cross-skill access is blocked
 * 3. All operations validate skill ownership before reading/writing
 */

import crypto from 'crypto';
import os from 'os';
import path from 'path';
import { getDb } from '../services/database';
import { logger } from '../utils/logger';

// ── Encryption ──────────────────────────────────────────────────

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

/**
 * Derive the encryption key from an environment variable or a stable machine-specific seed.
 * In production, set SKILL_CREDENTIAL_KEY (hex-encoded 32-byte key).
 * Falls back to a deterministic key derived from hostname + homedir for dev/test.
 */
function getEncryptionKey(): Buffer {
  const envKey = process.env.SKILL_CREDENTIAL_KEY;
  if (envKey) {
    const buf = Buffer.from(envKey, 'hex');
    if (buf.length !== 32) {
      throw new Error('SKILL_CREDENTIAL_KEY must be a 64-char hex string (32 bytes)');
    }
    return buf;
  }
  // Dev/test fallback: deterministic from machine identity
  const seed = `nexushub-skill-cred-${os.hostname()}-${os.homedir()}`;
  return crypto.createHash('sha256').update(seed).digest();
}

/** Encrypt a plaintext string. Returns base64-encoded IV + authTag + ciphertext. */
export function encrypt(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Pack: IV (16) + authTag (16) + ciphertext
  const packed = Buffer.concat([iv, authTag, encrypted]);
  return packed.toString('base64');
}

/** Decrypt a base64-encoded packed value. Returns plaintext. */
export function decrypt(packed: string): string {
  const key = getEncryptionKey();
  const buf = Buffer.from(packed, 'base64');
  if (buf.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error('Invalid encrypted value: too short');
  }
  const iv = buf.subarray(0, IV_LENGTH);
  const authTag = buf.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = buf.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf8');
}

// ── Skill-scoped credential operations ──────────────────────────

/** Resolve a skill name to its numeric ID. Returns undefined if not found. */
function resolveSkillId(skillName: string): number | undefined {
  const db = getDb();
  const row = db.prepare('SELECT id FROM installed_skills WHERE name = ?').get(skillName) as { id: number } | undefined;
  return row?.id;
}

/** Set (or update) an encrypted credential for a skill. */
export function setCredential(skillName: string, keyName: string, value: string): void {
  const skillId = resolveSkillId(skillName);
  if (!skillId) {
    throw new Error(`Skill not found: ${skillName}`);
  }
  const encryptedValue = encrypt(value);
  const db = getDb();
  db.prepare(`
    INSERT INTO skill_credentials (skill_id, key_name, encrypted_value)
    VALUES (?, ?, ?)
    ON CONFLICT(skill_id, key_name) DO UPDATE SET
      encrypted_value = excluded.encrypted_value
  `).run(skillId, keyName, encryptedValue);
  logger.info({ skill: skillName, key: keyName }, 'Credential set');
}

/** Get a decrypted credential for a skill. Returns undefined if not found. */
export function getCredential(skillName: string, keyName: string): string | undefined {
  const skillId = resolveSkillId(skillName);
  if (!skillId) return undefined;
  const db = getDb();
  const row = db.prepare(
    'SELECT encrypted_value FROM skill_credentials WHERE skill_id = ? AND key_name = ?'
  ).get(skillId, keyName) as { encrypted_value: string } | undefined;
  if (!row) return undefined;
  return decrypt(row.encrypted_value);
}

/** Delete a credential for a skill. Returns true if removed. */
export function deleteCredential(skillName: string, keyName: string): boolean {
  const skillId = resolveSkillId(skillName);
  if (!skillId) return false;
  const db = getDb();
  const result = db.prepare(
    'DELETE FROM skill_credentials WHERE skill_id = ? AND key_name = ?'
  ).run(skillId, keyName);
  if (result.changes > 0) {
    logger.info({ skill: skillName, key: keyName }, 'Credential deleted');
  }
  return result.changes > 0;
}

/** List all credential key names for a skill (values are NOT returned). */
export function listCredentialKeys(skillName: string): string[] {
  const skillId = resolveSkillId(skillName);
  if (!skillId) return [];
  const db = getDb();
  const rows = db.prepare(
    'SELECT key_name FROM skill_credentials WHERE skill_id = ? ORDER BY key_name'
  ).all(skillId) as Array<{ key_name: string }>;
  return rows.map(r => r.key_name);
}

/** Delete all credentials for a skill. Returns number of credentials removed. */
export function clearCredentials(skillName: string): number {
  const skillId = resolveSkillId(skillName);
  if (!skillId) return 0;
  const db = getDb();
  const result = db.prepare('DELETE FROM skill_credentials WHERE skill_id = ?').run(skillId);
  if (result.changes > 0) {
    logger.info({ skill: skillName, count: result.changes }, 'All credentials cleared');
  }
  return result.changes;
}
