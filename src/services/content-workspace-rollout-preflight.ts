// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import Database from 'better-sqlite3';
import fs from 'fs';
import {
  resolveContentWorkspaceCapabilities,
} from './content-workspace-capabilities';

type Environment = Record<string, string | undefined>;

export interface ContentWorkspaceRolloutPreflightStatus {
  ok: boolean;
  ownerCount: number;
  errors: readonly string[];
}

const WRITE_SLICE_KEYS = [
  'CONTENT_WORKSPACE_V1_CORE_WRITES',
  'CONTENT_WORKSPACE_V1_REVISION_WRITES',
  'CONTENT_WORKSPACE_V1_LINEAGE_WRITES',
  'CONTENT_WORKSPACE_V1_AGENT_WRITES',
  'CONTENT_WORKSPACE_V1_SCHEDULE_WRITES',
  'CONTENT_WORKSPACE_V1_RECOVERY_WRITES',
] as const;

function parseStrictBoolean(raw: string | undefined): boolean | null {
  if (raw == null || raw.trim() === '') return false;
  const normalized = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return null;
}

function parsePositiveIds(raw: string | undefined): { values: Set<number>; valid: boolean } {
  const values = new Set<number>();
  const entries = (raw ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
  for (const entry of entries) {
    if (!/^[1-9][0-9]*$/.test(entry)) return { values, valid: false };
    const value = Number(entry);
    if (!Number.isSafeInteger(value)) return { values, valid: false };
    values.add(value);
  }
  return { values, valid: true };
}

/**
 * Fail-closed release check for the first production Content workspace cutover.
 * It reads only aggregate owner/cohort state and never returns identifiers or
 * environment values. Runtime kill switches remain independent after rollout;
 * this gate is invoked only when the release introduces the canonical domain.
 */
export function getContentWorkspaceRolloutPreflightStatus(options: {
  dbPath: string;
  env?: Environment;
}): ContentWorkspaceRolloutPreflightStatus {
  const env = options.env ?? process.env;
  const errors: string[] = [];
  const userIds = parsePositiveIds(env.CONTENT_WORKSPACE_V1_USER_IDS);
  const tenantIds = parsePositiveIds(env.CONTENT_WORKSPACE_V1_TENANT_IDS);
  const globalWrite = parseStrictBoolean(env.CONTENT_WORKSPACE_V1_GLOBAL_WRITE);

  if ((env.CONTENT_WORKSPACE_V1_MODE ?? '').trim().toLowerCase() !== 'write') {
    errors.push('mode_not_write');
  }
  if (globalWrite === null) errors.push('global_write_invalid');
  else if (globalWrite) errors.push('global_write_not_scoped');
  if (!userIds.valid) errors.push('user_cohort_invalid');
  if (!tenantIds.valid) errors.push('tenant_cohort_invalid');
  for (const key of WRITE_SLICE_KEYS) {
    if (parseStrictBoolean(env[key]) !== true) errors.push('write_slice_disabled_or_invalid');
  }

  let ownerRows: Array<{ id: number; status: string }> = [];
  if (!fs.existsSync(options.dbPath)) {
    errors.push('database_missing');
  } else {
    try {
      const db = new Database(options.dbPath, { readonly: true, fileMustExist: true });
      try {
        ownerRows = db.prepare(`
          SELECT id, status
          FROM users
          WHERE tier = 'owner'
          ORDER BY id ASC
        `).all() as Array<{ id: number; status: string }>;
      } finally {
        db.close();
      }
    } catch {
      errors.push('owner_query_failed');
    }
  }

  const owner = ownerRows[0];
  if (ownerRows.length !== 1) errors.push('owner_count_not_one');
  if (!owner) {
    errors.push('owner_missing');
  } else {
    if (owner.status !== 'active') errors.push('owner_not_active');
    if (!userIds.values.has(owner.id) && !tenantIds.values.has(owner.id)) {
      errors.push('owner_not_enrolled');
    }
    const capabilities = resolveContentWorkspaceCapabilities(
      { userId: owner.id, tenantId: owner.id },
      { env, nodeEnv: 'production' },
    );
    if (capabilities.reasonCode !== 'available'
      || !Object.values(capabilities.writes).every(Boolean)) {
      errors.push('owner_write_capabilities_incomplete');
    }
  }

  return Object.freeze({
    ok: errors.length === 0,
    ownerCount: ownerRows.length,
    errors: Object.freeze([...new Set(errors)]),
  });
}
