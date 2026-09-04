// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * The identity of the release the current process is actually serving.
 *
 * `scripts/remote-user-release-transaction.sh` exports the verified runtime SHA,
 * artifact digest, and role into the PM2 environment, and
 * `ecosystem.release.config.js` forwards them to the app. Evidence that claims
 * to describe a deployed candidate must be bound to THESE values rather than to
 * whatever the operator happens to have checked out locally: a clean local
 * checkout proves the operator's tree is tidy, not that the server under test
 * is running those bytes.
 *
 * Reads fail closed. The ecosystem config substitutes the literal `unknown`
 * when the release transaction supplied nothing, so an unattested process must
 * never be mistaken for an attested one.
 */

const FULL_RUNTIME_SHA = /^[0-9a-f]{40}$/;
const FULL_ARTIFACT_DIGEST = /^[0-9a-f]{64}$/;
const RELEASE_ROLES = new Set(['staging', 'production']);

export type ReleaseRole = 'staging' | 'production';

export interface DeployedReleaseIdentity {
  runtimeSha: string;
  artifactDigest: string;
  role: ReleaseRole;
}

export function readDeployedReleaseIdentity(
  env: Readonly<Record<string, string | undefined>> = process.env,
): DeployedReleaseIdentity | null {
  // The PM2 release transaction exports NEXUS_RELEASE_SHA / _ARTIFACT_SHA256 /
  // _ROLE; the continuous-deployment Compose projects export the same facts as
  // NEXUS_RELEASE_SOURCE_SHA / _BACKEND_DIGEST ("sha256:<hex>") /
  // _ENVIRONMENT. Either spelling must attest the process; validation is identical.
  const runtimeSha = ((env.NEXUS_RELEASE_SHA ?? '').trim() || (env.NEXUS_RELEASE_SOURCE_SHA ?? '').trim());
  const artifactDigest = ((env.NEXUS_RELEASE_ARTIFACT_SHA256 ?? '').trim()
    || (env.NEXUS_RELEASE_BACKEND_DIGEST ?? '').trim().replace(/^sha256:/i, ''));
  const role = ((env.NEXUS_RELEASE_ROLE ?? '').trim() || (env.NEXUS_RELEASE_ENVIRONMENT ?? '').trim());

  if (!FULL_RUNTIME_SHA.test(runtimeSha)) return null;
  if (!FULL_ARTIFACT_DIGEST.test(artifactDigest)) return null;
  if (!RELEASE_ROLES.has(role)) return null;

  return { runtimeSha, artifactDigest, role: role as ReleaseRole };
}
