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

const APPLE_ROOT_CA_G3_FINGERPRINT256 = '63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:7C:4F:5C:75:6F:30:17:B3:A8:C4:88:C3:65:3E:91:79';
const APPLE_ROOT_CA_G3_PEM = `-----BEGIN CERTIFICATE-----
MIICQzCCAcmgAwIBAgIILcX8iNLFS5UwCgYIKoZIzj0EAwMwZzEbMBkGA1UEAwwS
QXBwbGUgUm9vdCBDQSAtIEczMSYwJAYDVQQLDB1BcHBsZSBDZXJ0aWZpY2F0aW9u
IEF1dGhvcml0eTETMBEGA1UECgwKQXBwbGUgSW5jLjELMAkGA1UEBhMCVVMwHhcN
MTQwNDMwMTgxOTA2WhcNMzkwNDMwMTgxOTA2WjBnMRswGQYDVQQDDBJBcHBsZSBS
b290IENBIC0gRzMxJjAkBgNVBAsMHUFwcGxlIENlcnRpZmljYXRpb24gQXV0aG9y
aXR5MRMwEQYDVQQKDApBcHBsZSBJbmMuMQswCQYDVQQGEwJVUzB2MBAGByqGSM49
AgEGBSuBBAAiA2IABJjpLz1AcqTtkyJygRMc3RCV8cWjTnHcFBbZDuWmBSp3ZHtf
TjjTuxxEtX/1H7YyYl3J6YRbTzBPEVoA/VhYDKX1DyxNB0cTddqXl5dvMVztK517
IDvYuVTZXpmkOlEKMaNCMEAwHQYDVR0OBBYEFLuw3qFYM4iapIqZ3r6966/ayySr
MA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49BAMDA2gA
MGUCMQCD6cHEFl4aXTQY2e3v9GwOAEZLuN+yRhHFD/3meoyhpmvOwgPUnPWTxnS4
at+qIxUCMG1mihDK1A3UT82NQz60imOlM27jbdoXt2QfyFMm+YhidDkLF1vLUagM
6BgD56KyKA==
-----END CERTIFICATE-----`;

function parseX5cCertificate(derBase64: string): crypto.X509Certificate {
  try {
    return new crypto.X509Certificate(Buffer.from(derBase64, 'base64'));
  } catch {
    throw new Error('APPLE_JWS_INVALID_CERTIFICATE');
  }
}

function getTrustedRootCertificates(): crypto.X509Certificate[] {
  const roots = [new crypto.X509Certificate(APPLE_ROOT_CA_G3_PEM)];
  const testRootPem = process.env.NODE_ENV === 'test'
    ? process.env.APPLE_JWS_TEST_ROOT_CERT_PEM
    : undefined;
  if (testRootPem) {
    roots.push(new crypto.X509Certificate(testRootPem));
  }
  return roots;
}

function findTrustedRoot(cert: crypto.X509Certificate, trustedRoots: crypto.X509Certificate[]): crypto.X509Certificate | undefined {
  return trustedRoots.find((root) => cert.fingerprint256 === root.fingerprint256);
}

function assertCertificateIsTimeValid(cert: crypto.X509Certificate): void {
  const now = Date.now();
  const validFrom = Date.parse(cert.validFrom);
  const validTo = Date.parse(cert.validTo);
  if (!Number.isFinite(validFrom) || !Number.isFinite(validTo) || now < validFrom || now > validTo) {
    throw new Error('APPLE_JWS_CERTIFICATE_EXPIRED');
  }
}

/**
 * Apple's App Store Server Notification / transaction leaf carries the
 * marker extension OID 1.2.840.113635.100.6.11.1 (the same OID Apple's own
 * server library requires). DER encoding of that OID, used as a byte probe:
 * every X.509 extension identifier appears verbatim in the certificate DER.
 */
const APP_STORE_NOTIFICATION_OID_DER = Buffer.from([
  0x06, 0x0a, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x63, 0x64, 0x06, 0x0b, 0x01,
]);

export interface AppleLeafCertificateFacts {
  ca: boolean;
  raw: Buffer;
}

/**
 * QA5 P2 (jws-no-leaf-purpose-check): chaining to Apple Root CA G3 is not
 * sufficient — that root signs every App Store developer's certificates, and
 * the chain walk alone accepted both a sibling end-entity certificate and an
 * intermediate CA signing directly. The leaf must be an end entity AND carry
 * the App Store marker OID.
 */
export function assertAppleAppStoreLeaf(leaf: AppleLeafCertificateFacts): void {
  if (leaf.ca) {
    throw new Error('APPLE_JWS_LEAF_NOT_END_ENTITY');
  }
  if (!Buffer.from(leaf.raw).includes(APP_STORE_NOTIFICATION_OID_DER)) {
    throw new Error('APPLE_JWS_LEAF_NOT_APP_STORE');
  }
}

function assertAppleRootedCertificateChain(x5c: string[]): crypto.X509Certificate {
  const providedChain = x5c.map(parseX5cCertificate);
  const trustedRoots = getTrustedRootCertificates();
  const bundledAppleRoot = trustedRoots[0];
  if (bundledAppleRoot.fingerprint256 !== APPLE_ROOT_CA_G3_FINGERPRINT256) {
    throw new Error('APPLE_JWS_UNTRUSTED_ROOT');
  }
  const chain = [...providedChain];
  const providedRoot = chain[chain.length - 1];
  if (!providedRoot || !findTrustedRoot(providedRoot, trustedRoots)) {
    chain.push(bundledAppleRoot);
  }
  if (chain.length < 1) {
    throw new Error('APPLE_JWS_INCOMPLETE_CERT_CHAIN');
  }

  const root = chain[chain.length - 1];
  if (!findTrustedRoot(root, trustedRoots) || !root.verify(root.publicKey)) {
    throw new Error('APPLE_JWS_UNTRUSTED_ROOT');
  }

  for (const cert of chain) {
    assertCertificateIsTimeValid(cert);
  }

  for (let index = 0; index < chain.length - 1; index += 1) {
    const cert = chain[index];
    const issuer = chain[index + 1];
    if (!cert.verify(issuer.publicKey)) {
      throw new Error('APPLE_JWS_INVALID_CERT_CHAIN');
    }
  }

  assertAppleAppStoreLeaf({ ca: chain[0].ca, raw: chain[0].raw });
  return chain[0];
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

  // Apple signs with ES256. Pin it so a header can never nominate a weaker or
  // absent algorithm (QA5 P2 jws-no-leaf-purpose-check).
  if (header.alg !== 'ES256') {
    throw new Error('APPLE_JWS_UNSUPPORTED_ALG');
  }

  const x5c = header.x5c;
  if (!Array.isArray(x5c) || typeof x5c[0] !== 'string' || x5c[0].length === 0) {
    if (options.requireX5c === false) {
      return { header, payload };
    }
    throw new Error('APPLE_JWS_MISSING_X5C');
  }

  const leaf = assertAppleRootedCertificateChain(x5c as string[]);
  const signedData = `${parts[0]}.${parts[1]}`;
  const signature = Buffer.from(parts[2], 'base64url');
  const verified = crypto.verify(
    'SHA256',
    Buffer.from(signedData),
    { key: leaf.publicKey, dsaEncoding: 'ieee-p1363' },
    signature,
  );

  if (!verified) {
    throw new Error('APPLE_JWS_INVALID_SIGNATURE');
  }

  return { header, payload };
}
