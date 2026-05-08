// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import crypto from 'crypto';

export interface VerifiedAppleJws<TPayload = Record<string, unknown>> {
  header: Record<string, unknown>;
  payload: TPayload;
}

interface VerifyAppleJwsOptions {
  /**
   * App Store Server Notification payloads must carry x5c. Older local
   * StoreKit test transactions may omit it, so protected app-originated
   * verification can opt out without weakening the public webhook.
   */
  requireX5c?: boolean;
}

function toPemCertificate(derBase64: string): string {
  const der = Buffer.from(derBase64, 'base64');
  const body = der.toString('base64').match(/.{1,64}/g)?.join('\n');
  if (!body) {
    throw new Error('APPLE_JWS_EMPTY_CERTIFICATE');
  }
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----`;
}

export function decodeAppleJwsPayload<TPayload = Record<string, unknown>>(jws: string): TPayload {
  const parts = String(jws || '').split('.');
  if (parts.length !== 3) {
    throw new Error('APPLE_JWS_MALFORMED');
  }
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as TPayload;
  } catch {
    throw new Error('APPLE_JWS_INVALID_PAYLOAD');
  }
}

export function verifyAppleJws<TPayload = Record<string, unknown>>(
  jws: string,
  options: VerifyAppleJwsOptions = {},
): VerifiedAppleJws<TPayload> {
  const parts = String(jws || '').split('.');
  if (parts.length !== 3) {
    throw new Error('APPLE_JWS_MALFORMED');
  }

  let header: Record<string, unknown>;
  let payload: TPayload;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  } catch {
    throw new Error('APPLE_JWS_INVALID_HEADER');
  }
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as TPayload;
  } catch {
    throw new Error('APPLE_JWS_INVALID_PAYLOAD');
  }

  const x5c = header.x5c;
  if (!Array.isArray(x5c) || typeof x5c[0] !== 'string' || x5c[0].length === 0) {
    if (options.requireX5c === false) {
      return { header, payload };
    }
    throw new Error('APPLE_JWS_MISSING_X5C');
  }

  const certPem = toPemCertificate(x5c[0]);
  const publicKey = crypto.createPublicKey({ key: certPem, format: 'pem' });
  const signedData = `${parts[0]}.${parts[1]}`;
  const signature = Buffer.from(parts[2], 'base64url');
  const verified = crypto.verify(
    'SHA256',
    Buffer.from(signedData),
    { key: publicKey, dsaEncoding: 'ieee-p1363' },
    signature,
  );

  if (!verified) {
    throw new Error('APPLE_JWS_INVALID_SIGNATURE');
  }

  return { header, payload };
}
