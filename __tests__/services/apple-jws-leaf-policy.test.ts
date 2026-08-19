// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * QA5 P2 (jws-no-leaf-purpose-check): chaining to Apple Root CA G3 is not
 * proof that a certificate is an App Store notification signer. That root
 * signs certificates for every Apple developer, so the verifier also accepted
 * a sibling end-entity certificate and an intermediate CA signing directly.
 */

import { describe, expect, it } from 'vitest';
import { assertAppleAppStoreLeaf } from '../../src/services/apple-jws-verifier';

// DER for OID 1.2.840.113635.100.6.11.1 as it appears inside a certificate.
const APP_STORE_OID = Buffer.from([
  0x06, 0x0a, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x63, 0x64, 0x06, 0x0b, 0x01,
]);

function certificateBytes(options: { withAppStoreOid: boolean }): Buffer {
  const filler = Buffer.from('30820123a0030201020208', 'hex');
  return options.withAppStoreOid
    ? Buffer.concat([filler, APP_STORE_OID, Buffer.from('0500', 'hex')])
    : Buffer.concat([filler, Buffer.from('06035504030c0a4e6f742041707073', 'hex')]);
}

describe('apple JWS leaf policy (QA5 P2)', () => {
  it('accepts a genuine App Store end-entity leaf', () => {
    expect(() => assertAppleAppStoreLeaf({
      ca: false,
      raw: certificateBytes({ withAppStoreOid: true }),
    })).not.toThrow();
  });

  it('refuses a CA certificate signing transactions directly', () => {
    expect(() => assertAppleAppStoreLeaf({
      ca: true,
      raw: certificateBytes({ withAppStoreOid: true }),
    })).toThrow('APPLE_JWS_LEAF_NOT_END_ENTITY');
  });

  it('refuses a sibling Apple-rooted certificate that is not an App Store signer', () => {
    expect(() => assertAppleAppStoreLeaf({
      ca: false,
      raw: certificateBytes({ withAppStoreOid: false }),
    })).toThrow('APPLE_JWS_LEAF_NOT_APP_STORE');
  });
});
