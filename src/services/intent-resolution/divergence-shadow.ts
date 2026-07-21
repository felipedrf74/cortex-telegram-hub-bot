// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Milestone 4 — resolver-vs-surface divergence telemetry (shadow only).
 *
 * Builds a privacy-safe record comparing the deterministic manifest resolver's
 * top candidate with what the live routing surfaces decide for the same text.
 * The record is merged additively into the shadow-route replay contextPack by
 * the (flag-gated) Chat Core v2 shadow route hook. It contains capability /
 * domain / skill identifiers and counts only — never raw message text and
 * never matched-evidence strings.
 *
 * NEVER on the live decision path: the caller wraps this in try/catch and any
 * throw here degrades to "no divergence telemetry", not a changed response.
 */

import { keywordMatch } from '../../router/classifier';
import { analyzeChatSkillOrchestration } from '../chat-skill-orchestrator';
import { selectRegistrySubsetForMessage } from '../chat/registry';
import { resolveIntent, INTENT_RESOLVER_VERSION, type IntentCandidate } from './intent-resolver';

export const ROUTING_DIVERGENCE_SHADOW_VERSION = 'routing_divergence_shadow@1.0.0';

/**
 * Chat Core v2 domain space → legacy runtime domain space. Exported so the
 * M20 route-exit sampler derives its legacy-vs-v2 comparison with the same
 * mapping this record was built with.
 */
export const V2_TO_LEGACY_DOMAIN: Record<string, string> = {
  secretary: 'secretary',
  tasks: 'secretary',
  training: 'triathlon',
  content: 'content',
  cooking: 'cooking',
  finance: 'finance',
  connections: 'connections',
  notifications: 'notifications',
  decision_center: 'decision_center',
};

/** Granular Chat action-skill space → legacy runtime domain space. */
const ACTION_SKILL_TO_LEGACY_DOMAIN: Record<string, string> = {
  secretary_calendar: 'secretary',
  secretary_reminders: 'secretary',
  mail: 'secretary',
  tasks: 'secretary',
  training: 'triathlon',
  content: 'content',
  cooking: 'cooking',
  finance: 'finance',
  connections: 'connections',
  notifications: 'notifications',
  decision_center: 'decision_center',
};

export interface RoutingDivergenceShadowRecord {
  divergenceVersion: string;
  resolverVersion: string;
  topCandidate: {
    capabilityId: string;
    domain: string;
    skill: string;
    rawScore: number;
    matchedEvidenceCount: number;
  } | null;
  candidateCount: number;
  surfaces: {
    classifierKeywordDomain: string | null;
    orchestratorPrimaryDomain: string | null;
    registryActionSkills: string[];
    shadowRouteIntent: string;
    shadowRouteDomains: string[];
  };
  agreement: {
    /** null = the surface produced no decision to compare against. */
    classifierKeyword: boolean | null;
    orchestratorPrimary: boolean | null;
    registrySubset: boolean | null;
    shadowRoute: boolean | null;
  };
}

export interface RoutingDivergenceShadowDeps {
  resolveIntent?: (text: string) => IntentCandidate[];
  keywordMatch?: (text: string) => string | null;
  orchestratorPrimaryDomain?: (text: string) => string | null;
  registryActionSkills?: (text: string) => string[];
}

export function buildRoutingDivergenceShadowRecord(
  text: string,
  shadowGuess: { intent: string; domains: readonly string[] },
  deps: RoutingDivergenceShadowDeps = {},
): RoutingDivergenceShadowRecord {
  const resolve = deps.resolveIntent ?? resolveIntent;
  const candidates = resolve(text);
  const top = candidates[0] ?? null;

  const classifierKeywordDomain = (deps.keywordMatch ?? keywordMatch)(text);
  const orchestratorPrimaryDomain = deps.orchestratorPrimaryDomain
    ? deps.orchestratorPrimaryDomain(text)
    : analyzeChatSkillOrchestration({ message: text }).primaryDomain;
  const registryActionSkills = deps.registryActionSkills
    ? deps.registryActionSkills(text)
    : [...new Set(selectRegistrySubsetForMessage(text).map((entry) => entry.skill))];
  const shadowRouteDomains = [...shadowGuess.domains];

  const registryDomains = new Set(
    registryActionSkills.map((skill) => ACTION_SKILL_TO_LEGACY_DOMAIN[skill] ?? skill),
  );
  const shadowLegacyDomains = new Set(
    shadowRouteDomains.map((domain) => V2_TO_LEGACY_DOMAIN[domain] ?? domain),
  );

  return {
    divergenceVersion: ROUTING_DIVERGENCE_SHADOW_VERSION,
    resolverVersion: INTENT_RESOLVER_VERSION,
    topCandidate: top
      ? {
        capabilityId: top.capabilityId,
        domain: top.domain,
        skill: top.skill,
        rawScore: top.rawScore,
        matchedEvidenceCount: top.matchedEvidence.length,
      }
      : null,
    candidateCount: candidates.length,
    surfaces: {
      classifierKeywordDomain,
      orchestratorPrimaryDomain: orchestratorPrimaryDomain ?? null,
      registryActionSkills,
      shadowRouteIntent: shadowGuess.intent,
      shadowRouteDomains,
    },
    agreement: {
      classifierKeyword: classifierKeywordDomain === null || top === null
        ? null
        : top.domain === classifierKeywordDomain,
      orchestratorPrimary: !orchestratorPrimaryDomain || top === null
        ? null
        : top.domain === orchestratorPrimaryDomain,
      registrySubset: registryDomains.size === 0 || top === null
        ? null
        : registryDomains.has(top.domain),
      shadowRoute: shadowLegacyDomains.size === 0 || top === null
        ? null
        : shadowLegacyDomains.has(top.domain),
    },
  };
}
