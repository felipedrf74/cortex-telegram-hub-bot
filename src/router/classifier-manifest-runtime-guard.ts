// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * M15 adversarial fix — hard runtime guard for the manifest classifier
 * prompt flag (AI_CLASSIFY_MANIFEST_PROMPT).
 *
 * The M15 flag-flip blockers are documented and test-pinned
 * (__tests__/services/chat-manifest-newly-reachable-skill-execution.test.ts):
 *   1. registry actions reachable through the manifest prompt with NO step
 *      executor (draft_email / send_email / connections_retry_sync) — a turn
 *      routed there dead-ends in 'blocked';
 *   2. NL-reachable manifest domains with NO legacy domain handler
 *      (connections / notifications / decision_center) — a classifier turn
 *      that misses the planner stages reaches the legacy tail and returns
 *      UNKNOWN_DOMAIN.
 *
 * Documentation alone cannot stop an operator from flipping the env flag, so
 * this guard runs at process startup (same boot window as
 * assertOwnerBootstrapReadyForRuntime): when the flag is requested ON while
 * either gap class is still open, it FORCE-DISABLES the flag for the process
 * (process-level override consulted by isManifestClassifierPromptEnabled)
 * and records a deduped operator alert instead of serving a routing surface
 * whose targets cannot execute.
 *
 * Zero cost flag-off: when the flag is not requested, the guard returns
 * before performing any manifest, dispatch-table, or domain-handler lookup.
 */

import { logger } from '../utils/logger';
import {
  forceDisableManifestClassifierPromptForProcess,
  getNlReachableCapabilities,
  isManifestClassifierPromptEnabled,
} from './classifier-prompt-builder';
import { getChatStepExecutor } from '../services/chat/executor/dispatch-table';
import { getChatDomainHandler } from '../api/routes/chat-message-context';
import { recordOperatorAlert } from '../services/operator-alerts';

/**
 * Registry actions the manifest prompt makes NL-reachable that MUST have a
 * step executor before the flag may serve traffic. Kept in sync with the
 * pinned "known execution gaps" test.
 */
export const MANIFEST_PROMPT_REQUIRED_STEP_EXECUTOR_ACTIONS = [
  'draft_email',
  'send_email',
  'connections_retry_sync',
] as const;

export interface ManifestClassifierRuntimeGuardDeps {
  env?: Record<string, string | undefined>;
  /** Injectable for tests — defaults to the real executor dispatch table. */
  getStepExecutor?: (action: string) => unknown;
  /** Injectable for tests — defaults to the real legacy domain-handler map. */
  getDomainHandler?: (domain: string) => unknown;
  /** Injectable for tests — defaults to the real NL-reachable manifest domains. */
  listNlReachableDomains?: () => string[];
}

export interface ManifestClassifierRuntimeGuardResult {
  /** Whether the env requested the flag on at all. */
  flagRequested: boolean;
  /** Whether the guard force-disabled the flag for this process. */
  forcedOff: boolean;
  /** Stable gap descriptors ('missing_step_executor:…' / 'missing_domain_handler:…'). */
  gaps: string[];
}

export const MANIFEST_CLASSIFIER_GUARD_ALERT_DEDUPE_KEY = 'manifest_classifier_prompt_force_disabled';

function defaultListNlReachableDomains(): string[] {
  return [...new Set(
    getNlReachableCapabilities().map((entry) => entry.runtimeRouting.domain),
  )];
}

export function enforceManifestClassifierRuntimeGuard(
  deps: ManifestClassifierRuntimeGuardDeps = {},
): ManifestClassifierRuntimeGuardResult {
  const env = deps.env ?? process.env;
  if (!isManifestClassifierPromptEnabled(env)) {
    return { flagRequested: false, forcedOff: false, gaps: [] };
  }

  const getStepExecutor = deps.getStepExecutor ?? ((action: string) => getChatStepExecutor(action as never));
  const getDomainHandler = deps.getDomainHandler ?? ((domain: string) => getChatDomainHandler(domain));
  const listNlReachableDomains = deps.listNlReachableDomains ?? defaultListNlReachableDomains;

  const gaps: string[] = [];
  for (const action of MANIFEST_PROMPT_REQUIRED_STEP_EXECUTOR_ACTIONS) {
    if (!getStepExecutor(action)) gaps.push(`missing_step_executor:${action}`);
  }
  for (const domain of listNlReachableDomains()) {
    if (!getDomainHandler(domain)) gaps.push(`missing_domain_handler:${domain}`);
  }

  if (gaps.length === 0) {
    return { flagRequested: true, forcedOff: false, gaps };
  }

  forceDisableManifestClassifierPromptForProcess();
  logger.warn(
    { gaps, flag: 'AI_CLASSIFY_MANIFEST_PROMPT' },
    'Manifest classifier prompt force-disabled for this process: flag-flip blockers are still open',
  );
  try {
    recordOperatorAlert({
      severity: 'warning',
      source: 'classifier_manifest_runtime_guard',
      dedupeKey: MANIFEST_CLASSIFIER_GUARD_ALERT_DEDUPE_KEY,
      title: 'AI_CLASSIFY_MANIFEST_PROMPT force-disabled at boot: execution gaps still open',
      detail: gaps.join('; '),
      metadata: { gaps },
      suspectedArea: 'router/classifier-manifest',
      userImpact: 'none (legacy classifier prompt keeps serving); manifest prompt rollout is blocked',
    });
  } catch (err) {
    // The guard must never block boot — the force-disable already happened.
    logger.error({ err }, 'Manifest classifier runtime guard could not record the operator alert');
  }
  return { flagRequested: true, forcedOff: true, gaps };
}
