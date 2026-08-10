// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type Database from 'better-sqlite3';

export const RELEASE_DATA_MAINTENANCE_SCHEMA = 'nexus.release-data-maintenance.v1';
export const RELEASE_DATA_MAINTENANCE_KEY_PREFIX = 'release_data_maintenance:';

const RELEASE_ID = /^[0-9a-f]{32}$/;
const SOURCE_SHA = /^[0-9a-f]{40}$/;
const OCI_DIGEST = /^sha256:[0-9a-f]{64}$/;

export interface ReleaseDataMaintenanceIdentity {
  releaseId: string;
  sourceSha: string;
  backendImageDigest: string;
}

function requireIdentityField(
  value: unknown,
  pattern: RegExp,
  label: string,
): string {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(`${label} is missing or malformed`);
  }
  return value;
}

export function assertReleaseDataMaintenanceIdentity(
  identity: ReleaseDataMaintenanceIdentity,
): ReleaseDataMaintenanceIdentity {
  return {
    releaseId: requireIdentityField(identity?.releaseId, RELEASE_ID, 'release data-maintenance release ID'),
    sourceSha: requireIdentityField(identity?.sourceSha, SOURCE_SHA, 'release data-maintenance source SHA'),
    backendImageDigest: requireIdentityField(
      identity?.backendImageDigest,
      OCI_DIGEST,
      'release data-maintenance backend image digest',
    ),
  };
}

export function releaseDataMaintenanceIdentityFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): ReleaseDataMaintenanceIdentity {
  return assertReleaseDataMaintenanceIdentity({
    releaseId: env.NEXUS_RELEASE_ID ?? '',
    sourceSha: env.NEXUS_RELEASE_SOURCE_SHA ?? '',
    backendImageDigest: env.NEXUS_RELEASE_BACKEND_DIGEST ?? '',
  });
}

export function recordReleaseDataMaintenanceCompletion(
  database: Database.Database,
  identityInput: ReleaseDataMaintenanceIdentity,
  completedAt: string = new Date().toISOString(),
): void {
  const identity = assertReleaseDataMaintenanceIdentity(identityInput);
  if (Number.isNaN(Date.parse(completedAt)) || new Date(completedAt).toISOString() !== completedAt) {
    throw new Error('release data-maintenance completion timestamp is not canonical UTC');
  }

  const key = `${RELEASE_DATA_MAINTENANCE_KEY_PREFIX}${identity.releaseId}`;
  const value = JSON.stringify({
    schema: RELEASE_DATA_MAINTENANCE_SCHEMA,
    releaseId: identity.releaseId,
    sourceSha: identity.sourceSha,
    backendImageDigest: identity.backendImageDigest,
    completedAt,
  });
  // Migration 028 is part of the legacy and target ledgers at first-container
  // bootstrap. INSERT-only publication keeps candidate and predecessor receipts
  // independently addressable; a mutable "last completed" key is forbidden.
  database.prepare(`
    INSERT INTO kv_store (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO NOTHING
  `).run(key, value);

  assertReleaseDataMaintenanceComplete(database, identity);
}

export function assertReleaseDataMaintenanceComplete(
  database: Database.Database,
  identityInput: ReleaseDataMaintenanceIdentity,
): void {
  const identity = assertReleaseDataMaintenanceIdentity(identityInput);
  const key = `${RELEASE_DATA_MAINTENANCE_KEY_PREFIX}${identity.releaseId}`;
  let row: { value: string } | undefined;
  try {
    row = database.prepare('SELECT value FROM kv_store WHERE key = ?').get(key) as typeof row;
  } catch {
    throw new Error(
      'release data-maintenance completion ledger is absent; run the exact release migrator before application boot',
    );
  }

  let receipt: {
    schema?: unknown;
    releaseId?: unknown;
    sourceSha?: unknown;
    backendImageDigest?: unknown;
    completedAt?: unknown;
    [key: string]: unknown;
  } | null = null;
  try {
    const parsed = JSON.parse(row?.value ?? '');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      receipt = parsed;
    }
  } catch {
    receipt = null;
  }
  const canonicalValue = receipt ? JSON.stringify({
    schema: receipt.schema,
    releaseId: receipt.releaseId,
    sourceSha: receipt.sourceSha,
    backendImageDigest: receipt.backendImageDigest,
    completedAt: receipt.completedAt,
  }) : null;
  const completedAt = typeof receipt?.completedAt === 'string' ? receipt.completedAt : '';
  if (
    !row
    || !receipt
    || Object.keys(receipt).sort().join(',')
      !== 'backendImageDigest,completedAt,releaseId,schema,sourceSha'
    || row.value !== canonicalValue
    || receipt.releaseId !== identity.releaseId
    || receipt.backendImageDigest !== identity.backendImageDigest
    || receipt.sourceSha !== identity.sourceSha
    || receipt.schema !== RELEASE_DATA_MAINTENANCE_SCHEMA
    || Number.isNaN(Date.parse(completedAt))
    || new Date(completedAt).toISOString() !== completedAt
  ) {
    throw new Error(
      `release data maintenance is incomplete for ${identity.releaseId} at ${identity.backendImageDigest}`,
    );
  }
}
