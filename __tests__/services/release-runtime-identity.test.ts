// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, expect, it } from 'vitest';
import { readDeployedReleaseIdentity } from '../../src/services/release-runtime-identity';

const SHA = 'a'.repeat(40);
const DIGEST = 'b'.repeat(64);

function env(overrides: Record<string, string | undefined> = {}) {
  return {
    NEXUS_RELEASE_SHA: SHA,
    NEXUS_RELEASE_ARTIFACT_SHA256: DIGEST,
    NEXUS_RELEASE_ROLE: 'staging',
    ...overrides,
  };
}

describe('readDeployedReleaseIdentity', () => {
  it('reads the identity the release transaction exports into the process env', () => {
    expect(readDeployedReleaseIdentity(env())).toEqual({
      runtimeSha: SHA,
      artifactDigest: DIGEST,
      role: 'staging',
    });
  });

  it('accepts the production role', () => {
    expect(readDeployedReleaseIdentity(env({ NEXUS_RELEASE_ROLE: 'production' }))?.role).toBe('production');
  });

  it.each([
    ['runtime sha missing', { NEXUS_RELEASE_SHA: undefined }],
    ['runtime sha short', { NEXUS_RELEASE_SHA: 'a'.repeat(39) }],
    ['runtime sha long', { NEXUS_RELEASE_SHA: 'a'.repeat(41) }],
    ['runtime sha uppercase', { NEXUS_RELEASE_SHA: 'A'.repeat(40) }],
    ['runtime sha non-hex', { NEXUS_RELEASE_SHA: 'z'.repeat(40) }],
    ['artifact digest missing', { NEXUS_RELEASE_ARTIFACT_SHA256: undefined }],
    ['artifact digest short', { NEXUS_RELEASE_ARTIFACT_SHA256: 'b'.repeat(63) }],
    ['artifact digest uppercase', { NEXUS_RELEASE_ARTIFACT_SHA256: 'B'.repeat(64) }],
    ['role missing', { NEXUS_RELEASE_ROLE: undefined }],
    ['role unrecognised', { NEXUS_RELEASE_ROLE: 'development' }],
    ['role empty', { NEXUS_RELEASE_ROLE: '' }],
  ])('fails closed when the %s', (_label, overrides) => {
    expect(readDeployedReleaseIdentity(env(overrides))).toBeNull();
  });

  it('rejects the ecosystem placeholder rather than reporting a fake identity', () => {
    // ecosystem.release.config.js substitutes 'unknown' when the release
    // transaction did not supply a value; that must never look attested.
    expect(readDeployedReleaseIdentity(env({ NEXUS_RELEASE_SHA: 'unknown' }))).toBeNull();
    expect(readDeployedReleaseIdentity(env({ NEXUS_RELEASE_ARTIFACT_SHA256: 'unknown' }))).toBeNull();
    expect(readDeployedReleaseIdentity(env({ NEXUS_RELEASE_ROLE: 'unknown' }))).toBeNull();
  });

  it('ignores surrounding whitespace rather than failing a well-formed identity', () => {
    expect(readDeployedReleaseIdentity(env({
      NEXUS_RELEASE_SHA: ` ${SHA} `,
      NEXUS_RELEASE_ROLE: ' staging ',
    }))).toEqual({ runtimeSha: SHA, artifactDigest: DIGEST, role: 'staging' });
  });

  it('returns null for a completely empty environment', () => {
    expect(readDeployedReleaseIdentity({})).toBeNull();
  });
});
