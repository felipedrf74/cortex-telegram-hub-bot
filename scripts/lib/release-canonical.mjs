import { createHash } from 'node:crypto';

/**
 * Deterministic primitives shared by the continuous-deployment release path.
 *
 * Release evidence is signed, digested, and compared across three hosts (the
 * hosted builder, the VPS poller, and the Pi audit mirror), so every byte-level
 * comparison must be reproducible from the value alone. These helpers are
 * deliberately dependency-free: the VPS poller runs them from a root-owned
 * checkout with no `node_modules` present.
 */

export function fail(message) {
  throw new Error(message);
}

/** RFC 8785-style ordering: object keys sorted, no incidental whitespace. */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`;
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function sha256Canonical(value) {
  return sha256(canonicalJson(value));
}

/**
 * Reject unknown and missing fields together. Signed release evidence must not
 * grow silent fields: an unexpected key is treated as tampering, not as a
 * forward-compatible extension.
 */
export function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  if (canonicalJson(actual) !== canonicalJson([...expected].sort())) {
    fail(`${label} fields do not match the governed schema`);
  }
  return value;
}

export const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

export function assertCanonicalTimestamp(value, label) {
  if (typeof value !== 'string'
      || !CANONICAL_TIMESTAMP.test(value)
      || !Number.isFinite(Date.parse(value))) {
    fail(`${label} is not a canonical UTC timestamp`);
  }
  return value;
}

export const FULL_SHA = /^[0-9a-f]{40}$/;
export const OCI_DIGEST = /^sha256:[0-9a-f]{64}$/;
export const HEX_SHA256 = /^[0-9a-f]{64}$/;
export const POSITIVE_INTEGER_STRING = /^[1-9][0-9]*$/;

export function assertFullSha(value, label) {
  if (typeof value !== 'string' || !FULL_SHA.test(value)) {
    fail(`${label} is not a full lowercase git SHA`);
  }
  return value;
}

export function assertOciDigest(value, label) {
  if (typeof value !== 'string' || !OCI_DIGEST.test(value)) {
    fail(`${label} is not a sha256 OCI digest`);
  }
  return value;
}

export function assertHexSha256(value, label) {
  if (typeof value !== 'string' || !HEX_SHA256.test(value)) {
    fail(`${label} is not a lowercase hex SHA-256`);
  }
  return value;
}

export function assertPositiveIntegerString(value, label) {
  if (!POSITIVE_INTEGER_STRING.test(String(value ?? ''))) {
    fail(`${label} is not a positive integer`);
  }
  return String(value);
}
