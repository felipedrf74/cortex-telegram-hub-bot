// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import fs from 'node:fs';
import path from 'node:path';

export type CapabilityLifecycle = 'experimental' | 'shadow' | 'active' | 'deprecated' | 'removed';

export type CapabilityResponseShape =
  | 'recipe'
  | 'agenda_summary'
  | 'task_options'
  | 'training_advice'
  | 'content_draft'
  | 'finance_summary'
  | 'connection_status'
  | 'notification_summary'
  | 'decision_summary'
  | 'direct_answer';

export interface CapabilityResponsePolicy {
  skill: string;
  genericAnswerExamples: string[];
  localReadExamples: string[];
  internetEligibleExamples: string[];
  actionExamples: string[];
  defaultGenericShape: CapabilityResponseShape;
  defaultLocalShape: CapabilityResponseShape;
  defaultGrounding: 'none' | 'local' | 'web' | 'local_and_web';
  telemetryLabel: string;
}

export interface CapabilityUiSkillMetadata {
  skill: string;
  displayName: string;
  responseCardType: string;
  latencyBudgetMs: number;
  privacyPolicy: 'safe_preview' | 'private_detail' | 'sensitive_redacted' | 'owner_admin_only';
}

export interface TrainingCapabilityMetadata {
  catalog: {
    summaryPath: string;
    summarySchema: 'nexus.training-catalog-summary.v1';
    catalogVersion: string;
    mediaApiSchemaVersion: string;
    approvedOrigin: string;
    activationState: string;
  };
  capacity: {
    capabilitiesPath: string;
    refreshMethod: 'POST';
    refreshPath: string;
    refreshApiSchema: string;
    authoritativeClientModification: 'NARROW_ONLY';
    storageMigration: string;
  };
}

export interface CapabilityManifestEntry {
  id: string;
  aliases: string[];
  version: string;
  lifecycle: CapabilityLifecycle;
  owner: string;
  /** Existing runtime domain and its legacy Chat owner mapping. Null preserves no implicit route owner. */
  runtimeRouting: { domain: string; chatOwnerSkill: string | null };
  requiredTier: 'free' | 'pro' | 'max' | 'owner';
  memoryScope: string;
  providerPolicy: string;
  costBudget: string;
  latencyBudgetMs: number;
  supportedChannels: string[];
  requiredEvaluations: string[];
  /** Access on restricted plans; paid plans remain governed by entitlement overrides. */
  restrictedPlanAccess: { free: boolean; beta: boolean };
  onboardingQuestionnaires: string[];
  chatOwnerSkills: string[];
  /** High-level references into the granular Chat action registry. */
  chatActionSkills: string[];
  chatOwnerUiSkills: Record<string, string>;
  responsePolicies: CapabilityResponsePolicy[];
  uiSkillMetadata: CapabilityUiSkillMetadata[];
  trainingCapabilities?: TrainingCapabilityMetadata;
}

export interface CapabilityManifest {
  schema: 'nexus.capability-manifest.v1';
  version: string;
  evaluationCoverage: Record<string, string[]>;
  chatResponsePolicyOrder: string[];
  chatUiSkillOrder: string[];
  capabilities: CapabilityManifestEntry[];
}

let cached: CapabilityManifest | null = null;

const RESPONSE_SHAPES = new Set<CapabilityResponseShape>([
  'recipe',
  'agenda_summary',
  'task_options',
  'training_advice',
  'content_draft',
  'finance_summary',
  'connection_status',
  'notification_summary',
  'decision_summary',
  'direct_answer',
]);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isNonEmptyString);
}

function validateResponsePolicy(entryId: string, policy: CapabilityResponsePolicy): void {
  if (!isNonEmptyString(policy?.skill)
      || !isStringArray(policy.genericAnswerExamples)
      || !isStringArray(policy.localReadExamples)
      || !isStringArray(policy.internetEligibleExamples)
      || !isStringArray(policy.actionExamples)
      || !RESPONSE_SHAPES.has(policy.defaultGenericShape)
      || !RESPONSE_SHAPES.has(policy.defaultLocalShape)
      || !['none', 'local', 'web', 'local_and_web'].includes(policy.defaultGrounding)
      || !isNonEmptyString(policy.telemetryLabel)) {
    throw new Error(`invalid capability response policy: ${entryId}/${policy?.skill ?? 'unknown'}`);
  }
}

function validateUiSkillMetadata(entryId: string, metadata: CapabilityUiSkillMetadata): void {
  if (!isNonEmptyString(metadata?.skill)
      || !isNonEmptyString(metadata.displayName)
      || !isNonEmptyString(metadata.responseCardType)
      || !Number.isFinite(metadata.latencyBudgetMs)
      || metadata.latencyBudgetMs <= 0
      || !['safe_preview', 'private_detail', 'sensitive_redacted', 'owner_admin_only'].includes(metadata.privacyPolicy)) {
    throw new Error(`invalid capability UI metadata: ${entryId}/${metadata?.skill ?? 'unknown'}`);
  }
}

function validateTrainingCapabilities(entryId: string, metadata: TrainingCapabilityMetadata): void {
  const { catalog, capacity } = metadata;
  if (!catalog
      || !isNonEmptyString(catalog.summaryPath)
      || catalog.summarySchema !== 'nexus.training-catalog-summary.v1'
      || !isNonEmptyString(catalog.catalogVersion)
      || !isNonEmptyString(catalog.mediaApiSchemaVersion)
      || !isNonEmptyString(catalog.approvedOrigin)
      || !isNonEmptyString(catalog.activationState)
      || !capacity
      || !isNonEmptyString(capacity.capabilitiesPath)
      || capacity.refreshMethod !== 'POST'
      || !isNonEmptyString(capacity.refreshPath)
      || !isNonEmptyString(capacity.refreshApiSchema)
      || capacity.authoritativeClientModification !== 'NARROW_ONLY'
      || !isNonEmptyString(capacity.storageMigration)) {
    throw new Error(`invalid Training capability metadata: ${entryId}`);
  }
}

export function loadCapabilityManifest(): CapabilityManifest {
  if (cached) return cached;
  const manifestPath = path.resolve(process.cwd(), 'config/capability-manifest.json');
  const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as CapabilityManifest;
  if (parsed.schema !== 'nexus.capability-manifest.v1'
      || !Array.isArray(parsed.capabilities)
      || !parsed.evaluationCoverage
      || typeof parsed.evaluationCoverage !== 'object'
      || Array.isArray(parsed.evaluationCoverage)
      || !isStringArray(parsed.chatResponsePolicyOrder)
      || !isStringArray(parsed.chatUiSkillOrder)) {
    throw new Error('invalid CapabilityManifest schema');
  }
  const ids = new Set<string>();
  const idsAndAliases = new Set<string>();
  const runtimeDomains = new Set<string>();
  const responsePolicySkills = new Set<string>();
  const uiMetadataSkills = new Set<string>();
  const requiredEvaluations = new Set<string>();
  const onboardingQuestionnaires = new Set<string>();
  for (const entry of parsed.capabilities) {
    if (!entry.id || ids.has(entry.id)) throw new Error(`invalid duplicate capability: ${entry.id}`);
    if (!entry.owner || !entry.version || entry.requiredEvaluations.length === 0
        || !Array.isArray(entry.aliases) || !Array.isArray(entry.onboardingQuestionnaires)
        || !Array.isArray(entry.chatOwnerSkills) || !Array.isArray(entry.chatActionSkills)
        || !entry.chatOwnerUiSkills || typeof entry.chatOwnerUiSkills !== 'object' || Array.isArray(entry.chatOwnerUiSkills)
        || !entry.runtimeRouting || !isNonEmptyString(entry.runtimeRouting.domain)
        || (entry.runtimeRouting.chatOwnerSkill !== null && !isNonEmptyString(entry.runtimeRouting.chatOwnerSkill))
        || !Array.isArray(entry.responsePolicies) || !Array.isArray(entry.uiSkillMetadata)
        || typeof entry.restrictedPlanAccess?.free !== 'boolean'
        || typeof entry.restrictedPlanAccess?.beta !== 'boolean') {
      throw new Error(`incomplete capability governance: ${entry.id}`);
    }
    if (runtimeDomains.has(entry.runtimeRouting.domain)) {
      throw new Error(`duplicate capability runtime domain: ${entry.runtimeRouting.domain}`);
    }
    runtimeDomains.add(entry.runtimeRouting.domain);
    ids.add(entry.id);
    for (const identifier of [entry.id, ...entry.aliases]) {
      if (idsAndAliases.has(identifier)) throw new Error(`duplicate capability identifier: ${identifier}`);
      idsAndAliases.add(identifier);
    }
    if (entry.runtimeRouting.chatOwnerSkill !== null
        && !entry.chatOwnerSkills.includes(entry.runtimeRouting.chatOwnerSkill)) {
      throw new Error(`runtime route owner is not governed by capability: ${entry.id}`);
    }
    if (new Set(entry.chatOwnerSkills).size !== entry.chatOwnerSkills.length
        || new Set(entry.chatActionSkills).size !== entry.chatActionSkills.length
        || new Set(entry.requiredEvaluations).size !== entry.requiredEvaluations.length
        || new Set(entry.onboardingQuestionnaires).size !== entry.onboardingQuestionnaires.length) {
      throw new Error(`duplicate capability references: ${entry.id}`);
    }
    for (const questionnaire of entry.onboardingQuestionnaires) {
      if (!isNonEmptyString(questionnaire)) {
        throw new Error(`invalid capability onboarding questionnaire: ${entry.id}`);
      }
      if (onboardingQuestionnaires.has(questionnaire)) {
        throw new Error(`duplicate capability onboarding questionnaire: ${questionnaire}`);
      }
      onboardingQuestionnaires.add(questionnaire);
    }
    for (const evaluation of entry.requiredEvaluations) {
      if (!isNonEmptyString(evaluation)) throw new Error(`invalid required evaluation: ${entry.id}`);
      requiredEvaluations.add(evaluation);
    }
    for (const policy of entry.responsePolicies) {
      validateResponsePolicy(entry.id, policy);
      if (!entry.chatOwnerSkills.includes(policy.skill)) {
        throw new Error(`response policy is not governed by capability: ${entry.id}/${policy.skill}`);
      }
      if (responsePolicySkills.has(policy.skill)) {
        throw new Error(`duplicate capability response policy: ${policy.skill}`);
      }
      responsePolicySkills.add(policy.skill);
    }
    for (const ownerSkill of entry.chatOwnerSkills) {
      if (!entry.responsePolicies.some((policy) => policy.skill === ownerSkill)) {
        throw new Error(`capability owner skill missing response policy: ${entry.id}/${ownerSkill}`);
      }
    }
    const ownerUiEntries = Object.entries(entry.chatOwnerUiSkills);
    if (ownerUiEntries.length !== entry.chatOwnerSkills.length
        || ownerUiEntries.some(([ownerSkill, uiSkill]) => (
          !entry.chatOwnerSkills.includes(ownerSkill) || !entry.chatActionSkills.includes(uiSkill)
        ))) {
      throw new Error(`capability owner-to-UI references are incomplete: ${entry.id}`);
    }
    for (const metadata of entry.uiSkillMetadata) {
      validateUiSkillMetadata(entry.id, metadata);
      if (!entry.chatActionSkills.includes(metadata.skill)) {
        throw new Error(`UI metadata is not referenced by capability: ${entry.id}/${metadata.skill}`);
      }
      if (uiMetadataSkills.has(metadata.skill)) {
        throw new Error(`duplicate capability UI metadata: ${metadata.skill}`);
      }
      uiMetadataSkills.add(metadata.skill);
    }
    for (const actionSkill of entry.chatActionSkills) {
      if (!entry.uiSkillMetadata.some((metadata) => metadata.skill === actionSkill)) {
        throw new Error(`capability action skill missing UI metadata: ${entry.id}/${actionSkill}`);
      }
    }
    if (entry.trainingCapabilities) validateTrainingCapabilities(entry.id, entry.trainingCapabilities);
  }
  for (const evaluation of requiredEvaluations) {
    if (!isStringArray(parsed.evaluationCoverage[evaluation]) || parsed.evaluationCoverage[evaluation].length === 0) {
      throw new Error(`required capability evaluation has no coverage reference: ${evaluation}`);
    }
  }
  for (const [evaluation, references] of Object.entries(parsed.evaluationCoverage)) {
    if (!requiredEvaluations.has(evaluation) || !isStringArray(references) || references.length === 0) {
      throw new Error(`invalid or unused capability evaluation coverage: ${evaluation}`);
    }
  }
  if (parsed.chatResponsePolicyOrder.length !== responsePolicySkills.size
      || new Set(parsed.chatResponsePolicyOrder).size !== responsePolicySkills.size
      || parsed.chatResponsePolicyOrder.some((skill) => !responsePolicySkills.has(skill))) {
    throw new Error('capability response policy order does not exactly cover governed policies');
  }
  if (parsed.chatUiSkillOrder.length !== uiMetadataSkills.size
      || new Set(parsed.chatUiSkillOrder).size !== uiMetadataSkills.size
      || parsed.chatUiSkillOrder.some((skill) => !uiMetadataSkills.has(skill))) {
    throw new Error('capability UI skill order does not exactly cover governed metadata');
  }
  cached = parsed;
  return parsed;
}

export function getCapabilityManifestEntry(skillId: string): CapabilityManifestEntry | null {
  return loadCapabilityManifest().capabilities.find(
    (entry) => entry.id === skillId || entry.aliases.includes(skillId),
  ) ?? null;
}

export function getRestrictedPlanCapabilityIds(plan: 'free' | 'beta'): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const entry of loadCapabilityManifest().capabilities) {
    if (!entry.restrictedPlanAccess[plan]) continue;
    ids.add(entry.id);
    for (const alias of entry.aliases) ids.add(alias);
  }
  return ids;
}

export function getCapabilityOnboardingMap(): Record<string, string | string[] | null> {
  return Object.fromEntries(loadCapabilityManifest().capabilities.map((entry) => {
    const questionnaires = entry.onboardingQuestionnaires;
    if (questionnaires.length === 0) return [entry.id, null];
    if (questionnaires.length === 1) return [entry.id, questionnaires[0]];
    return [entry.id, [...questionnaires]];
  }));
}

/** Reverse onboarding lookup generated from the same canonical capability entries. */
export function getCapabilityQuestionnaireSkillMap(): Record<string, string> {
  return Object.fromEntries(loadCapabilityManifest().capabilities.flatMap((entry) => (
    entry.onboardingQuestionnaires.map((questionnaire) => [questionnaire, entry.id])
  )));
}

/** Existing domain-to-Chat-owner mapping, including only domains that historically implied an owner. */
export function getCapabilityChatRoutingOwnerMap(): Readonly<Record<string, string>> {
  return Object.fromEntries(loadCapabilityManifest().capabilities.flatMap((entry) => (
    entry.runtimeRouting.chatOwnerSkill === null
      ? []
      : [[entry.runtimeRouting.domain, entry.runtimeRouting.chatOwnerSkill]]
  )));
}

export function getCapabilityOwnerUiSkillMap(): Readonly<Record<string, string>> {
  return Object.assign({}, ...loadCapabilityManifest().capabilities.map(
    (entry) => entry.chatOwnerUiSkills,
  ));
}

/** Stable high-level response defaults. Granular action policies remain in the Chat action registry. */
export function getCapabilityResponsePolicies(): CapabilityResponsePolicy[] {
  const manifest = loadCapabilityManifest();
  const bySkill = new Map(manifest.capabilities.flatMap((entry) => entry.responsePolicies).map(
    (policy) => [policy.skill, policy],
  ));
  return manifest.chatResponsePolicyOrder.map((skill) => {
    const policy = bySkill.get(skill)!;
    return {
      ...policy,
      genericAnswerExamples: [...policy.genericAnswerExamples],
      localReadExamples: [...policy.localReadExamples],
      internetEligibleExamples: [...policy.internetEligibleExamples],
      actionExamples: [...policy.actionExamples],
    };
  });
}

/** UI metadata keyed by the existing Chat action-skill identifiers consumed by REST/iOS surfaces. */
export function getCapabilityUiSkillMetadata(): Record<string, Omit<CapabilityUiSkillMetadata, 'skill'>> {
  const manifest = loadCapabilityManifest();
  const bySkill = new Map(manifest.capabilities.flatMap((entry) => entry.uiSkillMetadata).map(
    (metadata) => [metadata.skill, metadata],
  ));
  return Object.fromEntries(manifest.chatUiSkillOrder.map((skill) => {
    const { skill: _skill, ...metadata } = bySkill.get(skill)!;
    return [skill, { ...metadata }];
  }));
}

export function getCapabilityEvaluationCoverage(): Readonly<Record<string, readonly string[]>> {
  return Object.fromEntries(Object.entries(loadCapabilityManifest().evaluationCoverage).map(
    ([evaluation, references]) => [evaluation, [...references]],
  ));
}

export function getTrainingCapabilityMetadata(): TrainingCapabilityMetadata {
  const entries = loadCapabilityManifest().capabilities.filter((entry) => entry.trainingCapabilities);
  if (entries.length !== 1) throw new Error('CapabilityManifest must define exactly one Training capability');
  const metadata = entries[0].trainingCapabilities!;
  return {
    catalog: { ...metadata.catalog },
    capacity: { ...metadata.capacity },
  };
}

export function resetCapabilityManifestForTest(): void {
  cached = null;
}
