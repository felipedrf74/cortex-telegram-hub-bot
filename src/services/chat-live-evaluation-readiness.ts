// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import {
  entitlementPlanToSkillTier,
  getEffectiveEntitlement,
  isSkillAllowedByEntitlement,
} from './entitlement';
import {
  ChatLiveEvalContractError,
  type ChatLiveEvalRequestContext,
} from './chat-live-evaluation-contract';
import {
  readDeployedReleaseIdentity,
  type DeployedReleaseIdentity,
} from './release-runtime-identity';
import { checkSkillAccess } from './skill-tiers';

const REAL_PROVIDER_ENTITLEMENT_SOURCES = new Set(['founder', 'apple', 'stripe']);

const REAL_PROVIDER_REQUIRED_PARENT_SKILLS = [
  'secretary',
  'triathlon',
  'content',
  'cooking',
  'finance',
] as const;

const REAL_PROVIDER_REQUIRED_ACTION_SKILLS = [
  'secretary.calendar',
  'secretary.tasks',
  'triathlon',
  'content',
  'cooking',
  'finance',
] as const;

/**
 * Paid evaluation evidence must name the artifact that actually served it.
 * The serving process is the only party that knows its verified deployed
 * identity, so a real-provider run is refused unless this process was started
 * by a release transaction — and, per the runbook, only on staging.
 */
export function assertChatLiveEvalDeployedStagingRelease(
  context: ChatLiveEvalRequestContext,
  env: Readonly<Record<string, string | undefined>> = process.env,
): DeployedReleaseIdentity | null {
  const identity = readDeployedReleaseIdentity(env);
  if (context.mode !== 'real_provider') return identity;

  if (!identity) {
    throw new ChatLiveEvalContractError(
      'CHAT_LIVE_EVAL_DISABLED',
      'Real-provider chat evaluation requires a verified deployed release identity.',
      403,
    );
  }
  if (identity.role !== 'staging') {
    throw new ChatLiveEvalContractError(
      'CHAT_LIVE_EVAL_DISABLED',
      'Real-provider chat evaluation is restricted to a deployed staging release.',
      403,
    );
  }
  return identity;
}

export function assertChatLiveEvalRealProviderReadiness(
  context: ChatLiveEvalRequestContext,
): void {
  assertChatLiveEvalDeployedStagingRelease(context);
  if (context.mode !== 'real_provider') return;

  let ready = false;
  try {
    const entitlement = getEffectiveEntitlement(context.userId);
    const tier = entitlementPlanToSkillTier(entitlement.plan);
    const canonicalPaidAccess = entitlement.userId === context.userId
      && (entitlement.plan === 'pro' || entitlement.plan === 'max')
      && REAL_PROVIDER_ENTITLEMENT_SOURCES.has(entitlement.source)
      && entitlement.aiAccessAllowed === true;
    const parentSkillsReady = canonicalPaidAccess
      && REAL_PROVIDER_REQUIRED_PARENT_SKILLS.every((skillId) =>
        isSkillAllowedByEntitlement(entitlement, skillId),
      );
    const actionSkillsReady = canonicalPaidAccess
      && REAL_PROVIDER_REQUIRED_ACTION_SKILLS.every((skillId) =>
        checkSkillAccess({ id: context.userId, tier }, skillId).allowed,
      );
    ready = canonicalPaidAccess && parentSkillsReady && actionSkillsReady;
  } catch {
    ready = false;
  }

  if (!ready) {
    throw new ChatLiveEvalContractError(
      'CHAT_LIVE_EVAL_DISABLED',
      'Real-provider chat evaluation requires complete dedicated-tenant scenario access.',
      403,
    );
  }
}
