// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { recordContentWorkspaceOperationalOutcome } from './content-workspace-observability';

/**
 * Temporary, server-authoritative rollout contract for the canonical Content
 * workspace. Reads stay available for recovery and export even when a write
 * slice is disabled. Production writes require an explicit global or scoped
 * enrollment; an absent/invalid production mode fails closed to read-only.
 *
 * Removal gate: delete this module and its client seam after canonical parity
 * is verified, compatibility-route traffic is zero for two supported release
 * windows, and the operator kill switch has not been used during that window.
 */

export const CONTENT_WORKSPACE_CAPABILITIES_SCHEMA_VERSION = 'content-workspace-capabilities-v1';

export type ContentWorkspaceRolloutMode = 'off' | 'read_only' | 'recovery_only' | 'write';
export type ContentWorkspaceWriteSlice =
  | 'core'
  | 'revisions'
  | 'lineage'
  | 'agents'
  | 'scheduling'
  | 'restore_deleted_items';

export interface ContentWorkspaceCapabilityScope {
  tenantId: number;
  userId: number;
}

export interface ContentWorkspaceCapabilities {
  schemaVersion: typeof CONTENT_WORKSPACE_CAPABILITIES_SCHEMA_VERSION;
  available: boolean;
  mode: ContentWorkspaceRolloutMode;
  cohortEligible: boolean;
  reasonCode: 'available' | 'disabled_by_operator' | 'read_only' | 'recovery_only' | 'not_enrolled' | 'invalid_mode';
  reads: {
    library: true;
    trash: true;
    revisions: true;
    lineage: true;
    agentJobs: true;
    schedules: true;
  };
  writes: Record<ContentWorkspaceWriteSlice, boolean>;
  publicationExecution: 'not_supported';
  temporaryGate: {
    removalCriteria: readonly string[];
    rollbackContract: 'exact_runtime_and_database_snapshot';
  };
}

/**
 * Typed fail-closed error for non-HTTP callers. The HTTP router blocks the
 * same action before dispatch, while chat, jobs, and cross-skill adapters call
 * the domain services directly and therefore need the identical authority at
 * the service boundary.
 */
export class ContentWorkspaceWriteDisabledError extends Error {
  readonly code = 'CONTENT_WORKSPACE_WRITE_DISABLED';
  readonly status = 503;
  readonly details: {
    capabilitySchemaVersion: typeof CONTENT_WORKSPACE_CAPABILITIES_SCHEMA_VERSION;
    mode: ContentWorkspaceRolloutMode;
    writeSlice: ContentWorkspaceWriteSlice;
    reasonCode: ContentWorkspaceCapabilities['reasonCode'];
    retryable: true;
  };

  constructor(capabilities: ContentWorkspaceCapabilities, slice: ContentWorkspaceWriteSlice) {
    super(slice === 'restore_deleted_items'
      ? 'Content recovery is temporarily unavailable. The deleted item remains preserved in Trash.'
      : 'This Content workspace action is temporarily read-only. Existing content remains available.');
    this.name = 'ContentWorkspaceWriteDisabledError';
    this.details = {
      capabilitySchemaVersion: capabilities.schemaVersion,
      mode: capabilities.mode,
      writeSlice: slice,
      reasonCode: capabilities.reasonCode,
      retryable: true,
    };
  }
}

type Environment = Record<string, string | undefined>;

const VALID_MODES = new Set<ContentWorkspaceRolloutMode>([
  'off',
  'read_only',
  'recovery_only',
  'write',
]);

const SLICE_ENV: Record<ContentWorkspaceWriteSlice, string> = {
  core: 'CONTENT_WORKSPACE_V1_CORE_WRITES',
  revisions: 'CONTENT_WORKSPACE_V1_REVISION_WRITES',
  lineage: 'CONTENT_WORKSPACE_V1_LINEAGE_WRITES',
  agents: 'CONTENT_WORKSPACE_V1_AGENT_WRITES',
  scheduling: 'CONTENT_WORKSPACE_V1_SCHEDULE_WRITES',
  restore_deleted_items: 'CONTENT_WORKSPACE_V1_RECOVERY_WRITES',
};

const REMOVAL_CRITERIA = Object.freeze([
  'canonical_migration_parity_verified',
  'supported_clients_use_capability_contract',
  'compatibility_route_traffic_zero_for_two_supported_release_windows',
  'no_kill_switch_activation_during_observation_window',
  'legacy_routes_and_tables_approved_for_removal',
]);

export function resolveContentWorkspaceCapabilities(
  scope: ContentWorkspaceCapabilityScope,
  options: { env?: Environment; nodeEnv?: string } = {},
): ContentWorkspaceCapabilities {
  const env = options.env ?? process.env;
  const nodeEnv = (options.nodeEnv ?? env.NODE_ENV ?? 'development').trim().toLowerCase();
  const rawMode = env.CONTENT_WORKSPACE_V1_MODE?.trim().toLowerCase();
  const modeIsInvalid = Boolean(rawMode) && !VALID_MODES.has(rawMode as ContentWorkspaceRolloutMode);
  const mode: ContentWorkspaceRolloutMode = modeIsInvalid
    ? 'read_only'
    : (rawMode as ContentWorkspaceRolloutMode | undefined)
      || (nodeEnv === 'production' ? 'read_only' : 'write');

  const cohortEligible = resolveCohortEligibility(scope, mode, env, nodeEnv);
  const canWrite = mode === 'write' && cohortEligible;
  const writes = Object.fromEntries(
    (Object.keys(SLICE_ENV) as ContentWorkspaceWriteSlice[]).map((slice) => [
      slice,
      canWrite && sliceEnabled(env[SLICE_ENV[slice]]),
    ]),
  ) as Record<ContentWorkspaceWriteSlice, boolean>;

  if (mode === 'recovery_only') {
    writes.restore_deleted_items = sliceEnabled(env[SLICE_ENV.restore_deleted_items]);
  }

  const reasonCode: ContentWorkspaceCapabilities['reasonCode'] = modeIsInvalid
    ? 'invalid_mode'
    : mode === 'off'
      ? 'disabled_by_operator'
      : mode === 'read_only'
        ? 'read_only'
        : mode === 'recovery_only'
          ? 'recovery_only'
        : cohortEligible
          ? 'available'
          : 'not_enrolled';

  return {
    schemaVersion: CONTENT_WORKSPACE_CAPABILITIES_SCHEMA_VERSION,
    available: mode !== 'off',
    mode,
    cohortEligible,
    reasonCode,
    reads: {
      library: true,
      trash: true,
      revisions: true,
      lineage: true,
      agentJobs: true,
      schedules: true,
    },
    writes,
    publicationExecution: 'not_supported',
    temporaryGate: {
      removalCriteria: REMOVAL_CRITERIA,
      rollbackContract: 'exact_runtime_and_database_snapshot',
    },
  };
}

/**
 * Enforce rollout authority at the domain boundary so alternate transports
 * cannot bypass the HTTP middleware. Reads never call this helper.
 */
export function assertContentWorkspaceWriteEnabled(
  scope: ContentWorkspaceCapabilityScope,
  slice: ContentWorkspaceWriteSlice,
): void {
  const capabilities = resolveContentWorkspaceCapabilities(scope);
  if (!capabilities.writes[slice]) {
    recordContentWorkspaceOperationalOutcome({
      operation: 'rollout_gate',
      outcome: 'blocked',
      reason: 'rollout_write_disabled',
    });
    throw new ContentWorkspaceWriteDisabledError(capabilities, slice);
  }
}

export function classifyContentWorkspaceWriteSlice(
  method: string,
  requestPath: string,
  requestBody?: unknown,
): ContentWorkspaceWriteSlice | null {
  const normalizedMethod = method.trim().toUpperCase();
  if (normalizedMethod === 'GET' || normalizedMethod === 'HEAD' || normalizedMethod === 'OPTIONS') return null;

  const path = requestPath.split('?')[0].replace(/\/+$/, '');
  const body = requestBody && typeof requestBody === 'object'
    ? requestBody as Record<string, unknown>
    : {};
  // These compatibility generation/learning endpoints conditionally create
  // canonical workspace roots. Classify only the persistence-bearing form so
  // ordinary generation and non-script feedback remain available while the
  // workspace is read-only, but no hidden writer can bypass the kill switch.
  if (/\/content\/discover$/.test(path) || path === '/discover') return 'core';
  if (/\/content\/radar\/workspace-actions$/.test(path) || path === '/radar/workspace-actions') return 'core';
  if ((/\/content\/script$/.test(path) || path === '/script') && body.saveToIdeas === true) return 'core';
  if (/\/content\/variant-feedback$/.test(path) || path === '/variant-feedback') {
    const variantKind = typeof body.variantKind === 'string' && body.variantKind.trim()
      ? body.variantKind.trim().toLowerCase()
      : 'script';
    if (variantKind === 'script' && body.sentiment === 'approved') return 'core';
  }
  // Supported older clients still reach these adapters while rollout is in
  // progress. They now write the same canonical store and must honor the same
  // emergency/cohort authority instead of becoming a kill-switch bypass.
  if (/\/content\/topics(?:\/\d+)?$/.test(path)) return 'core';
  if (/\/content\/agency\/projects\/[^/]+\/handoff$/.test(path)) return 'core';
  if (/\/content\/workflow\/[^/]+\/source-review$/.test(path)) return 'lineage';
  if (/\/content\/workflow\/[^/]+\/(?:actions|approval|repurpose)$/.test(path)) return 'core';
  if (/\/content\/performance$/.test(path)) return 'core';
  if (!path.includes('/workspace/')) return null;
  if (/\/workspace\/items\/\d+\/restore$/.test(path)) return 'restore_deleted_items';
  if (path.includes('/workspace/agent-jobs') || path.includes('/workspace/agent-proposals')) return 'agents';
  if (path.includes('/schedule-previews') || path.endsWith('/schedule-cancel')) return 'scheduling';
  if (
    path.endsWith('/sources')
    || path.endsWith('/lineage')
    || /\/workspace\/sources\/\d+\/assessment$/.test(path)
  ) return 'lineage';
  if (path.includes('/revisions')) return 'revisions';
  return 'core';
}

function resolveCohortEligibility(
  scope: ContentWorkspaceCapabilityScope,
  mode: ContentWorkspaceRolloutMode,
  env: Environment,
  nodeEnv: string,
): boolean {
  if (mode !== 'write') return false;
  if (parseBoolean(env.CONTENT_WORKSPACE_V1_GLOBAL_WRITE) === true) return true;

  const users = parsePositiveIntegerSet(env.CONTENT_WORKSPACE_V1_USER_IDS);
  const tenants = parsePositiveIntegerSet(env.CONTENT_WORKSPACE_V1_TENANT_IDS);
  if (users.has(scope.userId) || tenants.has(scope.tenantId)) return true;

  // Local/test builds remain productive by default. Production always needs
  // an explicit global or scoped enrollment, even if MODE=write is present.
  return nodeEnv !== 'production' && users.size === 0 && tenants.size === 0;
}

function parsePositiveIntegerSet(raw: string | undefined): Set<number> {
  return new Set((raw ?? '')
    .split(',')
    .map((entry) => Number(entry.trim()))
    .filter((value) => Number.isInteger(value) && value > 0));
}

function sliceEnabled(raw: string | undefined): boolean {
  return parseBoolean(raw) !== false;
}

function parseBoolean(raw: string | undefined): boolean | null {
  if (raw == null || !raw.trim()) return null;
  const normalized = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return false;
}
