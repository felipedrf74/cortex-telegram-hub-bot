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
 * Every record is self-describing evidence: it carries the attested release
 * identity AND the manifest-routing capability-flag state observed while the
 * comparison was taken, so an offline gate can prove the surface it is about to
 * authorize was still answering with legacy logic at collection time.
 *
 * NEVER on the live decision path: the caller wraps this in try/catch and any
 * throw here degrades to "no divergence telemetry", not a changed response.
 */

import { keywordMatch } from '../../router/classifier';
import { analyzeChatSkillOrchestration } from '../chat-skill-orchestrator';
import { selectRegistrySubsetForMessage } from '../chat/registry';
import { resolveIntent, INTENT_RESOLVER_VERSION, type IntentCandidate } from './intent-resolver';
import {
  isManifestRoutingEnabled,
  MANIFEST_ROUTING_MASTER_KILL_ENV_VAR,
  type ManifestRoutingSurface,
} from './manifest-routing-flags';
import { V2_TO_LEGACY_DOMAIN } from './routing-domain-map';

export { V2_TO_LEGACY_DOMAIN } from './routing-domain-map';

export const ROUTING_DIVERGENCE_SHADOW_VERSION = 'routing_divergence_shadow@4.0.0';

const FULL_RUNTIME_SHA = /^[0-9a-f]{40}$/;
const FULL_ARTIFACT_DIGEST = /^[0-9a-f]{64}$/;
const RELEASE_ROLES = new Set(['staging', 'production']);

/**
 * Divergence surface name → the manifest-routing surface whose capability flag
 * decides whether that surface still answers with legacy logic. A comparison is
 * only evidence about the manifest resolver while the surface's own flag is
 * OFF; with it ON the surface consumes the same resolver and would agree with
 * itself. The gate reader (scripts/routing-divergence-report.mjs) refuses
 * evidence collected with the selected surface's flag enabled, which it can
 * only do because every record carries the state observed at write time.
 */
const DIVERGENCE_SURFACE_TO_MANIFEST_SURFACE: Record<
  keyof Omit<RoutingDivergenceCapabilityFlags, 'masterKill'>, ManifestRoutingSurface
> = {
  classifierKeyword: 'classifier',
  orchestratorPrimary: 'orchestrator',
  registrySubset: 'registry',
  shadowRoute: 'shadow',
};

export interface RoutingDivergenceReleaseIdentity {
  runtimeSha: string;
  artifactDigest: string;
  role: 'staging' | 'production';
}

/**
 * Effective manifest-routing capability state observed for this comparison.
 * Per-surface values already account for the master kill (which forces every
 * surface off); `masterKill` is recorded separately so flag-off evidence
 * manufactured by engaging the kill switch stays distinguishable from a genuine
 * pre-flip observation.
 */
export interface RoutingDivergenceCapabilityFlags {
  classifierKeyword: boolean;
  orchestratorPrimary: boolean;
  registrySubset: boolean;
  shadowRoute: boolean;
  masterKill: boolean;
}

/**
 * Exact dedicated identity and effective recorder/planner state observed by
 * the live hook for this row. These are operational identifiers only; no
 * user-provided text or profile data is recorded.
 */
export interface RoutingDivergenceRecorderState {
  userId: string;
  tenantId: string;
  shadowRouteHookEffective: boolean;
  shadowPlannerEffective: boolean;
}

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
  releaseIdentity: RoutingDivergenceReleaseIdentity;
  capabilityFlags: RoutingDivergenceCapabilityFlags;
  recorderState: RoutingDivergenceRecorderState;
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
  /**
   * Environment the gated inputs (release identity + capability flags) are read
   * from. Defaults to the ambient process environment, which is what the live
   * hook uses; tests inject an explicit environment instead of mutating global
   * state.
   */
  env?: Readonly<Record<string, string | undefined>>;
  /** Effective state supplied by the live hook after evaluating its real scope. */
  recorderState?: RoutingDivergenceRecorderState;
}

export function buildRoutingDivergenceShadowRecord(
  text: string,
  shadowGuess: { intent: string; domains: readonly string[] },
  deps: RoutingDivergenceShadowDeps = {},
): RoutingDivergenceShadowRecord {
  const env = deps.env ?? process.env;
  const resolve = deps.resolveIntent ?? resolveIntent;
  const candidates = resolve(text);
  const top = candidates[0] ?? null;
  const releaseIdentity = readReleaseIdentity(env);
  const capabilityFlags = readCapabilityFlags(env);
  const recorderState = readRecorderState(deps.recorderState);

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
    releaseIdentity,
    capabilityFlags,
    recorderState,
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

function readRecorderState(
  state: RoutingDivergenceRecorderState | undefined,
): RoutingDivergenceRecorderState {
  const canonicalPositiveId = (value: unknown): value is string => {
    if (typeof value !== 'string' || !/^[1-9][0-9]*$/u.test(value)) return false;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && String(parsed) === value;
  };
  if (
    !state
    || !canonicalPositiveId(state.userId)
    || !canonicalPositiveId(state.tenantId)
    || typeof state.shadowRouteHookEffective !== 'boolean'
    || typeof state.shadowPlannerEffective !== 'boolean'
  ) {
    throw new Error('routing_divergence_recorder_state_invalid');
  }
  return {
    userId: state.userId,
    tenantId: state.tenantId,
    shadowRouteHookEffective: state.shadowRouteHookEffective,
    shadowPlannerEffective: state.shadowPlannerEffective,
  };
}

function readReleaseIdentity(
  env: Readonly<Record<string, string | undefined>>,
): RoutingDivergenceReleaseIdentity {
  const runtimeSha = env.NEXUS_RELEASE_SHA;
  const artifactDigest = env.NEXUS_RELEASE_ARTIFACT_SHA256;
  const role = env.NEXUS_RELEASE_ROLE;

  if (!runtimeSha || !FULL_RUNTIME_SHA.test(runtimeSha)) {
    throw new Error('routing_divergence_release_identity_invalid_runtime_sha');
  }
  if (!artifactDigest || !FULL_ARTIFACT_DIGEST.test(artifactDigest)) {
    throw new Error('routing_divergence_release_identity_invalid_artifact_digest');
  }
  if (!role || !RELEASE_ROLES.has(role)) {
    throw new Error('routing_divergence_release_identity_invalid_role');
  }

  return {
    runtimeSha,
    artifactDigest,
    role: role as RoutingDivergenceReleaseIdentity['role'],
  };
}

function readCapabilityFlags(
  env: Readonly<Record<string, string | undefined>>,
): RoutingDivergenceCapabilityFlags {
  const flags = Object.fromEntries(
    Object.entries(DIVERGENCE_SURFACE_TO_MANIFEST_SURFACE).map(([surface, manifestSurface]) => [
      surface,
      isManifestRoutingEnabled(manifestSurface, env),
    ]),
  ) as Omit<RoutingDivergenceCapabilityFlags, 'masterKill'>;

  return { ...flags, masterKill: parseFlagBoolean(env[MANIFEST_ROUTING_MASTER_KILL_ENV_VAR]) };
}

/** Mirrors the manifest-routing flag parser so the recorded state matches it. */
function parseFlagBoolean(raw: string | undefined): boolean {
  const normalized = String(raw ?? '').trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes';
}
