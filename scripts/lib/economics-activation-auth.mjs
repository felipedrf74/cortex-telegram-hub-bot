// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import crypto from 'node:crypto';

export const ECONOMICS_ACTIVATION_AUTH_SCHEMA =
  'nexus.pre-release-economics-auth.v1';
export const ECONOMICS_ACTIVATION_AUTH_ALGORITHM = 'hmac-sha256';
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const PLACEHOLDER = /(?:change[-_ ]?me|replace[-_ ]?me|placeholder|example|your[-_ ]?secret)/iu;

export function validateEconomicsActivationSecret(secret) {
  if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < 32
      || PLACEHOLDER.test(secret)) {
    throw new Error(
      'LOCAL_PRIMARY_ACTIVATION_EVIDENCE_HMAC_SECRET must be at least 32 bytes and cannot contain placeholder text',
    );
  }
  return secret;
}

function signingInput(payloadSha256) {
  if (typeof payloadSha256 !== 'string' || !SHA256.test(payloadSha256)) {
    throw new Error('economics activation authentication requires a canonical payload digest');
  }
  return Buffer.from(`${ECONOMICS_ACTIVATION_AUTH_SCHEMA}\n${payloadSha256}\n`);
}

export function buildEconomicsActivationAuthentication(payloadSha256, secret) {
  const key = validateEconomicsActivationSecret(secret);
  return {
    schemaVersion: ECONOMICS_ACTIVATION_AUTH_SCHEMA,
    algorithm: ECONOMICS_ACTIVATION_AUTH_ALGORITHM,
    signature: `sha256:${crypto.createHmac('sha256', key)
      .update(signingInput(payloadSha256)).digest('hex')}`,
  };
}

export function validateEconomicsActivationAuthentication(value, payloadSha256, secret) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || JSON.stringify(Object.keys(value).sort())
        !== JSON.stringify(['algorithm', 'schemaVersion', 'signature'])) {
    throw new Error('economics activation authentication schema is invalid');
  }
  if (value.schemaVersion !== ECONOMICS_ACTIVATION_AUTH_SCHEMA
      || value.algorithm !== ECONOMICS_ACTIVATION_AUTH_ALGORITHM
      || typeof value.signature !== 'string' || !SHA256.test(value.signature)) {
    throw new Error('economics activation authentication contract is invalid');
  }
  const expected = buildEconomicsActivationAuthentication(payloadSha256, secret).signature;
  const actualBytes = Buffer.from(value.signature, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  if (actualBytes.length !== expectedBytes.length
      || !crypto.timingSafeEqual(actualBytes, expectedBytes)) {
    throw new Error('economics activation authentication signature is invalid');
  }
  return value;
}
