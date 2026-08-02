// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Milestone 12 — per-surface activation flags for manifest-driven routing.
 *
 * Each of the four legacy routing surfaces (router/classifier keywordMatch,
 * chat-skill-orchestrator, chat-core-v2 shadow-route-classifier, chat action
 * registry subset selection) gets its own opt-in flag so convergence onto the
 * shared manifest resolver can be rolled out (and rolled back) one surface at
 * a time. Follows the activation-flags pattern (env-driven, EnvLike parameter,
 * deterministic parsing). Only side effect: a one-time boot log of the
 * resolved flag state when any flag is on (silent when all are off).
 *
 * Defaults: every flag OFF → byte-identical legacy behavior.
 * Master kill: AI_ROUTING_MANIFEST_KILL=true forces every surface off and
 * always wins over per-surface flags (mirrors the chat-core-v2 kill-switch
 * precedence rule: a kill can only ever ADD an off, never remove one).
 */

import { logger } from '../../utils/logger';
import { chatCapabilityRuntimeAllowsFlags } from '../chat-capability-runtime-guard';

export type ManifestRoutingSurface = 'classifier' | 'orchestrator' | 'shadow' | 'registry';

type EnvLike = Record<string, string | undefined>;

const SURFACE_ENV_VAR: Record<ManifestRoutingSurface, string> = {
  classifier: 'AI_ROUTING_MANIFEST_CLASSIFIER',
  orchestrator: 'AI_ROUTING_MANIFEST_ORCHESTRATOR',
  shadow: 'AI_ROUTING_MANIFEST_SHADOW',
  registry: 'AI_ROUTING_MANIFEST_REGISTRY',
};

export const MANIFEST_ROUTING_MASTER_KILL_ENV_VAR = 'AI_ROUTING_MANIFEST_KILL';

function parseBoolean(raw: string | undefined): boolean {
  const normalized = String(raw ?? '').trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes';
}

// ─── One-time boot observability (M12 flag-state log) ─────────────
//
// The first isManifestRoutingEnabled call that observes ANY per-surface flag
// set logs the resolved flag state once (including when the master kill
// suppresses it). All-off stays completely silent, preserving the module's
// zero-noise default.

let bootFlagStateLogged = false;

/** Test hook: re-arm the one-time boot log. */
export function _resetManifestRoutingBootLogForTests(): void {
  bootFlagStateLogged = false;
}

function logBootFlagStateOnce(env: EnvLike): void {
  if (bootFlagStateLogged) return;
  const enabledSurfaces = (Object.keys(SURFACE_ENV_VAR) as ManifestRoutingSurface[])
    .filter((surface) => parseBoolean(env[SURFACE_ENV_VAR[surface]]));
  if (enabledSurfaces.length === 0) return;
  bootFlagStateLogged = true;
  const masterKill = parseBoolean(env[MANIFEST_ROUTING_MASTER_KILL_ENV_VAR]);
  logger.info(
    { enabledSurfaces, masterKill, suppressed: masterKill },
    masterKill
      ? 'manifest routing flags requested but suppressed by master kill'
      : 'manifest routing flags enabled',
  );
}

/**
 * Whether the given surface should consume the shared manifest resolver.
 * Default-off; the master kill flag wins over any per-surface enable.
 */
export function isManifestRoutingEnabled(
  surface: ManifestRoutingSurface,
  env: EnvLike = process.env,
): boolean {
  logBootFlagStateOnce(env);
  if (!chatCapabilityRuntimeAllowsFlags()) return false;
  if (parseBoolean(env[MANIFEST_ROUTING_MASTER_KILL_ENV_VAR])) return false;
  return parseBoolean(env[SURFACE_ENV_VAR[surface]]);
}

/** Env var name for a surface (used by ops tooling / tests). */
export function manifestRoutingEnvVarForSurface(surface: ManifestRoutingSurface): string {
  return SURFACE_ENV_VAR[surface];
}
