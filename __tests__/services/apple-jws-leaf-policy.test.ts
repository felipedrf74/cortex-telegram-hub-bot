// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * QA5 P2 (jws-no-leaf-purpose-check): chaining to Apple Root CA G3 is not
 * proof that a certificate is an App Store notification signer. That root
 * signs certificates for every Apple developer, so the verifier also accepted
 * a sibling end-entity certificate and an intermediate CA signing directly.
 *
 * QA6 P2: the marker check was `raw.includes(oidDer)` — a byte search over the
 * whole certificate that could not tell the marker EXTENSION from the same
 * bytes appearing anywhere else, and accepted buffers that were not
 * certificates at all. These fixtures are therefore built as real DER:
 * Certificate -> TBSCertificate -> [3] extensions -> Extension -> extnID.
 */

import { describe, expect, it } from 'vitest';
import { assertAppleAppStoreLeaf } from '../../src/services/apple-jws-verifier';

const SEQUENCE = 0x30;
const OID = 0x06;
const INTEGER = 0x02;
const OCTET_STRING = 0x04;
const EXTENSIONS_TAG = 0xa3;

/** OID 1.2.840.113635.100.6.11.1 content bytes (no tag, no length). */
const APP_STORE_OID_CONTENT = Buffer.from([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x63, 0x64, 0x06, 0x0b, 0x01]);
/** OID 2.5.29.19 (basicConstraints) — a plausible non-marker extension. */
const BASIC_CONSTRAINTS_OID_CONTENT = Buffer.from([0x55, 0x1d, 0x13]);

/** Encode one DER tag-length-value with a correct definite length. */
function der(tag: number, content: Buffer): Buffer {
  let header: Buffer;
  if (content.length < 0x80) {
    header = Buffer.from([tag, content.length]);
  } else {
    const lengthBytes: number[] = [];
    let remaining = content.length;
    while (remaining > 0) {
      lengthBytes.unshift(remaining & 0xff);
      remaining = Math.floor(remaining / 256);
    }
    header = Buffer.from([tag, 0x80 | lengthBytes.length, ...lengthBytes]);
  }
  return Buffer.concat([header, content]);
}

function extension(oidContent: Buffer): Buffer {
  return der(SEQUENCE, Buffer.concat([
    der(OID, oidContent),
    der(OCTET_STRING, Buffer.from([0x05, 0x00])),
  ]));
}

/**
 * A structurally valid certificate skeleton: enough real DER for the parser to
 * walk, with the extension list under control of the test.
 */
function certificate(options: {
  extensionOids?: Buffer[];
  /** Bytes smuggled into an opaque field, never into the extension list. */
  smuggled?: Buffer;
}): Buffer {
  const serial = options.smuggled
    ? der(INTEGER, options.smuggled)
    : der(INTEGER, Buffer.from([0x01, 0x02, 0x03, 0x04]));
  const fields: Buffer[] = [serial, der(SEQUENCE, Buffer.alloc(0))];
  if (options.extensionOids) {
    fields.push(der(EXTENSIONS_TAG, der(SEQUENCE, Buffer.concat(options.extensionOids.map(extension)))));
  }
  const tbs = der(SEQUENCE, Buffer.concat(fields));
  return der(SEQUENCE, Buffer.concat([tbs, der(SEQUENCE, Buffer.alloc(0))]));
}

describe('apple JWS leaf policy (QA5 P2, QA6 P2)', () => {
  it('accepts a genuine App Store end-entity leaf', () => {
    expect(() => assertAppleAppStoreLeaf({
      ca: false,
      raw: certificate({ extensionOids: [BASIC_CONSTRAINTS_OID_CONTENT, APP_STORE_OID_CONTENT] }),
    })).not.toThrow();
  });

  it('refuses a CA certificate signing transactions directly', () => {
    expect(() => assertAppleAppStoreLeaf({
      ca: true,
      raw: certificate({ extensionOids: [APP_STORE_OID_CONTENT] }),
    })).toThrow('APPLE_JWS_LEAF_NOT_END_ENTITY');
  });

  it('refuses a sibling Apple-rooted certificate that is not an App Store signer', () => {
    expect(() => assertAppleAppStoreLeaf({
      ca: false,
      raw: certificate({ extensionOids: [BASIC_CONSTRAINTS_OID_CONTENT] }),
    })).toThrow('APPLE_JWS_LEAF_NOT_APP_STORE');
  });

  it('refuses a certificate carrying the marker bytes outside the extension list (QA6 P2)', () => {
    // The exact defect: the OID's bytes present in an opaque field, with no
    // App Store marker extension. A byte search accepted this.
    const smuggled = Buffer.concat([
      Buffer.from([OID, APP_STORE_OID_CONTENT.length]),
      APP_STORE_OID_CONTENT,
    ]);
    expect(() => assertAppleAppStoreLeaf({
      ca: false,
      raw: certificate({ extensionOids: [BASIC_CONSTRAINTS_OID_CONTENT], smuggled }),
    })).toThrow('APPLE_JWS_LEAF_NOT_APP_STORE');
  });

  it('refuses a certificate with no extension list at all', () => {
    expect(() => assertAppleAppStoreLeaf({ ca: false, raw: certificate({}) }))
      .toThrow('APPLE_JWS_LEAF_NOT_APP_STORE');
  });

  it('refuses a buffer that is not a certificate, even if it contains the OID', () => {
    const notACertificate = Buffer.concat([
      Buffer.from('not der at all '),
      Buffer.from([OID, APP_STORE_OID_CONTENT.length]),
      APP_STORE_OID_CONTENT,
    ]);
    expect(() => assertAppleAppStoreLeaf({ ca: false, raw: notACertificate }))
      .toThrow('APPLE_JWS_LEAF_NOT_APP_STORE');
  });

  it('refuses a buffer too short to hold any DER node', () => {
    expect(() => assertAppleAppStoreLeaf({ ca: false, raw: Buffer.alloc(1) }))
      .toThrow('APPLE_JWS_LEAF_NOT_APP_STORE');
  });

  it('refuses a certificate whose TBSCertificate is not a SEQUENCE', () => {
    // Outer SEQUENCE parses, inner field does not: the walk must stop rather
    // than treat the malformed body as an empty extension list.
    const bogusTbs = der(SEQUENCE, Buffer.concat([
      der(INTEGER, Buffer.from([0x01])),
      der(SEQUENCE, Buffer.alloc(0)),
    ]));
    expect(() => assertAppleAppStoreLeaf({ ca: false, raw: bogusTbs }))
      .toThrow('APPLE_JWS_LEAF_NOT_APP_STORE');
  });

  it('refuses a certificate with a declared length running past the buffer', () => {
    // Long-form length claiming more bytes than exist.
    const overlong = Buffer.from([SEQUENCE, 0x82, 0xff, 0xff, 0x01, 0x02]);
    expect(() => assertAppleAppStoreLeaf({ ca: false, raw: overlong }))
      .toThrow('APPLE_JWS_LEAF_NOT_APP_STORE');
  });

  it('refuses a truncated certificate rather than reading past its end', () => {
    const truncated = certificate({ extensionOids: [APP_STORE_OID_CONTENT] }).subarray(0, 12);
    expect(() => assertAppleAppStoreLeaf({ ca: false, raw: truncated }))
      .toThrow('APPLE_JWS_LEAF_NOT_APP_STORE');
  });
});
