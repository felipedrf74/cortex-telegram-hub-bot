// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import crypto from 'node:crypto';
import { localPrimaryInferenceConfig } from './local-primary-config';
import { decryptValue } from '../utils/encryption';

const CONTENT_SCRIPT_JOB_HKDF_SALT = Buffer.from('nexushub-content-script-jobs-v2', 'utf8');
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

interface EncryptedJobEnvelopeV1 {
  schema: 'nexus.content-script-job-encrypted.v1';
  keyVersion: string;
  ciphertext: string;
}

interface EncryptedJobEnvelopeV2 {
  schema: 'nexus.content-script-job-encrypted.v2';
  keyVersion: string;
  ciphertext: string;
}

interface EncryptedJobEnvelopeV3 {
  schema: 'nexus.content-script-job-encrypted.v3';
  keyVersion: string;
  ciphertext: string;
}

type EncryptedJobEnvelope = EncryptedJobEnvelopeV1 | EncryptedJobEnvelopeV2 | EncryptedJobEnvelopeV3;

export class ContentScriptJobEncryptionError extends Error {
  readonly status = 503;

  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ContentScriptJobEncryptionError';
  }
}

function key(): string {
  const value = String(localPrimaryInferenceConfig.scriptJobEncryptionKey ?? '').trim();
  if (!value || Buffer.byteLength(value, 'utf8') < 32) {
    throw new ContentScriptJobEncryptionError(
      'CONTENT_SCRIPT_JOB_ENCRYPTION_KEY_UNAVAILABLE',
      'CONTENT_SCRIPT_JOB_ENCRYPTION_KEY must be at least 32 bytes when script jobs are enabled',
    );
  }
  return value;
}

function decryptionKeys(): string[] {
  const values = [
    localPrimaryInferenceConfig.scriptJobEncryptionKey,
    ...(localPrimaryInferenceConfig.scriptJobPreviousEncryptionKeys ?? []),
  ]
    .map((value) => String(value ?? '').trim())
    .filter((value, index, values) => (
      Buffer.byteLength(value, 'utf8') >= 32 && values.indexOf(value) === index
    ));
  if (values.length === 0) {
    throw new ContentScriptJobEncryptionError(
      'CONTENT_SCRIPT_JOB_ENCRYPTION_KEY_UNAVAILABLE',
      'No usable content script job decryption key is configured',
    );
  }
  return values;
}

function legacyKeyVersion(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function deriveContentJobKey(value: string, info: string): Buffer {
  return Buffer.from(crypto.hkdfSync(
    'sha256',
    Buffer.from(value, 'utf8'),
    CONTENT_SCRIPT_JOB_HKDF_SALT,
    Buffer.from(info, 'utf8'),
    KEY_LENGTH,
  ));
}

function contentKeyVersion(value: string): string {
  return crypto.createHash('sha256')
    .update(deriveContentJobKey(value, 'key-version'))
    .digest('hex')
    .slice(0, 16);
}

function envelopeAad(schema: EncryptedJobEnvelope['schema'], keyVersion: string): Buffer {
  return Buffer.from(`${schema}\u0000${keyVersion}`, 'utf8');
}

function encryptContentValue(
  plaintext: string,
  secret: string,
  userId: number,
  aad?: Buffer,
): string {
  const key = deriveContentJobKey(secret, `user:${userId}`);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_LENGTH });
  if (aad) cipher.setAAD(aad);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('hex');
}

function decryptContentValue(
  packedHex: string,
  secret: string,
  userId: number,
  aad?: Buffer,
): string {
  if (!/^[0-9a-f]+$/iu.test(packedHex) || packedHex.length % 2 !== 0) {
    throw new ContentScriptJobEncryptionError(
      'CONTENT_SCRIPT_JOB_CIPHERTEXT_INVALID',
      'Content script job ciphertext is invalid',
    );
  }
  const packed = Buffer.from(packedHex, 'hex');
  if (packed.length < IV_LENGTH + TAG_LENGTH) {
    throw new ContentScriptJobEncryptionError(
      'CONTENT_SCRIPT_JOB_CIPHERTEXT_INVALID',
      'Content script job ciphertext is invalid',
    );
  }
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    deriveContentJobKey(secret, `user:${userId}`),
    packed.subarray(0, IV_LENGTH),
    { authTagLength: TAG_LENGTH },
  );
  if (aad) decipher.setAAD(aad);
  decipher.setAuthTag(packed.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH));
  return decipher.update(packed.subarray(IV_LENGTH + TAG_LENGTH), undefined, 'utf8') + decipher.final('utf8');
}

export function encryptContentScriptJobJson(value: unknown, userId: number): string {
  const secret = key();
  const schema: EncryptedJobEnvelopeV3['schema'] = 'nexus.content-script-job-encrypted.v3';
  const keyVersion = contentKeyVersion(secret);
  const envelope: EncryptedJobEnvelopeV3 = {
    schema,
    keyVersion,
    ciphertext: encryptContentValue(
      JSON.stringify(value),
      secret,
      userId,
      envelopeAad(schema, keyVersion),
    ),
  };
  return JSON.stringify(envelope);
}

export function decryptContentScriptJobJson<T>(stored: string, userId: number): T {
  let parsed: Partial<EncryptedJobEnvelope>;
  try {
    parsed = JSON.parse(stored) as Partial<EncryptedJobEnvelope>;
  } catch {
    throw new ContentScriptJobEncryptionError(
      'CONTENT_SCRIPT_JOB_ENVELOPE_INVALID',
      'Content script job encrypted envelope is invalid',
    );
  }
  if ((parsed.schema !== 'nexus.content-script-job-encrypted.v1'
      && parsed.schema !== 'nexus.content-script-job-encrypted.v2'
      && parsed.schema !== 'nexus.content-script-job-encrypted.v3')
      || typeof parsed.ciphertext !== 'string'
      || typeof parsed.keyVersion !== 'string') {
    throw new ContentScriptJobEncryptionError(
      'CONTENT_SCRIPT_JOB_ENVELOPE_INVALID',
      'Content script job encrypted envelope is invalid',
    );
  }
  const envelope = parsed as EncryptedJobEnvelope;
  const legacy = envelope.schema === 'nexus.content-script-job-encrypted.v1';
  const configuredKeys = decryptionKeys();
  const declaredVersionMatchesAnotherLegacySchema = configuredKeys.some((secret) => {
    const expectedVersion = legacy ? legacyKeyVersion(secret) : contentKeyVersion(secret);
    const alternateVersion = legacy ? contentKeyVersion(secret) : legacyKeyVersion(secret);
    return envelope.keyVersion !== expectedVersion && envelope.keyVersion === alternateVersion;
  });
  if (declaredVersionMatchesAnotherLegacySchema) {
    throw new ContentScriptJobEncryptionError(
      'CONTENT_SCRIPT_JOB_ENVELOPE_AUTHENTICATION_FAILED',
      'Content script job envelope schema does not match its declared key identity',
    );
  }
  let declaredVersionIsConfigured = false;
  for (const secret of configuredKeys) {
    const expectedVersion = legacy ? legacyKeyVersion(secret) : contentKeyVersion(secret);
    if (expectedVersion === envelope.keyVersion) declaredVersionIsConfigured = true;
    try {
      const plaintext = legacy
        ? decryptValue(envelope.ciphertext, secret, userId)
        : decryptContentValue(
          envelope.ciphertext,
          secret,
          userId,
          envelope.schema === 'nexus.content-script-job-encrypted.v3'
            ? envelopeAad(envelope.schema, expectedVersion)
            : undefined,
        );
      const decoded = JSON.parse(plaintext) as T;
      if (expectedVersion !== envelope.keyVersion) {
        throw new ContentScriptJobEncryptionError(
          'CONTENT_SCRIPT_JOB_ENVELOPE_AUTHENTICATION_FAILED',
          'Content script job envelope metadata does not authenticate its ciphertext',
        );
      }
      return decoded;
    } catch (error) {
      if (error instanceof ContentScriptJobEncryptionError
          && error.code === 'CONTENT_SCRIPT_JOB_ENVELOPE_AUTHENTICATION_FAILED') {
        throw error;
      }
      // Try every configured key before distinguishing a genuinely retired key
      // from corrupt ciphertext. This also detects unauthenticated v1/v2
      // keyVersion mutations whenever the ciphertext still authenticates.
    }
  }
  if (!declaredVersionIsConfigured) {
    throw new ContentScriptJobEncryptionError(
      'CONTENT_SCRIPT_JOB_KEY_VERSION_UNAVAILABLE',
      'Content script job encrypted envelope uses an unavailable key version',
    );
  }
  throw new ContentScriptJobEncryptionError(
    'CONTENT_SCRIPT_JOB_DECRYPTION_FAILED',
    'Content script job encrypted payload could not be decrypted',
  );
}
